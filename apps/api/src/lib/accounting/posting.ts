import type { Db } from "../../db/pool.ts";
import { openHr } from "../hr/seal.ts";
import { AppError } from "../errors.ts";
import { allocateProportionally, formatMoney, parseMoney, type Halalas } from "../money.ts";

/**
 * The posting engine: every financial operation writes its double-entry journal entry in the SAME transaction
 * as the operation, so the ledger can never disagree with the documents. Each entry carries a source key
 * ("pos_order:<id>"), unique per workspace, so an operation is posted once, whether inline or by the catch-up sync.
 * Amounts are integer halalas; the database re-checks the balance at commit and refuses closed periods.
 */

export type SystemKey =
  | "cash" | "bank" | "card_clearing" | "gateway_clearing" | "platform_receivable" | "ar" | "inventory" | "vat_input"
  | "ap" | "accrued_expenses" | "vat_output" | "vat_payable" | "retained_earnings" | "opening_balance"
  | "sales" | "sales_invoiced" | "sales_returns" | "other_income" | "cash_over"
  | "cogs" | "waste" | "inventory_adjustment" | "delivery_commission" | "cash_short" | "general_expense"
  // Factories (seed_manufacturing_accounts): one inventory account per item type, work in progress, production.
  | "inventory_semi" | "inventory_finished" | "inventory_packaging" | "inventory_consumable" | "inventory_spare" | "wip"
  | "applied_overhead" | "applied_labor" | "production_variance" | "abnormal_scrap" | "withholding_payable" | "maintenance_expense" | "customer_advances"
  | "salaries_expense" | "gosi_expense" | "eos_expense" | "salaries_payable" | "gosi_payable" | "eos_provision" | "employee_advances";

export interface Line {
  key?: SystemKey;
  accountId?: string;
  debit?: Halalas;
  credit?: Halalas;
  memo?: string;
  partner?: { type: "customer" | "supplier"; id: string };
  branchId?: string | null;
  costCenterId?: string | null;
}

export interface Draft {
  date: string; // YYYY-MM-DD (Riyadh)
  description: string;
  sourceType: string;
  sourceId: string | null;
  /** Unique per workspace for automatic entries; null for manual ones. */
  sourceKey: string | null;
  lines: Line[];
  reversalOf?: string | null;
  idempotencyKey?: string | null;
}

/** Where money moves for each payment method. */
export function methodAccount(method: string): SystemKey {
  switch (method) {
    case "cash": return "cash";
    case "mada": case "visa": case "mastercard": case "card": return "card_clearing";
    case "platform": return "platform_receivable";
    case "bank_transfer": case "cheque": return "bank";
    case "online": return "gateway_clearing";
    default: throw new AppError(500, "internal", `unknown payment method ${method}`);
  }
}

async function systemAccounts(db: Db): Promise<Map<string, string>> {
  const rows = (await db.query<{ system_key: string; id: string }>("SELECT system_key, id FROM accounts WHERE system_key IS NOT NULL")).rows;
  return new Map(rows.map((r) => [r.system_key, r.id]));
}

/**
 * Writes one entry. Zero lines are dropped; debits must equal credits. Returns the entry id, or null when this
 * source key was already posted (idempotent).
 */
export async function post(db: Db, d: Draft): Promise<string | null> {
  const lines = d.lines.filter((l) => (l.debit ?? 0) > 0 || (l.credit ?? 0) > 0);
  const dr = lines.reduce((a, l) => a + (l.debit ?? 0), 0);
  const cr = lines.reduce((a, l) => a + (l.credit ?? 0), 0);
  if (dr === 0 && cr === 0) return null;
  if (dr !== cr) throw new AppError(500, "journal_unbalanced", `القيد غير متوازن (${formatMoney(dr)} / ${formatMoney(cr)})`);
  const keys = await systemAccounts(db);
  if (!keys.size) return null; // chart not set up (should not happen: every workspace is seeded)
  const n = (await db.query<{ n: string }>("SELECT next_counter('journal')::text AS n")).rows[0]!.n;
  const e = await db.query<{ id: string }>(
    `INSERT INTO journal_entries (tenant_id, entry_number, entry_date, description, source_type, source_id, source_key, reversal_of, idempotency_key, created_by)
     VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, nullif(current_setting('app.user_id', true), '')::uuid)
     ON CONFLICT (tenant_id, source_key) DO NOTHING RETURNING id`,
    [n, d.date, d.description.slice(0, 300), d.sourceType, d.sourceId, d.sourceKey, d.reversalOf ?? null, d.idempotencyKey ?? null]);
  const id = e.rows[0]?.id;
  if (!id) return null;
  for (const l of lines) {
    const accountId = l.accountId ?? (l.key ? keys.get(l.key) : undefined);
    if (!accountId) throw new AppError(409, "account_missing", `الحساب «${l.key}» غير موجود في دليل الحسابات`);
    await db.query(
      `INSERT INTO journal_lines (tenant_id, entry_id, account_id, debit, credit, memo, partner_type, partner_id, branch_id, cost_center_id)
       VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, accountId, formatMoney(l.debit ?? 0), formatMoney(l.credit ?? 0), l.memo ?? null, l.partner?.type ?? null, l.partner?.id ?? null, l.branchId ?? null, l.costCenterId ?? null]);
  }
  return id;
}

const m = (v: string | null | undefined) => parseMoney(v ?? "0");
const RIYADH = "Asia/Riyadh";

/** Where an item type is valued. A chart without the account (every restaurant) keeps the single inventory account. */
const TYPE_ACCOUNT: Record<string, SystemKey> = {
  raw: "inventory", semi_finished: "inventory_semi", finished: "inventory_finished",
  packaging: "inventory_packaging", consumable: "inventory_consumable", spare_part: "inventory_spare",
};

/**
 * The inventory side of an operation, split by the inventory account of each item it moved. The stock movements the
 * operation wrote give the weights; `total` (the amount the operation posts) is shared by them so the lines add up
 * to it exactly. With one account (a restaurant) this is the single line it always was.
 */
async function inventorySide(db: Db, refType: string, refId: string, total: Halalas, side: "debit" | "credit", branchId: string | null): Promise<Line[]> {
  if (total <= 0) return [];
  const rows = (await db.query<{ item_type: string; w: string }>(
    `SELECT i.item_type, abs(sum(mv.quantity * mv.unit_cost))::text AS w FROM stock_movements mv JOIN ingredients i ON i.id = mv.ingredient_id
      WHERE mv.ref_type = $1 AND mv.ref_id = $2 GROUP BY i.item_type`, [refType, refId])).rows;
  const present = new Set((await db.query<{ system_key: string }>("SELECT system_key FROM accounts WHERE system_key LIKE 'inventory%'")).rows.map((r) => r.system_key));
  const byKey = new Map<SystemKey, number>();
  for (const r of rows) {
    const k = TYPE_ACCOUNT[r.item_type] ?? "inventory";
    const key = present.has(k) ? k : "inventory";
    byKey.set(key, (byKey.get(key) ?? 0) + Number(r.w));
  }
  if (byKey.size <= 1) return [{ key: [...byKey.keys()][0] ?? "inventory", [side]: total, branchId }];
  const keys = [...byKey.keys()];
  const parts = allocateProportionally(total, keys.map((k) => byKey.get(k)!));
  return keys.map((key, i) => ({ key, [side]: parts[i]!, branchId }));
}

/**
 * A count or an adjustment can gain on one item and lose on another: each account moves by its own net, and the
 * balancing line (`against`) takes the total.
 */
async function inventoryNet(db: Db, refType: string, refId: string, against: SystemKey, branchId: string | null): Promise<Line[]> {
  const rows = (await db.query<{ item_type: string; v: string }>(
    `SELECT i.item_type, sum(mv.quantity * mv.unit_cost)::text AS v FROM stock_movements mv JOIN ingredients i ON i.id = mv.ingredient_id
      WHERE mv.ref_type = $1 AND mv.ref_id = $2 GROUP BY i.item_type`, [refType, refId])).rows;
  const present = new Set((await db.query<{ system_key: string }>("SELECT system_key FROM accounts WHERE system_key LIKE 'inventory%'")).rows.map((r) => r.system_key));
  const byKey = new Map<SystemKey, number>();
  for (const r of rows) {
    const k = TYPE_ACCOUNT[r.item_type] ?? "inventory";
    const key = present.has(k) ? k : "inventory";
    byKey.set(key, (byKey.get(key) ?? 0) + Number(r.v));
  }
  const lines: Line[] = [];
  let net = 0;
  for (const [key, v] of byKey) {
    const h = Math.round(v * 100);
    if (!h) continue;
    net += h;
    lines.push(h > 0 ? { key, debit: h, branchId } : { key, credit: -h, branchId });
  }
  if (net) lines.push(net > 0 ? { key: against, credit: net, branchId } : { key: against, debit: -net, branchId });
  return lines;
}

// ── One function per operation ────────────────────────────────────────────────────────────────

export async function postPosOrder(db: Db, orderId: string) {
  const o = (await db.query<{ order_number: string; d: string; taxable: string; vat: string; cost: string; commission: string; branch_id: string | null }>(
    `SELECT o.order_number::text, (o.created_at AT TIME ZONE '${RIYADH}')::date::text AS d, o.taxable::text, o.vat::text,
            round(o.cost_total, 2)::text AS cost, o.commission_amount::text AS commission, l.branch_id
       FROM pos_orders o JOIN locations l ON l.id = o.location_id WHERE o.id = $1`, [orderId])).rows[0];
  if (!o) return null;
  const pays = (await db.query<{ method: string; amount: string }>("SELECT method, sum(amount)::text AS amount FROM pos_payments WHERE order_id = $1 GROUP BY method", [orderId])).rows;
  const b = o.branch_id;
  return post(db, {
    date: o.d, description: `طلب مبيعات رقم ${o.order_number}`, sourceType: "pos_order", sourceId: orderId, sourceKey: `pos_order:${orderId}`,
    lines: [
      ...pays.map((p): Line => ({ key: methodAccount(p.method), debit: m(p.amount), branchId: b })),
      { key: "sales", credit: m(o.taxable), branchId: b },
      { key: "vat_output", credit: m(o.vat), branchId: b },
      { key: "delivery_commission", debit: m(o.commission), branchId: b },
      { key: "platform_receivable", credit: m(o.commission), branchId: b, memo: "عمولة التطبيق" },
      { key: "cogs", debit: m(o.cost), branchId: b },
      { key: "inventory", credit: m(o.cost), branchId: b },
    ],
  });
}

export async function postPosRefund(db: Db, refundId: string) {
  const r = (await db.query<{ order_number: string; d: string; amount: string; vat: string; method: string; restocked: string; branch_id: string | null }>(
    `SELECT o.order_number::text, (r.created_at AT TIME ZONE '${RIYADH}')::date::text AS d, r.amount::text, r.vat_amount::text AS vat, r.method,
            coalesce((SELECT round(sum(m.quantity * m.unit_cost), 2) FROM stock_movements m WHERE m.ref_type = 'pos_refund' AND m.ref_id = r.id), 0)::text AS restocked,
            l.branch_id
       FROM pos_refunds r JOIN pos_orders o ON o.id = r.order_id JOIN locations l ON l.id = o.location_id WHERE r.id = $1`, [refundId])).rows[0];
  if (!r) return null;
  const amount = m(r.amount);
  const vat = m(r.vat);
  const b = r.branch_id;
  return post(db, {
    date: r.d, description: `استرجاع على الطلب رقم ${r.order_number}`, sourceType: "pos_refund", sourceId: refundId, sourceKey: `pos_refund:${refundId}`,
    lines: [
      { key: "sales_returns", debit: amount - vat, branchId: b },
      { key: "vat_output", debit: vat, branchId: b },
      { key: methodAccount(r.method), credit: amount, branchId: b },
      { key: "inventory", debit: m(r.restocked), branchId: b },
      { key: "cogs", credit: m(r.restocked), branchId: b },
    ],
  });
}

export async function postShiftClose(db: Db, shiftId: string) {
  const s = (await db.query<{ d: string; over_short: string | null; branch_id: string | null }>(
    `SELECT (s.closed_at AT TIME ZONE '${RIYADH}')::date::text AS d, s.over_short::text, l.branch_id
       FROM pos_shifts s JOIN locations l ON l.id = s.location_id WHERE s.id = $1 AND s.status = 'closed'`, [shiftId])).rows[0];
  if (!s || !s.over_short) return null;
  const v = Number(s.over_short);
  if (v === 0) return null;
  const amt = parseMoney(Math.abs(v));
  const b = s.branch_id;
  return post(db, {
    date: s.d, description: v < 0 ? "عجز في صندوق الكاشير عند إغلاق الشفت" : "زيادة في صندوق الكاشير عند إغلاق الشفت",
    sourceType: "shift_close", sourceId: shiftId, sourceKey: `shift_close:${shiftId}`,
    lines: v < 0
      ? [{ key: "cash_short", debit: amt, branchId: b }, { key: "cash", credit: amt, branchId: b }]
      : [{ key: "cash", debit: amt, branchId: b }, { key: "cash_over", credit: amt, branchId: b }],
  });
}

export async function postPurchaseReceipt(db: Db, poId: string) {
  const p = (await db.query<{ po_number: string; d: string; total: string; vat: string; supplier_id: string; supplier: string; invoice: string | null; branch_id: string | null }>(
    `SELECT p.po_number::text, (p.received_at AT TIME ZONE '${RIYADH}')::date::text AS d, p.total::text, p.vat_amount::text AS vat,
            p.supplier_id, s.name AS supplier, p.supplier_invoice AS invoice, l.branch_id
       FROM purchase_orders p JOIN suppliers s ON s.id = p.supplier_id JOIN locations l ON l.id = p.location_id
      WHERE p.id = $1 AND p.status = 'received'`, [poId])).rows[0];
  if (!p) return null;
  const partner = { type: "supplier" as const, id: p.supplier_id };
  return post(db, {
    date: p.d, description: `استلام أمر الشراء رقم ${p.po_number} من ${p.supplier}${p.invoice ? ` (فاتورة ${p.invoice})` : ""}`,
    sourceType: "purchase_receipt", sourceId: poId, sourceKey: `purchase_receipt:${poId}`,
    lines: [
      { key: "inventory", debit: m(p.total), branchId: p.branch_id },
      { key: "vat_input", debit: m(p.vat), branchId: p.branch_id },
      { key: "ap", credit: m(p.total) + m(p.vat), partner, branchId: p.branch_id },
    ],
  });
}

/** One goods receipt note: inventory at landed cost (net), VAT input, and what we owe the supplier. */
export async function postGoodsReceipt(db: Db, grnId: string) {
  const g = (await db.query<{ grn_number: string; po_number: string; d: string; total: string; vat: string; supplier_id: string; supplier: string; invoice: string | null; branch_id: string | null; legacy: boolean }>(
    `SELECT g.grn_number::text, p.po_number::text, g.received_on::text AS d, g.total::text, g.vat_amount::text AS vat, g.supplier_id, s.name AS supplier,
            g.supplier_invoice AS invoice, l.branch_id, g.legacy
       FROM goods_receipts g JOIN purchase_orders p ON p.id = g.purchase_order_id JOIN suppliers s ON s.id = g.supplier_id JOIN locations l ON l.id = g.location_id
      WHERE g.id = $1`, [grnId])).rows[0];
  // Receipts carried over from before goods receipt notes were already posted under their purchase order.
  if (!g || g.legacy || m(g.total) + m(g.vat) === 0) return null;
  return post(db, {
    date: g.d, description: `استلام رقم ${g.grn_number} لأمر الشراء ${g.po_number} من ${g.supplier}${g.invoice ? ` (فاتورة ${g.invoice})` : ""}`,
    sourceType: "goods_receipt", sourceId: grnId, sourceKey: `goods_receipt:${grnId}`,
    lines: [
      ...(await inventorySide(db, "goods_receipt", grnId, m(g.total), "debit", g.branch_id)),
      { key: "vat_input", debit: m(g.vat), branchId: g.branch_id },
      { key: "ap", credit: m(g.total) + m(g.vat), partner: { type: "supplier", id: g.supplier_id }, branchId: g.branch_id },
    ],
  });
}

/** Goods that left the source and did not reach the destination: written off as an inventory adjustment. */
export async function postTransferShortage(db: Db, transferId: string) {
  const t = (await db.query<{ transfer_number: string; d: string; value: string; branch_id: string | null }>(
    `SELECT t.transfer_number::text, (t.completed_at AT TIME ZONE '${RIYADH}')::date::text AS d, round(t.shortage_value, 2)::text AS value, l.branch_id
       FROM stock_transfers t JOIN locations l ON l.id = t.to_location_id WHERE t.id = $1 AND t.status = 'completed'`, [transferId])).rows[0];
  if (!t || m(t.value) === 0) return null;
  return post(db, {
    date: t.d, description: `عجز التحويل رقم ${t.transfer_number} (فُقد في الطريق)`, sourceType: "transfer_shortage", sourceId: transferId, sourceKey: `transfer_shortage:${transferId}`,
    lines: [
      { key: "inventory_adjustment", debit: m(t.value), branchId: t.branch_id },
      ...(await inventorySide(db, "stock_transfer", transferId, m(t.value), "credit", t.branch_id)),
    ],
  });
}

export async function postPurchaseReturn(db: Db, returnId: string) {
  const r = (await db.query<{ return_number: string; d: string; value: string; vat: string; supplier_id: string; supplier: string; branch_id: string | null }>(
    `SELECT r.return_number::text, (r.created_at AT TIME ZONE '${RIYADH}')::date::text AS d, r.total_value::text AS value, r.vat_amount::text AS vat,
            r.supplier_id, s.name AS supplier, l.branch_id
       FROM purchase_returns r JOIN suppliers s ON s.id = r.supplier_id JOIN locations l ON l.id = r.location_id WHERE r.id = $1`, [returnId])).rows[0];
  if (!r) return null;
  return post(db, {
    date: r.d, description: `مرتجع مشتريات رقم ${r.return_number} إلى ${r.supplier}`, sourceType: "purchase_return", sourceId: returnId, sourceKey: `purchase_return:${returnId}`,
    lines: [
      { key: "ap", debit: m(r.value) + m(r.vat), partner: { type: "supplier", id: r.supplier_id }, branchId: r.branch_id },
      ...(await inventorySide(db, "purchase_return", returnId, m(r.value), "credit", r.branch_id)),
      { key: "vat_input", credit: m(r.vat), branchId: r.branch_id },
    ],
  });
}

export async function postSupplierPayment(db: Db, paymentId: string) {
  const p = (await db.query<{ payment_number: string; d: string; amount: string; wht: string; method: string; supplier_id: string; supplier: string }>(
    `SELECT p.payment_number::text, p.paid_on::text AS d, p.amount::text, p.withholding_amount::text AS wht, p.method, p.supplier_id, s.name AS supplier
       FROM supplier_payments p JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = $1`, [paymentId])).rows[0];
  if (!p) return null;
  // Tax withheld from a non-resident supplier: the balance is settled in full, the bank pays the net.
  const wht = m(p.wht);
  return post(db, {
    date: p.d, description: `سداد للمورد ${p.supplier} (دفعة ${p.payment_number})${wht ? " مع استقطاع الضريبة" : ""}`, sourceType: "supplier_payment", sourceId: paymentId, sourceKey: `supplier_payment:${paymentId}`,
    lines: [
      { key: "ap", debit: m(p.amount), partner: { type: "supplier", id: p.supplier_id } },
      { key: methodAccount(p.method), credit: m(p.amount) - wht },
      { key: "withholding_payable", credit: wht, memo: "ضريبة استقطاع مستحقة للهيئة" },
    ],
  });
}

/** Approval recognises the expense (accrual); payment settles it. */
export async function postExpense(db: Db, expenseId: string) {
  const e = (await db.query<{ expense_number: string; d: string; net: string; vat: string; total: string; description: string; account_id: string | null; branch_id: string | null; cost_center_id: string | null }>(
    `SELECT e.expense_number::text, e.expense_date::text AS d, e.amount_net::text AS net, e.vat_amount::text AS vat, e.total::text,
            e.description, c.account_id, e.branch_id, e.cost_center_id
       FROM expenses e JOIN expense_categories c ON c.id = e.category_id WHERE e.id = $1 AND e.status IN ('approved', 'paid')`, [expenseId])).rows[0];
  if (!e) return null;
  return post(db, {
    date: e.d, description: `مصروف رقم ${e.expense_number}: ${e.description}`, sourceType: "expense", sourceId: expenseId, sourceKey: `expense:${expenseId}`,
    lines: [
      { ...(e.account_id ? { accountId: e.account_id } : { key: "general_expense" as const }), debit: m(e.net), branchId: e.branch_id, costCenterId: e.cost_center_id },
      { key: "vat_input", debit: m(e.vat), branchId: e.branch_id },
      { key: "accrued_expenses", credit: m(e.total), branchId: e.branch_id },
    ],
  });
}

export async function postExpensePayment(db: Db, expenseId: string) {
  const e = (await db.query<{ expense_number: string; d: string; total: string; method: string; branch_id: string | null }>(
    `SELECT expense_number::text, (paid_at AT TIME ZONE '${RIYADH}')::date::text AS d, total::text, payment_method AS method, branch_id
       FROM expenses WHERE id = $1 AND status = 'paid'`, [expenseId])).rows[0];
  if (!e) return null;
  await postExpense(db, expenseId); // an expense paid straight away is recognised first
  return post(db, {
    date: e.d, description: `سداد المصروف رقم ${e.expense_number}`, sourceType: "expense_payment", sourceId: expenseId, sourceKey: `expense_payment:${expenseId}`,
    lines: [
      { key: "accrued_expenses", debit: m(e.total), branchId: e.branch_id },
      { key: methodAccount(e.method), credit: m(e.total), branchId: e.branch_id },
    ],
  });
}

export async function postWaste(db: Db, wasteId: string) {
  const w = (await db.query<{ waste_number: string; d: string; cost: string; branch_id: string | null }>(
    `SELECT w.waste_number::text, (w.created_at AT TIME ZONE '${RIYADH}')::date::text AS d, round(w.total_cost, 2)::text AS cost, l.branch_id
       FROM waste_records w JOIN locations l ON l.id = w.location_id WHERE w.id = $1`, [wasteId])).rows[0];
  if (!w) return null;
  return post(db, {
    date: w.d, description: `هدر رقم ${w.waste_number}`, sourceType: "waste", sourceId: wasteId, sourceKey: `waste:${wasteId}`,
    lines: [{ key: "waste", debit: m(w.cost), branchId: w.branch_id }, ...(await inventorySide(db, "waste", wasteId, m(w.cost), "credit", w.branch_id))],
  });
}

export async function postStocktake(db: Db, stocktakeId: string) {
  const s = (await db.query<{ count_number: string; d: string; v: string | null; branch_id: string | null }>(
    `SELECT s.count_number::text, (s.posted_at AT TIME ZONE '${RIYADH}')::date::text AS d, round(s.variance_value, 2)::text AS v, l.branch_id
       FROM stocktakes s JOIN locations l ON l.id = s.location_id WHERE s.id = $1 AND s.status = 'posted'`, [stocktakeId])).rows[0];
  if (!s || !s.v) return null;
  const v = Number(s.v);
  if (v === 0) return null;
  const amt = parseMoney(Math.abs(v));
  const b = s.branch_id;
  // Items valued in different accounts (a factory's raw materials and finished goods) each move by their own net.
  const split = await inventoryNet(db, "stocktake", stocktakeId, "inventory_adjustment", b);
  const accounts = split.filter((l) => l.key !== "inventory_adjustment").length;
  return post(db, {
    date: s.d, description: `تسوية فروقات الجرد رقم ${s.count_number} (${v < 0 ? "عجز" : "زيادة"})`, sourceType: "stocktake", sourceId: stocktakeId, sourceKey: `stocktake:${stocktakeId}`,
    lines: accounts > 1 ? split : v < 0
      ? [{ key: "inventory_adjustment", debit: amt, branchId: b }, { key: split[0]?.key ?? "inventory", credit: amt, branchId: b }]
      : [{ key: split[0]?.key ?? "inventory", debit: amt, branchId: b }, { key: "inventory_adjustment", credit: amt, branchId: b }],
  });
}

export async function postSalesDocument(db: Db, docId: string) {
  const d = (await db.query<{ kind: string; doc_number: string; issue_date: string; vat: string; total: string; customer_id: string | null; payment_means: string; branch_id: string | null; ap_taxable: string; ap_vat: string }>(
    `SELECT kind, doc_number, issue_date::text, vat::text, total::text, customer_id, payment_means, branch_id,
            coalesce((SELECT sum(a.taxable) FROM prepayment_applications a WHERE a.invoice_id = d.id), 0)::text AS ap_taxable,
            coalesce((SELECT sum(a.vat) FROM prepayment_applications a WHERE a.invoice_id = d.id), 0)::text AS ap_vat
       FROM sales_documents d WHERE id = $1`, [docId])).rows[0];
  if (!d) return null;
  const lines = (await db.query<{ account_id: string; net: string }>(
    "SELECT account_id, sum(net)::text AS net FROM sales_document_lines WHERE document_id = $1 GROUP BY account_id", [docId])).rows;
  // On credit (or with a named customer) the amount goes to the customer's receivable; paid at issue goes to cash/card/bank.
  const counter: Line = d.payment_means === "credit" && d.customer_id
    ? { key: "ar", partner: { type: "customer", id: d.customer_id } }
    : { key: methodAccount(d.payment_means === "credit" ? "cash" : d.payment_means) };
  const isCredit = d.kind === "credit_note";
  const label = d.kind === "invoice" ? "فاتورة ضريبية" : d.kind === "prepayment" ? "فاتورة دفعة مقدمة" : isCredit ? "إشعار دائن" : "إشعار مدين";
  // The advance an invoice deducts leaves the liability, and its VAT (declared on the prepayment) leaves output VAT.
  const apTaxable = m(d.ap_taxable);
  const apVat = m(d.ap_vat);
  const side = (v: Halalas, debitWhenInvoice: boolean): Pick<Line, "debit" | "credit"> => (debitWhenInvoice !== isCredit ? { debit: v } : { credit: v });
  return post(db, {
    date: d.issue_date, description: `${label} رقم ${d.doc_number}`, sourceType: "sales_document", sourceId: docId, sourceKey: `sales_document:${docId}`,
    lines: [
      { ...counter, ...side(m(d.total), true), branchId: d.branch_id },
      ...lines.map((l): Line => ({ accountId: l.account_id, ...side(m(l.net), false), branchId: d.branch_id })),
      { key: "vat_output", ...side(m(d.vat), false), branchId: d.branch_id },
      ...(apTaxable + apVat > 0 ? [
        { key: "customer_advances" as SystemKey, debit: apTaxable, branchId: d.branch_id },
        { key: "vat_output" as SystemKey, debit: apVat, branchId: d.branch_id },
        { ...counter, credit: apTaxable + apVat, branchId: d.branch_id },
      ] : []),
    ],
  });
}

export async function postCustomerReceipt(db: Db, receiptId: string) {
  const r = (await db.query<{ receipt_number: string; d: string; amount: string; method: string; customer_id: string; customer: string }>(
    `SELECT r.receipt_number::text, r.received_on::text AS d, r.amount::text, r.method, r.customer_id, c.name AS customer
       FROM customer_receipts r JOIN customers c ON c.id = r.customer_id WHERE r.id = $1`, [receiptId])).rows[0];
  if (!r) return null;
  return post(db, {
    date: r.d, description: `سند قبض رقم ${r.receipt_number} من ${r.customer}`, sourceType: "customer_receipt", sourceId: receiptId, sourceKey: `customer_receipt:${receiptId}`,
    lines: [
      { key: methodAccount(r.method), debit: m(r.amount) },
      { key: "ar", credit: m(r.amount), partner: { type: "customer", id: r.customer_id } },
    ],
  });
}

/**
 * One manufacturing-order event. Issues move materials into the order's work in progress; returns take them back;
 * labour and overhead are absorbed into it at the work center's rates; output leaves it at standard cost (with
 * by-products and abnormal scrap); closing posts what is left as the order's production variance.
 */
export async function postMoEvent(db: Db, eventId: string) {
  const e = (await db.query<{ kind: string; d: string; wip: string; detail: Record<string, any>; mo_number: string; item: string; cost_center_id: string | null; branch_id: string | null }>(
    `SELECT e.kind, (e.created_at AT TIME ZONE '${RIYADH}')::date::text AS d, e.wip_delta::text AS wip, e.detail, o.mo_number::text, i.name AS item, o.cost_center_id, l.branch_id
       FROM mo_events e JOIN manufacturing_orders o ON o.id = e.mo_id JOIN ingredients i ON i.id = o.item_id JOIN locations l ON l.id = o.location_id
      WHERE e.id = $1`, [eventId])).rows[0];
  if (!e) return null;
  const b = e.branch_id;
  const cc = e.cost_center_id;
  const wip = Math.round(Number(e.wip) * 100);
  const ref = `أمر التشغيل ${e.mo_number} (${e.item})`;
  const base = { date: e.d, sourceType: "mo_event", sourceId: eventId, sourceKey: `mo_event:${eventId}` };
  switch (e.kind) {
    case "issue":
      return post(db, { ...base, description: `صرف مواد ل${ref}`, lines: [{ key: "wip", debit: wip, branchId: b }, ...(await inventorySide(db, "mo_event", eventId, wip, "credit", b))] });
    case "return":
      return post(db, { ...base, description: `إرجاع مواد من ${ref}`, lines: [...(await inventorySide(db, "mo_event", eventId, -wip, "debit", b)), { key: "wip", credit: -wip, branchId: b }] });
    case "labor": {
      const labor = Math.round(Number(e.detail.labor ?? 0) * 100);
      return post(db, { ...base, description: `تحميل تشغيل ${e.detail.operation ?? ""} على ${ref}`, lines: [
        { key: "wip", debit: wip, branchId: b },
        { key: "applied_labor", credit: labor, branchId: b, costCenterId: cc },
        { key: "applied_overhead", credit: wip - labor, branchId: b, costCenterId: cc },
      ] });
    }
    case "output": {
      const scrap = Math.round(Number(e.detail.scrapValue ?? 0) * 100);
      return post(db, { ...base, description: `إنتاج ${ref}`, lines: [
        ...(await inventorySide(db, "mo_event", eventId, -wip - scrap, "debit", b)),
        { key: "abnormal_scrap", debit: scrap, branchId: b, costCenterId: cc, memo: "هالك غير عادي" },
        { key: "wip", credit: -wip, branchId: b },
      ] });
    }
    case "close":
      return post(db, { ...base, description: `إقفال ${ref}: انحراف الإنتاج`, lines: wip < 0
        ? [{ key: "production_variance", debit: -wip, branchId: b, costCenterId: cc }, { key: "wip", credit: -wip, branchId: b }]
        : [{ key: "wip", debit: wip, branchId: b }, { key: "production_variance", credit: wip, branchId: b, costCenterId: cc }] });
    default:
      return null;
  }
}

/** A delivery to a customer takes stock out at cost (cost of sales); a customer return puts it back. */
export async function postDelivery(db: Db, deliveryId: string) {
  const d = (await db.query<{ kind: string; n: string; so: string; d: string; value: string; customer: string; branch_id: string | null }>(
    `SELECT d.kind, d.delivery_number::text AS n, o.so_number::text AS so, d.delivered_on::text AS d, d.value::text, c.name AS customer, l.branch_id
       FROM deliveries d JOIN sales_orders o ON o.id = d.order_id JOIN customers c ON c.id = o.customer_id JOIN locations l ON l.id = d.location_id WHERE d.id = $1`, [deliveryId])).rows[0];
  if (!d) return null;
  const v = m(d.value);
  const ret = d.kind === "return";
  return post(db, {
    date: d.d, description: `${ret ? "مرتجع من العميل" : "تسليم للعميل"} ${d.customer} (رقم ${d.n}، أمر البيع ${d.so})`,
    sourceType: "delivery", sourceId: deliveryId, sourceKey: `delivery:${deliveryId}`,
    lines: ret
      ? [...(await inventorySide(db, "delivery", deliveryId, v, "debit", d.branch_id)), { key: "cogs", credit: v, branchId: d.branch_id }]
      : [{ key: "cogs", debit: v, branchId: d.branch_id }, ...(await inventorySide(db, "delivery", deliveryId, v, "credit", d.branch_id))],
  });
}

/** Spare parts used by a maintenance order leave stock into maintenance expense (on the machine's cost center). */
export async function postMaintenanceOrder(db: Db, orderId: string) {
  const o = (await db.query<{ n: string; d: string; cost: string; machine: string; branch_id: string | null; cost_center_id: string | null }>(
    `SELECT o.order_number::text AS n, (o.completed_at AT TIME ZONE '${RIYADH}')::date::text AS d, o.parts_cost::text AS cost, m.name AS machine,
            l.branch_id, w.cost_center_id
       FROM maintenance_orders o JOIN machines m ON m.id = o.machine_id LEFT JOIN locations l ON l.id = o.location_id LEFT JOIN work_centers w ON w.id = m.work_center_id
      WHERE o.id = $1 AND o.status = 'done'`, [orderId])).rows[0];
  if (!o) return null;
  const v = m(o.cost);
  if (!v) return null;
  return post(db, {
    date: o.d, description: `قطع غيار أمر الصيانة ${o.n} (${o.machine})`, sourceType: "maintenance", sourceId: orderId, sourceKey: `maintenance:${orderId}`,
    lines: [{ key: "maintenance_expense", debit: v, branchId: o.branch_id, costCenterId: o.cost_center_id }, ...(await inventorySide(db, "maintenance", orderId, v, "credit", o.branch_id))],
  });
}

/**
 * A payroll run, on approval, dated the period's last day, per cost center and branch: gross pay, employer GOSI and
 * the end-of-service accrual as expenses; net pay, both GOSI shares, the provision and recovered advances as what
 * is owed. Amounts are read from the sealed lines (openHr).
 */
export async function postPayrollRun(db: Db, runId: string) {
  const r = (await db.query<{ period: string; status: string }>("SELECT period, status FROM payroll_runs WHERE id = $1", [runId])).rows[0];
  if (!r || r.status === "draft") return null;
  const rows = (await db.query<{ cost_center_id: string | null; branch_id: string | null; amounts_enc: string }>(
    "SELECT cost_center_id, branch_id, amounts_enc FROM payroll_lines WHERE run_id = $1", [runId])).rows;
  const groups = new Map<string, { cc: string | null; b: string | null; gross: number; penalty: number; er: number; ee: number; eos: number; adv: number; net: number }>();
  for (const x of rows) {
    const a = openHr<{ gross: number; penalty: number; gosiEmployer: number; gosiEmployee: number; eosAccrual: number; advanceRecovery: number; net: number }>(x.amounts_enc);
    const k = `${x.cost_center_id}|${x.branch_id}`;
    const g = groups.get(k) ?? { cc: x.cost_center_id, b: x.branch_id, gross: 0, penalty: 0, er: 0, ee: 0, eos: 0, adv: 0, net: 0 };
    g.gross += a.gross; g.penalty += a.penalty; g.er += a.gosiEmployer; g.ee += a.gosiEmployee; g.eos += a.eosAccrual; g.adv += a.advanceRecovery; g.net += a.net;
    groups.set(k, g);
  }
  const [y, mo] = r.period.split("-").map(Number) as [number, number];
  const date = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
  const lines: Line[] = [];
  for (const g of groups.values()) {
    const at = { branchId: g.b, costCenterId: g.cc };
    lines.push({ key: "salaries_expense", debit: g.gross, ...at }, { key: "salaries_expense", credit: g.penalty, ...at },
      { key: "gosi_expense", debit: g.er, ...at }, { key: "gosi_payable", credit: g.er + g.ee, ...at },
      g.eos >= 0 ? { key: "eos_expense", debit: g.eos, ...at } : { key: "eos_expense", credit: -g.eos, ...at },
      g.eos >= 0 ? { key: "eos_provision", credit: g.eos, ...at } : { key: "eos_provision", debit: -g.eos, ...at },
      { key: "employee_advances", credit: g.adv, ...at }, { key: "salaries_payable", credit: g.net, ...at });
  }
  return post(db, { date, description: `مسير رواتب ${r.period}`, sourceType: "payroll_run", sourceId: runId, sourceKey: `payroll_run:${runId}`, lines });
}

/** Paying a run: what is owed in net pay leaves the bank (or cash). */
export async function postPayrollPayment(db: Db, runId: string) {
  const r = (await db.query<{ period: string; net: string; method: string | null; d: string | null }>(
    "SELECT period, net::text, payment_method AS method, paid_on::text AS d FROM payroll_runs WHERE id = $1 AND status = 'paid'", [runId])).rows[0];
  if (!r || !r.method || !r.d) return null;
  return post(db, { date: r.d, description: `صرف رواتب ${r.period}`, sourceType: "payroll_payment", sourceId: runId, sourceKey: `payroll_payment:${runId}`,
    lines: [{ key: "salaries_payable", debit: m(r.net) }, { key: methodAccount(r.method), credit: m(r.net) }] });
}

/**
 * A final settlement, paid when the employee leaves: the provision built for them is released against the award
 * (the difference is this period's expense or a reversal), unused annual leave is paid as salary.
 */
export async function postFinalSettlement(db: Db, id: string) {
  const s = (await db.query<{ last_day: string; amounts_enc: string; name: string; cost_center_id: string | null; branch_id: string | null }>(
    `SELECT f.last_day::text, f.amounts_enc, e.name, e.cost_center_id, e.branch_id FROM final_settlements f JOIN employees e ON e.id = f.employee_id WHERE f.id = $1`, [id])).rows[0];
  if (!s) return null;
  const a = openHr<{ award: number; provision: number; leaveEncashment: number; total: number; paymentMethod: string }>(s.amounts_enc);
  const at = { branchId: s.branch_id, costCenterId: s.cost_center_id };
  const diff = a.award - a.provision;
  return post(db, { date: s.last_day, description: `مخالصة نهاية خدمة ${s.name}`, sourceType: "final_settlement", sourceId: id, sourceKey: `final_settlement:${id}`,
    lines: [
      { key: "eos_provision", debit: a.provision, ...at },
      diff >= 0 ? { key: "eos_expense", debit: diff, ...at } : { key: "eos_expense", credit: -diff, ...at },
      { key: "salaries_expense", debit: a.leaveEncashment, ...at },
      { key: methodAccount(a.paymentMethod), credit: a.total, ...at },
    ] });
}

/** A mirror entry with debits and credits swapped. Each entry can be reversed once (enforced by the database). */
export async function reverse(db: Db, entryId: string, date: string, reason: string, sourceKey: string | null, idempotencyKey?: string) {
  const e = (await db.query<{ entry_number: string; description: string; source_type: string }>(
    "SELECT entry_number::text, description, source_type FROM journal_entries WHERE id = $1", [entryId])).rows[0];
  if (!e) throw new AppError(404, "not_found", "القيد غير موجود");
  const lines = (await db.query<{ account_id: string; debit: string; credit: string; memo: string | null; partner_type: "customer" | "supplier" | null; partner_id: string | null; branch_id: string | null }>(
    "SELECT account_id, debit::text, credit::text, memo, partner_type, partner_id, branch_id FROM journal_lines WHERE entry_id = $1", [entryId])).rows;
  return post(db, {
    date, description: `عكس القيد رقم ${e.entry_number}: ${reason}`, sourceType: "reversal", sourceId: entryId, sourceKey, reversalOf: entryId, idempotencyKey: idempotencyKey ?? null,
    lines: lines.map((l) => ({
      accountId: l.account_id, debit: m(l.credit), credit: m(l.debit), memo: l.memo ?? undefined,
      partner: l.partner_type && l.partner_id ? { type: l.partner_type, id: l.partner_id } : undefined, branchId: l.branch_id,
    })),
  });
}

// ── Catch-up: operations recorded before the ledger existed (or while posting was skipped) ─────
interface Source { type: string; label: string; sql: string; post: (db: Db, id: string) => Promise<unknown> }
export const SOURCES: Source[] = [
  { type: "pos_order", label: "طلبات المبيعات", post: postPosOrder, sql: `SELECT id, (created_at AT TIME ZONE '${RIYADH}')::date AS d FROM pos_orders` },
  { type: "pos_refund", label: "المرتجعات", post: postPosRefund, sql: `SELECT id, (created_at AT TIME ZONE '${RIYADH}')::date AS d FROM pos_refunds` },
  { type: "shift_close", label: "إغلاق الشفتات", post: postShiftClose, sql: `SELECT id, (closed_at AT TIME ZONE '${RIYADH}')::date AS d FROM pos_shifts WHERE status = 'closed' AND over_short <> 0` },
  // Before goods receipt notes: a received PO was one posting. Its carried-over (legacy) note is never posted again.
  { type: "purchase_receipt", label: "استلام المشتريات (قبل سندات الاستلام)", post: postPurchaseReceipt,
    sql: `SELECT p.id, (p.received_at AT TIME ZONE '${RIYADH}')::date AS d FROM purchase_orders p WHERE p.status = 'received' AND EXISTS (SELECT 1 FROM goods_receipts g WHERE g.purchase_order_id = p.id AND g.legacy)` },
  { type: "goods_receipt", label: "سندات استلام المشتريات", post: postGoodsReceipt, sql: "SELECT id, received_on AS d FROM goods_receipts WHERE NOT legacy AND total + vat_amount > 0" },
  { type: "transfer_shortage", label: "عجز التحويلات", post: postTransferShortage, sql: `SELECT id, (completed_at AT TIME ZONE '${RIYADH}')::date AS d FROM stock_transfers WHERE status = 'completed' AND round(shortage_value, 2) <> 0` },
  { type: "purchase_return", label: "مرتجعات المشتريات", post: postPurchaseReturn, sql: `SELECT id, (created_at AT TIME ZONE '${RIYADH}')::date AS d FROM purchase_returns` },
  { type: "supplier_payment", label: "دفعات الموردين", post: postSupplierPayment, sql: "SELECT id, paid_on AS d FROM supplier_payments" },
  { type: "expense", label: "المصروفات المعتمدة", post: postExpense, sql: "SELECT id, expense_date AS d FROM expenses WHERE status IN ('approved', 'paid')" },
  { type: "expense_payment", label: "سداد المصروفات", post: postExpensePayment, sql: `SELECT id, (paid_at AT TIME ZONE '${RIYADH}')::date AS d FROM expenses WHERE status = 'paid'` },
  { type: "waste", label: "الهدر", post: postWaste, sql: `SELECT id, (created_at AT TIME ZONE '${RIYADH}')::date AS d FROM waste_records WHERE total_cost > 0` },
  { type: "stocktake", label: "تسويات الجرد", post: postStocktake, sql: `SELECT id, (posted_at AT TIME ZONE '${RIYADH}')::date AS d FROM stocktakes WHERE status = 'posted' AND round(variance_value, 2) <> 0` },
  { type: "sales_document", label: "الفواتير والإشعارات", post: postSalesDocument, sql: "SELECT id, issue_date AS d FROM sales_documents" },
  { type: "customer_receipt", label: "سندات القبض", post: postCustomerReceipt, sql: "SELECT id, received_on AS d FROM customer_receipts" },
  { type: "payroll_run", label: "مسيرات الرواتب", post: postPayrollRun, sql: "SELECT id, (to_date(period || '-01', 'YYYY-MM-DD') + interval '1 month - 1 day')::date AS d FROM payroll_runs WHERE status <> 'draft'" },
  { type: "payroll_payment", label: "صرف الرواتب", post: postPayrollPayment, sql: "SELECT id, paid_on AS d FROM payroll_runs WHERE status = 'paid'" },
  { type: "final_settlement", label: "مخالصات نهاية الخدمة", post: postFinalSettlement, sql: "SELECT id, last_day AS d FROM final_settlements" },
  { type: "maintenance", label: "قطع غيار الصيانة", post: postMaintenanceOrder, sql: `SELECT id, (completed_at AT TIME ZONE '${RIYADH}')::date AS d FROM maintenance_orders WHERE status = 'done' AND parts_cost > 0` },
  { type: "delivery", label: "التسليمات ومرتجعات العملاء", post: postDelivery, sql: "SELECT id, delivered_on AS d FROM deliveries WHERE value > 0" },
  { type: "mo_event", label: "عمليات أوامر التشغيل", post: postMoEvent, sql: `SELECT id, (created_at AT TIME ZONE '${RIYADH}')::date AS d FROM mo_events WHERE wip_delta <> 0` },
];

const unpostedSql = (s: Source) =>
  `SELECT x.id, x.d::text AS d FROM (${s.sql}) x
    WHERE NOT EXISTS (SELECT 1 FROM journal_entries j WHERE j.source_key = '${s.type}:' || x.id::text)`;

export async function unposted(db: Db) {
  const lock = (await db.query<{ lock_date: string | null }>("SELECT lock_date::text FROM accounting_settings")).rows[0]?.lock_date ?? null;
  const out: { type: string; label: string; count: number; locked: number }[] = [];
  for (const s of SOURCES) {
    const rows = (await db.query<{ id: string; d: string }>(unpostedSql(s))).rows;
    if (rows.length) out.push({ type: s.type, label: s.label, count: rows.length, locked: lock ? rows.filter((r) => r.d <= lock).length : 0 });
  }
  return out;
}

/** Posts everything missing, oldest first. An operation dated inside a closed period is skipped and counted. */
export async function syncAll(db: Db) {
  const lock = (await db.query<{ lock_date: string | null }>("SELECT lock_date::text FROM accounting_settings")).rows[0]?.lock_date ?? null;
  let posted = 0;
  let skipped = 0;
  const todo: { s: Source; id: string; d: string }[] = [];
  for (const s of SOURCES) for (const r of (await db.query<{ id: string; d: string }>(unpostedSql(s))).rows) todo.push({ s, id: r.id, d: r.d });
  todo.sort((a, b) => a.d.localeCompare(b.d));
  for (const t of todo) {
    if (lock && t.d <= lock) { skipped++; continue; }
    if (await t.s.post(db, t.id)) posted++;
  }
  return { posted, skipped };
}
