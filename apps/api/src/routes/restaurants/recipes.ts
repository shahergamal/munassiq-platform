import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { foodCostPercent, round4 } from "../../lib/costing.ts";
import { AppError, badRequest, notFound } from "../../lib/errors.ts";
import { likePattern, pageMeta, parsePage, sortSql } from "../../lib/pagination.ts";
import { auditTenant, isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";
import type { Db } from "../../db/pool.ts";

const schema = z.object({
  code: z.string().trim().min(1).max(30).transform((v) => v.toUpperCase()),
  name: z.string().trim().min(2).max(180),
  category: z.string().trim().max(80).nullable().optional().transform((v) => v || null),
  priceNet: z.number().min(0).max(1_000_000),
  packagingCost: z.number().min(0).max(1_000_000).default(0),
  items: z.array(z.object({ ingredientId: z.string().uuid(), quantity: z.number().positive().max(1_000_000) })).min(1, "أضف مكوناً واحداً على الأقل").max(100),
});

// Ideal cost per recipe using the tenant-wide weighted average cost of each ingredient.
// `missingCost` counts ingredients that have never been purchased, so the UI can warn instead of showing a wrong number.
const COST_CTE = `
  WITH ing_cost AS (
    SELECT ingredient_id,
           CASE WHEN sum(quantity) > 0 THEN sum(quantity * avg_cost) / sum(quantity) ELSE max(avg_cost) END AS avg_cost
      FROM stock_levels GROUP BY ingredient_id
  ), recipe_cost AS (
    SELECT ri.recipe_id,
           coalesce(sum(ri.quantity / (i.yield_percentage / 100) * coalesce(c.avg_cost, 0)), 0)::float8 AS ingredient_cost,
           count(*) FILTER (WHERE coalesce(c.avg_cost, 0) = 0)::int AS missing_cost
      FROM recipe_items ri JOIN ingredients i ON i.id = ri.ingredient_id LEFT JOIN ing_cost c ON c.ingredient_id = ri.ingredient_id
     GROUP BY ri.recipe_id
  )`;

const RECIPE_SORT = ["name", "code", "priceNet", "totalCost", "margin", "foodCostPercent", "status"];

async function replaceItems(db: Db, recipeId: string, items: z.infer<typeof schema>["items"]) {
  if (new Set(items.map((i) => i.ingredientId)).size !== items.length) throw badRequest("لا يمكن تكرار نفس المكوّن في الوصفة");
  await db.query("DELETE FROM recipe_items WHERE recipe_id = $1", [recipeId]);
  for (const it of items) {
    await db.query(
      "INSERT INTO recipe_items (tenant_id, recipe_id, ingredient_id, quantity) VALUES (app_tenant_id(), $1, $2, $3)",
      [recipeId, it.ingredientId, round4(it.quantity)],
    );
  }
}

export default async function recipesRoutes(app: FastifyInstance) {
  app.get("/recipes", { preHandler: requireTenant("recipes.view", "rep_recipe_explosion.view") }, async (req) => {
    const q = req.query as { q?: string; status?: string; page?: string; pageSize?: string; sort?: string };
    const page = parsePage(q);
    const status = ["draft", "approved", "archived"].includes(q.status ?? "") ? q.status : null;
    const search = q.q?.trim() ? likePattern(q.q) : null;
    return tenantTx(req, async (db) => {
      // "totalCost", "margin" and "foodCostPercent" are selected only so the list can be sorted by them; the returned values are recomputed below.
      const { rows } = await db.query(
        `${COST_CTE}
         SELECT r.id, r.code, r.name, r.category, r.status, r.price_net::float8 AS "priceNet", r.packaging_cost::float8 AS "packagingCost",
                coalesce(rc.ingredient_cost, 0) AS "ingredientCost", coalesce(rc.missing_cost, 0) AS "missingCost",
                coalesce(rc.ingredient_cost, 0) + r.packaging_cost::float8 AS "totalCost",
                r.price_net::float8 - (coalesce(rc.ingredient_cost, 0) + r.packaging_cost::float8) AS margin,
                CASE WHEN r.price_net > 0 THEN (coalesce(rc.ingredient_cost, 0) + r.packaging_cost::float8) / r.price_net::float8 * 100 END AS "foodCostPercent",
                count(*) OVER()::int AS "_total"
           FROM recipes r LEFT JOIN recipe_cost rc ON rc.recipe_id = r.id
          WHERE ($1::text IS NULL OR r.name ILIKE $1 OR r.code ILIKE $1) AND ($2::text IS NULL OR r.status = $2)
          ORDER BY ${sortSql(q.sort, RECIPE_SORT)}r.name, r.id LIMIT $3 OFFSET $4`,
        [search, status, page.pageSize, page.offset],
      );
      const items = rows.map(({ _total, ...r }) => {
        const cost = Number(r.ingredientCost) + Number(r.packagingCost);
        return { ...r, totalCost: cost, margin: round4(Number(r.priceNet) - cost), foodCostPercent: foodCostPercent(cost, Number(r.priceNet)) };
      });
      return { items, meta: pageMeta(page, rows[0]?._total ?? 0) };
    }, { readOnly: true });
  });

  app.get("/recipes/:id", { preHandler: requireTenant("recipes.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const r = (await db.query(
        `SELECT id, code, name, category, status, price_net::float8 AS "priceNet", packaging_cost::float8 AS "packagingCost" FROM recipes WHERE id = $1`, [id])).rows[0];
      if (!r) throw notFound();
      const items = (await db.query(
        `SELECT ri.ingredient_id AS "ingredientId", i.name, bu.name AS "baseUnit", ri.quantity::float8 AS quantity, i.yield_percentage::float8 AS "yieldPercentage"
           FROM recipe_items ri JOIN ingredients i ON i.id = ri.ingredient_id JOIN units bu ON bu.id = i.base_unit_id
          WHERE ri.recipe_id = $1 ORDER BY i.name`, [id])).rows;
      return { ...r, items };
    }, { readOnly: true });
  });

  // Live cost while the user edits a recipe. POST only to carry the draft lines; it reads, never writes.
  app.post("/recipes/cost-preview", { preHandler: requireTenant("recipes.view") }, async (req) => {
    const body = z.object({
      priceNet: z.number().min(0).max(1_000_000).default(0),
      packagingCost: z.number().min(0).max(1_000_000).default(0),
      items: z.array(z.object({ ingredientId: z.string().uuid(), quantity: z.number().positive().max(1_000_000) })).max(100),
    }).parse(req.body);
    return tenantTx(req, async (db) => {
      const ids = body.items.map((i) => i.ingredientId);
      const { rows } = await db.query<{ id: string; name: string; unit: string; y: number; c: number }>(
        `WITH ing_cost AS (
           SELECT ingredient_id, CASE WHEN sum(quantity) > 0 THEN sum(quantity * avg_cost) / sum(quantity) ELSE max(avg_cost) END AS avg_cost
             FROM stock_levels WHERE ingredient_id = ANY($1::uuid[]) GROUP BY ingredient_id
         )
         SELECT i.id, i.name, bu.name AS unit, i.yield_percentage::float8 AS y, coalesce(c.avg_cost, 0)::float8 AS c
           FROM ingredients i JOIN units bu ON bu.id = i.base_unit_id LEFT JOIN ing_cost c ON c.ingredient_id = i.id
          WHERE i.id = ANY($1::uuid[])`, [ids]);
      const byId = new Map(rows.map((r) => [r.id, r]));
      const lines = body.items.map((it) => {
        const r = byId.get(it.ingredientId);
        if (!r) throw badRequest("أحد المكونات غير موجود");
        const raw = round4(it.quantity / (r.y / 100));
        return { ingredientId: it.ingredientId, name: r.name, unit: r.unit, quantity: it.quantity, rawQuantity: raw, unitCost: r.c, cost: round4(raw * r.c), missingCost: r.c === 0 };
      });
      const ingredientCost = round4(lines.reduce((a, l) => a + l.cost, 0));
      const totalCost = round4(ingredientCost + body.packagingCost);
      return {
        lines, ingredientCost, totalCost,
        margin: round4(body.priceNet - totalCost),
        foodCostPercent: foodCostPercent(totalCost, body.priceNet),
        missingCost: lines.filter((l) => l.missingCost).length,
      };
    }, { readOnly: true });
  });

  app.post("/recipes", { preHandler: requireTenant("recipes.create") }, async (req, reply) => {
    const body = schema.parse(req.body);
    const id = await tenantTx(req, async (db) => {
      const res = await db.query<{ id: string }>(
        `INSERT INTO recipes (tenant_id, code, name, category, price_net, packaging_cost) VALUES (app_tenant_id(), $1, $2, $3, $4, $5) RETURNING id`,
        [body.code, body.name, body.category, body.priceNet, body.packagingCost]);
      const newId = (res.rows[0] as { id: string }).id;
      await replaceItems(db, newId, body.items);
      await auditTenant(db, req, "recipe.created", "recipe", newId);
      return newId;
    });
    return reply.status(201).send({ id });
  });

  app.put("/recipes/:id", { preHandler: requireTenant("recipes.edit") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const body = schema.parse(req.body);
    await tenantTx(req, async (db) => {
      const res = await db.query(
        `UPDATE recipes SET code = $2, name = $3, category = $4, price_net = $5, packaging_cost = $6 WHERE id = $1 AND status <> 'archived'`,
        [id, body.code, body.name, body.category, body.priceNet, body.packagingCost]);
      if (!res.rowCount) throw new AppError(409, "invalid_state", "الوصفة غير موجودة أو مؤرشفة");
      await replaceItems(db, id, body.items);
      await auditTenant(db, req, "recipe.updated", "recipe", id);
    });
    return { ok: true };
  });

  // Approved recipes appear on the POS menu.
  app.post("/recipes/:id/status", { preHandler: requireTenant("recipes.approve") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const { status } = z.object({ status: z.enum(["draft", "approved", "archived"]) }).parse(req.body);
    await tenantTx(req, async (db) => {
      if (status === "approved") {
        const n = await db.query("SELECT 1 FROM recipe_items WHERE recipe_id = $1 LIMIT 1", [id]);
        if (!n.rowCount) throw badRequest("لا يمكن اعتماد وصفة بلا مكونات");
      }
      const res = await db.query("UPDATE recipes SET status = $2 WHERE id = $1", [id, status]);
      if (!res.rowCount) throw notFound();
      await auditTenant(db, req, `recipe.${status}`, "recipe", id);
    });
    return { ok: true };
  });

  app.delete("/recipes/:id", { preHandler: requireTenant("recipes.delete") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    await tenantTx(req, async (db) => {
      const res = await db.query("DELETE FROM recipes WHERE id = $1", [id]); // blocked by FK once sold: archive instead
      if (!res.rowCount) throw notFound();
      await auditTenant(db, req, "recipe.deleted", "recipe", id);
    });
    return { ok: true };
  });
}

