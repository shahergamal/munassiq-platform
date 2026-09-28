// Finite-capacity forward scheduling, pure (no database). Orders take their turn by due date (then number); each
// operation starts when its work center is free and the order's previous operation is done, and lasts its minutes at
// the center's capacity per day. Time is counted in days from the start of today (fractions within a day).

import { shiftDays } from "./mrp.ts";

export interface WorkCenterCap { id: string; name: string; minutesPerDay: number }
export interface SchedOrder {
  moId: string;
  number: number;
  label: string;
  dueDate: string | null;
  /** Not before this date (planned start), and never before today. */
  releaseDate: string | null;
  /** A maintenance order occupies its machine's work center like a one-operation order. */
  kind?: "mo" | "maintenance";
  operations: { seq: number; name: string; workCenterId: string; minutes: number }[];
}
export interface ScheduledOp { moId: string; seq: number; name: string; workCenterId: string; start: number; end: number; startDate: string; endDate: string }
export interface ScheduleResult {
  operations: ScheduledOp[];
  orders: { moId: string; kind: "mo" | "maintenance"; number: number; label: string; dueDate: string | null; start: number; end: number; finishDate: string; late: boolean }[];
  /** Minutes booked per work center per day index (0 = today). */
  load: Record<string, number[]>;
  horizonDays: number;
}

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export function schedule(p: { today: string; workCenters: WorkCenterCap[]; orders: SchedOrder[] }): ScheduleResult {
  const cap = new Map(p.workCenters.map((w) => [w.id, Math.max(1, w.minutesPerDay)]));
  const free = new Map(p.workCenters.map((w) => [w.id, 0]));
  const load: Record<string, number[]> = Object.fromEntries(p.workCenters.map((w) => [w.id, []]));
  const book = (wc: string, start: number, end: number) => {
    const perDay = cap.get(wc)!;
    for (let d = Math.floor(start); d < Math.ceil(end); d++) {
      const used = Math.min(end, d + 1) - Math.max(start, d);
      if (used > 0) (load[wc]![d] = (load[wc]![d] ?? 0) + used * perDay);
    }
  };
  const ordered = [...p.orders].sort((a, b) => (a.dueDate ?? "9999") < (b.dueDate ?? "9999") ? -1 : (a.dueDate ?? "9999") > (b.dueDate ?? "9999") ? 1 : a.number - b.number);
  const operations: ScheduledOp[] = [];
  const orders: ScheduleResult["orders"] = [];
  const dateOf = (t: number) => shiftDays(p.today, Math.floor(t + 1e-9));
  for (const o of ordered) {
    let ready = Math.max(0, o.releaseDate ? daysBetween(p.today, o.releaseDate) : 0);
    const first = ready;
    for (const op of [...o.operations].sort((a, b) => a.seq - b.seq)) {
      if (!cap.has(op.workCenterId) || op.minutes <= 0) continue;
      const start = Math.max(ready, free.get(op.workCenterId)!);
      const end = start + op.minutes / cap.get(op.workCenterId)!;
      free.set(op.workCenterId, end);
      book(op.workCenterId, start, end);
      operations.push({ moId: o.moId, seq: op.seq, name: op.name, workCenterId: op.workCenterId, start, end, startDate: dateOf(start), endDate: dateOf(Math.max(start, end - 1e-6)) });
      ready = end;
    }
    const finishDate = dateOf(Math.max(first, ready - 1e-6));
    orders.push({ moId: o.moId, kind: o.kind ?? "mo", number: o.number, label: o.label, dueDate: o.dueDate, start: first, end: ready, finishDate, late: Boolean(o.dueDate && finishDate > o.dueDate) });
  }
  const horizonDays = Math.max(7, Math.ceil(Math.max(0, ...operations.map((x) => x.end))));
  for (const wc of Object.keys(load)) load[wc] = Array.from({ length: horizonDays }, (_, i) => Math.round(load[wc]![i] ?? 0));
  return { operations, orders, load, horizonDays };
}
