// Variation-order caps, pure. Under GTPL 1448 Art. 67 (the percentages come from regulatory_parameters):
//   * new items: up to their cap, always with the contractor's consent;
//   * increase of existing items: beyond the no-consent limit only with consent;
//   * total increase (new + existing) never beyond its cap;
//   * decrease: beyond its cap only with consent.
// Amounts are cumulative over the contract's approved variations plus the one being approved, in halalas.

export interface VoAmounts { newItems: number; increase: number; decrease: number }
export interface VoCaps { newItemsPct: number; increaseConsentPct: number; totalIncreasePct: number; decreasePct: number }

export function checkVariationCaps(p: { contractValue: number; approved: VoAmounts; proposed: VoAmounts; caps: VoCaps | null; consent: boolean }) {
  const sum = { newItems: p.approved.newItems + p.proposed.newItems, increase: p.approved.increase + p.proposed.increase, decrease: p.approved.decrease + p.proposed.decrease };
  if (!p.caps) return { ok: true, violations: [] as string[], totals: sum, remaining: null };
  const of = (pct: number) => Math.round(p.contractValue * pct / 100);
  const c = p.caps;
  const violations: string[] = [];
  if (p.proposed.newItems > 0 && !p.consent) violations.push("البنود الجديدة تحتاج موافقة المتعاقد");
  if (sum.newItems > of(c.newItemsPct)) violations.push(`البنود الجديدة تتجاوز ${c.newItemsPct}% من قيمة العقد`);
  if (sum.increase > of(c.increaseConsentPct) && p.proposed.increase > 0 && !p.consent) violations.push(`زيادة البنود فوق ${c.increaseConsentPct}% تحتاج موافقة المتعاقد`);
  if (sum.newItems + sum.increase > of(c.totalIncreasePct)) violations.push(`الزيادة الكلية تتجاوز ${c.totalIncreasePct}% من قيمة العقد`);
  if (sum.decrease > of(c.decreasePct) && p.proposed.decrease > 0 && !p.consent) violations.push(`التخفيض فوق ${c.decreasePct}% يحتاج موافقة المتعاقد`);
  return {
    ok: violations.length === 0, violations, totals: sum,
    remaining: {
      newItems: of(c.newItemsPct) - sum.newItems,
      totalIncrease: of(c.totalIncreasePct) - sum.newItems - sum.increase,
      decreaseWithoutConsent: of(c.decreasePct) - sum.decrease,
    },
  };
}
