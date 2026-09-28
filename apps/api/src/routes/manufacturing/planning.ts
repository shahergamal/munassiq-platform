import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../../db/pool.ts";
import { round4 } from "../../lib/costing.ts";
import { AppError, badRequest, notFound } from "../../lib/errors.ts";
import { explode, type Bom } from "../../lib/manufacturing/bom.ts";
import { runMrp, shiftDays, type Flow, type MrpItem } from "../../lib/manufacturing/mrp.ts";
import { schedule, type SchedOrder } from "../../lib/manufacturing/schedule.ts";
import { auditTenant, isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";
import { today } from "../restaurants/batches.ts";
import { createPurchaseOrder } from "../restaurants/purchases.ts";
import { loadBoms } from "./production.ts";

// Planning for factory workspaces (docs/manufacturing/ARCHITECTURE.md, M4): MRP from open sales orders, open
// production and purchase orders and minimum stock, and a finite-capacity schedule of open production orders on the
// work centers. A run is a stored snapshot; its suggestions become draft orders only when someone converts them.

async function activeBoms(db: Db) {
  const map = new Map((await loadBoms(db, "status = 'active'", [])).map((b) => [b.itemId, b]));
  return (id: string): Bom | undefined => map.get(id);
}

/** Everything MRP reads, from the ledger of documents (never from the browser). */
async function planningInputs(db: Db, horizonEnd: string) {
  const t = today();
  const bomOf = await activeBoms(db);
  const items = new Map((await db.query<{ id: string; name: string; lead: number; on_hand: number; min_stock: number; par_stock: number }>(
    `SELECT i.id, i.name, i.lead_time_days AS lead, coalesce((SELECT sum(s.quantity) FROM stock_levels s JOIN locations l ON l.id = s.location_id WHERE s.ingredient_id = i.id AND l.location_type <> 'quarantine'), 0)::float8 AS on_hand,
            i.min_stock::float8 AS min_stock, i.par_stock::float8 AS par_stock
       FROM ingredients i WHERE i.is_active`)).rows.map((r) => [r.id, { id: r.id, name: r.name, leadTimeDays: r.lead, onHand: r.on_hand, minStock: r.min_stock, parStock: r.par_stock } as MrpItem]));
  const demands: Flow[] = [];
  const receipts: Flow[] = [];
  // Independent demand: what confirmed sales orders still have to deliver.
  for (const r of (await db.query<{ item_id: string; q: number; d: string; n: string }>(
    `SELECT l.item_id, (l.quantity - l.delivered_qty)::float8 AS q, coalesce(o.delivery_date, $1::date)::text AS d, o.so_number::text AS n
       FROM sales_order_lines l JOIN sales_orders o ON o.id = l.order_id WHERE o.status = 'confirmed' AND l.quantity > l.delivered_qty`, [t])).rows) {
    if (r.d <= horizonEnd) demands.push({ itemId: r.item_id, date: r.d, quantity: r.q, source: { type: "sales_order", ref: `SO-${r.n}` } });
  }
  // Open production orders: their remaining output is a receipt; what they still have to issue is demand.
  const mos = (await db.query<{ id: string; n: string; item_id: string; bom_id: string; q: number; produced: number; status: string; start: string; due: string }>(
    `SELECT id, mo_number::text AS n, item_id, bom_id, quantity::float8 AS q, produced_quantity::float8 AS produced, status,
            coalesce(planned_start, $1::date)::text AS start, coalesce(due_date, planned_start, $1::date)::text AS due
       FROM manufacturing_orders WHERE status IN ('draft', 'confirmed', 'in_progress')`, [t])).rows;
  const moBoms = new Map((await loadBoms(db, "id = ANY($1::uuid[])", [[...new Set(mos.map((m) => m.bom_id))]])).map((b) => [b.id, b]));
  for (const m of mos) {
    const left = round4(m.q - m.produced);
    if (left > 0) receipts.push({ itemId: m.item_id, date: m.due, quantity: left, source: { type: "mo_output", ref: `MO-${m.n}` } });
    if (m.status === "draft") {
      const bom = moBoms.get(m.bom_id);
      if (bom) for (const c of explode(bom, m.q, { bomOf }).components) demands.push({ itemId: c.componentId, date: m.start, quantity: c.quantity, source: { type: "mo_component", ref: `MO-${m.n}` } });
    }
  }
  for (const r of (await db.query<{ component_id: string; q: number; start: string; n: string }>(
    `SELECT c.component_id, greatest(0, c.required_qty - coalesce((
              SELECT sum((x->>'quantity')::numeric * CASE e.kind WHEN 'issue' THEN 1 ELSE -1 END) FROM mo_events e CROSS JOIN LATERAL jsonb_array_elements(e.detail->'lines') x
               WHERE e.mo_id = o.id AND e.kind IN ('issue', 'return') AND x->>'componentId' = c.component_id::text), 0))::float8 AS q,
            coalesce(o.planned_start, $1::date)::text AS start, o.mo_number::text AS n
       FROM mo_components c JOIN manufacturing_orders o ON o.id = c.mo_id WHERE o.status IN ('confirmed', 'in_progress')`, [t])).rows) {
    if (r.q > 0) demands.push({ itemId: r.component_id, date: r.start, quantity: r.q, source: { type: "mo_component", ref: `MO-${r.n}` } });
  }
  // Open purchase orders: what is still to arrive, in base units.
  for (const r of (await db.query<{ item_id: string; q: number; d: string; n: string }>(
    `SELECT pi.ingredient_id AS item_id, ((pi.quantity - pi.received_quantity) * i.purchase_to_base)::float8 AS q, coalesce(p.expected_date, $1::date)::text AS d, p.po_number::text AS n
       FROM purchase_items pi JOIN purchase_orders p ON p.id = pi.purchase_order_id JOIN ingredients i ON i.id = pi.ingredient_id
      WHERE p.status IN ('draft', 'approved', 'partially_received') AND pi.quantity > pi.received_quantity`, [t])).rows) {
    receipts.push({ itemId: r.item_id, date: r.d, quantity: r.q, source: { type: "purchase_order", ref: `PO-${r.n}` } });
  }
  return { t, bomOf, items, demands, receipts };
}

export default async function planningRoutes(app: FastifyInstance) {
  app.post("/mrp/runs", { preHandler: requireTenant("mrp.run") }, async (req, reply) => {
    const b = z.object({ horizonDays: z.number().int().min(7).max(365).default(90), safetyStock: z.boolean().default(true) }).parse(req.body ?? {});
    const out = await tenantTx(req, async (db) => {
      // One run at a time per workspace, so two planners never read each other's half-written suggestions.
      await db.query("SELECT pg_advisory_xact_lock(hashtext('mrp_run:' || app_tenant_id()::text))");
      const t = today();
      const inputs = await planningInputs(db, shiftDays(t, b.horizonDays));
      const suggestions = runMrp({ today: t, items: inputs.items, bomOf: inputs.bomOf, demands: inputs.demands, receipts: inputs.receipts, safetyStock: b.safetyStock });
      // The supplier a bought item came from last time, and what it cost then.
      const buyIds = [...new Set(suggestions.filter((s) => s.kind === "buy").map((s) => s.itemId))];
      const lastSupplier = new Map((await db.query<{ item_id: string; supplier_id: string }>(
        `SELECT DISTINCT ON (pi.ingredient_id) pi.ingredient_id AS item_id, p.supplier_id FROM purchase_items pi JOIN purchase_orders p ON p.id = pi.purchase_order_id
          WHERE pi.ingredient_id = ANY($1::uuid[]) AND p.status <> 'cancelled' ORDER BY pi.ingredient_id, p.created_at DESC`, [buyIds])).rows.map((r) => [r.item_id, r.supplier_id]));
      const n = (await db.query<{ n: string }>("SELECT next_counter('mrp_run')::text AS n")).rows[0]!.n;
      const summary = { make: suggestions.filter((s) => s.kind === "make").length, buy: suggestions.filter((s) => s.kind === "buy").length, late: suggestions.filter((s) => s.late).length,
        demands: inputs.demands.length, receipts: inputs.receipts.length };
      const run = (await db.query<{ id: string }>(
        "INSERT INTO mrp_runs (tenant_id, run_number, params, summary, created_by) VALUES (app_tenant_id(), $1, $2, $3, app_user_id()) RETURNING id",
        [n, JSON.stringify({ ...b, today: t }), JSON.stringify(summary)])).rows[0]!;
      for (const s of suggestions) {
        await db.query(
          `INSERT INTO mrp_suggestions (tenant_id, run_id, item_id, kind, level, quantity, need_date, order_date, supplier_id, explanation)
           VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [run.id, s.itemId, s.kind, s.level, s.quantity, s.needDate, s.orderDate, s.kind === "buy" ? lastSupplier.get(s.itemId) ?? null : null, JSON.stringify({ ...s.explanation, late: s.late })]);
      }
      await auditTenant(db, req, "mrp.run", "mrp_run", run.id, summary);
      return { id: run.id, number: Number(n), summary };
    });
    return reply.status(201).send(out);
  });

  app.get("/mrp/runs/latest", { preHandler: requireTenant("mrp.view") }, async (req) =>
    tenantTx(req, async (db) => {
      const run = (await db.query<{ id: string }>(
        `SELECT id, run_number::int AS number, params, summary, created_at AS "createdAt" FROM mrp_runs ORDER BY run_number DESC LIMIT 1`)).rows[0] ?? null;
      if (!run) return { run: null, suggestions: [] };
      const suggestions = (await db.query(
        `SELECT s.id, s.item_id AS "itemId", i.name AS "itemName", i.sku, u.name AS unit, i.purchase_to_base::float8 AS "purchaseToBase", pu.name AS "purchaseUnit",
                s.kind, s.level, s.quantity::float8 AS quantity, s.need_date::text AS "needDate", s.order_date::text AS "orderDate",
                s.supplier_id AS "supplierId", sp.name AS "supplierName", s.explanation, s.status, s.converted_to AS "convertedTo",
                (SELECT b.id FROM boms b WHERE b.item_id = s.item_id AND b.status = 'active') AS "bomId"
           FROM mrp_suggestions s JOIN ingredients i ON i.id = s.item_id JOIN units u ON u.id = i.base_unit_id JOIN units pu ON pu.id = i.purchase_unit_id
           LEFT JOIN suppliers sp ON sp.id = s.supplier_id
          WHERE s.run_id = $1 ORDER BY s.status = 'open' DESC, s.order_date, s.level, i.name`, [(run as { id: string }).id])).rows;
      return { run, suggestions };
    }, { readOnly: true }));

  /**
   * Suggestions become drafts: each "make" a draft production order (at the given production location), the "buy"
   * ones a draft purchase order per supplier (quantities in purchase units, at the last price paid, or the average
   * cost). Nothing is confirmed or approved here.
   */
  app.post("/mrp/suggestions/convert", { preHandler: requireTenant("mrp.convert") }, async (req) => {
    const b = z.object({
      ids: z.array(z.string().uuid()).min(1, "اختر مقترحاً واحداً على الأقل").max(200),
      productionLocationId: z.string().uuid().optional(),
      outputLocationId: z.string().uuid().optional(),
      receivingLocationId: z.string().uuid().optional(),
      suppliers: z.record(z.string().uuid()).default({}),
    }).parse(req.body);
    return tenantTx(req, async (db) => {
      const rows = (await db.query<{ id: string; item_id: string; kind: string; quantity: number; need_date: string; order_date: string; supplier_id: string | null; status: string; name: string; ptb: number }>(
        `SELECT s.id, s.item_id, s.kind, s.quantity::float8 AS quantity, s.need_date::text, s.order_date::text, s.supplier_id, s.status, i.name, i.purchase_to_base::float8 AS ptb
           FROM mrp_suggestions s JOIN ingredients i ON i.id = s.item_id WHERE s.id = ANY($1::uuid[]) FOR UPDATE OF s`, [b.ids])).rows;
      if (rows.length !== b.ids.length) throw notFound("مقترح غير موجود");
      if (rows.some((r) => r.status !== "open")) throw new AppError(409, "already_converted", "بعض المقترحات حُوّلت أو استُبعدت من قبل");
      const make = rows.filter((r) => r.kind === "make");
      const buy = rows.filter((r) => r.kind === "buy");
      if (make.length && !b.productionLocationId) throw new AppError(422, "validation_failed", "اختر موقع الإنتاج لأوامر التشغيل", [{ path: "productionLocationId", message: "اختر الموقع" }]);
      if (buy.length && !b.receivingLocationId) throw new AppError(422, "validation_failed", "اختر موقع استلام المشتريات", [{ path: "receivingLocationId", message: "اختر الموقع" }]);
      const created: { kind: "mo" | "po"; id: string; number: string }[] = [];
      for (const r of make) {
        const bom = (await db.query<{ id: string }>("SELECT id FROM boms WHERE item_id = $1 AND status = 'active'", [r.item_id])).rows[0];
        if (!bom) throw new AppError(409, "no_active_bom", `لا توجد قائمة مواد معتمدة لـ «${r.name}»`);
        const n = (await db.query<{ n: string }>("SELECT next_counter('manufacturing_order')::text AS n")).rows[0]!.n;
        const mo = (await db.query<{ id: string }>(
          `INSERT INTO manufacturing_orders (tenant_id, mo_number, item_id, bom_id, quantity, location_id, output_location_id, planned_start, due_date, notes, idempotency_key, created_by)
           VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, app_user_id()) RETURNING id`,
          [n, r.item_id, bom.id, r.quantity, b.productionLocationId, b.outputLocationId ?? b.productionLocationId, r.order_date, r.need_date, "من تخطيط الاحتياجات", randomUUID()])).rows[0]!;
        await db.query("UPDATE mrp_suggestions SET status = 'converted', converted_to = $2, converted_at = now() WHERE id = $1", [r.id, mo.id]);
        created.push({ kind: "mo", id: mo.id, number: `MO-${n}` });
      }
      const bySupplier = new Map<string, typeof buy>();
      for (const r of buy) {
        const sup = b.suppliers[r.id] ?? r.supplier_id;
        if (!sup) throw new AppError(422, "supplier_required", `اختر مورد «${r.name}» (لم يُشترَ من قبل)`, [{ path: `suppliers.${r.id}`, message: "اختر المورد" }]);
        bySupplier.set(sup, [...(bySupplier.get(sup) ?? []), r]);
      }
      for (const [supplierId, list] of bySupplier) {
        // The same item twice for one supplier (different dates) is one line; the earliest need sets the expected date.
        const qty = new Map<string, { q: number; ptb: number }>();
        for (const r of list) qty.set(r.item_id, { q: (qty.get(r.item_id)?.q ?? 0) + r.quantity, ptb: r.ptb });
        const prices = new Map((await db.query<{ id: string; p: number }>(
          `SELECT i.id, coalesce((SELECT pi.unit_price FROM purchase_items pi JOIN purchase_orders p ON p.id = pi.purchase_order_id
                                   WHERE pi.ingredient_id = i.id AND p.supplier_id = $2 AND p.status <> 'cancelled' ORDER BY p.created_at DESC LIMIT 1),
                                  (SELECT avg(s.avg_cost) FROM stock_levels s WHERE s.ingredient_id = i.id AND s.avg_cost > 0) * i.purchase_to_base, 0)::float8 AS p
             FROM ingredients i WHERE i.id = ANY($1::uuid[])`, [[...qty.keys()], supplierId])).rows.map((x) => [x.id, x.p]));
        const expected = list.map((r) => r.need_date).sort()[0]!;
        const po = await createPurchaseOrder(db, {
          supplierId, locationId: b.receivingLocationId!, supplierInvoice: null, expectedDate: expected, notes: "من تخطيط الاحتياجات",
          discount: 0, shipping: 0, fees: 0, costAllocation: "value",
          items: [...qty].map(([itemId, v]) => ({ ingredientId: itemId, quantity: Math.ceil((v.q / v.ptb) * 10_000) / 10_000, unitPrice: Math.round((prices.get(itemId) ?? 0) * 10_000) / 10_000 })),
        }, randomUUID(), req);
        const number = (await db.query<{ n: string }>("SELECT po_number::text AS n FROM purchase_orders WHERE id = $1", [po.id])).rows[0]!.n;
        for (const r of list) await db.query("UPDATE mrp_suggestions SET status = 'converted', converted_to = $2, converted_at = now(), supplier_id = $3 WHERE id = $1", [r.id, po.id, supplierId]);
        created.push({ kind: "po", id: po.id, number: `PO-${number}` });
      }
      await auditTenant(db, req, "mrp.converted", "mrp_run", rows[0]!.id, { created });
      return { created };
    });
  });

  app.post("/mrp/suggestions/:id/dismiss", { preHandler: requireTenant("mrp.convert") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    await tenantTx(req, async (db) => {
      const r = await db.query("UPDATE mrp_suggestions SET status = 'dismissed' WHERE id = $1 AND status = 'open'", [id]);
      if (!r.rowCount) throw badRequest("المقترح غير مفتوح");
    });
    return { ok: true };
  });

  /**
   * The finite-capacity schedule of open production orders: confirmed ones by their remaining planned minutes,
   * drafts by their BOM's operations. Read-only; nothing is stored.
   */
  app.get("/production/schedule", { preHandler: requireTenant("mrp.view", "mos.view") }, async (req) =>
    tenantTx(req, async (db) => {
      const t = today();
      const wcs = (await db.query<{ id: string; name: string; m: number }>("SELECT id, name, (hours_per_day * 60)::float8 AS m FROM work_centers WHERE is_active ORDER BY code")).rows;
      const mos = (await db.query<{ id: string; n: number; item: string; status: string; bom_id: string; q: number; produced: number; start: string | null; due: string | null }>(
        `SELECT o.id, o.mo_number::int AS n, i.name AS item, o.status, o.bom_id, o.quantity::float8 AS q, o.produced_quantity::float8 AS produced,
                o.planned_start::text AS start, o.due_date::text AS due
           FROM manufacturing_orders o JOIN ingredients i ON i.id = o.item_id WHERE o.status IN ('draft', 'confirmed', 'in_progress')`)).rows;
      const bomOf = await activeBoms(db);
      const moBoms = new Map((await loadBoms(db, "id = ANY($1::uuid[])", [[...new Set(mos.map((m) => m.bom_id))]])).map((b) => [b.id, b]));
      const orders: SchedOrder[] = [];
      for (const m of mos) {
        let ops: SchedOrder["operations"];
        if (m.status === "draft") {
          const bom = moBoms.get(m.bom_id);
          ops = bom ? explode(bom, m.q, { bomOf }).operations.map((o) => ({ seq: o.seq, name: o.name, workCenterId: o.workCenterId, minutes: o.minutes })) : [];
        } else {
          ops = (await db.query<{ seq: number; name: string; wc: string; planned: number; actual: number }>(
            `SELECT m.seq, m.name, m.work_center_id AS wc, m.planned_minutes::float8 AS planned,
                    coalesce((SELECT sum((e.detail->>'minutes')::numeric) FROM mo_events e WHERE e.mo_id = m.mo_id AND e.kind = 'labor' AND (e.detail->>'seq')::int = m.seq), 0)::float8 AS actual
               FROM mo_operations m WHERE m.mo_id = $1`, [m.id])).rows.map((o) => ({ seq: o.seq, name: o.name, workCenterId: o.wc, minutes: Math.max(0, o.planned - o.actual) }));
        }
        orders.push({ moId: m.id, number: m.n, label: `${m.item} · متبقٍ ${round4(m.q - m.produced)}`, dueDate: m.due, releaseDate: m.start && m.start > t ? m.start : null, operations: ops });
      }
      // Open maintenance on a machine takes its work center's time from its due date (not before today).
      const maint = (await db.query<{ id: string; n: number; machine: string; kind: string; due: string; minutes: number; wc: string }>(
        `SELECT o.id, o.order_number::int AS n, m.name AS machine, o.kind, o.due_date::text AS due, o.planned_minutes AS minutes, m.work_center_id AS wc
           FROM maintenance_orders o JOIN machines m ON m.id = o.machine_id WHERE o.status = 'open' AND m.work_center_id IS NOT NULL`)).rows;
      for (const x of maint) {
        orders.push({ moId: x.id, kind: "maintenance", number: x.n, label: `${x.kind === "corrective" ? "إصلاح" : "صيانة وقائية"} · ${x.machine}`, dueDate: x.due,
          releaseDate: x.due > t ? x.due : null, operations: [{ seq: 1, name: "صيانة", workCenterId: x.wc, minutes: x.minutes }] });
      }
      const r = schedule({ today: t, workCenters: wcs.map((w) => ({ id: w.id, name: w.name, minutesPerDay: w.m })), orders });
      return { today: t, workCenters: wcs.map((w) => ({ id: w.id, name: w.name, minutesPerDay: w.m })), ...r,
        orders: r.orders.map((o) => ({ ...o, status: mos.find((m) => m.id === o.moId)?.status ?? "maintenance" })) };
    }, { readOnly: true }));
}
