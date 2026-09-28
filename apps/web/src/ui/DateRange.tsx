import { addDays, isoDay } from "../lib/format";

/** Report/list period: quick presets + two native date inputs (Riyadh "today"). */
export function DateRange({ from, to, onChange }: { from: string; to: string; onChange: (from: string, to: string) => void }) {
  const today = isoDay();
  const presets: [string, string, string][] = [["اليوم", today, today], ["آخر 7 أيام", addDays(today, -6), today], ["آخر 30 يوماً", addDays(today, -29), today]];
  return (
    <div className="row">
      {presets.map(([l, f, t]) => <button key={l} type="button" className={`btn btn-sm ${from === f && to === t ? "btn-secondary" : "btn-ghost"}`} aria-pressed={from === f && to === t} onClick={() => onChange(f, t)}>{l}</button>)}
      <label className="row" style={{ gap: "var(--sp-1)" }}><span className="field-label">من</span><input type="date" className="input" style={{ width: "auto" }} value={from} max={to} onChange={(e) => e.target.value && onChange(e.target.value, to)} /></label>
      <label className="row" style={{ gap: "var(--sp-1)" }}><span className="field-label">إلى</span><input type="date" className="input" style={{ width: "auto" }} value={to} min={from} max={today} onChange={(e) => e.target.value && onChange(from, e.target.value)} /></label>
    </div>
  );
}
