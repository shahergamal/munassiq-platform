import type { Db } from "../../db/pool.ts";
import { AppError } from "../errors.ts";

// Statutory values for contracting (penalty caps, variation caps, guarantees, deadlines…) come from the dated
// regulatory_parameters table, never from constants. A value is looked up by the date of the EVENT and the law that
// governs the contract (GTPL 1440 / 1448 / private), not by today's date. A missing value, or one the platform admin
// has not yet verified against its official source, is an error: no silent default.

export type Regime = "GTPL_1440" | "GTPL_1448" | "PRIVATE";
export interface ParamValue {
  id: string; key: string; value: number; unit: string; regime: string; label: string; legalBasis: string; sourceTitle: string; sourceUrl: string | null;
  effectiveFrom: string; effectiveTo: string | null; confidence: string;
}

interface Row { id: string; key: string; value: string; unit: string; regime: string; label: string; legal_basis: string; source_title: string; source_url: string | null;
  effective_from: string; effective_to: string | null; confidence: string; status: string }

const COLS = `id, key, value::text, unit, regime, label, legal_basis, source_title, source_url, effective_from::text, effective_to::text, confidence, status`;
const toValue = (r: Row): ParamValue => ({ id: r.id, key: r.key, value: Number(r.value), unit: r.unit, regime: r.regime, label: r.label, legalBasis: r.legal_basis,
  sourceTitle: r.source_title, sourceUrl: r.source_url, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, confidence: r.confidence });

/** The row in force on `date` for the regime (a regime-specific value wins over one for ALL), or null. */
async function find(db: Db, key: string, date: string, regime: Regime | "ALL") {
  return (await db.query<Row>(
    `SELECT ${COLS} FROM regulatory_parameters
      WHERE key = $1 AND regime IN ($2, 'ALL') AND status <> 'retired' AND effective_from <= $3::date AND (effective_to IS NULL OR effective_to >= $3::date)
      ORDER BY regime = 'ALL', effective_from DESC LIMIT 1`, [key, regime, date])).rows[0] ?? null;
}

export async function resolveParam(db: Db, key: string, at: { date: string; regime: Regime | "ALL" }): Promise<ParamValue> {
  const r = await find(db, key, at.date, at.regime);
  if (!r) throw new AppError(422, "param_missing", `لا توجد قيمة نظامية «${key}» سارية في ${at.date} لنظام ${at.regime}. أضفها من «القيم التنظيمية» في لوحة مدير المنصة`, { key, ...at });
  if (r.status !== "verified") {
    throw new AppError(422, "param_unverified", `القيمة النظامية «${r.label}» (${r.legal_basis}) مسودة لم يوثّقها مدير المنصة بعد، فلا تُطبَّق`, { key, ...at });
  }
  return toValue(r);
}

/** For values a regime may simply not have (e.g. variation caps outside GTPL 1448): null when absent, error when unverified. */
export async function resolveParamIfAny(db: Db, key: string, at: { date: string; regime: Regime | "ALL" }): Promise<ParamValue | null> {
  const r = await find(db, key, at.date, at.regime);
  if (!r) return null;
  return resolveParam(db, key, at);
}

/** How a value is cited next to a calculation: «20% — المادة 70، نظام المنافسات… (سارٍ من 2027-01-02)». */
export const cite = (p: ParamValue) => `${p.value}${p.unit === "percent" ? "%" : ""} — ${p.legalBasis}، ${p.sourceTitle} (سارٍ من ${p.effectiveFrom})`;
