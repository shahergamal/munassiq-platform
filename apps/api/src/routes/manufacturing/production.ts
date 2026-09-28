import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../../db/pool.ts";
import { postMoEvent } from "../../lib/accounting/posting.ts";
import { round4, round6 } from "../../lib/costing.ts";
import { AppError, badRequest, notFound } from "../../lib/errors.ts";
import { explode, rollUp, variances, type Bom, type CostContext } from "../../lib/manufacturing/bom.ts";
import { likePattern, pageMeta, parsePage } from "../../lib/pagination.ts";
import { auditTenant, isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";
import { addBatch, addDays, drawBatches, expiryRules, today } from "../restaurants/batches.ts";
import { lockLevels, movement, putIn, takeOut } from "../restaurants/inventory.ts";
import { idempotencyKey } from "../restaurants/purchases.ts";

// Production for factory workspaces (docs/manufacturing/ARCHITECTURE.md, M2): work centers, versioned bills of
// materials with a standard cost roll-up, and manufacturing orders whose every step is an append-only event that
// posts its journal entry in the same transaction. Cost figures come from the server only.

const code = z.string().trim().regex(/^[A-Za-z0-9-]{1,20}$/, "الرمز حروف إنجليزية وأرقام وشرطة (حتى 20)").transform((v) => v.toUpperCase());
const qty = z.number().positive("كمية أكبر من صفر").max(100_000_000);
const conflict = (message: string, codeName = "invalid_state") => new AppError(409, codeName, message);
const h = (riyals: number) => Math.round(riyals * 100);

// ── Loading BOMs and costs ────────────────────────────────────────────────────────────────────
export async function loadBoms(db: Db, where: string, params: unknown[]): Promise<Bom[]> {
  const heads = (await db.query<{ id: string; item_id: string; quantity: number }>(`SELECT id, item_id, quantity::float8 AS quantity FROM boms WHERE ${where}`, params)).rows;
  if (!heads.length) return [];
  const ids = heads.map((b) => b.id);
  const lines = (await db.query<{ bom_id: string; component_id: string; quantity: number; scrap: number; phantom: boolean }>(
    "SELECT bom_id, component_id, quantity::float8 AS quantity, scrap_percent::float8 AS scrap, phantom FROM bom_lines WHERE bom_id = ANY($1::uuid[]) ORDER BY seq", [ids])).rows;
  const ops = (await db.query<{ bom_id: string; seq: number; name: string; work_center_id: string; setup: number; run: number; labor: number; overhead: number }>(
    `SELECT o.bom_id, o.seq, o.name, o.work_center_id, o.setup_minutes::float8 AS setup, o.run_minutes::float8 AS run,
            w.labor_rate::float8 AS labor, w.overhead_rate::float8 AS overhead
       FROM bom_operations o JOIN work_centers w ON w.id = o.work_center_id WHERE o.bom_id = ANY($1::uuid[]) ORDER BY o.seq`, [ids])).rows;
  const bys = (await db.query<{ bom_id: string; item_id: string; quantity: number; share: number }>(
    "SELECT bom_id, item_id, quantity::float8 AS quantity, cost_share::float8 AS share FROM bom_byproducts WHERE bom_id = ANY($1::uuid[])", [ids])).rows;
  return heads.map((b) => ({
    id: b.id, itemId: b.item_id, quantity: b.quantity,
    lines: lines.filter((l) => l.bom_id === b.id).map((l) => ({ componentId: l.component_id, quantity: l.quantity, scrapPercent: l.scrap, phantom: l.phantom })),
    operations: ops.filter((o) => o.bom_id === b.id).map((o) => ({ seq: o.seq, name: o.name, workCenterId: o.work_center_id, setupMinutes: o.setup, runMinutes: o.run, laborRate: o.labor, overheadRate: o.overhead })),
    byproducts: bys.filter((x) => x.bom_id === b.id).map((x) => ({ itemId: x.item_id, quantity: x.quantity, costShare: x.share })),
  }));
}

/** Active BOMs (sub-assemblies and phantoms roll up through them) and company-wide weighted-average costs. */
async function costContext(db: Db): Promise<CostContext> {
  const active = new Map((await loadBoms(db, "status = 'active'", [])).map((b) => [b.itemId, b]));
  const avg = new Map((await db.query<{ id: string; c: number }>(
    `SELECT ingredient_id AS id, CASE WHEN sum(quantity) > 0 THEN sum(quantity * avg_cost) / sum(quantity) ELSE max(avg_cost) END::float8 AS c
       FROM stock_levels GROUP BY ingredient_id`)).rows.map((r) => [r.id, r.c]));
  return { bomOf: (i) => active.get(i), avgCost: (i) => avg.get(i) ?? 0 };
}

async function names(db: Db, ids: string[]) {
  const rows = (await db.query<{ id: string; name: string; sku: string; unit: string; item_type: string }>(
    "SELECT i.id, i.name, i.sku, u.name AS unit, i.item_type FROM ingredients i JOIN units u ON u.id = i.base_unit_id WHERE i.id = ANY($1::uuid[])", [ids])).rows;
  return new Map(rows.map((r) => [r.id, r]));
}

// ── Manufacturing order state ─────────────────────────────────────────────────────────────────
interface MoRow {
  id: string; mo_number: string; item_id: string; bom_id: string; quantity: number; location_id: string; output_location_id: string;
  status: string; standard_unit_cost: number | null; produced_quantity: number; cost_center_id: string | null;
}
async function lockMo(db: Db, id: string): Promise<MoRow> {
  const mo = (await db.query<MoRow>(
    `SELECT id, mo_number::text, item_id, bom_id, quantity::float8 AS quantity, location_id, output_location_id, status,
            standard_unit_cost::float8 AS standard_unit_cost, produced_quantity::float8 AS produced_quantity, cost_center_id
       FROM manufacturing_orders WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!mo) throw notFound("أمر التشغيل غير موجود");
  return mo;
}
const working = (mo: MoRow) => {
  if (mo.status !== "confirmed" && mo.status !== "in_progress") throw conflict(mo.status === "draft" ? "أكّد أمر التشغيل أولاً" : "أمر التشغيل مقفل أو ملغى");
};

/** Per component: issued quantity and value net of returns (value in riyals, exact to the halala). */
async function issuedOf(db: Db, moId: string) {
  const rows = (await db.query<{ c: string; q: number; v: number }>(
    `SELECT x->>'componentId' AS c, sum((x->>'quantity')::numeric * CASE e.kind WHEN 'issue' THEN 1 ELSE -1 END)::float8 AS q,
            sum((x->>'value')::numeric * CASE e.kind WHEN 'issue' THEN 1 ELSE -1 END)::float8 AS v
       FROM mo_events e CROSS JOIN LATERAL jsonb_array_elements(e.detail->'lines') x
      WHERE e.mo_id = $1 AND e.kind IN ('issue', 'return') GROUP BY 1`, [moId])).rows;
  return new Map(rows.map((r) => [r.c, { quantity: round4(r.q), value: Math.round(r.v * 100) / 100 }]));
}

async function wipOf(db: Db, moId: string): Promise<number> {
  return Number((await db.query<{ w: string }>("SELECT coalesce(sum(wip_delta), 0)::text AS w FROM mo_events WHERE mo_id = $1", [moId])).rows[0]!.w);
}

async function recordEvent(db: Db, mo: MoRow, kind: string, detail: object, wipDelta: number, key: string) {
  const n = (await db.query<{ n: string }>("SELECT next_counter('mo_event')::text AS n")).rows[0]!.n;
  const e = (await db.query<{ id: string }>(
    `INSERT INTO mo_events (tenant_id, mo_id, event_number, kind, detail, wip_delta, idempotency_key, created_by)
     VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, app_user_id()) RETURNING id`,
    [mo.id, n, kind, JSON.stringify(detail), (wipDelta / 100).toFixed(2), key])).rows[0]!;
  return e.id;
}

/**
 * Issues components into the order: stock leaves the production location at its average cost (earliest expiry
 * first), the value enters the order's work in progress. One event, one journal entry.
 */
async function issue(db: Db, mo: MoRow, lines: { componentId: string; quantity: number }[], key: string, note: string | null) {
  const planned = new Set((await db.query<{ component_id: string }>("SELECT component_id FROM mo_components WHERE mo_id = $1", [mo.id])).rows.map((r) => r.component_id));
  for (const l of lines) if (!planned.has(l.componentId)) throw badRequest("المكوّن ليس في خطة هذا الأمر");
  const items = lines.filter((l) => l.quantity > 0).map((l) => ({ componentId: l.componentId, quantity: round4(l.quantity) }));
  if (!items.length) throw badRequest("أدخل كمية لمكوّن واحد على الأقل");
  await lockLevels(db, mo.location_id, items.map((i) => i.componentId));
  const drawn = new Map<string, Awaited<ReturnType<typeof drawBatches>>>();
  for (const i of items) drawn.set(i.componentId, await drawBatches(db, mo.location_id, i.componentId, i.quantity));
  const taken = await takeOut(db, mo.location_id, items.map((i) => ({ ingredientId: i.componentId, quantity: i.quantity })));
  const detailLines = taken.map((t) => ({
    componentId: t.ingredientId, quantity: t.quantity, unitCost: round6(t.unitCost), value: h(t.quantity * t.unitCost) / 100,
    batches: (drawn.get(t.ingredientId) ?? []).map((d) => ({ batchId: d.batchId, batchNo: d.batchNo, quantity: d.quantity, expiryDate: d.expiryDate })),
  }));
  const total = detailLines.reduce((a, l) => a + h(l.value), 0);
  const eventId = await recordEvent(db, mo, "issue", { lines: detailLines, note }, total, key);
  for (const l of detailLines) {
    await movement(db, { locationId: mo.location_id, ingredientId: l.componentId, type: "production_out", quantity: -l.quantity, unitCost: l.unitCost, refType: "mo_event", refId: eventId });
  }
  if (mo.status === "confirmed") await db.query("UPDATE manufacturing_orders SET status = 'in_progress' WHERE id = $1", [mo.id]);
  await postMoEvent(db, eventId);
  return { eventId, value: total / 100 };
}

// ── Routes ────────────────────────────────────────────────────────────────────────────────────
/**
 * An order's components, operations and costs: materials and conversion charged, output credited, the closing
 * variance, what is left in WIP, and the price / usage / efficiency split. Shared by the order page and the
 * production report, so both show the same figures.
 */
export async function moCostSummary(db: Db, id: string, o: { quantity: number; producedQuantity: number; standardUnitCost: number | null; status: string; locationId: string }) {
  const issued = await issuedOf(db, id);
  const comps = (await db.query<{ component_id: string; name: string; sku: string; unit: string; required: number; std: number; available: number }>(
    `SELECT c.component_id, i.name, i.sku, u.name AS unit, c.required_qty::float8 AS required, c.standard_cost::float8 AS std,
            coalesce((SELECT quantity FROM stock_levels s WHERE s.location_id = $2 AND s.ingredient_id = c.component_id), 0)::float8 AS available
       FROM mo_components c JOIN ingredients i ON i.id = c.component_id JOIN units u ON u.id = i.base_unit_id WHERE c.mo_id = $1 ORDER BY i.name`, [id, o.locationId])).rows;
  const ops = (await db.query<{ seq: number; name: string; work_center_id: string; wc: string; planned: number; labor_rate: number; overhead_rate: number }>(
    `SELECT m.seq, m.name, m.work_center_id, w.name AS wc, m.planned_minutes::float8 AS planned, m.labor_rate::float8 AS labor_rate, m.overhead_rate::float8 AS overhead_rate
       FROM mo_operations m JOIN work_centers w ON w.id = m.work_center_id WHERE m.mo_id = $1 ORDER BY m.seq`, [id])).rows;
  const actualMin = new Map((await db.query<{ seq: number; m: number }>(
    "SELECT (detail->>'seq')::int AS seq, sum((detail->>'minutes')::numeric)::float8 AS m FROM mo_events WHERE mo_id = $1 AND kind = 'labor' GROUP BY 1", [id])).rows.map((r) => [r.seq, r.m]));
  const wip = await wipOf(db, id);
  const ratio = o.quantity > 0 ? o.producedQuantity / o.quantity : 0;
  const sums = (await db.query<{ k: string; v: number }>(
    "SELECT kind AS k, sum(wip_delta)::float8 AS v FROM mo_events WHERE mo_id = $1 GROUP BY kind", [id])).rows;
  const sum = (k: string) => sums.find((s) => s.k === k)?.v ?? 0;
  const components = comps.map((c) => {
    const iss = issued.get(c.component_id) ?? { quantity: 0, value: 0 };
    return { componentId: c.component_id, name: c.name, sku: c.sku, unit: c.unit, requiredQty: c.required, standardCost: c.std, issuedQty: iss.quantity,
      issuedValue: iss.value, remainingQty: round4(Math.max(0, c.required - iss.quantity)), availableQty: c.available };
  });
  const operations = ops.map((m) => ({ seq: m.seq, name: m.name, workCenterId: m.work_center_id, workCenterName: m.wc, plannedMinutes: m.planned,
    actualMinutes: actualMin.get(m.seq) ?? 0, laborRate: m.labor_rate, overheadRate: m.overhead_rate }));
  return {
    components, operations,
    costs: {
      materials: Math.round((sum("issue") + sum("return")) * 100) / 100,
      conversion: sum("labor"),
      output: -sum("output"),
      variance: -sum("close"),
      wip,
      standardForOutput: Math.round((o.standardUnitCost ?? 0) * o.producedQuantity * 100) / 100,
      ...(o.status === "draft" ? { price: 0, usage: 0, efficiency: 0 } : variances({ producedRatio: ratio, components, operations })),
    },
  };
}

export default async function productionRoutes(app: FastifyInstance) {
  // Work centers ──────────────────────────────────────────────────────────────────────────────
  app.get("/work-centers", { preHandler: requireTenant("work_centers.view", "boms.view") }, async (req) =>
    tenantTx(req, async (db) => ({
      items: (await db.query(
        `SELECT w.id, w.code, w.name, w.location_id AS "locationId", l.name AS "locationName", w.cost_center_id AS "costCenterId", c.name AS "costCenterName",
                w.hours_per_day::float8 AS "hoursPerDay", w.labor_rate::float8 AS "laborRate", w.overhead_rate::float8 AS "overheadRate", w.is_active AS "isActive",
                (SELECT count(DISTINCT o.bom_id)::int FROM bom_operations o JOIN boms b ON b.id = o.bom_id WHERE o.work_center_id = w.id AND b.status = 'active') AS "activeBoms"
           FROM work_centers w LEFT JOIN locations l ON l.id = w.location_id LEFT JOIN cost_centers c ON c.id = w.cost_center_id
          ORDER BY w.is_active DESC, w.code`)).rows,
    }), { readOnly: true }));

  const wcBody = z.object({
    name: z.string().trim().min(2, "أدخل اسم مركز العمل").max(120),
    locationId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
    costCenterId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
    hoursPerDay: z.number().gt(0).max(24).default(8),
    laborRate: z.number().min(0).max(100_000).default(0),
    overheadRate: z.number().min(0).max(100_000).default(0),
  });
  const refsOk = async (db: Db, b: { locationId: string | null; costCenterId: string | null }) => {
    if (b.locationId && !(await db.query("SELECT 1 FROM locations WHERE id = $1", [b.locationId])).rowCount) throw badRequest("الموقع غير موجود");
    if (b.costCenterId && !(await db.query("SELECT 1 FROM cost_centers WHERE id = $1 AND is_active", [b.costCenterId])).rowCount) throw badRequest("مركز التكلفة غير موجود أو موقوف");
  };

  app.post("/work-centers", { preHandler: requireTenant("work_centers.create") }, async (req, reply) => {
    const b = wcBody.extend({ code }).parse(req.body);
    const id = await tenantTx(req, async (db) => {
      await refsOk(db, b);
      try {
        const r = (await db.query<{ id: string }>(
          `INSERT INTO work_centers (tenant_id, code, name, location_id, cost_center_id, hours_per_day, labor_rate, overhead_rate)
           VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [b.code, b.name, b.locationId, b.costCenterId, b.hoursPerDay, b.laborRate, b.overheadRate])).rows[0]!;
        await auditTenant(db, req, "work_center.created", "work_center", r.id, b);
        return r.id;
      } catch (e) {
        if ((e as { code?: string }).code === "23505") throw new AppError(409, "duplicate", "يوجد مركز عمل بنفس الرمز", [{ path: "code", message: "رمز مستخدم" }]);
        throw e;
      }
    });
    return reply.status(201).send({ id });
  });

  // Rates changed here apply to new BOM costings and new orders; confirmed orders keep the rates they froze.
  app.patch("/work-centers/:id", { preHandler: requireTenant("work_centers.edit") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = wcBody.partial().extend({ isActive: z.boolean().optional() }).parse(req.body);
    await tenantTx(req, async (db) => {
      await refsOk(db, { locationId: b.locationId ?? null, costCenterId: b.costCenterId ?? null });
      const r = await db.query(
        `UPDATE work_centers SET name = coalesce($2, name), location_id = CASE WHEN $3 THEN $4::uuid ELSE location_id END,
                cost_center_id = CASE WHEN $5 THEN $6::uuid ELSE cost_center_id END, hours_per_day = coalesce($7, hours_per_day),
                labor_rate = coalesce($8, labor_rate), overhead_rate = coalesce($9, overhead_rate), is_active = coalesce($10, is_active) WHERE id = $1`,
        [id, b.name ?? null, b.locationId !== undefined, b.locationId ?? null, b.costCenterId !== undefined, b.costCenterId ?? null,
          b.hoursPerDay ?? null, b.laborRate ?? null, b.overheadRate ?? null, b.isActive ?? null]);
      if (!r.rowCount) throw notFound("مركز العمل غير موجود");
      await auditTenant(db, req, "work_center.updated", "work_center", id, b);
    });
    return { ok: true };
  });

  // Bills of materials ────────────────────────────────────────────────────────────────────────
  app.get("/boms", { preHandler: requireTenant("boms.view") }, async (req) => {
    const q = req.query as { q?: string; status?: string; itemId?: string; page?: string; pageSize?: string };
    const page = parsePage(q);
    const search = q.q?.trim() ? likePattern(q.q) : null;
    const status = ["draft", "active", "archived"].includes(q.status ?? "") ? q.status! : null;
    return tenantTx(req, async (db) => {
      const { rows } = await db.query(
        `SELECT b.id, b.version, b.status, b.quantity::float8 AS quantity, b.created_at AS "createdAt", b.activated_at AS "activatedAt",
                i.id AS "itemId", i.name AS "itemName", i.sku AS "itemSku", i.item_type AS "itemType", u.name AS unit,
                (SELECT count(*)::int FROM bom_lines l WHERE l.bom_id = b.id) AS "componentsCount",
                (SELECT count(*)::int FROM bom_operations o WHERE o.bom_id = b.id) AS "operationsCount",
                count(*) OVER()::int AS "_total"
           FROM boms b JOIN ingredients i ON i.id = b.item_id JOIN units u ON u.id = i.base_unit_id
          WHERE ($1::text IS NULL OR i.name ILIKE $1 OR i.sku ILIKE $1) AND ($2::text IS NULL OR b.status = $2) AND ($3::uuid IS NULL OR b.item_id = $3)
          ORDER BY CASE b.status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, i.name, b.version DESC LIMIT $4 OFFSET $5`,
        [search, status, isUuid(q.itemId) ? q.itemId : null, page.pageSize, page.offset]);
      return { items: rows.map(({ _total, ...r }) => r), meta: pageMeta(page, rows[0]?._total ?? 0) };
    }, { readOnly: true });
  });

  app.get("/boms/:id", { preHandler: requireTenant("boms.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const head = (await db.query(
        `SELECT b.id, b.version, b.status, b.quantity::float8 AS quantity, b.notes, b.created_at AS "createdAt", b.activated_at AS "activatedAt",
                i.id AS "itemId", i.name AS "itemName", i.sku AS "itemSku", i.item_type AS "itemType", u.name AS unit,
                (SELECT json_agg(json_build_object('id', x.id, 'version', x.version, 'status', x.status) ORDER BY x.version DESC) FROM boms x WHERE x.item_id = b.item_id) AS versions
           FROM boms b JOIN ingredients i ON i.id = b.item_id JOIN units u ON u.id = i.base_unit_id WHERE b.id = $1`, [id])).rows[0];
      if (!head) throw notFound("قائمة المواد غير موجودة");
      const bom = (await loadBoms(db, "id = $1", [id]))[0]!;
      const ctx = await costContext(db);
      const n = await names(db, [...bom.lines.map((l) => l.componentId), ...bom.byproducts.map((b) => b.itemId)]);
      const wcs = new Map((await db.query<{ id: string; name: string; code: string }>("SELECT id, name, code FROM work_centers")).rows.map((w) => [w.id, w]));
      // A draft that would close a cycle, or a phantom without a BOM, still shows; the cost says why it cannot be computed.
      let cost: ReturnType<typeof rollUp> | null = null;
      let costError: string | null = null;
      try { cost = rollUp(bom, ctx); } catch (e) { costError = (e as Error).message; }
      return {
        ...head,
        lines: bom.lines.map((l, i) => ({ ...l, seq: i + 1, name: n.get(l.componentId)?.name, sku: n.get(l.componentId)?.sku, unit: n.get(l.componentId)?.unit,
          itemType: n.get(l.componentId)?.item_type, hasBom: Boolean(ctx.bomOf(l.componentId)), unitCost: cost?.lines[i]?.unitCost ?? null, cost: cost?.lines[i]?.cost ?? null })),
        operations: bom.operations.map((o, i) => ({ ...o, workCenterName: wcs.get(o.workCenterId)?.name, workCenterCode: wcs.get(o.workCenterId)?.code,
          labor: cost?.operations[i]?.labor ?? null, overhead: cost?.operations[i]?.overhead ?? null })),
        byproducts: bom.byproducts.map((b, i) => ({ ...b, name: n.get(b.itemId)?.name, unit: n.get(b.itemId)?.unit, value: cost?.byproducts[i]?.value ?? null })),
        cost: cost && { material: cost.material, labor: cost.labor, overhead: cost.overhead, total: cost.total, mainCost: cost.mainCost, unitCost: cost.unitCost },
        costError,
      };
    }, { readOnly: true });
  });

  const bomBody = z.object({
    quantity: qty,
    notes: z.string().trim().max(1000).nullable().optional().transform((v) => v || null),
    lines: z.array(z.object({
      componentId: z.string().uuid(), quantity: qty,
      scrapPercent: z.number().min(0).lt(100).default(0), phantom: z.boolean().default(false),
    })).min(1, "أضف مكوّناً واحداً على الأقل").max(200),
    operations: z.array(z.object({
      name: z.string().trim().min(2, "اسم العملية").max(120), workCenterId: z.string().uuid(),
      setupMinutes: z.number().min(0).max(100_000).default(0), runMinutes: z.number().min(0).max(10_000_000).default(0),
    })).max(50).default([]),
    byproducts: z.array(z.object({ itemId: z.string().uuid(), quantity: qty, costShare: z.number().min(0).lt(100).default(0) })).max(20).default([]),
  });
  type BomBody = z.infer<typeof bomBody>;

  async function writeBom(db: Db, bomId: string, itemId: string, b: BomBody) {
    const ids = [...new Set([...b.lines.map((l) => l.componentId), ...b.byproducts.map((x) => x.itemId)])];
    if (b.lines.some((l) => l.componentId === itemId) || b.byproducts.some((x) => x.itemId === itemId)) throw badRequest("لا يدخل الصنف في تركيب نفسه");
    if (new Set(b.lines.map((l) => l.componentId)).size !== b.lines.length) throw badRequest("مكوّن مكرر: اجمع كميته في سطر واحد");
    if (b.byproducts.some((x) => b.lines.some((l) => l.componentId === x.itemId))) throw badRequest("المنتج الثانوي لا يكون مكوّناً في نفس القائمة");
    if (b.byproducts.reduce((a, x) => a + x.costShare, 0) >= 100) throw badRequest("نصيب المنتجات الثانوية من التكلفة يجب أن يقل عن 100٪");
    const found = (await db.query<{ id: string }>("SELECT id FROM ingredients WHERE id = ANY($1::uuid[]) AND is_active", [ids])).rowCount;
    if (found !== ids.length) throw badRequest("صنف غير موجود أو موقوف في القائمة");
    const wcIds = [...new Set(b.operations.map((o) => o.workCenterId))];
    if (wcIds.length && (await db.query("SELECT 1 FROM work_centers WHERE id = ANY($1::uuid[]) AND is_active", [wcIds])).rowCount !== wcIds.length) throw badRequest("مركز عمل غير موجود أو موقوف");
    await db.query("UPDATE boms SET quantity = $2, notes = $3 WHERE id = $1", [bomId, round4(b.quantity), b.notes]);
    await db.query("DELETE FROM bom_lines WHERE bom_id = $1", [bomId]);
    await db.query("DELETE FROM bom_operations WHERE bom_id = $1", [bomId]);
    await db.query("DELETE FROM bom_byproducts WHERE bom_id = $1", [bomId]);
    for (const [i, l] of b.lines.entries()) {
      await db.query("INSERT INTO bom_lines (tenant_id, bom_id, seq, component_id, quantity, scrap_percent, phantom) VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6)",
        [bomId, i + 1, l.componentId, round4(l.quantity), l.scrapPercent, l.phantom]);
    }
    for (const [i, o] of b.operations.entries()) {
      await db.query("INSERT INTO bom_operations (tenant_id, bom_id, seq, name, work_center_id, setup_minutes, run_minutes) VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6)",
        [bomId, i + 1, o.name, o.workCenterId, o.setupMinutes, o.runMinutes]);
    }
    for (const x of b.byproducts) {
      await db.query("INSERT INTO bom_byproducts (tenant_id, bom_id, item_id, quantity, cost_share) VALUES (app_tenant_id(), $1, $2, $3, $4)", [bomId, x.itemId, round4(x.quantity), x.costShare]);
    }
  }

  // A new draft: from scratch, or a copy of an existing version (the usual way to change an active BOM).
  app.post("/boms", { preHandler: requireTenant("boms.create") }, async (req, reply) => {
    const b = z.object({ itemId: z.string().uuid(), copyFrom: z.string().uuid().optional() }).and(bomBody.partial()).parse(req.body);
    const id = await tenantTx(req, async (db) => {
      const item = (await db.query<{ item_type: string; is_active: boolean }>("SELECT item_type, is_active FROM ingredients WHERE id = $1", [b.itemId])).rows[0];
      if (!item?.is_active) throw badRequest("الصنف غير موجود أو موقوف");
      if (item.item_type !== "finished" && item.item_type !== "semi_finished") throw badRequest("قائمة المواد لمنتج تام أو نصف مصنّع فقط. غيّر نوع الصنف أولاً");
      // Versions of one item are numbered in order; the item row lock keeps two drafts from taking the same number.
      await db.query("SELECT 1 FROM ingredients WHERE id = $1 FOR UPDATE", [b.itemId]);
      const version = Number((await db.query<{ v: string }>("SELECT coalesce(max(version), 0) + 1 AS v FROM boms WHERE item_id = $1", [b.itemId])).rows[0]!.v);
      let content: BomBody;
      if (b.copyFrom) {
        const src = (await loadBoms(db, "id = $1 AND item_id = $2", [b.copyFrom, b.itemId]))[0];
        if (!src) throw notFound("الإصدار المنسوخ غير موجود");
        const notes = (await db.query<{ notes: string | null }>("SELECT notes FROM boms WHERE id = $1", [b.copyFrom])).rows[0]!.notes;
        content = { quantity: src.quantity, notes, lines: src.lines, byproducts: src.byproducts,
          operations: src.operations.map((o) => ({ name: o.name, workCenterId: o.workCenterId, setupMinutes: o.setupMinutes, runMinutes: o.runMinutes })) };
      } else {
        content = bomBody.parse(b);
      }
      const r = (await db.query<{ id: string }>(
        "INSERT INTO boms (tenant_id, item_id, version, quantity, created_by) VALUES (app_tenant_id(), $1, $2, $3, app_user_id()) RETURNING id", [b.itemId, version, content.quantity])).rows[0]!;
      await writeBom(db, r.id, b.itemId, content);
      await auditTenant(db, req, "bom.created", "bom", r.id, { itemId: b.itemId, version, copyFrom: b.copyFrom ?? null });
      return r.id;
    });
    return reply.status(201).send({ id });
  });

  const draftOf = async (db: Db, id: string) => {
    const bom = (await db.query<{ status: string; item_id: string }>("SELECT status, item_id FROM boms WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!bom) throw notFound("قائمة المواد غير موجودة");
    if (bom.status !== "draft") throw conflict("الإصدار المعتمد لا يُعدَّل. أنشئ إصداراً جديداً منه", "bom_frozen");
    return bom;
  };

  app.put("/boms/:id", { preHandler: requireTenant("boms.edit") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = bomBody.parse(req.body);
    await tenantTx(req, async (db) => {
      const bom = await draftOf(db, id);
      await writeBom(db, id, bom.item_id, b);
      await auditTenant(db, req, "bom.updated", "bom", id);
    });
    return { ok: true };
  });

  app.delete("/boms/:id", { preHandler: requireTenant("boms.delete") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    await tenantTx(req, async (db) => {
      await draftOf(db, id);
      await db.query("DELETE FROM boms WHERE id = $1", [id]);
      await auditTenant(db, req, "bom.deleted", "bom", id);
    });
    return { ok: true };
  });

  // Activation: the version new orders use. The previous active version is archived (orders made from it keep it).
  app.post("/boms/:id/activate", { preHandler: requireTenant("boms.approve") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const bom = await draftOf(db, id);
      const ctx = await costContext(db);
      const self = (await loadBoms(db, "id = $1", [id]))[0]!;
      // Checked as if already active: a cycle through other active BOMs, or a phantom without one, is refused now.
      const cost = rollUp(self, { ...ctx, bomOf: (i) => (i === self.itemId ? self : ctx.bomOf(i)) });
      explode(self, self.quantity, { bomOf: (i) => (i === self.itemId ? self : ctx.bomOf(i)) });
      await db.query("UPDATE boms SET status = 'archived' WHERE item_id = $1 AND status = 'active'", [bom.item_id]);
      await db.query("UPDATE boms SET status = 'active', activated_at = now(), activated_by = app_user_id() WHERE id = $1", [id]);
      await auditTenant(db, req, "bom.activated", "bom", id, { unitCost: cost.unitCost });
      return { ok: true, unitCost: cost.unitCost };
    });
  });

  app.post("/boms/:id/archive", { preHandler: requireTenant("boms.approve") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    await tenantTx(req, async (db) => {
      const r = await db.query("UPDATE boms SET status = 'archived' WHERE id = $1 AND status = 'active'", [id]);
      if (!r.rowCount) throw conflict("الإصدار ليس معتمداً");
      await auditTenant(db, req, "bom.archived", "bom", id);
    });
    return { ok: true };
  });

  // Manufacturing orders ──────────────────────────────────────────────────────────────────────
  app.get("/manufacturing-orders", { preHandler: requireTenant("mos.view") }, async (req) => {
    const q = req.query as { q?: string; status?: string; page?: string; pageSize?: string };
    const page = parsePage(q);
    const search = q.q?.trim() ? likePattern(q.q) : null;
    const status = ["draft", "confirmed", "in_progress", "closed", "cancelled", "open"].includes(q.status ?? "") ? q.status! : null;
    return tenantTx(req, async (db) => {
      const { rows } = await db.query(
        `SELECT o.id, o.mo_number::int AS number, o.status, o.quantity::float8 AS quantity, o.produced_quantity::float8 AS "producedQuantity",
                o.planned_start::text AS "plannedStart", o.due_date::text AS "dueDate", o.created_at AS "createdAt",
                i.name AS "itemName", i.sku AS "itemSku", u.name AS unit, b.version AS "bomVersion", l.name AS "locationName",
                o.standard_unit_cost::float8 AS "standardUnitCost",
                (SELECT coalesce(sum(e.wip_delta), 0) FROM mo_events e WHERE e.mo_id = o.id)::float8 AS wip,
                (o.status NOT IN ('closed', 'cancelled') AND o.due_date < (now() AT TIME ZONE 'Asia/Riyadh')::date) AS late,
                count(*) OVER()::int AS "_total"
           FROM manufacturing_orders o JOIN ingredients i ON i.id = o.item_id JOIN units u ON u.id = i.base_unit_id
           JOIN boms b ON b.id = o.bom_id JOIN locations l ON l.id = o.location_id
          WHERE ($1::text IS NULL OR i.name ILIKE $1 OR o.mo_number::text = trim(both '%' from $1))
            AND ($2::text IS NULL OR ($2 = 'open' AND o.status IN ('draft', 'confirmed', 'in_progress')) OR o.status = $2)
          ORDER BY CASE o.status WHEN 'in_progress' THEN 0 WHEN 'confirmed' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END, o.mo_number DESC LIMIT $3 OFFSET $4`,
        [search, status, page.pageSize, page.offset]);
      const counts = (await db.query<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM manufacturing_orders GROUP BY status")).rows;
      return { items: rows.map(({ _total, ...r }) => r), meta: pageMeta(page, rows[0]?._total ?? 0), counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) };
    }, { readOnly: true });
  });

  app.get("/manufacturing-orders/:id", { preHandler: requireTenant("mos.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const o = (await db.query(
        `SELECT o.id, o.mo_number::int AS number, o.status, o.quantity::float8 AS quantity, o.produced_quantity::float8 AS "producedQuantity",
                o.planned_start::text AS "plannedStart", o.due_date::text AS "dueDate", o.notes, o.created_at AS "createdAt", o.confirmed_at AS "confirmedAt",
                o.closed_at AS "closedAt", o.cancelled_at AS "cancelledAt", o.cancel_reason AS "cancelReason", o.standard_unit_cost::float8 AS "standardUnitCost",
                o.item_id AS "itemId", i.name AS "itemName", i.sku AS "itemSku", u.name AS unit, i.track_expiry AS "trackExpiry",
                o.bom_id AS "bomId", b.version AS "bomVersion", o.location_id AS "locationId", l.name AS "locationName",
                o.output_location_id AS "outputLocationId", ol.name AS "outputLocationName", o.cost_center_id AS "costCenterId", c.name AS "costCenterName"
           FROM manufacturing_orders o JOIN ingredients i ON i.id = o.item_id JOIN units u ON u.id = i.base_unit_id JOIN boms b ON b.id = o.bom_id
           JOIN locations l ON l.id = o.location_id JOIN locations ol ON ol.id = o.output_location_id LEFT JOIN cost_centers c ON c.id = o.cost_center_id
          WHERE o.id = $1`, [id])).rows[0];
      if (!o) throw notFound("أمر التشغيل غير موجود");
      const { components, operations, costs } = await moCostSummary(db, id, o);
      const bys = (await db.query(
        `SELECT b.item_id AS "itemId", i.name, u.name AS unit, b.per_unit::float8 AS "perUnit", b.unit_cost::float8 AS "unitCost"
           FROM mo_byproducts b JOIN ingredients i ON i.id = b.item_id JOIN units u ON u.id = i.base_unit_id WHERE b.mo_id = $1`, [id])).rows;
      const events = (await db.query(
        `SELECT e.id, e.event_number::int AS number, e.kind, e.detail, e.wip_delta::float8 AS "wipDelta", e.created_at AS "createdAt", j.id AS "journalId", j.entry_number::int AS "journalNumber"
           FROM mo_events e LEFT JOIN journal_entries j ON j.source_key = 'mo_event:' || e.id::text WHERE e.mo_id = $1 ORDER BY e.created_at, e.event_number`, [id])).rows;
      return { ...o, components, operations, byproducts: bys, events, costs };
    }, { readOnly: true });
  });

  const moBody = z.object({
    itemId: z.string().uuid("اختر المنتج"),
    bomId: z.string().uuid().optional(),
    quantity: qty,
    locationId: z.string().uuid("اختر موقع الإنتاج"),
    outputLocationId: z.string().uuid().optional(),
    costCenterId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
    plannedStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().transform((v) => v ?? null),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().transform((v) => v ?? null),
    notes: z.string().trim().max(1000).nullable().optional().transform((v) => v || null),
  }).refine((b) => !b.plannedStart || !b.dueDate || b.plannedStart <= b.dueDate, { message: "تاريخ التسليم قبل تاريخ البدء", path: ["dueDate"] });

  async function checkMoRefs(db: Db, b: z.infer<typeof moBody>) {
    const bom = b.bomId
      ? (await db.query<{ id: string; item_id: string; status: string }>("SELECT id, item_id, status FROM boms WHERE id = $1", [b.bomId])).rows[0]
      : (await db.query<{ id: string; item_id: string; status: string }>("SELECT id, item_id, status FROM boms WHERE item_id = $1 AND status = 'active'", [b.itemId])).rows[0];
    if (!bom) throw new AppError(422, "no_active_bom", "لا توجد قائمة مواد معتمدة لهذا المنتج. اعتمد قائمته أولاً", [{ path: "itemId", message: "اعتمد قائمة المواد أولاً" }]);
    if (bom.item_id !== b.itemId) throw badRequest("قائمة المواد لا تخص هذا المنتج");
    if (bom.status !== "active") throw badRequest("اختر الإصدار المعتمد من قائمة المواد");
    const locs = [...new Set([b.locationId, b.outputLocationId ?? b.locationId])];
    if ((await db.query("SELECT 1 FROM locations WHERE id = ANY($1::uuid[]) AND is_active", [locs])).rowCount !== locs.length) throw badRequest("الموقع غير موجود أو موقوف");
    if (b.costCenterId && !(await db.query("SELECT 1 FROM cost_centers WHERE id = $1 AND is_active", [b.costCenterId])).rowCount) throw badRequest("مركز التكلفة غير موجود أو موقوف");
    return bom.id;
  }

  app.post("/manufacturing-orders", { preHandler: requireTenant("mos.create") }, async (req, reply) => {
    const key = idempotencyKey(req);
    const b = moBody.parse(req.body);
    const out = await tenantTx(req, async (db) => {
      const dup = (await db.query<{ id: string }>("SELECT id FROM manufacturing_orders WHERE idempotency_key = $1", [key])).rows[0];
      if (dup) return { id: dup.id, replay: true };
      const bomId = await checkMoRefs(db, b);
      const n = (await db.query<{ n: string }>("SELECT next_counter('manufacturing_order')::text AS n")).rows[0]!.n;
      const r = (await db.query<{ id: string }>(
        `INSERT INTO manufacturing_orders (tenant_id, mo_number, item_id, bom_id, quantity, location_id, output_location_id, cost_center_id, planned_start, due_date, notes, idempotency_key, created_by)
         VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, app_user_id()) RETURNING id`,
        [n, b.itemId, bomId, round4(b.quantity), b.locationId, b.outputLocationId ?? b.locationId, b.costCenterId, b.plannedStart, b.dueDate, b.notes, key])).rows[0]!;
      await auditTenant(db, req, "mo.created", "manufacturing_order", r.id, { number: n, quantity: b.quantity });
      return { id: r.id, replay: false };
    });
    return reply.status(out.replay ? 200 : 201).send({ id: out.id });
  });

  app.put("/manufacturing-orders/:id", { preHandler: requireTenant("mos.create") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = moBody.parse(req.body);
    await tenantTx(req, async (db) => {
      const mo = await lockMo(db, id);
      if (mo.status !== "draft") throw conflict("يُعدَّل الأمر وهو مسودة فقط");
      const bomId = await checkMoRefs(db, b);
      await db.query(
        `UPDATE manufacturing_orders SET item_id = $2, bom_id = $3, quantity = $4, location_id = $5, output_location_id = $6, cost_center_id = $7,
                planned_start = $8, due_date = $9, notes = $10 WHERE id = $1`,
        [id, b.itemId, bomId, round4(b.quantity), b.locationId, b.outputLocationId ?? b.locationId, b.costCenterId, b.plannedStart, b.dueDate, b.notes]);
      await auditTenant(db, req, "mo.updated", "manufacturing_order", id);
    });
    return { ok: true };
  });

  /**
   * Confirmation freezes the plan: the BOM exploded for the quantity (phantoms replaced by their components), the
   * operations with the work centers' current rates, and the standard unit cost every output will be valued at.
   */
  app.post("/manufacturing-orders/:id/confirm", { preHandler: requireTenant("mos.confirm") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const mo = await lockMo(db, id);
      if (mo.status !== "draft") throw conflict("الأمر مؤكد من قبل");
      const ctx = await costContext(db);
      const bom = (await loadBoms(db, "id = $1", [mo.bom_id]))[0]!;
      const cost = rollUp(bom, ctx);
      const plan = explode(bom, mo.quantity, ctx);
      // Standard cost of each issued component: its own roll-up (sub-assemblies) or its average cost.
      const stdOf = (c: string) => { const sub = ctx.bomOf(c); return sub ? rollUp(sub, ctx).unitCost : ctx.avgCost(c); };
      for (const c of plan.components) {
        await db.query("INSERT INTO mo_components (tenant_id, mo_id, component_id, required_qty, standard_cost) VALUES (app_tenant_id(), $1, $2, $3, $4)",
          [id, c.componentId, c.quantity, round6(stdOf(c.componentId))]);
      }
      for (const o of plan.operations) {
        await db.query("INSERT INTO mo_operations (tenant_id, mo_id, seq, name, work_center_id, planned_minutes, labor_rate, overhead_rate) VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7)",
          [id, o.seq, o.name, o.workCenterId, o.minutes, o.laborRate, o.overheadRate]);
      }
      for (const b of cost.byproducts) {
        await db.query("INSERT INTO mo_byproducts (tenant_id, mo_id, item_id, per_unit, unit_cost) VALUES (app_tenant_id(), $1, $2, $3, $4)",
          [id, b.itemId, round6(b.quantity / bom.quantity), b.unitCost]);
      }
      await db.query("UPDATE manufacturing_orders SET status = 'confirmed', standard_unit_cost = $2, confirmed_at = now(), confirmed_by = app_user_id() WHERE id = $1",
        [id, cost.unitCost]);
      await auditTenant(db, req, "mo.confirmed", "manufacturing_order", id, { standardUnitCost: cost.unitCost });
      return { ok: true, standardUnitCost: cost.unitCost };
    });
  });

  const replay = async (db: Db, key: string) => (await db.query<{ id: string }>("SELECT id FROM mo_events WHERE idempotency_key = $1", [key])).rows[0];

  // Issue materials: listed quantities, or everything still to issue (`remaining: true`).
  app.post("/manufacturing-orders/:id/issue", { preHandler: requireTenant("mos.issue") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const key = idempotencyKey(req);
    const b = z.object({
      remaining: z.boolean().default(false),
      lines: z.array(z.object({ componentId: z.string().uuid(), quantity: z.number().min(0).max(100_000_000) })).max(200).default([]),
      note: z.string().trim().max(300).nullable().optional().transform((v) => v || null),
    }).parse(req.body);
    const out = await tenantTx(req, async (db) => {
      const dup = await replay(db, key);
      if (dup) return { eventId: dup.id, replay: true };
      const mo = await lockMo(db, id);
      working(mo);
      let lines = b.lines;
      if (b.remaining) {
        const issued = await issuedOf(db, id);
        lines = (await db.query<{ component_id: string; q: number }>("SELECT component_id, required_qty::float8 AS q FROM mo_components WHERE mo_id = $1", [id])).rows
          .map((c) => ({ componentId: c.component_id, quantity: round4(c.q - (issued.get(c.component_id)?.quantity ?? 0)) })).filter((l) => l.quantity > 0);
        if (!lines.length) throw conflict("صُرفت كل مكونات الأمر");
      }
      const r = await issue(db, mo, lines, key, b.note);
      await auditTenant(db, req, "mo.issued", "manufacturing_order", id, { event: r.eventId, value: r.value });
      return { ...r, replay: false };
    });
    return reply.status(out.replay ? 200 : 201).send({ eventId: out.eventId });
  });

  // Return unused material to the production location, at what it cost the order.
  app.post("/manufacturing-orders/:id/return", { preHandler: requireTenant("mos.issue") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const key = idempotencyKey(req);
    const b = z.object({
      lines: z.array(z.object({ componentId: z.string().uuid(), quantity: z.number().min(0).max(100_000_000) })).min(1).max(200),
      note: z.string().trim().max(300).nullable().optional().transform((v) => v || null),
    }).parse(req.body);
    const out = await tenantTx(req, async (db) => {
      const dup = await replay(db, key);
      if (dup) return { eventId: dup.id, replay: true };
      const mo = await lockMo(db, id);
      working(mo);
      const issued = await issuedOf(db, id);
      const lines = b.lines.filter((l) => l.quantity > 0).map((l) => {
        const got = issued.get(l.componentId);
        if (!got || l.quantity > got.quantity + 1e-9) throw badRequest("لا يُرجع أكثر مما صُرف للأمر");
        const unitCost = got.quantity > 0 ? round6(got.value / got.quantity) : 0;
        // The last of a component returns exactly its remaining value, so nothing is left behind in WIP.
        const value = Math.abs(l.quantity - got.quantity) < 1e-9 ? got.value : h(l.quantity * unitCost) / 100;
        return { componentId: l.componentId, quantity: round4(l.quantity), unitCost, value };
      });
      if (!lines.length) throw badRequest("أدخل كمية للإرجاع");
      const total = lines.reduce((a, l) => a + h(l.value), 0);
      const eventId = await recordEvent(db, mo, "return", { lines, note: b.note }, -total, key);
      await putIn(db, mo.location_id, lines.map((l) => ({ ingredientId: l.componentId, quantity: l.quantity, unitCost: l.unitCost })));
      for (const l of lines) {
        await movement(db, { locationId: mo.location_id, ingredientId: l.componentId, type: "production_in", quantity: l.quantity, unitCost: l.unitCost, refType: "mo_event", refId: eventId });
      }
      await postMoEvent(db, eventId);
      await auditTenant(db, req, "mo.returned", "manufacturing_order", id, { event: eventId, value: total / 100 });
      return { eventId, replay: false };
    });
    return reply.status(out.replay ? 200 : 201).send({ eventId: out.eventId });
  });

  // Time on an operation: labour and overhead absorbed into the order at the rates frozen at confirmation.
  app.post("/manufacturing-orders/:id/labor", { preHandler: requireTenant("mos.labor") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const key = idempotencyKey(req);
    const b = z.object({ seq: z.number().int().min(1), minutes: z.number().positive("دقائق أكبر من صفر").max(100_000), note: z.string().trim().max(300).nullable().optional().transform((v) => v || null) }).parse(req.body);
    const out = await tenantTx(req, async (db) => {
      const dup = await replay(db, key);
      if (dup) return { eventId: dup.id, replay: true };
      const mo = await lockMo(db, id);
      working(mo);
      const op = (await db.query<{ name: string; labor_rate: number; overhead_rate: number }>(
        "SELECT name, labor_rate::float8 AS labor_rate, overhead_rate::float8 AS overhead_rate FROM mo_operations WHERE mo_id = $1 AND seq = $2", [id, b.seq])).rows[0];
      if (!op) throw badRequest("العملية ليست في خطة هذا الأمر");
      const labor = h((b.minutes / 60) * op.labor_rate);
      const overhead = h((b.minutes / 60) * op.overhead_rate);
      const eventId = await recordEvent(db, mo, "labor", { seq: b.seq, operation: op.name, minutes: b.minutes, labor: labor / 100, overhead: overhead / 100, note: b.note }, labor + overhead, key);
      if (mo.status === "confirmed") await db.query("UPDATE manufacturing_orders SET status = 'in_progress' WHERE id = $1", [id]);
      await postMoEvent(db, eventId);
      await auditTenant(db, req, "mo.labor", "manufacturing_order", id, { event: eventId, minutes: b.minutes });
      return { eventId, replay: false };
    });
    return reply.status(out.replay ? 200 : 201).send({ eventId: out.eventId });
  });

  /**
   * Output: good units enter the output location at the standard unit cost (with their batch and expiry), by-products
   * at theirs, abnormal scrap is written off at standard. `backflush` first issues the components this output
   * consumes by the plan, for orders that do not issue by hand.
   */
  app.post("/manufacturing-orders/:id/produce", { preHandler: requireTenant("mos.produce") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const key = idempotencyKey(req);
    const b = z.object({
      quantity: z.number().min(0).max(100_000_000),
      scrapQuantity: z.number().min(0).max(100_000_000).default(0),
      scrapReason: z.string().trim().max(200).nullable().optional().transform((v) => v || null),
      byproducts: z.array(z.object({ itemId: z.string().uuid(), quantity: z.number().min(0).max(100_000_000) })).max(20).optional(),
      batchNo: z.string().trim().min(1).max(60).nullable().optional().transform((v) => v || null),
      expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().transform((v) => v || null),
      backflush: z.boolean().default(false),
    }).refine((x) => x.quantity > 0 || x.scrapQuantity > 0, "أدخل كمية الإنتاج أو الهالك")
      .refine((x) => x.scrapQuantity === 0 || x.scrapReason, { message: "اذكر سبب الهالك", path: ["scrapReason"] }).parse(req.body);
    const out = await tenantTx(req, async (db) => {
      const dup = await replay(db, key);
      if (dup) return { eventId: dup.id, replay: true };
      const mo = await lockMo(db, id);
      working(mo);
      if (b.backflush) {
        const planned = (await db.query<{ component_id: string; q: number }>("SELECT component_id, required_qty::float8 AS q FROM mo_components WHERE mo_id = $1", [id])).rows;
        const share = (b.quantity + b.scrapQuantity) / mo.quantity;
        await issue(db, mo, planned.map((c) => ({ componentId: c.component_id, quantity: round4(c.q * share) })), randomUUID(), "صرف تلقائي مع الإنتاج");
        mo.status = "in_progress";
      }
      const std = mo.standard_unit_cost ?? 0;
      const mainValue = h(b.quantity * std);
      const scrapValue = h(b.scrapQuantity * std);
      const planBys = (await db.query<{ item_id: string; per_unit: number; unit_cost: number }>(
        "SELECT item_id, per_unit::float8 AS per_unit, unit_cost::float8 AS unit_cost FROM mo_byproducts WHERE mo_id = $1", [id])).rows;
      const bys = planBys.map((p) => {
        const given = b.byproducts?.find((x) => x.itemId === p.item_id);
        const q = round4(given ? given.quantity : p.per_unit * b.quantity);
        return { itemId: p.item_id, quantity: q, unitCost: p.unit_cost, value: h(q * p.unit_cost) / 100 };
      }).filter((x) => x.quantity > 0);
      if (b.byproducts?.some((x) => !planBys.some((p) => p.item_id === x.itemId))) throw badRequest("منتج ثانوي ليس في خطة الأمر");
      const byValue = bys.reduce((a, x) => a + h(x.value), 0);

      // The output batch: its own number, and it expires no later than the earliest input the order consumed.
      let batch: { batchNo: string; expiryDate: string | null } | null = null;
      if (b.quantity > 0) {
        const rule = (await expiryRules(db, [mo.item_id])).get(mo.item_id)!;
        const inputs = (await db.query<{ e: string | null }>(
          `SELECT min((bt->>'expiryDate')::date)::text AS e FROM mo_events e CROSS JOIN LATERAL jsonb_array_elements(e.detail->'lines') x
             CROSS JOIN LATERAL jsonb_array_elements(coalesce(x->'batches', '[]'::jsonb)) bt WHERE e.mo_id = $1 AND e.kind = 'issue'`, [id])).rows[0]?.e ?? null;
        const own = b.expiryDate ?? (rule.shelfLifeDays ? addDays(today(), rule.shelfLifeDays) : null);
        const expiry = own && inputs ? (own < inputs ? own : inputs) : own ?? inputs;
        if (rule.trackExpiry && !expiry) throw new AppError(422, "expiry_required", "أدخل تاريخ انتهاء الإنتاج (الصنف يتتبع الصلاحية)", [{ path: "expiryDate", message: "مطلوب" }]);
        const seq = Number((await db.query<{ n: string }>("SELECT count(*)::text AS n FROM mo_events WHERE mo_id = $1 AND kind = 'output'", [id])).rows[0]!.n) + 1;
        if (rule.trackExpiry || expiry || b.batchNo) batch = { batchNo: b.batchNo ?? `MO-${mo.mo_number}-${seq}`, expiryDate: expiry };
      }
      const detail = { quantity: round4(b.quantity), unitCost: std, value: mainValue / 100, scrapQuantity: round4(b.scrapQuantity), scrapReason: b.scrapReason,
        scrapValue: scrapValue / 100, byproducts: bys, batch, backflush: b.backflush };
      const eventId = await recordEvent(db, mo, "output", detail, -(mainValue + byValue + scrapValue), key);
      if (b.quantity > 0) {
        await putIn(db, mo.output_location_id, [{ ingredientId: mo.item_id, quantity: round4(b.quantity), unitCost: std }]);
        await movement(db, { locationId: mo.output_location_id, ingredientId: mo.item_id, type: "production_in", quantity: round4(b.quantity), unitCost: std, refType: "mo_event", refId: eventId });
        if (batch) {
          await addBatch(db, { locationId: mo.output_location_id, ingredientId: mo.item_id, batchNo: batch.batchNo, expiryDate: batch.expiryDate, productionDate: today(),
            quantity: round4(b.quantity), unitCost: std, sourceType: "manufacturing", sourceId: eventId });
        }
      }
      for (const x of bys) {
        await putIn(db, mo.output_location_id, [{ ingredientId: x.itemId, quantity: x.quantity, unitCost: x.unitCost }]);
        await movement(db, { locationId: mo.output_location_id, ingredientId: x.itemId, type: "production_in", quantity: x.quantity, unitCost: x.unitCost, refType: "mo_event", refId: eventId });
      }
      await db.query("UPDATE manufacturing_orders SET produced_quantity = produced_quantity + $2, status = 'in_progress' WHERE id = $1", [id, round4(b.quantity)]);
      await postMoEvent(db, eventId);
      await auditTenant(db, req, "mo.produced", "manufacturing_order", id, { event: eventId, quantity: b.quantity, scrap: b.scrapQuantity });
      return { eventId, replay: false };
    });
    return reply.status(out.replay ? 200 : 201).send({ eventId: out.eventId });
  });

  // Closing: whatever is left in the order's work in progress is its production variance. WIP ends at zero.
  app.post("/manufacturing-orders/:id/close", { preHandler: requireTenant("mos.close") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const key = idempotencyKey(req);
    const out = await tenantTx(req, async (db) => {
      const dup = await replay(db, key);
      if (dup) return { eventId: dup.id, variance: 0, replay: true };
      const mo = await lockMo(db, id);
      if (mo.status !== "in_progress") throw conflict(mo.status === "confirmed" ? "لم يبدأ الأمر بعد: ألغِه بدلاً من إقفاله" : "لا يُقفل إلا أمر قيد التنفيذ");
      const wip = h(await wipOf(db, id));
      const eventId = await recordEvent(db, mo, "close", { variance: wip / 100, producedQuantity: mo.produced_quantity }, -wip, key);
      await db.query("UPDATE manufacturing_orders SET status = 'closed', closed_at = now(), closed_by = app_user_id() WHERE id = $1", [id]);
      if (wip !== 0) await postMoEvent(db, eventId);
      await auditTenant(db, req, "mo.closed", "manufacturing_order", id, { variance: wip / 100 });
      return { eventId, variance: wip / 100, replay: false };
    });
    return reply.status(out.replay ? 200 : 201).send({ eventId: out.eventId, variance: out.variance });
  });

  app.post("/manufacturing-orders/:id/cancel", { preHandler: requireTenant("mos.cancel") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ reason: z.string().trim().min(3, "اذكر سبب الإلغاء").max(300) }).parse(req.body);
    await tenantTx(req, async (db) => {
      const mo = await lockMo(db, id);
      if (mo.status !== "draft" && mo.status !== "confirmed") throw conflict("بدأ التنفيذ: أرجع المواد وأقفل الأمر بدلاً من إلغائه");
      if ((await db.query("SELECT 1 FROM mo_events WHERE mo_id = $1 LIMIT 1", [id])).rowCount) throw conflict("للأمر عمليات مسجلة");
      await db.query("UPDATE manufacturing_orders SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2 WHERE id = $1", [id, b.reason]);
      await auditTenant(db, req, "mo.cancelled", "manufacturing_order", id, { reason: b.reason });
    });
    return { ok: true };
  });

  // What producing N of an item would cost and need today (the order form's preview), without writing anything.
  app.get("/boms/:id/plan", { preHandler: requireTenant("boms.view", "mos.create") }, async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const q = Number((req.query as { quantity?: string }).quantity);
    const locationId = (req.query as { locationId?: string }).locationId;
    if (!(q > 0)) throw badRequest("أدخل الكمية");
    return tenantTx(req, async (db) => {
      const bom = (await loadBoms(db, "id = $1", [id]))[0];
      if (!bom) throw notFound("قائمة المواد غير موجودة");
      const ctx = await costContext(db);
      const cost = rollUp(bom, ctx);
      const plan = explode(bom, q, ctx);
      const n = await names(db, plan.components.map((c) => c.componentId));
      const avail = isUuid(locationId)
        ? new Map((await db.query<{ id: string; q: number }>("SELECT ingredient_id AS id, quantity::float8 AS q FROM stock_levels WHERE location_id = $1", [locationId])).rows.map((r) => [r.id, r.q]))
        : null;
      return {
        unitCost: cost.unitCost, total: Math.round(cost.unitCost * q * 100) / 100,
        components: plan.components.map((c) => ({ ...c, name: n.get(c.componentId)?.name, unit: n.get(c.componentId)?.unit, available: avail ? avail.get(c.componentId) ?? 0 : null })),
        minutes: plan.operations.reduce((a, o) => a + o.minutes, 0),
      };
    }, { readOnly: true });
  });
}
