import { computeIpc, type Halalas, type IpcHistory, type IpcLineInput, type IpcTerms } from "./ipc.ts";

// A subcontractor's payment certificate, seen from the main contractor (the buyer), pure. The measurement, retention,
// advance recovery and delay damages follow the same rules as the client IPC (computeIpc). On top of them:
//   * how VAT applies depends on the subcontractor: a VAT-registered resident charges it on its invoice (our input
//     VAT); an unregistered resident charges none; a non-resident charges none and we self-assess it (reverse charge:
//     input and output VAT of the same amount) on the net value of the supply;
//   * deductions (back-charges: materials or equipment we supplied, damages) are set off against what we owe; they
//     carry no VAT here (a taxable supply to the subcontractor is invoiced separately through the sales invoices);
//   * withholding tax on a non-resident is taken when it is PAID (supplier payments, by payment type), not here.
// Retention held from the subcontractor is a liability (retention payable) until released.

export type SubVat = "charged" | "none" | "reverse";
export interface SubTerms extends IpcTerms { vatMode: SubVat }
export interface Deduction { amount: Halalas }

export const subVatMode = (residency: string, vatNumber: string | null): SubVat =>
  residency === "non_resident" ? "reverse" : vatNumber ? "charged" : "none";

export function computeSubIpc(lines: IpcLineInput[], t: SubTerms, hist: IpcHistory, opts: { final: boolean; ldDays: number; deductions: Deduction[] }) {
  const base = computeIpc(lines, { ...t, vatRatePct: t.vatMode === "charged" ? t.vatRatePct : 0 }, hist, { final: opts.final, ldDays: opts.ldDays });
  const deductions = opts.deductions.reduce((a, d) => a + d.amount, 0);
  // The net supply of the period: the work less the advance recovered (self-assessed when it was paid) and damages.
  const netSupply = base.current - base.advanceRecovery - base.ld;
  const reverseChargeVat = t.vatMode === "reverse" ? Math.round(netSupply * t.vatRatePct / 100) : 0;
  return { ...base, deductions, netSupply, reverseChargeVat, net: base.net - deductions };
}
