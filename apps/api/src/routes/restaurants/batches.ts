import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../../db/pool.ts";
import { round4 } from "../../lib/costing.ts";
import { AppError, badRequest, notFound } from "../../lib/errors.ts";
import { pageMeta, parsePage, sortSql } from "../../lib/pagination.ts";
import { auditTenant, isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";
import { lockLevels } from "./inventory.ts";

/**
 * Batches (lots) and expiry dates. stock_levels stays the quantity and the cost; a batch says which part of that
 * quantity expires when and where it came from. Everything that lowers stock without naming a batch is matched by
 * the database trigger (stock without a batch first, then earliest expiry). The helpers below do the same match
 * explicitly when the caller needs to know WHICH batches left (a transfer carries them, a production run inherits
 * the earliest expiry of its inputs), or target one batch (a disposal).
 */

const TZ = "Asia/Riyadh";
export const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
export const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface Drawn { batchId: string; batchNo: string; expiryDate: string | null; productionDate: string | null; supplierId: string | null; quantity: number }

async function consume(db: Db, batchId: string, quantity: number, reason: "fefo" | "targeted") {
  await db.query("UPDATE stock_batches SET remaining = remaining - $2 WHERE id = $1", [batchId, quantity]);
  await db.query("INSERT INTO stock_batch_consumptions (tenant_id, batch_id, quantity, reason) VALUES (app_tenant_id(), $1, $2, $3)", [batchId, quantity, reason]);
}

/**
 * Takes `quantity` of an item out of its batches at a location, exactly as the trigger would, and says which ones.
 * Call it with the stock row locked (lockLevels) and just before the stock itself is taken out.
 */
export async function drawBatches(db: Db, locationId: string, ingredientId: string, quantity: number): Promise<Drawn[]> {
  // Stock on quality hold is not used: only a quality release moves it out (quality.ts, not through here).
  if ((await db.query<{ t: string }>("SELECT location_type AS t FROM locations WHERE id = $1", [locationId])).rows[0]?.t === "quarantine")
    throw new AppError(409, "quality_hold", "هذا موقع حجر الجودة: لا يُصرف ولا يُسلَّم منه قبل إفراج الجودة");
  const level = (await db.query<{ q: number }>("SELECT quantity::float8 AS q FROM stock_levels WHERE location_id = $1 AND ingredient_id = $2", [locationId, ingredientId])).rows[0]?.q ?? 0;
  const batches = (await db.query<{ id: string; batch_no: string; expiry_date: string | null; production_date: string | null; supplier_id: string | null; remaining: number }>(
    `SELECT id, batch_no, expiry_date::text, production_date::text, supplier_id, remaining::float8 AS remaining FROM stock_batches
      WHERE location_id = $1 AND ingredient_id = $2 AND remaining > 0 ORDER BY expiry_date NULLS LAST, received_at, id FOR UPDATE`, [locationId, ingredientId])).rows;
  const inBatches = batches.reduce((a, b) => a + b.remaining, 0);
  let need = round4(quantity - Math.max(0, round4(level - inBatches)));
  const out: Drawn[] = [];
  for (const b of batches) {
    if (need <= 0) break;
    const take = round4(Math.min(b.remaining, need));
    await consume(db, b.id, take, "fefo");
    out.push({ batchId: b.id, batchNo: b.batch_no, expiryDate: b.expiry_date, productionDate: b.production_date, supplierId: b.supplier_id, quantity: take });
    need = round4(need - take);
  }
  return out;
}

/** Takes from one named batch (a disposal of an expired lot). The stock itself is taken right after by the caller. */
export async function drawBatch(db: Db, batchId: string, locationId: string, ingredientId: string, quantity: number) {
  const b = (await db.query<{ location_id: string; ingredient_id: string; remaining: number; batch_no: string }>(
    "SELECT location_id, ingredient_id, remaining::float8 AS remaining, batch_no FROM stock_batches WHERE id = $1 FOR UPDATE", [batchId])).rows[0];
  if (!b) throw notFound("الدفعة غير موجودة");
  if (b.location_id !== locationId || b.ingredient_id !== ingredientId) throw badRequest("الدفعة لا تخص هذه المادة في هذا الموقع");
  if (quantity > b.remaining + 1e-9) throw new AppError(422, "batch_insufficient", `المتبقي في الدفعة ${b.batch_no} أقل من الكمية`);
  await consume(db, batchId, round4(quantity), "targeted");
}

/** A new batch. The quantity must already be in stock_levels (put in first), so batches never exceed the level. */
export async function addBatch(db: Db, p: {
  locationId: string; ingredientId: string; batchNo: string; expiryDate: string | null; productionDate?: string | null; quantity: number; unitCost: number;
  sourceType: "goods_receipt" | "transfer" | "production" | "opening" | "manufacturing"; sourceId: string | null; supplierId?: string | null; parentBatchId?: string | null;
}) {
  if (!(p.quantity > 0)) return null;
  const r = await db.query<{ id: string }>(
    `INSERT INTO stock_batches (tenant_id, location_id, ingredient_id, batch_no, expiry_date, production_date, quantity, remaining, unit_cost, source_type, source_id, supplier_id, parent_batch_id, created_by)
     VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $6, $7, $8, $9, $10, $11, app_user_id()) RETURNING id`,
    [p.locationId, p.ingredientId, p.batchNo.slice(0, 60), p.expiryDate, p.productionDate ?? null, round4(p.quantity), Math.max(0, p.unitCost), p.sourceType, p.sourceId, p.supplierId ?? null, p.parentBatchId ?? null]);
  return r.rows[0]!.id;
}

export interface ExpiryRule { trackExpiry: boolean; shelfLifeDays: number | null; name: string }
export async function expiryRules(db: Db, ids: string[]): Promise<Map<string, ExpiryRule>> {
  const { rows } = await db.query<{ id: string; track_expiry: boolean; shelf_life_days: number | null; name: string }>(
    "SELECT id, track_expiry, shelf_life_days, name FROM ingredients WHERE id = ANY($1::uuid[])", [ids]);
  return new Map(rows.map((r) => [r.id, { trackExpiry: r.track_expiry, shelfLifeDays: r.shelf_life_days, name: r.name }]));
}

/**
 * The expiry of a received line: the label's date, or the item's shelf life from the receipt date. An item that
 * tracks expiry cannot be received without one, and nothing is received already expired.
 */
export function receivedExpiry(rule: ExpiryRule, receivedOn: string, given: string | null | undefined) {
  const expiry = given ?? (rule.shelfLifeDays ? addDays(receivedOn, rule.shelfLifeDays) : null);
  if (rule.trackExpiry && !expiry) throw new AppError(422, "expiry_required", `أدخل تاريخ انتهاء «${rule.name}» (المادة تتتبع الصلاحية)`);
  if (expiry && expiry < receivedOn) throw new AppError(422, "expired_on_receipt", `«${rule.name}» منتهي الصلاحية (${expiry}). سجّله مرفوضاً بسبب الصلاحية`);
  return expiry;
}

const BATCH_SORT = ["expiryDate", "ingredientName", "locationName", "remaining", "value", "receivedAt", "batchNo"];

export default async function batchRoutes(app: FastifyInstance) {
  // Batches with stock, by how soon they expire. Value = remaining × the location's average cost (what a write-off costs).
  app.get("/stock/batches", { preHandler: requireTenant("batches.view") }, async (req) => {
    const q = req.query as { locationId?: string; ingredientId?: string; status?: string; days?: string; q?: string; page?: string; pageSize?: string; sort?: string };
    const page = parsePage(q);
    const days = Math.min(365, Math.max(1, Number(q.days) || 7));
    const status = ["expired", "expiring", "ok", "all", "empty"].includes(q.status ?? "") ? q.status! : "all";
    const search = (q.q ?? "").trim().slice(0, 60) || null;
    return tenantTx(req, async (db) => {
      const { rows } = await db.query(
        `SELECT b.id, b.batch_no AS "batchNo", b.expiry_date::text AS "expiryDate", b.production_date::text AS "productionDate",
                (b.expiry_date - $1::date)::int AS "daysLeft", b.quantity::float8 AS quantity, b.remaining::float8 AS remaining,
                round(b.remaining * coalesce(sl.avg_cost, b.unit_cost), 2)::float8 AS value, b.source_type AS "sourceType", b.source_id AS "sourceId",
                b.received_at AS "receivedAt", i.id AS "ingredientId", i.name AS "ingredientName", i.sku, u.name AS unit,
                l.id AS "locationId", l.name AS "locationName", s.name AS "supplierName", count(*) OVER()::int AS "_total"
           FROM stock_batches b JOIN ingredients i ON i.id = b.ingredient_id JOIN units u ON u.id = i.base_unit_id JOIN locations l ON l.id = b.location_id
           LEFT JOIN suppliers s ON s.id = b.supplier_id
           LEFT JOIN stock_levels sl ON sl.location_id = b.location_id AND sl.ingredient_id = b.ingredient_id
          WHERE ($2::uuid IS NULL OR b.location_id = $2) AND ($3::uuid IS NULL OR b.ingredient_id = $3)
            AND CASE $4 WHEN 'empty' THEN b.remaining = 0 ELSE b.remaining > 0 END
            AND CASE $4 WHEN 'expired' THEN b.expiry_date < $1::date
                        WHEN 'expiring' THEN b.expiry_date BETWEEN $1::date AND $1::date + $5::int
                        WHEN 'ok' THEN b.expiry_date IS NULL OR b.expiry_date > $1::date + $5::int
                        ELSE true END
            AND ($6::text IS NULL OR i.name ILIKE '%' || $6 || '%' OR b.batch_no ILIKE '%' || $6 || '%' OR i.sku ILIKE '%' || $6 || '%')
          ORDER BY ${sortSql(q.sort, BATCH_SORT)}b.expiry_date NULLS LAST, i.name, b.received_at LIMIT $7 OFFSET $8`,
        [today(), isUuid(q.locationId) ? q.locationId : null, isUuid(q.ingredientId) ? q.ingredientId : null, status, days, search, page.pageSize, page.offset]);
      return { today: today(), days, items: rows.map(({ _total, ...r }) => r), meta: pageMeta(page, rows[0]?._total ?? 0) };
    }, { readOnly: true });
  });

  // What needs attention: expired and soon-expiring stock, and tracked items holding stock without a batch.
  app.get("/stock/batches/summary", { preHandler: requireTenant("batches.view") }, async (req) => {
    const q = req.query as { locationId?: string; days?: string };
    const days = Math.min(365, Math.max(1, Number(q.days) || 7));
    const loc = isUuid(q.locationId) ? q.locationId : null;
    return tenantTx(req, async (db) => {
      const t = today();
      const sums = (await db.query<{ expired_count: number; expired_value: number; expiring_count: number; expiring_value: number }>(
        `SELECT count(*) FILTER (WHERE b.expiry_date < $1::date)::int AS expired_count,
                coalesce(round(sum(b.remaining * coalesce(sl.avg_cost, b.unit_cost)) FILTER (WHERE b.expiry_date < $1::date), 2), 0)::float8 AS expired_value,
                count(*) FILTER (WHERE b.expiry_date BETWEEN $1::date AND $1::date + $2::int)::int AS expiring_count,
                coalesce(round(sum(b.remaining * coalesce(sl.avg_cost, b.unit_cost)) FILTER (WHERE b.expiry_date BETWEEN $1::date AND $1::date + $2::int), 2), 0)::float8 AS expiring_value
           FROM stock_batches b LEFT JOIN stock_levels sl ON sl.location_id = b.location_id AND sl.ingredient_id = b.ingredient_id
          WHERE b.remaining > 0 AND ($3::uuid IS NULL OR b.location_id = $3)`, [t, days, loc])).rows[0]!;
      const unbatched = (await db.query(
        `SELECT i.id AS "ingredientId", i.name, u.name AS unit, l.id AS "locationId", l.name AS "locationName",
                round(sl.quantity - coalesce(bb.q, 0), 4)::float8 AS quantity
           FROM stock_levels sl JOIN ingredients i ON i.id = sl.ingredient_id AND i.track_expiry JOIN units u ON u.id = i.base_unit_id
           JOIN locations l ON l.id = sl.location_id
           LEFT JOIN (SELECT location_id, ingredient_id, sum(remaining) AS q FROM stock_batches WHERE remaining > 0 GROUP BY 1, 2) bb
             ON bb.location_id = sl.location_id AND bb.ingredient_id = sl.ingredient_id
          WHERE sl.quantity - coalesce(bb.q, 0) > 0.0001 AND ($1::uuid IS NULL OR sl.location_id = $1)
          ORDER BY i.name, l.name LIMIT 50`, [loc])).rows;
      return {
        today: t, days,
        expired: { count: sums.expired_count, value: sums.expired_value },
        expiring: { count: sums.expiring_count, value: sums.expiring_value },
        unbatched,
      };
    }, { readOnly: true });
  });

  // One batch, traced: where it came from, where its stock went (transfers → child batches), each consumption.
  app.get("/stock/batches/:id", { preHandler: requireTenant("batches.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const b = (await db.query(
        `SELECT b.id, b.batch_no AS "batchNo", b.expiry_date::text AS "expiryDate", b.production_date::text AS "productionDate", (b.expiry_date - $2::date)::int AS "daysLeft",
                b.quantity::float8 AS quantity, b.remaining::float8 AS remaining, b.unit_cost::float8 AS "unitCost", b.source_type AS "sourceType", b.source_id AS "sourceId",
                round(b.remaining * coalesce((SELECT sl.avg_cost FROM stock_levels sl WHERE sl.location_id = b.location_id AND sl.ingredient_id = b.ingredient_id), b.unit_cost), 2)::float8 AS value,
                b.received_at AS "receivedAt", b.parent_batch_id AS "parentBatchId", pb.location_id AS "parentLocationId", pl.name AS "parentLocationName",
                i.id AS "ingredientId", i.name AS "ingredientName", i.sku, u.name AS unit, l.id AS "locationId", l.name AS "locationName", s.name AS "supplierName",
                CASE b.source_type WHEN 'goods_receipt' THEN (SELECT 'GRN-' || g.grn_number FROM goods_receipts g WHERE g.id = b.source_id)
                                   WHEN 'transfer' THEN (SELECT 'TR-' || t.transfer_number FROM stock_transfers t WHERE t.id = b.source_id)
                                   WHEN 'production' THEN (SELECT 'PR-' || r.run_number FROM production_runs r WHERE r.id = b.source_id)
                                   WHEN 'manufacturing' THEN (SELECT 'MO-' || o.mo_number FROM mo_events e JOIN manufacturing_orders o ON o.id = e.mo_id WHERE e.id = b.source_id) END AS "sourceRef"
           FROM stock_batches b JOIN ingredients i ON i.id = b.ingredient_id JOIN units u ON u.id = i.base_unit_id JOIN locations l ON l.id = b.location_id
           LEFT JOIN suppliers s ON s.id = b.supplier_id LEFT JOIN stock_batches pb ON pb.id = b.parent_batch_id LEFT JOIN locations pl ON pl.id = pb.location_id
          WHERE b.id = $1`, [id, today()])).rows[0];
      if (!b) throw notFound("الدفعة غير موجودة");
      const consumptions = (await db.query(
        `SELECT c.quantity::float8 AS quantity, c.reason, c.created_at AS "createdAt" FROM stock_batch_consumptions c WHERE c.batch_id = $1 ORDER BY c.id DESC LIMIT 200`, [id])).rows;
      const children = (await db.query(
        `SELECT c.id, c.quantity::float8 AS quantity, c.remaining::float8 AS remaining, l.name AS "locationName", c.received_at AS "receivedAt"
           FROM stock_batches c JOIN locations l ON l.id = c.location_id WHERE c.parent_batch_id = $1 ORDER BY c.received_at`, [id])).rows;
      return { ...b, consumptions, children };
    }, { readOnly: true });
  });

  // Stock already on hand before tracking (or found without a label): give it a batch and an expiry date.
  app.post("/stock/batches", { preHandler: requireTenant("batches.create") }, async (req, reply) => {
    const b = z.object({
      locationId: z.string().uuid(), ingredientId: z.string().uuid(),
      batchNo: z.string().trim().min(1, "أدخل رقم الدفعة").max(60),
      expiryDate: z.string().regex(DATE, "أدخل تاريخ الانتهاء"),
      productionDate: z.string().regex(DATE).nullable().optional().transform((v) => v ?? null),
      quantity: z.number().positive("الكمية أكبر من صفر").max(1_000_000_000),
    }).refine((x) => !x.productionDate || x.productionDate <= x.expiryDate, { message: "تاريخ الإنتاج بعد تاريخ الانتهاء", path: ["productionDate"] }).parse(req.body);
    const id = await tenantTx(req, async (db) => {
      const level = (await lockLevels(db, b.locationId, [b.ingredientId])).get(b.ingredientId);
      const inBatches = (await db.query<{ q: number }>(
        "SELECT coalesce(sum(remaining), 0)::float8 AS q FROM stock_batches WHERE location_id = $1 AND ingredient_id = $2 AND remaining > 0", [b.locationId, b.ingredientId])).rows[0]!.q;
      const free = round4((level?.q ?? 0) - inBatches);
      if (b.quantity > free + 1e-9) throw new AppError(422, "exceeds_unbatched", `الرصيد بلا دفعة ${free} فقط. لا يمكن تسجيل دفعة أكبر من المخزون غير المرتبط بدفعة`, { free });
      const newId = await addBatch(db, { locationId: b.locationId, ingredientId: b.ingredientId, batchNo: b.batchNo, expiryDate: b.expiryDate, productionDate: b.productionDate,
        quantity: b.quantity, unitCost: level?.c ?? 0, sourceType: "opening", sourceId: null });
      await auditTenant(db, req, "batch.registered", "stock_batch", newId!, { batchNo: b.batchNo, expiryDate: b.expiryDate, quantity: b.quantity });
      return newId!;
    });
    return reply.status(201).send({ id });
  });
}
