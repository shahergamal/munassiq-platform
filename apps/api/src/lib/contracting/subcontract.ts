// The subcontracted share of a main contract, pure. The ceilings come from the main contract's form (data): e.g. the
// Etimad general construction form allows up to 30% with the entity's approval and from 30% to under 50% with a
// further approval (spending efficiency center). A form without ceilings leaves it to the contract.
// Amounts in halalas; percentages of the main contract's value.

export interface ShareCheck { mainValue: number; otherSubs: number; thisValue: number; approvalPct: number | null; maxPct: number | null; approvalRef: string | null }

export function checkSubcontractShare(p: ShareCheck) {
  const total = p.otherSubs + p.thisValue;
  const share = p.mainValue > 0 ? (total / p.mainValue) * 100 : 100;
  const round = (v: number) => Math.round(v * 100) / 100;
  // "Below 50%": the maximum itself is not allowed.
  if (p.maxPct !== null && share >= p.maxPct) {
    return { ok: false, share: round(share), needsApproval: true, reason: `المسند لمقاولي الباطن ${round(share)}% ويجب أن يبقى أقل من ${p.maxPct}% من قيمة العقد الرئيسي` };
  }
  const needsApproval = p.approvalPct !== null && share > 0;
  if (needsApproval && share > p.approvalPct! && !p.approvalRef) {
    return { ok: false, share: round(share), needsApproval, reason: `المسند ${round(share)}% يتجاوز ${p.approvalPct}%: يحتاج موافقة موثقة (رقم خطاب الموافقة)` };
  }
  return { ok: true, share: round(share), needsApproval, reason: null };
}
