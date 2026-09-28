import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { round4 } from "../../lib/costing.ts";
import { AppError, notFound } from "../../lib/errors.ts";
import { auditTenant, isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";

/**
 * Barcodes for scanners (a USB/Bluetooth scanner types the code and Enter; a phone reads it with its camera).
 * An ingredient can have several: the piece, the pack, the carton, each worth a quantity of its base unit.
 * The ingredient's own `barcode` field keeps meaning "one purchase unit".
 */
export default async function barcodeRoutes(app: FastifyInstance) {
  app.get("/ingredients/:id/barcodes", { preHandler: requireTenant("ingredients.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => ({
      items: (await db.query(
        `SELECT id, barcode, base_quantity::float8 AS "baseQuantity", label, created_at AS "createdAt"
           FROM ingredient_barcodes WHERE ingredient_id = $1 ORDER BY base_quantity`, [id])).rows,
    }), { readOnly: true });
  });

  app.post("/ingredients/:id/barcodes", { preHandler: requireTenant("ingredients.edit") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({
      barcode: z.string().trim().regex(/^[0-9A-Za-z\-.]{3,64}$/, "الباركود أرقام وحروف لاتينية من 3 إلى 64 خانة"),
      baseQuantity: z.number().positive("الكمية لكل مسحة أكبر من صفر").max(1_000_000_000),
      label: z.string().trim().max(60).nullable().optional().transform((v) => v || null),
    }).parse(req.body);
    const out = await tenantTx(req, async (db) => {
      if (!(await db.query("SELECT 1 FROM ingredients WHERE id = $1", [id])).rowCount) throw notFound("المادة غير موجودة");
      const clash = (await db.query<{ name: string }>(
        `SELECT i.name FROM ingredients i WHERE i.barcode = $1
         UNION ALL SELECT i.name FROM ingredient_barcodes b JOIN ingredients i ON i.id = b.ingredient_id WHERE b.barcode = $1 LIMIT 1`, [b.barcode])).rows[0];
      if (clash) throw new AppError(409, "duplicate", `الباركود مستخدم للمادة «${clash.name}»`);
      const r = (await db.query<{ id: string }>(
        "INSERT INTO ingredient_barcodes (tenant_id, ingredient_id, barcode, base_quantity, label) VALUES (app_tenant_id(), $1, $2, $3, $4) RETURNING id",
        [id, b.barcode, round4(b.baseQuantity), b.label])).rows[0]!;
      await auditTenant(db, req, "barcode.added", "ingredient", id, { barcode: b.barcode, baseQuantity: b.baseQuantity });
      return r.id;
    });
    return reply.status(201).send({ id: out });
  });

  app.delete("/ingredient-barcodes/:id", { preHandler: requireTenant("ingredients.edit") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    await tenantTx(req, async (db) => {
      const r = await db.query<{ ingredient_id: string; barcode: string }>("DELETE FROM ingredient_barcodes WHERE id = $1 RETURNING ingredient_id, barcode", [id]);
      if (!r.rows[0]) throw notFound();
      await auditTenant(db, req, "barcode.removed", "ingredient", r.rows[0].ingredient_id, { barcode: r.rows[0].barcode });
    });
    return reply.status(204).send();
  });

  // One code → the ingredient and the quantity one scan counts (receiving, transfers, waste).
  app.get("/barcodes/:code", { preHandler: requireTenant("stock.view", "goods_receipts.create", "stocktakes.count", "transfers.create", "waste.create") }, async (req) => {
    const { code } = req.params as { code: string };
    if (!/^[0-9A-Za-z\-.]{3,64}$/.test(code)) throw notFound("باركود غير معروف");
    return tenantTx(req, async (db) => {
      const r = (await db.query(
        `SELECT i.id AS "ingredientId", i.name, i.sku, bu.name AS "baseUnit", b.base_quantity::float8 AS "baseQuantity", b.label
           FROM ingredient_barcodes b JOIN ingredients i ON i.id = b.ingredient_id JOIN units bu ON bu.id = i.base_unit_id WHERE b.barcode = $1
         UNION ALL
         SELECT i.id, i.name, i.sku, bu.name, i.purchase_to_base::float8, pu.name
           FROM ingredients i JOIN units bu ON bu.id = i.base_unit_id JOIN units pu ON pu.id = i.purchase_unit_id WHERE i.barcode = $1
         LIMIT 1`, [code])).rows[0];
      if (!r) throw notFound("باركود غير معروف. أضفه للمادة من صفحة المواد الخام");
      return r;
    }, { readOnly: true });
  });
}
