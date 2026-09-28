import test from "node:test";
import assert from "node:assert/strict";
import { weightedAverage, landedUnitCosts, rawQuantityFor, recipeLineCost, foodCostPercent } from "../src/lib/costing.ts";

test("weighted average cost", () => {
  assert.equal(weightedAverage(0, 0, 10, 5), 5);
  assert.equal(weightedAverage(10, 5, 10, 7), 6);
  assert.equal(weightedAverage(3, 10, 1, 6), 9);
  assert.throws(() => weightedAverage(1, 1, 0, 1));
});

test("landed cost spreads shipping/fees and subtracts discount", () => {
  // two lines 100.00 and 300.00; +40.00 shipping, -20.00 discount => +10/-5 and +30/-15
  const costs = landedUnitCosts(
    [{ lineValue: 10000, baseQuantity: 10 }, { lineValue: 30000, baseQuantity: 30 }],
    { discount: 2000, shipping: 4000, fees: 0 },
  );
  assert.deepEqual(costs, [10.5, 10.5]);
  assert.throws(() => landedUnitCosts([{ lineValue: 100, baseQuantity: 1 }], { discount: 101, shipping: 0, fees: 0 }));
});

test("yield raises the raw quantity and cost", () => {
  assert.equal(rawQuantityFor(80, 80), 100);
  assert.equal(recipeLineCost(80, 0.05, 80), 5);
  assert.throws(() => rawQuantityFor(1, 0));
  assert.equal(foodCostPercent(30, 100), 30);
  assert.equal(foodCostPercent(30, 0), null);
});

test("landed cost: shipping and fees spread by value, by quantity, or by weight", () => {
  // Two lines: 100 kg of flour at 200 and 10 pieces of packaging at 800; 300 of freight.
  const lines = [{ lineValue: 20000, baseQuantity: 100_000, weight: 100_000 }, { lineValue: 80000, baseQuantity: 10, weight: 0 }];
  const adj = { discount: 0, shipping: 30000, fees: 0 };
  // By value: 60 / 240 → 2.6 per kg (260 / 100 000 g), 104 per piece.
  assert.deepEqual(landedUnitCosts(lines, adj, "value"), [0.0026, 104]);
  // By weight: all the freight rides on the flour (the pieces weigh nothing): 500 / 100 000 g, 80 per piece.
  assert.deepEqual(landedUnitCosts(lines, adj, "weight"), [0.005, 80]);
  // By quantity (base units): the grams carry nearly everything.
  const q = landedUnitCosts(lines, adj, "quantity");
  assert.ok(q[0]! > 0.00499 && q[1]! < 80.04);
  // Weight with nothing weighed falls back to value.
  assert.deepEqual(landedUnitCosts(lines.map((l) => ({ ...l, weight: 0 })), adj, "weight"), [0.0026, 104]);
});
