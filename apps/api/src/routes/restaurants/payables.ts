import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError, badRequest, forbidden, notFound } from "../../lib/errors.ts";
import { formatMoney, parseMoney, percentToBp, vatOf } from "../../lib/money.ts";
import { pageMeta, parsePage, sortSql } from "../../lib/pagination.ts";
import { auditTenant, isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";
import { dateRange, movement, takeOut } from "./inventory.ts";
import { idempotencyKey } from "./purchases.ts";
import { postExpense, postExpensePayment, postPurchaseReturn, postSupplierPayment } from "../../lib/accounting/posting.ts";

const TZ = "Asia/Riyadh";
const payMethod = z.enum(["bank_transfer", "cash", "cheque", "card"]);

// Supplier ledger: goods receipt notes increase what we owe; returns and payments decrease it.
// Amounts are what the supplier invoices: VAT included (grand_total, total_value + vat_amount).
const LEDGER = `
  SELECT supplier_id, received_on AS d, 'purchase'::text AS kind, id AS ref_id, grn_number AS ref_number, grand_total AS debit, 0::numeric AS credit, supplier_invoice AS note
    FROM goods_receipts WHERE grand_total > 0
  UNION ALL
  SELECT supplier_id, (created_at AT TIME ZONE '${TZ}')::date, 'return', id, return_number, 0, total_value + vat_amount, reason FROM purchase_returns
  UNION ALL
  SELECT supplier_id, paid_on, 'payment', id, payment_number, 0, amount, reference FROM supplier_payments`;

const RETURN_SORT = ["number", "createdAt", "supplierName", "poNumber", "summary", "reason", "totalValue", "vatAmount"];
const PAYABLE_SORT = ["name", "paymentTermsDays", "purchases", "returns", "payments", "balance", "lastPaymentOn"];
const EXPENSE_SORT = ["number", "expenseDate", "categoryName", "description", "amountNet", "vatAmount", "total", "status"];

export default async function payablesRoutes(app: FastifyInstance) {
  // ── Purchase returns ────────────────────────────────────────────────────────────────────────
  app.get("/purchase-returns", { preHandler: requireTenant("purchase_returns.view") }, async (req) => {
    const q = req.query as { page?: string; pageSize?: string; sort?: string };
    const page = parsePage(q);
    return tenantTx(req, async (db) => {
      const { rows } = await db.query(
        `SELECT r.id, r.return_number AS "number", r.reason, r.total_value::float8 AS "totalValue", r.vat_amount::float8 AS "vatAmount", r.created_at AS "createdAt",
                s.name AS "supplierName", l.name AS "locationName", po.po_number AS "poNumber",
                (SELECT string_agg(i.name, '، ' ORDER BY i.name) FROM purchase_return_items x JOIN ingredients i ON i.id = x.ingredient_id WHERE x.return_id = r.id) AS summary,
                count(*) OVER()::int AS "_total"
           FROM purchase_returns r JOIN suppliers s ON s.id = r.supplier_id JOIN locations l ON l.id = r.location_id
           LEFT JOIN purchase_orders po ON po.id = r.purchase_order_id
          ORDER BY ${sortSql(q.sort, RETURN_SORT)}r.created_at DESC LIMIT $1 OFFSET $2`, [page.pageSize, page.offset]);
      return { items: rows.map(({ _total, ...r }) => r), meta: pageMeta(page, rows[0]?._total ?? 0) };
    }, { readOnly: true });
  });

  /** Goods go back to the supplier: stock leaves at its weighted-average cost, and that value is credited to the supplier. */
  app.post("/purchase-returns", { preHandler: requireTenant("purchase_returns.create") }, async (req, reply) => {
    const key = idempotencyKey(req);
    const body = z.object({
      supplierId: z.string().uuid(), locationId: z.string().uuid(),
      purchaseOrderId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
      reason: z.string().trim().min(3, "اكتب سبب الإرجاع").max(300),
      items: z.array(z.object({ ingredientId: z.string().uuid(), quantity: z.number().positive().max(1_000_000_000) })).min(1, "أضف مادة واحدة على الأقل").max(200)
        .refine((ls) => new Set(ls.map((l) => l.ingredientId)).size === ls.length, "لا يمكن تكرار نفس المادة"),
    }).parse(req.body);
    const out = await tenantTx(req, async (db) => {
      const dup = (await db.query<{ id: string; total_value: string; vat_amount: string }>("SELECT id, total_value::text, vat_amount::text FROM purchase_returns WHERE idempotency_key = $1", [key])).rows[0];
      if (dup) return { id: dup.id, totalValue: Number(dup.total_value), vatAmount: Number(dup.vat_amount), replay: true };
      // The VAT reversed follows the original invoice when there is one, otherwise whether the supplier is VAT-registered.
      let vatRate = (await db.query<{ rate: number }>(
        `SELECT CASE WHEN s.tax_id IS NOT NULL AND btrim(s.tax_id) <> '' THEN st.vat_rate_percent ELSE 0 END::float8 AS rate
           FROM tenant_settings st, suppliers s WHERE s.id = $1`, [body.supplierId])).rows[0]?.rate ?? 0;
      if (body.purchaseOrderId) {
        const po = (await db.query<{ supplier_id: string; status: string; vat_rate: number }>("SELECT supplier_id, status, vat_rate::float8 AS vat_rate FROM purchase_orders WHERE id = $1", [body.purchaseOrderId])).rows[0];
        if (!po) throw notFound("أمر الشراء غير موجود");
        if (po.supplier_id !== body.supplierId) throw new AppError(422, "validation_failed", "أمر الشراء يخص مورداً آخر");
        if (!["received", "partially_received", "closed"].includes(po.status)) throw new AppError(409, "invalid_state", "يمكن الإرجاع على أمر شراء مستلم فقط");
        vatRate = po.vat_rate;
      }
      const taken = await takeOut(db, body.locationId, body.items);
      const total = parseMoney(taken.reduce((a, t) => a + t.quantity * t.unitCost, 0));
      const vat = vatOf(total, percentToBp(vatRate));
      const n = (await db.query<{ n: string }>("SELECT next_counter('purchase_return')::text AS n")).rows[0] as { n: string };
      const r = (await db.query<{ id: string }>(
        `INSERT INTO purchase_returns (tenant_id, return_number, supplier_id, location_id, purchase_order_id, reason, total_value, vat_amount, idempotency_key, created_by)
         VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, app_user_id()) RETURNING id`,
        [n.n, body.supplierId, body.locationId, body.purchaseOrderId, body.reason, formatMoney(total), formatMoney(vat), key])).rows[0] as { id: string };
      for (const t of taken) {
        await db.query("INSERT INTO purchase_return_items (tenant_id, return_id, ingredient_id, quantity, unit_cost) VALUES (app_tenant_id(), $1, $2, $3, $4)", [r.id, t.ingredientId, t.quantity, t.unitCost]);
        await movement(db, { locationId: body.locationId, ingredientId: t.ingredientId, type: "purchase_return", quantity: -t.quantity, unitCost: t.unitCost, refType: "purchase_return", refId: r.id });
      }
      await postPurchaseReturn(db, r.id);
      await auditTenant(db, req, "purchase_return.created", "purchase_return", r.id, { total: formatMoney(total), vat: formatMoney(vat) });
      return { id: r.id, totalValue: total / 100, vatAmount: vat / 100, replay: false };
    });
    return reply.status(out.replay ? 200 : 201).send({ id: out.id, totalValue: out.totalValue, vatAmount: out.vatAmount });
  });

  // ── Payables ────────────────────────────────────────────────────────────────────────────────
  app.get("/payables", { preHandler: requireTenant("payables.view") }, async (req) => {
    const q = req.query as { page?: string; pageSize?: string; onlyOpen?: string; sort?: string };
    const page = parsePage(q);
    return tenantTx(req, async (db) => {
      const { rows } = await db.query(
        `WITH l AS (${LEDGER})
         SELECT s.id AS "supplierId", s.name, s.payment_terms_days AS "paymentTermsDays",
                coalesce(sum(l.debit) FILTER (WHERE l.kind = 'purchase'), 0)::float8 AS purchases,
                coalesce(sum(l.credit) FILTER (WHERE l.kind = 'return'), 0)::float8 AS returns,
                coalesce(sum(l.credit) FILTER (WHERE l.kind = 'payment'), 0)::float8 AS payments,
                (coalesce(sum(l.debit), 0) - coalesce(sum(l.credit), 0))::float8 AS balance,
                max(l.d) FILTER (WHERE l.kind = 'payment') AS "lastPaymentOn",
                count(*) OVER()::int AS "_total"
           FROM suppliers s JOIN l ON l.supplier_id = s.id
          GROUP BY s.id, s.name, s.payment_terms_days
         HAVING ($1::boolean IS NOT TRUE OR coalesce(sum(l.debit), 0) - coalesce(sum(l.credit), 0) <> 0)
          ORDER BY ${sortSql(q.sort, PAYABLE_SORT)}balance DESC, s.name LIMIT $2 OFFSET $3`, [q.onlyOpen === "true", page.pageSize, page.offset]);
      const totals = (await db.query<{ owed: number }>(`WITH l AS (${LEDGER}) SELECT (coalesce(sum(debit), 0) - coalesce(sum(credit), 0))::float8 AS owed FROM l`)).rows[0];
      return { items: rows.map(({ _total, ...r }) => r), meta: pageMeta(page, rows[0]?._total ?? 0), totalOwed: totals?.owed ?? 0 };
    }, { readOnly: true });
  });

  app.get("/suppliers/:id/statement", { preHandler: requireTenant("payables.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const { from, to } = dateRange(req.query as { from?: string; to?: string });
    return tenantTx(req, async (db) => {
      const s = (await db.query<{ name: string }>("SELECT name FROM suppliers WHERE id = $1", [id])).rows[0];
      if (!s) throw notFound();
      const opening = (await db.query<{ b: number }>(
        `WITH l AS (${LEDGER}) SELECT (coalesce(sum(debit), 0) - coalesce(sum(credit), 0))::float8 AS b FROM l WHERE supplier_id = $1 AND d < $2::date`, [id, from])).rows[0]?.b ?? 0;
      const lines = (await db.query<{ d: string; kind: string; refId: string; refNumber: number; debit: number; credit: number; note: string | null }>(
        `WITH l AS (${LEDGER})
         SELECT d::text AS d, kind, ref_id AS "refId", ref_number AS "refNumber", debit::float8 AS debit, credit::float8 AS credit, note
           FROM l WHERE supplier_id = $1 AND d BETWEEN $2::date AND $3::date ORDER BY d, kind DESC, ref_number`, [id, from, to])).rows;
      // Signed: a supplier can be overpaid (negative balance), which parseMoney would reject.
      const cents = (v: number) => Math.round(v * 100);
      let running = cents(opening);
      const withBalance = lines.map((l) => { running += cents(l.debit) - cents(l.credit); return { ...l, balance: running / 100 }; });
      return { supplier: { id, name: s.name }, from, to, openingBalance: opening, closingBalance: running / 100, lines: withBalance };
    }, { readOnly: true });
  });

  app.get("/supplier-payments", { preHandler: requireTenant("payables.view") }, async (req) => {
    const q = req.query as { supplierId?: string; page?: string; pageSize?: string };
    const page = parsePage(q);
    return tenantTx(req, async (db) => {
      const { rows } = await db.query(
        `SELECT p.id, p.payment_number AS "number", p.paid_on::text AS "paidOn", p.amount::float8 AS amount, p.method, p.reference, p.notes,
                p.withholding_code AS "withholdingCode", p.withholding_rate::float8 AS "withholdingRate", p.withholding_amount::float8 AS "withholdingAmount",
                s.name AS "supplierName", count(*) OVER()::int AS "_total"
           FROM supplier_payments p JOIN suppliers s ON s.id = p.supplier_id
          WHERE ($1::uuid IS NULL OR p.supplier_id = $1) ORDER BY p.paid_on DESC, p.payment_number DESC LIMIT $2 OFFSET $3`,
        [isUuid(q.supplierId) ? q.supplierId : null, page.pageSize, page.offset]);
      return { items: rows.map(({ _total, ...r }) => r), meta: pageMeta(page, rows[0]?._total ?? 0) };
    }, { readOnly: true });
  });

  app.post("/supplier-payments", { preHandler: requireTenant("payables.pay") }, async (req, reply) => {
    const key = idempotencyKey(req);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
    const body = z.object({
      supplierId: z.string().uuid(),
      paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => d <= today, "لا يمكن تسجيل دفعة بتاريخ مستقبلي"),
      amount: z.number().positive().max(100_000_000),
      method: payMethod,
      reference: z.string().trim().max(80).nullable().optional().transform((v) => v || null),
      notes: z.string().trim().max(500).nullable().optional().transform((v) => v || null),
      /**
       * A non-resident supplier: the payment type (a withholding_rates code), or "none" for what is not subject to
       * withholding (goods bought and shipped from abroad). Ignored for resident suppliers.
       */
      withholdingCode: z.string().regex(/^[a-z_]{2,40}$/).optional(),
    }).parse(req.body);
    const out = await tenantTx(req, async (db) => {
      const dup = (await db.query<{ id: string }>("SELECT id FROM supplier_payments WHERE idempotency_key = $1", [key])).rows[0];
      if (dup) return { id: dup.id, replay: true };
      const sup = (await db.query<{ residency: string }>("SELECT residency FROM suppliers WHERE id = $1", [body.supplierId])).rows[0];
      if (!sup) throw notFound("المورد غير موجود");
      const amount = parseMoney(body.amount);
      let wht = { code: null as string | null, rate: 0, amount: 0 };
      if (sup.residency === "non_resident") {
        if (!body.withholdingCode) throw new AppError(422, "withholding_required", "المورد غير مقيم: اختر نوع الدفعة لاستقطاع الضريبة، أو «غير خاضعة» لشراء سلع", [{ path: "withholdingCode", message: "اختر نوع الدفعة" }]);
        if (body.withholdingCode !== "none") {
          const r = (await db.query<{ rate: string }>(
            "SELECT rate::text FROM withholding_rates WHERE code = $1 AND valid_from <= $2::date ORDER BY valid_from DESC LIMIT 1", [body.withholdingCode, body.paidOn])).rows[0];
          if (!r) throw badRequest("نوع دفعة الاستقطاع غير معروف");
          wht = { code: body.withholdingCode, rate: Number(r.rate), amount: vatOf(amount, percentToBp(Number(r.rate))) };
        }
      }
      const n = (await db.query<{ n: string }>("SELECT next_counter('supplier_payment')::text AS n")).rows[0] as { n: string };
      const p = (await db.query<{ id: string }>(
        `INSERT INTO supplier_payments (tenant_id, payment_number, supplier_id, paid_on, amount, method, reference, notes, idempotency_key, created_by,
                                        withholding_code, withholding_rate, withholding_amount)
         VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, app_user_id(), $9, $10, $11) RETURNING id`,
        [n.n, body.supplierId, body.paidOn, formatMoney(amount), body.method, body.reference, body.notes, key, wht.code, wht.rate, formatMoney(wht.amount)])).rows[0] as { id: string };
      await postSupplierPayment(db, p.id);
      await auditTenant(db, req, "supplier_payment.created", "supplier_payment", p.id, { amount: body.amount, withholding: wht.amount / 100 });
      return { id: p.id, replay: false };
    });
    return reply.status(out.replay ? 200 : 201).send({ id: out.id });
  });

  app.get("/withholding-rates", { preHandler: requireTenant("payables.view", "rep_withholding.view") }, async (req) =>
    tenantTx(req, async (db) => ({
      items: (await db.query<{ code: string; name: string; rate: number; validFrom: string }>(
        `SELECT DISTINCT ON (code) code, name_ar AS name, rate::float8 AS rate, valid_from::text AS "validFrom"
           FROM withholding_rates WHERE valid_from <= (now() AT TIME ZONE '${TZ}')::date ORDER BY code, valid_from DESC`)).rows.sort((a, b) => b.rate - a.rate),
    }), { readOnly: true }));

  // Monthly withholding return: what was withheld per payment type; due to ZATCA by the 10th of the next month.
  app.get("/reports/withholding", { preHandler: requireTenant("rep_withholding.view") }, async (req) => {
    const q = req.query as { month?: string };
    const month = /^\d{4}-\d{2}$/.test(q.month ?? "") ? q.month! : new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date()).slice(0, 7);
    const from = `${month}-01`;
    return tenantTx(req, async (db) => {
      const d = (await db.query<{ to: string; due: string }>(
        "SELECT (($1::date + interval '1 month') - interval '1 day')::date::text AS to, (($1::date + interval '1 month') + interval '9 days')::date::text AS due", [from])).rows[0]!;
      const rows = (await db.query<{ code: string; name: string; rate: number; payments: number; gross: number; tax: number }>(
        `SELECT p.withholding_code AS code, max(r.name_ar) AS name, p.withholding_rate::float8 AS rate, count(*)::int AS payments,
                sum(p.amount)::float8 AS gross, sum(p.withholding_amount)::float8 AS tax
           FROM supplier_payments p LEFT JOIN withholding_rates r ON r.code = p.withholding_code
          WHERE p.withholding_amount > 0 AND p.paid_on BETWEEN $1::date AND $2::date GROUP BY p.withholding_code, p.withholding_rate ORDER BY tax DESC`, [from, d.to])).rows;
      const payments = (await db.query(
        `SELECT p.id, p.payment_number AS number, p.paid_on::text AS "paidOn", s.name AS "supplierName", p.withholding_code AS code, p.withholding_rate::float8 AS rate,
                p.amount::float8 AS gross, p.withholding_amount::float8 AS tax
           FROM supplier_payments p JOIN suppliers s ON s.id = p.supplier_id
          WHERE p.withholding_amount > 0 AND p.paid_on BETWEEN $1::date AND $2::date ORDER BY p.paid_on, p.payment_number`, [from, d.to])).rows;
      const balance = Number((await db.query<{ b: string }>(
        `SELECT coalesce(sum(l.credit - l.debit), 0)::text AS b FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.system_key = 'withholding_payable'`)).rows[0]!.b);
      return { month, from, to: d.to, dueDate: d.due, rows, payments, total: rows.reduce((a, r) => a + Math.round(r.tax * 100), 0) / 100, payableBalance: balance };
    }, { readOnly: true });
  });

  /**
   * Three-way match of each goods receipt: the purchase order (price and quantity), what was received, and the
   * supplier's invoice (amount entered at receipt). A receipt is fine when the invoice is within `tolerance` % of
   * the receipt's value and no line was invoiced above the ordered price.
   */
  app.get("/reports/purchase-matching", { preHandler: requireTenant("rep_purchase_match.view") }, async (req) => {
    const q = req.query as { from?: string; to?: string; tolerance?: string; issues?: string };
    const { from, to } = dateRange(q);
    const tol = Math.min(10, Math.max(0, Number(q.tolerance ?? 1) || 0));
    return tenantTx(req, async (db) => {
      const rows = (await db.query<{ id: string; grnNumber: number; poId: string; poNumber: number; supplierName: string; receivedOn: string; supplierInvoice: string | null;
          invoiceAmount: number | null; receiptAmount: number; priceLines: number; priceVariance: number; shortLines: number }>(
        `SELECT g.id, g.grn_number::int AS "grnNumber", p.id AS "poId", p.po_number::int AS "poNumber", s.name AS "supplierName", g.received_on::text AS "receivedOn",
                g.supplier_invoice AS "supplierInvoice", g.invoice_amount::float8 AS "invoiceAmount", g.grand_total::float8 AS "receiptAmount",
                (SELECT count(*)::int FROM goods_receipt_items x WHERE x.receipt_id = g.id AND x.unit_price > x.ordered_price) AS "priceLines",
                (SELECT coalesce(sum((x.unit_price - x.ordered_price) * x.quantity), 0)::float8 FROM goods_receipt_items x WHERE x.receipt_id = g.id) AS "priceVariance",
                (SELECT count(*)::int FROM goods_receipt_items x WHERE x.receipt_id = g.id AND x.rejected_quantity > 0) AS "shortLines"
           FROM goods_receipts g JOIN purchase_orders p ON p.id = g.purchase_order_id JOIN suppliers s ON s.id = g.supplier_id
          WHERE NOT g.legacy AND g.received_on BETWEEN $1::date AND $2::date ORDER BY g.received_on DESC, g.grn_number DESC LIMIT 500`, [from, to])).rows;
      const items = rows.map((r) => {
        const diff = r.invoiceAmount === null ? null : Math.round((r.invoiceAmount - r.receiptAmount) * 100) / 100;
        const within = diff !== null && Math.abs(diff) <= Math.max(0.01, (r.receiptAmount * tol) / 100);
        const status = r.invoiceAmount === null ? "no_invoice" : !within ? "amount_mismatch" : r.priceLines > 0 ? "price_above_order" : "matched";
        return { ...r, difference: diff, priceVariance: Math.round(r.priceVariance * 100) / 100, status };
      });
      const shown = q.issues === "true" ? items.filter((i) => i.status !== "matched") : items;
      const count = (s: string) => items.filter((i) => i.status === s).length;
      return { from, to, tolerance: tol, items: shown,
        summary: { total: items.length, matched: count("matched"), noInvoice: count("no_invoice"), amountMismatch: count("amount_mismatch"), priceAboveOrder: count("price_above_order") } };
    }, { readOnly: true });
  });

  // ── Expenses ────────────────────────────────────────────────────────────────────────────────
  app.get("/expense-categories", { preHandler: requireTenant("expenses.view", "acc_settings.view") }, async (req) =>
    tenantTx(req, async (db) => ({
      items: (await db.query('SELECT id, name, is_active AS "isActive" FROM expense_categories ORDER BY is_active DESC, name')).rows,
    }), { readOnly: true }));

  app.post("/expense-categories", { preHandler: requireTenant("expenses.categories") }, async (req, reply) => {
    const { name } = z.object({ name: z.string().trim().min(2, "أدخل اسم الفئة").max(80) }).parse(req.body);
    const id = await tenantTx(req, async (db) => {
      const r = (await db.query<{ id: string }>("INSERT INTO expense_categories (tenant_id, name) VALUES (app_tenant_id(), $1) RETURNING id", [name])).rows[0] as { id: string };
      await auditTenant(db, req, "expense_category.created", "expense_category", r.id);
      return r.id;
    });
    return reply.status(201).send({ id });
  });

  app.patch("/expense-categories/:id", { preHandler: requireTenant("expenses.categories") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const body = z.object({ name: z.string().trim().min(2).max(80).optional(), isActive: z.boolean().optional() }).parse(req.body);
    await tenantTx(req, async (db) => {
      const r = await db.query("UPDATE expense_categories SET name = coalesce($2, name), is_active = coalesce($3, is_active) WHERE id = $1", [id, body.name ?? null, body.isActive ?? null]);
      if (!r.rowCount) throw notFound();
    });
    return { ok: true };
  });

  app.get("/expenses", { preHandler: requireTenant("expenses.view") }, async (req) => {
    const q = req.query as { from?: string; to?: string; status?: string; categoryId?: string; page?: string; pageSize?: string; sort?: string };
    const page = parsePage(q);
    const { from, to } = dateRange(q);
    const status = ["pending", "approved", "paid", "cancelled"].includes(q.status ?? "") ? q.status : null;
    const cat = isUuid(q.categoryId) ? q.categoryId : null;
    return tenantTx(req, async (db) => {
      const where = `e.expense_date BETWEEN $1::date AND $2::date AND ($3::text IS NULL OR e.status = $3) AND ($4::uuid IS NULL OR e.category_id = $4)`;
      const { rows } = await db.query(
        `SELECT e.id, e.expense_number AS "number", e.expense_date::text AS "expenseDate", e.description, e.amount_net::float8 AS "amountNet",
                e.vat_amount::float8 AS "vatAmount", e.total::float8 AS total, e.status, e.payment_method AS "paymentMethod", e.reference,
                e.cancel_reason AS "cancelReason", e.created_by AS "createdBy", c.name AS "categoryName", b.name AS "branchName",
                (SELECT cc.name FROM cost_centers cc WHERE cc.id = e.cost_center_id) AS "costCenterName",
                (e.created_by = app_user_id()) AS "isMine", count(*) OVER()::int AS "_total"
           FROM expenses e JOIN expense_categories c ON c.id = e.category_id LEFT JOIN branches b ON b.id = e.branch_id
          WHERE ${where} ORDER BY ${sortSql(q.sort, EXPENSE_SORT)}e.expense_date DESC, e.expense_number DESC LIMIT $5 OFFSET $6`, [from, to, status, cat, page.pageSize, page.offset]);
      const sum = (await db.query<{ total: number; pending: number }>(
        `SELECT coalesce(sum(total) FILTER (WHERE status <> 'cancelled'), 0)::float8 AS total, coalesce(sum(total) FILTER (WHERE status = 'pending'), 0)::float8 AS pending
           FROM expenses e WHERE ${where}`, [from, to, status, cat])).rows[0];
      return { from, to, items: rows.map(({ _total, createdBy, ...r }) => r), meta: pageMeta(page, rows[0]?._total ?? 0), summary: sum };
    }, { readOnly: true });
  });

  app.post("/expenses", { preHandler: requireTenant("expenses.create") }, async (req, reply) => {
    const key = idempotencyKey(req);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
    const body = z.object({
      categoryId: z.string().uuid(),
      branchId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
      costCenterId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
      expenseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => d <= today, "تاريخ المصروف لا يكون في المستقبل"),
      description: z.string().trim().min(3, "صف المصروف في كلمات قليلة").max(300),
      amountNet: z.number().positive().max(100_000_000),
      vatAmount: z.number().min(0).max(100_000_000).default(0),
      reference: z.string().trim().max(80).nullable().optional().transform((v) => v || null),
    }).refine((b) => b.vatAmount <= b.amountNet, { message: "الضريبة أكبر من المبلغ. تأكد من الأرقام", path: ["vatAmount"] }).parse(req.body);
    const out = await tenantTx(req, async (db) => {
      const dup = (await db.query<{ id: string }>("SELECT id FROM expenses WHERE idempotency_key = $1", [key])).rows[0];
      if (dup) return { id: dup.id, replay: true };
      const cat = (await db.query<{ is_active: boolean }>("SELECT is_active FROM expense_categories WHERE id = $1", [body.categoryId])).rows[0];
      if (!cat?.is_active) throw new AppError(422, "validation_failed", "الفئة غير موجودة أو موقوفة");
      if (body.costCenterId && !(await db.query("SELECT 1 FROM cost_centers WHERE id = $1 AND is_active", [body.costCenterId])).rowCount) {
        throw new AppError(422, "validation_failed", "مركز التكلفة غير موجود أو موقوف", [{ path: "costCenterId", message: "اختر مركز تكلفة نشطاً" }]);
      }
      const net = parseMoney(body.amountNet); const vat = parseMoney(body.vatAmount);
      const n = (await db.query<{ n: string }>("SELECT next_counter('expense')::text AS n")).rows[0] as { n: string };
      const e = (await db.query<{ id: string }>(
        `INSERT INTO expenses (tenant_id, expense_number, category_id, branch_id, expense_date, description, amount_net, vat_amount, total, reference, idempotency_key, created_by, cost_center_id)
         VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, app_user_id(), $11) RETURNING id`,
        [n.n, body.categoryId, body.branchId, body.expenseDate, body.description, formatMoney(net), formatMoney(vat), formatMoney(net + vat), body.reference, key, body.costCenterId])).rows[0] as { id: string };
      await auditTenant(db, req, "expense.created", "expense", e.id, { total: formatMoney(net + vat) });
      return { id: e.id, replay: false };
    });
    return reply.status(out.replay ? 200 : 201).send({ id: out.id });
  });

  app.post("/expenses/:id/approve", { preHandler: requireTenant("expenses.approve") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    await tenantTx(req, async (db) => {
      const e = (await db.query<{ status: string; created_by: string }>("SELECT status, created_by FROM expenses WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!e) throw notFound();
      if (e.status !== "pending") throw new AppError(409, "invalid_state", "يُعتمد المصروف وهو بانتظار الاعتماد فقط");
      // Segregation of duties: whoever records an expense does not approve it (the owner is exempt in one-person shops).
      if (e.created_by === req.tenant!.userId && req.tenant!.role !== "owner") throw forbidden("لا يمكنك اعتماد مصروف سجّلته بنفسك");
      await db.query("UPDATE expenses SET status = 'approved', approved_by = app_user_id(), approved_at = now() WHERE id = $1", [id]);
      await postExpense(db, id);
      await auditTenant(db, req, "expense.approved", "expense", id);
    });
    return { ok: true };
  });

  app.post("/expenses/:id/pay", { preHandler: requireTenant("expenses.pay") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const body = z.object({ method: payMethod, reference: z.string().trim().max(80).nullable().optional().transform((v) => v || null) }).parse(req.body);
    await tenantTx(req, async (db) => {
      const r = await db.query(
        "UPDATE expenses SET status = 'paid', payment_method = $2, reference = coalesce($3, reference), paid_by = app_user_id(), paid_at = now() WHERE id = $1 AND status = 'approved'",
        [id, body.method, body.reference]);
      if (!r.rowCount) throw new AppError(409, "invalid_state", "يُسدَّد المصروف بعد اعتماده فقط");
      await postExpensePayment(db, id);
      await auditTenant(db, req, "expense.paid", "expense", id, { method: body.method });
    });
    return { ok: true };
  });

  app.post("/expenses/:id/cancel", { preHandler: requireTenant("expenses.cancel") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const { reason } = z.object({ reason: z.string().trim().min(3, "اكتب سبب الإلغاء").max(300) }).parse(req.body);
    await tenantTx(req, async (db) => {
      const r = await db.query("UPDATE expenses SET status = 'cancelled', cancel_reason = $2 WHERE id = $1 AND status = 'pending'", [id, reason]);
      if (!r.rowCount) throw new AppError(409, "invalid_state", "يُلغى المصروف قبل اعتماده فقط");
      await auditTenant(db, req, "expense.cancelled", "expense", id, { reason });
    });
    return { ok: true };
  });

  app.get("/reports/expenses", { preHandler: requireTenant("rep_expenses.view") }, async (req) => {
    const { from, to } = dateRange(req.query as { from?: string; to?: string });
    return tenantTx(req, async (db) => {
      const byCategory = (await db.query(
        `SELECT c.name, count(*)::int AS count, sum(e.amount_net)::float8 AS net, sum(e.vat_amount)::float8 AS vat, sum(e.total)::float8 AS total
           FROM expenses e JOIN expense_categories c ON c.id = e.category_id
          WHERE e.status IN ('approved', 'paid') AND e.expense_date BETWEEN $1::date AND $2::date GROUP BY c.name ORDER BY total DESC`, [from, to])).rows;
      const sales = (await db.query<{ net: number }>(
        `SELECT coalesce(sum(taxable), 0)::float8 AS net FROM pos_orders WHERE (created_at AT TIME ZONE '${TZ}')::date BETWEEN $1::date AND $2::date`, [from, to])).rows[0];
      const net = byCategory.reduce((a, r) => a + parseMoney(r.net), 0) / 100;
      return { from, to, byCategory, totalNet: net, netSales: sales?.net ?? 0, expenseRatio: sales && sales.net > 0 ? Math.round((net / sales.net) * 10000) / 100 : null };
    }, { readOnly: true });
  });
}
