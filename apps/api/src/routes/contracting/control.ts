import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../../db/pool.ts";
import { cashFlow, costForecast, earnedValue, plannedCurve, type Activity } from "../../lib/contracting/evm.ts";
import { parseMspdi, parseXer, type ImportedActivity } from "../../lib/contracting/scheduleImport.ts";
import { AppError, badRequest, notFound } from "../../lib/errors.ts";
import { isoDate } from "../../lib/calendar.ts";
import { auditTenant, isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";
import { today } from "../restaurants/batches.ts";

// Schedule, cost control, earned value and cash flow of a project (docs/contracting/ARCHITECTURE.md, C9).
// The programme comes from P6 or MS Project (or is entered); progress is the site's; the budget per WBS × cost code is
// the control baseline; actuals come from the ledger (the project's cost center); commitments from open purchase
// orders of its site stores and the uncertified part of its subcontracts. All figures are computed here.

const date = isoDate;
const conflict = (m: string, code = "invalid_state") => new AppError(409, code, m);
const h = (v: string | number | null | undefined) => Math.round(Number(v ?? 0) * 100);
const r = (v: number) => v / 100;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const monthEnd = (p: string) => new Date(Date.UTC(Number(p.slice(0, 4)), Number(p.slice(5, 7)), 0)).toISOString().slice(0, 10);

interface ActRow { id: string; parent_id: string | null; code: string; name: string; is_summary: boolean; start: string | null; finish: string | null; budget: string; pct: string;
  actual_start: string | null; actual_finish: string | null; wbs_id: string | null; sort: number; removed: boolean }
export async function activities(db: Db, projectId: string) {
  return (await db.query<ActRow>(
    `SELECT id, parent_id, code, name, is_summary, start_date::text AS start, finish_date::text AS finish, budget::text, pct_complete::text AS pct,
            actual_start::text, actual_finish::text, wbs_id, sort, removed FROM schedule_activities WHERE project_id = $1 ORDER BY sort, code`, [projectId])).rows;
}
export const leaves = (rows: ActRow[]): Activity[] => rows.filter((a) => !a.is_summary && !a.removed && a.start && a.finish)
  .map((a) => ({ start: a.start!, finish: a.finish!, budget: h(a.budget), pctComplete: Number(a.pct) }));

/** The project's cost to date from the ledger: expenses on its cost center, not the contra or close entries. */
export async function actualCost(db: Db, projectId: string, asOf: string) {
  return h((await db.query<{ v: string }>(
    `SELECT coalesce(sum(l.debit - l.credit), 0)::text AS v FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
       JOIN projects p ON p.cost_center_id = l.cost_center_id
      WHERE p.id = $1 AND a.type = 'expense' AND e.entry_date <= $2 AND e.source_type <> 'contract_close'`, [projectId, asOf])).rows[0]!.v);
}
export const bacOf = async (db: Db, projectId: string) => h((await db.query<{ v: string }>("SELECT coalesce(sum(amount), 0)::text AS v FROM project_budgets WHERE project_id = $1", [projectId])).rows[0]!.v);

/** A project's earned value on a date (halalas): the programme's planned and earned value, the ledger's actual cost. */
export async function projectEvm(db: Db, projectId: string, asOf: string) {
  const acts = leaves(await activities(db, projectId));
  return { acts, ...earnedValue(acts, { bac: await bacOf(db, projectId), ac: await actualCost(db, projectId, asOf), date: asOf }) };
}

/**
 * The project's cash flow for the months ahead (halalas, before VAT): the main contracts' remaining value (less
 * retention and the advance still to recover) paid the customer's terms later, and the cost still to spend (EAC − AC),
 * both along the programme's planned curve.
 */
export async function projectCashFlow(db: Db, projectId: string, months: number, asOf: string) {
  const e = await projectEvm(db, projectId, asOf);
  const m = (await db.query<{ value: string; certified: string; retention: string; advance: string; recovered: string; terms: string }>(
    `SELECT coalesce(sum(k.value + coalesce((SELECT sum(vl.quantity * vl.rate) FROM variation_lines vl JOIN variations v ON v.id = vl.variation_id WHERE v.contract_id = k.id AND v.status = 'approved'), 0)), 0)::text AS value,
            coalesce(sum((SELECT gross_to_date FROM ipcs i WHERE i.contract_id = k.id AND i.status IN ('approved', 'invoiced') ORDER BY i.number DESC LIMIT 1)), 0)::text AS certified,
            coalesce(max(k.retention_pct), 0)::text AS retention,
            coalesce(sum((SELECT sum(taxable) FROM sales_documents d WHERE d.contract_id = k.id AND d.kind = 'prepayment')), 0)::text AS advance,
            coalesce(sum((SELECT sum(advance_recovery) FROM ipcs i WHERE i.contract_id = k.id AND i.status IN ('approved', 'invoiced'))), 0)::text AS recovered,
            coalesce(max(c.payment_terms_days), 30)::text AS terms
       FROM contracts k LEFT JOIN customers c ON c.id = k.customer_id WHERE k.project_id = $1 AND k.role = 'MAIN' AND k.status = 'active'`, [projectId])).rows[0]!;
  const items = cashFlow({ curve: plannedCurve(e.acts, e.bac), from: asOf.slice(0, 7), months,
    remainingRevenue: Math.max(0, h(m.value) - h(m.certified)), remainingCost: Math.max(0, e.eac - e.ac), retentionPct: Number(m.retention),
    advanceToRecover: Math.max(0, h(m.advance) - h(m.recovered)), vatPct: 0, inputVatShare: 0, paymentLagMonths: Math.ceil(Number(m.terms) / 30) });
  return { hasSchedule: e.acts.length > 0, items };
}

export default async function controlRoutes(app: FastifyInstance) {
  // ── Programme ─────────────────────────────────────────────────────────────────────────────
  app.get("/projects/:id/schedule", { preHandler: requireTenant("cost_control.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const rows = await activities(db, id);
      const t = today();
      const children = new Map<string | null, ActRow[]>();
      for (const a of rows) children.set(a.parent_id, [...(children.get(a.parent_id) ?? []), a]);
      const walk = (parent: string | null, depth: number): (ActRow & { depth: number })[] => (children.get(parent) ?? []).flatMap((a) => [{ ...a, depth }, ...walk(a.id, depth + 1)]);
      return {
        today: t,
        items: walk(null, 0).map((a) => ({ id: a.id, parentId: a.parent_id, code: a.code, name: a.name, isSummary: a.is_summary, depth: a.depth, start: a.start, finish: a.finish,
          budget: Number(a.budget), pctComplete: Number(a.pct), actualStart: a.actual_start, actualFinish: a.actual_finish, wbsId: a.wbs_id, removed: a.removed,
          // Behind: the plan says it should have started or finished by today and it has not.
          late: !a.is_summary && ((a.finish! < t && Number(a.pct) < 100) || (a.start! < t && !a.actual_start && Number(a.pct) === 0)) })),
      };
    }, { readOnly: true });
  });

  /** Imports a programme (P6 .xer or MS Project .xml): activities by code; the baseline and names from the file, progress kept unless the file has it. */
  app.post("/projects/:id/schedule/import", { preHandler: requireTenant("cost_control.schedule"), config: { rateLimit: { max: 20, timeWindow: "10 minutes" } } }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const file = await req.file({ limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
    if (!file) throw badRequest("أرفق ملف البرنامج الزمني (.xer أو .xml)");
    const text = (await file.toBuffer()).toString("utf8");
    let acts: ImportedActivity[];
    try {
      acts = file.filename.toLowerCase().endsWith(".xer") || text.startsWith("ERMHDR") ? parseXer(text) : parseMspdi(text);
    } catch { throw badRequest("الملف ليس برنامجاً زمنياً مقروءاً: صدّره من Primavera P6 بصيغة XER أو من MS Project بصيغة XML"); }
    if (!acts.length) throw badRequest("لا أنشطة في الملف");
    if (acts.length > 20_000) throw badRequest("الحد الأقصى 20,000 نشاط");
    return tenantTx(req, async (db) => {
      if (!(await db.query("SELECT 1 FROM projects WHERE id = $1", [id])).rowCount) throw notFound("المشروع غير موجود");
      const ids = new Map<string, string>();
      let sort = 0;
      for (const a of acts) {
        const progress = !a.isSummary && (a.pctComplete > 0 || a.actualStart);
        const row = (await db.query<{ id: string }>(
          `INSERT INTO schedule_activities (tenant_id, project_id, code, name, is_summary, start_date, finish_date, pct_complete, actual_start, actual_finish, sort)
           VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (tenant_id, project_id, code) DO UPDATE SET name = EXCLUDED.name, is_summary = EXCLUDED.is_summary, start_date = EXCLUDED.start_date,
             finish_date = EXCLUDED.finish_date, sort = EXCLUDED.sort,
             pct_complete = CASE WHEN $11 THEN EXCLUDED.pct_complete ELSE schedule_activities.pct_complete END,
             actual_start = CASE WHEN $11 THEN EXCLUDED.actual_start ELSE schedule_activities.actual_start END,
             actual_finish = CASE WHEN $11 THEN EXCLUDED.actual_finish ELSE schedule_activities.actual_finish END
           RETURNING id`,
          [id, a.code.slice(0, 60), a.name.slice(0, 300), a.isSummary, a.isSummary ? null : a.start, a.isSummary ? null : a.finish, a.pctComplete, a.actualStart,
            a.actualStart ? a.actualFinish : null, sort += 10, Boolean(progress)])).rows[0]!;
        ids.set(a.code, row.id);
      }
      for (const a of acts) await db.query("UPDATE schedule_activities SET parent_id = $2 WHERE id = $1", [ids.get(a.code), a.parentCode ? ids.get(a.parentCode) ?? null : null]);
      // Activities no longer in the programme go, unless the site reported progress on them: those stay, detached
      // from the old tree (its summaries are deleted) and flagged removed, so earned value counts them no more.
      await db.query("UPDATE schedule_activities SET removed = false WHERE id = ANY($1::uuid[])", [[...ids.values()]]);
      await db.query(`UPDATE schedule_activities SET parent_id = NULL, removed = true
                       WHERE project_id = $1 AND NOT (id = ANY($2::uuid[])) AND (pct_complete > 0 OR actual_start IS NOT NULL)`, [id, [...ids.values()]]);
      const removed = await db.query("DELETE FROM schedule_activities WHERE project_id = $1 AND NOT (id = ANY($2::uuid[])) AND pct_complete = 0 AND actual_start IS NULL",
        [id, [...ids.values()]]);
      await auditTenant(db, req, "schedule.imported", "project", id, { activities: acts.length, removed: removed.rowCount });
      return { ok: true, activities: acts.filter((a) => !a.isSummary).length, summaries: acts.filter((a) => a.isSummary).length };
    });
  });

  app.put("/schedule-activities/:id/progress", { preHandler: requireTenant("cost_control.schedule") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ pctComplete: z.number().min(0).max(100), actualStart: date.nullable().optional().transform((v) => v ?? null),
      actualFinish: date.nullable().optional().transform((v) => v ?? null) }).parse(req.body);
    if (b.pctComplete > 0 && !b.actualStart) throw badRequest("أدخل تاريخ البدء الفعلي");
    if (b.actualFinish && b.pctComplete < 100) throw badRequest("النشاط المنتهي إنجازه 100%");
    if ((b.actualStart && b.actualStart > today()) || (b.actualFinish && b.actualFinish > today())) throw badRequest("التاريخ الفعلي في المستقبل");
    if (b.actualStart && b.actualFinish && b.actualFinish < b.actualStart) throw badRequest("الانتهاء الفعلي قبل البدء");
    await tenantTx(req, async (db) => {
      const r = await db.query("UPDATE schedule_activities SET pct_complete = $2, actual_start = $3, actual_finish = $4, progress_at = now() WHERE id = $1 AND NOT is_summary",
        [id, b.pctComplete, b.actualStart, b.actualFinish]);
      if (!r.rowCount) throw notFound("النشاط غير موجود");
      await auditTenant(db, req, "schedule.progress", "schedule_activity", id, { pct: b.pctComplete });
    });
    return { ok: true };
  });

  app.put("/schedule-activities/:id/budget", { preHandler: requireTenant("cost_control.budget") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ budget: z.number().min(0).max(1e13) }).parse(req.body);
    await tenantTx(req, async (db) => {
      const r = await db.query("UPDATE schedule_activities SET budget = $2 WHERE id = $1 AND NOT is_summary", [id, b.budget]);
      if (!r.rowCount) throw notFound("النشاط غير موجود");
    });
    return { ok: true };
  });

  // ── Budget and cost control ───────────────────────────────────────────────────────────────
  app.put("/projects/:id/budget", { preHandler: requireTenant("cost_control.budget") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ lines: z.array(z.object({ wbsId: z.string().uuid().nullable().optional().transform((v) => v ?? null), costCodeId: z.string().uuid(),
      amount: z.number().min(0).max(1e13) })).max(2000) }).parse(req.body);
    if (new Set(b.lines.map((l) => `${l.wbsId}:${l.costCodeId}`)).size !== b.lines.length) throw badRequest("سطر مكرر لنفس العنصر والرمز");
    await tenantTx(req, async (db) => {
      if (!(await db.query("SELECT 1 FROM projects WHERE id = $1", [id])).rowCount) throw notFound("المشروع غير موجود");
      for (const l of b.lines) {
        if (l.wbsId && !(await db.query("SELECT 1 FROM wbs_nodes WHERE id = $1 AND project_id = $2", [l.wbsId, id])).rowCount) throw badRequest("عنصر WBS ليس من هذا المشروع");
      }
      await db.query("DELETE FROM project_budgets WHERE project_id = $1", [id]);
      for (const l of b.lines.filter((x) => x.amount > 0)) {
        await db.query("INSERT INTO project_budgets (tenant_id, project_id, wbs_id, cost_code_id, amount) VALUES (app_tenant_id(), $1, $2, $3, $4)", [id, l.wbsId, l.costCodeId, l.amount]);
      }
      await auditTenant(db, req, "project.budget", "project", id, { lines: b.lines.length, total: b.lines.reduce((a, l) => a + l.amount, 0) });
    });
    return { ok: true };
  });

  /**
   * Cost control by cost code (and WBS element): the budget, the actual cost from the ledger, what is committed but
   * not yet cost (open purchase orders of the project's site stores; subcontracts' uncertified value), and the forecast:
   * actual + the larger of the commitments and what the budget still leaves.
   */
  app.get("/projects/:id/cost-control", { preHandler: requireTenant("cost_control.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const asOf = today();
      const rows = (await db.query<{ code_id: string | null; code: string | null; name: string | null; wbs_id: string | null; wbs: string | null; budget: string; actual: string; committed: string }>(
        `WITH b AS (SELECT wbs_id, cost_code_id, sum(amount) AS v FROM project_budgets WHERE project_id = $1 GROUP BY 1, 2),
              a AS (SELECT l.wbs_id, l.cost_code_id, sum(l.debit - l.credit) AS v FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
                     JOIN accounts ac ON ac.id = l.account_id JOIN projects p ON p.cost_center_id = l.cost_center_id
                    WHERE p.id = $1 AND ac.type = 'expense' AND e.source_type <> 'contract_close' AND e.entry_date <= $2 GROUP BY 1, 2),
              c AS (
                SELECT NULL::uuid AS wbs_id, (SELECT id FROM cost_codes WHERE code = 'MAT') AS cost_code_id,
                       coalesce(sum((i.quantity - i.received_quantity) * i.unit_price), 0) AS v
                  FROM purchase_items i JOIN purchase_orders o ON o.id = i.purchase_order_id JOIN locations l ON l.id = o.location_id
                 WHERE l.project_id = $1 AND o.status IN ('approved', 'partially_received') AND i.quantity > i.received_quantity
                UNION ALL
                SELECT NULL, (SELECT id FROM cost_codes WHERE code = 'SUB'),
                       coalesce(sum(k.value + coalesce((SELECT sum(vl.quantity * vl.rate) FROM variation_lines vl JOIN variations v ON v.id = vl.variation_id
                                                        WHERE v.contract_id = k.id AND v.status = 'approved'), 0)
                                    - coalesce((SELECT gross_to_date FROM ipcs i WHERE i.contract_id = k.id AND i.status = 'invoiced' ORDER BY i.number DESC LIMIT 1), 0)), 0)
                  FROM contracts k WHERE k.project_id = $1 AND k.role = 'SUB' AND k.status = 'active'),
              keys AS (SELECT wbs_id, cost_code_id FROM b UNION SELECT wbs_id, cost_code_id FROM a UNION SELECT wbs_id, cost_code_id FROM c WHERE v <> 0)
         SELECT k.cost_code_id AS code_id, cc.code, cc.name, k.wbs_id, w.code AS wbs,
                coalesce((SELECT sum(v) FROM b WHERE b.wbs_id IS NOT DISTINCT FROM k.wbs_id AND b.cost_code_id IS NOT DISTINCT FROM k.cost_code_id), 0)::text AS budget,
                coalesce((SELECT sum(v) FROM a WHERE a.wbs_id IS NOT DISTINCT FROM k.wbs_id AND a.cost_code_id IS NOT DISTINCT FROM k.cost_code_id), 0)::text AS actual,
                coalesce((SELECT sum(v) FROM c WHERE c.wbs_id IS NOT DISTINCT FROM k.wbs_id AND c.cost_code_id IS NOT DISTINCT FROM k.cost_code_id), 0)::text AS committed
           FROM keys k LEFT JOIN cost_codes cc ON cc.id = k.cost_code_id LEFT JOIN wbs_nodes w ON w.id = k.wbs_id
          ORDER BY cc.code NULLS LAST, w.code NULLS FIRST`, [id, asOf])).rows;
      const f = costForecast(rows.map((x) => ({ code: x.code_id ?? "", budget: h(x.budget), actual: h(x.actual), committed: Math.max(0, h(x.committed)) })));
      const lines = rows.map((x, i) => ({ costCodeId: x.code_id, costCode: x.code ?? "—", costName: x.name ?? "غير مصنّف", wbsId: x.wbs_id, wbs: x.wbs,
        budget: r(h(x.budget)), actual: r(h(x.actual)), committed: r(Math.max(0, h(x.committed))), forecast: r(f[i]!), variance: r(h(x.budget) - f[i]!) }))
        .filter((l) => l.budget || l.actual || l.committed);
      const sum = (k: "budget" | "actual" | "committed" | "forecast" | "variance") => Math.round(lines.reduce((a, l) => a + l[k] * 100, 0)) / 100;
      return { asOf, lines, totals: { budget: sum("budget"), actual: sum("actual"), committed: sum("committed"), forecast: sum("forecast"), variance: sum("variance") } };
    }, { readOnly: true });
  });

  // ── Earned value ──────────────────────────────────────────────────────────────────────────
  app.get("/projects/:id/evm", { preHandler: requireTenant("cost_control.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const q = z.object({ date: date.optional() }).parse(req.query);
    const asOf = q.date ?? today();
    return tenantTx(req, async (db) => {
      const acts = leaves(await activities(db, id));
      const bac = await bacOf(db, id);
      const ac = await actualCost(db, id, asOf);
      const e = earnedValue(acts, { bac, ac, date: asOf });
      const snaps = (await db.query<{ period: string; pv: string; ev: string; ac: string }>("SELECT period, pv::text, ev::text, ac::text FROM evm_snapshots WHERE project_id = $1 ORDER BY period", [id])).rows;
      const curve = plannedCurve(acts, e.bac).map((c) => {
        const s = snaps.find((x) => x.period === c.period);
        return { period: c.period, pv: r(c.pv), ev: s ? Number(s.ev) : null, ac: s ? Number(s.ac) : null };
      });
      return { asOf, activities: acts.length, budgeted: acts.some((a) => a.budget > 0) ? "activities" : bac ? "project" : "none",
        bac: r(e.bac), pv: r(e.pv), ev: r(e.ev), ac: r(e.ac), sv: r(e.sv), cv: r(e.cv), spi: e.spi, cpi: e.cpi, eac: r(e.eac), etc: r(e.etc), vac: r(e.vac), tcpi: e.tcpi, curve,
        snapshots: snaps.map((s) => s.period) };
    }, { readOnly: true });
  });

  app.post("/projects/:id/evm/snapshot", { preHandler: requireTenant("cost_control.snapshot") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ period: z.string().regex(PERIOD, "الشهر بصيغة YYYY-MM") }).parse(req.body);
    // The progress on record is today's, so only the month just ended is snapshotted: an older month would pair its
    // cost with months of later progress, and the row is permanent.
    const prev = new Date(`${today().slice(0, 7)}-01T00:00:00Z`); prev.setUTCMonth(prev.getUTCMonth() - 1);
    if (b.period !== prev.toISOString().slice(0, 7)) throw badRequest(`يُثبَّت الشهر المنتهي للتو فقط (${prev.toISOString().slice(0, 7)})، والإنجاز المسجل هو إنجاز اليوم`);
    return tenantTx(req, async (db) => {
      const end = monthEnd(b.period);
      const acts = leaves(await activities(db, id));
      if (!acts.length) throw badRequest("لا برنامج زمني للمشروع");
      const e = earnedValue(acts, { bac: await bacOf(db, id), ac: await actualCost(db, id, end), date: end });
      try {
        await db.query("INSERT INTO evm_snapshots (tenant_id, project_id, period, bac, pv, ev, ac, created_by) VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, app_user_id())",
          [id, b.period, r(e.bac), r(e.pv), r(e.ev), r(e.ac)]);
      } catch (x) { if ((x as { code?: string }).code === "23505") throw conflict("ثُبّت هذا الشهر من قبل", "duplicate"); throw x; }
      await auditTenant(db, req, "evm.snapshot", "project", id, { period: b.period });
      return { ok: true, pv: r(e.pv), ev: r(e.ev), ac: r(e.ac) };
    });
  });

  // ── Cash flow ─────────────────────────────────────────────────────────────────────────────
  app.get("/projects/:id/cashflow", { preHandler: requireTenant("cost_control.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const q = z.object({ months: z.coerce.number().int().min(1).max(36).default(12) }).parse(req.query);
    return tenantTx(req, async (db) => {
      const asOf = today();
      const f = await projectCashFlow(db, id, q.months, asOf);
      return { asOf, basis: "قبل ضريبة القيمة المضافة", hasSchedule: f.hasSchedule,
        items: f.items.map((x) => ({ period: x.period, inflow: r(x.inflow), outflow: r(x.outflow), net: r(x.net), cumulative: r(x.cumulative) })) };
    }, { readOnly: true });
  });
}
