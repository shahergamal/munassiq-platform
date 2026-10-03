import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { postLaborAllocation } from "../../lib/accounting/posting.ts";
import { ensureContractingAccounts } from "../../lib/contracting/accounts.ts";
import { allocateLabor } from "../../lib/contracting/labor.ts";
import { AppError, badRequest, notFound } from "../../lib/errors.ts";
import { openHr } from "../../lib/hr/seal.ts";
import { auditTenant, isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";
import { today } from "../restaurants/batches.ts";
import { projectOpen } from "./site.ts";

// Labour on projects (docs/contracting/ARCHITECTURE.md, C8): the day's hours of each employee per project, and
// allocating an approved payroll run to the projects by those hours (lib/contracting/labor.ts). Individual pay stays
// sealed: only per-project totals are stored, shown and posted.

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح");
const conflict = (m: string, code = "invalid_state") => new AppError(409, code, m);

export default async function laborRoutes(app: FastifyInstance) {
  /** A project's day: every active employee with the hours recorded on it (and on other projects that day). */
  app.get("/labor-timesheets", { preHandler: requireTenant("labor.view") }, async (req) => {
    const q = z.object({ projectId: z.string().uuid(), date }).parse(req.query);
    return tenantTx(req, async (db) => ({
      items: (await db.query(
        `SELECT e.id AS "employeeId", e.code, e.name, e.job_title AS "jobTitle",
                (SELECT t.hours::float8 FROM labor_timesheets t WHERE t.employee_id = e.id AND t.project_id = $1 AND t.work_date = $2) AS hours,
                (SELECT t.wbs_id FROM labor_timesheets t WHERE t.employee_id = e.id AND t.project_id = $1 AND t.work_date = $2) AS "wbsId",
                coalesce((SELECT sum(t.hours) FROM labor_timesheets t WHERE t.employee_id = e.id AND t.project_id <> $1 AND t.work_date = $2), 0)::float8 AS "otherHours",
                (SELECT a.hours + a.overtime_hours FROM attendance a WHERE a.employee_id = e.id AND a.work_date = $2 AND a.status = 'present')::float8 AS "attendanceHours"
           FROM employees e WHERE e.status = 'active' ORDER BY e.code`, [q.projectId, q.date])).rows,
      locked: Boolean((await db.query("SELECT 1 FROM labor_allocations x JOIN payroll_runs r ON r.id = x.run_id WHERE r.period = $1", [q.date.slice(0, 7)])).rowCount),
    }), { readOnly: true });
  });

  // The day's hours on a project, replaced as a whole (zero removes an employee from it).
  app.put("/labor-timesheets", { preHandler: requireTenant("labor.record") }, async (req) => {
    const b = z.object({ projectId: z.string().uuid(), workDate: date, rows: z.array(z.object({ employeeId: z.string().uuid(), hours: z.number().min(0).max(24),
      wbsId: z.string().uuid().nullable().optional().transform((v) => v ?? null) })).max(2000) }).parse(req.body);
    if (b.workDate > today()) throw badRequest("اليوم لم يأتِ بعد");
    return tenantTx(req, async (db) => {
      if ((await db.query("SELECT 1 FROM labor_allocations x JOIN payroll_runs r ON r.id = x.run_id WHERE r.period = $1", [b.workDate.slice(0, 7)])).rowCount) {
        throw conflict("حُمّل مسير هذا الشهر على المشاريع: ساعاته لا تتغير", "labor_locked");
      }
      await projectOpen(db, b.projectId);
      for (const r of b.rows) {
        if (r.wbsId && !(await db.query("SELECT 1 FROM wbs_nodes WHERE id = $1 AND project_id = $2", [r.wbsId, b.projectId])).rowCount) throw badRequest("عنصر WBS ليس من هذا المشروع");
        await db.query("DELETE FROM labor_timesheets WHERE employee_id = $1 AND project_id = $2 AND work_date = $3", [r.employeeId, b.projectId, b.workDate]);
        if (r.hours > 0) {
          await db.query("INSERT INTO labor_timesheets (tenant_id, employee_id, project_id, work_date, hours, wbs_id, recorded_by) VALUES (app_tenant_id(), $1, $2, $3, $4, $5, app_user_id())",
            [r.employeeId, b.projectId, b.workDate, r.hours, r.wbsId]);
        }
      }
      try { await db.query("SET CONSTRAINTS labor_timesheets_day_cap IMMEDIATE"); } catch (e) {
        if ((e as { message?: string }).message?.includes("labor_day_over_24")) throw badRequest("ساعات موظف في هذا اليوم على كل المشاريع أكثر من 24");
        throw e;
      }
      await auditTenant(db, req, "labor.recorded", "project", b.projectId, { date: b.workDate, rows: b.rows.length });
      return { ok: true };
    });
  });

  /** A month on projects: hours per project, and the payroll allocation if made. */
  app.get("/labor/summary", { preHandler: requireTenant("labor.view") }, async (req) => {
    const q = z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).parse(req.query);
    return tenantTx(req, async (db) => {
      const run = (await db.query<{ id: string; status: string }>("SELECT id, status FROM payroll_runs WHERE period = $1", [q.period])).rows[0] ?? null;
      const alloc = run ? (await db.query<{ id: string; allocated: number; unallocated: number; created_at: string }>(
        "SELECT id, allocated::float8 AS allocated, unallocated::float8 AS unallocated, created_at FROM labor_allocations WHERE run_id = $1", [run.id])).rows[0] ?? null : null;
      const projects = (await db.query(
        `SELECT p.id, p.code, p.name, coalesce(sum(t.hours), 0)::float8 AS hours, count(DISTINCT t.employee_id)::int AS employees,
                (SELECT l.amount::float8 FROM labor_allocation_lines l WHERE l.allocation_id = $2 AND l.project_id = p.id) AS amount
           FROM projects p LEFT JOIN labor_timesheets t ON t.project_id = p.id AND to_char(t.work_date, 'YYYY-MM') = $1
          GROUP BY p.id HAVING coalesce(sum(t.hours), 0) > 0 OR (SELECT count(*) FROM labor_allocation_lines l WHERE l.allocation_id = $2 AND l.project_id = p.id) > 0
          ORDER BY p.code`, [q.period, alloc?.id ?? null])).rows;
      return { period: q.period, run: run ? { id: run.id, status: run.status } : null, allocation: alloc, projects };
    }, { readOnly: true });
  });

  /**
   * Allocates an approved payroll run to the projects of its month by hours. Each employee's full cost (pay after
   * penalties, employer GOSI, end-of-service accrual) is opened here only to be summed per project.
   */
  app.post("/payroll/runs/:id/allocate-projects", { preHandler: requireTenant("labor.allocate") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const run = (await db.query<{ period: string; status: string }>("SELECT period, status FROM payroll_runs WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!run) throw notFound("المسير غير موجود");
      if (run.status === "draft") throw conflict("اعتمد المسير أولاً");
      if ((await db.query("SELECT 1 FROM labor_allocations WHERE run_id = $1", [id])).rowCount) throw conflict("حُمّل هذا المسير على المشاريع من قبل", "already_allocated");
      const lines = (await db.query<{ employee_id: string; amounts_enc: string }>("SELECT employee_id, amounts_enc FROM payroll_lines WHERE run_id = $1", [id])).rows;
      const att = new Map((await db.query<{ e: string; h: string }>(
        `SELECT employee_id AS e, sum(hours + overtime_hours)::text AS h FROM attendance WHERE status = 'present' AND to_char(work_date, 'YYYY-MM') = $1 GROUP BY employee_id`,
        [run.period])).rows.map((r) => [r.e, Number(r.h)]));
      const hrs = (await db.query<{ e: string; p: string; h: string }>(
        `SELECT employee_id AS e, project_id AS p, sum(hours)::text AS h FROM labor_timesheets WHERE to_char(work_date, 'YYYY-MM') = $1 GROUP BY employee_id, project_id`, [run.period])).rows;
      const r = allocateLabor(lines.map((l) => {
        const a = openHr<{ gross: number; penalty: number; gosiEmployer: number; eosAccrual: number }>(l.amounts_enc);
        return { cost: a.gross - a.penalty + a.gosiEmployer + Math.max(0, a.eosAccrual), attendanceHours: att.get(l.employee_id) ?? 0,
          projectHours: Object.fromEntries(hrs.filter((x) => x.e === l.employee_id).map((x) => [x.p, Number(x.h)])) };
      }));
      if (r.allocated <= 0) throw badRequest("لا ساعات مسجلة على المشاريع لموظفي هذا المسير في شهره");
      await ensureContractingAccounts(db);
      const x = (await db.query<{ id: string }>("INSERT INTO labor_allocations (tenant_id, run_id, allocated, unallocated, created_by) VALUES (app_tenant_id(), $1, $2, $3, app_user_id()) RETURNING id",
        [id, r.allocated / 100, r.unallocated / 100])).rows[0]!;
      for (const [projectId, v] of r.byProject) {
        await db.query("INSERT INTO labor_allocation_lines (tenant_id, allocation_id, project_id, hours, amount) VALUES (app_tenant_id(), $1, $2, $3, $4)",
          [x.id, projectId, v.hours, v.amount / 100]);
      }
      await postLaborAllocation(db, x.id);
      await auditTenant(db, req, "labor.allocated", "payroll_run", id, { allocated: r.allocated / 100, projects: r.byProject.size });
      return { id: x.id, allocated: r.allocated / 100, unallocated: r.unallocated / 100, projects: r.byProject.size };
    });
  });
}
