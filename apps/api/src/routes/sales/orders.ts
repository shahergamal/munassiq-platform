import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../../db/pool.ts";
import { postDelivery } from "../../lib/accounting/posting.ts";
import { round4, round6 } from "../../lib/costing.ts";
import { AppError, badRequest, notFound } from "../../lib/errors.ts";
import { formatMoney, parseMoney, percentToBp, riyal, vatOf } from "../../lib/money.ts";
import { likePattern, pageMeta, parsePage } from "../../lib/pagination.ts";
import { auditTenant, isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";
import { drawBatches, today } from "../restaurants/batches.ts";
import { lockLevels, movement, putIn, takeOut } from "../restaurants/inventory.ts";
import { idempotencyKey } from "../restaurants/purchases.ts";
import { EXEMPTION_REASONS, issueSalesDocument, sendToZatca, unappliedPrepayments, type DocInput } from "../restaurants/sales.ts";

// Order to cash for factory workspaces (docs/manufacturing/ARCHITECTURE.md, M3): a quotation becomes an order that
// reserves stock, delivery notes take the goods out at cost, and invoices bill what was delivered through the same
// tax-invoice engine as every other invoice (ZATCA included). Prices, tax, cost and availability: server only.

const conflict = (message: string, code = "invalid_state", details?: unknown) => new AppError(409, code, message, details);
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const lineSchema = z.object({
  itemId: z.string().uuid("اختر الصنف"),
  quantity: z.number().positive("الكمية أكبر من صفر").max(100_000_000),
  /** Omitted: the item's sale price. */
  unitPrice: z.number().min(0).max(100_000_000).optional(),
  discount: z.number().min(0).max(100_000_000).default(0),
  description: z.string().trim().max(300).nullable().optional().transform((v) => v || null),
  vatCategory: z.enum(["S", "Z", "E", "O"]).default("S"),
  exemptionCode: z.string().max(20).nullable().optional().transform((v) => v || null),
  exemptionReason: z.string().trim().max(300).nullable().optional().transform((v) => v || null),
});
const orderSchema = z.object({
  customerId: z.string().uuid("اختر العميل"),
  locationId: z.string().uuid("اختر موقع التسليم"),
  validUntil: iso.nullable().optional().transform((v) => v ?? null),
  deliveryDate: iso.nullable().optional().transform((v) => v ?? null),
  customerRef: z.string().trim().max(60).nullable().optional().transform((v) => v || null),
  notes: z.string().trim().max(1000).nullable().optional().transform((v) => v || null),
  lines: z.array(lineSchema).min(1, "أضف بنداً واحداً على الأقل").max(200),
});
type OrderBody = z.infer<typeof orderSchema>;

interface OrderRow {
  id: string; so_number: string; customer_id: string; location_id: string; status: string; total: string;
}
async function lockOrder(db: Db, id: string): Promise<OrderRow> {
  const o = (await db.query<OrderRow>("SELECT id, so_number::text, customer_id, location_id, status, total::text FROM sales_orders WHERE id = $1 FOR UPDATE", [id])).rows[0];
  if (!o) throw notFound("أمر البيع غير موجود");
  return o;
}
interface LineRow { id: string; line_no: number; item_id: string; name: string; name_en: string | null; unit: string; quantity: number; unit_price: string; discount: string; vat_category: "S" | "Z" | "E" | "O"; exemption_code: string | null; exemption_reason: string | null; delivered: number; invoiced: number }
async function linesOf(db: Db, orderId: string): Promise<LineRow[]> {
  return (await db.query<LineRow>(
    `SELECT l.id, l.line_no, l.item_id, l.description AS name, i.name_en, u.name AS unit, l.quantity::float8 AS quantity, l.unit_price::text, l.discount::text,
            l.vat_category, l.exemption_code, l.exemption_reason, l.delivered_qty::float8 AS delivered, l.invoiced_qty::float8 AS invoiced
       FROM sales_order_lines l JOIN ingredients i ON i.id = l.item_id JOIN units u ON u.id = i.base_unit_id WHERE l.order_id = $1 ORDER BY l.line_no`, [orderId])).rows;
}

/** Order totals in halalas, the way the invoice will compute them (VAT on the standard-rated net). */
function totals(lines: { quantity: number; unitPrice: number; discount: number; vatCategory: string }[], rate: number) {
  let subtotal = 0, discount = 0, standard = 0, taxable = 0;
  for (const l of lines) {
    const gross = Math.round(l.quantity * parseMoney(l.unitPrice));
    const disc = parseMoney(l.discount);
    subtotal += gross; discount += disc; taxable += gross - disc;
    if (l.vatCategory === "S") standard += gross - disc;
  }
  const vat = vatOf(standard, percentToBp(rate));
  return { subtotal, discount, taxable, vat, total: taxable + vat };
}

/**
 * What can still be promised at a location: on hand minus what confirmed orders (other than `exceptOrder`) have
 * reserved and not yet delivered.
 */
async function availability(db: Db, locationId: string, itemIds: string[], exceptOrder: string | null) {
  const rows = (await db.query<{ item_id: string; on_hand: number; reserved: number }>(
    `SELECT i.id AS item_id,
            coalesce((SELECT quantity FROM stock_levels s WHERE s.location_id = $1 AND s.ingredient_id = i.id), 0)::float8 AS on_hand,
            coalesce((SELECT sum(l.quantity - l.delivered_qty) FROM sales_order_lines l JOIN sales_orders o ON o.id = l.order_id
                       WHERE o.status = 'confirmed' AND o.location_id = $1 AND l.item_id = i.id AND ($3::uuid IS NULL OR o.id <> $3)), 0)::float8 AS reserved
       FROM ingredients i WHERE i.id = ANY($2::uuid[])`, [locationId, itemIds, exceptOrder])).rows;
  return new Map(rows.map((r) => [r.item_id, { onHand: r.on_hand, reserved: r.reserved, available: round4(r.on_hand - r.reserved) }]));
}

/** What the customer owes (receivable in the ledger) plus confirmed orders not yet invoiced. */
async function exposure(db: Db, customerId: string, exceptOrder: string | null) {
  const ar = Number((await db.query<{ v: string }>(
    `SELECT coalesce(sum(l.debit - l.credit), 0)::text AS v FROM journal_lines l JOIN accounts a ON a.id = l.account_id
      WHERE a.system_key = 'ar' AND l.partner_type = 'customer' AND l.partner_id = $1`, [customerId])).rows[0]!.v);
  const open = Number((await db.query<{ v: string }>(
    `SELECT coalesce(sum(o.total * (1 - coalesce((SELECT sum(l.invoiced_qty * l.unit_price) / nullif(sum(l.quantity * l.unit_price), 0) FROM sales_order_lines l WHERE l.order_id = o.id), 0))), 0)::text AS v
       FROM sales_orders o WHERE o.customer_id = $1 AND o.status = 'confirmed' AND ($2::uuid IS NULL OR o.id <> $2)`, [customerId, exceptOrder])).rows[0]!.v);
  // Advances received and not yet deducted already cover part of the open orders.
  const advance = Number((await db.query<{ v: string }>(
    `SELECT coalesce(sum(l.credit - l.debit), 0)::text AS v FROM journal_lines l JOIN accounts a ON a.id = l.account_id JOIN journal_entries j ON j.id = l.entry_id
       JOIN sales_documents d ON d.id = j.source_id AND j.source_type = 'sales_document'
      WHERE a.system_key = 'customer_advances' AND d.customer_id = $1`, [customerId])).rows[0]!.v);
  return { receivable: Math.round(ar * 100) / 100, openOrders: Math.round(Math.max(0, open - advance) * 100) / 100 };
}

async function writeLines(db: Db, orderId: string, b: OrderBody) {
  const ids = [...new Set(b.lines.map((l) => l.itemId))];
  // The customer's price list first, then the item's own sale price.
  const items = new Map((await db.query<{ id: string; name: string; sale_price: string | null; is_active: boolean }>(
    `SELECT i.id, i.name, coalesce(pl.price, i.sale_price)::text AS sale_price, i.is_active FROM ingredients i
       LEFT JOIN customers c ON c.id = $2 LEFT JOIN price_lists l ON l.id = c.price_list_id AND l.is_active
       LEFT JOIN price_list_items pl ON pl.list_id = l.id AND pl.item_id = i.id
      WHERE i.id = ANY($1::uuid[])`, [ids, b.customerId])).rows.map((r) => [r.id, r]));
  const rate = Number((await db.query<{ r: string }>("SELECT vat_rate_percent::text AS r FROM tenant_settings")).rows[0]?.r ?? 15);
  const lines = b.lines.map((l, i) => {
    const it = items.get(l.itemId);
    if (!it?.is_active) throw badRequest(`الصنف في البند ${i + 1} غير موجود أو موقوف`);
    const unitPrice = l.unitPrice ?? (it.sale_price !== null ? Number(it.sale_price) : NaN);
    if (!(unitPrice >= 0)) throw new AppError(422, "validation_failed", `أدخل سعر «${it.name}» (لا يوجد له سعر بيع افتراضي)`, [{ path: `lines.${i}.unitPrice`, message: "أدخل السعر" }]);
    if (l.discount > l.quantity * unitPrice) throw badRequest(`خصم البند ${i + 1} أكبر من قيمته`);
    if (l.vatCategory !== "S") {
      const r = l.exemptionCode ? EXEMPTION_REASONS[l.exemptionCode] : undefined;
      if (!r || r.cat !== l.vatCategory) throw badRequest(`اختر سبب الإعفاء أو النسبة الصفرية للبند ${i + 1}`);
      if (l.vatCategory === "O" && !l.exemptionReason) throw badRequest(`اكتب سبب كون البند ${i + 1} خارج نطاق الضريبة`);
    }
    return { ...l, unitPrice, description: l.description ?? it.name };
  });
  await db.query("DELETE FROM sales_order_lines WHERE order_id = $1", [orderId]);
  for (const [i, l] of lines.entries()) {
    await db.query(
      `INSERT INTO sales_order_lines (tenant_id, order_id, line_no, item_id, description, quantity, unit_price, discount, vat_category, exemption_code, exemption_reason)
       VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [orderId, i + 1, l.itemId, l.description, round4(l.quantity), formatMoney(parseMoney(l.unitPrice)), formatMoney(parseMoney(l.discount)), l.vatCategory, l.exemptionCode,
        l.vatCategory === "O" ? l.exemptionReason : l.exemptionCode ? EXEMPTION_REASONS[l.exemptionCode]!.ar : null]);
  }
  const t = totals(lines, rate);
  await db.query("UPDATE sales_orders SET subtotal = $2, discount = $3, taxable = $4, vat = $5, total = $6 WHERE id = $1",
    [orderId, formatMoney(t.subtotal), formatMoney(t.discount), formatMoney(t.taxable), formatMoney(t.vat), formatMoney(t.total)]);
}

async function checkRefs(db: Db, b: OrderBody) {
  if (!(await db.query("SELECT 1 FROM customers WHERE id = $1", [b.customerId])).rowCount) throw notFound("العميل غير موجود");
  if (!(await db.query("SELECT 1 FROM locations WHERE id = $1 AND is_active", [b.locationId])).rowCount) throw badRequest("موقع التسليم غير موجود أو موقوف");
}

/** Closed once everything ordered is delivered and invoiced (or short-closed by hand). */
async function settle(db: Db, orderId: string) {
  const open = (await db.query("SELECT 1 FROM sales_order_lines WHERE order_id = $1 AND (delivered_qty < quantity OR invoiced_qty < delivered_qty) LIMIT 1", [orderId])).rowCount;
  if (!open) await db.query("UPDATE sales_orders SET status = 'closed', closed_at = now() WHERE id = $1 AND status = 'confirmed'", [orderId]);
}

export default async function salesOrderRoutes(app: FastifyInstance) {
  app.get("/sales-orders", { preHandler: requireTenant("sales_orders.view") }, async (req) => {
    const q = req.query as { q?: string; status?: string; customerId?: string; page?: string; pageSize?: string };
    const page = parsePage(q);
    const search = q.q?.trim() ? likePattern(q.q) : null;
    const status = ["quotation", "confirmed", "closed", "cancelled", "open"].includes(q.status ?? "") ? q.status! : null;
    return tenantTx(req, async (db) => {
      const { rows } = await db.query(
        `SELECT o.id, o.so_number::int AS number, o.status, o.order_date::text AS "orderDate", o.valid_until::text AS "validUntil", o.delivery_date::text AS "deliveryDate",
                o.total::float8 AS total, o.customer_ref AS "customerRef", c.id AS "customerId", c.name AS "customerName",
                (SELECT coalesce(sum(l.delivered_qty) / nullif(sum(l.quantity), 0), 0) FROM sales_order_lines l WHERE l.order_id = o.id)::float8 AS "deliveredRatio",
                (SELECT coalesce(sum(l.invoiced_qty) / nullif(sum(l.quantity), 0), 0) FROM sales_order_lines l WHERE l.order_id = o.id)::float8 AS "invoicedRatio",
                (o.status = 'quotation' AND o.valid_until < (now() AT TIME ZONE 'Asia/Riyadh')::date) AS expired,
                (o.status = 'confirmed' AND o.delivery_date < (now() AT TIME ZONE 'Asia/Riyadh')::date
                  AND EXISTS (SELECT 1 FROM sales_order_lines l WHERE l.order_id = o.id AND l.delivered_qty < l.quantity)) AS late,
                count(*) OVER()::int AS "_total"
           FROM sales_orders o JOIN customers c ON c.id = o.customer_id
          WHERE ($1::text IS NULL OR c.name ILIKE $1 OR o.so_number::text = trim(both '%' from $1) OR o.customer_ref ILIKE $1)
            AND ($2::text IS NULL OR ($2 = 'open' AND o.status IN ('quotation', 'confirmed')) OR o.status = $2)
            AND ($3::uuid IS NULL OR o.customer_id = $3)
          ORDER BY CASE o.status WHEN 'confirmed' THEN 0 WHEN 'quotation' THEN 1 ELSE 2 END, o.so_number DESC LIMIT $4 OFFSET $5`,
        [search, status, isUuid(q.customerId) ? q.customerId : null, page.pageSize, page.offset]);
      const counts = (await db.query<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM sales_orders GROUP BY status")).rows;
      return { items: rows.map(({ _total, ...r }) => r), meta: pageMeta(page, rows[0]?._total ?? 0), counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) };
    }, { readOnly: true });
  });

  app.get("/sales-orders/:id", { preHandler: requireTenant("sales_orders.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const o = (await db.query(
        `SELECT o.id, o.so_number::int AS number, o.status, o.order_date::text AS "orderDate", o.valid_until::text AS "validUntil", o.delivery_date::text AS "deliveryDate",
                o.customer_ref AS "customerRef", o.notes, o.subtotal::float8 AS subtotal, o.discount::float8 AS discount, o.taxable::float8 AS taxable, o.vat::float8 AS vat,
                o.total::float8 AS total, o.created_at AS "createdAt", o.confirmed_at AS "confirmedAt", o.closed_at AS "closedAt", o.cancelled_at AS "cancelledAt",
                o.cancel_reason AS "cancelReason", o.location_id AS "locationId", l.name AS "locationName",
                c.id AS "customerId", c.name AS "customerName", c.phone AS "customerPhone", c.customer_type AS "customerType", c.vat_number AS "customerVat",
                c.other_id AS "customerOtherId", c.country_code AS "customerCountry", c.credit_limit::float8 AS "creditLimit", c.payment_terms_days AS "paymentTermsDays"
           FROM sales_orders o JOIN customers c ON c.id = o.customer_id JOIN locations l ON l.id = o.location_id WHERE o.id = $1`, [id])).rows[0];
      if (!o) throw notFound("أمر البيع غير موجود");
      const lines = await linesOf(db, id);
      const avail = await availability(db, o.locationId, lines.map((l) => l.item_id), id);
      const deliveries = (await db.query(
        `SELECT d.id, d.kind, d.delivery_number::int AS number, d.delivered_on::text AS date, d.lines, d.value::float8 AS value, d.reason, d.driver, d.created_at AS "createdAt"
           FROM deliveries d WHERE d.order_id = $1 ORDER BY d.created_at`, [id])).rows;
      const invoices = (await db.query(
        `SELECT d.id, d.kind, d.doc_number AS number, d.invoice_type AS "invoiceType", d.issue_date::text AS date, d.total::float8 AS total,
                d.prepaid_amount::float8 AS prepaid, d.is_export AS "isExport"
           FROM sales_documents d WHERE d.sales_order_id = $1
         UNION ALL
         SELECT n.id, n.kind, n.doc_number, n.invoice_type, n.issue_date::text, n.total::float8, 0, false
           FROM sales_documents n JOIN sales_documents p ON p.id = n.original_id WHERE p.sales_order_id = $1 AND p.kind = 'prepayment'
          ORDER BY 5, 3`, [id])).rows;
      const open = await unappliedPrepayments(db, id);
      // A confirmed order counts against the limit like the customer's other open orders; a quotation does not yet.
      const credit = o.creditLimit !== null ? await exposure(db, o.customerId, o.status === "confirmed" ? null : id) : null;
      return {
        ...o,
        lines: lines.map((l) => ({
          id: l.id, lineNo: l.line_no, itemId: l.item_id, description: l.name, unit: l.unit, quantity: l.quantity, unitPrice: Number(l.unit_price), discount: Number(l.discount),
          vatCategory: l.vat_category, exemptionCode: l.exemption_code, deliveredQty: l.delivered, invoicedQty: l.invoiced,
          toDeliver: round4(Math.max(0, l.quantity - l.delivered)), toInvoice: round4(Math.max(0, l.delivered - l.invoiced)),
          overInvoiced: round4(Math.max(0, l.invoiced - l.delivered)), ...avail.get(l.item_id)!,
        })),
        deliveries, invoices,
        // Advances not yet deducted by an invoice (nor refunded): the next invoice deducts them.
        unappliedPrepayments: open.map((p) => ({ id: p.id, number: p.number, remaining: (p.taxable + p.vat) / 100 })),
        credit: credit && { ...credit, limit: o.creditLimit, available: Math.round((o.creditLimit - credit.receivable - credit.openOrders) * 100) / 100 },
      };
    }, { readOnly: true });
  });

  app.post("/sales-orders", { preHandler: requireTenant("sales_orders.create") }, async (req, reply) => {
    const key = idempotencyKey(req);
    const b = orderSchema.parse(req.body);
    const out = await tenantTx(req, async (db) => {
      const dup = (await db.query<{ id: string }>("SELECT id FROM sales_orders WHERE idempotency_key = $1", [key])).rows[0];
      if (dup) return { id: dup.id, replay: true };
      await checkRefs(db, b);
      const n = (await db.query<{ n: string }>("SELECT next_counter('sales_order')::text AS n")).rows[0]!.n;
      const r = (await db.query<{ id: string }>(
        `INSERT INTO sales_orders (tenant_id, so_number, customer_id, location_id, order_date, valid_until, delivery_date, customer_ref, notes, idempotency_key, created_by)
         VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, app_user_id()) RETURNING id`,
        [n, b.customerId, b.locationId, today(), b.validUntil, b.deliveryDate, b.customerRef, b.notes, key])).rows[0]!;
      await writeLines(db, r.id, b);
      await auditTenant(db, req, "sales_order.created", "sales_order", r.id, { number: n });
      return { id: r.id, replay: false };
    });
    return reply.status(out.replay ? 200 : 201).send({ id: out.id });
  });

  app.put("/sales-orders/:id", { preHandler: requireTenant("sales_orders.create") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = orderSchema.parse(req.body);
    await tenantTx(req, async (db) => {
      const o = await lockOrder(db, id);
      if (o.status !== "quotation") throw conflict("يُعدَّل عرض السعر قبل تأكيده فقط");
      await checkRefs(db, b);
      await db.query("UPDATE sales_orders SET customer_id = $2, location_id = $3, valid_until = $4, delivery_date = $5, customer_ref = $6, notes = $7 WHERE id = $1",
        [id, b.customerId, b.locationId, b.validUntil, b.deliveryDate, b.customerRef, b.notes]);
      await writeLines(db, id, b);
      await auditTenant(db, req, "sales_order.updated", "sales_order", id);
    });
    return { ok: true };
  });

  /**
   * Confirmation turns the quotation into an order: it reserves the quantities at the delivery location (refused if
   * they are not available, unless `backorder` accepts making or buying the rest) and must fit the customer's
   * credit limit (what they owe + open orders + this one).
   */
  app.post("/sales-orders/:id/confirm", { preHandler: requireTenant("sales_orders.confirm") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ backorder: z.boolean().default(false) }).parse(req.body ?? {});
    return tenantTx(req, async (db) => {
      const o = await lockOrder(db, id);
      if (o.status !== "quotation") throw conflict("الأمر مؤكد من قبل");
      // One confirmation at a time per location, so two orders cannot reserve the same stock.
      await db.query("SELECT pg_advisory_xact_lock(hashtext('so_reserve:' || $1))", [o.location_id]);
      const cust = (await db.query<{ name: string; credit_limit: string | null }>("SELECT name, credit_limit::text FROM customers WHERE id = $1", [o.customer_id])).rows[0]!;
      if (cust.credit_limit !== null) {
        const e = await exposure(db, o.customer_id, id);
        const limit = Number(cust.credit_limit);
        const after = Math.round((e.receivable + e.openOrders + Number(o.total)) * 100) / 100;
        if (after > limit) {
          throw conflict(`يتجاوز حد ائتمان «${cust.name}» (${riyal(parseMoney(limit))}): المستحق ${riyal(parseMoney(Math.max(0, e.receivable)))} والأوامر المفتوحة ${riyal(parseMoney(e.openOrders))} وهذا الأمر ${riyal(parseMoney(Number(o.total)))}`,
            "credit_limit_exceeded", { limit, receivable: e.receivable, openOrders: e.openOrders, order: Number(o.total) });
        }
      }
      const lines = await linesOf(db, id);
      const need = new Map<string, number>();
      for (const l of lines) need.set(l.item_id, (need.get(l.item_id) ?? 0) + l.quantity);
      const avail = await availability(db, o.location_id, [...need.keys()], id);
      const short = [...need].filter(([item, q]) => q > (avail.get(item)?.available ?? 0) + 1e-9)
        .map(([item, q]) => ({ itemId: item, name: lines.find((l) => l.item_id === item)!.name, required: q, available: Math.max(0, avail.get(item)?.available ?? 0) }));
      if (short.length && !b.backorder) {
        throw conflict(`الكمية المتاحة لا تكفي: ${short.map((s) => `«${s.name}» متاح ${round4(s.available)} من ${round4(s.required)}`).join("، ")}. أكّد مع الانتظار لإنتاج الباقي أو شرائه`, "insufficient_availability", { short });
      }
      await db.query("UPDATE sales_orders SET status = 'confirmed', confirmed_at = now(), confirmed_by = app_user_id() WHERE id = $1", [id]);
      await auditTenant(db, req, "sales_order.confirmed", "sales_order", id, { backorder: short });
      return { ok: true, backorder: short };
    });
  });

  /**
   * A delivery note: goods leave the order's location at their average cost, earliest expiry first (an expired batch
   * is never delivered), and cost of sales is posted. Default: everything still to deliver.
   */
  app.post("/sales-orders/:id/deliver", { preHandler: requireTenant("sales_orders.deliver") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const key = idempotencyKey(req);
    const b = z.object({
      lines: z.array(z.object({ lineId: z.string().uuid(), quantity: z.number().min(0).max(100_000_000) })).max(200).optional(),
      driver: z.string().trim().max(120).nullable().optional().transform((v) => v || null),
    }).parse(req.body ?? {});
    const out = await tenantTx(req, async (db) => {
      const dup = (await db.query<{ id: string }>("SELECT id FROM deliveries WHERE idempotency_key = $1", [key])).rows[0];
      if (dup) return { id: dup.id, replay: true };
      const o = await lockOrder(db, id);
      if (o.status !== "confirmed") throw conflict(o.status === "quotation" ? "أكّد أمر البيع أولاً" : "أمر البيع مقفل أو ملغى");
      const lines = await linesOf(db, id);
      const pick = (b.lines ?? lines.map((l) => ({ lineId: l.id, quantity: round4(l.quantity - l.delivered) })))
        .filter((x) => x.quantity > 0).map((x) => {
          const l = lines.find((y) => y.id === x.lineId);
          if (!l) throw badRequest("بند ليس في هذا الأمر");
          if (x.quantity > l.quantity - l.delivered + 1e-9) throw badRequest(`لا يُسلَّم من «${l.name}» أكثر من المتبقي (${round4(l.quantity - l.delivered)})`);
          return { line: l, quantity: round4(x.quantity) };
        });
      if (!pick.length) throw conflict("لا يوجد ما يُسلَّم في هذا الأمر");
      const items = [...new Set(pick.map((p) => p.line.item_id))];
      await lockLevels(db, o.location_id, items);
      const todayIso = today();
      const detail: { lineId: string; itemId: string; quantity: number; unitCost: number; value: number; batches: { batchId: string; batchNo: string; expiryDate: string | null; quantity: number }[] }[] = [];
      for (const p of pick) {
        const drawn = await drawBatches(db, o.location_id, p.line.item_id, p.quantity);
        const expired = drawn.find((d) => d.expiryDate && d.expiryDate < todayIso);
        if (expired) throw conflict(`في «${p.line.name}» تشغيلة منتهية الصلاحية (${expired.batchNo}، ${expired.expiryDate}) لم تُتلف بعد. أتلفها من «الصلاحية والدفعات» ثم سلّم`, "expired_stock");
        const [taken] = await takeOut(db, o.location_id, [{ ingredientId: p.line.item_id, quantity: p.quantity }]);
        detail.push({ lineId: p.line.id, itemId: p.line.item_id, quantity: p.quantity, unitCost: round6(taken!.unitCost), value: Math.round(p.quantity * taken!.unitCost * 100) / 100,
          batches: drawn.map((d) => ({ batchId: d.batchId, batchNo: d.batchNo, expiryDate: d.expiryDate, quantity: d.quantity })) });
        await db.query("UPDATE sales_order_lines SET delivered_qty = delivered_qty + $2 WHERE id = $1", [p.line.id, p.quantity]);
      }
      const value = detail.reduce((a, d) => a + Math.round(d.value * 100), 0);
      const n = (await db.query<{ n: string }>("SELECT next_counter('delivery')::text AS n")).rows[0]!.n;
      const d = (await db.query<{ id: string }>(
        `INSERT INTO deliveries (tenant_id, delivery_number, kind, order_id, location_id, delivered_on, lines, value, driver, idempotency_key, created_by)
         VALUES (app_tenant_id(), $1, 'delivery', $2, $3, $4, $5, $6, $7, $8, app_user_id()) RETURNING id`,
        [n, id, o.location_id, todayIso, JSON.stringify(detail), formatMoney(value), b.driver, key])).rows[0]!;
      for (const x of detail) {
        await movement(db, { locationId: o.location_id, ingredientId: x.itemId, type: "delivery", quantity: -x.quantity, unitCost: x.unitCost, refType: "delivery", refId: d.id });
      }
      await postDelivery(db, d.id);
      await settle(db, id);
      await auditTenant(db, req, "sales_order.delivered", "delivery", d.id, { order: o.so_number, value: value / 100 });
      return { id: d.id, replay: false };
    });
    return reply.status(out.replay ? 200 : 201).send({ id: out.id });
  });

  // A customer return of delivered goods: back into stock at what they cost when delivered; cost of sales reversed.
  app.post("/sales-orders/:id/returns", { preHandler: requireTenant("sales_orders.deliver") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const key = idempotencyKey(req);
    const b = z.object({
      lines: z.array(z.object({ lineId: z.string().uuid(), quantity: z.number().min(0).max(100_000_000) })).min(1).max(200),
      reason: z.string().trim().min(3, "اذكر سبب المرتجع").max(300),
    }).parse(req.body);
    const out = await tenantTx(req, async (db) => {
      const dup = (await db.query<{ id: string }>("SELECT id FROM deliveries WHERE idempotency_key = $1", [key])).rows[0];
      if (dup) return { id: dup.id, replay: true };
      const o = await lockOrder(db, id);
      if (o.status === "quotation" || o.status === "cancelled") throw conflict("لا تسليمات على هذا الأمر");
      const lines = await linesOf(db, id);
      // Net delivered quantity and value per line, from the delivery notes (deliveries minus earlier returns).
      const net = new Map<string, { q: number; v: number }>();
      for (const d of (await db.query<{ kind: string; lines: { lineId: string; quantity: number; value: number }[] }>("SELECT kind, lines FROM deliveries WHERE order_id = $1", [id])).rows) {
        for (const x of d.lines) {
          const s = d.kind === "delivery" ? 1 : -1;
          const cur = net.get(x.lineId) ?? { q: 0, v: 0 };
          net.set(x.lineId, { q: cur.q + s * x.quantity, v: cur.v + s * x.value });
        }
      }
      const detail = b.lines.filter((x) => x.quantity > 0).map((x) => {
        const l = lines.find((y) => y.id === x.lineId);
        const got = net.get(x.lineId);
        if (!l || !got || x.quantity > got.q + 1e-9) throw badRequest("لا يُرجع أكثر مما سُلّم");
        const unitCost = got.q > 0 ? round6(got.v / got.q) : 0;
        const value = Math.abs(x.quantity - got.q) < 1e-9 ? Math.round(got.v * 100) / 100 : Math.round(x.quantity * unitCost * 100) / 100;
        return { lineId: l.id, itemId: l.item_id, quantity: round4(x.quantity), unitCost, value, batches: [] };
      });
      if (!detail.length) throw badRequest("أدخل كمية المرتجع");
      const value = detail.reduce((a, d) => a + Math.round(d.value * 100), 0);
      const n = (await db.query<{ n: string }>("SELECT next_counter('customer_return')::text AS n")).rows[0]!.n;
      const d = (await db.query<{ id: string }>(
        `INSERT INTO deliveries (tenant_id, delivery_number, kind, order_id, location_id, delivered_on, lines, value, reason, idempotency_key, created_by)
         VALUES (app_tenant_id(), $1, 'return', $2, $3, $4, $5, $6, $7, $8, app_user_id()) RETURNING id`,
        [n, id, o.location_id, today(), JSON.stringify(detail), formatMoney(value), b.reason, key])).rows[0]!;
      await putIn(db, o.location_id, detail.map((x) => ({ ingredientId: x.itemId, quantity: x.quantity, unitCost: x.unitCost })));
      for (const x of detail) {
        await movement(db, { locationId: o.location_id, ingredientId: x.itemId, type: "customer_return", quantity: x.quantity, unitCost: x.unitCost, refType: "delivery", refId: d.id });
        await db.query("UPDATE sales_order_lines SET delivered_qty = delivered_qty - $2 WHERE id = $1", [x.lineId, x.quantity]);
      }
      // A closed order with goods back is open again for redelivery (or a credit note).
      if (o.status === "closed") await db.query("UPDATE sales_orders SET status = 'confirmed', closed_at = NULL WHERE id = $1", [id]);
      await postDelivery(db, d.id);
      await auditTenant(db, req, "sales_order.returned", "delivery", d.id, { order: o.so_number, value: value / 100, reason: b.reason });
      return { id: d.id, replay: false };
    });
    return reply.status(out.replay ? 200 : 201).send({ id: out.id });
  });

  /**
   * The tax invoice for what was delivered and not yet invoiced (or the listed quantities): a standard invoice for a
   * business buyer, simplified otherwise. Issued by the same engine as every invoice, so ZATCA stamping, clearance
   * and posting are identical.
   */
  app.post("/sales-orders/:id/invoice", { preHandler: requireTenant("sales_orders.invoice") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const key = idempotencyKey(req);
    const b = z.object({
      invoiceType: z.enum(["standard", "simplified"]).optional(),
      paymentMeans: z.enum(["cash", "card", "bank_transfer", "credit"]).default("credit"),
      lines: z.array(z.object({ lineId: z.string().uuid(), quantity: z.number().positive().max(100_000_000) })).max(200).optional(),
      notes: z.string().trim().max(1000).nullable().optional().transform((v) => v || null),
      isExport: z.boolean().default(false),
    }).parse(req.body ?? {});
    let invoiceType = "standard";
    const out = await tenantTx(req, async (db) => {
      const dup = (await db.query<{ id: string; doc_number: string }>("SELECT id, doc_number FROM sales_documents WHERE idempotency_key = $1", [key])).rows[0];
      if (dup) return { id: dup.id, number: dup.doc_number, replay: true };
      const o = await lockOrder(db, id);
      if (o.status === "quotation" || o.status === "cancelled") throw conflict("تُصدر الفاتورة لأمر مؤكد");
      const cust = (await db.query<{ customer_type: string; vat_number: string | null; other_id: string | null }>("SELECT customer_type, vat_number, other_id FROM customers WHERE id = $1", [o.customer_id])).rows[0]!;
      invoiceType = b.invoiceType ?? (cust.customer_type === "business" || cust.vat_number || cust.other_id ? "standard" : "simplified");
      const lines = await linesOf(db, id);
      const pick = (b.lines ?? lines.map((l) => ({ lineId: l.id, quantity: round4(l.delivered - l.invoiced) }))).filter((x) => x.quantity > 0).map((x) => {
        const l = lines.find((y) => y.id === x.lineId);
        if (!l) throw badRequest("بند ليس في هذا الأمر");
        if (x.quantity > l.delivered - l.invoiced + 1e-9) throw badRequest(`لا يُفوتر من «${l.name}» أكثر مما سُلّم ولم يُفوتر (${round4(Math.max(0, l.delivered - l.invoiced))})`);
        return { line: l, quantity: round4(x.quantity) };
      });
      if (!pick.length) throw conflict("لا توجد كميات مسلّمة لم تُفوتر بعد. سلّم أولاً");
      const doc: DocInput = {
        kind: "invoice", invoiceType: invoiceType as "standard" | "simplified", customerId: o.customer_id, originalId: null, reason: null, supplyDate: null,
        paymentMeans: b.paymentMeans, notes: b.notes ?? `أمر البيع رقم ${o.so_number}`, salesOrderId: id, applyPrepayments: true, isExport: b.isExport,
        branchId: (await db.query<{ b: string | null }>("SELECT branch_id AS b FROM locations WHERE id = $1", [o.location_id])).rows[0]?.b ?? null,
        lines: pick.map(({ line, quantity }) => ({
          description: line.name_en ? `${line.name} / ${line.name_en}` : line.name, quantity, unitPrice: Number(line.unit_price),
          // The line discount follows the invoiced share of the ordered quantity.
          discount: Math.round((Number(line.discount) * quantity / line.quantity) * 100) / 100,
          vatCategory: line.vat_category, exemptionCode: line.exemption_code, exemptionReason: line.vat_category === "O" ? line.exemption_reason : null, accountId: null, itemId: line.item_id,
        })),
      } as DocInput;
      const r = await issueSalesDocument(db, doc, key, req);
      for (const p of pick) await db.query("UPDATE sales_order_lines SET invoiced_qty = invoiced_qty + $2 WHERE id = $1", [p.line.id, p.quantity]);
      await settle(db, id);
      await auditTenant(db, req, "sales_order.invoiced", "sales_document", r.id, { order: o.so_number });
      return r;
    });
    const zatca = await sendToZatca(req, invoiceType, out);
    return reply.status(out.replay ? 200 : 201).send({ id: out.id, number: out.number, prepaid: out.prepaid ?? 0, zatca });
  });

  /**
   * An advance on a confirmed order: a prepayment invoice (386) for the amount received, VAT included. VAT is due
   * on receipt; the amount sits in customer advances until the order's invoice deducts it.
   */
  app.post("/sales-orders/:id/prepayments", { preHandler: requireTenant("sales_orders.invoice") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const key = idempotencyKey(req);
    const b = z.object({
      amount: z.number().positive("المبلغ أكبر من صفر").max(100_000_000),
      paymentMeans: z.enum(["cash", "card", "bank_transfer"]),
      notes: z.string().trim().max(1000).nullable().optional().transform((v) => v || null),
    }).parse(req.body);
    let invoiceType = "standard";
    const out = await tenantTx(req, async (db) => {
      const dup = (await db.query<{ id: string; doc_number: string }>("SELECT id, doc_number FROM sales_documents WHERE idempotency_key = $1", [key])).rows[0];
      if (dup) return { id: dup.id, number: dup.doc_number, replay: true };
      const o = await lockOrder(db, id);
      if (o.status !== "confirmed") throw conflict("الدفعة المقدمة على أمر مؤكد");
      await db.query("SELECT pg_advisory_xact_lock(hashtext('so_prepayment:' || $1))", [id]);
      const cust = (await db.query<{ customer_type: string; vat_number: string | null; other_id: string | null }>("SELECT customer_type, vat_number, other_id FROM customers WHERE id = $1", [o.customer_id])).rows[0]!;
      invoiceType = cust.customer_type === "business" || cust.vat_number || cust.other_id ? "standard" : "simplified";
      // Advances never exceed what is still to be invoiced on the order.
      const rate = Number((await db.query<{ r: string }>("SELECT vat_rate_percent::text AS r FROM tenant_settings")).rows[0]?.r ?? 15);
      const gross = parseMoney(b.amount);
      const net = Math.round(gross * 10000 / (10000 + percentToBp(rate)));
      const invoiced = parseMoney((await db.query<{ v: string }>("SELECT coalesce(sum(total - prepaid_amount), 0)::text AS v FROM sales_documents WHERE sales_order_id = $1 AND kind = 'invoice'", [id])).rows[0]!.v);
      const open = (await unappliedPrepayments(db, id)).reduce((a, p) => a + p.taxable + p.vat, 0);
      const left = parseMoney(o.total) - invoiced - open;
      if (gross > left) throw conflict(`الدفعة أكبر من المتبقي على الأمر بعد الفواتير والدفعات السابقة (${riyal(Math.max(0, left))})`, "prepayment_exceeds_order");
      const doc: DocInput = {
        kind: "prepayment", invoiceType: invoiceType as "standard" | "simplified", customerId: o.customer_id, originalId: null, reason: null, supplyDate: null,
        branchId: (await db.query<{ b: string | null }>("SELECT branch_id AS b FROM locations WHERE id = $1", [o.location_id])).rows[0]?.b ?? null,
        paymentMeans: b.paymentMeans, notes: b.notes ?? `دفعة مقدمة على أمر البيع رقم ${o.so_number}`, salesOrderId: id,
        lines: [{ description: `دفعة مقدمة على أمر البيع SO-${o.so_number} / Advance payment`, quantity: 1, unitPrice: net / 100, discount: 0, vatCategory: "S",
          exemptionCode: null, exemptionReason: null, accountId: null }],
      };
      const r = await issueSalesDocument(db, doc, key, req);
      await auditTenant(db, req, "sales_order.prepayment", "sales_document", r.id, { order: o.so_number, amount: b.amount });
      return r;
    });
    const zatca = await sendToZatca(req, invoiceType, out);
    return reply.status(out.replay ? 200 : 201).send({ id: out.id, number: out.number, zatca });
  });

  // Refunding (part of) an advance nothing has deducted: a credit note on the prepayment, paid back to the customer.
  app.post("/sales-orders/:id/prepayments/:docId/refund", { preHandler: requireTenant("sales_orders.invoice") }, async (req, reply) => {
    const { id, docId } = req.params as { id: string; docId: string };
    if (!isUuid(id) || !isUuid(docId)) throw notFound();
    const key = idempotencyKey(req);
    const b = z.object({
      amount: z.number().positive("المبلغ أكبر من صفر").max(100_000_000),
      paymentMeans: z.enum(["cash", "card", "bank_transfer"]),
      reason: z.string().trim().min(3, "اذكر سبب الاسترداد").max(300),
    }).parse(req.body);
    let invoiceType = "standard";
    const out = await tenantTx(req, async (db) => {
      const dup = (await db.query<{ id: string; doc_number: string }>("SELECT id, doc_number FROM sales_documents WHERE idempotency_key = $1", [key])).rows[0];
      if (dup) return { id: dup.id, number: dup.doc_number, replay: true };
      await lockOrder(db, id);
      await db.query("SELECT pg_advisory_xact_lock(hashtext('so_prepayment:' || $1))", [id]);
      const p = (await unappliedPrepayments(db, id)).find((x) => x.id === docId);
      if (!p) throw conflict("لا متبقٍ من هذه الدفعة: خُصمت في فاتورة أو استُردّت");
      const gross = parseMoney(b.amount);
      if (gross > p.taxable + p.vat) throw conflict(`المبلغ أكبر من المتبقي من الدفعة (${riyal(p.taxable + p.vat)})`);
      const d = (await db.query<{ invoice_type: string; customer_id: string }>("SELECT invoice_type, customer_id FROM sales_documents WHERE id = $1", [docId])).rows[0]!;
      invoiceType = d.invoice_type;
      const net = gross === p.taxable + p.vat ? p.taxable : Math.round(gross * 10000 / (10000 + percentToBp(p.rate)));
      const doc: DocInput = {
        kind: "credit_note", invoiceType: d.invoice_type as "standard" | "simplified", customerId: d.customer_id, originalId: docId, reason: b.reason, supplyDate: null,
        branchId: null, paymentMeans: b.paymentMeans, notes: null,
        lines: [{ description: `استرداد من الدفعة المقدمة ${p.number} / Advance refund`, quantity: 1, unitPrice: net / 100, discount: 0, vatCategory: "S",
          exemptionCode: null, exemptionReason: null, accountId: null }],
      };
      const r = await issueSalesDocument(db, doc, key, req);
      await auditTenant(db, req, "sales_order.prepayment_refunded", "sales_document", r.id, { prepayment: p.number, amount: b.amount });
      return r;
    });
    const zatca = await sendToZatca(req, invoiceType, out);
    return reply.status(out.replay ? 200 : 201).send({ id: out.id, number: out.number, zatca });
  });

  // Cancel: a quotation, or an order nothing was delivered on. Close: stop an order short (the rest is released).
  app.post("/sales-orders/:id/cancel", { preHandler: requireTenant("sales_orders.cancel") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ reason: z.string().trim().min(3, "اذكر السبب").max(300) }).parse(req.body);
    await tenantTx(req, async (db) => {
      const o = await lockOrder(db, id);
      if (o.status !== "quotation" && o.status !== "confirmed") throw conflict("الأمر مقفل أو ملغى");
      if ((await db.query("SELECT 1 FROM deliveries WHERE order_id = $1 LIMIT 1", [id])).rowCount) throw conflict("سُلّم جزء من الأمر: أقفله بدلاً من إلغائه");
      if ((await unappliedPrepayments(db, id)).length) throw conflict("على الأمر دفعة مقدمة: استردّها أولاً (إشعار دائن على الدفعة)", "prepayment_open");
      await db.query("UPDATE sales_orders SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2 WHERE id = $1", [id, b.reason]);
      await auditTenant(db, req, "sales_order.cancelled", "sales_order", id, { reason: b.reason });
    });
    return { ok: true };
  });

  app.post("/sales-orders/:id/close", { preHandler: requireTenant("sales_orders.cancel") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ reason: z.string().trim().min(3, "اذكر السبب").max(300) }).parse(req.body);
    await tenantTx(req, async (db) => {
      const o = await lockOrder(db, id);
      if (o.status !== "confirmed") throw conflict("يُقفل أمر مؤكد فقط");
      if ((await db.query("SELECT 1 FROM sales_order_lines WHERE order_id = $1 AND invoiced_qty < delivered_qty LIMIT 1", [id])).rowCount) {
        throw conflict("في الأمر كميات سُلّمت ولم تُفوتر: أصدر فاتورتها أولاً");
      }
      if ((await unappliedPrepayments(db, id)).length) throw conflict("على الأمر دفعة مقدمة لم تُخصم: استردّ المتبقي منها أولاً", "prepayment_open");
      await db.query("UPDATE sales_orders SET status = 'closed', closed_at = now(), cancel_reason = $2 WHERE id = $1", [id, b.reason]);
      await auditTenant(db, req, "sales_order.closed", "sales_order", id, { reason: b.reason });
    });
    return { ok: true };
  });

  // Price and availability of items for the order form (server prices; what the location can still promise).
  app.get("/sales-orders/availability", { preHandler: requireTenant("sales_orders.create", "sales_orders.view") }, async (req) => {
    const q = req.query as { locationId?: string; itemIds?: string; customerId?: string };
    if (!isUuid(q.locationId)) throw badRequest("اختر الموقع");
    const ids = (q.itemIds ?? "").split(",").filter(isUuid).slice(0, 200);
    return tenantTx(req, async (db) => {
      const a = await availability(db, q.locationId!, ids, null);
      const prices = new Map((await db.query<{ id: string; p: number | null }>(
        `SELECT i.id, coalesce(pl.price, i.sale_price)::float8 AS p FROM ingredients i
           LEFT JOIN customers c ON c.id = $2 LEFT JOIN price_lists l ON l.id = c.price_list_id AND l.is_active
           LEFT JOIN price_list_items pl ON pl.list_id = l.id AND pl.item_id = i.id WHERE i.id = ANY($1::uuid[])`,
        [ids, isUuid(q.customerId) ? q.customerId : null])).rows.map((r) => [r.id, r.p]));
      return { items: ids.map((i) => ({ itemId: i, salePrice: prices.get(i) ?? null, ...(a.get(i) ?? { onHand: 0, reserved: 0, available: 0 }) })) };
    }, { readOnly: true });
  });
}
