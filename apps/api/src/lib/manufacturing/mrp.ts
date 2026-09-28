// Material requirements planning, pure (no database). Time-phased, lot-for-lot with a min/max safety stock:
// every item is walked through its dated demands and receipts from today's stock; when the projected balance would
// fall below the minimum, an order is planned for that date, sized back up to the target level. Manufactured items
// (an active BOM) are processed before their components (low-level codes), so a planned production order becomes
// dated demand for what it consumes, level by level.

import { explode, type Bom } from "./bom.ts";

export interface MrpItem {
  id: string;
  name: string;
  leadTimeDays: number;
  onHand: number;
  minStock: number;
  /** Target level when replenishing (0: back to the minimum only). */
  parStock: number;
}
export interface Flow {
  itemId: string;
  date: string; // YYYY-MM-DD
  quantity: number;
  source: { type: "sales_order" | "mo_component" | "planned_order" | "mo_output" | "purchase_order"; ref?: string; label?: string };
}
export interface Suggestion {
  itemId: string;
  kind: "make" | "buy";
  level: number;
  quantity: number;
  needDate: string;
  orderDate: string;
  late: boolean;
  explanation: {
    onHand: number; minStock: number; target: number;
    demand: { date: string; quantity: number; source: Flow["source"] }[];
    receipts: { date: string; quantity: number; source: Flow["source"] }[];
    projectedBefore: number;
  };
}

const r4 = (n: number) => Math.round((n + Number.EPSILON) * 1e4) / 1e4;
export const shiftDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** Level 0 for what nothing consumes; a component is one level below the deepest thing that uses it. */
export function lowLevelCodes(itemIds: Iterable<string>, bomOf: (id: string) => Bom | undefined): Map<string, number> {
  const level = new Map<string, number>();
  const visit = (id: string, depth: number, path: Set<string>) => {
    if (path.has(id)) return; // cycles are refused when a BOM is activated; never loop here
    if ((level.get(id) ?? -1) >= depth) return;
    level.set(id, depth);
    const bom = bomOf(id);
    if (!bom) return;
    const next = new Set(path).add(id);
    for (const c of explode(bom, bom.quantity, { bomOf }).components) visit(c.componentId, depth + 1, next);
  };
  for (const id of itemIds) visit(id, 0, new Set());
  return level;
}

export function runMrp(p: {
  today: string;
  items: Map<string, MrpItem>;
  bomOf: (id: string) => Bom | undefined;
  demands: Flow[];
  receipts: Flow[];
  /** Replenish items below their minimum stock even without demand. */
  safetyStock?: boolean;
}): Suggestion[] {
  const out: Suggestion[] = [];
  const demands = [...p.demands];
  const codes = lowLevelCodes([...p.items.keys(), ...demands.map((d) => d.itemId)], p.bomOf);
  const maxLevel = Math.max(0, ...codes.values());
  for (let level = 0; level <= maxLevel; level++) {
    for (const [itemId, lvl] of codes) {
      if (lvl !== level) continue;
      const item = p.items.get(itemId);
      if (!item) continue;
      const bom = p.bomOf(itemId);
      const safety = p.safetyStock === false ? 0 : item.minStock;
      const target = Math.max(safety, p.safetyStock === false ? 0 : item.parStock);
      const own = demands.filter((d) => d.itemId === itemId).map((d) => ({ ...d, date: d.date < p.today ? p.today : d.date }));
      const recs = p.receipts.filter((r) => r.itemId === itemId).map((r) => ({ ...r, date: r.date < p.today ? p.today : r.date }));
      // Events in date order; on one date, receipts count before demand.
      const dates = [...new Set([p.today, ...own.map((d) => d.date), ...recs.map((r) => r.date)])].sort();
      let balance = item.onHand;
      for (const date of dates) {
        const inToday = recs.filter((r) => r.date === date);
        const outToday = own.filter((d) => d.date === date);
        balance = r4(balance + inToday.reduce((a, r) => a + r.quantity, 0) - outToday.reduce((a, d) => a + d.quantity, 0));
        if (balance >= safety - 1e-9) continue;
        const quantity = r4(target - balance);
        if (quantity <= 0) continue;
        const orderDate = shiftDays(date, -item.leadTimeDays);
        const s: Suggestion = {
          itemId, kind: bom ? "make" : "buy", level, quantity, needDate: date, orderDate: orderDate < p.today ? p.today : orderDate, late: orderDate < p.today,
          explanation: {
            onHand: item.onHand, minStock: safety, target, projectedBefore: balance,
            demand: own.filter((d) => d.date <= date).map((d) => ({ date: d.date, quantity: d.quantity, source: d.source })),
            receipts: recs.filter((r) => r.date <= date).map((r) => ({ date: r.date, quantity: r.quantity, source: r.source })),
          },
        };
        out.push(s);
        balance = r4(balance + quantity);
        // Making it consumes its components on the day production starts.
        if (bom) {
          for (const c of explode(bom, quantity, { bomOf: p.bomOf }).components) {
            demands.push({ itemId: c.componentId, date: s.orderDate, quantity: c.quantity, source: { type: "planned_order", ref: itemId, label: item.name } });
          }
        }
      }
    }
  }
  return out;
}
