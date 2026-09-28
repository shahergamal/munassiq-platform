import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../../db/pool.ts";
import { round4 } from "../../lib/costing.ts";
import { AppError, badRequest, forbidden, notFound } from "../../lib/errors.ts";
import { formatMoney, parseMoney, percentToBp, vatOf } from "../../lib/money.ts";
import { pageMeta, parsePage } from "../../lib/pagination.ts";
import { auditTenant, isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";
import { idempotencyKey } from "./purchases.ts";

/**
 * The start of the purchasing cycle: a location asks for goods (requisition), a manager approves or rejects it, and
 * the buyer turns it into purchase orders, one per supplier, at prices defaulting to the last receipt. Reorder
 * suggestions come from stock below the minimum, net of what is already on order.
 */

const REQ_STATUSES = ["submitted", "approved", "rejected", "converted", "cancelled"];

/** The last received price per purchase unit and its supplier, per ingredient. */
async function lastPrices(db: Db, ingredientIds: string[]) {
  if (!ingredientIds.length) return new Map<string, { price: number; supplierId: string; supplierName: string }>();
  const { rows } = await db.query<{ ingredient_id: string; price: number; supplier_id: string; supplier_name: string }>(
    `SELECT DISTINCT ON (x.ingredient_id) x.ingredient_id, x.unit_price::float8 AS price, g.supplier_id, s.name AS supplier_name
       FROM goods_receipt_items x JOIN goods_receipts g ON g.id = x.receipt_id JOIN suppliers s ON s.id = g.supplier_id
      WHERE x.ingredient_id = ANY($1::uuid[]) AND x.quantity > 0
      ORDER BY x.ingredient_id, g.received_on DESC, g.grn_number DESC`, [ingredientIds]);
  return new Map(rows.map((r) => [r.ingredient_id, { price: r.price, supplierId: r.supplier_id, supplierName: r.supplier_name }]));
}

export default async function procurementRoutes(app: FastifyInstance) {
  app.get("/requisitions", { preHandler: requireTenant("requisitions.view") }, async (req) => {
    const q = req.query as { status?: string; page?: string; pageSize?: string };
    const page = parsePage(q);
    const status = REQ_STATUSES.includes(q.status ?? "") ? q.status : null;
    return tenantTx(req, async (db) => {
      const { rows } = await db.query(
        `SELECT r.id, r.pr_number AS "number", r.status, r.needed_by::text AS "neededBy", r.notes, r.created_at AS "createdAt", l.name AS "locationName",
                (SELECT count(*)::int FROM purchase_requisition_items x WHERE x.requisition_id = r.id) AS "itemsCount",
                (SELECT string_agg(i.name, '، ' ORDER BY i.name) FROM purchase_requisition_items x JOIN ingredients i ON i.id = x.ingredient_id WHERE x.requisition_id = r.id) AS summary,
                count(*) OVER()::int AS "_total"
           FROM purchase_requisitions r JOIN locations l ON l.id = r.location_id
          WHERE $1::text IS NULL OR r.status = $1 ORDER BY r.created_at DESC LIMIT $2 OFFSET $3`, [status, page.pageSize, page.offset]);
      return { items: rows.map(({ _total, ...r }) => r), meta: pageMeta(page, rows[0]?._total ?? 0) };
    }, { readOnly: true });
  });

  app.get("/requisitions/:id", { preHandler: requireTenant("requisitions.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const r = (await db.query(
        `SELECT r.id, r.pr_number AS "number", r.status, r.needed_by::text AS "neededBy", r.notes, r.decision_note AS "decisionNote", r.created_at AS "createdAt",
                r.decided_at AS "decidedAt", r.requested_by AS "requestedBy", r.location_id AS "locationId", l.name AS "locationName"
           FROM purchase_requisitions r JOIN locations l ON l.id = r.location_id WHERE r.id = $1`, [id])).rows[0];
      if (!r) throw notFound();
      const items = (await db.query<{ id: string; ingredientId: string; name: string; quantity: number; purchaseOrderId: string | null }>(
        `SELECT x.id, x.ingredient_id AS "ingredientId", i.name, i.sku, pu.name AS "purchaseUnit", x.quantity::float8 AS quantity, x.note,
                x.purchase_order_id AS "purchaseOrderId", (SELECT po.po_number FROM purchase_orders po WHERE po.id = x.purchase_order_id) AS "poNumber",
                coalesce((SELECT sl.quantity FROM stock_levels sl WHERE sl.location_id = $2 AND sl.ingredient_id = x.ingredient_id), 0)::float8 / i.purchase_to_base AS "onHand"
           FROM purchase_requisition_items x JOIN ingredients i ON i.id = x.ingredient_id JOIN units pu ON pu.id = i.purchase_unit_id
          WHERE x.requisition_id = $1 ORDER BY i.name`, [id, r.locationId])).rows;
      const prices = await lastPrices(db, items.map((i) => i.ingredientId));
      return { ...r, items: items.map((i) => ({ ...i, lastPrice: prices.get(i.ingredientId)?.price ?? null, lastSupplierId: prices.get(i.ingredientId)?.supplierId ?? null, lastSupplierName: prices.get(i.ingredientId)?.supplierName ?? null })) };
    }, { readOnly: true });
  });

  app.post("/requisitions", { preHandler: requireTenant("requisitions.create") }, async (req, reply) => {
    const key = idempotencyKey(req);
    const b = z.object({
      locationId: z.string().uuid(),
      neededBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().transform((v) => v ?? null),
      notes: z.string().trim().max(500).nullable().optional().transform((v) => v || null),
      items: z.array(z.object({ ingredientId: z.string().uuid(), quantity: z.number().positive().max(1_000_000_000), note: z.string().trim().max(200).nullable().optional().transform((v) => v || null) }))
        .min(1, "أضف مادة واحدة على الأقل").max(200).refine((ls) => new Set(ls.map((l) => l.ingredientId)).size === ls.length, "لا يمكن تكرار نفس المادة"),
    }).parse(req.body);
    const out = await tenantTx(req, async (db) => {
      const dup = (await db.query<{ id: string }>("SELECT id FROM purchase_requisitions WHERE idempotency_key = $1", [key])).rows[0];
      if (dup) return { id: dup.id, replay: true };
      const n = (await db.query<{ n: string }>("SELECT next_counter('requisition')::text AS n")).rows[0]!.n;
      const r = (await db.query<{ id: string }>(
        `INSERT INTO purchase_requisitions (tenant_id, pr_number, location_id, needed_by, notes, idempotency_key, requested_by)
         VALUES (app_tenant_id(), $1, $2, $3, $4, $5, app_user_id()) RETURNING id`, [n, b.locationId, b.neededBy, b.notes, key])).rows[0]!;
      for (const it of b.items) {
        await db.query("INSERT INTO purchase_requisition_items (tenant_id, requisition_id, ingredient_id, quantity, note) VALUES (app_tenant_id(), $1, $2, $3, $4)",
          [r.id, it.ingredientId, round4(it.quantity), it.note]);
      }
      await auditTenant(db, req, "requisition.submitted", "purchase_requisition", r.id, { items: b.items.length });
      return { id: r.id, replay: false };
    });
    return reply.status(out.replay ? 200 : 201).send({ id: out.id });
  });

  async function decide(db: Db, id: string, userId: string, isOwner: boolean, to: "approved" | "rejected", note: string | null) {
    const r = (await db.query<{ status: string; requested_by: string }>("SELECT status, requested_by FROM purchase_requisitions WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!r) throw notFound();
    if (r.status !== "submitted") throw new AppError(409, "invalid_state", "يُعتمد أو يُرفض الطلب المُقدَّم فقط");
    if (r.requested_by === userId && !isOwner) throw forbidden("لا يمكنك البت في طلب قدّمته بنفسك");
    await db.query("UPDATE purchase_requisitions SET status = $2, decision_note = $3, decided_by = app_user_id(), decided_at = now() WHERE id = $1", [id, to, note]);
  }

  app.post("/requisitions/:id/approve", { preHandler: requireTenant("requisitions.approve") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    await tenantTx(req, async (db) => {
      await decide(db, id, req.tenant!.userId, req.tenant!.role === "owner", "approved", null);
      await auditTenant(db, req, "requisition.approved", "purchase_requisition", id);
    });
    return { ok: true };
  });

  app.post("/requisitions/:id/reject", { preHandler: requireTenant("requisitions.approve") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ note: z.string().trim().min(3, "اكتب سبب الرفض").max(300) }).parse(req.body);
    await tenantTx(req, async (db) => {
      await decide(db, id, req.tenant!.userId, req.tenant!.role === "owner", "rejected", b.note);
      await auditTenant(db, req, "requisition.rejected", "purchase_requisition", id, { note: b.note });
    });
    return { ok: true };
  });

  app.post("/requisitions/:id/cancel", { preHandler: requireTenant("requisitions.cancel") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    await tenantTx(req, async (db) => {
      const r = await db.query("UPDATE purchase_requisitions SET status = 'cancelled' WHERE id = $1 AND status IN ('submitted', 'approved')", [id]);
      if (!r.rowCount) throw new AppError(409, "invalid_state", "لا يمكن إلغاء الطلب في حالته الحالية");
      await auditTenant(db, req, "requisition.cancelled", "purchase_requisition", id);
    });
    return { ok: true };
  });

  /**
   * An approved requisition becomes draft purchase orders, one per chosen supplier. Lines left out stay open for a
   * later conversion; the requisition is "converted" once every line has its PO.
   */
  app.post("/requisitions/:id/convert", { preHandler: requireTenant("requisitions.convert") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const key = idempotencyKey(req);
    const b = z.object({
      lines: z.array(z.object({ itemId: z.string().uuid(), supplierId: z.string().uuid("اختر المورد لكل مادة"), unitPrice: z.number().min(0).max(1_000_000_000), quantity: z.number().positive().max(1_000_000_000).optional() }))
        .min(1, "اختر مادة واحدة على الأقل").max(200),
      expectedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().transform((v) => v ?? null),
    }).parse(req.body);
    const out = await tenantTx(req, async (db) => {
      const done = (await db.query<{ id: string }>("SELECT id FROM purchase_orders WHERE idempotency_key = $1", [key])).rows[0];
      if (done) return { replay: true, purchaseOrderIds: (await db.query<{ id: string }>("SELECT id FROM purchase_orders WHERE requisition_id = $1 ORDER BY po_number", [id])).rows.map((r) => r.id) };
      const r = (await db.query<{ status: string; location_id: string; pr_number: string }>("SELECT status, location_id, pr_number::text FROM purchase_requisitions WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!r) throw notFound();
      if (r.status !== "approved") throw new AppError(409, "invalid_state", "يُحوَّل الطلب المعتمد فقط إلى أوامر شراء");
      const items = new Map((await db.query<{ id: string; ingredient_id: string; quantity: number; purchase_order_id: string | null }>(
        "SELECT id, ingredient_id, quantity::float8 AS quantity, purchase_order_id FROM purchase_requisition_items WHERE requisition_id = $1", [id])).rows.map((x) => [x.id, x]));
      for (const l of b.lines) {
        const it = items.get(l.itemId);
        if (!it) throw badRequest("بند غير موجود في الطلب");
        if (it.purchase_order_id) throw new AppError(409, "already_converted", "أحد البنود حُوّل إلى أمر شراء من قبل");
      }
      const tax = (await db.query<{ rate: number }>("SELECT vat_rate_percent::float8 AS rate FROM tenant_settings")).rows[0]!.rate;
      const bySupplier = new Map<string, typeof b.lines>();
      for (const l of b.lines) bySupplier.set(l.supplierId, [...(bySupplier.get(l.supplierId) ?? []), l]);
      const ids: string[] = [];
      let first = true;
      for (const [supplierId, lines] of bySupplier) {
        const s = (await db.query<{ registered: boolean }>("SELECT coalesce(tax_id IS NOT NULL AND btrim(tax_id) <> '', false) AS registered FROM suppliers WHERE id = $1 AND is_active", [supplierId])).rows[0];
        if (!s) throw badRequest("أحد الموردين غير موجود أو موقوف");
        const priced = lines.map((l) => { const q = l.quantity ?? items.get(l.itemId)!.quantity; return { ...l, q, total: parseMoney(q * l.unitPrice) }; });
        const subtotal = priced.reduce((a, l) => a + l.total, 0);
        const vatRate = s.registered ? tax : 0;
        const vat = vatOf(subtotal, percentToBp(vatRate));
        const n = (await db.query<{ n: string }>("SELECT next_counter('po')::text AS n")).rows[0]!.n;
        // The first PO carries the request's Idempotency-Key; the others get their own.
        const po = (await db.query<{ id: string }>(
          `INSERT INTO purchase_orders (tenant_id, po_number, supplier_id, location_id, subtotal, total, vat_rate, vat_amount, idempotency_key, created_by, requisition_id, expected_date, notes)
           VALUES (app_tenant_id(), $1, $2, $3, $4, $4, $5, $6, CASE WHEN $7 THEN $8::uuid ELSE gen_random_uuid() END, app_user_id(), $9, $10, $11) RETURNING id`,
          [n, supplierId, r.location_id, formatMoney(subtotal), vatRate, formatMoney(vat), first, key, id, b.expectedDate, `من طلب الشراء رقم ${r.pr_number}`])).rows[0]!;
        first = false;
        for (const l of priced) {
          const it = items.get(l.itemId)!;
          await db.query("INSERT INTO purchase_items (tenant_id, purchase_order_id, ingredient_id, quantity, unit_price, line_total) VALUES (app_tenant_id(), $1, $2, $3, $4, $5)",
            [po.id, it.ingredient_id, round4(l.q), l.unitPrice, formatMoney(l.total)]);
          await db.query("UPDATE purchase_requisition_items SET purchase_order_id = $2 WHERE id = $1", [l.itemId, po.id]);
        }
        await auditTenant(db, req, "purchase.created", "purchase_order", po.id, { requisitionId: id, total: formatMoney(subtotal) });
        ids.push(po.id);
      }
      await db.query(
        `UPDATE purchase_requisitions SET status = 'converted' WHERE id = $1
            AND NOT EXISTS (SELECT 1 FROM purchase_requisition_items x WHERE x.requisition_id = $1 AND x.purchase_order_id IS NULL)`, [id]);
      return { replay: false, purchaseOrderIds: ids };
    });
    return reply.status(out.replay ? 200 : 201).send({ purchaseOrderIds: out.purchaseOrderIds });
  });

  /**
   * What to order for a location: ingredients at or below their minimum. Suggested = target − on hand − on order,
   * where target is the par level (or twice the minimum) and "on order" is what open POs still owe this location.
   */
  app.get("/purchasing/suggestions", { preHandler: requireTenant("requisitions.create", "purchases.create", "purchases.view") }, async (req) => {
    const q = req.query as { locationId?: string };
    if (!isUuid(q.locationId)) throw badRequest("اختر الموقع");
    return tenantTx(req, async (db) => {
      const { rows } = await db.query<{ ingredientId: string; name: string; purchaseUnit: string; onHand: number; onOrder: number; minStock: number; target: number; purchaseToBase: number }>(
        `WITH oo AS (
           SELECT pi.ingredient_id, sum(pi.quantity - pi.received_quantity) AS q
             FROM purchase_items pi JOIN purchase_orders po ON po.id = pi.purchase_order_id
            WHERE po.location_id = $1 AND po.status IN ('draft', 'approved', 'partially_received') GROUP BY 1)
         SELECT i.id AS "ingredientId", i.name, i.sku, pu.name AS "purchaseUnit", i.purchase_to_base::float8 AS "purchaseToBase",
                coalesce(sl.quantity, 0)::float8 AS "onHand", coalesce(oo.q * i.purchase_to_base, 0)::float8 AS "onOrder",
                i.min_stock::float8 AS "minStock", (CASE WHEN i.par_stock > 0 THEN i.par_stock ELSE i.min_stock * 2 END)::float8 AS target, bu.name AS "baseUnit"
           FROM ingredients i JOIN units pu ON pu.id = i.purchase_unit_id JOIN units bu ON bu.id = i.base_unit_id
           LEFT JOIN stock_levels sl ON sl.ingredient_id = i.id AND sl.location_id = $1
           LEFT JOIN oo ON oo.ingredient_id = i.id
          WHERE i.is_active AND i.min_stock > 0 AND coalesce(sl.quantity, 0) + coalesce(oo.q * i.purchase_to_base, 0) <= i.min_stock
          ORDER BY coalesce(sl.quantity, 0) / nullif(i.min_stock, 0), i.name`, [q.locationId]);
      const prices = await lastPrices(db, rows.map((r) => r.ingredientId));
      return {
        items: rows.map((r) => {
          const need = Math.max(0, r.target - r.onHand - r.onOrder);
          const lp = prices.get(r.ingredientId);
          return { ...r, suggestedQuantity: Math.ceil((need / r.purchaseToBase) * 100) / 100, lastPrice: lp?.price ?? null, lastSupplierId: lp?.supplierId ?? null, lastSupplierName: lp?.supplierName ?? null };
        }).filter((r) => r.suggestedQuantity > 0),
      };
    }, { readOnly: true });
  });
}
