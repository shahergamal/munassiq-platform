import test from "node:test";
import assert from "node:assert/strict";
import { parseMoney, formatMoney, vatOf, allocateProportionally, priceOrder, percentToBp, splitGross } from "../src/lib/money.ts";

test("parseMoney rounds half-up and rejects junk", () => {
  assert.equal(parseMoney("1.005"), 101);
  assert.equal(parseMoney("1.004"), 100);
  assert.equal(parseMoney(19.99), 1999);
  assert.equal(parseMoney("0"), 0);
  assert.throws(() => parseMoney("-1"));
  assert.throws(() => parseMoney("abc"));
  assert.throws(() => parseMoney(""));
  assert.equal(formatMoney(1999), "19.99");
});

test("vatOf 15% is half-up", () => {
  assert.equal(vatOf(10000, 1500), 1500);
  assert.equal(vatOf(333, 1500), 50); // 49.95 -> 50
  assert.equal(vatOf(0, 1500), 0);
});

test("allocateProportionally always sums to the total", () => {
  for (const total of [0, 1, 7, 100, 999]) {
    const parts = allocateProportionally(total, [333, 333, 334]);
    assert.equal(parts.reduce((a, b) => a + b, 0), total);
    assert.ok(parts.every((p) => Number.isInteger(p) && p >= 0));
  }
  assert.deepEqual(allocateProportionally(10, [0, 0]), [0, 10]);
});

test("priceOrder: totals are consistent and discount is spread", () => {
  const o = priceOrder(
    [{ unitNet: 1000, quantity: 3 }, { unitNet: 555, quantity: 1 }],
    { type: "percent", valueBp: percentToBp(10) },
    1500,
  );
  assert.equal(o.subtotal, 3555);
  assert.equal(o.discount, 356); // 355.5 -> 356
  assert.equal(o.lines.reduce((a, l) => a + l.discount, 0), o.discount);
  assert.equal(o.taxable, o.subtotal - o.discount);
  assert.equal(o.total, o.taxable + o.vat);
  assert.equal(o.lines.reduce((a, l) => a + l.total, 0), o.total);
});

test("priceOrder rejects bad input", () => {
  assert.throws(() => priceOrder([{ unitNet: 100, quantity: 0 }], null, 1500));
  assert.throws(() => priceOrder([{ unitNet: 100, quantity: 1.5 }], null, 1500));
  assert.throws(() => priceOrder([{ unitNet: 100, quantity: 1 }], { type: "amount", value: 101 }, 1500));
});

test("priceOrder: the order's VAT is computed on its taxable total (ZATCA BR-CO-17), not summed from lines", () => {
  // Two lines of 0.03: each line's VAT rounds to 0.00, the order's 0.06 × 15% = 0.009 rounds to 0.01.
  const o = priceOrder([{ unitNet: 3, quantity: 1 }, { unitNet: 3, quantity: 1 }], null, 1500);
  assert.deepEqual(o.lines.map((l) => l.vat), [0, 0]);
  assert.equal(o.vat, 1);
  assert.equal(o.total, o.taxable + o.vat);
});

test("splitGross: VAT is exactly round(net × 15%), and the rest is a non-negative rounding", () => {
  assert.deepEqual(splitGross(1000, 1500), { net: 869, vat: 130, rounding: 1 }, "10.00 has no exact split");
  assert.deepEqual(splitGross(1150, 1500), { net: 1000, vat: 150, rounding: 0 });
  for (let g = 1; g < 5000; g += 7) {
    const s = splitGross(g, 1500);
    assert.equal(s.vat, vatOf(s.net, 1500));
    assert.ok(s.rounding === 0 || s.rounding === 1, `gross ${g}`);
  }
});
