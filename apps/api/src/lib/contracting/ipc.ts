// Interim payment certificate arithmetic, pure (no database). Amounts in halalas; each rounded where it arises.
// The rules (ZATCA contracting guideline, May 2026, and the usual contract terms):
//   * cumulative-to-date measurement: this period = to date − previous approved IPC;
//   * retention = its percentage of this period's work, until the cap (a share of the contract value) is reached;
//     it does NOT reduce the VAT base: VAT is on the full work value;
//   * the advance is recovered in each IPC in the same proportion it bears to the contract value, never beyond
//     what remains nor beyond the period's work (the invoice carries it); a final IPC recovers everything left
//     that its work can carry — an advance never earned is refunded by a credit note on the advance invoice;
//   * delay damages = days × daily rate, capped (cumulative) at a share of the contract value; they are billed as a
//     credit note with VAT (a price reduction), so they reduce what is payable including their VAT.

export type Halalas = number;
export const h = (riyals: number): Halalas => Math.round(riyals * 100);

export interface IpcLineInput { kind: "boq" | "vo" | "mos"; rate: number; qtyToDate: number; previousQty: number; amountToDate?: number; previousAmount?: number }
export interface IpcTerms {
  contractValue: Halalas;
  retentionPct: number;
  /** Cap on total retention as a percentage of the contract value; 0 = no cap. */
  retentionCapPct: number;
  /** The advance invoiced (excl. VAT) and what earlier IPCs recovered. */
  advanceTaxable: Halalas;
  advanceRecovered: Halalas;
  ldRatePerDay: Halalas;
  /** Cap on total delay damages as a percentage of the contract value; null = not known (then no damages may be charged). */
  ldCapPct: number | null;
  vatRatePct: number;
}
export interface IpcHistory { previousGross: Halalas; retainedToDate: Halalas; ldToDate: Halalas }

export const lineToDate = (l: IpcLineInput): Halalas => (l.kind === "mos" ? h(l.amountToDate ?? 0) : Math.round(l.qtyToDate * l.rate * 100));
export const linePrevious = (l: IpcLineInput): Halalas => (l.kind === "mos" ? h(l.previousAmount ?? 0) : Math.round(l.previousQty * l.rate * 100));

export function computeIpc(lines: IpcLineInput[], t: IpcTerms, hist: IpcHistory, opts: { final: boolean; ldDays: number }) {
  const grossToDate = lines.reduce((a, l) => a + lineToDate(l), 0);
  const current = grossToDate - hist.previousGross;

  const cap = t.retentionCapPct > 0 ? Math.round(t.contractValue * t.retentionCapPct / 100) : Number.POSITIVE_INFINITY;
  let retention = Math.round(current * t.retentionPct / 100);
  retention = current >= 0 ? Math.max(0, Math.min(retention, cap - hist.retainedToDate)) : Math.max(retention, -hist.retainedToDate);

  const remainingAdvance = Math.max(0, t.advanceTaxable - t.advanceRecovered);
  const share = t.contractValue > 0 ? t.advanceTaxable / t.contractValue : 0;
  const due = opts.final ? remainingAdvance : Math.min(remainingAdvance, Math.round(current * share));
  const advanceRecovery = Math.max(0, Math.min(due, current));

  if (opts.ldDays > 0 && t.ldCapPct === null) throw new Error("ld_cap_unknown");
  const ldCap = t.ldCapPct === null ? 0 : Math.round(t.contractValue * t.ldCapPct / 100);
  const ld = Math.max(0, Math.min(opts.ldDays * t.ldRatePerDay, ldCap - hist.ldToDate));

  const vatOf = (v: Halalas) => Math.round(v * t.vatRatePct / 100);
  const vat = vatOf(current);
  const net = current + vat - retention - (advanceRecovery + vatOf(advanceRecovery)) - (ld + vatOf(ld));
  return {
    grossToDate, previousGross: hist.previousGross, current, retention, advanceRecovery, advanceRecoveryVat: vatOf(advanceRecovery),
    ld, ldVat: vatOf(ld), ldCapped: opts.ldDays * t.ldRatePerDay > ld, vat, net,
  };
}
