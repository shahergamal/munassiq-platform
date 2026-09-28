// Bill of materials arithmetic, pure (no database): the cost roll-up that sets an order's standard cost, and the
// explosion that turns a BOM into what an order must issue. Quantities are in each item's base unit.

import { AppError } from "../errors.ts";

export interface BomLine { componentId: string; quantity: number; scrapPercent: number; phantom: boolean }
export interface BomOperation { seq: number; name: string; workCenterId: string; setupMinutes: number; runMinutes: number; laborRate: number; overheadRate: number }
export interface BomByproduct { itemId: string; quantity: number; costShare: number }
export interface Bom { id: string; itemId: string; quantity: number; lines: BomLine[]; operations: BomOperation[]; byproducts: BomByproduct[] }

export interface CostContext {
  /** The active BOM of an item (used for sub-assemblies and phantoms). */
  bomOf: (itemId: string) => Bom | undefined;
  /** Current weighted-average cost of one base unit (items without a BOM). */
  avgCost: (itemId: string) => number;
}

const r6 = (n: number) => Math.round((n + Number.EPSILON) * 1e6) / 1e6;
const r4 = (n: number) => Math.round((n + Number.EPSILON) * 1e4) / 1e4;
const gross = (l: BomLine) => l.quantity * (1 + l.scrapPercent / 100);

export interface RollUpLine { componentId: string; quantity: number; grossQuantity: number; unitCost: number; cost: number; source: "average" | "bom" }
export interface RollUpOperation { seq: number; name: string; workCenterId: string; minutes: number; labor: number; overhead: number }
export interface RollUp {
  bomId: string; quantity: number;
  material: number; labor: number; overhead: number; total: number;
  /** What the by-products carry; the main product carries the rest. */
  byproducts: { itemId: string; quantity: number; costShare: number; value: number; unitCost: number }[];
  mainCost: number;
  /** Standard cost of one base unit of the main product. */
  unitCost: number;
  lines: RollUpLine[];
  operations: RollUpOperation[];
}

/**
 * Standard cost of one batch of `bom`: components at their own roll-up (when they have an active BOM) or their
 * average cost, grossed up by expected scrap; operations at their work center's labour and overhead rates. A cycle
 * (A needs B needs A) is refused.
 */
export function rollUp(bom: Bom, ctx: CostContext, path: string[] = []): RollUp {
  if (path.includes(bom.itemId)) throw new AppError(422, "bom_cycle", "قائمة المواد تحتوي على دورة: صنف يدخل في تركيب نفسه");
  const trail = [...path, bom.itemId];
  const lines: RollUpLine[] = bom.lines.map((l) => {
    const sub = ctx.bomOf(l.componentId);
    const unitCost = sub ? rollUp(sub, ctx, trail).unitCost : ctx.avgCost(l.componentId);
    const g = r4(gross(l));
    return { componentId: l.componentId, quantity: l.quantity, grossQuantity: g, unitCost: r6(unitCost), cost: r6(g * unitCost), source: sub ? "bom" : "average" };
  });
  const operations: RollUpOperation[] = bom.operations.map((o) => {
    const minutes = o.setupMinutes + o.runMinutes;
    return { seq: o.seq, name: o.name, workCenterId: o.workCenterId, minutes, labor: r6((minutes / 60) * o.laborRate), overhead: r6((minutes / 60) * o.overheadRate) };
  });
  const material = r6(lines.reduce((a, l) => a + l.cost, 0));
  const labor = r6(operations.reduce((a, o) => a + o.labor, 0));
  const overhead = r6(operations.reduce((a, o) => a + o.overhead, 0));
  const total = r6(material + labor + overhead);
  const shares = bom.byproducts.reduce((a, b) => a + b.costShare, 0);
  if (shares >= 100) throw new AppError(422, "validation_failed", "نصيب المنتجات الثانوية من التكلفة يجب أن يقل عن 100٪");
  const byproducts = bom.byproducts.map((b) => {
    const value = r6((total * b.costShare) / 100);
    return { itemId: b.itemId, quantity: b.quantity, costShare: b.costShare, value, unitCost: r6(value / b.quantity) };
  });
  const mainCost = r6(total - byproducts.reduce((a, b) => a + b.value, 0));
  return { bomId: bom.id, quantity: bom.quantity, material, labor, overhead, total, byproducts, mainCost, unitCost: r6(mainCost / bom.quantity), lines, operations };
}

export interface Requirement { componentId: string; quantity: number }
export interface Explosion { components: Requirement[]; operations: (Omit<BomOperation, "setupMinutes" | "runMinutes"> & { minutes: number })[] }

/**
 * What an order for `quantity` of the BOM's item must issue and do. Stocked components are issued as they are
 * (with their expected scrap); a phantom sub-assembly is replaced by its own components and operations, scaled.
 * Setup time is once per order; run time scales with the quantity.
 */
export function explode(bom: Bom, quantity: number, ctx: Pick<CostContext, "bomOf">, path: string[] = []): Explosion {
  if (path.includes(bom.itemId)) throw new AppError(422, "bom_cycle", "قائمة المواد تحتوي على دورة: صنف يدخل في تركيب نفسه");
  const trail = [...path, bom.itemId];
  const factor = quantity / bom.quantity;
  const need = new Map<string, number>();
  const ops: Explosion["operations"] = [];
  for (const o of bom.operations) ops.push({ seq: o.seq, name: o.name, workCenterId: o.workCenterId, laborRate: o.laborRate, overheadRate: o.overheadRate, minutes: r4(o.setupMinutes + o.runMinutes * factor) });
  for (const l of bom.lines) {
    const q = gross(l) * factor;
    const sub = l.phantom ? ctx.bomOf(l.componentId) : undefined;
    if (l.phantom && !sub) throw new AppError(422, "phantom_without_bom", "مكوّن وهمي (Phantom) بلا قائمة مواد معتمدة: اعتمد قائمته أولاً أو ألغِ علامة الوهمي");
    if (sub) {
      const inner = explode(sub, q, ctx, trail);
      for (const c of inner.components) need.set(c.componentId, (need.get(c.componentId) ?? 0) + c.quantity);
      for (const o of inner.operations) ops.push({ ...o, seq: ops.length + 1 });
    } else {
      need.set(l.componentId, (need.get(l.componentId) ?? 0) + q);
    }
  }
  return {
    components: [...need].map(([componentId, q]) => ({ componentId, quantity: r4(q) })).filter((c) => c.quantity > 0),
    operations: ops.map((o, i) => ({ ...o, seq: i + 1 })),
  };
}

/**
 * Where an order's cost went (all in riyals): what the output absorbed at standard against what really went in.
 * Price: materials bought dearer or cheaper than standard. Usage: more or fewer materials than the output needed.
 * Efficiency: more or fewer minutes than planned for the output. The remainder is what closing posts.
 */
export function variances(p: {
  producedRatio: number; // produced ÷ planned
  components: { requiredQty: number; standardCost: number; issuedQty: number; issuedValue: number }[];
  operations: { plannedMinutes: number; actualMinutes: number; laborRate: number; overheadRate: number }[];
}) {
  let price = 0, usage = 0, efficiency = 0;
  for (const c of p.components) {
    price += c.issuedValue - c.issuedQty * c.standardCost;
    usage += (c.issuedQty - c.requiredQty * p.producedRatio) * c.standardCost;
  }
  for (const o of p.operations) efficiency += ((o.actualMinutes - o.plannedMinutes * p.producedRatio) / 60) * (o.laborRate + o.overheadRate);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return { price: r2(price), usage: r2(usage), efficiency: r2(efficiency) };
}
