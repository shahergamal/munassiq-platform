import test from "node:test";
import assert from "node:assert/strict";
import { explode, rollUp, variances, type Bom } from "../src/lib/manufacturing/bom.ts";

// Three levels: biscuits (F) ← dough (S, its own BOM) + carton (P); dough ← flour (A) + sugar (B).
const wc = { workCenterId: "oven", laborRate: 60, overheadRate: 30 };
const dough: Bom = {
  id: "bS", itemId: "S", quantity: 100, byproducts: [],
  lines: [{ componentId: "A", quantity: 80, scrapPercent: 0, phantom: false }, { componentId: "B", quantity: 20, scrapPercent: 5, phantom: false }],
  operations: [{ seq: 1, name: "عجن", ...wc, setupMinutes: 0, runMinutes: 60 }],
};
const biscuits: Bom = {
  id: "bF", itemId: "F", quantity: 50, byproducts: [],
  lines: [{ componentId: "S", quantity: 10, scrapPercent: 10, phantom: false }, { componentId: "P", quantity: 2, scrapPercent: 0, phantom: false }],
  operations: [{ seq: 1, name: "خبز", ...wc, setupMinutes: 30, runMinutes: 90 }],
};
const avg: Record<string, number> = { A: 2, B: 5, P: 1.5, S: 999 };
const boms = new Map([["S", dough], ["F", biscuits]]);
const ctx = { bomOf: (i: string) => boms.get(i), avgCost: (i: string) => avg[i] ?? 0 };

test("roll-up: sub-assembly at its own standard, scrap grossed up, operations at their rates", () => {
  // Dough batch 100: A 80×2 = 160, B 21×5 = 105, oven 60 min × 90/h = 90 → 355 → 3.55 per unit (its average, 999, is ignored).
  const s = rollUp(dough, ctx);
  assert.deepEqual([s.material, s.labor, s.overhead, s.total, s.unitCost], [265, 60, 30, 355, 3.55]);
  // Biscuits batch 50: dough 11×3.55 = 39.05, cartons 2×1.5 = 3, oven 120 min → 180 → 222.05 → 4.441 per unit.
  const f = rollUp(biscuits, ctx);
  assert.equal(f.lines[0]!.source, "bom");
  assert.equal(f.lines[0]!.grossQuantity, 11);
  assert.deepEqual([f.material, f.labor + f.overhead, f.total], [42.05, 180, 222.05]);
  assert.equal(f.unitCost, 4.441);
});

test("roll-up: a by-product carries its cost share, the main product the rest", () => {
  const withBran: Bom = { ...dough, id: "bS2", byproducts: [{ itemId: "bran", quantity: 10, costShare: 20 }] };
  const r = rollUp(withBran, ctx);
  assert.equal(r.byproducts[0]!.value, 71);
  assert.equal(r.byproducts[0]!.unitCost, 7.1);
  assert.equal(r.mainCost, 284);
  assert.equal(r.unitCost, 2.84);
  assert.equal(r.mainCost + r.byproducts[0]!.value, r.total, "nothing lost between the products");
});

test("explosion: scaled requirements, phantom replaced by its components, setup once", () => {
  const e = explode(biscuits, 100, ctx);
  assert.deepEqual(e.components, [{ componentId: "S", quantity: 22 }, { componentId: "P", quantity: 4 }]);
  assert.equal(e.operations[0]!.minutes, 30 + 180, "setup once, run × 2");
  const phantom: Bom = { ...biscuits, id: "bF2", lines: [{ ...biscuits.lines[0]!, phantom: true }, biscuits.lines[1]!] };
  const p = explode(phantom, 100, ctx);
  // 22 of dough exploded: A 80×0.22 = 17.6, B 21×0.22 = 4.62; the dough's kneading joins the order's operations.
  assert.deepEqual(p.components.sort((a, b) => a.componentId.localeCompare(b.componentId)), [{ componentId: "A", quantity: 17.6 }, { componentId: "B", quantity: 4.62 }, { componentId: "P", quantity: 4 }]);
  assert.deepEqual(p.operations.map((o) => [o.seq, o.name, o.minutes]), [[1, "خبز", 210], [2, "عجن", 13.2]]);
});

test("a cycle is refused", () => {
  const loop = new Map<string, Bom>([["S", { ...dough, lines: [{ componentId: "F", quantity: 1, scrapPercent: 0, phantom: false }] }], ["F", biscuits]]);
  assert.throws(() => rollUp(biscuits, { ...ctx, bomOf: (i) => loop.get(i) }), /دورة/);
});

test("variances split what closing posts into price, usage and efficiency", () => {
  const v = variances({
    producedRatio: 0.5,
    components: [{ requiredQty: 100, standardCost: 2, issuedQty: 60, issuedValue: 132 }],
    operations: [{ plannedMinutes: 120, actualMinutes: 90, laborRate: 60, overheadRate: 30 }],
  });
  // Price: 132 − 60×2 = 12 dearer. Usage: (60 − 50)×2 = 20 over. Efficiency: (90 − 60) min × 90/h = 45 over.
  assert.deepEqual(v, { price: 12, usage: 20, efficiency: 45 });
});
