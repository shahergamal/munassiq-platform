/**
 * Money helpers. All arithmetic is done in integer minor units ("halalas")
 * so that VAT and discount allocation never suffer from floating-point drift.
 */

export type Halalas = number;

/** Parse "12.345" / 12.345 into halalas using half-up rounding. Negative values are rejected. */
export function parseMoney(input: string | number): Halalas {
  const raw = typeof input === "number" ? input.toFixed(6) : String(input).trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) throw new RangeError("invalid_money");
  const [whole = "0", frac = ""] = raw.split(".");
  const digits = (frac + "000").slice(0, 3);
  let halalas = Number(whole) * 100 + Number(digits.slice(0, 2));
  if (Number(digits[2]) >= 5) halalas += 1;
  if (!Number.isSafeInteger(halalas)) throw new RangeError("money_out_of_range");
  return halalas;
}

export function formatMoney(halalas: Halalas): string {
  return (halalas / 100).toFixed(2);
}

/** VAT in halalas for a net amount; `rateBp` is basis points (1500 = 15%). Half-up. */
export function vatOf(netHalalas: Halalas, rateBp: number): Halalas {
  return Math.floor((netHalalas * rateBp + 5000) / 10000);
}

/** Percent (e.g. 15 or 7.25) to basis points. */
export function percentToBp(percent: number): number {
  return Math.round(percent * 100);
}

/**
 * Split `total` across `weights` so the parts are integers that sum exactly to `total`
 * (largest-remainder method). Zero total weight puts everything on the last part.
 */
export function allocateProportionally(total: Halalas, weights: number[]): Halalas[] {
  if (weights.length === 0) return [];
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    const out = weights.map(() => 0);
    out[out.length - 1] = total;
    return out;
  }
  const raw = weights.map((w) => (total * w) / sum);
  const floors = raw.map(Math.floor);
  let remainder = total - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    remainder -= 1;
  }
  return floors;
}

export type Discount = { type: "amount"; value: Halalas } | { type: "percent"; valueBp: number } | null;

export interface PricedLine {
  net: Halalas;
  discount: Halalas;
  taxable: Halalas;
  vat: Halalas;
  total: Halalas;
}

export interface PricedOrder {
  lines: PricedLine[];
  subtotal: Halalas;
  discount: Halalas;
  taxable: Halalas;
  vat: Halalas;
  total: Halalas;
}

/**
 * Price an order server-side. Unit prices are VAT-exclusive. Each line shows its own VAT, but the order's VAT is
 * computed once on the order's taxable total (ZATCA BR-CO-17: category VAT = round(taxable × rate)), so it can
 * differ from the sum of line VATs by a halala.
 */
export function priceOrder(
  lines: { unitNet: Halalas; quantity: number }[],
  discount: Discount,
  vatRateBp: number,
): PricedOrder {
  const nets = lines.map((l) => {
    if (!Number.isInteger(l.quantity) || l.quantity <= 0) throw new RangeError("invalid_quantity");
    return l.unitNet * l.quantity;
  });
  const subtotal = nets.reduce((a, b) => a + b, 0);
  let discountTotal = 0;
  if (discount?.type === "amount") discountTotal = discount.value;
  if (discount?.type === "percent") discountTotal = Math.floor((subtotal * discount.valueBp + 5000) / 10000);
  if (discountTotal > subtotal) throw new RangeError("discount_exceeds_subtotal");
  const shares = allocateProportionally(discountTotal, nets);
  const priced = nets.map((net, i): PricedLine => {
    const disc = shares[i] ?? 0;
    const taxable = net - disc;
    const vat = vatOf(taxable, vatRateBp);
    return { net, discount: disc, taxable, vat, total: taxable + vat };
  });
  const taxable = priced.reduce((a, l) => a + l.taxable, 0);
  const vat = vatOf(taxable, vatRateBp);
  return { lines: priced, subtotal, discount: discountTotal, taxable, vat, total: taxable + vat };
}

/**
 * Splits a VAT-inclusive amount the way a ZATCA document must show it: VAT = round(net × rate) exactly, and the
 * net is the largest amount whose total does not exceed `gross`. What is left (0 or 0.01) is the document's payable
 * rounding amount, never negative. Some inclusive amounts (10.00 at 15%) have no exact split.
 */
export function splitGross(gross: Halalas, rateBp: number): { net: Halalas; vat: Halalas; rounding: Halalas } {
  let net = Math.floor((gross * 10000) / (10000 + rateBp));
  while (net > 0 && net + vatOf(net, rateBp) > gross) net--;
  while (net + 1 + vatOf(net + 1, rateBp) <= gross) net++;
  const vat = vatOf(net, rateBp);
  return { net, vat, rounding: gross - net - vat };
}

/** An amount for an Arabic message, written like the UI writes it: the riyal sign (U+20C1) left of the amount, LTR-isolated. */
export const riyal = (halalas: Halalas) => `\u2066\u20C1\u00A0${(halalas / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\u2069`;
