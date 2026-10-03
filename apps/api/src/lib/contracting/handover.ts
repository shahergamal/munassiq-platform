// Handover and the defects liability period, pure.

/** The date `months` after `date`, on the same day or the month's last day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(date: string, months: number) {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const total = (m - 1) + months;
  const year = y + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

/** What still stands between a contract and its final acceptance, in words for the user (empty: ready). */
export function finalAcceptanceBlockers(s: { openItems: number; ipcsInProgress: number; dlpEndsOn: string; date: string; earlyReason: string | null }) {
  const out: string[] = [];
  if (s.openItems) out.push(`${s.openItems} ملاحظة أو عيب لم يُتحقق من إصلاحه`);
  if (s.ipcsInProgress) out.push("مستخلص قيد الإعداد أو الاعتماد");
  if (s.date < s.dlpEndsOn && !s.earlyReason) out.push(`فترة الضمان تنتهي ${s.dlpEndsOn}: الاستلام النهائي قبلها يحتاج سبباً (موافقة المالك)`);
  return out;
}
