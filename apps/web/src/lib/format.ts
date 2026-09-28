// One formatter per kind, used everywhere (the old UI had 7 different SAR formatters).
// Numbers use Latin digits with two decimals; money carries the Saudi Riyal sign instead of «ر.س».

/** U+20C1 SAUDI RIYAL SIGN. Drawn by our one-glyph font (styles/base.css) until system fonts carry it. */
export const RIYAL = "⃁";
// Left-to-right isolate: the sign stays on the left of the amount, whatever the direction of the text around it.
const LRI = "⁦", PDI = "⁩", NBSP = " ";

const NUM = "en-US";
const fixed2 = new Intl.NumberFormat(NUM, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const unitCost = new Intl.NumberFormat(NUM, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const qty = new Intl.NumberFormat(NUM, { minimumFractionDigits: 2, maximumFractionDigits: 3 });
const int = new Intl.NumberFormat(NUM, { maximumFractionDigits: 0 });
const pct = new Intl.NumberFormat(NUM, { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Arabic month and period names, Gregorian calendar, Latin digits.
const DATES = "ar-SA-u-ca-gregory-nu-latn";
const date = new Intl.DateTimeFormat(DATES, { dateStyle: "medium", timeZone: "Asia/Riyadh" });
const dateTime = new Intl.DateTimeFormat(DATES, { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Riyadh" });
const dateLong = new Intl.DateTimeFormat(DATES, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Riyadh" });
const timeOnly = new Intl.DateTimeFormat(DATES, { hour: "numeric", minute: "2-digit", timeZone: "Asia/Riyadh" });
const hourRiyadh = new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: "Asia/Riyadh" });

const EMPTY = "—";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const withSign = (n: string) => `${LRI}${RIYAL}${NBSP}${n}${PDI}`;

export const money = (v: number | null | undefined) => (isNum(v) ? withSign(fixed2.format(v)) : EMPTY);
/** Per-base-unit costs need more precision than invoice totals (0.0125 per g): two to four decimals. */
export const cost = (v: number | null | undefined) => (isNum(v) ? withSign(unitCost.format(v)) : EMPTY);
/** Two decimals; a third only when it carries a real value (0.125 kg). */
export const quantity = (v: number | null | undefined) => (isNum(v) ? qty.format(v) : EMPTY);
export const integer = (v: number | null | undefined) => (isNum(v) ? int.format(v) : EMPTY);
/** Takes a percentage number (30 = 30%). */
export const percent = (v: number | null | undefined) => (isNum(v) ? `${LRI}${pct.format(v / 100)}${PDI}` : EMPTY);
export const day = (v: string | null | undefined) => (v ? date.format(new Date(v.length === 10 ? `${v}T12:00:00+03:00` : v)) : EMPTY);
/** Umm al-Qura (Saudi official) date next to the Gregorian one on documents: "12 ربيع الآخر 1448 هـ". */
const hijriFmt = new Intl.DateTimeFormat("ar-SA-u-ca-islamic-umalqura-nu-latn", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Riyadh" });
export const hijri = (v: string | null | undefined) => (v ? hijriFmt.format(new Date(v.length === 10 ? `${v}T12:00:00+03:00` : v)) : EMPTY);
export const dayTime = (v: string | null | undefined) => (v ? dateTime.format(new Date(v)) : EMPTY);
/** "الخميس، 24 سبتمبر 2026" */
export const dayLong = (d = new Date()) => dateLong.format(d);
export const time = (v: string | null | undefined) => (v ? timeOnly.format(new Date(v)) : EMPTY);
/** Morning until noon Riyadh time, evening after. */
export const greeting = (d = new Date()) => (Number(hourRiyadh.format(d)) < 12 ? "صباح الخير" : "مساء الخير");
export const text = (v: string | null | undefined) => (v && v.trim() ? v : EMPTY);

/** YYYY-MM-DD in Riyadh, for date inputs and report ranges. */
export function isoDay(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh" }).format(d);
}
export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  return Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${isoDay()}T00:00:00Z`)) / 86_400_000);
}
