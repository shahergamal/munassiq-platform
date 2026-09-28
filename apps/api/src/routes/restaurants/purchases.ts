import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Db } from "../../db/pool.ts";
import { z } from "zod";
import { landedUnitCosts, round4, type CostAllocation } from "../../lib/costing.ts";
import { AppError, badRequest, forbidden, notFound } from "../../lib/errors.ts";
import { formatMoney, parseMoney, percentToBp, vatOf } from "../../lib/money.ts";
import { likePattern, pageMeta, parsePage, sortSql } from "../../lib/pagination.ts";
import { auditTenant, isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";
import { postGoodsReceipt } from "../../lib/accounting/posting.ts";
import { movement, putIn } from "./inventory.ts";
import { addBatch, expiryRules, receivedExpiry } from "./batches.ts";

const PURCHASE_SORT = ["number", "supplierName", "locationName", "supplierInvoice", "createdAt", "grandTotal", "status"];

const amount = z.number().min(0).max(1_000_000_000);

const createSchema = z.object({
  supplierId: z.string().uuid(),
  locationId: z.string().uuid(),
  supplierInvoice: z.string().trim().max(60).nullable().optional().transform((v) => v || null),
  expectedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().transform((v) => v ?? null),
  notes: z.string().trim().max(500).nullable().optional().transform((v) => v || null),
  discount: amount.default(0),
  shipping: amount.default(0),
  fees: amount.default(0),
  /** How shipping and fees (freight, insurance, customs, clearance) are spread over the lines at receipt. */
  costAllocation: z.enum(["value", "quantity", "weight"]).default("value"),
  /** Whether the supplier's invoice carries VAT. Omitted: yes when the supplier has a VAT number. The rate is always the tenant's. */
  vatApplicable: z.boolean().optional(),
  items: z.array(z.object({
    ingredientId: z.string().uuid(),
    quantity: z.number().positive().max(1_000_000_000),
    unitPrice: amount,
  })).min(1, "أضف صنفاً واحداً على الأقل").max(200),
});

export function idempotencyKey(req: FastifyRequest): string {
  const k = req.headers["idempotency-key"];
  if (typeof k !== "string" || !isUuid(k)) throw new AppError(400, "idempotency_key_required", "مفتاح منع التكرار (Idempotency-Key) مطلوب");
  return k;
}

export type PurchaseInput = z.infer<typeof createSchema>;
export const purchaseSchema = createSchema;

/** Creates a draft purchase order inside the caller's transaction (totals and VAT computed here). Idempotent on `key`. */
export async function createPurchaseOrder(db: Db, body: PurchaseInput, key: string, req: FastifyRequest | null): Promise<{ id: string; replay: boolean }> {
  if (new Set(body.items.map((i) => i.ingredientId)).size !== body.items.length) throw badRequest("لا يمكن تكرار نفس الصنف في أمر الشراء");
  const existing = await db.query<{ id: string }>("SELECT id FROM purchase_orders WHERE idempotency_key = $1", [key]);
  if (existing.rows[0]) return { id: existing.rows[0].id, replay: true };

  const lines = body.items.map((it) => ({ ...it, line: parseMoney(it.quantity * it.unitPrice) }));
  const subtotal = lines.reduce((a, l) => a + l.line, 0);
  const discount = parseMoney(body.discount);
  if (discount > subtotal) throw badRequest("الخصم أكبر من إجمالي الأصناف");
  const total = subtotal - discount + parseMoney(body.shipping) + parseMoney(body.fees);
  const tax = (await db.query<{ rate: number; registered: boolean }>(
    `SELECT st.vat_rate_percent::float8 AS rate, coalesce(s.tax_id IS NOT NULL AND btrim(s.tax_id) <> '', false) AS registered
       FROM tenant_settings st LEFT JOIN suppliers s ON s.id = $1`, [body.supplierId])).rows[0] as { rate: number; registered: boolean };
  // A supplier outside this workspace is invisible here; the foreign key rejects it on insert.
  const vatRate = (body.vatApplicable ?? tax.registered) ? tax.rate : 0;
  const vat = vatOf(total, percentToBp(vatRate));
  const number = (await db.query<{ n: string }>("SELECT next_counter('po')::text AS n")).rows[0] as { n: string };
  const po = await db.query<{ id: string }>(
    `INSERT INTO purchase_orders (tenant_id, po_number, supplier_id, location_id, supplier_invoice, subtotal, discount, shipping, fees, total, vat_rate, vat_amount, idempotency_key, created_by, expected_date, notes, cost_allocation)
     VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, app_user_id(), $13, $14, $15) RETURNING id`,
    [number.n, body.supplierId, body.locationId, body.supplierInvoice, formatMoney(subtotal), formatMoney(discount),
      formatMoney(parseMoney(body.shipping)), formatMoney(parseMoney(body.fees)), formatMoney(total), vatRate, formatMoney(vat), key, body.expectedDate, body.notes, body.costAllocation],
  );
  const id = (po.rows[0] as { id: string }).id;
  for (const l of lines) {
    await db.query(
      `INSERT INTO purchase_items (tenant_id, purchase_order_id, ingredient_id, quantity, unit_price, line_total)
       VALUES (app_tenant_id(), $1, $2, $3, $4, $5)`,
      [id, l.ingredientId, l.quantity, l.unitPrice, formatMoney(l.line)],
    );
  }
  if (req) await auditTenant(db, req, "purchase.created", "purchase_order", id, { total: formatMoney(total), vat: formatMoney(vat) });
  return { id, replay: false };
}

export default async function purchasesRoutes(app: FastifyInstance) {
  app.get("/purchases", { preHandler: requireTenant("purchases.view", "purchase_returns.create", "payables.pay") }, async (req) => {
    const q = req.query as { status?: string; q?: string; page?: string; pageSize?: string; sort?: string };
    const page = parsePage(q);
    const status = ["draft", "approved", "partially_received", "received", "closed", "cancelled"].includes(q.status ?? "") ? q.status : null;
    const search = q.q?.trim() ? likePattern(q.q) : null;
    return tenantTx(req, async (db) => {
      const { rows } = await db.query(
        `SELECT po.id, po.po_number AS "number", po.status, po.supplier_invoice AS "supplierInvoice", po.total::float8 AS total,
                po.vat_amount::float8 AS "vatAmount", po.grand_total::float8 AS "grandTotal", po.created_at AS "createdAt", s.name AS "supplierName", l.name AS "locationName", count(*) OVER()::int AS "_total"
           FROM purchase_orders po
           JOIN suppliers s ON s.id = po.supplier_id JOIN locations l ON l.id = po.location_id
          WHERE ($1::text IS NULL OR po.status = $1) AND ($2::text IS NULL OR s.name ILIKE $2 OR po.supplier_invoice ILIKE $2 OR po.po_number::text ILIKE $2)
          ORDER BY ${sortSql(q.sort, PURCHASE_SORT)}po.created_at DESC LIMIT $3 OFFSET $4`,
        [status, search, page.pageSize, page.offset],
      );
      return { items: rows.map(({ _total, ...r }) => r), meta: pageMeta(page, rows[0]?._total ?? 0) };
    }, { readOnly: true });
  });

  app.get("/purchases/:id", { preHandler: requireTenant("purchases.view", "goods_receipts.create") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const po = (await db.query(
        `SELECT po.id, po.po_number AS "number", po.status, po.supplier_invoice AS "supplierInvoice", po.subtotal::float8 AS subtotal,
                po.discount::float8 AS discount, po.shipping::float8 AS shipping, po.fees::float8 AS fees, po.total::float8 AS total, po.cost_allocation AS "costAllocation",
                po.vat_rate::float8 AS "vatRate", po.vat_amount::float8 AS "vatAmount", po.grand_total::float8 AS "grandTotal", po.created_by AS "createdBy", po.created_at AS "createdAt", po.approved_at AS "approvedAt", po.received_at AS "receivedAt",
                po.supplier_id AS "supplierId", s.name AS "supplierName", po.location_id AS "locationId", l.name AS "locationName",
                po.expected_date::text AS "expectedDate", po.notes, po.closed_reason AS "closedReason", po.closed_at AS "closedAt",
                po.requisition_id AS "requisitionId", (SELECT r.pr_number FROM purchase_requisitions r WHERE r.id = po.requisition_id) AS "requisitionNumber",
                s.tax_id AS "supplierTaxId", s.phone AS "supplierPhone", s.payment_terms_days AS "paymentTermsDays"
           FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id JOIN locations l ON l.id = po.location_id WHERE po.id = $1`, [id])).rows[0];
      if (!po) throw notFound();
      const items = (await db.query(
        `SELECT pi.ingredient_id AS "ingredientId", i.name, i.sku, pu.name AS "purchaseUnit", pi.quantity::float8 AS quantity,
                pi.unit_price::float8 AS "unitPrice", pi.line_total::float8 AS "lineTotal", pi.received_unit_cost::float8 AS "receivedUnitCost",
                pi.received_quantity::float8 AS "receivedQuantity", i.barcode, i.purchase_to_base::float8 AS "purchaseToBase",
                i.track_expiry AS "trackExpiry", i.shelf_life_days AS "shelfLifeDays"
           FROM purchase_items pi JOIN ingredients i ON i.id = pi.ingredient_id JOIN units pu ON pu.id = i.purchase_unit_id
          WHERE pi.purchase_order_id = $1 ORDER BY i.name`, [id])).rows;
      const receipts = (await db.query(
        `SELECT g.id, g.grn_number AS "number", g.received_on::text AS "receivedOn", g.supplier_invoice AS "supplierInvoice", g.grand_total::float8 AS "grandTotal",
                g.invoice_amount::float8 AS "invoiceAmount", (g.invoice_amount - g.grand_total)::float8 AS "invoiceVariance",
                (SELECT count(*)::int FROM goods_receipt_items x WHERE x.receipt_id = g.id AND x.rejected_quantity > 0) AS "rejectedLines"
           FROM goods_receipts g WHERE g.purchase_order_id = $1 ORDER BY g.grn_number`, [id])).rows;
      return { ...po, items, receipts };
    }, { readOnly: true });
  });

  app.post("/purchases", { preHandler: requireTenant("purchases.create") }, async (req, reply) => {
    const key = idempotencyKey(req);
    const body = createSchema.parse(req.body);
    const result = await tenantTx(req, (db) => createPurchaseOrder(db, body, key, req));
    return reply.status(result.replay ? 200 : 201).send({ id: result.id });
  });

  app.post("/purchases/:id/approve", { preHandler: requireTenant("purchases.approve") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    await tenantTx(req, async (db) => {
      const po = (await db.query<{ status: string; created_by: string; grand_total: string; limit: string | null }>(
        "SELECT po.status, po.created_by, po.grand_total::text, st.po_owner_approval_above::text AS limit FROM purchase_orders po, tenant_settings st WHERE po.id = $1 FOR UPDATE OF po", [id])).rows[0];
      if (!po) throw notFound();
      if (po.status !== "draft") throw new AppError(409, "invalid_state", "يمكن اعتماد أوامر الشراء في حالة مسودة فقط");
      // Approval matrix: above the workspace's limit only the owner commits the money.
      if (po.limit !== null && parseMoney(po.grand_total) > parseMoney(po.limit) && req.tenant!.role !== "owner") {
        throw new AppError(403, "approval_limit", `قيمة الأمر تتجاوز حد الاعتماد (${po.limit}) ويعتمده مالك المنشأة فقط`);
      }
      // Segregation of duties: the author of a purchase order cannot approve it (the owner is exempt in one-person shops).
      if (po.created_by === req.tenant!.userId && req.tenant!.role !== "owner") throw forbidden("لا يمكنك اعتماد أمر شراء أنشأته بنفسك");
      await db.query("UPDATE purchase_orders SET status = 'approved', approved_by = app_user_id(), approved_at = now() WHERE id = $1", [id]);
      await auditTenant(db, req, "purchase.approved", "purchase_order", id);
    });
    return { ok: true };
  });

  app.post("/purchases/:id/cancel", { preHandler: requireTenant("purchases.cancel") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    await tenantTx(req, async (db) => {
      const res = await db.query("UPDATE purchase_orders SET status = 'cancelled' WHERE id = $1 AND status IN ('draft', 'approved')", [id]);
      if (!res.rowCount) throw new AppError(409, "invalid_state", "لا يمكن إلغاء أمر الشراء في حالته الحالية");
      await auditTenant(db, req, "purchase.cancelled", "purchase_order", id);
    });
    return { ok: true };
  });

  // ── Goods receipt notes: one per delivery. Stock in, landed cost, weighted average, journal: ONE transaction. ──
  const receiptSchema = z.object({
    receivedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صحيح").optional(),
    supplierInvoice: z.string().trim().max(60).nullable().optional().transform((v) => v || null),
    supplierInvoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().transform((v) => v ?? null),
    /** The supplier invoice's total (VAT included), for the three-way match. */
    invoiceAmount: z.number().min(0).max(1_000_000_000).nullable().optional().transform((v) => v ?? null),
    notes: z.string().trim().max(500).nullable().optional().transform((v) => v || null),
    items: z.array(z.object({
      ingredientId: z.string().uuid(),
      quantity: z.number().min(0).max(1_000_000_000),
      rejectedQuantity: z.number().min(0).max(1_000_000_000).default(0),
      rejectReason: z.string().trim().max(200).nullable().optional().transform((v) => v || null),
      /** As invoiced, per purchase unit; omitted = the PO price. */
      unitPrice: amount.optional(),
      /** The supplier's label: lot number and dates. Expiry is required for items that track it (or comes from their shelf life). */
      batchNo: z.string().trim().max(60).nullable().optional().transform((v) => v || null),
      expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ انتهاء غير صحيح").nullable().optional().transform((v) => v ?? null),
      productionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ إنتاج غير صحيح").nullable().optional().transform((v) => v ?? null),
    })).min(1, "أضف صنفاً واحداً على الأقل").max(200)
      .refine((ls) => new Set(ls.map((l) => l.ingredientId)).size === ls.length, "لا يمكن تكرار نفس الصنف"),
  });
  type ReceiptInput = z.infer<typeof receiptSchema>;

  async function receiveGoods(db: Db, req: FastifyRequest, poId: string, b: ReceiptInput, key: string) {
    const dup = (await db.query<{ id: string }>("SELECT id FROM goods_receipts WHERE idempotency_key = $1", [key])).rows[0];
    if (dup) return { id: dup.id, replay: true };
    const po = (await db.query<{ status: string; location_id: string; supplier_id: string; subtotal: string; discount: string; shipping: string; fees: string; vat_rate: number; cost_allocation: CostAllocation }>(
      "SELECT status, location_id, supplier_id, subtotal::text, discount::text, shipping::text, fees::text, vat_rate::float8 AS vat_rate, cost_allocation FROM purchase_orders WHERE id = $1 FOR UPDATE", [poId])).rows[0];
    if (!po) throw notFound();
    if (po.status !== "approved" && po.status !== "partially_received") throw new AppError(409, "invalid_state", "يجب اعتماد أمر الشراء قبل الاستلام، ولا يُستلم أمر مكتمل أو مغلق");
    const ordered = new Map((await db.query<{ ingredient_id: string; quantity: number; received_quantity: number; unit_price: string; purchase_to_base: number; name: string; grams: number }>(
      `SELECT pi.ingredient_id, pi.quantity::float8 AS quantity, pi.received_quantity::float8 AS received_quantity, pi.unit_price::text, i.purchase_to_base::float8 AS purchase_to_base, i.name,
              CASE WHEN u.dimension = 'mass' THEN u.to_base ELSE 0 END::float8 AS grams
         FROM purchase_items pi JOIN ingredients i ON i.id = pi.ingredient_id JOIN units u ON u.id = i.base_unit_id WHERE pi.purchase_order_id = $1`, [poId])).rows.map((r) => [r.ingredient_id, r]));
    for (const it of b.items) {
      const o = ordered.get(it.ingredientId);
      if (!o) throw badRequest("صنف غير موجود في أمر الشراء");
      if (it.quantity + it.rejectedQuantity <= 0) throw badRequest(`أدخل الكمية المستلمة أو المرفوضة للصنف ${o.name}`);
      if (it.rejectedQuantity > 0 && !it.rejectReason) throw badRequest(`اكتب سبب رفض ${o.name} (تالف، منتهي، مخالف للمواصفات…)`);
      if (round4(o.received_quantity + it.quantity) > round4(o.quantity) + 1e-9) {
        throw new AppError(422, "over_receipt", `الكمية المستلمة من ${o.name} تتجاوز المطلوب (المتبقي ${round4(o.quantity - o.received_quantity)})`);
      }
    }
    const accepted = b.items.filter((it) => it.quantity > 0).sort((a, c) => a.ingredientId.localeCompare(c.ingredientId));
    const priceOf = (it: ReceiptInput["items"][number]) => it.unitPrice ?? Number(ordered.get(it.ingredientId)!.unit_price);
    const lineTotal = (it: ReceiptInput["items"][number]) => parseMoney(it.quantity * priceOf(it));
    const subtotal = accepted.reduce((a, it) => a + lineTotal(it), 0);

    // The PO's discount, shipping and fees follow what was delivered (at the ordered price); the delivery that
    // completes the order takes whatever is left, so the receipts always add up to the order.
    const completes = [...ordered.values()].every((o) => {
      const now = accepted.find((a) => a.ingredientId === o.ingredient_id)?.quantity ?? 0;
      return round4(o.received_quantity + now) >= round4(o.quantity);
    });
    const prior = (await db.query<{ d: string; s: string; f: string }>(
      "SELECT coalesce(sum(discount), 0)::text AS d, coalesce(sum(shipping), 0)::text AS s, coalesce(sum(fees), 0)::text AS f FROM goods_receipts WHERE purchase_order_id = $1", [poId])).rows[0]!;
    const poSub = parseMoney(po.subtotal);
    const deliveredAtOrder = accepted.reduce((a, it) => a + parseMoney(it.quantity * Number(ordered.get(it.ingredientId)!.unit_price)), 0);
    const share = (whole: string, before: string) => {
      const w = parseMoney(whole), p = parseMoney(before);
      if (completes) return Math.max(0, w - p);
      return poSub > 0 ? Math.min(Math.max(0, w - p), Math.round((w * deliveredAtOrder) / poSub)) : 0;
    };
    const discount = Math.min(share(po.discount, prior.d), subtotal);
    const shipping = share(po.shipping, prior.s);
    const fees = share(po.fees, prior.f);
    const total = subtotal - discount + shipping + fees;
    const vat = vatOf(total, percentToBp(po.vat_rate));

    const unitCosts = accepted.length ? landedUnitCosts(
      accepted.map((it) => {
        const o = ordered.get(it.ingredientId)!;
        const baseQuantity = round4(it.quantity * o.purchase_to_base);
        return { lineValue: lineTotal(it), baseQuantity, weight: baseQuantity * o.grams };
      }),
      { discount, shipping, fees }, po.cost_allocation) : [];

    const receivedOn = b.receivedOn ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh" }).format(new Date());
    // Expiry per accepted line: the label, or the item's shelf life; required for tracked items, never already past.
    const rules = await expiryRules(db, accepted.map((it) => it.ingredientId));
    const expiries = new Map(accepted.map((it) => {
      if (it.productionDate && it.expiryDate && it.productionDate > it.expiryDate) throw badRequest(`تاريخ إنتاج ${rules.get(it.ingredientId)?.name ?? ""} بعد تاريخ انتهائه`);
      return [it.ingredientId, receivedExpiry(rules.get(it.ingredientId)!, receivedOn, it.expiryDate)] as const;
    }));
    const n = (await db.query<{ n: string }>("SELECT next_counter('grn')::text AS n")).rows[0]!.n;
    const grn = (await db.query<{ id: string }>(
      `INSERT INTO goods_receipts (tenant_id, grn_number, purchase_order_id, supplier_id, location_id, received_on, supplier_invoice, supplier_invoice_date, invoice_amount,
                                   subtotal, discount, shipping, fees, total, vat_rate, vat_amount, notes, idempotency_key, created_by)
       VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, app_user_id()) RETURNING id`,
      [n, poId, po.supplier_id, po.location_id, receivedOn, b.supplierInvoice, b.supplierInvoiceDate, b.invoiceAmount === null ? null : formatMoney(parseMoney(b.invoiceAmount)),
        formatMoney(subtotal), formatMoney(discount), formatMoney(shipping), formatMoney(fees), formatMoney(total), po.vat_rate, formatMoney(vat), b.notes, key])).rows[0]!;

    for (const it of b.items) {
      const o = ordered.get(it.ingredientId)!;
      const idx = accepted.indexOf(it);
      const unitCost = idx >= 0 ? unitCosts[idx]! : null;
      await db.query(
        `INSERT INTO goods_receipt_items (tenant_id, receipt_id, ingredient_id, quantity, rejected_quantity, reject_reason, ordered_price, unit_price, line_total, unit_cost,
                                          batch_no, expiry_date, production_date)
         VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [grn.id, it.ingredientId, round4(it.quantity), round4(it.rejectedQuantity), it.rejectReason, o.unit_price, priceOf(it), formatMoney(it.quantity > 0 ? lineTotal(it) : 0), unitCost,
          it.batchNo, expiries.get(it.ingredientId) ?? it.expiryDate, it.productionDate]);
      if (it.quantity > 0) {
        const baseQty = round4(it.quantity * o.purchase_to_base);
        await putIn(db, po.location_id, [{ ingredientId: it.ingredientId, quantity: baseQty, unitCost: unitCost! }]);
        await movement(db, { locationId: po.location_id, ingredientId: it.ingredientId, type: "purchase", quantity: baseQty, unitCost: unitCost!, refType: "goods_receipt", refId: grn.id });
        const expiry = expiries.get(it.ingredientId) ?? null;
        if (expiry || it.batchNo || rules.get(it.ingredientId)?.trackExpiry) {
          await addBatch(db, { locationId: po.location_id, ingredientId: it.ingredientId, batchNo: it.batchNo ?? `GRN-${n}`, expiryDate: expiry, productionDate: it.productionDate,
            quantity: baseQty, unitCost: unitCost!, sourceType: "goods_receipt", sourceId: grn.id, supplierId: po.supplier_id });
        }
        await db.query("UPDATE purchase_items SET received_quantity = received_quantity + $3, received_unit_cost = $4 WHERE purchase_order_id = $1 AND ingredient_id = $2",
          [poId, it.ingredientId, round4(it.quantity), unitCost]);
      }
    }
    await db.query(
      `UPDATE purchase_orders SET status = CASE WHEN $2 THEN 'received' ELSE 'partially_received' END,
              received_by = CASE WHEN $2 THEN app_user_id() ELSE received_by END, received_at = CASE WHEN $2 THEN now() ELSE received_at END,
              supplier_invoice = coalesce(supplier_invoice, $3) WHERE id = $1`, [poId, completes, b.supplierInvoice]);
    if (accepted.length) await postGoodsReceipt(db, grn.id);
    await auditTenant(db, req, completes ? "purchase.received" : "purchase.partially_received", "goods_receipt", grn.id,
      { purchaseOrderId: poId, total: formatMoney(total), vat: formatMoney(vat), rejected: b.items.filter((i) => i.rejectedQuantity > 0).length });
    return { id: grn.id, replay: false };
  }

  app.post("/purchases/:id/receipts", { preHandler: requireTenant("goods_receipts.create") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const key = idempotencyKey(req);
    const body = receiptSchema.parse(req.body);
    const out = await tenantTx(req, (db) => receiveGoods(db, req, id, body, key));
    return reply.status(out.replay ? 200 : 201).send({ id: out.id });
  });

  // Everything still outstanding, at the ordered prices (one delivery, no rejections).
  app.post("/purchases/:id/receive", { preHandler: requireTenant("goods_receipts.create") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const headerKey = req.headers["idempotency-key"];
    await tenantTx(req, async (db) => {
      const rest = (await db.query<{ ingredient_id: string; q: number }>(
        "SELECT ingredient_id, (quantity - received_quantity)::float8 AS q FROM purchase_items WHERE purchase_order_id = $1 AND quantity > received_quantity", [id])).rows;
      const po = (await db.query<{ status: string; supplier_invoice: string | null }>("SELECT status, supplier_invoice FROM purchase_orders WHERE id = $1", [id])).rows[0];
      if (!po) throw notFound();
      if (po.status !== "approved" && po.status !== "partially_received") throw new AppError(409, "invalid_state", "يجب اعتماد أمر الشراء قبل الاستلام");
      await receiveGoods(db, req, id, { supplierInvoice: po.supplier_invoice, supplierInvoiceDate: null, invoiceAmount: null, notes: null,
        items: rest.map((r) => ({ ingredientId: r.ingredient_id, quantity: r.q, rejectedQuantity: 0, rejectReason: null, batchNo: null, expiryDate: null, productionDate: null })) },
        typeof headerKey === "string" && isUuid(headerKey) ? headerKey : randomUUID());
    });
    return { ok: true };
  });

  // A PO that will not be delivered in full: close what is left, with the reason (the received part stays).
  app.post("/purchases/:id/close", { preHandler: requireTenant("purchases.close") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ reason: z.string().trim().min(3, "اكتب سبب إغلاق الأمر").max(300) }).parse(req.body);
    await tenantTx(req, async (db) => {
      const r = await db.query("UPDATE purchase_orders SET status = 'closed', closed_reason = $2, closed_by = app_user_id(), closed_at = now() WHERE id = $1 AND status = 'partially_received'", [id, b.reason]);
      if (!r.rowCount) throw new AppError(409, "invalid_state", "يُغلق الأمر المستلم جزئياً فقط. الأمر غير المستلم يُلغى");
      await auditTenant(db, req, "purchase.closed", "purchase_order", id, { reason: b.reason });
    });
    return { ok: true };
  });

  app.get("/goods-receipts", { preHandler: requireTenant("goods_receipts.view") }, async (req) => {
    const q = req.query as { supplierId?: string; mismatch?: string; page?: string; pageSize?: string };
    const page = parsePage(q);
    return tenantTx(req, async (db) => {
      const { rows } = await db.query(
        `SELECT g.id, g.grn_number AS "number", g.received_on::text AS "receivedOn", g.supplier_invoice AS "supplierInvoice", g.supplier_invoice_date::text AS "supplierInvoiceDate",
                g.total::float8 AS total, g.vat_amount::float8 AS "vatAmount", g.grand_total::float8 AS "grandTotal", g.invoice_amount::float8 AS "invoiceAmount",
                (g.invoice_amount - g.grand_total)::float8 AS "invoiceVariance", g.legacy,
                po.id AS "purchaseOrderId", po.po_number AS "poNumber", s.name AS "supplierName", l.name AS "locationName",
                (SELECT count(*)::int FROM goods_receipt_items x WHERE x.receipt_id = g.id AND x.rejected_quantity > 0) AS "rejectedLines",
                count(*) OVER()::int AS "_total"
           FROM goods_receipts g JOIN purchase_orders po ON po.id = g.purchase_order_id JOIN suppliers s ON s.id = g.supplier_id JOIN locations l ON l.id = g.location_id
          WHERE ($1::uuid IS NULL OR g.supplier_id = $1)
            AND (NOT $2 OR g.supplier_invoice IS NULL OR (g.invoice_amount IS NOT NULL AND abs(g.invoice_amount - g.grand_total) >= 0.01))
          ORDER BY g.received_on DESC, g.grn_number DESC LIMIT $3 OFFSET $4`,
        [isUuid(q.supplierId) ? q.supplierId : null, q.mismatch === "true", page.pageSize, page.offset]);
      return { items: rows.map(({ _total, ...r }) => r), meta: pageMeta(page, rows[0]?._total ?? 0) };
    }, { readOnly: true });
  });

  app.get("/goods-receipts/:id", { preHandler: requireTenant("goods_receipts.view", "payables.view", "batches.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const g = (await db.query(
        `SELECT g.id, g.grn_number AS "number", g.received_on::text AS "receivedOn", g.supplier_invoice AS "supplierInvoice", g.supplier_invoice_date::text AS "supplierInvoiceDate",
                g.invoice_amount::float8 AS "invoiceAmount", g.subtotal::float8 AS subtotal, g.discount::float8 AS discount, g.shipping::float8 AS shipping, g.fees::float8 AS fees,
                g.total::float8 AS total, g.vat_rate::float8 AS "vatRate", g.vat_amount::float8 AS "vatAmount", g.grand_total::float8 AS "grandTotal", g.notes, g.created_at AS "createdAt",
                po.id AS "purchaseOrderId", po.po_number AS "poNumber", s.name AS "supplierName", s.tax_id AS "supplierTaxId", l.name AS "locationName"
           FROM goods_receipts g JOIN purchase_orders po ON po.id = g.purchase_order_id JOIN suppliers s ON s.id = g.supplier_id JOIN locations l ON l.id = g.location_id
          WHERE g.id = $1`, [id])).rows[0];
      if (!g) throw notFound();
      const items = (await db.query(
        `SELECT x.ingredient_id AS "ingredientId", i.name, i.sku, u.name AS "purchaseUnit", x.quantity::float8 AS quantity, x.rejected_quantity::float8 AS "rejectedQuantity",
                x.reject_reason AS "rejectReason", x.ordered_price::float8 AS "orderedPrice", x.unit_price::float8 AS "unitPrice", x.line_total::float8 AS "lineTotal",
                x.batch_no AS "batchNo", x.expiry_date::text AS "expiryDate", x.production_date::text AS "productionDate"
           FROM goods_receipt_items x JOIN ingredients i ON i.id = x.ingredient_id JOIN units u ON u.id = i.purchase_unit_id WHERE x.receipt_id = $1 ORDER BY i.name`, [id])).rows;
      return { ...g, items };
    }, { readOnly: true });
  });
}
