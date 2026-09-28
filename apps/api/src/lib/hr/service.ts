import type { Db } from "../../db/pool.ts";
import { AppError } from "../errors.ts";
import { annualLeaveAccrued, type GosiRate, type GosiScheme, type Pay, type PayLine } from "./payroll.ts";
import { openHr } from "./seal.ts";

/** The GOSI rates in force on a date for a scheme (the latest valid_from on or before it). */
export async function gosiRate(db: Db, scheme: GosiScheme, on: string): Promise<GosiRate> {
  const r = (await db.query<{ ep: string; erp: string; es: string; ers: string; eh: string; c: string }>(
    `SELECT employee_pension::text AS ep, employer_pension::text AS erp, employee_saned::text AS es, employer_saned::text AS ers, employer_hazard::text AS eh, wage_ceiling::text AS c
       FROM gosi_rates WHERE scheme = $1 AND valid_from <= $2::date ORDER BY valid_from DESC LIMIT 1`, [scheme, on])).rows[0];
  if (!r) throw new AppError(409, "gosi_rates_missing", "لا توجد نسب تأمينات سارية لهذا التاريخ");
  return { employeePension: Number(r.ep), employerPension: Number(r.erp), employeeSaned: Number(r.es), employerSaned: Number(r.ers), employerHazard: Number(r.eh), wageCeiling: Number(r.c) };
}

export interface EmployeeRow {
  id: string; code: string; name: string; gender: "male" | "female"; nationality: string; hire_date: string; gosi_first_registered: string | null;
  pay_enc: string; iban_enc: string | null; id_number_enc: string; cost_center_id: string | null; branch_id: string | null; status: string; terminated_on: string | null;
}
export const EMPLOYEE_COLS = `id, code, name, gender, nationality, hire_date::text, gosi_first_registered::text, pay_enc, iban_enc, id_number_enc, cost_center_id, branch_id, status, terminated_on::text`;
export const payOf = (e: Pick<EmployeeRow, "pay_enc">) => openHr<Pay>(e.pay_enc);

/** The end-of-service provision built so far for one employee: the accruals of approved payroll runs. */
export async function eosProvisioned(db: Db, employeeId: string): Promise<number> {
  const rows = (await db.query<{ a: string }>(
    "SELECT l.amounts_enc AS a FROM payroll_lines l JOIN payroll_runs r ON r.id = l.run_id WHERE l.employee_id = $1 AND r.status <> 'draft'", [employeeId])).rows;
  return rows.reduce((s, r) => s + openHr<PayLine>(r.a).eosAccrual, 0);
}

/**
 * Leave balances on a date: annual (accrued by service − approved annual days) and compensatory (overtime hours
 * taken as leave, 8 to a day − approved compensatory days).
 */
export async function leaveBalances(db: Db, employeeId: string, hire: string, asOf: string) {
  const taken = new Map((await db.query<{ kind: string; d: number }>(
    `SELECT t.kind, coalesce(sum(r.days), 0)::int AS d FROM leave_requests r JOIN leave_types t ON t.id = r.leave_type_id
      WHERE r.employee_id = $1 AND r.status = 'approved' GROUP BY t.kind`, [employeeId])).rows.map((r) => [r.kind, r.d]));
  const pendingAnnual = (await db.query<{ d: number }>(
    `SELECT coalesce(sum(r.days), 0)::int AS d FROM leave_requests r JOIN leave_types t ON t.id = r.leave_type_id
      WHERE r.employee_id = $1 AND r.status = 'requested' AND t.kind = 'annual'`, [employeeId])).rows[0]!.d;
  const overtimeLeave = Number((await db.query<{ h: string }>(
    "SELECT coalesce(sum(overtime_hours), 0)::text AS h FROM attendance WHERE employee_id = $1 AND overtime_as_leave", [employeeId])).rows[0]!.h);
  const accrued = annualLeaveAccrued(hire, asOf);
  return {
    annual: { accrued, taken: taken.get("annual") ?? 0, pending: pendingAnnual, balance: Math.round((accrued - (taken.get("annual") ?? 0)) * 100) / 100 },
    compensatory: { earned: Math.round(overtimeLeave / 8 * 100) / 100, taken: taken.get("compensatory") ?? 0, balance: Math.round((overtimeLeave / 8 - (taken.get("compensatory") ?? 0)) * 100) / 100 },
  };
}

/** A period's first and last day ("2026-09" → 2026-09-01 … 2026-09-30). */
export function periodBounds(period: string) {
  const [y, m] = period.split("-").map(Number) as [number, number];
  const end = new Date(Date.UTC(y, m, 0));
  return { start: `${period}-01`, end: end.toISOString().slice(0, 10), days: end.getUTCDate() };
}

/** Payroll periods already approved are closed: their attendance and leaves no longer change. */
export async function assertPeriodOpen(db: Db, date: string) {
  if ((await db.query("SELECT 1 FROM payroll_runs WHERE period = $1 AND status <> 'draft'", [date.slice(0, 7)])).rowCount) {
    throw new AppError(409, "payroll_period_closed", `مسير ${date.slice(0, 7)} معتمد: لا يُعدَّل حضوره ولا إجازاته`);
  }
}
