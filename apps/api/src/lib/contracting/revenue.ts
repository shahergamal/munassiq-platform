// Revenue on a construction contract over time (IFRS 15; SME standard section 23), pure. Amounts in halalas.
//   * The transaction price = the contract value + approved variations + agreed claims (variable consideration only
//     once agreed: the constraint) − delay damages charged.
//   * Progress, by the workspace's policy: input (cost incurred / estimated total cost) or output (work certified
//     by the approved IPCs / the value of the work: contract + approved variations). Capped at 100%. It is then
//     applied to the transaction price (so damages and agreed claims move revenue as the work progresses).
//   * Revenue to date = price × progress. Against what was billed to date, the difference is a contract asset (work
//     done, not billed) or a contract liability (billed ahead of the work).
//   * An onerous contract (estimated cost above the price) recognises the whole expected loss at once: the part not
//     yet in the results (through revenue below cost) is a provision, remeasured each close.

export type RevenueMethod = "input" | "output";
export interface CloseInput {
  method: RevenueMethod;
  transactionPrice: number;
  /** Contract value + approved variations: what the certified work is measured against (output method). */
  workValue: number;
  /** Null when no estimate was entered: the onerous test cannot be made (the WIP says so). */
  estimatedCost: number | null;
  costToDate: number;
  certifiedToDate: number;
  billedToDate: number;
}

export function computeClose(p: CloseInput) {
  if (p.method === "input" && !(p.estimatedCost && p.estimatedCost > 0)) throw new Error("estimate_required");
  const raw = p.method === "input" ? p.costToDate / p.estimatedCost! : p.workValue > 0 ? p.certifiedToDate / p.workValue : 0;
  const pct = Math.max(0, Math.min(1, raw));
  const revenueToDate = Math.round(p.transactionPrice * pct);
  // Positive: contract asset. Negative: contract liability.
  const position = revenueToDate - p.billedToDate;
  const expectedLoss = p.estimatedCost === null ? 0 : Math.max(0, p.estimatedCost - p.transactionPrice);
  // What the results already carry of that loss: cost to date beyond revenue to date.
  const recognisedLoss = Math.max(0, p.costToDate - revenueToDate);
  const provision = expectedLoss > 0 ? Math.max(0, expectedLoss - recognisedLoss) : 0;
  return { pct: Math.round(pct * 1_000_000) / 1_000_000, revenueToDate, position, expectedLoss, provision,
    grossProfit: p.estimatedCost === null ? null : p.transactionPrice - p.estimatedCost };
}

/** The entry of a close: undo the previous position and provision, book the new ones (halalas, debit/credit per key). */
export function closeLines(prev: { position: number; provision: number }, next: { position: number; provision: number }) {
  const lines: { key: "contract_asset" | "contract_liability" | "contract_revenue" | "onerous_provision" | "onerous_loss"; debit?: number; credit?: number }[] = [];
  const book = (position: number, sign: 1 | -1) => {
    // sign 1 books the position, -1 reverses it.
    const v = position * sign;
    if (position > 0) lines.push(v > 0 ? { key: "contract_asset", debit: v } : { key: "contract_asset", credit: -v });
    if (position < 0) lines.push(v < 0 ? { key: "contract_liability", credit: -v } : { key: "contract_liability", debit: v });
    if (position !== 0) lines.push(v > 0 ? { key: "contract_revenue", credit: v } : { key: "contract_revenue", debit: -v });
  };
  book(prev.position, -1);
  book(next.position, 1);
  const dp = next.provision - prev.provision;
  if (dp > 0) lines.push({ key: "onerous_loss", debit: dp }, { key: "onerous_provision", credit: dp });
  if (dp < 0) lines.push({ key: "onerous_provision", debit: -dp }, { key: "onerous_loss", credit: -dp });
  return lines;
}
