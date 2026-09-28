import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError, badRequest, notFound } from "../../lib/errors.ts";
import { formatMoney, parseMoney } from "../../lib/money.ts";
import { auditTenant, isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";

// Customer price lists (M3): a list gives a customer its own prices; a quotation proposes the list price first,
// then the item's sale price. The price on the order line stays what was agreed when it was written.

export default async function priceListRoutes(app: FastifyInstance) {
  app.get("/price-lists", { preHandler: requireTenant("price_lists.view", "customers.edit", "sales_orders.create") }, async (req) =>
    tenantTx(req, async (db) => ({
      items: (await db.query(
        `SELECT p.id, p.name, p.notes, p.is_active AS "isActive",
                (SELECT count(*)::int FROM price_list_items i WHERE i.list_id = p.id) AS "itemsCount",
                (SELECT count(*)::int FROM customers c WHERE c.price_list_id = p.id) AS "customersCount"
           FROM price_lists p ORDER BY p.is_active DESC, p.name`)).rows,
    }), { readOnly: true }));

  app.get("/price-lists/:id", { preHandler: requireTenant("price_lists.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const p = (await db.query(`SELECT id, name, notes, is_active AS "isActive" FROM price_lists WHERE id = $1`, [id])).rows[0];
      if (!p) throw notFound("قائمة الأسعار غير موجودة");
      const items = (await db.query(
        `SELECT x.item_id AS "itemId", i.name, i.sku, u.name AS unit, x.price::float8 AS price, i.sale_price::float8 AS "salePrice"
           FROM price_list_items x JOIN ingredients i ON i.id = x.item_id JOIN units u ON u.id = i.base_unit_id WHERE x.list_id = $1 ORDER BY i.name`, [id])).rows;
      const customers = (await db.query(`SELECT id, name FROM customers WHERE price_list_id = $1 ORDER BY name LIMIT 200`, [id])).rows;
      return { ...p, items, customers };
    }, { readOnly: true });
  });

  const head = z.object({
    name: z.string().trim().min(2, "أدخل اسم القائمة").max(120),
    notes: z.string().trim().max(500).nullable().optional().transform((v) => v || null),
  });
  const items = z.array(z.object({ itemId: z.string().uuid(), price: z.number().min(0).max(100_000_000) })).max(2000);
  const dupName = (e: unknown) => (e as { code?: string }).code === "23505";

  app.post("/price-lists", { preHandler: requireTenant("price_lists.create") }, async (req, reply) => {
    const b = head.extend({ items: items.default([]) }).parse(req.body);
    const id = await tenantTx(req, async (db) => {
      try {
        const r = (await db.query<{ id: string }>("INSERT INTO price_lists (tenant_id, name, notes) VALUES (app_tenant_id(), $1, $2) RETURNING id", [b.name, b.notes])).rows[0]!;
        await writeItems(db, r.id, b.items);
        await auditTenant(db, req, "price_list.created", "price_list", r.id, { name: b.name, items: b.items.length });
        return r.id;
      } catch (e) {
        if (dupName(e)) throw new AppError(409, "duplicate", "توجد قائمة أسعار بنفس الاسم", [{ path: "name", message: "اسم مستخدم" }]);
        throw e;
      }
    });
    return reply.status(201).send({ id });
  });

  // Replaces the list's name, notes and prices. Orders already written keep their prices.
  app.put("/price-lists/:id", { preHandler: requireTenant("price_lists.edit") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = head.extend({ items, isActive: z.boolean().default(true) }).parse(req.body);
    await tenantTx(req, async (db) => {
      try {
        const r = await db.query("UPDATE price_lists SET name = $2, notes = $3, is_active = $4 WHERE id = $1", [id, b.name, b.notes, b.isActive]);
        if (!r.rowCount) throw notFound("قائمة الأسعار غير موجودة");
      } catch (e) {
        if (dupName(e)) throw new AppError(409, "duplicate", "توجد قائمة أسعار بنفس الاسم", [{ path: "name", message: "اسم مستخدم" }]);
        throw e;
      }
      await writeItems(db, id, b.items);
      await auditTenant(db, req, "price_list.updated", "price_list", id, { items: b.items.length, isActive: b.isActive });
    });
    return { ok: true };
  });

  async function writeItems(db: Parameters<Parameters<typeof tenantTx>[1]>[0], listId: string, list: z.infer<typeof items>) {
    const ids = [...new Set(list.map((i) => i.itemId))];
    if (ids.length !== list.length) throw badRequest("صنف مكرر في القائمة");
    if (ids.length && (await db.query("SELECT 1 FROM ingredients WHERE id = ANY($1::uuid[])", [ids])).rowCount !== ids.length) throw badRequest("صنف غير موجود في القائمة");
    await db.query("DELETE FROM price_list_items WHERE list_id = $1", [listId]);
    for (const i of list) {
      await db.query("INSERT INTO price_list_items (tenant_id, list_id, item_id, price) VALUES (app_tenant_id(), $1, $2, $3)", [listId, i.itemId, formatMoney(parseMoney(i.price))]);
    }
  }
}
