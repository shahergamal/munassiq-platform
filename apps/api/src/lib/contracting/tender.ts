// Tender pricing (rate build-up), pure. Amounts in halalas, quantities as numbers.
//   * Each priced item is built from resources per unit of the item: materials, labour, equipment, subcontract;
//     each resource = quantity per unit × unit cost × (1 + waste%).
//   * The item's direct unit cost is their sum; its selling rate adds the tender's overheads, risk and profit, each
//     a percentage applied in turn (overhead on direct, risk on cost with overhead, profit on the cost with risk).
//   * An item priced directly (a lump sum or a subcontract quote) has a rate and no resources: its markups apply too.
// The cost without profit is the estimated cost handed to the contract when the tender is won.

export type ResourceKind = "material" | "labor" | "equipment" | "subcontract";
export interface Resource { kind: ResourceKind; quantity: number; unitCost: number; wastePct: number }
export interface TenderItem { quantity: number; resources: Resource[]; directRate?: number | null }
export interface Markups { overheadPct: number; riskPct: number; profitPct: number }

export const resourceCost = (r: Resource) => Math.round(r.quantity * r.unitCost * (1 + r.wastePct / 100));

export function priceItem(item: TenderItem, m: Markups) {
  const byKind: Record<ResourceKind, number> = { material: 0, labor: 0, equipment: 0, subcontract: 0 };
  for (const r of item.resources) byKind[r.kind] += resourceCost(r);
  const direct = item.resources.length ? Object.values(byKind).reduce((a, v) => a + v, 0) : Math.round(item.directRate ?? 0);
  const withOverhead = Math.round(direct * (1 + m.overheadPct / 100));
  const cost = Math.round(withOverhead * (1 + m.riskPct / 100));
  const rate = Math.round(cost * (1 + m.profitPct / 100));
  return { byKind, direct, costRate: cost, rate, amount: Math.round(rate * item.quantity), costAmount: Math.round(cost * item.quantity), directAmount: Math.round(direct * item.quantity) };
}

export function priceTender(items: TenderItem[], m: Markups) {
  const priced = items.map((i) => priceItem(i, m));
  const sum = (k: "amount" | "costAmount" | "directAmount") => priced.reduce((a, p) => a + p[k], 0);
  const total = sum("amount");
  const cost = sum("costAmount");
  const kinds = (["material", "labor", "equipment", "subcontract"] as const).map((k) => [k, items.reduce((a, it, i) => a + Math.round(priced[i]!.byKind[k] * it.quantity), 0)]);
  return { items: priced, total, cost, direct: sum("directAmount"), margin: total - cost, marginPct: total ? Math.round(((total - cost) / total) * 10_000) / 100 : 0,
    byKind: Object.fromEntries(kinds) as Record<ResourceKind, number> };
}
