import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../../db/pool.ts";
import { postContractClose } from "../../lib/accounting/posting.ts";
import { ensureContractingAccounts } from "../../lib/contracting/accounts.ts";
import { computeClose, type RevenueMethod } from "../../lib/contracting/revenue.ts";
import { AppError, badRequest, notFound } from "../../lib/errors.ts";
import { auditTenant, isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";
import { today } from "../restaurants/batches.ts";

// Revenue over time on main contracts (docs/contracting/ARCHITECTURE.md, C5): the workspace's policy, the estimated
// total cost, the work-in-progress schedule (live) and the monthly close that books the contract asset/liability
// and the onerous provision. Subcontracts are costs of the main contract and are not closed themselves.

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const lastDay = (period: string) => new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).toISOString().slice(0, 10);
const cents = (v: string | number | null | undefined) => Math.round(Number(v ?? 0) * 100);
const riyals = (v: number) => v / 100;

interface Figures { id: string; number: string; title: string; project: string; projectId: string; customer: string | null; value: number; variations: number; claims: number; ld: number;
  certified: number; billed: number; cost: number; estimate: number | null; mains: number }
/** A main contract's figures as at the end of a day (halalas). Cost is the project's (its cost center). */
async function figuresAt(db: Db, date: string, contractId?: string): Promise<Figures[]> {
  return (await db.query<Record<string, string | number | null>>(
    `SELECT k.id, k.number, k.title, p.code AS project, p.id AS project_id, c.name AS customer, k.value::text,
            coalesce((SELECT sum(l.quantity * l.rate) FROM variation_lines l JOIN variations o ON o.id = l.variation_id
                       WHERE o.contract_id = k.id AND o.status = 'approved' AND (o.decided_at AT TIME ZONE 'Asia/Riyadh')::date <= $1), 0)::text AS variations,
            coalesce((SELECT sum(amount_assessed) FROM claims WHERE contract_id = k.id AND status = 'agreed' AND (agreed_at AT TIME ZONE 'Asia/Riyadh')::date <= $1), 0)::text AS claims,
            coalesce((SELECT sum(ld_amount) FROM ipcs WHERE contract_id = k.id AND status IN ('approved', 'invoiced') AND period_to <= $1), 0)::text AS ld,
            coalesce((SELECT gross_to_date FROM ipcs WHERE contract_id = k.id AND status IN ('approved', 'invoiced') AND period_to <= $1 ORDER BY number DESC LIMIT 1), 0)::text AS certified,
            coalesce((SELECT sum(CASE WHEN d.kind = 'credit_note' THEN -d.taxable WHEN d.kind IN ('invoice', 'debit_note') THEN d.taxable ELSE 0 END)
                        FROM sales_documents d WHERE d.contract_id = k.id AND d.issue_date <= $1), 0)::text AS billed,
            coalesce((SELECT sum(l.debit - l.credit) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
                       WHERE l.cost_center_id = p.cost_center_id AND a.type = 'expense' AND e.entry_date <= $1 AND e.source_type <> 'contract_close'), 0)::text AS cost,
            (SELECT estimated_cost FROM contract_estimates WHERE contract_id = k.id AND as_of <= $1 ORDER BY as_of DESC, created_at DESC LIMIT 1)::text AS estimate,
            (SELECT count(*)::int FROM contracts m WHERE m.project_id = k.project_id AND m.role = 'MAIN' AND m.status <> 'draft') AS mains
       FROM contracts k JOIN projects p ON p.id = k.project_id LEFT JOIN customers c ON c.id = k.customer_id
      WHERE k.role = 'MAIN' AND k.status <> 'draft' AND ($2::uuid IS NULL OR k.id = $2) ORDER BY p.code, k.number`, [date, contractId ?? null])).rows
    .map((r) => ({ id: r.id as string, number: r.number as string, title: r.title as string, project: r.project as string, projectId: r.project_id as string, customer: r.customer as string | null,
      value: cents(r.value), variations: cents(r.variations), claims: cents(r.claims), ld: cents(r.ld), certified: cents(r.certified), billed: cents(r.billed), cost: cents(r.cost),
      estimate: r.estimate === null ? null : cents(r.estimate), mains: Number(r.mains) }));
}

/** The close of one contract, or why it cannot be computed. */
function evaluate(f: Figures, method: RevenueMethod) {
  const transactionPrice = f.value + f.variations + f.claims - f.ld;
  if (method === "input" && f.mains > 1) return { error: "للمشروع أكثر من عقد رئيسي: التكلفة لا تُنسب لعقد واحد. افصل كل عقد في مشروع، أو استخدم طريقة المخرجات" };
  if (method === "input" && f.estimate === null) return { error: "أدخل التكلفة الكلية المقدرة للعقد (طريقة المدخلات)" };
  // The onerous test compares the project's cost with this contract: only meaningful with one main contract and an estimate.
  const onerousTestable = f.estimate !== null && f.mains === 1;
  const r = computeClose({ method, transactionPrice, workValue: f.value + f.variations, estimatedCost: onerousTestable ? f.estimate : null, costToDate: f.cost,
    certifiedToDate: f.certified, billedToDate: f.billed });
  const note = f.estimate === null ? "بلا تقدير للتكلفة الكلية: لا يُقيَّم إن كان العقد مثقلاً" : f.mains > 1 ? "للمشروع أكثر من عقد رئيسي: لا يُقيَّم العقد المثقل من تكلفة المشروع" : null;
  return { transactionPrice, ...r, note };
}

const methodOf = async (db: Db) => (await db.query<{ m: RevenueMethod }>("SELECT revenue_method AS m FROM tenant_settings")).rows[0]!.m;

export default async function revenueRoutes(app: FastifyInstance) {
  app.get("/contracting/revenue-settings", { preHandler: requireTenant("revenue.view") }, async (req) =>
    tenantTx(req, async (db) => ({ method: await methodOf(db), closed: Number((await db.query<{ n: string }>("SELECT count(*)::text AS n FROM contract_closes")).rows[0]!.n) }), { readOnly: true }));

  // The policy is chosen once: after the first close, changing it would restate earlier periods.
  app.put("/contracting/revenue-settings", { preHandler: requireTenant("revenue.settings") }, async (req) => {
    const b = z.object({ method: z.enum(["output", "input"]) }).parse(req.body);
    await tenantTx(req, async (db) => {
      if ((await db.query("SELECT 1 FROM contract_closes LIMIT 1")).rowCount && (await methodOf(db)) !== b.method) {
        throw new AppError(409, "policy_locked", "أُقفلت شهور بالسياسة الحالية: تغيير طريقة قياس الإنجاز يحتاج معالجة تغيير سياسة محاسبية بأثر رجعي، لا يتم من هنا");
      }
      await db.query("UPDATE tenant_settings SET revenue_method = $1", [b.method]);
      await auditTenant(db, req, "revenue.policy", "tenant_settings", "revenue_method", { method: b.method });
    });
    return { ok: true };
  });

  app.get("/contracts/:id/estimates", { preHandler: requireTenant("revenue.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => ({
      items: (await db.query(`SELECT id, estimated_cost::float8 AS "estimatedCost", as_of::text AS "asOf", note, created_at AS "createdAt" FROM contract_estimates
                               WHERE contract_id = $1 ORDER BY as_of DESC, created_at DESC`, [id])).rows,
    }), { readOnly: true });
  });

  app.post("/contracts/:id/estimates", { preHandler: requireTenant("revenue.estimate") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ estimatedCost: z.number().positive().max(1e13), asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      note: z.string().trim().max(500).nullable().optional().transform((v) => v || null) }).parse(req.body);
    if (b.asOf && b.asOf > today()) throw badRequest("تاريخ التقدير في المستقبل");
    const eid = await tenantTx(req, async (db) => {
      const c = (await db.query<{ role: string }>("SELECT role FROM contracts WHERE id = $1", [id])).rows[0];
      if (!c) throw notFound("العقد غير موجود");
      if (c.role !== "MAIN") throw badRequest("التكلفة المقدرة للعقد الرئيسي؛ عقود الباطن من تكاليفه");
      const r = (await db.query<{ id: string }>("INSERT INTO contract_estimates (tenant_id, contract_id, estimated_cost, as_of, note, created_by) VALUES (app_tenant_id(), $1, $2, $3, $4, app_user_id()) RETURNING id",
        [id, b.estimatedCost, b.asOf ?? today(), b.note])).rows[0]!;
      await auditTenant(db, req, "contract.estimate", "contract", id, { estimatedCost: b.estimatedCost });
      return r.id;
    });
    return reply.status(201).send({ id: eid });
  });

  /** The work-in-progress schedule at the end of a month, live, with the last close of each contract. */
  app.get("/contracting/wip", { preHandler: requireTenant("revenue.view") }, async (req) => {
    const q = req.query as { period?: string };
    const period = PERIOD.test(q.period ?? "") ? q.period! : today().slice(0, 7);
    return tenantTx(req, async (db) => {
      const method = await methodOf(db);
      const closes = new Map((await db.query<{ contract_id: string; period: string; position: string; provision: string }>(
        `SELECT DISTINCT ON (contract_id) contract_id, period, position::text, provision::text FROM contract_closes WHERE period <= $1 ORDER BY contract_id, period DESC`, [period])).rows
        .map((r) => [r.contract_id, r]));
      const items = (await figuresAt(db, lastDay(period))).map((f) => {
        const e = evaluate(f, method);
        const last = closes.get(f.id);
        return {
          contractId: f.id, number: f.number, title: f.title, project: f.project, customer: f.customer, costToDate: riyals(f.cost), certifiedToDate: riyals(f.certified),
          billedToDate: riyals(f.billed), estimatedCost: f.estimate === null ? null : riyals(f.estimate),
          ...("error" in e ? { error: e.error } : {
            transactionPrice: riyals(e.transactionPrice), pct: e.pct, revenueToDate: riyals(e.revenueToDate), contractAsset: riyals(Math.max(0, e.position)),
            contractLiability: riyals(Math.max(0, -e.position)), expectedLoss: riyals(e.expectedLoss), provision: riyals(e.provision), grossProfit: e.grossProfit === null ? null : riyals(e.grossProfit), note: e.note,
            backlog: riyals(e.transactionPrice - e.revenueToDate),
          }),
          lastClose: last ? { period: last.period, position: Number(last.position), provision: Number(last.provision) } : null,
          closedThisPeriod: last?.period === period,
        };
      });
      return { period, method, items };
    }, { readOnly: true });
  });

  /** Closes the month for every main contract not yet closed for it (periods in order). One transaction. */
  app.post("/contracting/close", { preHandler: requireTenant("revenue.close") }, async (req) => {
    const b = z.object({ period: z.string().regex(PERIOD, "الشهر بصيغة YYYY-MM") }).parse(req.body);
    if (b.period > today().slice(0, 7)) throw badRequest("لا يُقفل شهر لم ينتهِ بعد");
    return tenantTx(req, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext('contract_close:' || app_tenant_id()::text))");
      const method = await methodOf(db);
      await ensureContractingAccounts(db);
      const later = (await db.query<{ n: string }>("SELECT count(*)::text AS n FROM contract_closes WHERE period > $1", [b.period])).rows[0]!.n;
      if (Number(later)) throw new AppError(409, "later_period_closed", "أُقفل شهر لاحق: الإقفال بالترتيب");
      const closed: string[] = [];
      const skipped: { number: string; reason: string }[] = [];
      for (const f of await figuresAt(db, lastDay(b.period))) {
        if ((await db.query("SELECT 1 FROM contract_closes WHERE contract_id = $1 AND period = $2", [f.id, b.period])).rowCount) continue;
        const e = evaluate(f, method);
        if ("error" in e) { skipped.push({ number: f.number, reason: e.error! }); continue; }
        const r = (await db.query<{ id: string }>(
          `INSERT INTO contract_closes (tenant_id, contract_id, period, method, transaction_price, estimated_cost, cost_to_date, certified_to_date, billed_to_date, pct_complete,
                                        revenue_to_date, position, expected_loss, provision, created_by)
           VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, app_user_id()) RETURNING id`,
          [f.id, b.period, method, riyals(e.transactionPrice), f.estimate === null ? null : riyals(f.estimate), riyals(f.cost), riyals(f.certified), riyals(f.billed), e.pct,
            riyals(e.revenueToDate), riyals(e.position), riyals(e.expectedLoss), riyals(e.provision)])).rows[0]!;
        await postContractClose(db, r.id);
        closed.push(f.number);
      }
      await auditTenant(db, req, "contracting.close", "period", b.period, { closed, skipped });
      return { period: b.period, closed, skipped };
    });
  });
}
