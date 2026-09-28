import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { round4, round6 } from "../../lib/costing.ts";
import { AppError, badRequest, notFound } from "../../lib/errors.ts";
import { likePattern, pageMeta, parsePage, sortSql } from "../../lib/pagination.ts";
import { auditTenant, isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";
import { insertIngredient, loadUnits } from "./catalog.ts";
import { lockLevels, movement, putIn, takeOut } from "./inventory.ts";
import { addBatch, addDays, drawBatches, expiryRules, today } from "./batches.ts";
import { idempotencyKey } from "./purchases.ts";

const items = z.array(z.object({ ingredientId: z.string().uuid(), quantity: z.number().positive().max(1_000_000) })).min(1, "أضف مكوناً واحداً على الأقل").max(100)
  .refine((ls) => new Set(ls.map((l) => l.ingredientId)).size === ls.length, "لا يمكن تكرار نفس المكوّن");

// Estimated batch cost from the current tenant-wide weighted-average cost of each input (inputs are RAW quantities).
const EST = `
  WITH ing_cost AS (
    SELECT ingredient_id, CASE WHEN sum(quantity) > 0 THEN sum(quantity * avg_cost) / sum(quantity) ELSE max(avg_cost) END AS c
      FROM stock_levels GROUP BY ingredient_id
  ), est AS (
    SELECT pi.prep_recipe_id, coalesce(sum(pi.quantity * coalesce(c.c, 0)), 0) AS batch_cost,
           count(*) FILTER (WHERE coalesce(c.c, 0) = 0)::int AS missing, count(*)::int AS n
      FROM prep_recipe_items pi LEFT JOIN ing_cost c ON c.ingredient_id = pi.ingredient_id GROUP BY pi.prep_recipe_id
  )`;

const PREP_SORT = ["name", "batchYield", "estimatedUnitCost", "stockQty", "isActive"];
const RUN_SORT = ["createdAt", "name", "locationName", "batches", "outputQuantity", "unitCost", "totalCost"];

export default async function prepRoutes(app: FastifyInstance) {
  app.get("/prep-recipes", { preHandler: requireTenant("prep_recipes.view") }, async (req) => {
    const q = req.query as { q?: string; page?: string; pageSize?: string; sort?: string };
    const page = parsePage(q);
    const search = q.q?.trim() ? likePattern(q.q) : null;
    return tenantTx(req, async (db) => {
      const { rows } = await db.query(
        `${EST}
         SELECT p.id, i.id AS "ingredientId", i.name, i.category, i.sku, u.name AS unit, p.batch_yield::float8 AS "batchYield", p.is_active AS "isActive",
                coalesce(e.n, 0) AS "itemsCount", coalesce(e.missing, 0) AS "missingCost",
                round(coalesce(e.batch_cost, 0), 4)::float8 AS "batchCost", round(coalesce(e.batch_cost, 0) / p.batch_yield, 6)::float8 AS "estimatedUnitCost",
                coalesce((SELECT sum(sl.quantity) FROM stock_levels sl WHERE sl.ingredient_id = i.id), 0)::float8 AS "stockQty",
                count(*) OVER()::int AS "_total"
           FROM prep_recipes p JOIN ingredients i ON i.id = p.ingredient_id JOIN units u ON u.id = i.base_unit_id LEFT JOIN est e ON e.prep_recipe_id = p.id
          WHERE ($1::text IS NULL OR i.name ILIKE $1 OR i.sku ILIKE $1) ORDER BY ${sortSql(q.sort, PREP_SORT)}i.name LIMIT $2 OFFSET $3`, [search, page.pageSize, page.offset]);
      return { items: rows.map(({ _total, ...r }) => r), meta: pageMeta(page, rows[0]?._total ?? 0) };
    }, { readOnly: true });
  });

  app.get("/prep-recipes/:id", { preHandler: requireTenant("prep_recipes.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const p = (await db.query(
        `${EST}
         SELECT p.id, i.id AS "ingredientId", i.name, i.category, u.id AS "unitId", u.name AS unit, p.batch_yield::float8 AS "batchYield", p.notes, p.is_active AS "isActive",
                i.min_stock::float8 AS "minStock", round(coalesce(e.batch_cost, 0), 4)::float8 AS "batchCost",
                round(coalesce(e.batch_cost, 0) / p.batch_yield, 6)::float8 AS "estimatedUnitCost", coalesce(e.missing, 0) AS "missingCost"
           FROM prep_recipes p JOIN ingredients i ON i.id = p.ingredient_id JOIN units u ON u.id = i.base_unit_id LEFT JOIN est e ON e.prep_recipe_id = p.id
          WHERE p.id = $1`, [id])).rows[0];
      if (!p) throw notFound();
      const lines = (await db.query(
        `WITH ing_cost AS (SELECT ingredient_id, CASE WHEN sum(quantity) > 0 THEN sum(quantity * avg_cost) / sum(quantity) ELSE max(avg_cost) END AS c FROM stock_levels GROUP BY ingredient_id)
         SELECT pi.ingredient_id AS "ingredientId", i.name, u.name AS unit, pi.quantity::float8 AS quantity, round(coalesce(c.c, 0), 6)::float8 AS "unitCost",
                round(pi.quantity * coalesce(c.c, 0), 4)::float8 AS cost
           FROM prep_recipe_items pi JOIN ingredients i ON i.id = pi.ingredient_id JOIN units u ON u.id = i.base_unit_id LEFT JOIN ing_cost c ON c.ingredient_id = pi.ingredient_id
          WHERE pi.prep_recipe_id = $1 ORDER BY i.name`, [id])).rows;
      return { ...p, items: lines };
    }, { readOnly: true });
  });

  // Creates the prepared ingredient AND its recipe in one transaction.
  app.post("/prep-recipes", { preHandler: requireTenant("prep_recipes.create") }, async (req, reply) => {
    const body = z.object({
      name: z.string().trim().min(2, "أدخل اسم الصنف المحضّر").max(180),
      category: z.string().trim().max(80).nullable().optional().transform((v) => v || null),
      unitId: z.string().uuid(),
      batchYield: z.number().positive().max(1_000_000),
      minStock: z.number().min(0).default(0),
      notes: z.string().trim().max(500).nullable().optional().transform((v) => v || null),
      items,
    }).parse(req.body);
    const id = await tenantTx(req, async (db) => {
      const ingredientId = await insertIngredient(db, { name: body.name, category: body.category, baseUnitId: body.unitId, purchaseUnitId: body.unitId, yieldPercentage: 100, minStock: body.minStock, parStock: 0, barcode: null }, await loadUnits(db));
      if (body.items.some((i) => i.ingredientId === ingredientId)) throw badRequest("لا يمكن أن يكون الصنف مكوّناً لنفسه");
      await db.query("UPDATE ingredients SET is_prepared = true WHERE id = $1", [ingredientId]);
      const p = (await db.query<{ id: string }>(
        "INSERT INTO prep_recipes (tenant_id, ingredient_id, batch_yield, notes) VALUES (app_tenant_id(), $1, $2, $3) RETURNING id",
        [ingredientId, round4(body.batchYield), body.notes])).rows[0] as { id: string };
      for (const it of body.items) {
        await db.query("INSERT INTO prep_recipe_items (tenant_id, prep_recipe_id, ingredient_id, quantity) VALUES (app_tenant_id(), $1, $2, $3)", [p.id, it.ingredientId, round4(it.quantity)]);
      }
      await auditTenant(db, req, "prep_recipe.created", "prep_recipe", p.id);
      return p.id;
    });
    return reply.status(201).send({ id });
  });

  app.put("/prep-recipes/:id", { preHandler: requireTenant("prep_recipes.edit") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const body = z.object({
      batchYield: z.number().positive().max(1_000_000),
      notes: z.string().trim().max(500).nullable().optional().transform((v) => v || null),
      isActive: z.boolean().default(true),
      items,
    }).parse(req.body);
    await tenantTx(req, async (db) => {
      const p = (await db.query<{ ingredient_id: string }>("SELECT ingredient_id FROM prep_recipes WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!p) throw notFound();
      if (body.items.some((i) => i.ingredientId === p.ingredient_id)) throw badRequest("لا يمكن أن يكون الصنف مكوّناً لنفسه");
      await db.query("UPDATE prep_recipes SET batch_yield = $2, notes = $3, is_active = $4 WHERE id = $1", [id, round4(body.batchYield), body.notes, body.isActive]);
      await db.query("DELETE FROM prep_recipe_items WHERE prep_recipe_id = $1", [id]);
      for (const it of body.items) {
        await db.query("INSERT INTO prep_recipe_items (tenant_id, prep_recipe_id, ingredient_id, quantity) VALUES (app_tenant_id(), $1, $2, $3)", [id, it.ingredientId, round4(it.quantity)]);
      }
      await auditTenant(db, req, "prep_recipe.updated", "prep_recipe", id);
    });
    return { ok: true };
  });

  /**
   * Production: raw inputs leave the location at their weighted-average cost; the prepared output enters at
   * exactly (input cost ÷ output quantity). One transaction, idempotent, recorded as an immutable run.
   */
  app.post("/prep-recipes/:id/produce", { preHandler: requireTenant("prep_recipes.produce") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const key = idempotencyKey(req);
    const body = z.object({ locationId: z.string().uuid(), batches: z.number().positive().max(10_000) }).parse(req.body);
    const out = await tenantTx(req, async (db) => {
      const dup = (await db.query<{ id: string; output_quantity: string; unit_cost: string }>("SELECT id, output_quantity::text, unit_cost::text FROM production_runs WHERE idempotency_key = $1", [key])).rows[0];
      if (dup) return { id: dup.id, outputQuantity: Number(dup.output_quantity), unitCost: Number(dup.unit_cost), replay: true };
      const p = (await db.query<{ ingredient_id: string; batch_yield: number; is_active: boolean }>(
        "SELECT ingredient_id, batch_yield::float8 AS batch_yield, is_active FROM prep_recipes WHERE id = $1 FOR SHARE", [id])).rows[0];
      if (!p) throw notFound();
      if (!p.is_active) throw new AppError(409, "invalid_state", "الوصفة التحضيرية موقوفة");
      const inputs = (await db.query<{ ingredient_id: string; q: number }>("SELECT ingredient_id, quantity::float8 AS q FROM prep_recipe_items WHERE prep_recipe_id = $1", [id])).rows;
      await lockLevels(db, body.locationId, inputs.map((i) => i.ingredient_id));
      let inputExpiry: string | null = null;
      for (const i of inputs) {
        for (const d of await drawBatches(db, body.locationId, i.ingredient_id, round4(i.q * body.batches))) {
          if (d.expiryDate && (!inputExpiry || d.expiryDate < inputExpiry)) inputExpiry = d.expiryDate;
        }
      }
      const taken = await takeOut(db, body.locationId, inputs.map((i) => ({ ingredientId: i.ingredient_id, quantity: round4(i.q * body.batches) })));
      const totalCost = round4(taken.reduce((a, t) => a + t.quantity * t.unitCost, 0));
      const outputQty = round4(p.batch_yield * body.batches);
      const unitCost = round6(totalCost / outputQty);
      const n = (await db.query<{ n: string }>("SELECT next_counter('production')::text AS n")).rows[0] as { n: string };
      const run = (await db.query<{ id: string }>(
        `INSERT INTO production_runs (tenant_id, run_number, prep_recipe_id, location_id, batches, output_quantity, total_cost, unit_cost, idempotency_key, created_by)
         VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, app_user_id()) RETURNING id`,
        [n.n, id, body.locationId, body.batches, outputQty, totalCost, unitCost, key])).rows[0] as { id: string };
      for (const t of taken) {
        await movement(db, { locationId: body.locationId, ingredientId: t.ingredientId, type: "production_out", quantity: -t.quantity, unitCost: t.unitCost, refType: "production", refId: run.id });
      }
      await putIn(db, body.locationId, [{ ingredientId: p.ingredient_id, quantity: outputQty, unitCost }]);
      await movement(db, { locationId: body.locationId, ingredientId: p.ingredient_id, type: "production_in", quantity: outputQty, unitCost, refType: "production", refId: run.id });
      // What is made expires after its shelf life, and never after the earliest-expiring input it was made from.
      const rule = (await expiryRules(db, [p.ingredient_id])).get(p.ingredient_id)!;
      const own = rule.shelfLifeDays ? addDays(today(), rule.shelfLifeDays) : null;
      const expiry = own && inputExpiry ? (own < inputExpiry ? own : inputExpiry) : own ?? inputExpiry;
      if (rule.trackExpiry || expiry) {
        await addBatch(db, { locationId: body.locationId, ingredientId: p.ingredient_id, batchNo: `PR-${n.n}`, expiryDate: expiry, productionDate: today(),
          quantity: outputQty, unitCost, sourceType: "production", sourceId: run.id });
      }
      await auditTenant(db, req, "production.completed", "production_run", run.id, { batches: body.batches, outputQty, totalCost });
      return { id: run.id, outputQuantity: outputQty, unitCost, replay: false };
    });
    return reply.status(out.replay ? 200 : 201).send({ id: out.id, outputQuantity: out.outputQuantity, unitCost: out.unitCost });
  });

  app.get("/production-runs", { preHandler: requireTenant("prep_recipes.view", "stock.view") }, async (req) => {
    const q = req.query as { prepRecipeId?: string; page?: string; pageSize?: string; sort?: string };
    const page = parsePage(q);
    return tenantTx(req, async (db) => {
      const { rows } = await db.query(
        `SELECT r.id, r.run_number AS "number", r.created_at AS "createdAt", r.batches::float8 AS batches, r.output_quantity::float8 AS "outputQuantity",
                r.total_cost::float8 AS "totalCost", r.unit_cost::float8 AS "unitCost", i.name, u.name AS unit, l.name AS "locationName", count(*) OVER()::int AS "_total"
           FROM production_runs r JOIN prep_recipes p ON p.id = r.prep_recipe_id JOIN ingredients i ON i.id = p.ingredient_id JOIN units u ON u.id = i.base_unit_id
           JOIN locations l ON l.id = r.location_id
          WHERE ($1::uuid IS NULL OR r.prep_recipe_id = $1) ORDER BY ${sortSql(q.sort, RUN_SORT)}r.created_at DESC LIMIT $2 OFFSET $3`,
        [isUuid(q.prepRecipeId) ? q.prepRecipeId : null, page.pageSize, page.offset]);
      return { items: rows.map(({ _total, ...r }) => r), meta: pageMeta(page, rows[0]?._total ?? 0) };
    }, { readOnly: true });
  });
}
