import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { nextRevision, sniffMime } from "../../lib/contracting/siteQuality.ts";
import { AppError, badRequest, notFound } from "../../lib/errors.ts";
import { systemPool } from "../../db/pool.ts";
import { auditTenant, isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";
import { today } from "../restaurants/batches.ts";
import { projectOpen } from "./site.ts";

// Document control and daily site reports (docs/contracting/ARCHITECTURE.md, C10). A document's revisions are files
// kept as they were uploaded (append-only, with their SHA-256); the type is read from the file's bytes. A submittal is
// a revision the consultant reviews once (A–D). A transmittal records which revisions went to whom and why. A daily
// report is a draft until submitted, then final; its manpower hours are the safety man-hours.

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح");
const optText = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => v || null);
const conflict = (m: string, code = "invalid_state") => new AppError(409, code, m);
const MAX_FILE = 15 * 1024 * 1024;
const DOC_TYPES = ["drawing", "shop_drawing", "specification", "method_statement", "material_submittal", "report", "correspondence", "other"] as const;
const DISCIPLINE = ["architectural", "structural", "mep", "civil", "general"] as const;
const EXT: Record<string, string> = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg", "image/vnd.dwg": "dwg" };

/** Members' names (the app role does not read users): only for members of this workspace. */
async function memberNames(tenantId: string, ids: (string | null)[]) {
  const want = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (!want.length) return new Map<string, string>();
  return new Map((await systemPool.query<{ id: string; full_name: string }>(
    "SELECT u.id, u.full_name FROM users u JOIN memberships m ON m.user_id = u.id AND m.tenant_id = $1 WHERE u.id = ANY($2::uuid[])", [tenantId, want])).rows.map((r) => [r.id, r.full_name]));
}

export default async function documentRoutes(app: FastifyInstance) {
  // ── Register ──────────────────────────────────────────────────────────────────────────────
  app.get("/projects/:id/documents", { preHandler: requireTenant("documents.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const q = z.object({ docType: z.enum(DOC_TYPES).optional(), discipline: z.enum(DISCIPLINE).optional() }).parse(req.query);
    return tenantTx(req, async (db) => ({
      items: (await db.query(
        `SELECT d.id, d.number, d.title, d.doc_type AS "docType", d.discipline, l.revision AS "latestRevision", l.id AS "latestRevisionId", l.created_at AS "latestAt",
                rv.code AS "reviewCode", (SELECT count(*)::int FROM document_revisions x WHERE x.document_id = d.id) AS revisions
           FROM project_documents d
           LEFT JOIN LATERAL (SELECT id, revision, created_at FROM document_revisions r WHERE r.document_id = d.id ORDER BY created_at DESC LIMIT 1) l ON true
           LEFT JOIN document_reviews rv ON rv.revision_id = l.id
          WHERE d.project_id = $1 AND ($2::text IS NULL OR d.doc_type = $2) AND ($3::text IS NULL OR d.discipline = $3)
          ORDER BY d.number LIMIT 2000`, [id, q.docType ?? null, q.discipline ?? null])).rows,
    }), { readOnly: true });
  });

  app.post("/projects/:id/documents", { preHandler: requireTenant("documents.upload") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ number: z.string().trim().regex(/^[A-Za-z0-9._/-]{1,60}$/, "الرقم حروف لاتينية وأرقام و . _ / - فقط"), title: z.string().trim().min(2).max(200),
      docType: z.enum(DOC_TYPES), discipline: z.enum(DISCIPLINE) }).parse(req.body);
    const out = await tenantTx(req, async (db) => {
      await projectOpen(db, id);
      const row = (await db.query<{ id: string }>("INSERT INTO project_documents (tenant_id, project_id, number, title, doc_type, discipline, created_by) VALUES (app_tenant_id(), $1, $2, $3, $4, $5, app_user_id()) RETURNING id",
        [id, b.number, b.title, b.docType, b.discipline])).rows[0]!;
      await auditTenant(db, req, "document.registered", "project_document", row.id, { number: b.number });
      return row;
    });
    return reply.status(201).send(out);
  });

  app.get("/documents/:id", { preHandler: requireTenant("documents.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const d = (await db.query(`SELECT id, project_id AS "projectId", number, title, doc_type AS "docType", discipline FROM project_documents WHERE id = $1`, [id])).rows[0];
      if (!d) throw notFound("الوثيقة غير موجودة");
      const rows = (await db.query<{ revision: string; createdBy: string }>(
        `SELECT r.id, r.revision, r.filename, r.mime, r.size_bytes AS "sizeBytes", r.sha256, r.notes, r.created_at AS "createdAt", r.created_by AS "createdBy",
                rv.code AS "reviewCode", rv.reviewed_on::text AS "reviewedOn", rv.reviewer, rv.comments AS "reviewComments",
                coalesce((SELECT json_agg(json_build_object('number', t.number, 'recipient', t.recipient, 'purpose', t.purpose, 'sentOn', t.sent_on::text) ORDER BY t.number)
                            FROM transmittal_items ti JOIN transmittals t ON t.id = ti.transmittal_id WHERE ti.revision_id = r.id), '[]') AS transmittals
           FROM document_revisions r LEFT JOIN document_reviews rv ON rv.revision_id = r.id
          WHERE r.document_id = $1 ORDER BY r.created_at DESC`, [id])).rows;
      const names = await memberNames(req.tenant!.id, rows.map((r) => r.createdBy));
      const revisions = rows.map(({ createdBy, ...r }) => ({ ...r, uploadedBy: names.get(createdBy) ?? null }));
      return { ...d, revisions, suggestedRevision: nextRevision(revisions[0]?.revision ?? null) };
    }, { readOnly: true });
  });

  /** A new revision: the file (PDF, PNG, JPEG or DWG by its bytes, up to 15 MB), its code (default: the next) and a note. */
  app.post("/documents/:id/revisions", { preHandler: requireTenant("documents.upload"), config: { rateLimit: { max: 60, timeWindow: "10 minutes" } } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const q = z.object({ revision: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,4}$/, "رمز الإصدار حروف لاتينية كبيرة أو أرقام حتى 4").optional(), notes: optText(500) }).parse(req.query);
    const file = await req.file({ limits: { fileSize: MAX_FILE, files: 1 } });
    if (!file) throw badRequest("أرفق ملف الإصدار");
    const content = await file.toBuffer();
    if (file.file.truncated) throw badRequest("حجم الملف أكبر من 15 ميجابايت");
    const mime = sniffMime(content);
    if (!mime) throw badRequest("نوع الملف غير مقبول: PDF أو صورة PNG/JPEG أو رسم DWG");
    const base = (file.filename || "file").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 180);
    const filename = base.toLowerCase().endsWith(`.${EXT[mime]}`) ? base : `${base}.${EXT[mime]}`;
    const out = await tenantTx(req, async (db) => {
      const d = (await db.query<{ project_id: string }>("SELECT project_id FROM project_documents WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!d) throw notFound("الوثيقة غير موجودة");
      await projectOpen(db, d.project_id);
      const latest = (await db.query<{ revision: string }>("SELECT revision FROM document_revisions WHERE document_id = $1 ORDER BY created_at DESC LIMIT 1", [id])).rows[0]?.revision ?? null;
      const revision = q.revision ?? nextRevision(latest);
      if ((await db.query("SELECT 1 FROM document_revisions WHERE document_id = $1 AND revision = $2", [id, revision])).rowCount) throw conflict(`الإصدار ${revision} موجود: الملف لا يُستبدل، ارفع إصداراً جديداً`, "duplicate");
      const row = (await db.query<{ id: string }>(
        `INSERT INTO document_revisions (tenant_id, document_id, revision, filename, mime, size_bytes, sha256, content, notes, created_by)
         VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, app_user_id()) RETURNING id`,
        [id, revision, filename, mime, content.length, createHash("sha256").update(content).digest("hex"), content, q.notes])).rows[0]!;
      await auditTenant(db, req, "document.revision", "project_document", id, { revision, bytes: content.length });
      return { id: row.id, revision };
    });
    return reply.status(201).send(out);
  });

  app.get("/document-revisions/:id/file", { preHandler: requireTenant("documents.view") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const f = await tenantTx(req, async (db) =>
      (await db.query<{ filename: string; mime: string; content: Buffer }>("SELECT filename, mime, content FROM document_revisions WHERE id = $1", [id])).rows[0], { readOnly: true });
    if (!f) throw notFound("الملف غير موجود");
    return reply.header("content-type", f.mime).header("x-content-type-options", "nosniff")
      .header("content-disposition", `attachment; filename="document"; filename*=UTF-8''${encodeURIComponent(f.filename)}`)
      .header("cache-control", "private, no-store").send(f.content);
  });

  app.post("/document-revisions/:id/review", { preHandler: requireTenant("documents.review") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ code: z.enum(["A", "B", "C", "D"]), reviewedOn: date, reviewer: optText(120), comments: optText(1000) }).parse(req.body);
    if (b.reviewedOn > today()) throw badRequest("تاريخ المراجعة لا يكون في المستقبل");
    if (b.code !== "A" && !b.comments) throw badRequest("اكتب ملاحظات الاستشاري");
    await tenantTx(req, async (db) => {
      const r = (await db.query<{ uploaded: string }>("SELECT (created_at AT TIME ZONE 'Asia/Riyadh')::date::text AS uploaded FROM document_revisions WHERE id = $1", [id])).rows[0];
      if (!r) throw notFound();
      if (b.reviewedOn < r.uploaded) throw badRequest("تاريخ المراجعة قبل رفع الإصدار");
      try {
        await db.query("INSERT INTO document_reviews (tenant_id, revision_id, code, reviewed_on, reviewer, comments, recorded_by) VALUES (app_tenant_id(), $1, $2, $3, $4, $5, app_user_id())",
          [id, b.code, b.reviewedOn, b.reviewer, b.comments]);
      } catch (x) { if ((x as { code?: string }).code === "23505") throw conflict("رُوجع هذا الإصدار من قبل: المراجعة الجديدة تكون لإصدار جديد", "duplicate"); throw x; }
      await auditTenant(db, req, "document.reviewed", "document_revision", id, { code: b.code });
    });
    return { ok: true };
  });

  // ── Transmittals ──────────────────────────────────────────────────────────────────────────
  app.get("/projects/:id/transmittals", { preHandler: requireTenant("documents.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => ({
      items: (await db.query(
        `SELECT t.id, t.number, t.recipient, t.purpose, t.sent_on::text AS "sentOn", t.notes,
                coalesce(json_agg(json_build_object('document', d.number, 'title', d.title, 'revision', r.revision) ORDER BY d.number) FILTER (WHERE r.id IS NOT NULL), '[]') AS items
           FROM transmittals t LEFT JOIN transmittal_items ti ON ti.transmittal_id = t.id LEFT JOIN document_revisions r ON r.id = ti.revision_id
           LEFT JOIN project_documents d ON d.id = r.document_id
          WHERE t.project_id = $1 GROUP BY t.id ORDER BY t.number DESC LIMIT 500`, [id])).rows,
    }), { readOnly: true });
  });

  app.post("/projects/:id/transmittals", { preHandler: requireTenant("documents.transmit") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ recipient: z.string().trim().min(2).max(200), purpose: z.enum(["for_approval", "for_information", "for_construction", "as_built"]), sentOn: date, notes: optText(500),
      revisionIds: z.array(z.string().uuid()).min(1, "اختر إصداراً واحداً على الأقل").max(200) }).parse(req.body);
    if (b.sentOn > today()) throw badRequest("تاريخ الإرسال لا يكون في المستقبل");
    const ids = [...new Set(b.revisionIds)];
    const out = await tenantTx(req, async (db) => {
      const ok = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM document_revisions r JOIN project_documents d ON d.id = r.document_id WHERE r.id = ANY($1::uuid[]) AND d.project_id = $2`,
        [ids, id])).rows[0]!.n;
      if (ok !== ids.length) throw badRequest("كل الإصدارات تكون من وثائق هذا المشروع");
      const late = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM document_revisions WHERE id = ANY($1::uuid[]) AND (created_at AT TIME ZONE 'Asia/Riyadh')::date > $2",
        [ids, b.sentOn])).rows[0]!.n;
      if (late) throw badRequest("تاريخ الإرسال قبل رفع بعض الإصدارات");
      if (b.purpose === "for_construction") {
        const bad = (await db.query<{ number: string }>(
          `SELECT d.number || ' ' || r.revision AS number FROM document_revisions r JOIN project_documents d ON d.id = r.document_id LEFT JOIN document_reviews v ON v.revision_id = r.id
            WHERE r.id = ANY($1::uuid[]) AND d.doc_type IN ('shop_drawing', 'material_submittal', 'method_statement') AND coalesce(v.code, '') NOT IN ('A', 'B')`, [ids])).rows;
        if (bad.length) throw conflict(`لا يُرسل للتنفيذ ما لم يعتمده الاستشاري (A أو B): ${bad.map((x) => x.number).join("، ")}`, "not_approved");
      }
      const n = (await db.query<{ n: string }>("SELECT next_counter('transmittal')::text AS n")).rows[0]!.n;
      const t = (await db.query<{ id: string }>("INSERT INTO transmittals (tenant_id, project_id, number, recipient, purpose, sent_on, notes, created_by) VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, app_user_id()) RETURNING id",
        [id, n, b.recipient, b.purpose, b.sentOn, b.notes])).rows[0]!;
      for (const r of ids) await db.query("INSERT INTO transmittal_items (tenant_id, transmittal_id, revision_id) VALUES (app_tenant_id(), $1, $2)", [t.id, r]);
      await auditTenant(db, req, "document.transmittal", "transmittal", t.id, { number: n, revisions: ids.length });
      return { id: t.id, number: Number(n) };
    });
    return reply.status(201).send(out);
  });

  // ── Daily site reports ────────────────────────────────────────────────────────────────────
  app.get("/daily-reports", { preHandler: requireTenant("daily_reports.view") }, async (req) => {
    const q = z.object({ projectId: z.string().uuid(), from: date.optional(), to: date.optional() }).parse(req.query);
    return tenantTx(req, async (db) => ({
      items: (await db.query(
        `SELECT d.id, d.report_date::text AS "reportDate", d.weather, d.temperature::float8 AS temperature, d.status, d.submitted_at AS "submittedAt",
                coalesce((SELECT sum(headcount) FROM daily_report_manpower m WHERE m.report_id = d.id), 0)::int AS headcount,
                coalesce((SELECT sum(headcount * hours) FROM daily_report_manpower m WHERE m.report_id = d.id), 0)::float8 AS manhours,
                coalesce((SELECT sum(working_hours) FROM daily_report_equipment e WHERE e.report_id = d.id), 0)::float8 AS "equipmentHours"
           FROM daily_reports d WHERE d.project_id = $1 AND d.report_date BETWEEN coalesce($2::date, '2000-01-01') AND coalesce($3::date, '2999-12-31')
          ORDER BY d.report_date DESC LIMIT 400`, [q.projectId, q.from ?? null, q.to ?? null])).rows,
    }), { readOnly: true });
  });

  app.get("/projects/:id/daily-reports/:date", { preHandler: requireTenant("daily_reports.view") }, async (req) => {
    const { id, date: day } = req.params as { id: string; date: string };
    if (!isUuid(id) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw notFound();
    return tenantTx(req, async (db) => {
      const d = (await db.query<{ id: string; submittedById: string | null }>(
        `SELECT d.id, d.report_date::text AS "reportDate", d.weather, d.temperature::float8 AS temperature, d.work_done AS "workDone", d.issues, d.status,
                d.submitted_at AS "submittedAt", d.submitted_by AS "submittedById"
           FROM daily_reports d WHERE d.project_id = $1 AND d.report_date = $2`, [id, day])).rows[0];
      if (!d) return { report: null };
      const manpower = (await db.query(`SELECT m.trade, m.supplier_id AS "supplierId", s.name AS supplier, m.headcount, m.hours::float8 AS hours
                                          FROM daily_report_manpower m LEFT JOIN suppliers s ON s.id = m.supplier_id WHERE m.report_id = $1 ORDER BY m.trade`, [d.id])).rows;
      const equipment = (await db.query(`SELECT e.machine_id AS "machineId", e.description, e.working_hours::float8 AS "workingHours", e.idle_hours::float8 AS "idleHours"
                                           FROM daily_report_equipment e WHERE e.report_id = $1 ORDER BY e.description`, [d.id])).rows;
      const { submittedById, ...rest } = d;
      return { report: { ...rest, submittedBy: (await memberNames(req.tenant!.id, [submittedById])).get(submittedById ?? "") ?? null, manpower, equipment } };
    }, { readOnly: true });
  });

  /** Saves the day's draft (the lines are replaced). A submitted report does not change. */
  app.put("/projects/:id/daily-reports/:date", { preHandler: requireTenant("daily_reports.write") }, async (req) => {
    const { id, date: day } = req.params as { id: string; date: string };
    if (!isUuid(id) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw notFound();
    if (day > today()) throw badRequest("التقرير اليومي ليوم مضى أو اليوم");
    const b = z.object({
      weather: z.enum(["clear", "hot", "windy", "dust", "rain"]).nullable().optional().transform((v) => v ?? null),
      temperature: z.number().min(-10).max(60).nullable().optional().transform((v) => v ?? null),
      workDone: optText(4000), issues: optText(2000),
      manpower: z.array(z.object({ trade: z.string().trim().min(2).max(80), supplierId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
        headcount: z.number().int().min(1).max(5000), hours: z.number().positive().max(16) })).max(100),
      equipment: z.array(z.object({ machineId: z.string().uuid().nullable().optional().transform((v) => v ?? null), description: z.string().trim().min(2).max(120),
        workingHours: z.number().min(0).max(24), idleHours: z.number().min(0).max(24) }).refine((e) => e.workingHours + e.idleHours <= 24, "ساعات المعدة في اليوم لا تتجاوز 24")).max(100),
    }).parse(req.body);
    return tenantTx(req, async (db) => {
      await projectOpen(db, id);
      const existing = (await db.query<{ id: string; status: string }>("SELECT id, status FROM daily_reports WHERE project_id = $1 AND report_date = $2 FOR UPDATE", [id, day])).rows[0];
      if (existing?.status === "submitted") throw conflict("التقرير مُقدَّم ولا يُعدَّل", "daily_report_final");
      const rid = existing?.id ?? (await db.query<{ id: string }>("INSERT INTO daily_reports (tenant_id, project_id, report_date, created_by) VALUES (app_tenant_id(), $1, $2, app_user_id()) RETURNING id", [id, day])).rows[0]!.id;
      await db.query("UPDATE daily_reports SET weather = $2, temperature = $3, work_done = $4, issues = $5 WHERE id = $1", [rid, b.weather, b.temperature, b.workDone, b.issues]);
      await db.query("DELETE FROM daily_report_manpower WHERE report_id = $1", [rid]);
      await db.query("DELETE FROM daily_report_equipment WHERE report_id = $1", [rid]);
      for (const m of b.manpower) await db.query("INSERT INTO daily_report_manpower (tenant_id, report_id, trade, supplier_id, headcount, hours) VALUES (app_tenant_id(), $1, $2, $3, $4, $5)", [rid, m.trade, m.supplierId, m.headcount, m.hours]);
      for (const e of b.equipment) await db.query("INSERT INTO daily_report_equipment (tenant_id, report_id, machine_id, description, working_hours, idle_hours) VALUES (app_tenant_id(), $1, $2, $3, $4, $5)", [rid, e.machineId, e.description, e.workingHours, e.idleHours]);
      return { id: rid };
    });
  });

  app.post("/daily-reports/:id/submit", { preHandler: requireTenant("daily_reports.submit") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    await tenantTx(req, async (db) => {
      const d = (await db.query<{ status: string; work_done: string | null; lines: number }>(
        "SELECT status, work_done, (SELECT count(*)::int FROM daily_report_manpower WHERE report_id = $1) AS lines FROM daily_reports WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!d) throw notFound();
      if (d.status === "submitted") throw conflict("التقرير مُقدَّم من قبل", "daily_report_final");
      if (!d.work_done || !d.lines) throw badRequest("اكتب الأعمال المنفذة وسجّل العمالة قبل تقديم التقرير");
      await db.query("UPDATE daily_reports SET status = 'submitted', submitted_by = app_user_id(), submitted_at = now() WHERE id = $1", [id]);
      await auditTenant(db, req, "daily_report.submitted", "daily_report", id);
    });
    return { ok: true };
  });
}
