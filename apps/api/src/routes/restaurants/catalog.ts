import type { FastifyInstance } from "fastify";
import { z, type ZodRawShape } from "zod";
import type { Db } from "../../db/pool.ts";
import { AppError, badRequest, notFound } from "../../lib/errors.ts";
import { likePattern, pageMeta, parsePage, sortSql } from "../../lib/pagination.ts";
import type { Permission } from "../../lib/rbac.ts";
import { auditTenant, isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";

const toSnake = (k: string) => k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);

interface CrudDef {
  path: string;
  table: string;
  entity: string;
  /** Any of these opens the list (other screens pick from it); none = every member (names only). */
  read: Permission[];
  create: Permission;
  edit: Permission;
  delete: Permission;
  schema: z.ZodObject<ZodRawShape>;
  select: string; // trusted SQL fragment with camelCase aliases
  search: string[]; // trusted snake_case column names
  order: string;
}

/** Output column names of a select list: `a`, `b AS "bee"` → [a, bee]. */
function outputAliases(select: string): string[] {
  return select.split(",").map((p) => p.trim()).map((p) => /AS "(\w+)"$/.exec(p)?.[1] ?? (/^\w+$/.test(p) ? p : null)).filter((x): x is string => x !== null);
}

/**
 * Declarative CRUD: one place for pagination, validation, audit and error handling, so every catalog
 * screen behaves identically. Column names come from the developer-defined schema, never from the client.
 */
function crud(app: FastifyInstance, def: CrudDef) {
  app.get(def.path, { preHandler: requireTenant(...def.read) }, async (req) => {
    const q = req.query as { q?: string; isActive?: string; page?: string; pageSize?: string; sort?: string };
    const page = parsePage(q);
    // Every output alias of the select list is sortable (they are developer-defined, never from the client).
    const sortable = outputAliases(def.select);
    const search = q.q?.trim() ? likePattern(q.q) : null;
    const active = q.isActive === "true" ? true : q.isActive === "false" ? false : null;
    const where = def.search.map((c) => `${c} ILIKE $1`).join(" OR ");
    return tenantTx(req, async (db) => {
      const { rows } = await db.query(
        `SELECT ${def.select}, count(*) OVER()::int AS "_total" FROM ${def.table}
          WHERE ($1::text IS NULL OR ${where}) AND ($2::boolean IS NULL OR is_active = $2)
          ORDER BY ${sortSql(q.sort, sortable)}${def.order} LIMIT $3 OFFSET $4`,
        [search, active, page.pageSize, page.offset],
      );
      const total = rows[0]?._total ?? 0;
      return { items: rows.map(({ _total, ...r }) => r), meta: pageMeta(page, total) };
    }, { readOnly: true });
  });

  app.post(def.path, { preHandler: requireTenant(def.create) }, async (req, reply) => {
    const data = def.schema.parse(req.body) as Record<string, unknown>;
    const keys = Object.keys(data);
    const id = await tenantTx(req, async (db) => {
      const res = await db.query<{ id: string }>(
        `INSERT INTO ${def.table} (tenant_id, ${keys.map(toSnake).join(", ")})
         VALUES (app_tenant_id(), ${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
        keys.map((k) => data[k]),
      );
      const newId = (res.rows[0] as { id: string }).id;
      await auditTenant(db, req, `${def.entity}.created`, def.entity, newId);
      return newId;
    });
    return reply.status(201).send({ id });
  });

  app.patch(`${def.path}/:id`, { preHandler: requireTenant(def.edit) }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const data = def.schema.partial().parse(req.body) as Record<string, unknown>;
    const keys = Object.keys(data);
    if (!keys.length) throw badRequest("لا توجد تغييرات");
    await tenantTx(req, async (db) => {
      const res = await db.query(
        `UPDATE ${def.table} SET ${keys.map((k, i) => `${toSnake(k)} = $${i + 2}`).join(", ")} WHERE id = $1`,
        [id, ...keys.map((k) => data[k])],
      );
      if (!res.rowCount) throw notFound();
      await auditTenant(db, req, `${def.entity}.updated`, def.entity, id, { fields: keys });
    });
    return { ok: true };
  });

  app.delete(`${def.path}/:id`, { preHandler: requireTenant(def.delete) }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    await tenantTx(req, async (db) => {
      const res = await db.query(`DELETE FROM ${def.table} WHERE id = $1`, [id]);
      if (!res.rowCount) throw notFound();
      await auditTenant(db, req, `${def.entity}.deleted`, def.entity, id);
    });
    return { ok: true };
  });
}

const code = z.string().trim().min(1, "أدخل الرمز").max(30).transform((v) => v.toUpperCase());
const name = z.string().trim().min(2, "أدخل الاسم").max(180);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => (v ? v : null));

export const ITEM_TYPES = ["raw", "semi_finished", "finished", "packaging", "consumable", "spare_part"] as const;

export const ingredientSchema = z.object({
  name,
  category: optionalText(80),
  baseUnitId: z.string().uuid(),
  purchaseUnitId: z.string().uuid(),
  purchaseToBase: z.number().positive().max(1_000_000).optional(),
  yieldPercentage: z.number().gt(0).max(100).default(100),
  minStock: z.number().min(0).default(0),
  /** Target level the reorder suggestion fills up to (base units). 0 = twice the minimum. */
  parStock: z.number().min(0).max(1_000_000_000).default(0),
  barcode: optionalText(60),
  /** Receiving asks for an expiry date per line, and stock is kept in dated batches (first expiry first out). */
  trackExpiry: z.boolean().optional(),
  /** Default expiry at receipt (receipt date + days) and the expiry of what a production run makes. */
  shelfLifeDays: z.number().int("عدد أيام صحيح").min(1).max(3650).nullable().optional(),
  /** Raw material, semi-finished, finished product…: in a factory it decides the inventory account the item is valued in. */
  itemType: z.enum(ITEM_TYPES).optional(),
  /** Default unit price (per base unit, VAT excluded) on quotations and sales orders. */
  salePrice: z.number().min(0).max(100_000_000).nullable().optional(),
  /** Days from ordering to having it (supplier delivery, or production): MRP orders this early. */
  leadTimeDays: z.number().int().min(0).max(365).optional(),
  /** Shown next to the Arabic name on bilingual documents. */
  nameEn: z.string().trim().max(160).nullable().optional().transform((v) => (v === undefined ? undefined : v || null))
    .refine((v) => v == null || v.length >= 2, "الاسم الإنجليزي حرفان على الأقل"),
});
export type IngredientInput = z.infer<typeof ingredientSchema>;

interface UnitRow { id: string; dimension: string; to_base: string }

export async function loadUnits(db: Db): Promise<Map<string, UnitRow>> {
  const { rows } = await db.query<UnitRow>("SELECT id, dimension, to_base::text FROM units");
  return new Map(rows.map((r) => [r.id, r]));
}

/** Resolves the purchase→base factor. Same dimension: derived from unit sizes. Otherwise it must be given. */
export function resolvePurchaseToBase(input: IngredientInput, units: Map<string, UnitRow>): number {
  const base = units.get(input.baseUnitId);
  const purchase = units.get(input.purchaseUnitId);
  if (!base || !purchase) throw badRequest("وحدة غير موجودة");
  if (input.purchaseToBase) return input.purchaseToBase;
  if (base.dimension !== purchase.dimension) throw badRequest("وحدتا الأساس والشراء من نوعين مختلفين. حدّد معامل التحويل يدوياً");
  // Count units (carton, pack, box, piece…) all have to_base 1, so "carton → piece" cannot be derived: 24? 12? It must be given.
  if (base.dimension === "count" && input.baseUnitId !== input.purchaseUnitId) throw badRequest("حدّد عدد وحدات الأساس في وحدة الشراء (مثال: كرتون فيه 24 حبة)");
  return Number(purchase.to_base) / Number(base.to_base);
}

export async function insertIngredient(db: Db, input: IngredientInput, units: Map<string, UnitRow>): Promise<string> {
  const factor = resolvePurchaseToBase(input, units);
  const n = (await db.query<{ n: string }>("SELECT next_counter('ingredient')::text AS n")).rows[0] as { n: string };
  const sku = `ING-${n.n.padStart(6, "0")}`;
  const res = await db.query<{ id: string }>(
    `INSERT INTO ingredients (tenant_id, sku, name, category, base_unit_id, purchase_unit_id, purchase_to_base, yield_percentage, min_stock, barcode, par_stock, track_expiry, shelf_life_days, item_type, name_en, sale_price, lead_time_days)
     VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
    [sku, input.name, input.category ?? null, input.baseUnitId, input.purchaseUnitId, factor, input.yieldPercentage, input.minStock, input.barcode ?? null, input.parStock ?? 0,
      input.trackExpiry ?? false, input.shelfLifeDays ?? null, input.itemType ?? "raw", input.nameEn ?? null, input.salePrice ?? null, input.leadTimeDays ?? 0],
  );
  return (res.rows[0] as { id: string }).id;
}

export async function catalogRoutes(app: FastifyInstance) {
  crud(app, {
    path: "/suppliers", table: "suppliers", entity: "supplier", read: ["suppliers.view", "purchases.view", "purchases.create", "requisitions.convert", "payables.view", "expenses.view", "expenses.create", "purchase_returns.view", "goods_receipts.view", "rep_supplier_perf.view", "rep_purchase_prices.view"],
    create: "suppliers.create", edit: "suppliers.edit", delete: "suppliers.delete",
    schema: z.object({
      code, name, taxId: optionalText(30), phone: optionalText(30),
      email: z.string().trim().email().max(255).nullable().optional().transform((v) => v ?? null),
      paymentTermsDays: z.number().int().min(0).max(365).default(0),
      // A non-resident supplier's payments carry withholding tax (routes/restaurants/payables.ts).
      residency: z.enum(["resident", "non_resident"]).default("resident"),
      isActive: z.boolean().default(true),
    }),
    select: `id, code, name, tax_id AS "taxId", phone, email, payment_terms_days AS "paymentTermsDays", residency, is_active AS "isActive"`,
    search: ["name", "code", "phone"], order: "name, id",
  });

  crud(app, {
    path: "/branches", table: "branches", entity: "branch", read: [], create: "branches.create", edit: "branches.edit", delete: "branches.delete",
    schema: z.object({ code, name, city: optionalText(80), isActive: z.boolean().default(true) }),
    select: `id, code, name, city, is_active AS "isActive"`,
    search: ["name", "code", "city"], order: "name, id",
  });

  crud(app, {
    path: "/locations", table: "locations", entity: "location", read: [], create: "locations.create", edit: "locations.edit", delete: "locations.delete",
    schema: z.object({
      code, name,
      branchId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
      locationType: z.enum(["kitchen", "warehouse", "store", "quarantine"]).default("kitchen"),
      isActive: z.boolean().default(true),
    }),
    select: `id, code, name, branch_id AS "branchId", location_type AS "locationType", is_active AS "isActive"`,
    search: ["name", "code"], order: "name, id",
  });

  app.get("/units", { preHandler: requireTenant() }, async (req) =>
    tenantTx(req, async (db) => ({
      items: (await db.query('SELECT id, code, name, dimension, to_base::float8 AS "toBase" FROM units ORDER BY dimension, to_base DESC, code')).rows,
    }), { readOnly: true }));

  const INGREDIENT_SORT = ["name", "sku", "category", "baseUnitName", "stockQty", "avgCost", "yieldPercentage", "isActive", "itemType"];

  // ── Ingredients ─────────────────────────────────────────────────────────────────────────────
  app.get("/ingredients", { preHandler: requireTenant("ingredients.view", "stock.view", "requisitions.create", "purchases.create", "purchase_returns.create", "transfers.create", "waste.create", "stocktakes.count", "recipes.create", "recipes.edit", "prep_recipes.create", "prep_recipes.edit", "modifiers.create", "modifiers.edit", "batches.view", "rep_recipe_explosion.view", "rep_purchase_prices.view") }, async (req) => {
    const q = req.query as { q?: string; isActive?: string; category?: string; stock?: string; locationId?: string; type?: string; page?: string; pageSize?: string; sort?: string };
    // With locationId, stock and cost are that location's (used when moving stock out of a specific place).
    const loc = isUuid(q.locationId) ? q.locationId : null;
    const page = parsePage(q);
    const search = q.q?.trim() ? likePattern(q.q) : null;
    const active = q.isActive === "true" ? true : q.isActive === "false" ? false : null;
    const category = q.category?.trim() ? q.category.trim().slice(0, 80) : null;
    const stock = q.stock === "low" || q.stock === "zero" ? q.stock : null;
    // One type or several ("raw,packaging": what a purchase or a bill of materials may use).
    const types = q.type ? q.type.split(",").filter((t) => (ITEM_TYPES as readonly string[]).includes(t)) : [];
    return tenantTx(req, async (db) => {
      // Stock and weighted-average cost are aggregated across locations in the database, never in the browser.
      const { rows } = await db.query(
        `WITH st AS (
           SELECT ingredient_id, sum(quantity) AS qty,
                  CASE WHEN sum(quantity) > 0 THEN sum(quantity * avg_cost) / sum(quantity) ELSE max(avg_cost) END AS avg_cost
             FROM stock_levels WHERE ($7::uuid IS NULL OR location_id = $7) GROUP BY ingredient_id
         )
         SELECT i.id, i.sku, i.name, i.name_en AS "nameEn", i.item_type AS "itemType", i.sale_price::float8 AS "salePrice", i.lead_time_days AS "leadTimeDays", i.category, i.barcode, i.is_active AS "isActive",
                i.base_unit_id AS "baseUnitId", bu.code AS "baseUnitCode", bu.name AS "baseUnit", bu.name AS "baseUnitName",
                i.purchase_unit_id AS "purchaseUnitId", pu.name AS "purchaseUnitName",
                i.purchase_to_base::float8 AS "purchaseToBase", i.yield_percentage::float8 AS "yieldPercentage",
                i.min_stock::float8 AS "minStock", i.par_stock::float8 AS "parStock", i.track_expiry AS "trackExpiry", i.shelf_life_days AS "shelfLifeDays", coalesce(st.qty, 0)::float8 AS "stockQty", round(coalesce(st.avg_cost, 0), 6)::float8 AS "avgCost",
                count(*) OVER()::int AS "_total"
           FROM ingredients i
           JOIN units bu ON bu.id = i.base_unit_id JOIN units pu ON pu.id = i.purchase_unit_id
           LEFT JOIN st ON st.ingredient_id = i.id
          WHERE ($1::text IS NULL OR i.name ILIKE $1 OR i.sku ILIKE $1 OR i.barcode ILIKE $1) AND ($2::boolean IS NULL OR i.is_active = $2)
            AND ($5::text IS NULL OR i.category = $5) AND (cardinality($8::text[]) = 0 OR i.item_type = ANY($8))
            AND ($6::text IS NULL OR ($6 = 'zero' AND coalesce(st.qty, 0) = 0) OR ($6 = 'low' AND coalesce(st.qty, 0) > 0 AND coalesce(st.qty, 0) < i.min_stock))
          ORDER BY ${sortSql(q.sort, INGREDIENT_SORT)}i.name, i.id LIMIT $3 OFFSET $4`,
        [search, active, page.pageSize, page.offset, category, stock, loc, types],
      );
      return { items: rows.map(({ _total, ...r }) => r), meta: pageMeta(page, rows[0]?._total ?? 0) };
    }, { readOnly: true });
  });

  app.get("/ingredients/categories", { preHandler: requireTenant("ingredients.view", "stocktakes.count") }, async (req) =>
    tenantTx(req, async (db) => ({
      items: (await db.query<{ category: string }>("SELECT DISTINCT category FROM ingredients WHERE category IS NOT NULL ORDER BY category LIMIT 500")).rows.map((r) => r.category),
    }), { readOnly: true }));

  app.post("/ingredients", { preHandler: requireTenant("ingredients.create") }, async (req, reply) => {
    const input = ingredientSchema.parse(req.body);
    const id = await tenantTx(req, async (db) => {
      const newId = await insertIngredient(db, input, await loadUnits(db));
      await auditTenant(db, req, "ingredient.created", "ingredient", newId);
      return newId;
    });
    return reply.status(201).send({ id });
  });

  app.patch("/ingredients/:id", { preHandler: requireTenant("ingredients.edit") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const input = ingredientSchema.partial().extend({ isActive: z.boolean().optional() }).parse(req.body);
    await tenantTx(req, async (db) => {
      const cur = (await db.query("SELECT base_unit_id, purchase_unit_id, purchase_to_base::float8 AS f, item_type FROM ingredients WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!cur) throw notFound();
      // The type decides the account the item is valued in: once stock has moved, a new type would leave its value
      // behind in the old account.
      if (input.itemType && input.itemType !== cur.item_type && (await db.query("SELECT 1 FROM stock_movements WHERE ingredient_id = $1 LIMIT 1", [id])).rowCount) {
        throw new AppError(409, "type_locked", "لا يمكن تغيير نوع صنف له حركات مخزون. أنشئ صنفاً جديداً بالنوع الصحيح");
      }
      const stocked = await db.query("SELECT 1 FROM stock_levels WHERE ingredient_id = $1 AND quantity > 0 LIMIT 1", [id]);
      if (stocked.rowCount && input.baseUnitId && input.baseUnitId !== cur.base_unit_id) {
        throw new AppError(409, "unit_locked", "لا يمكن تغيير وحدة الأساس لمادة لها رصيد مخزون");
      }
      let factor = cur.f as number;
      if (input.baseUnitId || input.purchaseUnitId || input.purchaseToBase) {
        factor = resolvePurchaseToBase(
          { ...input, baseUnitId: input.baseUnitId ?? cur.base_unit_id, purchaseUnitId: input.purchaseUnitId ?? cur.purchase_unit_id, name: "x", yieldPercentage: 100, minStock: 0 } as IngredientInput,
          await loadUnits(db),
        );
      }
      await db.query(
        `UPDATE ingredients SET name = coalesce($2, name), category = coalesce($3, category), base_unit_id = coalesce($4, base_unit_id),
                purchase_unit_id = coalesce($5, purchase_unit_id), purchase_to_base = $6, yield_percentage = coalesce($7, yield_percentage),
                min_stock = coalesce($8, min_stock), barcode = coalesce($9, barcode), is_active = coalesce($10, is_active), par_stock = coalesce($11, par_stock),
                track_expiry = coalesce($12, track_expiry), shelf_life_days = CASE WHEN $14 THEN $13 ELSE shelf_life_days END,
                item_type = coalesce($15, item_type), name_en = CASE WHEN $17 THEN $16 ELSE name_en END,
                sale_price = CASE WHEN $19 THEN $18 ELSE sale_price END, lead_time_days = coalesce($20, lead_time_days) WHERE id = $1`,
        [id, input.name ?? null, input.category ?? null, input.baseUnitId ?? null, input.purchaseUnitId ?? null, factor,
          input.yieldPercentage ?? null, input.minStock ?? null, input.barcode ?? null, input.isActive ?? null, input.parStock ?? null,
          input.trackExpiry ?? null, input.shelfLifeDays ?? null, input.shelfLifeDays !== undefined, input.itemType ?? null, input.nameEn ?? null, input.nameEn !== undefined, input.salePrice ?? null, input.salePrice !== undefined, input.leadTimeDays ?? null],
      );
      await auditTenant(db, req, "ingredient.updated", "ingredient", id, { fields: Object.keys(input) });
    });
    return { ok: true };
  });

  app.delete("/ingredients/:id", { preHandler: requireTenant("ingredients.delete") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    await tenantTx(req, async (db) => {
      const res = await db.query("DELETE FROM ingredients WHERE id = $1", [id]);
      if (!res.rowCount) throw notFound();
      await auditTenant(db, req, "ingredient.deleted", "ingredient", id);
    });
    return { ok: true };
  });

  const STOCK_SORT = ["name", "sku", "locationName", "quantity", "avgCost", "value"];

  // ── Stock on hand (read-only; changes only through purchases and sales) ──────────────────────
  app.get("/stock", { preHandler: requireTenant("stock.view", "transfers.create", "waste.create") }, async (req) => {
    const q = req.query as { locationId?: string; q?: string; page?: string; pageSize?: string; sort?: string };
    const page = parsePage(q);
    const loc = isUuid(q.locationId) ? q.locationId : null;
    const search = q.q?.trim() ? likePattern(q.q) : null;
    return tenantTx(req, async (db) => {
      const { rows } = await db.query(
        `SELECT sl.location_id AS "locationId", l.name AS "locationName", i.id AS "ingredientId", i.sku, i.name,
                bu.name AS "baseUnit", sl.quantity::float8 AS quantity, sl.avg_cost::float8 AS "avgCost",
                round(sl.quantity * sl.avg_cost, 2)::float8 AS value, (sl.quantity < i.min_stock) AS "belowMin",
                count(*) OVER()::int AS "_total"
           FROM stock_levels sl
           JOIN ingredients i ON i.id = sl.ingredient_id JOIN locations l ON l.id = sl.location_id JOIN units bu ON bu.id = i.base_unit_id
          WHERE ($1::uuid IS NULL OR sl.location_id = $1) AND ($2::text IS NULL OR i.name ILIKE $2 OR i.sku ILIKE $2)
          ORDER BY ${sortSql(q.sort, STOCK_SORT)}i.name, l.name LIMIT $3 OFFSET $4`,
        [loc, search, page.pageSize, page.offset],
      );
      return { items: rows.map(({ _total, ...r }) => r), meta: pageMeta(page, rows[0]?._total ?? 0) };
    }, { readOnly: true });
  });
}
