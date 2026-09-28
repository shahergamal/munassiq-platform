// Payroll arithmetic for Saudi employers, pure (no database). Amounts in halalas (integers), rounded per item.
// Regulatory values come from the caller (the gosi_rates table), never from constants here.

export type Halalas = number;
export const h = (riyals: number): Halalas => Math.round(riyals * 100);

/** Monthly pay as agreed in the contract (riyals, as entered). */
export interface Pay {
  basic: number;
  housing: number;
  /** Housing provided in kind: counts for GOSI as two months' basic a year, and is not paid in cash. */
  housingInKind: boolean;
  transport: number;
  /** Other fixed monthly allowances. */
  other: number;
  /** The wage registered with GOSI, when it is known (checked against the computed base before the WPS file). */
  gosiRegisteredWage?: number | null;
}

export interface GosiRate { employeePension: number; employerPension: number; employeeSaned: number; employerSaned: number; employerHazard: number; wageCeiling: number }
export type GosiScheme = "old" | "new" | "non_saudi";

/** The new system applies to Saudis first registered with GOSI on or after 3 July 2024. */
export const NEW_SYSTEM_FROM = "2024-07-03";
export function gosiScheme(nationality: string, firstRegistered: string | null): GosiScheme {
  if (nationality !== "SA") return "non_saudi";
  return firstRegistered && firstRegistered >= NEW_SYSTEM_FROM ? "new" : "old";
}

/** The fixed monthly wage (Article 84's "last wage"): basic and the fixed allowances paid in cash. */
export const fixedWage = (p: Pay): Halalas => h(p.basic) + (p.housingInKind ? 0 : h(p.housing)) + h(p.transport) + h(p.other);

/** GOSI contribution base: basic + cash housing (or two months' basic a year when in kind), capped. */
export function gosiBase(p: Pay, ceiling: number): Halalas {
  const housing = p.housingInKind ? Math.round(h(p.basic) * 2 / 12) : h(p.housing);
  return Math.min(h(ceiling), h(p.basic) + housing);
}

const pct = (base: Halalas, rate: number) => Math.round(base * rate / 100);
export function gosiContribution(base: Halalas, r: GosiRate) {
  const employee = { pension: pct(base, r.employeePension), saned: pct(base, r.employeeSaned) };
  const employer = { pension: pct(base, r.employerPension), saned: pct(base, r.employerSaned), hazard: pct(base, r.employerHazard) };
  return { base, employee: employee.pension + employee.saned, employer: employer.pension + employer.saned + employer.hazard, detail: { employee, employer } };
}

/** Daily wage on a 30-day month (the Labour Law's convention for deductions and leave encashment). */
export const dailyWage = (p: Pay): Halalas => Math.round(fixedWage(p) / 30);

/**
 * Overtime (Article 107): each extra hour is paid the hourly wage plus 50% of the hourly basic, on an 8-hour day
 * and a 30-day month.
 */
export function overtimePay(p: Pay, hours: number): Halalas {
  const hourly = fixedWage(p) / 30 / 8;
  const hourlyBasic = h(p.basic) / 30 / 8;
  return Math.round(hours * (hourly + 0.5 * hourlyBasic));
}

/**
 * Sick leave pay (Article 117), in a year counted from the first sick day: the first 30 days full pay, the next 60
 * at three quarters, the next 30 unpaid. `before` is the sick days already taken in that year; returns the share of
 * the daily wage not paid for the `days` now.
 */
export function sickLeaveUnpaidDays(before: number, days: number): number {
  let unpaid = 0;
  for (let d = before + 1; d <= before + days; d++) unpaid += d <= 30 ? 0 : d <= 90 ? 0.25 : 1;
  return unpaid;
}

const DAY = 86_400_000;
const dayNo = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY);
export const addDaysIso = (iso: string, n: number) => new Date((dayNo(iso) + n) * DAY).toISOString().slice(0, 10);
/** Service in years (days / 365), both ends included. */
export const serviceYears = (from: string, to: string) => Math.max(0, dayNo(to) - dayNo(from) + 1) / 365;

/**
 * Annual leave accrued (Article 109): 21 days a year, 30 once five years of service are complete, pro rata by day.
 */
export function annualLeaveAccrued(hire: string, asOf: string): number {
  const years = serviceYears(hire, asOf);
  return Math.round((Math.min(years, 5) * 21 + Math.max(0, years - 5) * 30) * 100) / 100;
}

export type Separation = "resignation" | "termination" | "contract_end" | "article_87" | "article_80";

/**
 * End-of-service award. Article 84: half a month's wage for each of the first five years, a full month for each
 * year after, fractions of a year pro rata. Article 85 (resignation): nothing under two years, a third from two to
 * five, two thirds from five to ten, all of it from ten. Article 87: the full award despite resigning (force
 * majeure; a woman within six months of marriage or three of giving birth). Article 80 (dismissal for cause): none.
 */
export function endOfService(wage: Halalas, hire: string, lastDay: string, reason: Separation) {
  const years = serviceYears(hire, lastDay);
  const full = Math.round(wage * (Math.min(years, 5) * 0.5 + Math.max(0, years - 5)));
  const factor = reason === "article_80" ? 0 : reason !== "resignation" ? 1 : years < 2 ? 0 : years < 5 ? 1 / 3 : years < 10 ? 2 / 3 : 1;
  return { years: Math.round(years * 10000) / 10000, full, factor, award: Math.round(full * factor) };
}

/** A Saudi IBAN: SA + 2 check digits + 2-digit bank code + 18 account characters, valid mod-97. */
export function ibanInfo(raw: string): { iban: string; bankCode: string } | null {
  const iban = raw.replace(/\s+/g, "").toUpperCase();
  if (!/^SA\d{4}[0-9A-Z]{18}$/.test(iban)) return null;
  const moved = iban.slice(4) + iban.slice(0, 4);
  const digits = moved.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of digits) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1 ? { iban, bankCode: iban.slice(4, 6) } : null;
}

export interface MonthInput {
  pay: Pay;
  rate: GosiRate;
  /** Calendar days of the month the person was employed (joined or left mid-month), out of the month's days. */
  employedDays: number;
  monthDays: number;
  overtimeHours: number;
  absentDays: number;
  unpaidLeaveDays: number;
  /** Share of daily wage not paid for sick days this month (sickLeaveUnpaidDays). */
  sickUnpaidDays: number;
  bonus: Halalas;
  advanceRecovery: Halalas;
  penalty: Halalas;
  /** End-of-service award if they left at the month's end (termination basis), and what is provisioned so far. */
  eosEntitlement: Halalas;
  eosProvisioned: Halalas;
}

/**
 * One employee's month. Earnings are prorated for a partial month on a 30-day basis; absence, unpaid leave and
 * the unpaid share of sick leave reduce them. GOSI is on the prorated base; the employee's share is deducted.
 */
export function payMonth(m: MonthInput) {
  const full = m.employedDays >= m.monthDays;
  const days = full ? 30 : Math.min(30, m.employedDays);
  const prorate = (v: Halalas) => (full ? v : Math.round(v * days / 30));
  const basic = prorate(h(m.pay.basic));
  const housing = m.pay.housingInKind ? 0 : prorate(h(m.pay.housing));
  const transport = prorate(h(m.pay.transport));
  const other = prorate(h(m.pay.other));
  const overtime = overtimePay(m.pay, m.overtimeHours);
  const daily = dailyWage(m.pay);
  const absence = Math.round(daily * m.absentDays);
  const unpaidLeave = Math.round(daily * m.unpaidLeaveDays);
  const sick = Math.round(daily * m.sickUnpaidDays);
  const gross = Math.max(0, basic + housing + transport + other + overtime + m.bonus - absence - unpaidLeave - sick);
  const gosi = gosiContribution(prorate(gosiBase(m.pay, m.rate.wageCeiling)), m.rate);
  const deductions = gosi.employee + m.advanceRecovery + m.penalty;
  return {
    days, basic, housing, transport, other, overtime, bonus: m.bonus, absence, unpaidLeave, sick, gross,
    gosiBase: gosi.base, gosiEmployee: gosi.employee, gosiEmployer: gosi.employer, gosiDetail: gosi.detail,
    advanceRecovery: m.advanceRecovery, penalty: m.penalty, deductions, net: gross - deductions,
    eosAccrual: m.eosEntitlement - m.eosProvisioned,
  };
}
export type PayLine = ReturnType<typeof payMonth>;
