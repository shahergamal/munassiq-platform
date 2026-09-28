import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError, badRequest, notFound } from "../../lib/errors.ts";
import { assertPeriodOpen, leaveBalances } from "../../lib/hr/service.ts";
import { auditTenant, isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";
import { today } from "../restaurants/batches.ts";

// Attendance (daily hours, overtime, absence) and leave requests for every sector (ARCHITECTURE.md, M7). Both
// feed the payroll; a period whose payroll is approved is closed to changes.

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح");
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000) + 1;

export default async function hrTimeRoutes(app: FastifyInstance) {
  // ── Attendance ──────────────────────────────────────────────────────────────────────────────
  // One day's sheet: every active employee, with what is recorded (nothing recorded = not yet entered).
  app.get("/attendance", { preHandler: requireTenant("attendance.view") }, async (req) => {
    const d = date.parse((req.query as { date?: string }).date ?? today());
    return tenantTx(req, async (db) => ({
      date: d,
      closed: Boolean((await db.query("SELECT 1 FROM payroll_runs WHERE period = $1 AND status <> 'draft'", [d.slice(0, 7)])).rowCount),
      items: (await db.query(
        `SELECT e.id AS "employeeId", e.code, e.name, e.job_title AS "jobTitle", e.work_center_id AS "defaultWorkCenterId",
                a.status, a.hours::float8 AS hours, a.overtime_hours::float8 AS "overtimeHours", a.overtime_as_leave AS "overtimeAsLeave", a.work_center_id AS "workCenterId", a.note,
                (SELECT t.name FROM leave_requests r JOIN leave_types t ON t.id = r.leave_type_id
                  WHERE r.employee_id = e.id AND r.status = 'approved' AND $1::date BETWEEN r.start_date AND r.end_date LIMIT 1) AS "onLeave"
           FROM employees e LEFT JOIN attendance a ON a.employee_id = e.id AND a.work_date = $1
          WHERE e.status = 'active' AND e.hire_date <= $1 ORDER BY e.code`, [d])).rows,
    }), { readOnly: true });
  });

  app.put("/attendance", { preHandler: requireTenant("attendance.record") }, async (req) => {
    const b = z.object({
      date,
      rows: z.array(z.object({
        employeeId: z.string().uuid(),
        status: z.enum(["present", "absent", "leave", "weekend", "holiday"]),
        hours: z.number().min(0).max(24).default(0),
        overtimeHours: z.number().min(0).max(12).default(0),
        overtimeAsLeave: z.boolean().default(false),
        workCenterId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
        note: z.string().trim().max(200).nullable().optional().transform((v) => v || null),
      })).min(1).max(500),
    }).parse(req.body);
    if (b.date > today()) throw badRequest("لا يُسجَّل حضور يوم لم يأتِ");
    for (const r of b.rows) if (r.status !== "present" && (r.hours || r.overtimeHours)) throw badRequest("الساعات والعمل الإضافي للحاضر فقط");
    return tenantTx(req, async (db) => {
      await assertPeriodOpen(db, b.date);
      for (const r of b.rows) {
        await db.query(
          `INSERT INTO attendance (tenant_id, employee_id, work_date, status, hours, overtime_hours, overtime_as_leave, work_center_id, note, recorded_by)
           VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, app_user_id())
           ON CONFLICT (tenant_id, employee_id, work_date) DO UPDATE SET status = EXCLUDED.status, hours = EXCLUDED.hours, overtime_hours = EXCLUDED.overtime_hours,
             overtime_as_leave = EXCLUDED.overtime_as_leave, work_center_id = EXCLUDED.work_center_id, note = EXCLUDED.note, recorded_by = app_user_id(), recorded_at = now()`,
          [r.employeeId, b.date, r.status, r.hours, r.overtimeHours, r.overtimeAsLeave, r.workCenterId, r.note]);
      }
      await auditTenant(db, req, "attendance.recorded", "attendance", b.rows[0]!.employeeId, { date: b.date, rows: b.rows.length });
      return { ok: true, saved: b.rows.length };
    });
  });

  // A month per employee: days present/absent, hours and overtime (for the payroll and for labour on work centers).
  app.get("/attendance/summary", { preHandler: requireTenant("attendance.view", "payroll.view") }, async (req) => {
    const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).parse((req.query as { period?: string }).period ?? today().slice(0, 7));
    return tenantTx(req, async (db) => ({
      period,
      items: (await db.query(
        `SELECT e.id AS "employeeId", e.code, e.name, count(*) FILTER (WHERE a.status = 'present')::int AS present, count(*) FILTER (WHERE a.status = 'absent')::int AS absent,
                coalesce(sum(a.hours), 0)::float8 AS hours, coalesce(sum(a.overtime_hours) FILTER (WHERE NOT a.overtime_as_leave), 0)::float8 AS "overtimePaid",
                coalesce(sum(a.overtime_hours) FILTER (WHERE a.overtime_as_leave), 0)::float8 AS "overtimeAsLeave"
           FROM employees e LEFT JOIN attendance a ON a.employee_id = e.id AND to_char(a.work_date, 'YYYY-MM') = $1
          WHERE e.status = 'active' OR e.terminated_on >= to_date($1 || '-01', 'YYYY-MM-DD') GROUP BY e.id ORDER BY e.code`, [period])).rows,
      byWorkCenter: (await db.query(
        `SELECT w.id AS "workCenterId", w.name, coalesce(sum(a.hours + a.overtime_hours), 0)::float8 AS hours
           FROM attendance a JOIN work_centers w ON w.id = coalesce(a.work_center_id, (SELECT e.work_center_id FROM employees e WHERE e.id = a.employee_id))
          WHERE to_char(a.work_date, 'YYYY-MM') = $1 AND a.status = 'present' GROUP BY w.id ORDER BY w.name`, [period])).rows,
    }), { readOnly: true });
  });

  // ── Leaves ──────────────────────────────────────────────────────────────────────────────────
  app.get("/leave-types", { preHandler: requireTenant("leaves.view", "leaves.request") }, async (req) =>
    tenantTx(req, async (db) => ({
      items: (await db.query(`SELECT id, code, name, kind, max_days AS "maxDays", paid, gender FROM leave_types WHERE is_active ORDER BY kind = 'annual' DESC, name`)).rows,
    }), { readOnly: true }));

  app.get("/leaves", { preHandler: requireTenant("leaves.view") }, async (req) => {
    const q = req.query as { status?: string; employeeId?: string };
    const status = ["requested", "approved", "rejected", "cancelled"].includes(q.status ?? "") ? q.status! : null;
    return tenantTx(req, async (db) => ({
      items: (await db.query(
        `SELECT r.id, r.start_date::text AS "startDate", r.end_date::text AS "endDate", r.days, r.status, r.note, r.created_at AS "createdAt", r.decided_at AS "decidedAt",
                e.id AS "employeeId", e.code, e.name, t.name AS "typeName", t.kind
           FROM leave_requests r JOIN employees e ON e.id = r.employee_id JOIN leave_types t ON t.id = r.leave_type_id
          WHERE ($1::text IS NULL OR r.status = $1) AND ($2::uuid IS NULL OR r.employee_id = $2)
          ORDER BY r.status = 'requested' DESC, r.start_date DESC LIMIT 300`, [status, isUuid(q.employeeId) ? q.employeeId : null])).rows,
    }), { readOnly: true });
  });

  app.post("/leaves", { preHandler: requireTenant("leaves.request") }, async (req, reply) => {
    const b = z.object({
      employeeId: z.string().uuid("اختر الموظف"),
      leaveTypeId: z.string().uuid("اختر نوع الإجازة"),
      startDate: date, endDate: date,
      note: z.string().trim().max(500).nullable().optional().transform((v) => v || null),
    }).parse(req.body);
    if (b.endDate < b.startDate) throw badRequest("نهاية الإجازة قبل بدايتها");
    const days = daysBetween(b.startDate, b.endDate);
    const id = await tenantTx(req, async (db) => {
      const e = (await db.query<{ gender: string; hire_date: string; status: string }>("SELECT gender, hire_date::text, status FROM employees WHERE id = $1", [b.employeeId])).rows[0];
      if (!e || e.status !== "active") throw notFound("الموظف غير موجود أو انتهت خدمته");
      const t = (await db.query<{ kind: string; max_days: number | null; gender: string | null; name: string }>(
        "SELECT kind, max_days, gender, name FROM leave_types WHERE id = $1 AND is_active", [b.leaveTypeId])).rows[0];
      if (!t) throw notFound("نوع الإجازة غير موجود");
      if (t.gender && t.gender !== e.gender) throw badRequest(`«${t.name}» لا تنطبق على هذا الموظف`);
      if (t.max_days && t.kind !== "sick" && days > t.max_days) throw badRequest(`«${t.name}» حتى ${t.max_days} يوماً`);
      if ((await db.query(`SELECT 1 FROM leave_requests WHERE employee_id = $1 AND status IN ('requested', 'approved') AND daterange(start_date, end_date, '[]') && daterange($2::date, $3::date, '[]')`,
        [b.employeeId, b.startDate, b.endDate])).rowCount) throw new AppError(409, "overlap", "لدى الموظف إجازة أخرى في هذه الأيام");
      if (t.kind === "annual" || t.kind === "compensatory") {
        const bal = await leaveBalances(db, b.employeeId, e.hire_date, b.endDate);
        const left = t.kind === "annual" ? bal.annual.balance - bal.annual.pending : bal.compensatory.balance;
        if (days > left + 1e-9) throw new AppError(409, "leave_balance", `الرصيد لا يكفي: المتاح ${Math.floor(left * 100) / 100} يوماً`);
      }
      await assertPeriodOpen(db, b.startDate);
      const r = (await db.query<{ id: string }>(
        `INSERT INTO leave_requests (tenant_id, employee_id, leave_type_id, start_date, end_date, days, note, created_by)
         VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, app_user_id()) RETURNING id`, [b.employeeId, b.leaveTypeId, b.startDate, b.endDate, days, b.note])).rows[0]!;
      await auditTenant(db, req, "leave.requested", "leave_request", r.id, { days });
      return r.id;
    });
    return reply.status(201).send({ id, days });
  });

  app.post("/leaves/:id/:action", { preHandler: requireTenant("leaves.approve", "leaves.request") }, async (req) => {
    const { id, action } = req.params as { id: string; action: string };
    if (!isUuid(id) || !["approve", "reject", "cancel"].includes(action)) throw notFound();
    if (action !== "cancel" && !req.tenant!.permissions.includes("leaves.approve")) throw new AppError(403, "forbidden", "اعتماد الإجازات لغير صلاحيتك");
    return tenantTx(req, async (db) => {
      const r = (await db.query<{ status: string; start_date: string }>("SELECT status, start_date::text FROM leave_requests WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!r) throw notFound("الطلب غير موجود");
      const from = action === "cancel" ? ["requested", "approved"] : ["requested"];
      if (!from.includes(r.status)) throw new AppError(409, "invalid_state", "الطلب ليس في حالة تسمح بذلك");
      await assertPeriodOpen(db, r.start_date);
      const to = action === "approve" ? "approved" : action === "reject" ? "rejected" : "cancelled";
      await db.query("UPDATE leave_requests SET status = $2, decided_by = app_user_id(), decided_at = now() WHERE id = $1", [id, to]);
      await auditTenant(db, req, `leave.${to}`, "leave_request", id);
      return { ok: true, status: to };
    });
  });
}
