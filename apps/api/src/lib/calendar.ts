import { z } from "zod";

/** A real calendar date in YYYY-MM-DD (2026-02-30 is refused here rather than by the database as a 500). */
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح")
  .refine((d) => { const t = Date.parse(`${d}T00:00:00Z`); return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d; }, "تاريخ غير صالح");
