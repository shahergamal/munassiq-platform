// Site materials and equipment, pure. Amounts in halalas.

/** A day of a machine on a project: operating hours at the internal rate, idle hours at the idle share of it; breakdown free. */
export function equipmentCharge(p: { operatingHours: number; idleHours: number; hourlyRate: number; idleRatePct: number }) {
  return Math.round(p.operatingHours * p.hourlyRate + p.idleHours * p.hourlyRate * p.idleRatePct / 100);
}

/** Utilisation = operating hours over the hours the machine was on the project. */
export const utilisation = (operating: number, idle: number, breakdown: number) => {
  const on = operating + idle + breakdown;
  return on > 0 ? Math.round((operating / on) * 10_000) / 100 : null;
};

/**
 * Consumption against the BOQ: the theoretical quantity is what the certified work needs by its norm; waste is the
 * issued quantity beyond it, as a share of the theoretical (negative when less was used).
 */
export function consumption(p: { certifiedQty: number; normPerUnit: number; issuedQty: number }) {
  const theoretical = Math.round(p.certifiedQty * p.normPerUnit * 10_000) / 10_000;
  const variance = Math.round((p.issuedQty - theoretical) * 10_000) / 10_000;
  return { theoretical, variance, wastePct: theoretical > 0 ? Math.round((variance / theoretical) * 10_000) / 100 : null };
}
