import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../../db/pool.ts";
import { round4, weightedAverage } from "../../lib/costing.ts";
import { AppError, badRequest, forbidden, notFound } from "../../lib/errors.ts";
import { pageMeta, parsePage, sortSql } from "../../lib/pagination.ts";
import { auditTenant, isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";
import { idempotencyKey } from "./purchases.ts";
import { postStocktake, postTransferShortage, postWaste } from "../../lib/accounting/posting.ts";
import { addBatch, drawBatch, drawBatches, type Drawn } from "./batches.ts";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TZ = "Asia/Riyadh";
const qty = z.number().positive().max(1_000_000_000);
const lines = z.array(z.object({ ingredientId: z.string().uuid(), quantity: qty })).min(1, "أضف مادة واحدة على الأقل").max(200)
  .refine((ls) => new Set(ls.map((l) => l.ingredientId)).size === ls.length, "لا يمكن تكرار نفس المادة");

const MOVEMENT_SORT = ["createdAt", "ingredientName", "locationName", "type", "quantity", "unitCost", "value"];
const TRANSFER_SORT = ["number", "fromName", "toName", "itemsCount", "value", "status"];
const WASTE_SORT = ["number", "createdAt", "locationName", "reason", "totalCost"];
const STOCKTAKE_SORT = ["number", "locationName", "varianceValue", "status"];

interface Level { ingredient_id: string; q: number; c: number }

/**
 * Locks the stock rows of (location, ingredients) in a stable order and returns them.
 * Missing rows are created at zero first so they can be locked too (concurrent writers serialise on them).
 */
export async function lockLevels(db: Db, locationId: string, ingredientIds: string[]): Promise<Map<string, Level>> {
  const ids = [...new Set(ingredientIds)].sort();
  for (const id of ids) {
    await db.query("INSERT INTO stock_levels (tenant_id, location_id, ingredient_id, quantity, avg_cost) VALUES (app_tenant_id(), $1, $2, 0, 0) ON CONFLICT DO NOTHING", [locationId, id]);
  }
  const { rows } = await db.query<Level>(
    `SELECT ingredient_id, quantity::float8 AS q, avg_cost::float8 AS c FROM stock_levels
      WHERE location_id = $1 AND ingredient_id = ANY($2::uuid[]) ORDER BY ingredient_id FOR UPDATE`, [locationId, ids]);
  return new Map(rows.map((r) => [r.ingredient_id, r]));
}

async function ingredientNames(db: Db, ids: string[]): Promise<Map<string, { name: string; unit: string }>> {
  const { rows } = await db.query<{ id: string; name: string; unit: string }>(
    "SELECT i.id, i.name, u.name AS unit FROM ingredients i JOIN units u ON u.id = i.base_unit_id WHERE i.id = ANY($1::uuid[])", [ids]);
  return new Map(rows.map((r) => [r.id, { name: r.name, unit: r.unit }]));
}

/** Takes stock out at the current weighted-average cost. Refuses (409) rather than going negative. */
export async function takeOut(db: Db, locationId: string, items: { ingredientId: string; quantity: number }[]) {
  const levels = await lockLevels(db, locationId, items.map((i) => i.ingredientId));
  const names = await ingredientNames(db, items.map((i) => i.ingredientId));
  for (const it of items) {
    const have = levels.get(it.ingredientId)?.q ?? 0;
    if (have < it.quantity) {
      const n = names.get(it.ingredientId);
      throw new AppError(409, "insufficient_stock", `الرصيد غير كافٍ للمادة: ${n?.name ?? ""}`, { ingredient: n?.name, available: have, required: it.quantity, unit: n?.unit });
    }
  }
  const out: { ingredientId: string; quantity: number; unitCost: number }[] = [];
  for (const it of items) {
    const l = levels.get(it.ingredientId) as Level;
    await db.query("UPDATE stock_levels SET quantity = $3, updated_at = now() WHERE location_id = $1 AND ingredient_id = $2", [locationId, it.ingredientId, round4(l.q - it.quantity)]);
    out.push({ ingredientId: it.ingredientId, quantity: it.quantity, unitCost: l.c });
  }
  return out;
}

export async function putIn(db: Db, locationId: string, items: { ingredientId: string; quantity: number; unitCost: number }[]) {
  const levels = await lockLevels(db, locationId, items.map((i) => i.ingredientId));
  for (const it of items) {
    const l = levels.get(it.ingredientId) as Level;
    await db.query("UPDATE stock_levels SET quantity = $3, avg_cost = $4, updated_at = now() WHERE location_id = $1 AND ingredient_id = $2",
      [locationId, it.ingredientId, round4(l.q + it.quantity), weightedAverage(l.q, l.c, it.quantity, it.unitCost)]);
  }
}

export async function movement(db: Db, p: { locationId: string; ingredientId: string; type: string; quantity: number; unitCost: number; refType: string; refId: string }) {
  await db.query(
    `INSERT INTO stock_movements (tenant_id, location_id, ingredient_id, movement_type, quantity, unit_cost, ref_type, ref_id, created_by)
     VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, app_user_id())`,
    [p.locationId, p.ingredientId, p.type, p.quantity, p.unitCost, p.refType, p.refId]);
}

export function dateRange(q: { from?: string; to?: string }) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
  const to = DATE.test(q.to ?? "") ? (q.to as string) : today;
  const from = DATE.test(q.from ?? "") ? (q.from as string) : new Date(Date.parse(to) - 29 * 86_400_000).toISOString().slice(0, 10);
  if (from > to) throw badRequest("تاريخ البداية بعد تاريخ النهاية");
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 366) throw badRequest("الحد الأقصى للفترة سنة واحدة");
  return { from, to };
}

export default async function inventoryRoutes(app: FastifyInstance) {
  // ── Movement ledger ─────────────────────────────────────────────────────────────────────────
  app.get("/stock/movements", { preHandler: requireTenant("movements.view", "stock.view") }, async (req) => {
    const q = req.query as { ingredientId?: string; locationId?: string; type?: string; from?: string; to?: string; page?: string; pageSize?: string; sort?: string };
    const page = parsePage(q);
    const { from, to } = dateRange(q);
    const types = ["purchase", "sale", "refund_return", "transfer_out", "transfer_in", "waste", "count_adjustment", "production_in", "production_out", "purchase_return"];
    return tenantTx(req, async (db) => {
      const { rows } = await db.query(
        `SELECT m.id, m.created_at AS "createdAt", m.movement_type AS type, m.quantity::float8 AS quantity, m.unit_cost::float8 AS "unitCost",
                round(m.quantity * m.unit_cost, 2)::float8 AS value, m.ref_type AS "refType", m.ref_id AS "refId",
                i.id AS "ingredientId", i.name AS "ingredientName", u.name AS unit, l.name AS "locationName", count(*) OVER()::int AS "_total"
           FROM stock_movements m JOIN ingredients i ON i.id = m.ingredient_id JOIN units u ON u.id = i.base_unit_id JOIN locations l ON l.id = m.location_id
          WHERE ($1::uuid IS NULL OR m.ingredient_id = $1) AND ($2::uuid IS NULL OR m.location_id = $2) AND ($3::text IS NULL OR m.movement_type = $3)
            AND (m.created_at AT TIME ZONE '${TZ}')::date BETWEEN $4::date AND $5::date
          ORDER BY ${sortSql(q.sort, MOVEMENT_SORT)}m.created_at DESC, m.id LIMIT $6 OFFSET $7`,
        [isUuid(q.ingredientId) ? q.ingredientId : null, isUuid(q.locationId) ? q.locationId : null, types.includes(q.type ?? "") ? q.type : null, from, to, page.pageSize, page.offset]);
      return { from, to, items: rows.map(({ _total, ...r }) => r), meta: pageMeta(page, rows[0]?._total ?? 0) };
    }, { readOnly: true });
  });

  // ── Transfers ───────────────────────────────────────────────────────────────────────────────
  app.get("/transfers", { preHandler: requireTenant("transfers.view") }, async (req) => {
    const q = req.query as { status?: string; page?: string; pageSize?: string; sort?: string };
    const page = parsePage(q);
    const status = ["draft", "in_transit", "completed", "cancelled"].includes(q.status ?? "") ? q.status : null;
    return tenantTx(req, async (db) => {
      const { rows } = await db.query(
        `SELECT t.id, t.transfer_number AS "number", t.status, t.notes, t.created_at AS "createdAt", t.completed_at AS "completedAt",
                f.name AS "fromName", d.name AS "toName",
                (SELECT count(*)::int FROM stock_transfer_items x WHERE x.transfer_id = t.id) AS "itemsCount",
                -- Costs are fixed only when the transfer completes; a draft or cancelled one has no value (NULL sorts last).
                CASE WHEN t.status IN ('in_transit', 'completed') THEN (SELECT round(coalesce(sum(x.quantity * x.unit_cost), 0), 2)::float8 FROM stock_transfer_items x WHERE x.transfer_id = t.id) END AS value,
                round(t.shortage_value, 2)::float8 AS "shortageValue", t.dispatched_at AS "dispatchedAt",
                count(*) OVER()::int AS "_total"
           FROM stock_transfers t JOIN locations f ON f.id = t.from_location_id JOIN locations d ON d.id = t.to_location_id
          WHERE ($1::text IS NULL OR t.status = $1) ORDER BY ${sortSql(q.sort, TRANSFER_SORT)}t.created_at DESC LIMIT $2 OFFSET $3`, [status, page.pageSize, page.offset]);
      return { items: rows.map(({ _total, ...r }) => r), meta: pageMeta(page, rows[0]?._total ?? 0) };
    }, { readOnly: true });
  });

  app.get("/transfers/:id", { preHandler: requireTenant("transfers.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const t = (await db.query(
        `SELECT t.id, t.transfer_number AS "number", t.status, t.notes, t.created_at AS "createdAt", t.completed_at AS "completedAt",
                t.dispatched_at AS "dispatchedAt", round(t.shortage_value, 2)::float8 AS "shortageValue",
                t.from_location_id AS "fromLocationId", f.name AS "fromName", t.to_location_id AS "toLocationId", d.name AS "toName"
           FROM stock_transfers t JOIN locations f ON f.id = t.from_location_id JOIN locations d ON d.id = t.to_location_id WHERE t.id = $1`, [id])).rows[0];
      if (!t) throw notFound();
      const items = (await db.query(
        `SELECT x.ingredient_id AS "ingredientId", i.name, u.name AS unit, x.quantity::float8 AS quantity, x.unit_cost::float8 AS "unitCost",
                x.received_quantity::float8 AS "receivedQuantity", x.shortage_reason AS "shortageReason", i.barcode, x.batches,
                (SELECT sl.quantity::float8 FROM stock_levels sl WHERE sl.location_id = $2 AND sl.ingredient_id = x.ingredient_id) AS "available"
           FROM stock_transfer_items x JOIN ingredients i ON i.id = x.ingredient_id JOIN units u ON u.id = i.base_unit_id
          WHERE x.transfer_id = $1 ORDER BY i.name`, [id, t.fromLocationId])).rows;
      return { ...t, items };
    }, { readOnly: true });
  });

  app.post("/transfers", { preHandler: requireTenant("transfers.create") }, async (req, reply) => {
    const key = idempotencyKey(req);
    const body = z.object({
      fromLocationId: z.string().uuid(), toLocationId: z.string().uuid(),
      notes: z.string().trim().max(500).nullable().optional().transform((v) => v || null),
      items: lines,
      completeNow: z.boolean().default(false),
    }).refine((b) => b.fromLocationId !== b.toLocationId, { message: "اختر موقعين مختلفين", path: ["toLocationId"] }).parse(req.body);
    const out = await tenantTx(req, async (db) => {
      const dup = (await db.query<{ id: string }>("SELECT id FROM stock_transfers WHERE idempotency_key = $1", [key])).rows[0];
      if (dup) return { id: dup.id, replay: true };
      const n = (await db.query<{ n: string }>("SELECT next_counter('transfer')::text AS n")).rows[0] as { n: string };
      const t = (await db.query<{ id: string }>(
        `INSERT INTO stock_transfers (tenant_id, transfer_number, from_location_id, to_location_id, notes, idempotency_key, created_by)
         VALUES (app_tenant_id(), $1, $2, $3, $4, $5, app_user_id()) RETURNING id`, [n.n, body.fromLocationId, body.toLocationId, body.notes, key])).rows[0] as { id: string };
      for (const it of body.items) {
        await db.query("INSERT INTO stock_transfer_items (tenant_id, transfer_id, ingredient_id, quantity) VALUES (app_tenant_id(), $1, $2, $3)", [t.id, it.ingredientId, round4(it.quantity)]);
      }
      await auditTenant(db, req, "transfer.created", "stock_transfer", t.id);
      if (body.completeNow) {
        if (!["transfers.dispatch", "transfers.receive"].every((p) => req.tenant!.permissions.includes(p as never))) throw forbidden("النقل الفوري يحتاج صلاحيتي الإرسال والاستلام");
        await completeTransfer(db, t.id);
      }
      return { id: t.id, replay: false };
    });
    return reply.status(out.replay ? 200 : 201).send({ id: out.id });
  });

  /** Dispatch: stock leaves the source at its weighted-average cost and is "in transit" until the destination receives it. */
  async function dispatchTransfer(db: Db, id: string) {
    const t = (await db.query<{ status: string; from_location_id: string }>("SELECT status, from_location_id FROM stock_transfers WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!t) throw notFound();
    if (t.status !== "draft") throw new AppError(409, "invalid_state", "يُرسل التحويل في حالة مسودة فقط");
    const items = (await db.query<{ ingredient_id: string; q: number }>(
      "SELECT ingredient_id, quantity::float8 AS q FROM stock_transfer_items WHERE transfer_id = $1 ORDER BY ingredient_id", [id])).rows;
    // The batches (and their expiry dates) that leave, first-expiry-first, travel with the goods.
    await lockLevels(db, t.from_location_id, items.map((i) => i.ingredient_id));
    const drawn = new Map<string, Drawn[]>();
    for (const i of items) drawn.set(i.ingredient_id, await drawBatches(db, t.from_location_id, i.ingredient_id, i.q));
    const out = await takeOut(db, t.from_location_id, items.map((i) => ({ ingredientId: i.ingredient_id, quantity: i.q })));
    for (const o of out) {
      await db.query("UPDATE stock_transfer_items SET unit_cost = $3, batches = $4 WHERE transfer_id = $1 AND ingredient_id = $2",
        [id, o.ingredientId, o.unitCost, JSON.stringify(drawn.get(o.ingredientId) ?? [])]);
      await movement(db, { locationId: t.from_location_id, ingredientId: o.ingredientId, type: "transfer_out", quantity: -o.quantity, unitCost: o.unitCost, refType: "stock_transfer", refId: id });
    }
    await db.query("UPDATE stock_transfers SET status = 'in_transit', dispatched_by = app_user_id(), dispatched_at = now() WHERE id = $1", [id]);
  }

  /**
   * Receipt at the destination: what arrived goes into stock at the dispatch cost; what did not is a shortage,
   * written off (inventory adjustment) with its reason. Receiving more than was sent is refused.
   */
  async function receiveTransfer(db: Db, id: string, received: { ingredientId: string; receivedQuantity: number; shortageReason: string | null }[] | null) {
    const t = (await db.query<{ status: string; to_location_id: string }>("SELECT status, to_location_id FROM stock_transfers WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!t) throw notFound();
    if (t.status !== "in_transit") throw new AppError(409, "invalid_state", "يُستلم التحويل المُرسل فقط");
    const items = (await db.query<{ ingredient_id: string; q: number; c: number; name: string; batches: Drawn[] }>(
      `SELECT x.ingredient_id, x.quantity::float8 AS q, x.unit_cost::float8 AS c, i.name, x.batches FROM stock_transfer_items x JOIN ingredients i ON i.id = x.ingredient_id
        WHERE x.transfer_id = $1 ORDER BY x.ingredient_id`, [id])).rows;
    let shortage = 0;
    const into: { ingredientId: string; quantity: number; unitCost: number }[] = [];
    for (const it of items) {
      const r = received?.find((x) => x.ingredientId === it.ingredient_id);
      const got = r ? round4(r.receivedQuantity) : it.q;
      if (got > it.q + 1e-9) throw badRequest(`الكمية المستلمة من ${it.name} أكبر من المُرسلة`);
      if (got < it.q && !(r?.shortageReason && r.shortageReason.length >= 3)) throw badRequest(`اكتب سبب نقص ${it.name}`);
      shortage += (it.q - got) * it.c;
      await db.query("UPDATE stock_transfer_items SET received_quantity = $3, shortage_reason = $4 WHERE transfer_id = $1 AND ingredient_id = $2",
        [id, it.ingredient_id, got, got < it.q ? r!.shortageReason : null]);
      if (got > 0) into.push({ ingredientId: it.ingredient_id, quantity: got, unitCost: it.c });
    }
    if (into.length) await putIn(db, t.to_location_id, into);
    for (const o of into) await movement(db, { locationId: t.to_location_id, ingredientId: o.ingredientId, type: "transfer_in", quantity: o.quantity, unitCost: o.unitCost, refType: "stock_transfer", refId: id });
    // Dated batches arrive first (a shortage is taken from the stock that had no batch, then from the latest dates).
    for (const o of into) {
      let left = o.quantity;
      for (const b of items.find((i) => i.ingredient_id === o.ingredientId)?.batches ?? []) {
        if (left <= 0) break;
        const q = round4(Math.min(b.quantity, left));
        await addBatch(db, { locationId: t.to_location_id, ingredientId: o.ingredientId, batchNo: b.batchNo, expiryDate: b.expiryDate, productionDate: b.productionDate,
          quantity: q, unitCost: o.unitCost, sourceType: "transfer", sourceId: id, supplierId: b.supplierId, parentBatchId: b.batchId });
        left = round4(left - q);
      }
    }
    await db.query("UPDATE stock_transfers SET status = 'completed', completed_by = app_user_id(), completed_at = now(), shortage_value = $2 WHERE id = $1", [id, round4(shortage)]);
    await postTransferShortage(db, id);
    return round4(shortage);
  }

  app.post("/transfers/:id/dispatch", { preHandler: requireTenant("transfers.dispatch") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    await tenantTx(req, async (db) => {
      await dispatchTransfer(db, id);
      await auditTenant(db, req, "transfer.dispatched", "stock_transfer", id);
    });
    return { ok: true };
  });

  app.post("/transfers/:id/receive", { preHandler: requireTenant("transfers.receive") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ items: z.array(z.object({
      ingredientId: z.string().uuid(), receivedQuantity: z.number().min(0).max(1_000_000_000),
      shortageReason: z.string().trim().max(200).nullable().optional().transform((v) => v || null),
    })).max(200).optional() }).parse(req.body ?? {});
    return tenantTx(req, async (db) => {
      const shortageValue = await receiveTransfer(db, id, b.items ?? null);
      await auditTenant(db, req, "transfer.received", "stock_transfer", id, { shortageValue });
      return { ok: true, shortageValue };
    });
  });

  /** Moves stock: out of the source at its weighted-average cost, into the destination re-averaging there. One transaction. */
  async function completeTransfer(db: Db, id: string) {
    await dispatchTransfer(db, id);
    await receiveTransfer(db, id, null);
  }

  app.post("/transfers/:id/complete", { preHandler: requireTenant("transfers.dispatch") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    // Sending and receiving at once: both halves of the document.
    if (!req.tenant!.permissions.includes("transfers.receive")) throw forbidden("النقل الفوري يحتاج صلاحيتي الإرسال والاستلام");
    await tenantTx(req, async (db) => {
      await completeTransfer(db, id);
      await auditTenant(db, req, "transfer.completed", "stock_transfer", id);
    });
    return { ok: true };
  });

  app.post("/transfers/:id/cancel", { preHandler: requireTenant("transfers.cancel") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    await tenantTx(req, async (db) => {
      const r = await db.query("UPDATE stock_transfers SET status = 'cancelled' WHERE id = $1 AND status = 'draft'", [id]);
      if (!r.rowCount) throw new AppError(409, "invalid_state", "يمكن إلغاء التحويل في حالة مسودة فقط");
      await auditTenant(db, req, "transfer.cancelled", "stock_transfer", id);
    });
    return { ok: true };
  });

  // ── Waste ───────────────────────────────────────────────────────────────────────────────────
  const reasons = z.enum(["expired", "spoiled", "damaged", "prep_error", "overproduction", "other"]);
  const wasteLines = z.array(z.object({ ingredientId: z.string().uuid(), quantity: qty, batchId: z.string().uuid().nullable().optional().transform((v) => v ?? null) }))
    .min(1, "أضف مادة واحدة على الأقل").max(200)
    .refine((ls) => new Set(ls.map((l) => l.ingredientId)).size === ls.length, "لا يمكن تكرار نفس المادة");

  app.get("/waste", { preHandler: requireTenant("waste.view") }, async (req) => {
    const q = req.query as { from?: string; to?: string; reason?: string; page?: string; pageSize?: string; sort?: string };
    const page = parsePage(q);
    const { from, to } = dateRange(q);
    const reason = reasons.safeParse(q.reason).success ? q.reason : null;
    return tenantTx(req, async (db) => {
      const { rows } = await db.query(
        `SELECT w.id, w.waste_number AS "number", w.reason, w.notes, w.total_cost::float8 AS "totalCost", w.created_at AS "createdAt", l.name AS "locationName",
                (SELECT string_agg(i.name, '، ' ORDER BY i.name) FROM waste_items x JOIN ingredients i ON i.id = x.ingredient_id WHERE x.waste_id = w.id) AS summary,
                count(*) OVER()::int AS "_total"
           FROM waste_records w JOIN locations l ON l.id = w.location_id
          WHERE (w.created_at AT TIME ZONE '${TZ}')::date BETWEEN $1::date AND $2::date AND ($3::text IS NULL OR w.reason = $3)
          ORDER BY ${sortSql(q.sort, WASTE_SORT)}w.created_at DESC LIMIT $4 OFFSET $5`, [from, to, reason, page.pageSize, page.offset]);
      return { from, to, items: rows.map(({ _total, ...r }) => r), meta: pageMeta(page, rows[0]?._total ?? 0) };
    }, { readOnly: true });
  });

  app.post("/waste", { preHandler: requireTenant("waste.create") }, async (req, reply) => {
    const key = idempotencyKey(req);
    const body = z.object({
      locationId: z.string().uuid(),
      reason: reasons,
      notes: z.string().trim().max(500).nullable().optional().transform((v) => v || null),
      items: wasteLines,
    }).refine((b) => b.reason !== "other" || (b.notes ?? "").length >= 3, { message: "اشرح سبب الهدر عند اختيار «أخرى»", path: ["notes"] }).parse(req.body);
    const out = await tenantTx(req, async (db) => {
      const dup = (await db.query<{ id: string; total_cost: string }>("SELECT id, total_cost::text FROM waste_records WHERE idempotency_key = $1", [key])).rows[0];
      if (dup) return { id: dup.id, totalCost: Number(dup.total_cost), replay: true };
      // A line naming a batch (an expired lot) takes from that batch; the others follow first-expiry-first.
      await lockLevels(db, body.locationId, body.items.map((i) => i.ingredientId));
      for (const it of body.items) if (it.batchId) await drawBatch(db, it.batchId, body.locationId, it.ingredientId, it.quantity);
      const taken = await takeOut(db, body.locationId, body.items);
      const total = round4(taken.reduce((a, t) => a + t.quantity * t.unitCost, 0));
      const n = (await db.query<{ n: string }>("SELECT next_counter('waste')::text AS n")).rows[0] as { n: string };
      const w = (await db.query<{ id: string }>(
        `INSERT INTO waste_records (tenant_id, waste_number, location_id, reason, notes, total_cost, idempotency_key, created_by)
         VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, app_user_id()) RETURNING id`, [n.n, body.locationId, body.reason, body.notes, total, key])).rows[0] as { id: string };
      for (const t of taken) {
        await db.query("INSERT INTO waste_items (tenant_id, waste_id, ingredient_id, quantity, unit_cost, batch_id) VALUES (app_tenant_id(), $1, $2, $3, $4, $5)",
          [w.id, t.ingredientId, t.quantity, t.unitCost, body.items.find((i) => i.ingredientId === t.ingredientId)?.batchId ?? null]);
        await movement(db, { locationId: body.locationId, ingredientId: t.ingredientId, type: "waste", quantity: -t.quantity, unitCost: t.unitCost, refType: "waste", refId: w.id });
      }
      await postWaste(db, w.id);
      await auditTenant(db, req, "waste.recorded", "waste", w.id, { reason: body.reason, total });
      return { id: w.id, totalCost: total, replay: false };
    });
    return reply.status(out.replay ? 200 : 201).send({ id: out.id, totalCost: out.totalCost });
  });

  // ── Stocktakes ──────────────────────────────────────────────────────────────────────────────
  app.get("/stocktakes", { preHandler: requireTenant("stocktakes.view") }, async (req) => {
    const q = req.query as { status?: string; page?: string; pageSize?: string; sort?: string };
    const page = parsePage(q);
    const status = ["counting", "posted", "cancelled"].includes(q.status ?? "") ? q.status : null;
    return tenantTx(req, async (db) => {
      const { rows } = await db.query(
        `SELECT s.id, s.count_number AS "number", s.status, s.notes, s.variance_value::float8 AS "varianceValue", s.created_at AS "createdAt", s.posted_at AS "postedAt",
                l.name AS "locationName",
                (SELECT count(*)::int FROM stocktake_items x WHERE x.stocktake_id = s.id) AS "itemsCount",
                (SELECT count(*)::int FROM stocktake_items x WHERE x.stocktake_id = s.id AND x.counted_qty IS NOT NULL) AS "countedCount",
                count(*) OVER()::int AS "_total"
           FROM stocktakes s JOIN locations l ON l.id = s.location_id
          WHERE ($1::text IS NULL OR s.status = $1) ORDER BY ${sortSql(q.sort, STOCKTAKE_SORT)}s.created_at DESC LIMIT $2 OFFSET $3`, [status, page.pageSize, page.offset]);
      return { items: rows.map(({ _total, ...r }) => r), meta: pageMeta(page, rows[0]?._total ?? 0) };
    }, { readOnly: true });
  });

  app.post("/stocktakes", { preHandler: requireTenant("stocktakes.count") }, async (req, reply) => {
    const body = z.object({
      locationId: z.string().uuid(), notes: z.string().trim().max(500).nullable().optional().transform((v) => v || null),
      // A cycle count covers one category; posting then adjusts only those items.
      category: z.string().trim().max(80).nullable().optional().transform((v) => v || null),
    }).parse(req.body);
    const id = await tenantTx(req, async (db) => {
      const n = (await db.query<{ n: string }>("SELECT next_counter('stocktake')::text AS n")).rows[0] as { n: string };
      let s;
      try {
        s = (await db.query<{ id: string }>(
          "INSERT INTO stocktakes (tenant_id, count_number, location_id, notes, created_by, category) VALUES (app_tenant_id(), $1, $2, $3, app_user_id(), $4) RETURNING id",
          [n.n, body.locationId, body.notes, body.category])).rows[0] as { id: string };
      } catch (err) {
        if ((err as { constraint?: string }).constraint === "stocktakes_one_open_uq") throw new AppError(409, "count_open", "يوجد جرد مفتوح لهذا الموقع. أكمله أو ألغِه أولاً");
        throw err;
      }
      // The sheet lists every active ingredient, so items that exist physically but not in the system can be counted too.
      await db.query(
        `INSERT INTO stocktake_items (tenant_id, stocktake_id, ingredient_id)
         SELECT app_tenant_id(), $1, i.id FROM ingredients i WHERE i.is_active AND ($2::text IS NULL OR i.category = $2)`, [s.id, body.category]);
      if (!(await db.query("SELECT 1 FROM stocktake_items WHERE stocktake_id = $1 LIMIT 1", [s.id])).rowCount) throw badRequest("لا توجد مواد نشطة في هذه الفئة");
      await auditTenant(db, req, "stocktake.started", "stocktake", s.id);
      return s.id;
    });
    return reply.status(201).send({ id });
  });

  app.get("/stocktakes/:id", { preHandler: requireTenant("stocktakes.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const s = (await db.query(
        `SELECT s.id, s.count_number AS "number", s.status, s.notes, s.variance_value::float8 AS "varianceValue", s.created_at AS "createdAt", s.posted_at AS "postedAt",
                s.location_id AS "locationId", l.name AS "locationName", s.category, s.scanned
           FROM stocktakes s JOIN locations l ON l.id = s.location_id WHERE s.id = $1`, [id])).rows[0];
      if (!s) throw notFound();
      // Blind count: while counting, the system quantity is NOT returned, so the counter cannot copy it.
      const posted = s.status === "posted";
      const items = (await db.query(
        `SELECT x.ingredient_id AS "ingredientId", i.name, i.category, u.name AS unit, x.counted_qty::float8 AS "countedQty",
                ${posted ? `x.system_qty::float8 AS "systemQty", x.unit_cost::float8 AS "unitCost",
                (x.counted_qty - x.system_qty)::float8 AS variance, round((x.counted_qty - x.system_qty) * x.unit_cost, 2)::float8 AS "varianceValue"` : `NULL AS "systemQty"`}
           FROM stocktake_items x JOIN ingredients i ON i.id = x.ingredient_id JOIN units u ON u.id = i.base_unit_id
          WHERE x.stocktake_id = $1 ORDER BY i.category NULLS LAST, i.name`, [id])).rows;
      // Every barcode of the items on this sheet, with the quantity one scan adds (base units), so a scanner
      // (keyboard or camera) resolves codes instantly on the device.
      const barcodes = s.status === "counting" ? (await db.query(
        `SELECT b.barcode AS code, b.ingredient_id AS "ingredientId", b.base_quantity::float8 AS "baseQuantity", b.label
           FROM ingredient_barcodes b JOIN stocktake_items x ON x.ingredient_id = b.ingredient_id AND x.stocktake_id = $1
         UNION ALL
         SELECT i.barcode, i.id, i.purchase_to_base::float8, pu.name
           FROM ingredients i JOIN units pu ON pu.id = i.purchase_unit_id JOIN stocktake_items x ON x.ingredient_id = i.id AND x.stocktake_id = $1
          WHERE i.barcode IS NOT NULL AND btrim(i.barcode) <> ''`, [id])).rows : [];
      return { ...s, items, barcodes };
    }, { readOnly: true });
  });

  app.put("/stocktakes/:id/counts", { preHandler: requireTenant("stocktakes.count") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const body = z.object({
      items: z.array(z.object({ ingredientId: z.string().uuid(), countedQty: z.number().min(0).max(1_000_000_000).nullable() })).max(2000),
      scanned: z.boolean().optional(),
    }).parse(req.body);
    await tenantTx(req, async (db) => {
      const s = (await db.query<{ status: string }>("SELECT status FROM stocktakes WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!s) throw notFound();
      if (s.status !== "counting") throw new AppError(409, "invalid_state", "الجرد مُرحَّل أو ملغى ولا يمكن تعديل العد");
      if (body.scanned) await db.query("UPDATE stocktakes SET scanned = true WHERE id = $1", [id]);
      for (const it of body.items) {
        await db.query("UPDATE stocktake_items SET counted_qty = $3 WHERE stocktake_id = $1 AND ingredient_id = $2", [id, it.ingredientId, it.countedQty === null ? null : round4(it.countedQty)]);
      }
    });
    return { ok: true };
  });

  /** Posting: system quantity is read under lock at this moment, counted items become the new balance, the difference is a movement. */
  app.post("/stocktakes/:id/post", { preHandler: requireTenant("stocktakes.post") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const s = (await db.query<{ status: string; location_id: string; created_by: string }>("SELECT status, location_id, created_by FROM stocktakes WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!s) throw notFound();
      if (s.status !== "counting") throw new AppError(409, "invalid_state", "الجرد مُرحَّل أو ملغى");
      const counted = (await db.query<{ ingredient_id: string; c: number }>(
        "SELECT ingredient_id, counted_qty::float8 AS c FROM stocktake_items WHERE stocktake_id = $1 AND counted_qty IS NOT NULL ORDER BY ingredient_id", [id])).rows;
      if (!counted.length) throw badRequest("لم تُدخل أي كمية معدودة. أدخل العد ثم رحّل");
      const levels = await lockLevels(db, s.location_id, counted.map((c) => c.ingredient_id));
      let varianceValue = 0;
      for (const c of counted) {
        const l = levels.get(c.ingredient_id) as Level;
        const delta = round4(c.c - l.q);
        varianceValue += delta * l.c;
        await db.query("UPDATE stocktake_items SET system_qty = $3, unit_cost = $4 WHERE stocktake_id = $1 AND ingredient_id = $2", [id, c.ingredient_id, l.q, l.c]);
        if (delta !== 0) {
          await db.query("UPDATE stock_levels SET quantity = $3, updated_at = now() WHERE location_id = $1 AND ingredient_id = $2", [s.location_id, c.ingredient_id, c.c]);
          await movement(db, { locationId: s.location_id, ingredientId: c.ingredient_id, type: "count_adjustment", quantity: delta, unitCost: l.c, refType: "stocktake", refId: id });
        }
      }
      varianceValue = round4(varianceValue);
      await db.query("UPDATE stocktakes SET status = 'posted', posted_by = app_user_id(), posted_at = now(), variance_value = $2 WHERE id = $1", [id, varianceValue]);
      await postStocktake(db, id);
      await auditTenant(db, req, "stocktake.posted", "stocktake", id, { varianceValue, items: counted.length });
      return { ok: true, varianceValue, countedItems: counted.length };
    });
  });

  app.post("/stocktakes/:id/cancel", { preHandler: requireTenant("stocktakes.count") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    await tenantTx(req, async (db) => {
      const r = await db.query("UPDATE stocktakes SET status = 'cancelled' WHERE id = $1 AND status = 'counting'", [id]);
      if (!r.rowCount) throw new AppError(409, "invalid_state", "يمكن إلغاء الجرد أثناء العد فقط");
      await auditTenant(db, req, "stocktake.cancelled", "stocktake", id);
    });
    return { ok: true };
  });

  // ── Reports ─────────────────────────────────────────────────────────────────────────────────
  app.get("/reports/waste-analysis", { preHandler: requireTenant("rep_waste.view") }, async (req) => {
    const { from, to } = dateRange(req.query as { from?: string; to?: string });
    return tenantTx(req, async (db) => {
      const where = `(w.created_at AT TIME ZONE '${TZ}')::date BETWEEN $1::date AND $2::date`;
      const byReason = (await db.query(
        `SELECT w.reason, count(DISTINCT w.id)::int AS records, round(sum(x.quantity * x.unit_cost), 2)::float8 AS value
           FROM waste_records w JOIN waste_items x ON x.waste_id = w.id WHERE ${where} GROUP BY w.reason ORDER BY value DESC`, [from, to])).rows;
      const byIngredient = (await db.query(
        `SELECT i.id AS "ingredientId", i.name, u.name AS unit, sum(x.quantity)::float8 AS quantity, round(sum(x.quantity * x.unit_cost), 2)::float8 AS value
           FROM waste_records w JOIN waste_items x ON x.waste_id = w.id JOIN ingredients i ON i.id = x.ingredient_id JOIN units u ON u.id = i.base_unit_id
          WHERE ${where} GROUP BY i.id, i.name, u.name ORDER BY value DESC LIMIT 50`, [from, to])).rows;
      const total = byReason.reduce((a, r) => a + Number(r.value), 0);
      return { from, to, total: Math.round(total * 100) / 100, byReason, byIngredient };
    }, { readOnly: true });
  });

  app.get("/reports/stock-variance", { preHandler: requireTenant("rep_stock_variance.view") }, async (req) => {
    const { from, to } = dateRange(req.query as { from?: string; to?: string });
    return tenantTx(req, async (db) => {
      const { rows } = await db.query(
        `SELECT i.id AS "ingredientId", i.name, u.name AS unit, count(DISTINCT s.id)::int AS counts,
                sum(x.counted_qty - x.system_qty)::float8 AS variance, round(sum((x.counted_qty - x.system_qty) * x.unit_cost), 2)::float8 AS "varianceValue"
           FROM stocktakes s JOIN stocktake_items x ON x.stocktake_id = s.id JOIN ingredients i ON i.id = x.ingredient_id JOIN units u ON u.id = i.base_unit_id
          WHERE s.status = 'posted' AND x.counted_qty IS NOT NULL AND x.counted_qty <> x.system_qty
            AND (s.posted_at AT TIME ZONE '${TZ}')::date BETWEEN $1::date AND $2::date
          GROUP BY i.id, i.name, u.name ORDER BY abs(sum((x.counted_qty - x.system_qty) * x.unit_cost)) DESC LIMIT 100`, [from, to]);
      const total = rows.reduce((a, r) => a + Number(r.varianceValue), 0);
      return { from, to, total: Math.round(total * 100) / 100, items: rows };
    }, { readOnly: true });
  });
}
