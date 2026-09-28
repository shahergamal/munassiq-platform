import ExcelJS from "exceljs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../../db/pool.ts";
import { postPayrollPayment, postPayrollRun } from "../../lib/accounting/posting.ts";
import { AppError, badRequest, notFound } from "../../lib/errors.ts";
import { endOfService, fixedWage, gosiBase, gosiScheme, h, payMonth, sickLeaveUnpaidDays, type PayLine } from "../../lib/hr/payroll.ts";
import { ensurePayrollAccounts, openHr, sealHr } from "../../lib/hr/seal.ts";
import { EMPLOYEE_COLS, eosProvisioned, gosiRate, payOf, periodBounds, type EmployeeRow } from "../../lib/hr/service.ts";
import { auditTenant, isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";
import { today } from "../restaurants/batches.ts";

// The monthly payroll for every sector (ARCHITECTURE.md, M7): draft (computed from contracts, attendance, leaves
// and adjustments, recomputed at will) → approved (posted, closed) → paid (posted). Per-employee amounts are
// sealed; the run keeps totals. The wage protection file for Mudad and a bank file come from an approved run.

const PERIOD = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "الفترة بصيغة YYYY-MM");
const dayNo = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);
const overlap = (a1: string, a2: string, b1: string, b2: string) => Math.max(0, Math.min(dayNo(a2), dayNo(b2)) - Math.max(dayNo(a1), dayNo(b1)) + 1);
const maxIso = (a: string, b: string) => (a > b ? a : b);
const minIso = (a: string, b: string) => (a < b ? a : b);
const riyal = (v: number) => Math.round(v) / 100;

interface Line extends PayLine { employeeId: string; scheme: string; costCenterId: string | null; branchId: string | null }

/** Every employee on the books during the period, computed from their contract and the period's records. */
async function compute(db: Db, period: string): Promise<Line[]> {
  const { start, end, days: monthDays } = periodBounds(period);
  const emps = (await db.query<EmployeeRow & { work_cc: string | null }>(
    `SELECT ${EMPLOYEE_COLS}, (SELECT w.cost_center_id FROM work_centers w WHERE w.id = employees.work_center_id) AS work_cc FROM employees
      WHERE hire_date <= $2::date AND (status = 'active' OR terminated_on >= $1::date) ORDER BY code`, [start, end])).rows;
  const out: Line[] = [];
  for (const e of emps) {
    const from = maxIso(e.hire_date, start);
    const to = e.terminated_on ? minIso(e.terminated_on, end) : end;
    const employedDays = overlap(from, to, start, end);
    if (employedDays <= 0) continue;
    const pay = payOf(e);
    const scheme = gosiScheme(e.nationality, e.gosi_first_registered);
    const rate = await gosiRate(db, scheme, start);
    const leaves = (await db.query<{ kind: string; paid: boolean; s: string; e: string }>(
      `SELECT t.kind, t.paid, r.start_date::text AS s, r.end_date::text AS e FROM leave_requests r JOIN leave_types t ON t.id = r.leave_type_id
        WHERE r.employee_id = $1 AND r.status = 'approved' AND r.end_date >= $2::date - 365 AND r.start_date <= $3::date ORDER BY r.start_date`, [e.id, start, end])).rows;
    let unpaidLeaveDays = 0;
    let sickUnpaidDays = 0;
    for (const l of leaves) {
      const inPeriod = overlap(l.s, l.e, from, to);
      if (!inPeriod) continue;
      if (l.kind === "unpaid" || !l.paid) unpaidLeaveDays += inPeriod;
      else if (l.kind === "sick") {
        // Sick days already taken in the year before this stretch (Article 117 counts from the first sick day of the year).
        const s = maxIso(l.s, from);
        const yearBefore = new Date((dayNo(s) - 365) * 86_400_000).toISOString().slice(0, 10);
        const prior = leaves.filter((x) => x.kind === "sick" && x !== l).reduce((a, x) => a + overlap(x.s, x.e, yearBefore, new Date((dayNo(s) - 1) * 86_400_000).toISOString().slice(0, 10)), 0)
          + overlap(l.s, l.e, yearBefore, new Date((dayNo(s) - 1) * 86_400_000).toISOString().slice(0, 10));
        sickUnpaidDays += sickLeaveUnpaidDays(prior, inPeriod);
      }
    }
    const att = (await db.query<{ ot: string; absent: number }>(
      `SELECT coalesce(sum(a.overtime_hours) FILTER (WHERE NOT a.overtime_as_leave), 0)::text AS ot,
              count(*) FILTER (WHERE a.status = 'absent' AND NOT EXISTS (SELECT 1 FROM leave_requests r WHERE r.employee_id = a.employee_id AND r.status = 'approved'
                                                                        AND a.work_date BETWEEN r.start_date AND r.end_date))::int AS absent
         FROM attendance a WHERE a.employee_id = $1 AND a.work_date BETWEEN $2 AND $3`, [e.id, from, to])).rows[0]!;
    const adj = (await db.query<{ kind: string; amount_enc: string }>("SELECT kind, amount_enc FROM payroll_adjustments WHERE employee_id = $1 AND period = $2", [e.id, period])).rows;
    const sum = (k: string) => adj.filter((a) => a.kind === k).reduce((s, a) => s + h(openHr<number>(a.amount_enc)), 0);
    const eos = endOfService(fixedWage(pay), e.hire_date, to, "termination");
    const line = payMonth({
      pay, rate, employedDays, monthDays, overtimeHours: Number(att.ot), absentDays: att.absent, unpaidLeaveDays, sickUnpaidDays,
      bonus: sum("bonus"), advanceRecovery: sum("advance_recovery"), penalty: sum("penalty"),
      eosEntitlement: eos.full, eosProvisioned: await eosProvisioned(db, e.id),
    });
    out.push({ ...line, employeeId: e.id, scheme, costCenterId: e.cost_center_id ?? e.work_cc, branchId: e.branch_id });
  }
  return out;
}

async function writeRun(db: Db, runId: string, period: string) {
  const lines = await compute(db, period);
  await db.query("DELETE FROM payroll_lines WHERE run_id = $1", [runId]);
  for (const l of lines) {
    await db.query("INSERT INTO payroll_lines (tenant_id, run_id, employee_id, cost_center_id, branch_id, amounts_enc) VALUES (app_tenant_id(), $1, $2, $3, $4, $5)",
      [runId, l.employeeId, l.costCenterId, l.branchId, sealHr(l)]);
  }
  const t = (k: keyof PayLine) => riyal(lines.reduce((a, l) => a + (l[k] as number), 0));
  await db.query("UPDATE payroll_runs SET employees = $2, gross = $3, deductions = $4, net = $5, employer_gosi = $6, eos_accrual = $7 WHERE id = $1",
    [runId, lines.length, t("gross"), t("deductions"), t("net"), t("gosiEmployer"), t("eosAccrual")]);
  return lines.length;
}

const RUN_COLS = `id, period, status, employees, gross::float8 AS gross, deductions::float8 AS deductions, net::float8 AS net, employer_gosi::float8 AS "employerGosi",
  eos_accrual::float8 AS "eosAccrual", payment_method AS "paymentMethod", paid_on::text AS "paidOn", created_at AS "createdAt", approved_at AS "approvedAt"`;

/** Lines of a run with the employee and the amounts (riyals), for the page and the files. */
async function linesOf(db: Db, runId: string) {
  const rows = (await db.query<{ amounts_enc: string; employee_id: string; code: string; name: string; id_number_enc: string; id_type: string; iban_enc: string | null; bank_code: string | null;
    pay_enc: string; gosi_first_registered: string | null; nationality: string }>(
    `SELECT l.amounts_enc, l.employee_id, e.code, e.name, e.id_number_enc, e.id_type, e.iban_enc, e.bank_code, e.pay_enc, e.gosi_first_registered::text, e.nationality
       FROM payroll_lines l JOIN employees e ON e.id = l.employee_id WHERE l.run_id = $1 ORDER BY e.code`, [runId])).rows;
  return rows.map((r) => {
    const a = openHr<Line>(r.amounts_enc);
    const amounts = (["basic", "housing", "transport", "other", "overtime", "bonus", "absence", "unpaidLeave", "sick", "gross", "gosiBase", "gosiEmployee", "gosiEmployer",
      "advanceRecovery", "penalty", "deductions", "net", "eosAccrual"] as const).map((k) => [k, riyal(a[k])]);
    return { r, a, view: { employeeId: r.employee_id, code: r.code, name: r.name, scheme: a.scheme, days: a.days, ...Object.fromEntries(amounts) } };
  });
}

export default async function payrollRoutes(app: FastifyInstance) {
  app.get("/payroll/runs", { preHandler: requireTenant("payroll.view") }, async (req) =>
    tenantTx(req, async (db) => ({ items: (await db.query(`SELECT ${RUN_COLS} FROM payroll_runs ORDER BY period DESC LIMIT 60`)).rows }), { readOnly: true }));

  app.get("/payroll/runs/:id", { preHandler: requireTenant("payroll.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const run = (await db.query(`SELECT ${RUN_COLS} FROM payroll_runs WHERE id = $1`, [id])).rows[0];
      if (!run) throw notFound("المسير غير موجود");
      const journal = (await db.query(`SELECT id, entry_number::int AS number, source_type AS "sourceType" FROM journal_entries WHERE source_type IN ('payroll_run', 'payroll_payment') AND source_id = $1`, [id])).rows;
      return { ...run, journal, lines: (await linesOf(db, id)).map((x) => x.view) };
    }, { readOnly: true });
  });

  // Create (or recompute) the draft for a month.
  app.post("/payroll/runs", { preHandler: requireTenant("payroll.run") }, async (req, reply) => {
    const { period } = z.object({ period: PERIOD }).parse(req.body);
    if (period > today().slice(0, 7)) throw badRequest("لا يُعدّ مسير شهر لم يبدأ");
    const out = await tenantTx(req, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext('payroll:' || $1))", [period]);
      const cur = (await db.query<{ id: string; status: string }>("SELECT id, status FROM payroll_runs WHERE period = $1", [period])).rows[0];
      if (cur && cur.status !== "draft") throw new AppError(409, "payroll_final", `مسير ${period} معتمد من قبل`);
      const id = cur?.id ?? (await db.query<{ id: string }>("INSERT INTO payroll_runs (tenant_id, period, created_by) VALUES (app_tenant_id(), $1, app_user_id()) RETURNING id", [period])).rows[0]!.id;
      const n = await writeRun(db, id, period);
      if (!n) throw new AppError(422, "no_employees", "لا يوجد موظفون على رأس العمل في هذا الشهر");
      await auditTenant(db, req, cur ? "payroll.recomputed" : "payroll.created", "payroll_run", id, { period, employees: n });
      return { id, created: !cur };
    });
    return reply.status(out.created ? 201 : 200).send({ id: out.id });
  });

  app.delete("/payroll/runs/:id", { preHandler: requireTenant("payroll.run") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    await tenantTx(req, async (db) => {
      const r = await db.query("DELETE FROM payroll_runs WHERE id = $1 AND status = 'draft'", [id]);
      if (!r.rowCount) throw new AppError(409, "invalid_state", "يُحذف المسير المسودة فقط");
      await auditTenant(db, req, "payroll.deleted", "payroll_run", id);
    });
    return { ok: true };
  });

  // Approval recomputes once more (so it reflects the latest records), closes the period and posts the run.
  app.post("/payroll/runs/:id/approve", { preHandler: requireTenant("payroll.approve") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const r = (await db.query<{ status: string; period: string }>("SELECT status, period FROM payroll_runs WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!r) throw notFound("المسير غير موجود");
      if (r.status !== "draft") throw new AppError(409, "invalid_state", "المسير معتمد من قبل");
      if ((await db.query("SELECT 1 FROM payroll_runs WHERE status = 'draft' AND period < $1", [r.period])).rowCount) throw new AppError(409, "earlier_draft", "اعتمد مسير الشهر السابق أولاً");
      await writeRun(db, id, r.period);
      await ensurePayrollAccounts(db);
      await db.query("UPDATE payroll_runs SET status = 'approved', approved_by = app_user_id(), approved_at = now() WHERE id = $1", [id]);
      const journal = await postPayrollRun(db, id);
      await auditTenant(db, req, "payroll.approved", "payroll_run", id, { period: r.period });
      return { ok: true, journalId: journal };
    });
  });

  app.post("/payroll/runs/:id/pay", { preHandler: requireTenant("payroll.pay") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ method: z.enum(["bank_transfer", "cash"]), paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.body);
    const paidOn = b.paidOn ?? today();
    if (paidOn > today()) throw badRequest("تاريخ الصرف لا يكون في المستقبل");
    return tenantTx(req, async (db) => {
      const r = (await db.query<{ status: string; period: string }>("SELECT status, period FROM payroll_runs WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!r) throw notFound("المسير غير موجود");
      if (r.status === "paid") return { ok: true, replay: true };
      if (r.status !== "approved") throw new AppError(409, "invalid_state", "اعتمد المسير قبل صرفه");
      await db.query("UPDATE payroll_runs SET status = 'paid', payment_method = $2, paid_on = $3 WHERE id = $1", [id, b.method, paidOn]);
      const journal = await postPayrollPayment(db, id);
      await auditTenant(db, req, "payroll.paid", "payroll_run", id, { period: r.period, method: b.method });
      return { ok: true, replay: false, journalId: journal };
    });
  });

  // ── Adjustments (bonus, advance recovery, penalty) for a month ────────────────────────────────
  app.get("/payroll/adjustments", { preHandler: requireTenant("payroll.view") }, async (req) => {
    const period = PERIOD.parse((req.query as { period?: string }).period ?? today().slice(0, 7));
    return tenantTx(req, async (db) => ({
      items: (await db.query<{ id: string; kind: string; amount_enc: string; note: string; code: string; name: string; employee_id: string }>(
        `SELECT a.id, a.kind, a.amount_enc, a.note, e.code, e.name, e.id AS employee_id FROM payroll_adjustments a JOIN employees e ON e.id = a.employee_id WHERE a.period = $1 ORDER BY e.code`, [period])).rows
        .map((a) => ({ id: a.id, kind: a.kind, amount: openHr<number>(a.amount_enc), note: a.note, code: a.code, name: a.name, employeeId: a.employee_id })),
    }), { readOnly: true });
  });
  app.post("/payroll/adjustments", { preHandler: requireTenant("payroll.run") }, async (req, reply) => {
    const b = z.object({ employeeId: z.string().uuid(), period: PERIOD, kind: z.enum(["bonus", "advance_recovery", "penalty"]), amount: z.number().positive().max(1_000_000),
      note: z.string().trim().min(2, "اذكر السبب").max(200) }).parse(req.body);
    const id = await tenantTx(req, async (db) => {
      if ((await db.query("SELECT 1 FROM payroll_runs WHERE period = $1 AND status <> 'draft'", [b.period])).rowCount) throw new AppError(409, "payroll_period_closed", "مسير الشهر معتمد");
      const r = (await db.query<{ id: string }>(
        "INSERT INTO payroll_adjustments (tenant_id, employee_id, period, kind, amount_enc, note, created_by) VALUES (app_tenant_id(), $1, $2, $3, $4, $5, app_user_id()) RETURNING id",
        [b.employeeId, b.period, b.kind, sealHr(b.amount), b.note])).rows[0]!;
      await auditTenant(db, req, "payroll.adjustment", "payroll_adjustment", r.id, { kind: b.kind, period: b.period });
      return r.id;
    });
    return reply.status(201).send({ id });
  });
  app.delete("/payroll/adjustments/:id", { preHandler: requireTenant("payroll.run") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    await tenantTx(req, async (db) => {
      const r = await db.query("DELETE FROM payroll_adjustments a WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM payroll_runs r WHERE r.period = a.period AND r.status <> 'draft')", [id]);
      if (!r.rowCount) throw new AppError(409, "invalid_state", "التعديل غير موجود أو مسير شهره معتمد");
      await auditTenant(db, req, "payroll.adjustment_removed", "payroll_adjustment", id);
    });
    return { ok: true };
  });

  // ── Wage protection (Mudad) ─────────────────────────────────────────────────────────────────
  /**
   * Before uploading: every employee needs a valid ID number and IBAN, a positive net, and a GOSI registered wage
   * that matches the base this payroll computed (Mudad matches the file against GOSI and the bank transfer).
   */
  app.get("/payroll/runs/:id/wps-check", { preHandler: requireTenant("payroll.export") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const run = (await db.query<{ period: string; status: string }>("SELECT period, status FROM payroll_runs WHERE id = $1", [id])).rows[0];
      if (!run) throw notFound("المسير غير موجود");
      const issues: { code: string; name: string; problem: string }[] = [];
      for (const { r, a } of await linesOf(db, id)) {
        const idNo = openHr<string>(r.id_number_enc);
        if (!/^[12]\d{9}$/.test(idNo)) issues.push({ code: r.code, name: r.name, problem: "رقم الهوية أو الإقامة ليس 10 أرقام تبدأ بـ 1 أو 2" });
        if (!r.iban_enc) issues.push({ code: r.code, name: r.name, problem: "لا يوجد آيبان" });
        if (a.net <= 0) issues.push({ code: r.code, name: r.name, problem: "صافي الراتب صفر أو أقل" });
        const pay = payOf({ pay_enc: r.pay_enc });
        const rate = await gosiRate(db, gosiScheme(r.nationality, r.gosi_first_registered), `${run.period}-01`);
        if (pay.gosiRegisteredWage !== null && pay.gosiRegisteredWage !== undefined && h(pay.gosiRegisteredWage) !== gosiBase(pay, rate.wageCeiling)) {
          issues.push({ code: r.code, name: r.name, problem: `الأجر المسجل في التأمينات (${pay.gosiRegisteredWage}) يختلف عن الأساسي والسكن (${gosiBase(pay, rate.wageCeiling) / 100})` });
        }
      }
      const [y, m] = run.period.split("-").map(Number) as [number, number];
      return { period: run.period, status: run.status, deadline: new Date(Date.UTC(y, m, 30)).toISOString().slice(0, 10), issues };
    }, { readOnly: true });
  });

  /**
   * The files: `mudad` (the wage protection sheet: ID, name, bank, IBAN, basic, housing, other earnings,
   * deductions, net) and `bank` (a generic CSV of IBAN, name and amount). Column layouts differ by bank and change
   * with Mudad's template: they live here, one place to adjust.
   */
  app.get("/payroll/runs/:id/file/:format", { preHandler: requireTenant("payroll.export") }, async (req, reply) => {
    const { id, format } = req.params as { id: string; format: string };
    if (!isUuid(id) || !["mudad", "bank"].includes(format)) throw notFound();
    const data = await tenantTx(req, async (db) => {
      const run = (await db.query<{ period: string; status: string }>("SELECT period, status FROM payroll_runs WHERE id = $1", [id])).rows[0];
      if (!run) throw notFound("المسير غير موجود");
      if (run.status === "draft") throw new AppError(409, "invalid_state", "اعتمد المسير قبل تصدير ملفاته");
      const rows = (await linesOf(db, id)).map(({ r, a }) => ({
        id: openHr<string>(r.id_number_enc), name: r.name, bank: r.bank_code ?? "", iban: r.iban_enc ? openHr<string>(r.iban_enc) : "",
        basic: riyal(a.basic), housing: riyal(a.housing), other: riyal(a.transport + a.other + a.overtime + a.bonus - a.absence - a.unpaidLeave - a.sick),
        deductions: riyal(a.deductions), net: riyal(a.net),
      }));
      await auditTenant(db, req, "payroll.exported", "payroll_run", id, { format });
      return { period: run.period, rows };
    });
    if (format === "bank") {
      const csv = ["IBAN,Name,Amount,Reference", ...data.rows.map((r) => [r.iban, `"${r.name.replace(/"/g, '""')}"`, r.net.toFixed(2), `SALARY-${data.period}`].join(","))].join("\r\n");
      return reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="salaries-${data.period}.csv"`)
        .header("cache-control", "private, no-store").send(`﻿${csv}`);
    }
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("WPS");
    ws.columns = [
      { header: "Employee ID (National ID / Iqama)", key: "id", width: 18 }, { header: "Employee Name", key: "name", width: 30 }, { header: "Bank Code", key: "bank", width: 10 },
      { header: "IBAN", key: "iban", width: 28 }, { header: "Basic Salary", key: "basic", width: 14 }, { header: "Housing Allowance", key: "housing", width: 14 },
      { header: "Other Earnings", key: "other", width: 14 }, { header: "Deductions", key: "deductions", width: 14 }, { header: "Net Salary", key: "net", width: 14 },
    ];
    for (const r of data.rows) ws.addRow(r);
    const buf = await wb.xlsx.writeBuffer();
    return reply.header("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("content-disposition", `attachment; filename="wps-${data.period}.xlsx"`).header("cache-control", "private, no-store").send(Buffer.from(buf));
  });
}
