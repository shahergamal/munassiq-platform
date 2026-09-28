import test from "node:test";
import assert from "node:assert/strict";
import type { Bom } from "../src/lib/manufacturing/bom.ts";
import { lowLevelCodes, runMrp, type MrpItem } from "../src/lib/manufacturing/mrp.ts";

// Three levels: box (F) ← biscuit (S, made) + carton (P, bought); biscuit ← dough (D, made); dough ← flour (A, bought).
const op = { seq: 1, name: "x", workCenterId: "w", setupMinutes: 0, runMinutes: 0, laborRate: 0, overheadRate: 0 };
const boms: Record<string, Bom> = {
  F: { id: "bF", itemId: "F", quantity: 1, lines: [{ componentId: "S", quantity: 12, scrapPercent: 0, phantom: false }, { componentId: "P", quantity: 1, scrapPercent: 0, phantom: false }], operations: [op], byproducts: [] },
  S: { id: "bS", itemId: "S", quantity: 100, lines: [{ componentId: "D", quantity: 2, scrapPercent: 0, phantom: false }], operations: [op], byproducts: [] },
  D: { id: "bD", itemId: "D", quantity: 1, lines: [{ componentId: "A", quantity: 0.8, scrapPercent: 0, phantom: false }], operations: [op], byproducts: [] },
};
const bomOf = (id: string) => boms[id];
const item = (id: string, x: Partial<MrpItem> = {}): MrpItem => ({ id, name: id, leadTimeDays: 0, onHand: 0, minStock: 0, parStock: 0, ...x });
const today = "2026-10-01";

test("low-level codes put a component below everything that uses it", () => {
  const c = lowLevelCodes(["F", "S", "D", "A", "P"], bomOf);
  assert.deepEqual(Object.fromEntries(c), { F: 0, S: 1, P: 1, D: 2, A: 3 });
});

test("three levels: demand for boxes becomes biscuits, dough and flour, net of stock and dated by lead times", () => {
  const items = new Map([
    ["F", item("F", { onHand: 20, leadTimeDays: 1 })],
    ["S", item("S", { onHand: 400, leadTimeDays: 2 })],
    ["D", item("D", { leadTimeDays: 1 })],
    ["A", item("A", { onHand: 5, leadTimeDays: 7, minStock: 10 })],
    ["P", item("P", { onHand: 100, leadTimeDays: 3 })],
  ]);
  const s = runMrp({ today, items, bomOf, receipts: [], demands: [{ itemId: "F", date: "2026-10-20", quantity: 120, source: { type: "sales_order", ref: "SO-1" } }] });
  const by = (id: string) => s.filter((x) => x.itemId === id).map((x) => [x.kind, x.quantity, x.needDate, x.orderDate]);
  // 120 boxes − 20 in stock = 100 to make, started a day before the 20th.
  assert.deepEqual(by("F"), [["make", 100, "2026-10-20", "2026-10-19"]]);
  // 100 boxes × 12 = 1200 biscuits − 400 = 800 to make by the 19th; cartons 100 needed, 100 on hand: none.
  assert.deepEqual(by("S"), [["make", 800, "2026-10-19", "2026-10-17"]]);
  assert.deepEqual(by("P"), []);
  // 800 biscuits need 16 dough; 16 dough need 12.8 flour on the 16th: 5 on hand, minimum 10 → buy 17.8, a week earlier.
  assert.deepEqual(by("D"), [["make", 16, "2026-10-17", "2026-10-16"]]);
  // Flour is already under its minimum today (5 < 10): 5 now, then 12.8 more for the dough.
  assert.deepEqual(by("A"), [["buy", 5, today, today], ["buy", 12.8, "2026-10-16", "2026-10-09"]]);
});

test("scheduled receipts cover demand before anything is planned; a late order is flagged", () => {
  const items = new Map([["P", item("P", { leadTimeDays: 10 })]]);
  const s = runMrp({ today, items, bomOf, demands: [{ itemId: "P", date: "2026-10-05", quantity: 50, source: { type: "sales_order" } }],
    receipts: [{ itemId: "P", date: "2026-10-04", quantity: 30, source: { type: "purchase_order", ref: "PO-7" } }] });
  assert.equal(s.length, 1);
  assert.deepEqual([s[0]!.quantity, s[0]!.orderDate, s[0]!.late], [20, today, true]);
});

test("min/max: below the minimum it orders up to the target level; safety stock can be switched off", () => {
  const items = new Map([["P", item("P", { onHand: 3, minStock: 10, parStock: 50 })]]);
  assert.equal(runMrp({ today, items, bomOf, demands: [], receipts: [] })[0]!.quantity, 47);
  assert.equal(runMrp({ today, items, bomOf, demands: [], receipts: [], safetyStock: false }).length, 0);
});

test("finite capacity: orders queue on a busy work center by due date, and a late finish is flagged", async () => {
  const { schedule } = await import("../src/lib/manufacturing/schedule.ts");
  const wcs = [{ id: "oven", name: "الفرن", minutesPerDay: 480 }, { id: "pack", name: "التغليف", minutesPerDay: 240 }];
  const r = schedule({ today, workCenters: wcs, orders: [
    { moId: "B", number: 2, label: "B", dueDate: "2026-10-10", releaseDate: null, operations: [{ seq: 1, name: "خبز", workCenterId: "oven", minutes: 480 }] },
    { moId: "A", number: 1, label: "A", dueDate: "2026-10-02", releaseDate: null, operations: [{ seq: 1, name: "خبز", workCenterId: "oven", minutes: 960 }, { seq: 2, name: "تغليف", workCenterId: "pack", minutes: 120 }] },
  ] });
  // A is due first: two oven days (1st–2nd), then half a packing day on the 3rd → late for the 2nd.
  const a = r.orders.find((o) => o.moId === "A")!;
  assert.deepEqual([a.finishDate, a.late], ["2026-10-03", true]);
  // B waits for the oven: the 3rd.
  const b = r.operations.find((o) => o.moId === "B")!;
  assert.deepEqual([b.startDate, b.endDate], ["2026-10-03", "2026-10-03"]);
  assert.deepEqual(r.load["oven"]!.slice(0, 3), [480, 480, 480]);
  assert.deepEqual(r.load["pack"]!.slice(0, 3), [0, 0, 120]);
});
