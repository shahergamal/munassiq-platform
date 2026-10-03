import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { post, reverse, syncAll, unposted, type Line } from "../../lib/accounting/posting.ts";
import { aging, balanceSheet, incomeStatement, ledger, trialBalance, vatReturn } from "../../lib/accounting/reports.ts";
import { AppError, badRequest, notFound } from "../../lib/errors.ts";
import { parseMoney, riyal } from "../../lib/money.ts";
import { pageMeta, parsePage } from "../../lib/pagination.ts";
import { auditTenant, isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";
import { idempotencyKey } from "./purchases.ts";

const TZ = "Asia/Riyadh";
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
const date = z.string().regex(ISO, "تاريخ غير صحيح");

/**
 * Fiscal year `year` (named by the calendar year it ends in) for a year starting in `startMonth`:
 * start 1 → Jan..Dec of `year`; start 7 → 1 Jul (year-1) .. 30 Jun (year).
 */
export function fiscalYear(year: number, startMonth: number): { from: string; to: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  if (startMonth === 1) return { from: `${year}-01-01`, to: `${year}-12-31` };
  const endMonth = startMonth - 1;
  const last = new Date(Date.UTC(year, endMonth, 0)).getUTCDate();
  return { from: `${year - 1}-${pad(startMonth)}-01`, to: `${year}-${pad(endMonth)}-${pad(last)}` };
}

/** The fiscal year a date falls in. */
export function fiscalYearOf(d: string, startMonth: number): number {
  const y = Number(d.slice(0, 4));
  return startMonth === 1 || Number(d.slice(5, 7)) < startMonth ? y : y + 1;
}

const costCenterParam = (q: { costCenterId?: string }) => (isUuid(q.costCenterId) ? q.costCenterId : null);

/** from/to (YYYY-MM-DD); default: this month to date. */
function period(q: { from?: string; to?: string }) {
  const t = today();
  const from = ISO.test(q.from ?? "") ? q.from! : `${t.slice(0, 7)}-01`;
  const to = ISO.test(q.to ?? "") ? q.to! : t;
  if (from > to) throw badRequest("تاريخ البداية بعد تاريخ النهاية");
  return { from, to };
}

const SOURCE_LABEL: Record<string, string> = {
  manual: "قيد يدوي", opening: "قيد افتتاحي", reversal: "قيد عكسي", year_close: "إقفال السنة", vat_settlement: "تسوية الضريبة",
  pos_order: "مبيعات نقاط البيع", pos_refund: "مرتجع مبيعات", shift_close: "إغلاق شفت", purchase_receipt: "استلام مشتريات", purchase_return: "مرتجع مشتريات",
  supplier_payment: "دفعة مورد", expense: "مصروف", expense_payment: "سداد مصروف", waste: "هدر", stocktake: "تسوية جرد",
  sales_document: "فاتورة / إشعار", customer_receipt: "سند قبض", mo_event: "أمر تشغيل", delivery: "تسليم / مرتجع عميل", maintenance: "صيانة", payroll_run: "مسير رواتب", payroll_payment: "صرف رواتب", final_settlement: "مخالصة نهاية خدمة", bank_guarantee: "عمولة ضمان بنكي", sub_ipc: "مستخلص مقاول باطن", sub_advance: "دفعة مقدمة لمقاول باطن", retention_release: "إفراج عن محتجزات", contract_close: "إقفال شهري لعقد", site_issue: "صرف مواد لمشروع", equipment_timesheet: "تحميل معدات على مشروع", labor_allocation: "تحميل رواتب على المشاريع",
};

export default async function accountingRoutes(app: FastifyInstance) {
  // ── Dashboard ───────────────────────────────────────────────────────────────────────────────
  app.get("/accounting/summary", { preHandler: requireTenant("acc_overview.view") }, async (req) =>
    tenantTx(req, async (db) => {
      const t = today();
      const bal = (await db.query<{ key: string; d: number }>(
        `SELECT a.system_key AS key, coalesce(sum(l.debit - l.credit), 0)::float8 AS d
           FROM accounts a LEFT JOIN journal_lines l ON l.account_id = a.id
          WHERE a.system_key IN ('cash', 'bank', 'card_clearing', 'platform_receivable', 'ar', 'ap', 'accrued_expenses', 'inventory', 'vat_output', 'vat_input', 'vat_payable',
                                 'inventory_semi', 'inventory_finished', 'inventory_packaging', 'inventory_consumable', 'inventory_spare', 'wip')
          GROUP BY a.system_key`)).rows;
      const b = (k: string) => bal.find((x) => x.key === k)?.d ?? 0;
      // A factory values stock in several accounts (raw, semi-finished, finished, work in progress…): one figure here.
      const stock = bal.filter((x) => x.key === "inventory" || x.key === "wip" || x.key.startsWith("inventory_")).reduce((a, x) => a + x.d, 0);
      const month = await incomeStatement(db, `${t.slice(0, 7)}-01`, t);
      const settings = (await db.query<{ lock_date: string | null }>("SELECT lock_date::text FROM accounting_settings")).rows[0];
      return {
        cash: b("cash") + b("bank"), cardClearing: b("card_clearing"), platformReceivable: b("platform_receivable"),
        receivables: b("ar"), payables: -(b("ap") + b("accrued_expenses")), inventory: Math.round(stock * 100) / 100,
        vatDue: -(b("vat_output") + b("vat_input") + b("vat_payable")),
        month: { from: month.from, to: month.to, revenue: month.revenue.total, grossProfit: month.grossProfit, netProfit: month.netProfit },
        lockDate: settings?.lock_date ?? null,
        unposted: await unposted(db),
      };
    }, { readOnly: true }));

  // ── Chart of accounts ───────────────────────────────────────────────────────────────────────
  app.get("/accounts", { preHandler: requireTenant("acc_accounts.view", "acc_journal.view", "acc_journal.create", "acc_reports.view", "acc_settings.view", "acc_receipts.create") }, async (req) =>
    tenantTx(req, async (db) => ({
      items: (await db.query(
        `SELECT a.id, a.code, a.name, a.type, a.parent_id AS "parentId", a.is_group AS "isGroup", a.system_key AS "systemKey", a.is_active AS "isActive",
                coalesce((SELECT sum(l.debit - l.credit) FROM journal_lines l WHERE l.account_id = a.id), 0)::float8 AS "netDebit",
                EXISTS (SELECT 1 FROM journal_lines l WHERE l.account_id = a.id) AS "hasEntries"
           FROM accounts a ORDER BY a.code`)).rows,
    }), { readOnly: true }));

  app.post("/accounts", { preHandler: requireTenant("acc_accounts.create") }, async (req, reply) => {
    const b = z.object({
      code: z.string().trim().regex(/^[0-9]{1,10}$/, "رقم الحساب أرقام فقط (حتى 10 خانات)"),
      name: z.string().trim().min(2, "أدخل اسم الحساب").max(120),
      parentId: z.string().uuid("اختر الحساب الرئيسي"),
      isGroup: z.boolean().default(false),
    }).parse(req.body);
    const id = await tenantTx(req, async (db) => {
      const parent = (await db.query<{ code: string; type: string; is_group: boolean }>("SELECT code, type, is_group FROM accounts WHERE id = $1", [b.parentId])).rows[0];
      if (!parent) throw notFound("الحساب الرئيسي غير موجود");
      if (!parent.is_group) throw badRequest("الحساب الأب يجب أن يكون حساباً رئيسياً (تجميعياً)");
      if (!b.code.startsWith(parent.code) || b.code === parent.code) throw badRequest(`رقم الحساب يبدأ برقم الحساب الرئيسي ${parent.code}`);
      try {
        const r = await db.query<{ id: string }>(
          "INSERT INTO accounts (tenant_id, code, name, type, parent_id, is_group) VALUES (app_tenant_id(), $1, $2, $3, $4, $5) RETURNING id",
          [b.code, b.name, parent.type, b.parentId, b.isGroup]);
        await auditTenant(db, req, "account.created", "account", r.rows[0]!.id, { code: b.code, name: b.name });
        return r.rows[0]!.id;
      } catch (err) {
        if ((err as { code?: string }).code === "23505") throw new AppError(409, "account_exists", "يوجد حساب بنفس الرقم");
        throw err;
      }
    });
    return reply.status(201).send({ id });
  });

  app.patch("/accounts/:id", { preHandler: requireTenant("acc_accounts.edit") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ name: z.string().trim().min(2).max(120).optional(), isActive: z.boolean().optional() }).parse(req.body);
    await tenantTx(req, async (db) => {
      const a = (await db.query<{ system_key: string | null; bal: string }>(
        "SELECT system_key, coalesce((SELECT sum(debit - credit) FROM journal_lines WHERE account_id = a.id), 0)::text AS bal FROM accounts a WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!a) throw notFound();
      if (b.isActive === false) {
        if (a.system_key) throw new AppError(409, "system_account", "هذا حساب تستخدمه القيود التلقائية ولا يمكن إيقافه. يمكنك تغيير اسمه");
        if (Number(a.bal) !== 0) throw new AppError(409, "account_has_balance", "لا يمكن إيقاف حساب له رصيد. انقل رصيده بقيد أولاً");
      }
      await db.query("UPDATE accounts SET name = coalesce($2, name), is_active = coalesce($3, is_active) WHERE id = $1", [id, b.name ?? null, b.isActive ?? null]);
      await auditTenant(db, req, "account.updated", "account", id, b);
    });
    return { ok: true };
  });

  app.get("/accounting/expense-categories", { preHandler: requireTenant("acc_settings.view") }, async (req) =>
    tenantTx(req, async (db) => ({
      items: (await db.query(
        `SELECT c.id, c.name, c.is_active AS "isActive", c.account_id AS "accountId", a.code AS "accountCode", a.name AS "accountName"
           FROM expense_categories c LEFT JOIN accounts a ON a.id = c.account_id ORDER BY c.name`)).rows,
    }), { readOnly: true }));

  app.put("/accounting/expense-categories/:id", { preHandler: requireTenant("acc_settings.manage") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const { accountId } = z.object({ accountId: z.string().uuid() }).parse(req.body);
    await tenantTx(req, async (db) => {
      const a = (await db.query<{ type: string; is_group: boolean }>("SELECT type, is_group FROM accounts WHERE id = $1 AND is_active", [accountId])).rows[0];
      if (!a || a.type !== "expense" || a.is_group) throw badRequest("اختر حساب مصروفات فرعياً نشطاً");
      const r = await db.query("UPDATE expense_categories SET account_id = $2 WHERE id = $1", [id, accountId]);
      if (!r.rowCount) throw notFound();
      await auditTenant(db, req, "expense_category.account_mapped", "expense_category", id, { accountId });
    });
    return { ok: true };
  });

  // ── Journal ─────────────────────────────────────────────────────────────────────────────────
  app.get("/accounting/journal", { preHandler: requireTenant("acc_journal.view") }, async (req) => {
    const q = req.query as { from?: string; to?: string; source?: string; q?: string; page?: string; pageSize?: string };
    const { from, to } = period(q);
    const page = parsePage(q);
    const source = /^[a-z_]{2,40}$/.test(q.source ?? "") ? q.source : null;
    const search = q.q?.trim() ? `%${q.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    return tenantTx(req, async (db) => {
      const { rows } = await db.query(
        `SELECT e.id, e.entry_number::int AS "number", e.entry_date::text AS date, e.description, e.source_type AS "sourceType",
                e.reversal_of AS "reversalOf", EXISTS (SELECT 1 FROM journal_entries x WHERE x.reversal_of = e.id) AS "reversed",
                (SELECT sum(debit) FROM journal_lines l WHERE l.entry_id = e.id)::float8 AS amount,
                count(*) OVER()::int AS "_total"
           FROM journal_entries e
          WHERE e.entry_date BETWEEN $1::date AND $2::date AND ($3::text IS NULL OR e.source_type = $3)
            AND ($4::text IS NULL OR e.description ILIKE $4 OR e.entry_number::text = trim(both '%' from $4))
          ORDER BY e.entry_date DESC, e.entry_number DESC LIMIT $5 OFFSET $6`, [from, to, source, search, page.pageSize, page.offset]);
      return { from, to, items: rows.map(({ _total, ...r }) => ({ ...r, sourceLabel: SOURCE_LABEL[r.sourceType as string] ?? r.sourceType })), meta: pageMeta(page, rows[0]?._total ?? 0) };
    }, { readOnly: true });
  });

  app.get("/accounting/journal/:id", { preHandler: requireTenant("acc_journal.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const e = (await db.query(
        `SELECT e.id, e.entry_number::int AS "number", e.entry_date::text AS date, e.description, e.source_type AS "sourceType", e.source_id AS "sourceId",
                e.reversal_of AS "reversalOf", (SELECT x.id FROM journal_entries x WHERE x.reversal_of = e.id) AS "reversedBy", e.created_at AS "createdAt"
           FROM journal_entries e WHERE e.id = $1`, [id])).rows[0];
      if (!e) throw notFound("القيد غير موجود");
      const lines = (await db.query(
        `SELECT l.id, a.id AS "accountId", a.code AS "accountCode", a.name AS "accountName", l.debit::float8 AS debit, l.credit::float8 AS credit, l.memo,
                l.partner_type AS "partnerType", coalesce(c.name, s.name) AS "partnerName", b.name AS "branchName", cc.name AS "costCenterName"
           FROM journal_lines l JOIN accounts a ON a.id = l.account_id
           LEFT JOIN cost_centers cc ON cc.id = l.cost_center_id
           LEFT JOIN customers c ON l.partner_type = 'customer' AND c.id = l.partner_id
           LEFT JOIN suppliers s ON l.partner_type = 'supplier' AND s.id = l.partner_id
           LEFT JOIN branches b ON b.id = l.branch_id
          WHERE l.entry_id = $1 ORDER BY l.debit DESC, a.code`, [id])).rows;
      return { ...e, sourceLabel: SOURCE_LABEL[e.sourceType as string] ?? e.sourceType, lines };
    }, { readOnly: true });
  });

  const lineSchema = z.object({
    accountId: z.string().uuid("اختر الحساب"),
    debit: z.number().min(0).max(100_000_000).default(0),
    credit: z.number().min(0).max(100_000_000).default(0),
    memo: z.string().trim().max(300).nullable().optional().transform((v) => v || null),
    partnerType: z.enum(["customer", "supplier"]).nullable().optional().transform((v) => v ?? null),
    partnerId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
    branchId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
    costCenterId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
  }).refine((l) => (l.debit > 0) !== (l.credit > 0), "كل سطر إما مدين أو دائن بمبلغ أكبر من صفر")
    .refine((l) => (l.partnerType === null) === (l.partnerId === null), "اختر العميل أو المورد");

  app.post("/accounting/journal", { preHandler: requireTenant("acc_journal.create") }, async (req, reply) => {
    const key = idempotencyKey(req);
    const b = z.object({
      date,
      description: z.string().trim().min(2, "اكتب بيان القيد").max(300),
      // An opening entry: whatever does not balance goes to "opening balances" (equity).
      opening: z.boolean().default(false),
      lines: z.array(lineSchema).min(1, "أضف سطرين على الأقل").max(200),
    }).parse(req.body);
    const out = await tenantTx(req, async (db) => {
      const dup = (await db.query<{ id: string }>("SELECT id FROM journal_entries WHERE idempotency_key = $1", [key])).rows[0];
      if (dup) return { id: dup.id, replay: true };
      for (const l of b.lines) {
        if (!l.partnerId) continue;
        const table = l.partnerType === "customer" ? "customers" : "suppliers";
        if (!(await db.query(`SELECT 1 FROM ${table} WHERE id = $1`, [l.partnerId])).rowCount) throw notFound(l.partnerType === "customer" ? "العميل غير موجود" : "المورد غير موجود");
      }
      const centers = [...new Set(b.lines.map((l) => l.costCenterId).filter((x): x is string => Boolean(x)))];
      if (centers.length && (await db.query("SELECT 1 FROM cost_centers WHERE id = ANY($1::uuid[]) AND is_active", [centers])).rowCount !== centers.length) {
        throw badRequest("مركز تكلفة غير موجود أو موقوف");
      }
      const lines: Line[] = b.lines.map((l) => ({
        accountId: l.accountId, debit: parseMoney(l.debit), credit: parseMoney(l.credit), memo: l.memo ?? undefined,
        partner: l.partnerType && l.partnerId ? { type: l.partnerType, id: l.partnerId } : undefined, branchId: l.branchId, costCenterId: l.costCenterId,
      }));
      const diff = lines.reduce((s, l) => s + (l.debit ?? 0) - (l.credit ?? 0), 0);
      if (b.opening && diff !== 0) lines.push({ key: "opening_balance", ...(diff > 0 ? { credit: diff } : { debit: -diff }), memo: "فرق الأرصدة الافتتاحية" });
      else if (diff !== 0) throw new AppError(422, "journal_unbalanced", `القيد غير متوازن: الفرق ${riyal(Math.abs(diff))}`);
      if (lines.length < 2) throw badRequest("القيد يحتاج سطرين على الأقل");
      const id = await post(db, { date: b.date, description: b.description, sourceType: b.opening ? "opening" : "manual", sourceId: null, sourceKey: null, lines, idempotencyKey: key });
      await auditTenant(db, req, "journal.posted", "journal_entry", id!, { date: b.date, opening: b.opening });
      return { id: id!, replay: false };
    });
    return reply.status(out.replay ? 200 : 201).send({ id: out.id });
  });

  app.post("/accounting/journal/:id/reverse", { preHandler: requireTenant("acc_journal.reverse") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const key = idempotencyKey(req);
    const b = z.object({ date: date.optional(), reason: z.string().trim().min(3, "اكتب سبب العكس").max(200) }).parse(req.body);
    const out = await tenantTx(req, async (db) => {
      const dup = (await db.query<{ id: string }>("SELECT id FROM journal_entries WHERE idempotency_key = $1", [key])).rows[0];
      if (dup) return dup.id;
      const e = (await db.query<{ source_type: string }>("SELECT source_type FROM journal_entries WHERE id = $1", [id])).rows[0];
      if (!e) throw notFound("القيد غير موجود");
      // Automatic entries follow their documents: correct the document (refund, credit note, return) instead.
      if (e.source_type !== "manual" && e.source_type !== "opening") throw new AppError(409, "automatic_entry", "هذا قيد تلقائي مرتبط بعملية. صحّحه من العملية نفسها (مرتجع، إشعار دائن، ...)");
      if ((await db.query("SELECT 1 FROM journal_entries WHERE reversal_of = $1", [id])).rowCount) throw new AppError(409, "already_reversed", "تم عكس هذا القيد من قبل");
      const rid = await reverse(db, id, b.date ?? today(), b.reason, null, key);
      await auditTenant(db, req, "journal.reversed", "journal_entry", id, { reversal: rid, reason: b.reason });
      return rid!;
    });
    return reply.status(201).send({ id: out });
  });

  // ── Catch-up, period lock, year-end ─────────────────────────────────────────────────────────
  app.post("/accounting/sync", { preHandler: requireTenant("acc_settings.manage") }, async (req) =>
    tenantTx(req, async (db) => {
      const r = await syncAll(db);
      await auditTenant(db, req, "accounting.synced", "journal_entry", "00000000-0000-0000-0000-000000000000", r);
      return r;
    }));

  app.put("/accounting/lock", { preHandler: requireTenant("acc_settings.manage") }, async (req) => {
    const { lockDate } = z.object({ lockDate: date.nullable() }).parse(req.body);
    if (lockDate && lockDate >= today()) throw badRequest("تاريخ الإقفال يجب أن يكون قبل اليوم");
    await tenantTx(req, async (db) => {
      const before = (await db.query<{ lock_date: string | null }>("SELECT lock_date::text FROM accounting_settings FOR UPDATE")).rows[0]?.lock_date ?? null;
      await db.query(
        `INSERT INTO accounting_settings (tenant_id, lock_date) VALUES (app_tenant_id(), $1)
         ON CONFLICT (tenant_id) DO UPDATE SET lock_date = EXCLUDED.lock_date`, [lockDate]);
      await auditTenant(db, req, "accounting.lock_changed", "accounting_settings", "00000000-0000-0000-0000-000000000000", { from: before, to: lockDate });
    });
    return { ok: true };
  });

  app.post("/accounting/close-year", { preHandler: requireTenant("acc_settings.manage") }, async (req, reply) => {
    const { year } = z.object({ year: z.number().int().min(2000).max(2100) }).parse(req.body);
    const out = await tenantTx(req, async (db) => {
      const startMonth = (await db.query<{ m: number }>("SELECT fiscal_year_start_month AS m FROM accounting_settings")).rows[0]?.m ?? 1;
      const { from: start, to: end } = fiscalYear(year, startMonth);
      if (end >= today()) throw badRequest("تُقفل السنة بعد انتهائها");
      const is = await incomeStatement(db, start, end);
      const bal = (await db.query<{ id: string; type: string; net: string }>(
        `SELECT a.id, a.type, sum(l.credit - l.debit)::text AS net FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
          WHERE a.type IN ('revenue', 'expense') AND e.entry_date BETWEEN $1::date AND $2::date GROUP BY a.id, a.type HAVING sum(l.credit - l.debit) <> 0`,
        [start, end])).rows;
      // Revenue and expense accounts go to zero; the difference (the year's profit or loss) moves to retained earnings.
      const lines: Line[] = bal.map((x) => { const n = Math.round(Number(x.net) * 100); return n > 0 ? { accountId: x.id, debit: n } : { accountId: x.id, credit: -n }; });
      const diff = lines.reduce((s, l) => s + (l.debit ?? 0) - (l.credit ?? 0), 0);
      if (diff) lines.push({ key: "retained_earnings", ...(diff > 0 ? { credit: diff } : { debit: -diff }) });
      const id = lines.length >= 2 ? await post(db, { date: end, description: `إقفال السنة المالية ${year}: ترحيل صافي ${is.netProfit >= 0 ? "الربح" : "الخسارة"} إلى الأرباح المبقاة`, sourceType: "year_close", sourceId: null, sourceKey: `year_close:${year}`, lines }) : null;
      await db.query(
        `INSERT INTO accounting_settings (tenant_id, lock_date) VALUES (app_tenant_id(), $1)
         ON CONFLICT (tenant_id) DO UPDATE SET lock_date = GREATEST(accounting_settings.lock_date, EXCLUDED.lock_date)`, [end]);
      await auditTenant(db, req, "accounting.year_closed", "journal_entry", id ?? "00000000-0000-0000-0000-000000000000", { year, netProfit: is.netProfit });
      return { id, netProfit: is.netProfit, lockDate: end };
    });
    return reply.status(201).send(out);
  });

  /** Moves the period's output and input VAT into "VAT payable", ready to settle with ZATCA. */
  app.post("/accounting/vat-settlement", { preHandler: requireTenant("acc_settings.manage") }, async (req, reply) => {
    const b = z.object({ from: date, to: date }).parse(req.body);
    if (b.from > b.to || b.to >= today()) throw badRequest("اختر فترة منتهية");
    const out = await tenantTx(req, async (db) => {
      const v = (await db.query<{ key: string; net: string }>(
        `SELECT a.system_key AS key, coalesce(sum(l.credit - l.debit), 0)::text AS net FROM accounts a
           JOIN journal_lines l ON l.account_id = a.id JOIN journal_entries e ON e.id = l.entry_id
          WHERE a.system_key IN ('vat_output', 'vat_input') AND e.entry_date BETWEEN $1::date AND $2::date AND e.source_type <> 'vat_settlement'
          GROUP BY a.system_key`, [b.from, b.to])).rows;
      const outNet = Math.round(Number(v.find((x) => x.key === "vat_output")?.net ?? 0) * 100);
      const inNet = -Math.round(Number(v.find((x) => x.key === "vat_input")?.net ?? 0) * 100);
      const lines: Line[] = [
        outNet >= 0 ? { key: "vat_output", debit: outNet } : { key: "vat_output", credit: -outNet },
        inNet >= 0 ? { key: "vat_input", credit: inNet } : { key: "vat_input", debit: -inNet },
      ];
      const due = outNet - inNet;
      lines.push(due >= 0 ? { key: "vat_payable", credit: due } : { key: "vat_payable", debit: -due });
      const id = await post(db, { date: b.to, description: `تسوية ضريبة القيمة المضافة من ${b.from} إلى ${b.to}`, sourceType: "vat_settlement", sourceId: null, sourceKey: `vat_settlement:${b.from}:${b.to}`, lines });
      if (!id) throw new AppError(409, "already_settled", "هذه الفترة سُوّيت من قبل أو لا توجد عليها ضريبة");
      await auditTenant(db, req, "accounting.vat_settled", "journal_entry", id, { ...b, due: due / 100 });
      return { id, vatDue: due / 100 };
    });
    return reply.status(201).send(out);
  });

  // ── Reports ─────────────────────────────────────────────────────────────────────────────────
  app.get("/accounting/trial-balance", { preHandler: requireTenant("acc_reports.view") }, async (req) => {
    const q = req.query as { from?: string; to?: string; costCenterId?: string };
    const { from, to } = period(q);
    return tenantTx(req, (db) => trialBalance(db, from, to, costCenterParam(q)), { readOnly: true });
  });
  app.get("/accounting/income-statement", { preHandler: requireTenant("acc_reports.view", "cost_centers.view") }, async (req) => {
    const q = req.query as { from?: string; to?: string; costCenterId?: string };
    const { from, to } = period(q);
    // A member who sees cost centers but not the financial reports gets one cost center's statement only.
    const cc = costCenterParam(q);
    if (!cc && !req.tenant!.permissions.includes("acc_reports.view")) throw badRequest("اختر مركز التكلفة");
    return tenantTx(req, (db) => incomeStatement(db, from, to, cc), { readOnly: true });
  });
  app.get("/accounting/balance-sheet", { preHandler: requireTenant("acc_reports.view") }, async (req) => {
    const asOf = ISO.test((req.query as { asOf?: string }).asOf ?? "") ? (req.query as { asOf: string }).asOf : today();
    return tenantTx(req, (db) => balanceSheet(db, asOf), { readOnly: true });
  });
  app.get("/accounting/ledger", { preHandler: requireTenant("acc_reports.view", "acc_accounts.view") }, async (req) => {
    const q = req.query as { accountId?: string; from?: string; to?: string };
    if (!isUuid(q.accountId)) throw badRequest("اختر الحساب");
    const { from, to } = period(q);
    const out = await tenantTx(req, (db) => ledger(db, q.accountId!, from, to), { readOnly: true });
    if (!out) throw notFound("الحساب غير موجود");
    return out;
  });
  app.get("/accounting/aging", { preHandler: requireTenant("acc_reports.view") }, async (req) => {
    const q = req.query as { kind?: string; asOf?: string };
    const kind = q.kind === "payable" ? "payable" : "receivable";
    const asOf = ISO.test(q.asOf ?? "") ? q.asOf! : today();
    return tenantTx(req, (db) => aging(db, kind, asOf), { readOnly: true });
  });
  app.get("/accounting/vat-return", { preHandler: requireTenant("acc_reports.view") }, async (req) => {
    const { from, to } = period(req.query as { from?: string; to?: string });
    return tenantTx(req, (db) => vatReturn(db, from, to), { readOnly: true });
  });

  // ── Cost centers ────────────────────────────────────────────────────────────────────────────
  // A second axis next to the branch (a production line, a department, a project): picked on manual entries and
  // expenses, and filters the trial balance and the income statement.
  app.get("/cost-centers", { preHandler: requireTenant("cost_centers.view", "acc_journal.create", "expenses.create", "acc_reports.view") }, async (req) =>
    tenantTx(req, async (db) => ({
      items: (await db.query(
        `SELECT c.id, c.code, c.name, c.kind, c.is_active AS "isActive",
                (SELECT count(*)::int FROM journal_lines l WHERE l.cost_center_id = c.id) AS "linesCount"
           FROM cost_centers c ORDER BY c.is_active DESC, c.code`)).rows,
    }), { readOnly: true }));

  const costCenterBody = z.object({
    code: z.string().trim().regex(/^[A-Za-z0-9-]{1,20}$/, "الرمز حروف إنجليزية وأرقام وشرطة (حتى 20)").transform((v) => v.toUpperCase()),
    name: z.string().trim().min(2, "أدخل اسم مركز التكلفة").max(120),
    kind: z.enum(["production", "service", "department", "project"]).default("department"),
  });

  app.post("/cost-centers", { preHandler: requireTenant("cost_centers.create") }, async (req, reply) => {
    const b = costCenterBody.parse(req.body);
    const id = await tenantTx(req, async (db) => {
      try {
        const r = (await db.query<{ id: string }>("INSERT INTO cost_centers (tenant_id, code, name, kind) VALUES (app_tenant_id(), $1, $2, $3) RETURNING id", [b.code, b.name, b.kind])).rows[0]!;
        await auditTenant(db, req, "cost_center.created", "cost_center", r.id, b);
        return r.id;
      } catch (e) {
        if ((e as { code?: string }).code === "23505") throw new AppError(409, "duplicate", "يوجد مركز تكلفة بنفس الرمز", [{ path: "code", message: "رمز مستخدم" }]);
        throw e;
      }
    });
    return reply.status(201).send({ id });
  });

  // Renaming and stopping only: the code is on posted lines, and a center with lines is never deleted.
  app.patch("/cost-centers/:id", { preHandler: requireTenant("cost_centers.edit") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ name: costCenterBody.shape.name.optional(), kind: costCenterBody.shape.kind.optional(), isActive: z.boolean().optional() })
      .refine((x) => Object.keys(x).length > 0, "لا توجد تغييرات").parse(req.body);
    await tenantTx(req, async (db) => {
      const r = await db.query("UPDATE cost_centers SET name = coalesce($2, name), kind = coalesce($3, kind), is_active = coalesce($4, is_active) WHERE id = $1",
        [id, b.name ?? null, b.kind ?? null, b.isActive ?? null]);
      if (!r.rowCount) throw notFound("مركز التكلفة غير موجود");
      await auditTenant(db, req, "cost_center.updated", "cost_center", id, b);
    });
    return { ok: true };
  });

  // ── Fiscal year and periods ─────────────────────────────────────────────────────────────────
  // Periods are the fiscal year's months; a period is closed once the lock date reaches its last day.
  app.get("/accounting/fiscal", { preHandler: requireTenant("acc_settings.view") }, async (req) => {
    const q = req.query as { year?: string };
    return tenantTx(req, async (db) => {
      const st = (await db.query<{ m: number; lock_date: string | null }>("SELECT fiscal_year_start_month AS m, lock_date::text FROM accounting_settings")).rows[0];
      const startMonth = st?.m ?? 1;
      const lock = st?.lock_date ?? null;
      const current = fiscalYearOf(today(), startMonth);
      const year = /^\d{4}$/.test(q.year ?? "") ? Number(q.year) : current;
      const fy = fiscalYear(year, startMonth);
      const periods = Array.from({ length: 12 }, (_, i) => {
        const d = new Date(Date.UTC(Number(fy.from.slice(0, 4)), Number(fy.from.slice(5, 7)) - 1 + i, 1));
        const from = d.toISOString().slice(0, 10);
        const to = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
        return { index: i + 1, from, to, status: lock && lock >= to ? "closed" : from > today() ? "future" : "open" };
      });
      return { startMonth, year, currentYear: current, from: fy.from, to: fy.to, lockDate: lock, yearClosed: Boolean(lock && lock >= fy.to), periods };
    }, { readOnly: true });
  });

  app.put("/accounting/fiscal", { preHandler: requireTenant("acc_settings.manage") }, async (req) => {
    const { startMonth } = z.object({ startMonth: z.number().int().min(1).max(12) }).parse(req.body);
    await tenantTx(req, async (db) => {
      const cur = (await db.query<{ m: number; lock_date: string | null }>("SELECT fiscal_year_start_month AS m, lock_date::text FROM accounting_settings FOR UPDATE")).rows[0];
      if (cur?.m === startMonth) return;
      // Once periods are closed their boundaries are fixed; moving the start would split a closed year.
      if (cur?.lock_date) {
        throw new AppError(409, "periods_closed", "لا يمكن تغيير بداية السنة المالية بعد إقفال فترات. تواصل مع الدعم إن احتجت ذلك");
      }
      await db.query(
        `INSERT INTO accounting_settings (tenant_id, fiscal_year_start_month) VALUES (app_tenant_id(), $1)
         ON CONFLICT (tenant_id) DO UPDATE SET fiscal_year_start_month = EXCLUDED.fiscal_year_start_month`, [startMonth]);
      await auditTenant(db, req, "accounting.fiscal_year_changed", "accounting_settings", "00000000-0000-0000-0000-000000000000", { from: cur?.m ?? 1, to: startMonth });
    });
    return { ok: true };
  });

  // ── Tax profile (seller block of every tax invoice) ─────────────────────────────────────────
  app.get("/accounting/tax-profile", { preHandler: requireTenant("acc_settings.view", "zatca.view", "acc_invoices.view") }, async (req) =>
    tenantTx(req, async (db) => {
      const t = (await db.query<{ company_name: string; tax_id: string; city: string | null }>("SELECT company_name, tax_id, city FROM tenants")).rows[0]!;
      const p = (await db.query(
        `SELECT legal_name AS "legalName", cr_number AS "crNumber", street, building_no AS "buildingNo", additional_no AS "additionalNo",
                district, city, postal_code AS "postalCode", updated_at AS "updatedAt" FROM tax_profiles`)).rows[0] ?? null;
      return { vatNumber: t.tax_id, companyName: t.company_name, profile: p, suggested: { legalName: t.company_name, city: t.city } };
    }, { readOnly: true }));

  app.put("/accounting/tax-profile", { preHandler: requireTenant("acc_settings.tax_profile") }, async (req) => {
    const b = z.object({
      legalName: z.string().trim().min(2, "أدخل الاسم النظامي للمنشأة").max(200),
      crNumber: z.string().trim().regex(/^[0-9]{10}$/, "رقم السجل التجاري 10 أرقام").nullable().optional().transform((v) => v || null),
      street: z.string().trim().min(2, "أدخل اسم الشارع").max(120),
      buildingNo: z.string().trim().regex(/^[0-9]{4}$/, "رقم المبنى 4 أرقام"),
      additionalNo: z.string().trim().regex(/^[0-9]{4}$/, "الرقم الإضافي 4 أرقام").nullable().optional().transform((v) => v || null),
      district: z.string().trim().min(2, "أدخل الحي").max(120),
      city: z.string().trim().min(2, "أدخل المدينة").max(80),
      postalCode: z.string().trim().regex(/^[0-9]{5}$/, "الرمز البريدي 5 أرقام"),
    }).parse(req.body);
    await tenantTx(req, async (db) => {
      await db.query(
        `INSERT INTO tax_profiles (tenant_id, legal_name, cr_number, street, building_no, additional_no, district, city, postal_code)
         VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (tenant_id) DO UPDATE SET legal_name = EXCLUDED.legal_name, cr_number = EXCLUDED.cr_number, street = EXCLUDED.street,
           building_no = EXCLUDED.building_no, additional_no = EXCLUDED.additional_no, district = EXCLUDED.district, city = EXCLUDED.city, postal_code = EXCLUDED.postal_code`,
        [b.legalName, b.crNumber, b.street, b.buildingNo, b.additionalNo, b.district, b.city, b.postalCode]);
      await auditTenant(db, req, "tax_profile.updated", "tax_profile", "00000000-0000-0000-0000-000000000000", b);
    });
    return { ok: true };
  });
}
