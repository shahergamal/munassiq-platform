import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../../db/pool.ts";
import { round4 } from "../../lib/costing.ts";
import { AppError, badRequest, notFound } from "../../lib/errors.ts";
import { likePattern } from "../../lib/pagination.ts";
import { auditTenant, isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";
import { addBatch, drawBatch } from "../restaurants/batches.ts";
import { lockLevels, movement, putIn, takeOut } from "../restaurants/inventory.ts";
import { idempotencyKey } from "../restaurants/purchases.ts";

// Quality for factory workspaces (docs/manufacturing/ARCHITECTURE.md, M5): inspection plans, inspections with a
// server-judged result, holding a batch in a quarantine location and releasing it, non-conformance reports, and
// tracing a batch backward to its supplier and forward to its customers.

const characteristic = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(["numeric", "check"]),
  min: z.number().nullable().optional().transform((v) => v ?? null),
  max: z.number().nullable().optional().transform((v) => v ?? null),
  unit: z.string().trim().max(20).nullable().optional().transform((v) => v || null),
}).refine((c) => c.kind === "check" || c.min !== null || c.max !== null, "حدد الحد الأدنى أو الأعلى للقياس")
  .refine((c) => c.min === null || c.max === null || c.min <= c.max, "الحد الأدنى أكبر من الأعلى");
type Characteristic = z.infer<typeof characteristic>;

/** Each measured value against its acceptance range, judged here (the browser sends values only). */
export function judge(chars: Characteristic[], values: Record<string, number | boolean | null>) {
  return chars.map((c) => {
    const v = values[c.name];
    if (v === undefined || v === null) return { name: c.name, value: null, pass: false, missing: true };
    const pass = c.kind === "check" ? v === true : typeof v === "number" && (c.min === null || v >= c.min) && (c.max === null || v <= c.max);
    return { name: c.name, value: v, pass, missing: false };
  });
}

/** The workspace's quarantine location, created the first time something is held. */
async function quarantine(db: Db): Promise<string> {
  const q = (await db.query<{ id: string }>("SELECT id FROM locations WHERE location_type = 'quarantine' AND is_active ORDER BY created_at LIMIT 1")).rows[0];
  if (q) return q.id;
  return (await db.query<{ id: string }>(
    "INSERT INTO locations (tenant_id, code, name, location_type) VALUES (app_tenant_id(), 'QC-HOLD', 'حجر الجودة', 'quarantine') ON CONFLICT (tenant_id, code) DO UPDATE SET location_type = 'quarantine' RETURNING id")).rows[0]!.id;
}

/**
 * Moves (part of) a batch to another location: the batch is drawn at the source, stock leaves at the source's
 * average cost and enters the target at the same cost under the same batch number, as a child batch (the trace
 * follows it). Value does not change, so there is no journal entry.
 */
async function moveBatch(db: Db, batchId: string, to: string, quantity: number, refId: string) {
  const b = (await db.query<{ location_id: string; ingredient_id: string; remaining: number; batch_no: string; expiry_date: string | null; production_date: string | null; supplier_id: string | null }>(
    "SELECT location_id, ingredient_id, remaining::float8 AS remaining, batch_no, expiry_date::text, production_date::text, supplier_id FROM stock_batches WHERE id = $1 FOR UPDATE", [batchId])).rows[0];
  if (!b) throw notFound("التشغيلة غير موجودة");
  if (b.location_id === to) throw badRequest("التشغيلة في هذا الموقع بالفعل");
  const qty = round4(Math.min(quantity, b.remaining));
  if (!(qty > 0)) throw new AppError(409, "batch_empty", "لم يبقَ من التشغيلة شيء");
  const [first, second] = [b.location_id, to].sort();
  await lockLevels(db, first!, [b.ingredient_id]);
  await lockLevels(db, second!, [b.ingredient_id]);
  await drawBatch(db, batchId, b.location_id, b.ingredient_id, qty);
  const [taken] = await takeOut(db, b.location_id, [{ ingredientId: b.ingredient_id, quantity: qty }]);
  await putIn(db, to, [{ ingredientId: b.ingredient_id, quantity: qty, unitCost: taken!.unitCost }]);
  await movement(db, { locationId: b.location_id, ingredientId: b.ingredient_id, type: "transfer_out", quantity: -qty, unitCost: taken!.unitCost, refType: "qc_release", refId });
  await movement(db, { locationId: to, ingredientId: b.ingredient_id, type: "transfer_in", quantity: qty, unitCost: taken!.unitCost, refType: "qc_release", refId });
  const child = await addBatch(db, { locationId: to, ingredientId: b.ingredient_id, batchNo: b.batch_no, expiryDate: b.expiry_date, productionDate: b.production_date,
    quantity: qty, unitCost: taken!.unitCost, sourceType: "transfer", sourceId: refId, supplierId: b.supplier_id, parentBatchId: batchId });
  return { from: b.location_id, quantity: qty, newBatchId: child! };
}

export default async function qualityRoutes(app: FastifyInstance) {
  // Plans ─────────────────────────────────────────────────────────────────────────────────────
  app.get("/qc/plans", { preHandler: requireTenant("qc_plans.view", "qc_inspections.create") }, async (req) =>
    tenantTx(req, async (db) => ({
      items: (await db.query(
        `SELECT p.id, p.item_id AS "itemId", i.name AS "itemName", i.sku, p.stage, p.name, p.characteristics, p.is_active AS "isActive",
                (SELECT count(*)::int FROM qc_inspections x WHERE x.plan_id = p.id) AS "inspections"
           FROM qc_plans p JOIN ingredients i ON i.id = p.item_id ORDER BY p.is_active DESC, i.name, p.stage`)).rows,
    }), { readOnly: true }));

  const planBody = z.object({
    itemId: z.string().uuid("اختر الصنف"),
    stage: z.enum(["receipt", "production"]),
    name: z.string().trim().min(2, "أدخل اسم الخطة").max(120),
    characteristics: z.array(characteristic).min(1, "أضف خاصية واحدة على الأقل").max(40),
  });
  app.post("/qc/plans", { preHandler: requireTenant("qc_plans.create") }, async (req, reply) => {
    const b = planBody.parse(req.body);
    if (new Set(b.characteristics.map((c) => c.name)).size !== b.characteristics.length) throw badRequest("اسم خاصية مكرر");
    const id = await tenantTx(req, async (db) => {
      try {
        const r = (await db.query<{ id: string }>("INSERT INTO qc_plans (tenant_id, item_id, stage, name, characteristics) VALUES (app_tenant_id(), $1, $2, $3, $4) RETURNING id",
          [b.itemId, b.stage, b.name, JSON.stringify(b.characteristics)])).rows[0]!;
        await auditTenant(db, req, "qc_plan.created", "qc_plan", r.id, { itemId: b.itemId, stage: b.stage });
        return r.id;
      } catch (e) {
        if ((e as { code?: string }).code === "23505") throw new AppError(409, "duplicate", "للصنف خطة فحص مفعّلة لهذه المرحلة. عدّلها أو أوقفها أولاً");
        throw e;
      }
    });
    return reply.status(201).send({ id });
  });
  // Editing a plan changes what future inspections check; past inspections keep their results.
  app.put("/qc/plans/:id", { preHandler: requireTenant("qc_plans.edit") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = planBody.omit({ itemId: true, stage: true }).extend({ isActive: z.boolean().default(true) }).parse(req.body);
    await tenantTx(req, async (db) => {
      const r = await db.query("UPDATE qc_plans SET name = $2, characteristics = $3, is_active = $4 WHERE id = $1", [id, b.name, JSON.stringify(b.characteristics), b.isActive]);
      if (!r.rowCount) throw notFound("خطة الفحص غير موجودة");
      await auditTenant(db, req, "qc_plan.updated", "qc_plan", id, { isActive: b.isActive });
    });
    return { ok: true };
  });

  // Inspections ───────────────────────────────────────────────────────────────────────────────
  // What is waiting: batches received or produced for items with an active plan, never inspected, still in stock.
  app.get("/qc/pending", { preHandler: requireTenant("qc_inspections.view") }, async (req) =>
    tenantTx(req, async (db) => ({
      items: (await db.query(
        `SELECT b.id AS "batchId", b.batch_no AS "batchNo", b.remaining::float8 AS remaining, b.expiry_date::text AS "expiryDate", b.received_at AS "receivedAt",
                i.id AS "itemId", i.name AS "itemName", u.name AS unit, l.name AS "locationName", p.id AS "planId", p.name AS "planName", p.stage, p.characteristics,
                CASE b.source_type WHEN 'goods_receipt' THEN (SELECT 'GRN-' || g.grn_number || ' · ' || s.name FROM goods_receipts g JOIN suppliers s ON s.id = g.supplier_id WHERE g.id = b.source_id)
                                   WHEN 'manufacturing' THEN (SELECT 'MO-' || o.mo_number FROM mo_events e JOIN manufacturing_orders o ON o.id = e.mo_id WHERE e.id = b.source_id) END AS source
           FROM stock_batches b JOIN ingredients i ON i.id = b.ingredient_id JOIN units u ON u.id = i.base_unit_id JOIN locations l ON l.id = b.location_id
           JOIN qc_plans p ON p.item_id = b.ingredient_id AND p.is_active AND p.stage = CASE b.source_type WHEN 'goods_receipt' THEN 'receipt' WHEN 'manufacturing' THEN 'production' END
          WHERE b.remaining > 0 AND l.location_type <> 'quarantine'
            AND NOT EXISTS (SELECT 1 FROM qc_inspections x WHERE x.batch_id = b.id)
          ORDER BY b.received_at LIMIT 200`)).rows,
    }), { readOnly: true }));

  app.get("/qc/inspections", { preHandler: requireTenant("qc_inspections.view") }, async (req) => {
    const q = req.query as { decision?: string; q?: string };
    const decision = ["accepted", "on_hold", "rejected"].includes(q.decision ?? "") ? q.decision! : null;
    const search = q.q?.trim() ? likePattern(q.q) : null;
    return tenantTx(req, async (db) => ({
      items: (await db.query(
        `SELECT x.id, x.inspection_number::int AS number, x.decision, x.results, x.quantity::float8 AS quantity, x.notes, x.inspected_at AS "inspectedAt",
                i.name AS "itemName", b.id AS "batchId", b.batch_no AS "batchNo", p.name AS "planName", p.stage
           FROM qc_inspections x JOIN ingredients i ON i.id = x.item_id JOIN qc_plans p ON p.id = x.plan_id LEFT JOIN stock_batches b ON b.id = x.batch_id
          WHERE ($1::text IS NULL OR x.decision = $1) AND ($2::text IS NULL OR i.name ILIKE $2 OR b.batch_no ILIKE $2)
          ORDER BY x.inspected_at DESC LIMIT 300`, [decision, search])).rows,
      // Held now: batches sitting in a quarantine location with stock.
      held: (await db.query(
        `SELECT b.id AS "batchId", b.batch_no AS "batchNo", b.remaining::float8 AS remaining, i.name AS "itemName", u.name AS unit, l.name AS "locationName", b.received_at AS "heldAt",
                (SELECT r.reason FROM qc_releases r WHERE r.new_batch_id = b.id ORDER BY r.created_at DESC LIMIT 1) AS reason,
                (SELECT r.from_location FROM qc_releases r WHERE r.new_batch_id = b.id ORDER BY r.created_at DESC LIMIT 1) AS "fromLocationId"
           FROM stock_batches b JOIN locations l ON l.id = b.location_id JOIN ingredients i ON i.id = b.ingredient_id JOIN units u ON u.id = i.base_unit_id
          WHERE l.location_type = 'quarantine' AND b.remaining > 0 ORDER BY b.received_at DESC`)).rows,
    }), { readOnly: true });
  });

  /**
   * An inspection: values per characteristic, judged here. All pass: accepted. Otherwise the inspector holds the lot
   * (to decide later) or rejects it; both move it to quarantine, and a rejection opens a non-conformance report.
   */
  app.post("/qc/inspections", { preHandler: requireTenant("qc_inspections.create") }, async (req, reply) => {
    const key = idempotencyKey(req);
    const b = z.object({
      batchId: z.string().uuid("اختر التشغيلة"),
      planId: z.string().uuid().optional(),
      values: z.record(z.union([z.number(), z.boolean(), z.null()])),
      decision: z.enum(["accept", "hold", "reject"]).optional(),
      notes: z.string().trim().max(1000).nullable().optional().transform((v) => v || null),
    }).parse(req.body);
    const out = await tenantTx(req, async (db) => {
      const dup = (await db.query<{ id: string }>("SELECT id FROM qc_inspections WHERE idempotency_key = $1", [key])).rows[0];
      if (dup) return { id: dup.id, replay: true, decision: null as string | null };
      const batch = (await db.query<{ ingredient_id: string; remaining: number; source_type: string; source_id: string | null; supplier_id: string | null; location_type: string }>(
        `SELECT b.ingredient_id, b.remaining::float8 AS remaining, b.source_type, b.source_id, b.supplier_id, l.location_type
           FROM stock_batches b JOIN locations l ON l.id = b.location_id WHERE b.id = $1 FOR UPDATE OF b`, [b.batchId])).rows[0];
      if (!batch) throw notFound("التشغيلة غير موجودة");
      if (!(batch.remaining > 0)) throw new AppError(409, "batch_empty", "لم يبقَ من التشغيلة شيء لفحصه");
      const plan = (await db.query<{ id: string; characteristics: Characteristic[] }>(
        `SELECT id, characteristics FROM qc_plans WHERE item_id = $1 AND ($2::uuid IS NULL AND is_active OR id = $2)
          ORDER BY stage = CASE $3 WHEN 'manufacturing' THEN 'production' ELSE 'receipt' END DESC LIMIT 1`,
        [batch.ingredient_id, b.planId ?? null, batch.source_type])).rows[0];
      if (!plan) throw new AppError(422, "no_plan", "لا توجد خطة فحص لهذا الصنف. أنشئ خطته أولاً");
      const results = judge(plan.characteristics, b.values);
      if (results.some((r) => r.missing)) throw new AppError(422, "validation_failed", `أدخل قيمة: ${results.filter((r) => r.missing).map((r) => r.name).join("، ")}`);
      const allPass = results.every((r) => r.pass);
      const decision = b.decision === "accept" || (!b.decision && allPass) ? "accepted" : b.decision === "reject" ? "rejected" : "on_hold";
      if (decision === "accepted" && !allPass) throw new AppError(422, "failed_characteristics", "خصائص خارج الحدود: لا يُقبل إلا بتقرير عدم مطابقة (ارفضه أو احجزه)");
      const n = (await db.query<{ n: string }>("SELECT next_counter('qc_inspection')::text AS n")).rows[0]!.n;
      const ins = (await db.query<{ id: string }>(
        `INSERT INTO qc_inspections (tenant_id, inspection_number, plan_id, item_id, batch_id, source_type, source_id, results, decision, quantity, notes, idempotency_key, inspected_by)
         VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, app_user_id()) RETURNING id`,
        [n, plan.id, batch.ingredient_id, b.batchId, batch.source_type === "goods_receipt" ? "goods_receipt" : batch.source_type === "manufacturing" ? "mo_event" : "manual",
          batch.source_id, JSON.stringify(results), decision, round4(batch.remaining), b.notes, key])).rows[0]!;
      let heldBatch: string | null = null;
      if (decision !== "accepted" && batch.location_type !== "quarantine") {
        const q = await quarantine(db);
        const moved = await moveBatch(db, b.batchId, q, batch.remaining, ins.id);
        heldBatch = moved.newBatchId;
        await db.query(
          `INSERT INTO qc_releases (tenant_id, batch_id, action, from_location, to_location, quantity, new_batch_id, reason, inspection_id, created_by)
           VALUES (app_tenant_id(), $1, 'hold', $2, $3, $4, $5, $6, $7, app_user_id())`,
          [b.batchId, moved.from, q, moved.quantity, moved.newBatchId, decision === "rejected" ? "مرفوض في الفحص" : "معلّق حتى قرار الجودة", ins.id]);
      }
      if (decision === "rejected") {
        const failed = results.filter((r) => !r.pass).map((r) => `${r.name}: ${r.value}`).join("، ");
        const nn = (await db.query<{ n: string }>("SELECT next_counter('ncr')::text AS n")).rows[0]!.n;
        await db.query(
          `INSERT INTO ncrs (tenant_id, ncr_number, item_id, batch_id, inspection_id, supplier_id, quantity, description, created_by)
           VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, app_user_id())`,
          [nn, batch.ingredient_id, heldBatch ?? b.batchId, ins.id, batch.supplier_id, round4(batch.remaining), `رُفضت التشغيلة في الفحص رقم ${n}${failed ? `: ${failed}` : ""}${b.notes ? `. ${b.notes}` : ""}`]);
      }
      await auditTenant(db, req, "qc.inspected", "qc_inspection", ins.id, { decision, batchId: b.batchId });
      return { id: ins.id, replay: false, decision };
    });
    return reply.status(out.replay ? 200 : 201).send({ id: out.id, decision: out.decision });
  });

  // Release a held batch back into stock (to where it came from, or another location).
  app.post("/qc/batches/:batchId/release", { preHandler: requireTenant("qc_inspections.release") }, async (req) => {
    const { batchId } = req.params as { batchId: string };
    if (!isUuid(batchId)) throw notFound();
    const b = z.object({ reason: z.string().trim().min(3, "اذكر سبب الإفراج").max(300), toLocationId: z.string().uuid().optional() }).parse(req.body);
    return tenantTx(req, async (db) => {
      const cur = (await db.query<{ location_type: string; remaining: number; from_location: string | null }>(
        `SELECT l.location_type, b.remaining::float8 AS remaining,
                (SELECT r.from_location FROM qc_releases r WHERE r.new_batch_id = b.id AND r.action = 'hold' ORDER BY r.created_at DESC LIMIT 1) AS from_location
           FROM stock_batches b JOIN locations l ON l.id = b.location_id WHERE b.id = $1`, [batchId])).rows[0];
      if (!cur) throw notFound("التشغيلة غير موجودة");
      if (cur.location_type !== "quarantine") throw new AppError(409, "not_held", "التشغيلة ليست محجوزة");
      const to = b.toLocationId ?? cur.from_location;
      if (!to) throw badRequest("اختر موقع الإفراج");
      if ((await db.query<{ t: string }>("SELECT location_type AS t FROM locations WHERE id = $1 AND is_active", [to])).rows[0]?.t === "quarantine") throw badRequest("اختر موقعاً خارج الحجر");
      const moved = await moveBatch(db, batchId, to, cur.remaining, batchId);
      await db.query(
        `INSERT INTO qc_releases (tenant_id, batch_id, action, from_location, to_location, quantity, new_batch_id, reason, created_by)
         VALUES (app_tenant_id(), $1, 'release', $2, $3, $4, $5, $6, app_user_id())`, [batchId, moved.from, to, moved.quantity, moved.newBatchId, b.reason]);
      await auditTenant(db, req, "qc.released", "stock_batch", batchId, { reason: b.reason, to });
      return { ok: true, batchId: moved.newBatchId };
    });
  });

  // Non-conformance reports ───────────────────────────────────────────────────────────────────
  app.get("/ncrs", { preHandler: requireTenant("ncrs.view") }, async (req) => {
    const status = (req.query as { status?: string }).status;
    return tenantTx(req, async (db) => ({
      items: (await db.query(
        `SELECT n.id, n.ncr_number::int AS number, n.status, n.description, n.disposition, n.root_cause AS "rootCause", n.corrective_action AS "correctiveAction",
                n.quantity::float8 AS quantity, n.created_at AS "createdAt", n.closed_at AS "closedAt", i.name AS "itemName", u.name AS unit,
                b.id AS "batchId", b.batch_no AS "batchNo", s.name AS "supplierName", x.inspection_number::int AS "inspectionNumber"
           FROM ncrs n JOIN ingredients i ON i.id = n.item_id JOIN units u ON u.id = i.base_unit_id LEFT JOIN stock_batches b ON b.id = n.batch_id
           LEFT JOIN suppliers s ON s.id = n.supplier_id LEFT JOIN qc_inspections x ON x.id = n.inspection_id
          WHERE ($1::text IS NULL OR n.status = $1) ORDER BY n.status = 'open' DESC, n.ncr_number DESC LIMIT 300`, [status === "open" || status === "closed" ? status : null])).rows,
    }), { readOnly: true });
  });

  app.post("/ncrs", { preHandler: requireTenant("ncrs.create") }, async (req, reply) => {
    const b = z.object({
      itemId: z.string().uuid("اختر الصنف"),
      batchId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
      supplierId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
      quantity: z.number().positive().max(100_000_000).nullable().optional().transform((v) => v ?? null),
      description: z.string().trim().min(5, "صف المشكلة").max(1000),
    }).parse(req.body);
    const id = await tenantTx(req, async (db) => {
      const n = (await db.query<{ n: string }>("SELECT next_counter('ncr')::text AS n")).rows[0]!.n;
      const r = (await db.query<{ id: string }>(
        "INSERT INTO ncrs (tenant_id, ncr_number, item_id, batch_id, supplier_id, quantity, description, created_by) VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, app_user_id()) RETURNING id",
        [n, b.itemId, b.batchId, b.supplierId, b.quantity, b.description])).rows[0]!;
      await auditTenant(db, req, "ncr.created", "ncr", r.id);
      return r.id;
    });
    return reply.status(201).send({ id });
  });

  // Closing records what was decided; the stock action itself (waste, return to supplier, release) is done on its own page.
  app.post("/ncrs/:id/close", { preHandler: requireTenant("ncrs.close") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({
      disposition: z.enum(["rework", "scrap", "return_to_supplier", "use_as_is"]),
      rootCause: z.string().trim().min(3, "اذكر السبب الجذري").max(1000),
      correctiveAction: z.string().trim().min(3, "اذكر الإجراء التصحيحي").max(1000),
    }).parse(req.body);
    await tenantTx(req, async (db) => {
      const r = await db.query(
        "UPDATE ncrs SET status = 'closed', disposition = $2, root_cause = $3, corrective_action = $4, closed_by = app_user_id(), closed_at = now() WHERE id = $1 AND status = 'open'",
        [id, b.disposition, b.rootCause, b.correctiveAction]);
      if (!r.rowCount) throw new AppError(409, "invalid_state", "التقرير غير موجود أو مقفل");
      await auditTenant(db, req, "ncr.closed", "ncr", id, b);
    });
    return { ok: true };
  });

  // Traceability ──────────────────────────────────────────────────────────────────────────────
  app.get("/trace/search", { preHandler: requireTenant("trace.view") }, async (req) => {
    const q = (req.query as { q?: string }).q?.trim();
    if (!q) return { items: [] };
    return tenantTx(req, async (db) => ({
      items: (await db.query(
        `SELECT b.id, b.batch_no AS "batchNo", i.name AS "itemName", l.name AS "locationName", b.quantity::float8 AS quantity, b.remaining::float8 AS remaining,
                b.expiry_date::text AS "expiryDate", b.source_type AS "sourceType", b.received_at AS "receivedAt"
           FROM stock_batches b JOIN ingredients i ON i.id = b.ingredient_id JOIN locations l ON l.id = b.location_id
          WHERE b.batch_no ILIKE $1 OR i.name ILIKE $1 ORDER BY b.received_at DESC LIMIT 50`, [likePattern(q)])).rows,
    }), { readOnly: true });
  });

  /**
   * Where a batch came from (supplier, or the production order and the input batches it consumed, recursively) and
   * where it went (child batches moved elsewhere, production orders it fed and their output, customers it was
   * delivered to), in one answer.
   */
  app.get("/trace/batches/:id", { preHandler: requireTenant("trace.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const info = async (batchId: string) => (await db.query<{ id: string; batch_no: string; item: string; item_id: string; unit: string; location: string; quantity: number; remaining: number; expiry: string | null; production: string | null; source_type: string; source_id: string | null; parent: string | null; received_at: string }>(
        `SELECT b.id, b.batch_no, i.name AS item, i.id AS item_id, u.name AS unit, l.name AS location, b.quantity::float8 AS quantity, b.remaining::float8 AS remaining,
                b.expiry_date::text AS expiry, b.production_date::text AS production, b.source_type, b.source_id, b.parent_batch_id AS parent, b.received_at::text
           FROM stock_batches b JOIN ingredients i ON i.id = b.ingredient_id JOIN units u ON u.id = i.base_unit_id JOIN locations l ON l.id = b.location_id WHERE b.id = $1`, [batchId])).rows[0];
      const root = await info(id);
      if (!root) throw notFound("التشغيلة غير موجودة");
      const node = (b: NonNullable<Awaited<ReturnType<typeof info>>>) => ({ batchId: b.id, batchNo: b.batch_no, itemName: b.item, unit: b.unit, location: b.location, quantity: b.quantity,
        remaining: b.remaining, expiryDate: b.expiry, productionDate: b.production });
      type Back = ReturnType<typeof node> & { origin: { kind: string; label: string; date?: string }; inputs: Back[] };
      const seen = new Set<string>();
      const backward = async (batchId: string, depth: number): Promise<Back | null> => {
        const b = await info(batchId);
        if (!b || depth > 8 || seen.has(`b:${batchId}`)) return null;
        seen.add(`b:${batchId}`);
        if (b.parent) {
          const parent = await backward(b.parent, depth + 1);
          return { ...node(b), origin: { kind: "moved", label: `نُقلت من ${parent?.location ?? ""}` }, inputs: parent ? [parent] : [] };
        }
        if (b.source_type === "goods_receipt") {
          const g = (await db.query<{ grn: string; supplier: string; d: string; invoice: string | null }>(
            "SELECT g.grn_number::text AS grn, s.name AS supplier, g.received_on::text AS d, g.supplier_invoice AS invoice FROM goods_receipts g JOIN suppliers s ON s.id = g.supplier_id WHERE g.id = $1", [b.source_id])).rows[0];
          return { ...node(b), origin: { kind: "supplier", label: g ? `المورد ${g.supplier} · استلام GRN-${g.grn}${g.invoice ? ` · فاتورة ${g.invoice}` : ""}` : "استلام", date: g?.d }, inputs: [] };
        }
        if (b.source_type === "manufacturing") {
          const mo = (await db.query<{ id: string; n: string }>("SELECT o.id, o.mo_number::text AS n FROM mo_events e JOIN manufacturing_orders o ON o.id = e.mo_id WHERE e.id = $1", [b.source_id])).rows[0];
          const inputs: Back[] = [];
          if (mo) {
            const used = (await db.query<{ batch_id: string }>(
              `SELECT DISTINCT bt->>'batchId' AS batch_id FROM mo_events e CROSS JOIN LATERAL jsonb_array_elements(e.detail->'lines') x
                 CROSS JOIN LATERAL jsonb_array_elements(coalesce(x->'batches', '[]'::jsonb)) bt WHERE e.mo_id = $1 AND e.kind = 'issue' AND bt->>'batchId' IS NOT NULL`, [mo.id])).rows;
            for (const u of used) { const x = await backward(u.batch_id, depth + 1); if (x) inputs.push(x); }
          }
          return { ...node(b), origin: { kind: "production", label: mo ? `إنتاج أمر التشغيل MO-${mo.n}` : "إنتاج" }, inputs };
        }
        return { ...node(b), origin: { kind: b.source_type, label: b.source_type === "opening" ? "رصيد افتتاحي" : "إنتاج تحضيري" }, inputs: [] };
      };
      type Fwd = { kind: string; label: string; date?: string; quantity?: number; batch?: ReturnType<typeof node>; next: Fwd[] };
      const forward = async (batchId: string, depth: number): Promise<Fwd[]> => {
        if (depth > 8 || seen.has(`f:${batchId}`)) return [];
        seen.add(`f:${batchId}`);
        const out: Fwd[] = [];
        for (const c of (await db.query<{ id: string }>("SELECT id FROM stock_batches WHERE parent_batch_id = $1", [batchId])).rows) {
          const b = await info(c.id);
          if (b) out.push({ kind: "moved", label: `نُقل إلى ${b.location}`, quantity: b.quantity, batch: node(b), next: await forward(c.id, depth + 1) });
        }
        const mos = (await db.query<{ mo_id: string; n: string; q: number; d: string }>(
          `SELECT e.mo_id, o.mo_number::text AS n, sum((bt->>'quantity')::numeric)::float8 AS q, min(e.created_at)::date::text AS d
             FROM mo_events e JOIN manufacturing_orders o ON o.id = e.mo_id CROSS JOIN LATERAL jsonb_array_elements(e.detail->'lines') x
             CROSS JOIN LATERAL jsonb_array_elements(coalesce(x->'batches', '[]'::jsonb)) bt
            WHERE e.kind = 'issue' AND bt->>'batchId' = $1 GROUP BY e.mo_id, o.mo_number`, [batchId])).rows;
        for (const m of mos) {
          const outputs = (await db.query<{ id: string }>(
            "SELECT b.id FROM stock_batches b JOIN mo_events e ON e.id = b.source_id WHERE b.source_type = 'manufacturing' AND e.mo_id = $1", [m.mo_id])).rows;
          const next: Fwd[] = [];
          for (const o of outputs) {
            const b = await info(o.id);
            if (b) next.push({ kind: "output", label: "ناتج", quantity: b.quantity, batch: node(b), next: await forward(o.id, depth + 1) });
          }
          out.push({ kind: "production", label: `دخل في أمر التشغيل MO-${m.n}`, date: m.d, quantity: m.q, next });
        }
        const dels = (await db.query<{ n: string; so: string; customer: string; d: string; q: number; kind: string }>(
          `SELECT d.delivery_number::text AS n, o.so_number::text AS so, c.name AS customer, d.delivered_on::text AS d, d.kind,
                  sum((bt->>'quantity')::numeric)::float8 AS q
             FROM deliveries d JOIN sales_orders o ON o.id = d.order_id JOIN customers c ON c.id = o.customer_id
             CROSS JOIN LATERAL jsonb_array_elements(d.lines) x CROSS JOIN LATERAL jsonb_array_elements(coalesce(x->'batches', '[]'::jsonb)) bt
            WHERE bt->>'batchId' = $1 GROUP BY d.id, d.delivery_number, o.so_number, c.name, d.delivered_on, d.kind`, [batchId])).rows;
        for (const d of dels) out.push({ kind: "customer", label: `سُلّم للعميل ${d.customer} · إذن DN-${d.n} · أمر SO-${d.so}`, date: d.d, quantity: d.q, next: [] });
        return out;
      };
      const inspections = (await db.query(
        `SELECT x.inspection_number::int AS number, x.decision, x.inspected_at AS "inspectedAt", p.name AS "planName" FROM qc_inspections x JOIN qc_plans p ON p.id = x.plan_id WHERE x.batch_id = $1 ORDER BY x.inspected_at`, [id])).rows;
      return { batch: node(root), backward: await backward(id, 0), forward: await forward(id, 0), inspections };
    }, { readOnly: true });
  });
}
