import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { systemPool, withSystemTx } from "../db/pool.ts";
import { AppError, notFound } from "../lib/errors.ts";
import { auditSystem, isUuid, requireAdmin } from "../plugins/auth.ts";

// Platform admin: the statutory values contracting applies (penalty caps, variation caps, guarantees, deadlines…).
// Seeded as drafts; a value applies to contracts only after the admin verifies it against its official source.
// A verified value is evidence and is not edited (database trigger): it is closed by an end date or retired.

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح");
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const body = z.object({
  key: z.string().trim().regex(/^[a-z0-9_]{2,60}$/, "المفتاح بحروف إنجليزية صغيرة وأرقام و _"),
  regime: z.enum(["GTPL_1440", "GTPL_1448", "PRIVATE", "ALL"]),
  value: z.number().min(0).max(1e12),
  unit: z.enum(["percent", "sar", "days", "working_days", "months"]),
  label: text(3, 200), legalBasis: text(2, 300), sourceTitle: text(2, 300),
  sourceUrl: z.string().trim().url("رابط غير صالح").regex(/^https?:\/\//).max(500).nullable().optional().transform((v) => v || null),
  confidence: z.enum(["official", "secondary", "commercial"]),
  effectiveFrom: date, effectiveTo: date.nullable().optional().transform((v) => v ?? null),
  notes: z.string().trim().max(1000).nullable().optional().transform((v) => v || null),
}).refine((b) => !b.effectiveTo || b.effectiveTo >= b.effectiveFrom, { message: "نهاية السريان قبل بدايته", path: ["effectiveTo"] });

const overlap = (e: unknown) => {
  if ((e as { code?: string }).code === "23P01") return new AppError(409, "parameter_overlap", "توجد قيمة أخرى لنفس المفتاح والنظام في فترة متداخلة: أغلق الفترة السابقة بتاريخ نهاية أولاً");
  if ((e as { message?: string }).message?.includes("regulatory_parameter_verified")) return new AppError(409, "parameter_verified", "القيمة الموثقة لا تُعدّل: أغلقها بتاريخ نهاية وأضف قيمة جديدة");
  return e;
};

export default async function adminRegulatoryRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAdmin);

  app.get("/regulatory-parameters", async (req) => {
    const q = z.object({ status: z.enum(["draft", "verified", "retired"]).optional(), regime: z.enum(["GTPL_1440", "GTPL_1448", "PRIVATE", "ALL"]).optional() }).parse(req.query);
    const r = await systemPool.query(
      `SELECT p.id, p.key, p.regime, p.value::float8 AS value, p.unit, p.label, p.legal_basis AS "legalBasis", p.source_title AS "sourceTitle", p.source_url AS "sourceUrl",
              p.confidence, p.effective_from::text AS "effectiveFrom", p.effective_to::text AS "effectiveTo", p.status, p.notes, p.verified_at AS "verifiedAt",
              u.full_name AS "verifiedBy",
              -- How many active contracts took this value at activation (they keep it, whatever happens to the row later).
              (SELECT count(*)::int FROM contracts c WHERE c.applied_params -> p.key ->> 'id' = p.id::text) AS "usedBy"
         FROM regulatory_parameters p LEFT JOIN users u ON u.id = p.verified_by
        WHERE ($1::text IS NULL OR p.status = $1) AND ($2::text IS NULL OR p.regime = $2)
        ORDER BY p.status = 'draft' DESC, p.key, p.effective_from`, [q.status ?? null, q.regime ?? null]);
    return { items: r.rows };
  });

  app.post("/regulatory-parameters", async (req, reply) => {
    const b = body.parse(req.body);
    const id = await withSystemTx(async (db) => {
      try {
        const r = (await db.query<{ id: string }>(
          `INSERT INTO regulatory_parameters (key, regime, value, unit, label, legal_basis, source_title, source_url, confidence, effective_from, effective_to, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
          [b.key, b.regime, b.value, b.unit, b.label, b.legalBasis, b.sourceTitle, b.sourceUrl, b.confidence, b.effectiveFrom, b.effectiveTo, b.notes])).rows[0]!;
        await auditSystem(db, req, null, "regulatory.created", "regulatory_parameter", r.id, { key: b.key, regime: b.regime, value: b.value });
        return r.id;
      } catch (e) { throw overlap(e); }
    });
    return reply.status(201).send({ id });
  });

  // A draft changes freely; a verified value only gets its end date, source link and notes.
  app.put("/regulatory-parameters/:id", async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = body.parse(req.body);
    await withSystemTx(async (db) => {
      const p = (await db.query<{ status: string }>("SELECT status FROM regulatory_parameters WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!p) throw notFound("القيمة غير موجودة");
      if (p.status === "retired") throw new AppError(409, "parameter_retired", "القيمة الملغاة لا تُعدّل");
      try {
        await db.query(
          `UPDATE regulatory_parameters SET key = $2, regime = $3, value = $4, unit = $5, label = $6, legal_basis = $7, source_title = $8, source_url = $9, confidence = $10,
                  effective_from = $11, effective_to = $12, notes = $13 WHERE id = $1`,
          [id, b.key, b.regime, b.value, b.unit, b.label, b.legalBasis, b.sourceTitle, b.sourceUrl, b.confidence, b.effectiveFrom, b.effectiveTo, b.notes]);
      } catch (e) { throw overlap(e); }
      await auditSystem(db, req, null, "regulatory.updated", "regulatory_parameter", id, { key: b.key, value: b.value, effectiveTo: b.effectiveTo });
    });
    return { ok: true };
  });

  // Verification is the admin's statement that the value matches its official source; it is audited with that source.
  app.post("/regulatory-parameters/:id/:action", async (req) => {
    const { id, action } = req.params as { id: string; action: string };
    if (!isUuid(id) || !["verify", "retire"].includes(action)) throw notFound();
    const b = z.object({ note: z.string().trim().max(500).optional() }).parse(req.body ?? {});
    await withSystemTx(async (db) => {
      const p = (await db.query<{ status: string; key: string; value: string; source_title: string }>(
        "SELECT status, key, value::text, source_title FROM regulatory_parameters WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!p) throw notFound("القيمة غير موجودة");
      if (action === "verify") {
        if (p.status !== "draft") throw new AppError(409, "invalid_state", "يوثَّق المسودة فقط");
        await db.query("UPDATE regulatory_parameters SET status = 'verified', verified_by = $2, verified_at = now() WHERE id = $1", [id, req.auth!.id]);
      } else {
        if (p.status === "retired") throw new AppError(409, "invalid_state", "القيمة ملغاة من قبل");
        await db.query("UPDATE regulatory_parameters SET status = 'retired' WHERE id = $1", [id]);
      }
      await auditSystem(db, req, null, `regulatory.${action === "verify" ? "verified" : "retired"}`, "regulatory_parameter", id,
        { key: p.key, value: Number(p.value), source: p.source_title, note: b.note ?? null });
    });
    return { ok: true };
  });

  app.delete("/regulatory-parameters/:id", async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    await withSystemTx(async (db) => {
      const r = await db.query("DELETE FROM regulatory_parameters WHERE id = $1 AND status = 'draft' RETURNING key", [id]);
      if (!r.rowCount) throw new AppError(409, "invalid_state", "تُحذف المسودة فقط؛ الموثقة تُلغى");
      await auditSystem(db, req, null, "regulatory.deleted", "regulatory_parameter", id, { key: r.rows[0].key });
    });
    return { ok: true };
  });
}
