import { allocateProportionally, type Halalas } from "./money.ts";

const round = (n: number, dp: number) => {
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
};

export const round4 = (n: number) => round(n, 4);
export const round6 = (n: number) => round(n, 6);

/** Moving weighted-average cost after receiving `addQty` at `addCost` (per base unit). */
export function weightedAverage(oldQty: number, oldCost: number, addQty: number, addCost: number): number {
  if (!(addQty > 0)) throw new RangeError("invalid_quantity");
  if (addCost < 0) throw new RangeError("invalid_cost");
  if (oldQty <= 0) return round6(addCost);
  return round6((oldQty * oldCost + addQty * addCost) / (oldQty + addQty));
}

export interface ReceiptLine {
  lineValue: Halalas; // quantity * unit price, in halalas
  baseQuantity: number; // quantity converted to the ingredient base unit
  /** Mass of the line (any one mass unit for all lines), or 0 when the item is not counted by mass. */
  weight?: number;
}

export type CostAllocation = "value" | "quantity" | "weight";

/**
 * Landed cost: the discount is subtracted by line value; shipping and fees (freight, insurance, customs, clearance)
 * are added by the chosen basis: line value, base quantity, or weight (lines without a weight carry none; when no
 * line has one, value is used). Returns the cost per BASE unit for every line.
 */
export function landedUnitCosts(
  lines: ReceiptLine[],
  adjustments: { discount: Halalas; shipping: Halalas; fees: Halalas },
  basis: CostAllocation = "value",
): number[] {
  const subtotal = lines.reduce((a, l) => a + l.lineValue, 0);
  if (adjustments.discount > subtotal) throw new RangeError("discount_exceeds_subtotal");
  const byValue = lines.map((l) => l.lineValue);
  const byWeight = lines.map((l) => l.weight ?? 0);
  const weights = basis === "quantity" ? lines.map((l) => l.baseQuantity)
    : basis === "weight" && byWeight.some((w) => w > 0) ? byWeight : byValue;
  const extra = allocateProportionally(adjustments.shipping + adjustments.fees, weights);
  const disc = allocateProportionally(adjustments.discount, byValue);
  return lines.map((l, i) => {
    if (!(l.baseQuantity > 0)) throw new RangeError("invalid_quantity");
    const effective = l.lineValue + (extra[i] ?? 0) - (disc[i] ?? 0);
    return round6(effective / 100 / l.baseQuantity);
  });
}

/** Raw stock needed to yield `usableQty` of an ingredient (trim/prep loss via yield %). */
export function rawQuantityFor(usableQty: number, yieldPercentage: number): number {
  if (!(yieldPercentage > 0 && yieldPercentage <= 100)) throw new RangeError("invalid_yield");
  return round4((usableQty * 100) / yieldPercentage);
}

export function recipeLineCost(usableQty: number, avgCost: number, yieldPercentage: number): number {
  return round6(rawQuantityFor(usableQty, yieldPercentage) * avgCost);
}

export function foodCostPercent(cost: number, priceNet: number): number | null {
  return priceNet > 0 ? round(((cost / priceNet) * 100), 2) : null;
}
