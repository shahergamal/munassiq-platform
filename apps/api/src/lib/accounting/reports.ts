import type { Db } from "../../db/pool.ts";

/**
 * Financial statements read from the journal only (never from the operations directly), so every figure
 * traces to an entry. Amounts are returned in riyals with two decimals; sums are done in halalas.
 */

type Type = "asset" | "liability" | "equity" | "revenue" | "expense";
interface AccountRow { id: string; code: string; name: string; type: Type; parent_id: string | null; is_group: boolean; system_key: string | null; is_active: boolean }
const debitNormal = (t: Type) => t === "asset" || t === "expense";
const h = (v: string | number | null | undefined) => Math.round(Number(v ?? 0) * 100);
const r = (halalas: number) => Math.round(halalas) / 100;

async function accounts(db: Db) {
  return (await db.query<AccountRow>("SELECT id, code, name, type, parent_id, is_group, system_key, is_active FROM accounts ORDER BY code")).rows;
}

/** Root code of an account (the top-level group it belongs to: 1..6). */
function rootOf(all: Map<string, AccountRow>, a: AccountRow) {
  let cur = a;
  while (cur.parent_id && all.get(cur.parent_id)) cur = all.get(cur.parent_id)!;
  return cur.code;
}

/** Per account: debit and credit totals before `from`, and within [from, to]; optionally one cost center's lines only. */
async function movements(db: Db, from: string | null, to: string, costCenterId: string | null = null) {
  const rows = (await db.query<{ account_id: string; od: string; oc: string; pd: string; pc: string }>(
    `SELECT l.account_id,
            coalesce(sum(l.debit) FILTER (WHERE $1::date IS NOT NULL AND e.entry_date < $1::date), 0)::text AS od,
            coalesce(sum(l.credit) FILTER (WHERE $1::date IS NOT NULL AND e.entry_date < $1::date), 0)::text AS oc,
            coalesce(sum(l.debit) FILTER (WHERE $1::date IS NULL OR e.entry_date >= $1::date), 0)::text AS pd,
            coalesce(sum(l.credit) FILTER (WHERE $1::date IS NULL OR e.entry_date >= $1::date), 0)::text AS pc
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE e.entry_date <= $2::date AND ($3::uuid IS NULL OR l.cost_center_id = $3) GROUP BY l.account_id`, [from, to, costCenterId])).rows;
  return new Map(rows.map((x) => [x.account_id, { od: h(x.od), oc: h(x.oc), pd: h(x.pd), pc: h(x.pc) }]));
}

export async function trialBalance(db: Db, from: string, to: string, costCenterId: string | null = null) {
  const all = await accounts(db);
  const mv = await movements(db, from, to, costCenterId);
  const byId = new Map(all.map((a) => [a.id, a]));
  // Roll every leaf's figures up its parent chain so group rows show subtotals.
  const sums = new Map<string, { od: number; oc: number; pd: number; pc: number }>();
  for (const a of all) sums.set(a.id, { od: 0, oc: 0, pd: 0, pc: 0 });
  for (const [id, m] of mv) {
    let cur = byId.get(id);
    while (cur) {
      const s = sums.get(cur.id)!;
      s.od += m.od; s.oc += m.oc; s.pd += m.pd; s.pc += m.pc;
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
  }
  const net = (d: number, c: number) => ({ debit: r(Math.max(d - c, 0)), credit: r(Math.max(c - d, 0)) });
  const rows = all.map((a) => {
    const s = sums.get(a.id)!;
    const depth = (() => { let n = 0; let c = a; while (c.parent_id && byId.get(c.parent_id)) { n++; c = byId.get(c.parent_id)!; } return n; })();
    return {
      id: a.id, code: a.code, name: a.name, type: a.type, isGroup: a.is_group, depth,
      opening: net(s.od, s.oc), period: { debit: r(s.pd), credit: r(s.pc) }, closing: net(s.od + s.pd, s.oc + s.pc),
    };
  }).filter((x) => x.opening.debit || x.opening.credit || x.period.debit || x.period.credit);
  const leaves = rows.filter((x) => !x.isGroup);
  const tot = (f: (x: (typeof rows)[number]) => number) => r(leaves.reduce((a, x) => a + h(f(x)), 0));
  return {
    from, to, costCenterId, rows,
    totals: {
      opening: { debit: tot((x) => x.opening.debit), credit: tot((x) => x.opening.credit) },
      period: { debit: tot((x) => x.period.debit), credit: tot((x) => x.period.credit) },
      closing: { debit: tot((x) => x.closing.debit), credit: tot((x) => x.closing.credit) },
    },
  };
}

export async function incomeStatement(db: Db, from: string, to: string, costCenterId: string | null = null) {
  const all = await accounts(db);
  const byId = new Map(all.map((a) => [a.id, a]));
  const mv = await movements(db, from, to, costCenterId);
  const section = (pick: (a: AccountRow) => boolean, sign: 1 | -1) => {
    const lines = all.filter((a) => !a.is_group && pick(a)).map((a) => {
      const m = mv.get(a.id);
      const v = m ? (m.pc - m.pd) * sign : 0;
      return { id: a.id, code: a.code, name: a.name, amount: r(v) };
    }).filter((x) => x.amount !== 0);
    return { lines, total: r(lines.reduce((s, x) => s + h(x.amount), 0)) };
  };
  const revenue = section((a) => a.type === "revenue", 1);
  const cost = section((a) => a.type === "expense" && rootOf(byId, a) === "5", -1);
  const expenses = section((a) => a.type === "expense" && rootOf(byId, a) !== "5", -1);
  const gross = r(h(revenue.total) - h(cost.total));
  const netProfit = r(h(gross) - h(expenses.total));
  return {
    from, to, costCenterId, revenue, costOfSales: cost, grossProfit: gross, expenses, netProfit,
    grossMarginPercent: revenue.total ? Math.round((gross / revenue.total) * 10000) / 100 : null,
    netMarginPercent: revenue.total ? Math.round((netProfit / revenue.total) * 10000) / 100 : null,
  };
}

export async function balanceSheet(db: Db, asOf: string) {
  const all = await accounts(db);
  const mv = await movements(db, null, asOf);
  const bal = (a: AccountRow) => { const m = mv.get(a.id); if (!m) return 0; return debitNormal(a.type) ? m.pd - m.pc : m.pc - m.pd; };
  const group = (type: Type) => {
    const lines = all.filter((a) => !a.is_group && a.type === type).map((a) => ({ id: a.id, code: a.code, name: a.name, amount: r(bal(a)) })).filter((x) => x.amount !== 0);
    return { lines, total: r(lines.reduce((s, x) => s + h(x.amount), 0)) };
  };
  const assets = group("asset");
  const liabilities = group("liability");
  const equity = group("equity");
  // Profit not yet closed into retained earnings belongs to equity.
  const earnings = all.filter((a) => !a.is_group && (a.type === "revenue" || a.type === "expense"))
    .reduce((s, a) => s + (a.type === "revenue" ? bal(a) : -bal(a)), 0);
  const totalEquity = h(equity.total) + earnings;
  return {
    asOf, assets, liabilities, equity: { ...equity, currentEarnings: r(earnings), total: r(totalEquity) },
    liabilitiesAndEquity: r(h(liabilities.total) + totalEquity),
    balanced: h(assets.total) === h(liabilities.total) + totalEquity,
  };
}

export async function ledger(db: Db, accountId: string, from: string, to: string) {
  const a = (await db.query<AccountRow>("SELECT id, code, name, type, parent_id, is_group, system_key, is_active FROM accounts WHERE id = $1", [accountId])).rows[0];
  if (!a) return null;
  const ids = a.is_group
    ? (await db.query<{ id: string }>(
        `WITH RECURSIVE t AS (SELECT id FROM accounts WHERE id = $1 UNION ALL SELECT c.id FROM accounts c JOIN t ON c.parent_id = t.id) SELECT id FROM t`, [accountId])).rows.map((x) => x.id)
    : [accountId];
  const o = (await db.query<{ d: string; c: string }>(
    `SELECT coalesce(sum(l.debit), 0)::text AS d, coalesce(sum(l.credit), 0)::text AS c FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.account_id = ANY($1::uuid[]) AND e.entry_date < $2::date`, [ids, from])).rows[0]!;
  const sign = debitNormal(a.type) ? 1 : -1;
  let running = (h(o.d) - h(o.c)) * sign;
  const opening = r(running);
  const lines = (await db.query<{ entry_id: string; entry_number: string; entry_date: string; description: string; source_type: string; memo: string | null; debit: string; credit: string; partner: string | null }>(
    `SELECT e.id AS entry_id, e.entry_number::text, e.entry_date::text, e.description, e.source_type, l.memo, l.debit::text, l.credit::text,
            coalesce(c.name, s.name) AS partner
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       LEFT JOIN customers c ON l.partner_type = 'customer' AND c.id = l.partner_id
       LEFT JOIN suppliers s ON l.partner_type = 'supplier' AND s.id = l.partner_id
      WHERE l.account_id = ANY($1::uuid[]) AND e.entry_date BETWEEN $2::date AND $3::date
      ORDER BY e.entry_date, e.entry_number, l.id`, [ids, from, to])).rows.map((l) => {
    running += (h(l.debit) - h(l.credit)) * sign;
    return { entryId: l.entry_id, entryNumber: Number(l.entry_number), date: l.entry_date, description: l.description, sourceType: l.source_type, memo: l.memo, partner: l.partner, debit: Number(l.debit), credit: Number(l.credit), balance: r(running) };
  });
  return { account: { id: a.id, code: a.code, name: a.name, type: a.type }, from, to, opening, lines, closing: r(running) };
}

/**
 * Open items per customer (receivable) or supplier (payable), oldest first (FIFO): payments settle the oldest
 * amounts, and what remains is aged by its entry date.
 */
export async function aging(db: Db, kind: "receivable" | "payable", asOf: string) {
  const key = kind === "receivable" ? "ar" : "ap";
  const partnerType = kind === "receivable" ? "customer" : "supplier";
  const rows = (await db.query<{ partner_id: string; name: string; d: string; debit: string; credit: string }>(
    `SELECT l.partner_id, coalesce(c.name, s.name, '—') AS name, e.entry_date::text AS d, l.debit::text, l.credit::text
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
       LEFT JOIN customers c ON $2 = 'customer' AND c.id = l.partner_id
       LEFT JOIN suppliers s ON $2 = 'supplier' AND s.id = l.partner_id
      WHERE a.system_key = $1 AND l.partner_type = $2 AND e.entry_date <= $3::date
      ORDER BY l.partner_id, e.entry_date, e.entry_number`, [key, partnerType, asOf])).rows;
  const byPartner = new Map<string, { name: string; items: { d: string; amt: number }[]; pay: number }>();
  for (const x of rows) {
    const p = byPartner.get(x.partner_id) ?? { name: x.name, items: [], pay: 0 };
    // Receivable: debits are what the customer owes. Payable: credits are what we owe.
    const owe = kind === "receivable" ? h(x.debit) - h(x.credit) : h(x.credit) - h(x.debit);
    if (owe > 0) p.items.push({ d: x.d, amt: owe }); else p.pay += -owe;
    byPartner.set(x.partner_id, p);
  }
  const day = (d: string) => Date.parse(`${d}T00:00:00Z`);
  const now = day(asOf);
  const out = [...byPartner.entries()].map(([id, p]) => {
    let pay = p.pay;
    const b = { current: 0, d30: 0, d60: 0, d90: 0, over90: 0 };
    for (const it of p.items) {
      const used = Math.min(pay, it.amt);
      pay -= used;
      const open = it.amt - used;
      if (!open) continue;
      const age = Math.floor((now - day(it.d)) / 86_400_000);
      if (age <= 0) b.current += open; else if (age <= 30) b.d30 += open; else if (age <= 60) b.d60 += open; else if (age <= 90) b.d90 += open; else b.over90 += open;
    }
    const total = b.current + b.d30 + b.d60 + b.d90 + b.over90 - pay; // unapplied payments reduce the balance
    return { partnerId: id, name: p.name, current: r(b.current), d1_30: r(b.d30), d31_60: r(b.d60), d61_90: r(b.d90), over90: r(b.over90), unapplied: r(pay), total: r(total) };
  }).filter((x) => x.total !== 0).sort((a, b) => b.total - a.total);
  const sum = (k: keyof (typeof out)[number]) => r(out.reduce((s, x) => s + h(x[k] as number), 0));
  return { kind, asOf, items: out, totals: { current: sum("current"), d1_30: sum("d1_30"), d31_60: sum("d31_60"), d61_90: sum("d61_90"), over90: sum("over90"), unapplied: sum("unapplied"), total: sum("total") } };
}

/**
 * The ZATCA VAT return layout (boxes 1-16), computed from the tax documents of the period: point-of-sale
 * invoices and credit notes, issued invoices / debit / credit notes by VAT category, received purchases and
 * returns, and approved expenses. Credit notes and returns go to the adjustments column. It is a working paper
 * to fill the return on the ZATCA portal, not the filing itself.
 */
export async function vatReturn(db: Db, from: string, to: string) {
  const TZ = "Asia/Riyadh";
  const q = async (sql: string) => (await db.query<{ a: string; v: string }>(sql, [from, to])).rows[0] ?? { a: "0", v: "0" };
  const inRange = (col: string) => `(${col} AT TIME ZONE '${TZ}')::date BETWEEN $1::date AND $2::date`;
  const pos = await q(`SELECT coalesce(sum(taxable), 0)::text AS a, coalesce(sum(vat), 0)::text AS v FROM pos_orders WHERE ${inRange("created_at")}`);
  const posRefund = await q(`SELECT coalesce(sum(amount - vat_amount), 0)::text AS a, coalesce(sum(vat_amount), 0)::text AS v FROM pos_refunds WHERE ${inRange("created_at")}`);
  const docs = (await db.query<{ kind: string; cat: string; export: boolean; a: string; v: string }>(
    `SELECT d.kind, l.vat_category AS cat, coalesce(l.exemption_code IN ('VATEX-SA-32', 'VATEX-SA-33'), false) AS export, sum(l.net)::text AS a, sum(l.vat)::text AS v
       FROM sales_document_lines l JOIN sales_documents d ON d.id = l.document_id
      WHERE d.issue_date BETWEEN $1::date AND $2::date GROUP BY 1, 2, 3`, [from, to])).rows;
  const doc = (cat: string, exp: boolean | null, credit: boolean) => docs
    .filter((x) => x.cat === cat && (exp === null || x.export === exp) && (x.kind === "credit_note") === credit)
    .reduce((s, x) => ({ a: s.a + h(x.a), v: s.v + h(x.v) }), { a: 0, v: 0 });
  const purchases = await q(`SELECT coalesce(sum(total), 0)::text AS a, coalesce(sum(vat_amount), 0)::text AS v FROM goods_receipts WHERE vat_amount > 0 AND received_on BETWEEN $1::date AND $2::date`);
  const returns = await q(`SELECT coalesce(sum(total_value), 0)::text AS a, coalesce(sum(vat_amount), 0)::text AS v FROM purchase_returns WHERE vat_amount > 0 AND ${inRange("created_at")}`);
  // Advances deducted by final invoices of the period were declared on their prepayment invoices (386): out of box 1.
  const applied = await q(`SELECT coalesce(sum(a.taxable), 0)::text AS a, coalesce(sum(a.vat), 0)::text AS v FROM prepayment_applications a
                            JOIN sales_documents d ON d.id = a.invoice_id WHERE d.issue_date BETWEEN $1::date AND $2::date`);
  const expenses = await q(`SELECT coalesce(sum(amount_net), 0)::text AS a, coalesce(sum(vat_amount), 0)::text AS v FROM expenses WHERE status IN ('approved', 'paid') AND vat_amount > 0 AND expense_date BETWEEN $1::date AND $2::date`);
  // Subcontractors: a registered resident's invoices (the period's supply net of advance recovery and damages, whose
  // VAT was on the advance or is reduced) and advances go to box 7; a non-resident's are reverse-charged (box 9).
  const rate = `(SELECT vat_rate_percent FROM tenant_settings)`;
  const subIpc = (vat: "charged" | "reverse") => q(
    `SELECT coalesce(sum(i.current_gross - i.advance_recovery - i.ld_amount), 0)::text AS a,
            coalesce(sum(${vat === "charged" ? `i.vat - round((i.advance_recovery + i.ld_amount) * ${rate} / 100, 2)` : "i.reverse_charge_vat"}), 0)::text AS v
       FROM ipcs i JOIN contracts c ON c.id = i.contract_id
      WHERE c.role = 'SUB' AND i.status = 'invoiced' AND ${vat === "charged" ? "i.vat > 0" : "i.reverse_charge_vat > 0"}
        AND coalesce(i.supplier_invoice_date, i.period_to) BETWEEN $1::date AND $2::date`);
  const subAdv = (vat: "charged" | "reverse") => q(
    `SELECT coalesce(sum(taxable), 0)::text AS a, coalesce(sum(${vat === "charged" ? "vat" : "reverse_charge_vat"}), 0)::text AS v FROM subcontract_advances
      WHERE ${vat === "charged" ? "vat > 0" : "reverse_charge_vat > 0"} AND advance_date BETWEEN $1::date AND $2::date`);
  const subs = [await subIpc("charged"), await subAdv("charged")];
  const rcm = [await subIpc("reverse"), await subAdv("reverse")];
  const sum2 = (xs: { a: string; v: string }[]) => ({ a: xs.reduce((s, x) => s + h(x.a), 0), v: xs.reduce((s, x) => s + h(x.v), 0) });
  const sub = sum2(subs);
  const rc = sum2(rcm);

  const S = doc("S", null, false); const Sc = doc("S", null, true);
  const Zd = doc("Z", false, false); const Zdc = doc("Z", false, true);
  const Zx = doc("Z", true, false); const Zxc = doc("Z", true, true);
  const E = doc("E", null, false); const Ec = doc("E", null, true);
  const box = (no: number, label: string, amount: number, adjustment: number, vat: number | null) => ({ no, label, amount: r(amount), adjustment: r(adjustment), vat: vat === null ? null : r(vat) });
  const sales = [
    box(1, "المبيعات الخاضعة للنسبة الأساسية", h(pos.a) + S.a, -(h(posRefund.a) + Sc.a + h(applied.a)), h(pos.v) + S.v - h(posRefund.v) - Sc.v - h(applied.v)),
    box(2, "المبيعات للمواطنين (الخدمات الصحية الخاصة / التعليم الأهلي / المسكن الأول)", 0, 0, 0),
    box(3, "المبيعات المحلية الخاضعة للنسبة الصفرية", Zd.a, -Zdc.a, null),
    box(4, "الصادرات", Zx.a, -Zxc.a, null),
    box(5, "المبيعات المعفاة", E.a, -Ec.a, null),
  ];
  const salesTotal = box(6, "إجمالي المبيعات", sales.reduce((s, b) => s + h(b.amount), 0), sales.reduce((s, b) => s + h(b.adjustment), 0), sales.reduce((s, b) => s + h(b.vat ?? 0), 0));
  const buys = [
    box(7, "المشتريات الخاضعة للنسبة الأساسية", h(purchases.a) + h(expenses.a) + sub.a, -h(returns.a), h(purchases.v) + h(expenses.v) + sub.v - h(returns.v)),
    box(8, "الاستيرادات الخاضعة لضريبة القيمة المضافة التي تدفع في الجمارك", 0, 0, 0),
    box(9, "الاستيرادات الخاضعة للضريبة وتطبق عليها آلية الاحتساب العكسي", rc.a, 0, rc.v),
    box(10, "المشتريات الخاضعة للنسبة الصفرية", 0, 0, null),
    box(11, "المشتريات المعفاة", 0, 0, null),
  ];
  const buysTotal = box(12, "إجمالي المشتريات", buys.reduce((s, b) => s + h(b.amount), 0), buys.reduce((s, b) => s + h(b.adjustment), 0), buys.reduce((s, b) => s + h(b.vat ?? 0), 0));
  // Reverse-charged VAT is due as output and deducted as input (box 9): no net effect when fully deductible.
  const due = h(salesTotal.vat ?? 0) + rc.v - h(buysTotal.vat ?? 0);
  return {
    from, to, sales, salesTotal, purchases: buys, purchasesTotal: buysTotal,
    vatDue: r(due),
    notes: [
      "البنود 13 إلى 16 (إجمالي الضريبة المستحقة، التصحيحات من الفترات السابقة، الرصيد الدائن المرحّل، صافي الضريبة) تُستكمل في بوابة الزكاة والضريبة.",
      "المشتريات من موردين غير مسجلين في ضريبة القيمة المضافة لا تظهر في الإقرار.",
      "ضريبة الاحتساب العكسي (البند 9) تُستحق مخرجاتٍ وتُخصم مدخلاتٍ بالمبلغ نفسه، فصافي أثرها صفر عند الخصم الكامل.",
      "هذه ورقة عمل لتعبئة الإقرار في بوابة هيئة الزكاة والضريبة والجمارك، وليست تقديماً للإقرار.",
    ],
  };
}
