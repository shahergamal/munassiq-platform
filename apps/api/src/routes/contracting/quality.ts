import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../../db/pool.ts";
import { daysLate, RECORDABLE, safetyRates } from "../../lib/contracting/siteQuality.ts";
import { AppError, badRequest, notFound } from "../../lib/errors.ts";
import { isoDate } from "../../lib/calendar.ts";
import { auditTenant, isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";
import { today } from "../restaurants/batches.ts";
import { projectOpen } from "./site.ts";

// Quality and safety on site (docs/contracting/ARCHITECTURE.md, C10): the ITP, inspection requests for work (WIR)
// and materials (MIR) with the consultant's result, NCRs, RFIs linked to the variation or claim they led to,
// incidents and permits to work. The safety rates are measured on the man-hours of the submitted daily reports.

const date = isoDate;
const optUuid = z.string().uuid().nullable().optional().transform((v) => v ?? null);
const optText = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => v || null);
const conflict = (m: string, code = "invalid_state") => new AppError(409, code, m);
const notFuture = (d: string | null | undefined, what: string) => { if (d && d > today()) throw badRequest(`${what} لا يكون في المستقبل`); };

async function belongs(db: Db, projectId: string, refs: { wbsId?: string | null; boqItemId?: string | null; itpItemId?: string | null }) {
  if (refs.wbsId && !(await db.query("SELECT 1 FROM wbs_nodes WHERE id = $1 AND project_id = $2", [refs.wbsId, projectId])).rowCount) throw badRequest("عنصر WBS ليس من هذا المشروع");
  if (refs.itpItemId && !(await db.query("SELECT 1 FROM itp_items WHERE id = $1 AND project_id = $2 AND is_active", [refs.itpItemId, projectId])).rowCount) throw badRequest("بند خطة الفحص ليس من هذا المشروع");
  if (refs.boqItemId && !(await db.query(`SELECT 1 FROM boq_items i JOIN boq_versions v ON v.id = i.version_id JOIN contracts c ON c.id = v.contract_id
                                            WHERE i.id = $1 AND c.project_id = $2`, [refs.boqItemId, projectId])).rowCount) throw badRequest("البند ليس من جداول كميات هذا المشروع");
}

const KIND_INCIDENT = ["near_miss", "first_aid", "medical_treatment", "lost_time", "fatality", "property_damage", "environmental"] as const;
const PERMIT = ["hot_work", "confined_space", "work_at_height", "excavation", "electrical", "lifting"] as const;
const DISCIPLINE = ["architectural", "structural", "mep", "civil", "general"] as const;

export default async function qualityRoutes(app: FastifyInstance) {
  // ── ITP ───────────────────────────────────────────────────────────────────────────────────
  app.get("/projects/:id/itp", { preHandler: requireTenant("quality.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => ({
      items: (await db.query(
        `SELECT t.id, t.activity, t.point, t.reference, t.criteria, t.frequency, t.is_active AS "isActive",
                (SELECT count(*)::int FROM inspection_requests r WHERE r.itp_item_id = t.id AND r.status IN ('approved', 'approved_as_noted')) AS passed,
                (SELECT count(*)::int FROM inspection_requests r WHERE r.itp_item_id = t.id AND r.status = 'submitted') AS pending
           FROM itp_items t WHERE t.project_id = $1 ORDER BY t.is_active DESC, t.activity`, [id])).rows,
    }), { readOnly: true });
  });

  const itpBody = z.object({ activity: z.string().trim().min(2).max(200), point: z.enum(["H", "W", "R"]), reference: optText(200), criteria: optText(500), frequency: optText(120) });
  app.post("/projects/:id/itp", { preHandler: requireTenant("quality.plan") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = itpBody.parse(req.body);
    const out = await tenantTx(req, async (db) => {
      await projectOpen(db, id);
      return (await db.query<{ id: string }>("INSERT INTO itp_items (tenant_id, project_id, activity, point, reference, criteria, frequency) VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6) RETURNING id",
        [id, b.activity, b.point, b.reference, b.criteria, b.frequency])).rows[0]!;
    });
    return reply.status(201).send(out);
  });

  app.put("/itp-items/:id", { preHandler: requireTenant("quality.plan") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = itpBody.extend({ isActive: z.boolean() }).parse(req.body);
    await tenantTx(req, async (db) => {
      const r = await db.query("UPDATE itp_items SET activity = $2, point = $3, reference = $4, criteria = $5, frequency = $6, is_active = $7 WHERE id = $1",
        [id, b.activity, b.point, b.reference, b.criteria, b.frequency, b.isActive]);
      if (!r.rowCount) throw notFound();
    });
    return { ok: true };
  });

  // ── Inspection requests (WIR / MIR) ───────────────────────────────────────────────────────
  app.get("/inspections", { preHandler: requireTenant("quality.view") }, async (req) => {
    const q = z.object({ projectId: z.string().uuid(), kind: z.enum(["WIR", "MIR"]).optional(), status: z.string().max(20).optional() }).parse(req.query);
    return tenantTx(req, async (db) => ({
      today: today(),
      items: (await db.query(
        `SELECT r.id, r.kind, r.number, r.description, r.location, r.requested_for::text AS "requestedFor", r.status, r.inspector, r.inspected_on::text AS "inspectedOn", r.comments,
                r.quantity::float8 AS quantity, i.name AS material, s.name AS supplier, t.activity AS "itpActivity", t.point AS "itpPoint", w.code AS wbs,
                r.reinspection_of AS "reinspectionOf", (SELECT number FROM inspection_requests p WHERE p.id = r.reinspection_of) AS "reinspectionOfNumber",
                (SELECT n.number FROM site_ncrs n WHERE n.inspection_id = r.id LIMIT 1) AS "ncrNumber"
           FROM inspection_requests r LEFT JOIN ingredients i ON i.id = r.ingredient_id LEFT JOIN suppliers s ON s.id = r.supplier_id
           LEFT JOIN itp_items t ON t.id = r.itp_item_id LEFT JOIN wbs_nodes w ON w.id = r.wbs_id
          WHERE r.project_id = $1 AND ($2::text IS NULL OR r.kind = $2) AND ($3::text IS NULL OR r.status = $3)
          ORDER BY r.status = 'submitted' DESC, r.requested_for DESC, r.number DESC LIMIT 500`, [q.projectId, q.kind ?? null, q.status ?? null])).rows,
    }), { readOnly: true });
  });

  app.post("/inspections", { preHandler: requireTenant("quality.record") }, async (req, reply) => {
    const b = z.object({ projectId: z.string().uuid(), kind: z.enum(["WIR", "MIR"]), itpItemId: optUuid, wbsId: optUuid, boqItemId: optUuid, ingredientId: optUuid, supplierId: optUuid,
      quantity: z.number().positive().max(1e9).nullable().optional().transform((v) => v ?? null), location: optText(200), description: z.string().trim().min(3).max(1000),
      requestedFor: date, reinspectionOf: optUuid }).parse(req.body);
    if (b.kind === "MIR" && !b.ingredientId) throw badRequest("طلب فحص المواد يحتاج المادة");
    const out = await tenantTx(req, async (db) => {
      await projectOpen(db, b.projectId);
      await belongs(db, b.projectId, b);
      if (b.reinspectionOf) {
        const p = (await db.query<{ status: string; project_id: string; kind: string }>("SELECT status, project_id, kind FROM inspection_requests WHERE id = $1", [b.reinspectionOf])).rows[0];
        if (!p || p.project_id !== b.projectId || p.kind !== b.kind) throw badRequest("إعادة الفحص تكون لطلب من نفس المشروع والنوع");
        if (p.status !== "rejected") throw badRequest("إعادة الفحص تكون لطلب مرفوض");
      }
      const n = (await db.query<{ n: string }>("SELECT next_counter($1)::text AS n", [`inspection_${b.kind.toLowerCase()}`])).rows[0]!.n;
      const row = (await db.query<{ id: string }>(
        `INSERT INTO inspection_requests (tenant_id, project_id, kind, number, itp_item_id, wbs_id, boq_item_id, ingredient_id, supplier_id, quantity, location, description, requested_for, reinspection_of, created_by)
         VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, app_user_id()) RETURNING id`,
        [b.projectId, b.kind, n, b.itpItemId, b.wbsId, b.boqItemId, b.kind === "MIR" ? b.ingredientId : null, b.supplierId, b.quantity, b.location, b.description, b.requestedFor, b.reinspectionOf])).rows[0]!;
      await auditTenant(db, req, "inspection.requested", "inspection_request", row.id, { kind: b.kind, number: n });
      return { id: row.id, number: Number(n) };
    });
    return reply.status(201).send(out);
  });

  /** The consultant's result. A rejection says why and may raise an NCR in the same step. */
  app.post("/inspections/:id/result", { preHandler: requireTenant("quality.respond") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ status: z.enum(["approved", "approved_as_noted", "rejected"]), inspector: optText(120), inspectedOn: date, comments: optText(1000),
      raiseNcr: z.object({ severity: z.enum(["minor", "major"]), supplierId: optUuid }).nullable().optional().transform((v) => v ?? null) }).parse(req.body);
    notFuture(b.inspectedOn, "تاريخ الفحص");
    if (b.status !== "approved" && !b.comments) throw badRequest("اكتب ملاحظات الاستشاري أو سبب الرفض");
    if (b.raiseNcr && b.status !== "rejected") throw badRequest("تقرير عدم المطابقة يُفتح من فحص مرفوض");
    return tenantTx(req, async (db) => {
      const r = (await db.query<{ status: string; project_id: string; description: string; supplier_id: string | null; kind: string; number: string }>(
        "SELECT status, project_id, description, supplier_id, kind, number::text FROM inspection_requests WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!r) throw notFound();
      if (r.status !== "submitted") throw conflict("سُجّلت نتيجة هذا الطلب من قبل");
      await db.query("UPDATE inspection_requests SET status = $2, inspector = $3, inspected_on = $4, comments = $5, result_by = app_user_id(), result_at = now() WHERE id = $1",
        [id, b.status, b.inspector, b.inspectedOn, b.comments]);
      let ncrId: string | null = null;
      if (b.raiseNcr) {
        const n = (await db.query<{ n: string }>("SELECT next_counter('site_ncr')::text AS n")).rows[0]!.n;
        ncrId = (await db.query<{ id: string }>(
          `INSERT INTO site_ncrs (tenant_id, project_id, number, source, inspection_id, supplier_id, severity, description, created_by)
           VALUES (app_tenant_id(), $1, $2, 'inspection', $3, $4, $5, $6, app_user_id()) RETURNING id`,
          [r.project_id, n, id, b.raiseNcr.supplierId ?? r.supplier_id, b.raiseNcr.severity, `${r.kind}-${r.number}: ${b.comments}`.slice(0, 1000)])).rows[0]!.id;
      }
      await auditTenant(db, req, "inspection.result", "inspection_request", id, { status: b.status, ncr: ncrId });
      return { ok: true, ncrId };
    });
  });

  app.post("/inspections/:id/cancel", { preHandler: requireTenant("quality.record") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    await tenantTx(req, async (db) => {
      const r = await db.query("UPDATE inspection_requests SET status = 'cancelled' WHERE id = $1 AND status = 'submitted'", [id]);
      if (!r.rowCount) throw conflict("يُلغى الطلب قبل تسجيل نتيجته فقط");
      await auditTenant(db, req, "inspection.cancelled", "inspection_request", id);
    });
    return { ok: true };
  });

  // ── NCRs ──────────────────────────────────────────────────────────────────────────────────
  app.get("/site-ncrs", { preHandler: requireTenant("quality.view") }, async (req) => {
    const q = z.object({ projectId: z.string().uuid(), status: z.enum(["open", "closed"]).optional() }).parse(req.query);
    return tenantTx(req, async (db) => ({
      items: (await db.query(
        `SELECT n.id, n.number, n.source, n.severity, n.description, n.disposition, n.root_cause AS "rootCause", n.corrective_action AS "correctiveAction",
                n.cost_estimate::float8 AS "costEstimate", n.status, n.created_at AS "createdAt", n.closed_at AS "closedAt", s.name AS supplier, n.supplier_id AS "supplierId",
                (SELECT kind || '-' || number FROM inspection_requests r WHERE r.id = n.inspection_id) AS inspection
           FROM site_ncrs n LEFT JOIN suppliers s ON s.id = n.supplier_id
          WHERE n.project_id = $1 AND ($2::text IS NULL OR n.status = $2) ORDER BY n.status = 'open' DESC, n.number DESC LIMIT 500`, [q.projectId, q.status ?? null])).rows,
    }), { readOnly: true });
  });

  app.post("/site-ncrs", { preHandler: requireTenant("quality.record") }, async (req, reply) => {
    const b = z.object({ projectId: z.string().uuid(), source: z.enum(["internal_audit", "client", "consultant"]), severity: z.enum(["minor", "major"]), supplierId: optUuid,
      description: z.string().trim().min(5).max(1000) }).parse(req.body);
    const out = await tenantTx(req, async (db) => {
      await projectOpen(db, b.projectId);
      const n = (await db.query<{ n: string }>("SELECT next_counter('site_ncr')::text AS n")).rows[0]!.n;
      const row = (await db.query<{ id: string }>("INSERT INTO site_ncrs (tenant_id, project_id, number, source, supplier_id, severity, description, created_by) VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, app_user_id()) RETURNING id",
        [b.projectId, n, b.source, b.supplierId, b.severity, b.description])).rows[0]!;
      await auditTenant(db, req, "ncr.opened", "site_ncr", row.id, { number: n });
      return { id: row.id, number: Number(n) };
    });
    return reply.status(201).send(out);
  });

  app.put("/site-ncrs/:id", { preHandler: requireTenant("quality.record") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ disposition: z.enum(["rework", "repair", "use_as_is", "reject"]).nullable().optional().transform((v) => v ?? null), rootCause: optText(1000),
      correctiveAction: optText(1000), costEstimate: z.number().min(0).max(1e11).nullable().optional().transform((v) => v ?? null), supplierId: optUuid }).parse(req.body);
    await tenantTx(req, async (db) => {
      const r = await db.query(`UPDATE site_ncrs SET disposition = $2, root_cause = $3, corrective_action = $4, cost_estimate = $5, supplier_id = $6 WHERE id = $1 AND status = 'open'`,
        [id, b.disposition, b.rootCause, b.correctiveAction, b.costEstimate, b.supplierId]);
      if (!r.rowCount) throw conflict("التقرير مغلق أو غير موجود");
    });
    return { ok: true };
  });

  app.post("/site-ncrs/:id/close", { preHandler: requireTenant("quality.close") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    await tenantTx(req, async (db) => {
      const n = (await db.query<{ status: string; disposition: string | null; corrective_action: string | null; created_by: string }>(
        "SELECT status, disposition, corrective_action, created_by FROM site_ncrs WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!n) throw notFound();
      if (n.status !== "open") throw conflict("التقرير مغلق من قبل");
      if (!n.disposition || !n.corrective_action) throw badRequest("حدد المعالجة والإجراء التصحيحي قبل الإغلاق");
      await db.query("UPDATE site_ncrs SET status = 'closed', closed_by = app_user_id(), closed_at = now() WHERE id = $1", [id]);
      await auditTenant(db, req, "ncr.closed", "site_ncr", id);
    });
    return { ok: true };
  });

  // ── RFIs ──────────────────────────────────────────────────────────────────────────────────
  app.get("/rfis", { preHandler: requireTenant("quality.view") }, async (req) => {
    const q = z.object({ projectId: z.string().uuid(), status: z.enum(["open", "answered", "closed"]).optional() }).parse(req.query);
    return tenantTx(req, async (db) => {
      const t = today();
      const rows = (await db.query<{ requiredBy: string | null; status: string }>(
        `SELECT f.id, f.number, f.subject, f.question, f.discipline, f.required_by::text AS "requiredBy", f.status, f.answer, f.answered_on::text AS "answeredOn", f.impact,
                f.variation_id AS "variationId", v.number AS "variationNumber", f.claim_id AS "claimId", c.number AS "claimNumber"
           FROM rfis f LEFT JOIN variations v ON v.id = f.variation_id LEFT JOIN claims c ON c.id = f.claim_id
          WHERE f.project_id = $1 AND ($2::text IS NULL OR f.status = $2) ORDER BY f.status = 'open' DESC, f.number DESC LIMIT 500`, [q.projectId, q.status ?? null])).rows;
      return { items: rows.map((r) => ({ ...r, daysLate: r.status === "open" ? daysLate(r.requiredBy, t) : 0 })) };
    }, { readOnly: true });
  });

  app.post("/rfis", { preHandler: requireTenant("quality.record") }, async (req, reply) => {
    const b = z.object({ projectId: z.string().uuid(), subject: z.string().trim().min(3).max(200), question: z.string().trim().min(5).max(2000), discipline: z.enum(DISCIPLINE),
      requiredBy: date.nullable().optional().transform((v) => v ?? null) }).parse(req.body);
    const out = await tenantTx(req, async (db) => {
      await projectOpen(db, b.projectId);
      const n = (await db.query<{ n: string }>("SELECT next_counter('rfi')::text AS n")).rows[0]!.n;
      const row = (await db.query<{ id: string }>("INSERT INTO rfis (tenant_id, project_id, number, subject, question, discipline, required_by, created_by) VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, app_user_id()) RETURNING id",
        [b.projectId, n, b.subject, b.question, b.discipline, b.requiredBy])).rows[0]!;
      await auditTenant(db, req, "rfi.raised", "rfi", row.id, { number: n });
      return { id: row.id, number: Number(n) };
    });
    return reply.status(201).send(out);
  });

  app.post("/rfis/:id/answer", { preHandler: requireTenant("quality.respond") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ answer: z.string().trim().min(2).max(2000), answeredOn: date, impact: z.enum(["none", "cost", "time", "cost_time"]) }).parse(req.body);
    notFuture(b.answeredOn, "تاريخ الرد");
    await tenantTx(req, async (db) => {
      const r = await db.query("UPDATE rfis SET status = 'answered', answer = $2, answered_on = $3, impact = $4 WHERE id = $1 AND status = 'open'", [id, b.answer, b.answeredOn, b.impact]);
      if (!r.rowCount) throw conflict("الاستفسار ليس مفتوحاً");
      await auditTenant(db, req, "rfi.answered", "rfi", id, { impact: b.impact });
    });
    return { ok: true };
  });

  /** An answer that changes cost or time is followed by a variation or a claim on one of the project's contracts. */
  app.post("/rfis/:id/link", { preHandler: requireTenant("quality.record") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ variationId: optUuid, claimId: optUuid }).refine((x) => Boolean(x.variationId) !== Boolean(x.claimId), "اختر أمر تغيير أو مطالبة").parse(req.body);
    await tenantTx(req, async (db) => {
      const f = (await db.query<{ project_id: string; status: string; impact: string | null }>("SELECT project_id, status, impact FROM rfis WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!f) throw notFound();
      if (f.status === "open" || f.impact === "none") throw conflict("يُربط الاستفسار بعد الرد عليه وحين يغيّر التكلفة أو المدة");
      const table = b.variationId ? "variations" : "claims";
      const ok = await db.query(`SELECT 1 FROM ${table} x JOIN contracts c ON c.id = x.contract_id WHERE x.id = $1 AND c.project_id = $2`, [b.variationId ?? b.claimId, f.project_id]);
      if (!ok.rowCount) throw badRequest(b.variationId ? "أمر التغيير ليس من عقود هذا المشروع" : "المطالبة ليست من عقود هذا المشروع");
      await db.query(`UPDATE rfis SET ${b.variationId ? "variation_id" : "claim_id"} = $2 WHERE id = $1`, [id, b.variationId ?? b.claimId]);
      await auditTenant(db, req, "rfi.linked", "rfi", id, b);
    });
    return { ok: true };
  });

  app.post("/rfis/:id/close", { preHandler: requireTenant("quality.record") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    await tenantTx(req, async (db) => {
      const r = await db.query("UPDATE rfis SET status = 'closed' WHERE id = $1 AND status = 'answered'", [id]);
      if (!r.rowCount) throw conflict("يُغلق الاستفسار بعد الرد عليه");
    });
    return { ok: true };
  });

  app.get("/projects/:id/quality-summary", { preHandler: requireTenant("quality.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const s = (await db.query<{ pending: number; decided: number; first_pass: number; open_ncrs: number; major_ncrs: number; open_rfis: number; overdue_rfis: number }>(
        `SELECT (SELECT count(*)::int FROM inspection_requests WHERE project_id = $1 AND status = 'submitted') AS pending,
                (SELECT count(*)::int FROM inspection_requests WHERE project_id = $1 AND reinspection_of IS NULL AND status IN ('approved', 'approved_as_noted', 'rejected')) AS decided,
                (SELECT count(*)::int FROM inspection_requests WHERE project_id = $1 AND reinspection_of IS NULL AND status IN ('approved', 'approved_as_noted')) AS first_pass,
                (SELECT count(*)::int FROM site_ncrs WHERE project_id = $1 AND status = 'open') AS open_ncrs,
                (SELECT count(*)::int FROM site_ncrs WHERE project_id = $1 AND status = 'open' AND severity = 'major') AS major_ncrs,
                (SELECT count(*)::int FROM rfis WHERE project_id = $1 AND status = 'open') AS open_rfis,
                (SELECT count(*)::int FROM rfis WHERE project_id = $1 AND status = 'open' AND required_by < $2) AS overdue_rfis`, [id, today()])).rows[0]!;
      return { pendingInspections: s.pending, firstPassRate: s.decided ? Math.round((s.first_pass / s.decided) * 1000) / 10 : null, openNcrs: s.open_ncrs, majorNcrs: s.major_ncrs,
        openRfis: s.open_rfis, overdueRfis: s.overdue_rfis };
    }, { readOnly: true });
  });

  // ── Safety ────────────────────────────────────────────────────────────────────────────────
  app.get("/hse/incidents", { preHandler: requireTenant("hse.view") }, async (req) => {
    const q = z.object({ projectId: z.string().uuid() }).parse(req.query);
    return tenantTx(req, async (db) => ({
      items: (await db.query(
        `SELECT i.id, i.number, i.occurred_at AS "occurredAt", i.kind, i.description, i.location, i.lost_days AS "lostDays", i.immediate_action AS "immediateAction",
                i.root_cause AS "rootCause", i.reported_to_authority_on::text AS "reportedToAuthorityOn", i.status, e.name AS employee, s.name AS supplier
           FROM hse_incidents i LEFT JOIN employees e ON e.id = i.employee_id LEFT JOIN suppliers s ON s.id = i.supplier_id
          WHERE i.project_id = $1 ORDER BY i.occurred_at DESC LIMIT 500`, [q.projectId])).rows,
    }), { readOnly: true });
  });

  app.post("/hse/incidents", { preHandler: requireTenant("hse.record") }, async (req, reply) => {
    const b = z.object({ projectId: z.string().uuid(), occurredAt: z.string().datetime({ offset: true }), kind: z.enum(KIND_INCIDENT), description: z.string().trim().min(5).max(2000),
      location: optText(200), employeeId: optUuid, supplierId: optUuid, lostDays: z.number().int().min(0).max(3650).default(0), immediateAction: optText(1000) }).parse(req.body);
    if (Date.parse(b.occurredAt) > Date.now() + 60_000) throw badRequest("وقت الحادث لا يكون في المستقبل");
    if (b.kind !== "lost_time" && b.lostDays) throw badRequest("أيام الغياب للإصابة المضيعة للوقت فقط");
    const out = await tenantTx(req, async (db) => {
      if (!(await db.query("SELECT 1 FROM projects WHERE id = $1", [b.projectId])).rowCount) throw notFound("المشروع غير موجود");
      const n = (await db.query<{ n: string }>("SELECT next_counter('hse_incident')::text AS n")).rows[0]!.n;
      const row = (await db.query<{ id: string }>(
        `INSERT INTO hse_incidents (tenant_id, project_id, number, occurred_at, kind, description, location, employee_id, supplier_id, lost_days, immediate_action, created_by)
         VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, app_user_id()) RETURNING id`,
        [b.projectId, n, b.occurredAt, b.kind, b.description, b.location, b.employeeId, b.supplierId, b.lostDays, b.immediateAction])).rows[0]!;
      await auditTenant(db, req, "hse.incident", "hse_incident", row.id, { kind: b.kind });
      return { id: row.id, number: Number(n) };
    });
    return reply.status(201).send(out);
  });

  app.put("/hse/incidents/:id", { preHandler: requireTenant("hse.record") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ lostDays: z.number().int().min(0).max(3650), immediateAction: optText(1000), rootCause: optText(1000),
      reportedToAuthorityOn: date.nullable().optional().transform((v) => v ?? null) }).parse(req.body);
    notFuture(b.reportedToAuthorityOn, "تاريخ الإبلاغ");
    await tenantTx(req, async (db) => {
      const r = await db.query(`UPDATE hse_incidents SET lost_days = CASE WHEN kind = 'lost_time' THEN $2 ELSE 0 END, immediate_action = $3, root_cause = $4, reported_to_authority_on = $5
                                 WHERE id = $1 AND status = 'open'`, [id, b.lostDays, b.immediateAction, b.rootCause, b.reportedToAuthorityOn]);
      if (!r.rowCount) throw conflict("الحادث مغلق أو غير موجود");
    });
    return { ok: true };
  });

  app.post("/hse/incidents/:id/close", { preHandler: requireTenant("hse.record") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    await tenantTx(req, async (db) => {
      const i = (await db.query<{ status: string; root_cause: string | null }>("SELECT status, root_cause FROM hse_incidents WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!i) throw notFound();
      if (i.status !== "open") throw conflict("الحادث مغلق من قبل");
      if (!i.root_cause) throw badRequest("سجّل السبب الجذري قبل إغلاق الحادث");
      await db.query("UPDATE hse_incidents SET status = 'closed', closed_at = now() WHERE id = $1", [id]);
      await auditTenant(db, req, "hse.incident_closed", "hse_incident", id);
    });
    return { ok: true };
  });

  app.get("/work-permits", { preHandler: requireTenant("hse.view") }, async (req) => {
    const q = z.object({ projectId: z.string().uuid(), status: z.enum(["active", "closed", "cancelled"]).optional() }).parse(req.query);
    return tenantTx(req, async (db) => ({
      items: (await db.query(
        `SELECT w.id, w.number, w.kind, w.location, w.description, w.precautions, w.valid_from AS "validFrom", w.valid_to AS "validTo", w.status, s.name AS supplier,
                (w.status = 'active' AND w.valid_to < now()) AS expired
           FROM work_permits w LEFT JOIN suppliers s ON s.id = w.supplier_id
          WHERE w.project_id = $1 AND ($2::text IS NULL OR w.status = $2) ORDER BY w.status = 'active' DESC, w.valid_from DESC LIMIT 500`, [q.projectId, q.status ?? null])).rows,
    }), { readOnly: true });
  });

  app.post("/work-permits", { preHandler: requireTenant("hse.permits") }, async (req, reply) => {
    const b = z.object({ projectId: z.string().uuid(), kind: z.enum(PERMIT), location: z.string().trim().min(2).max(200), description: z.string().trim().min(3).max(1000),
      precautions: optText(1000), supplierId: optUuid, validFrom: z.string().datetime({ offset: true }), validTo: z.string().datetime({ offset: true }) }).parse(req.body);
    const from = Date.parse(b.validFrom), to = Date.parse(b.validTo);
    if (!(to > from)) throw badRequest("نهاية التصريح بعد بدايته");
    if (to - from > 7 * 86_400_000) throw badRequest("التصريح لا يتجاوز سبعة أيام: يُجدَّد بتصريح جديد");
    if (to < Date.now()) throw badRequest("التصريح منتهٍ قبل إصداره");
    if (["hot_work", "confined_space"].includes(b.kind) && !b.precautions) throw badRequest("اكتب الاحتياطات: فحص الغاز، طفاية، مراقب، وما يلزم");
    const out = await tenantTx(req, async (db) => {
      await projectOpen(db, b.projectId);
      const n = (await db.query<{ n: string }>("SELECT next_counter('work_permit')::text AS n")).rows[0]!.n;
      const row = (await db.query<{ id: string }>(
        `INSERT INTO work_permits (tenant_id, project_id, number, kind, location, description, precautions, supplier_id, valid_from, valid_to, issued_by)
         VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, app_user_id()) RETURNING id`,
        [b.projectId, n, b.kind, b.location, b.description, b.precautions, b.supplierId, b.validFrom, b.validTo])).rows[0]!;
      await auditTenant(db, req, "hse.permit", "work_permit", row.id, { kind: b.kind });
      return { id: row.id, number: Number(n) };
    });
    return reply.status(201).send(out);
  });

  app.post("/work-permits/:id/:action", { preHandler: requireTenant("hse.permits") }, async (req) => {
    const { id, action } = req.params as { id: string; action: string };
    if (!isUuid(id) || !["close", "cancel"].includes(action)) throw notFound();
    await tenantTx(req, async (db) => {
      const r = await db.query("UPDATE work_permits SET status = $2, closed_by = app_user_id(), closed_at = now() WHERE id = $1 AND status = 'active'", [id, action === "close" ? "closed" : "cancelled"]);
      if (!r.rowCount) throw conflict("التصريح ليس سارياً");
      await auditTenant(db, req, `hse.permit_${action}`, "work_permit", id);
    });
    return { ok: true };
  });

  /** The project's (or every project's) safety performance over a period: man-hours from the submitted daily reports. */
  app.get("/hse/summary", { preHandler: requireTenant("hse.view") }, async (req) => {
    const q = z.object({ projectId: z.string().uuid().optional(), from: date.optional(), to: date.optional() }).parse(req.query);
    const to = q.to ?? today();
    const from = q.from ?? `${to.slice(0, 4)}-01-01`;
    if (from > to) throw badRequest("بداية الفترة بعد نهايتها");
    return tenantTx(req, async (db) => {
      const p = q.projectId ?? null;
      const mh = Number((await db.query<{ v: string }>(
        `SELECT coalesce(sum(m.headcount * m.hours), 0)::text AS v FROM daily_report_manpower m JOIN daily_reports d ON d.id = m.report_id
          WHERE d.status = 'submitted' AND d.report_date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR d.project_id = $3)`, [from, to, p])).rows[0]!.v);
      const kinds = (await db.query<{ kind: string; n: number; days: number }>(
        `SELECT kind, count(*)::int AS n, coalesce(sum(lost_days), 0)::int AS days FROM hse_incidents
          WHERE (occurred_at AT TIME ZONE 'Asia/Riyadh')::date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR project_id = $3) GROUP BY kind`, [from, to, p])).rows;
      const count = (k: readonly string[]) => kinds.filter((x) => k.includes(x.kind)).reduce((a, x) => a + x.n, 0);
      const lastLti = (await db.query<{ d: string | null }>(
        `SELECT max((occurred_at AT TIME ZONE 'Asia/Riyadh')::date)::text AS d FROM hse_incidents WHERE kind IN ('lost_time', 'fatality') AND ($1::uuid IS NULL OR project_id = $1)`, [p])).rows[0]!.d;
      const permits = (await db.query<{ active: number; expired: number }>(
        `SELECT count(*) FILTER (WHERE valid_to >= now())::int AS active, count(*) FILTER (WHERE valid_to < now())::int AS expired
           FROM work_permits WHERE status = 'active' AND ($1::uuid IS NULL OR project_id = $1)`, [p])).rows[0]!;
      const lti = count(["lost_time", "fatality"]);
      return { from, to, manhours: mh, byKind: Object.fromEntries(kinds.map((k) => [k.kind, k.n])), lostDays: kinds.reduce((a, k) => a + k.days, 0),
        lostTime: lti, recordable: count(RECORDABLE), ...safetyRates({ manhours: mh, lostTime: lti, recordable: count(RECORDABLE) }),
        daysSinceLastLti: lastLti ? daysLate(lastLti, today()) : null, activePermits: permits.active, expiredOpenPermits: permits.expired };
    }, { readOnly: true });
  });
}
