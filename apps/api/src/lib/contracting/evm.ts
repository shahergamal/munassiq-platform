// Schedule, earned value and cash flow, pure. Amounts in halalas, dates as YYYY-MM-DD.
//   * An activity's planned progress on a date is linear between its baseline start and finish.
//   * Its weight is its budget; a schedule without budgets weights activities by duration, so the project's budget
//     (BAC) is spread over them in that proportion.
//   * PV = Σ weight × planned %, EV = Σ weight × actual %, AC = the project's cost to date (from the ledger).
//   * SPI = EV/PV, CPI = EV/AC, EAC = BAC/CPI (the current cost efficiency continues), ETC = EAC − AC, VAC = BAC − EAC,
//     TCPI = (BAC − EV)/(BAC − AC): the efficiency the rest of the work needs to finish on budget.

export interface Activity { start: string; finish: string; budget: number; pctComplete: number }

const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;

export function plannedPct(a: Pick<Activity, "start" | "finish">, date: string) {
  const s = day(a.start);
  const f = day(a.finish);
  const t = day(date);
  if (t < s) return 0;
  if (t >= f) return 1;
  return f > s ? (t - s + 1) / (f - s + 1) : 1;
}

/** Each activity's weight: its budget, or (no budgets at all) the BAC spread by duration. */
export function weights(acts: Activity[], bac: number) {
  if (acts.some((a) => a.budget > 0)) return acts.map((a) => a.budget);
  const dur = acts.map((a) => Math.max(1, day(a.finish) - day(a.start) + 1));
  const total = dur.reduce((s, x) => s + x, 0);
  return dur.map((d) => (total ? Math.round((bac * d) / total) : 0));
}

const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);

export function earnedValue(acts: Activity[], p: { bac: number; ac: number; date: string }) {
  const w = weights(acts, p.bac);
  const bac = acts.some((a) => a.budget > 0) ? w.reduce((s, x) => s + x, 0) : p.bac;
  const pv = Math.round(acts.reduce((s, a, i) => s + w[i]! * plannedPct(a, p.date), 0));
  const ev = Math.round(acts.reduce((s, a, i) => s + w[i]! * Math.min(1, Math.max(0, a.pctComplete / 100)), 0));
  const cpi = ratio(ev, p.ac);
  const eac = cpi && cpi > 0 ? Math.round(bac / cpi) : bac;
  return { bac, pv, ev, ac: p.ac, sv: ev - pv, cv: ev - p.ac, spi: ratio(ev, pv), cpi, eac, etc: eac - p.ac, vac: bac - eac,
    tcpi: bac - p.ac > 0 ? Math.round(((bac - ev) / (bac - p.ac)) * 1000) / 1000 : null };
}

/** The planned value at the end of each month from the first start to the last finish (the S-curve). */
export function plannedCurve(acts: Activity[], bac: number) {
  if (!acts.length) return [];
  const w = weights(acts, bac);
  const first = acts.map((a) => a.start).sort()[0]!;
  const last = acts.map((a) => a.finish).sort().at(-1)!;
  const out: { period: string; pv: number }[] = [];
  const d = new Date(`${first.slice(0, 7)}-01T00:00:00Z`);
  for (let i = 0; i < 240; i++) {
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    out.push({ period: end.slice(0, 7), pv: Math.round(acts.reduce((s, a, j) => s + w[j]! * plannedPct(a, end), 0)) });
    if (end >= last) break;
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

/**
 * The months ahead: the remaining work follows the planned curve. Money in = its share of the remaining contract value,
 * less retention and the advance still to recover, with VAT, paid a lag of months later; money out = its share of the
 * cost still to spend (EAC − AC), with VAT where the costs carry it, paid in the month.
 */
export function cashFlow(p: { curve: { period: string; pv: number }[]; from: string; months: number; remainingRevenue: number; remainingCost: number;
  retentionPct: number; advanceToRecover: number; vatPct: number; inputVatShare: number; paymentLagMonths: number }) {
  const future = p.curve.filter((c) => c.period >= p.from);
  const before = p.curve.filter((c) => c.period < p.from).at(-1)?.pv ?? 0;
  const span = (future.at(-1)?.pv ?? before) - before;
  const steps = future.map((c, i) => ({ period: c.period, share: span > 0 ? (c.pv - (i ? future[i - 1]!.pv : before)) / span : 0 }));
  if (!steps.length && (p.remainingRevenue > 0 || p.remainingCost > 0)) steps.push({ period: p.from, share: 1 });
  const months: string[] = [];
  const d = new Date(`${p.from}-01T00:00:00Z`);
  for (let i = 0; i < p.months; i++) { months.push(d.toISOString().slice(0, 7)); d.setUTCMonth(d.getUTCMonth() + 1); }
  const shift = (period: string, n: number) => { const x = new Date(`${period}-01T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 7); };
  const inflow = new Map<string, number>();
  const outflow = new Map<string, number>();
  for (const s of steps) {
    const work = p.remainingRevenue * s.share;
    const net = work * (1 + p.vatPct / 100) - work * p.retentionPct / 100 - p.advanceToRecover * s.share * (1 + p.vatPct / 100);
    const at = shift(s.period, p.paymentLagMonths);
    inflow.set(at, (inflow.get(at) ?? 0) + net);
    outflow.set(s.period, (outflow.get(s.period) ?? 0) + p.remainingCost * s.share * (1 + p.vatPct * p.inputVatShare / 100));
  }
  let cumulative = 0;
  return months.map((m) => {
    const i = Math.round(inflow.get(m) ?? 0);
    const o = Math.round(outflow.get(m) ?? 0);
    cumulative += i - o;
    return { period: m, inflow: i, outflow: o, net: i - o, cumulative };
  });
}
