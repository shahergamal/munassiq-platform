import ExcelJS from "exceljs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../../db/pool.ts";
import { postGuaranteeFee } from "../../lib/accounting/posting.ts";
import { ensureContractingAccounts } from "../../lib/contracting/accounts.ts";
import { cite, resolveParam, resolveParamIfAny, type ParamValue, type Regime } from "../../lib/contracting/params.ts";
import { checkSubcontractShare } from "../../lib/contracting/subcontract.ts";
import { AppError, badRequest, notFound } from "../../lib/errors.ts";
import { auditTenant, isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";
import { today } from "../restaurants/batches.ts";
import { cellText } from "../restaurants/import.ts";
import { idempotencyKey } from "../restaurants/purchases.ts";

// Projects, contracts, bills of quantities, WBS and bank guarantees (docs/contracting/ARCHITECTURE.md, C2).

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const date = z.string().regex(ISO, "تاريخ غير صالح");
const optDate = date.nullable().optional().transform((v) => v ?? null);
const conflict = (m: string, code = "invalid_state") => new AppError(409, code, m);
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const BOQ_HEADERS = ["الرمز", "رمز الأب", "الوصف", "الوحدة", "الكمية", "السعر", "قسم (نعم/لا)", "مبلغ مؤقت (نعم/لا)", "مرجع المواصفات"];
const MAX_BOQ_ROWS = 50_000;

/** A contract's BOQ version in force (the frozen contract version once active, else the latest draft). */
export async function currentVersion(db: Db, contractId: string) {
  return (await db.query<{ id: string; number: number; kind: string; status: string }>(
    "SELECT id, number, kind, status FROM boq_versions WHERE contract_id = $1 ORDER BY number DESC LIMIT 1", [contractId])).rows[0] ?? null;
}

interface BoqRow { id: string; parent_id: string | null; code: string; description: string; is_section: boolean; unit: string | null; quantity: number; rate: number;
  is_provisional: boolean; is_prime_cost: boolean; is_daywork: boolean; spec_ref: string | null; sort: number }
/** Items of a version with each leaf's amount and each section's total (sum of its subtree), in halalas. */
export async function boqTree(db: Db, versionId: string) {
  const rows = (await db.query<BoqRow>(
    `SELECT id, parent_id, code, description, is_section, unit, quantity::float8 AS quantity, rate::float8 AS rate, is_provisional, is_prime_cost, is_daywork, spec_ref, sort
       FROM boq_items WHERE version_id = $1 ORDER BY sort, code`, [versionId])).rows;
  const amount = new Map<string, number>();
  for (const r of rows) if (!r.is_section) amount.set(r.id, Math.round(r.quantity * r.rate * 100));
  const children = new Map<string | null, BoqRow[]>();
  for (const r of rows) children.set(r.parent_id, [...(children.get(r.parent_id) ?? []), r]);
  const total = (r: BoqRow): number => r.is_section ? (children.get(r.id) ?? []).reduce((a, c) => a + total(c), 0) : amount.get(r.id)!;
  const depth = new Map<string, number>();
  const walk = (parent: string | null, d: number): BoqRow[] => (children.get(parent) ?? []).flatMap((r) => { depth.set(r.id, d); return [r, ...walk(r.id, d + 1)]; });
  const ordered = walk(null, 0);
  return {
    items: ordered.map((r) => ({ id: r.id, parentId: r.parent_id, code: r.code, description: r.description, isSection: r.is_section, unit: r.unit, quantity: r.quantity, rate: r.rate,
      amount: total(r) / 100, depth: depth.get(r.id)!, isProvisional: r.is_provisional, isPrimeCost: r.is_prime_cost, isDaywork: r.is_daywork, specRef: r.spec_ref })),
    total: rows.filter((r) => !r.is_section).reduce((a, r) => a + amount.get(r.id)!, 0) / 100,
  };
}

/** Headline figures of a contract (SAR): BOQ, approved variations, billed, retention held, advance invoiced/recovered, delay damages. */
export async function contractFigures(db: Db, id: string) {
  const v = await currentVersion(db, id);
  const boq = v ? (await boqTree(db, v.id)).total : 0;
  const x = (await db.query<Record<string, string>>(
    `SELECT coalesce((SELECT sum(l.quantity * l.rate) FROM variation_lines l JOIN variations o ON o.id = l.variation_id WHERE o.contract_id = $1 AND o.status = 'approved'), 0)::text AS vo,
            coalesce((SELECT gross_to_date FROM ipcs WHERE contract_id = $1 AND status IN ('approved', 'invoiced') ORDER BY number DESC LIMIT 1), 0)::text AS billed,
            coalesce((SELECT sum(retention_current) FROM ipcs WHERE contract_id = $1 AND status IN ('approved', 'invoiced')), 0)::text AS retention,
            coalesce((SELECT sum(advance_recovery) FROM ipcs WHERE contract_id = $1 AND status IN ('approved', 'invoiced')), 0)::text AS recovered,
            coalesce((SELECT sum(ld_amount) FROM ipcs WHERE contract_id = $1 AND status IN ('approved', 'invoiced')), 0)::text AS ld,
            (coalesce((SELECT sum(taxable) FROM sales_documents WHERE contract_id = $1 AND kind = 'prepayment'), 0)
              + coalesce((SELECT sum(taxable) FROM subcontract_advances WHERE contract_id = $1), 0))::text AS advance,
            -- Retention that can be released: booked with the invoice (ours) or the recorded invoice (a subcontractor's), less releases.
            (coalesce((SELECT sum(retention_current) FROM ipcs WHERE contract_id = $1 AND status = 'invoiced'), 0)
              - coalesce((SELECT sum(amount) FROM retention_releases WHERE contract_id = $1), 0))::text AS releasable,
            coalesce((SELECT sum(amount) FROM retention_releases WHERE contract_id = $1), 0)::text AS released`, [id])).rows[0]!;
  const n = (k: string) => Number(x[k]);
  return { boqTotal: boq, approvedVariations: Math.round(n("vo") * 100) / 100, billedToDate: n("billed"), retentionHeld: n("retention"),
    advanceInvoiced: n("advance"), advanceRecovered: n("recovered"), ldToDate: n("ld"), retentionReleasable: n("releasable"), retentionReleased: n("released") };
}

const projectBody = z.object({
  code: z.string().trim().regex(/^[A-Za-z0-9-]{1,20}$/, "رمز المشروع حروف إنجليزية وأرقام وشرطة"),
  name: z.string().trim().min(2, "أدخل اسم المشروع").max(160),
  clientId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
  specialty: z.string().regex(/^[A-Z_]{2,30}$/, "اختر التخصص"),
  branchId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
  location: z.string().trim().max(300).nullable().optional().transform((v) => v || null),
  latitude: z.number().min(-90).max(90).nullable().optional().transform((v) => v ?? null),
  longitude: z.number().min(-180).max(180).nullable().optional().transform((v) => v ?? null),
  codeEdition: z.string().trim().max(40).nullable().optional().transform((v) => v || null),
});

const contractBody = z.object({
  projectId: z.string().uuid("اختر المشروع"),
  number: z.string().trim().min(1, "أدخل رقم العقد").max(40),
  title: z.string().trim().min(2, "أدخل عنوان العقد").max(200),
  role: z.enum(["MAIN", "SUB"]).default("MAIN"),
  customerId: z.string().uuid("اختر العميل").nullable().optional().transform((v) => v ?? null),
  supplierId: z.string().uuid("اختر مقاول الباطن").nullable().optional().transform((v) => v ?? null),
  parentContractId: z.string().uuid("اختر العقد الرئيسي").nullable().optional().transform((v) => v ?? null),
  subcontractApprovalRef: z.string().trim().min(2).max(120).nullable().optional().transform((v) => v || null),
  profile: z.string().regex(/^[A-Z0-9_]{2,30}$/, "اختر نموذج العقد"),
  pricingModel: z.enum(["LUMP_SUM", "UNIT_PRICE", "COST_PLUS", "GMP", "T_AND_M", "RATE_CARD"]),
  governingRegime: z.enum(["GTPL_1440", "GTPL_1448", "PRIVATE"]),
  governmentClient: z.boolean().default(false),
  tenderDate: optDate, signDate: optDate, siteHandoverDate: optDate, startDate: optDate,
  durationDays: z.number().int().positive().max(36500).nullable().optional().transform((v) => v ?? null),
  value: z.number().min(0).max(1e13),
  advancePct: z.number().min(0).max(100).optional(),
  retentionPct: z.number().min(0).max(100).optional(),
  retentionCapPct: z.number().min(0).max(100).optional(),
  ldRatePerDay: z.number().min(0).max(1e9).default(0),
  ldCapPct: z.number().min(0).max(100).nullable().optional().transform((v) => v ?? null),
  dlpMonths: z.number().int().min(0).max(120).optional(),
  claimNoticeDays: z.number().int().min(1).max(365).optional(),
});

export default async function projectRoutes(app: FastifyInstance) {
  // Reference data: specialties, contract forms, and the statutory values in force today (with their status).
  app.get("/contracting/reference", { preHandler: requireTenant("projects.view", "contracts.view") }, async (req) =>
    tenantTx(req, async (db) => ({
      specialties: (await db.query("SELECT code, name, definition FROM specialty_templates ORDER BY name")).rows,
      profiles: (await db.query("SELECT code, name, defaults FROM contract_profiles ORDER BY code = 'CUSTOM', name")).rows,
      parameters: (await db.query(
        `SELECT key, regime, value::float8 AS value, unit, label, legal_basis AS "legalBasis", source_title AS "sourceTitle", confidence, status,
                effective_from::text AS "effectiveFrom", effective_to::text AS "effectiveTo"
           FROM regulatory_parameters WHERE status <> 'retired' ORDER BY key, regime, effective_from`)).rows,
      costCodes: (await db.query(`SELECT id, code, name, kind, is_active AS "isActive" FROM cost_codes ORDER BY code`)).rows,
    }), { readOnly: true }));

  app.post("/cost-codes", { preHandler: requireTenant("projects.edit") }, async (req, reply) => {
    const b = z.object({ code: z.string().trim().regex(/^[A-Za-z0-9.-]{1,20}$/, "رمز غير صالح"), name: z.string().trim().min(2).max(120),
      kind: z.enum(["material", "labor", "equipment", "subcontract", "overhead"]) }).parse(req.body);
    const id = await tenantTx(req, async (db) => {
      try {
        return (await db.query<{ id: string }>("INSERT INTO cost_codes (tenant_id, code, name, kind) VALUES (app_tenant_id(), $1, $2, $3) RETURNING id", [b.code, b.name, b.kind])).rows[0]!.id;
      } catch (e) { if ((e as { code?: string }).code === "23505") throw conflict("الرمز مستخدم", "duplicate"); throw e; }
    });
    return reply.status(201).send({ id });
  });

  // ── Projects ────────────────────────────────────────────────────────────────────────────────
  app.get("/projects", { preHandler: requireTenant("projects.view") }, async (req) =>
    tenantTx(req, async (db) => ({
      items: (await db.query(
        `SELECT p.id, p.code, p.name, p.status, p.specialty, s.name AS "specialtyName", c.name AS "clientName", p.location,
                (SELECT count(*)::int FROM contracts k WHERE k.project_id = p.id AND k.role = 'MAIN') AS contracts,
                (SELECT coalesce(sum(k.value), 0)::float8 FROM contracts k WHERE k.project_id = p.id AND k.role = 'MAIN') AS "contractValue",
                (SELECT min(x.expires_on)::text FROM project_permits x WHERE x.project_id = p.id AND x.expires_on >= current_date) AS "nextPermitExpiry"
           FROM projects p JOIN specialty_templates s ON s.code = p.specialty LEFT JOIN customers c ON c.id = p.client_id ORDER BY p.status = 'closed', p.code`)).rows,
    }), { readOnly: true }));

  app.post("/projects", { preHandler: requireTenant("projects.create") }, async (req, reply) => {
    const b = projectBody.parse(req.body);
    const id = await tenantTx(req, async (db) => {
      const tpl = (await db.query<{ definition: { wbsLevels: string[] } }>("SELECT definition FROM specialty_templates WHERE code = $1", [b.specialty])).rows[0];
      if (!tpl) throw badRequest("التخصص غير موجود");
      // The project's own cost center: every posting for the project carries it.
      let cc: string;
      try {
        cc = (await db.query<{ id: string }>("INSERT INTO cost_centers (tenant_id, code, name, kind) VALUES (app_tenant_id(), $1, $2, 'project') RETURNING id", [b.code, b.name])).rows[0]!.id;
      } catch (e) { if ((e as { code?: string }).code === "23505") throw conflict(`رمز «${b.code}» مستخدم لمركز تكلفة أو مشروع`, "duplicate"); throw e; }
      const r = (await db.query<{ id: string }>(
        `INSERT INTO projects (tenant_id, code, name, client_id, specialty, cost_center_id, branch_id, location, latitude, longitude, code_edition, created_by)
         VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, app_user_id()) RETURNING id`,
        [b.code, b.name, b.clientId, b.specialty, cc, b.branchId, b.location, b.latitude, b.longitude, b.codeEdition])).rows[0]!;
      await auditTenant(db, req, "project.created", "project", r.id, { code: b.code });
      return r.id;
    });
    return reply.status(201).send({ id });
  });

  app.put("/projects/:id", { preHandler: requireTenant("projects.edit") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = projectBody.omit({ code: true, specialty: true }).extend({ status: z.enum(["planning", "active", "completed", "closed"]) }).parse(req.body);
    await tenantTx(req, async (db) => {
      if (b.status === "closed" && (await db.query("SELECT 1 FROM contracts WHERE project_id = $1 AND status = 'active'", [id])).rowCount) {
        throw conflict("للمشروع عقود مفعّلة: أكملها قبل إغلاقه");
      }
      const r = await db.query(`UPDATE projects SET name = $2, client_id = $3, branch_id = $4, location = $5, latitude = $6, longitude = $7, code_edition = $8, status = $9 WHERE id = $1`,
        [id, b.name, b.clientId, b.branchId, b.location, b.latitude, b.longitude, b.codeEdition, b.status]);
      if (!r.rowCount) throw notFound("المشروع غير موجود");
      await db.query("UPDATE cost_centers SET name = $2 WHERE id = (SELECT cost_center_id FROM projects WHERE id = $1)", [id, b.name]);
      await auditTenant(db, req, "project.updated", "project", id, { status: b.status });
    });
    return { ok: true };
  });

  app.get("/projects/:id", { preHandler: requireTenant("projects.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const p = (await db.query(
        `SELECT p.id, p.code, p.name, p.status, p.specialty, s.name AS "specialtyName", s.definition, p.client_id AS "clientId", c.name AS "clientName",
                p.branch_id AS "branchId", p.location, p.latitude::float8 AS latitude, p.longitude::float8 AS longitude, p.code_edition AS "codeEdition", p.cost_center_id AS "costCenterId"
           FROM projects p JOIN specialty_templates s ON s.code = p.specialty LEFT JOIN customers c ON c.id = p.client_id WHERE p.id = $1`, [id])).rows[0];
      if (!p) throw notFound("المشروع غير موجود");
      return {
        ...p,
        contracts: (await db.query(
          `SELECT k.id, k.number, k.title, k.role, k.status, k.value::float8 AS value, k.pricing_model AS "pricingModel", k.governing_regime AS "governingRegime",
                  coalesce(c.name, s.name) AS "customerName", pk.number AS "parentNumber"
             FROM contracts k LEFT JOIN customers c ON c.id = k.customer_id LEFT JOIN suppliers s ON s.id = k.supplier_id LEFT JOIN contracts pk ON pk.id = k.parent_contract_id
            WHERE k.project_id = $1 ORDER BY k.role, k.created_at`, [id])).rows,
        wbs: (await db.query(`SELECT id, parent_id AS "parentId", code, name FROM wbs_nodes WHERE project_id = $1 ORDER BY sort, code`, [id])).rows,
        permits: (await db.query(`SELECT id, kind, number, issuer, expires_on::text AS "expiresOn" FROM project_permits WHERE project_id = $1 ORDER BY expires_on NULLS LAST`, [id])).rows,
      };
    }, { readOnly: true });
  });

  app.post("/projects/:id/wbs", { preHandler: requireTenant("projects.edit", "boq.edit") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ parentId: z.string().uuid().nullable().optional().transform((v) => v ?? null), code: z.string().trim().min(1).max(40), name: z.string().trim().min(1).max(160) }).parse(req.body);
    const nodeId = await tenantTx(req, async (db) => {
      if (b.parentId && !(await db.query("SELECT 1 FROM wbs_nodes WHERE id = $1 AND project_id = $2", [b.parentId, id])).rowCount) throw badRequest("العنصر الأب ليس في هذا المشروع");
      try {
        return (await db.query<{ id: string }>("INSERT INTO wbs_nodes (tenant_id, project_id, parent_id, code, name) VALUES (app_tenant_id(), $1, $2, $3, $4) RETURNING id",
          [id, b.parentId, b.code, b.name])).rows[0]!.id;
      } catch (e) { if ((e as { code?: string }).code === "23505") throw conflict("رمز WBS مستخدم في المشروع", "duplicate"); throw e; }
    });
    return reply.status(201).send({ id: nodeId });
  });
  app.delete("/wbs/:id", { preHandler: requireTenant("projects.edit", "boq.edit") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    await tenantTx(req, async (db) => {
      if ((await db.query("SELECT 1 FROM journal_lines WHERE wbs_id = $1 LIMIT 1", [id])).rowCount) throw conflict("على العنصر قيود محاسبية: لا يُحذف");
      const r = await db.query("DELETE FROM wbs_nodes WHERE id = $1", [id]);
      if (!r.rowCount) throw notFound();
    });
    return { ok: true };
  });

  app.post("/projects/:id/permits", { preHandler: requireTenant("projects.edit") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ kind: z.string().trim().min(2).max(80), number: z.string().trim().min(1).max(60), issuer: z.string().trim().max(120).nullable().optional().transform((v) => v || null),
      expiresOn: optDate }).parse(req.body);
    const pid = await tenantTx(req, async (db) => (await db.query<{ id: string }>(
      "INSERT INTO project_permits (tenant_id, project_id, kind, number, issuer, expires_on) VALUES (app_tenant_id(), $1, $2, $3, $4, $5) RETURNING id",
      [id, b.kind, b.number, b.issuer, b.expiresOn])).rows[0]!.id);
    return reply.status(201).send({ id: pid });
  });
  app.delete("/permits/:id", { preHandler: requireTenant("projects.edit") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    await tenantTx(req, async (db) => { if (!(await db.query("DELETE FROM project_permits WHERE id = $1", [id])).rowCount) throw notFound(); });
    return { ok: true };
  });

  // ── Contracts ───────────────────────────────────────────────────────────────────────────────
  app.post("/contracts", { preHandler: requireTenant("contracts.create") }, async (req, reply) => {
    const b = contractBody.parse(req.body);
    if (b.role === "MAIN" && !b.customerId) throw badRequest("اختر العميل");
    if (b.role === "SUB" && (!b.supplierId || !b.parentContractId)) throw badRequest("عقد الباطن يحتاج مقاول الباطن والعقد الرئيسي");
    // A subcontract is private between us and the subcontractor, whatever governs the main contract.
    if (b.role === "SUB") b.governingRegime = "PRIVATE";
    if (b.governingRegime !== "PRIVATE" && !b.tenderDate) throw badRequest("العقد الحكومي يحتاج تاريخ طرح المنافسة: هو ما يحدد النظام الحاكم");
    const id = await tenantTx(req, async (db) => {
      const prof = (await db.query<{ defaults: { retentionPct: number; retentionCapPct: number; advancePct: number; dlpMonths: number; claimNoticeDays: number } }>(
        "SELECT defaults FROM contract_profiles WHERE code = $1", [b.profile])).rows[0];
      if (!prof) throw badRequest("نموذج العقد غير موجود");
      const d = prof.defaults;
      if (!(await db.query("SELECT 1 FROM projects WHERE id = $1", [b.projectId])).rowCount) throw notFound("المشروع غير موجود");
      try {
        const r = (await db.query<{ id: string }>(
          `INSERT INTO contracts (tenant_id, project_id, number, title, role, customer_id, profile, pricing_model, governing_regime, government_client, tender_date, sign_date,
                                  site_handover_date, start_date, duration_days, value, advance_pct, retention_pct, retention_cap_pct, ld_rate_per_day, ld_cap_pct, dlp_months,
                                  claim_notice_days, supplier_id, parent_contract_id, subcontract_approval_ref, created_by)
           VALUES (app_tenant_id(), $1, $2, $3, $22, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $23, $24, $25, app_user_id()) RETURNING id`,
          [b.projectId, b.number, b.title, b.role === "MAIN" ? b.customerId : null, b.profile, b.pricingModel, b.governingRegime, b.role === "MAIN" && b.governmentClient, b.tenderDate, b.signDate,
            b.siteHandoverDate, b.startDate, b.durationDays, b.value, b.advancePct ?? d.advancePct, b.retentionPct ?? d.retentionPct, b.retentionCapPct ?? d.retentionCapPct, b.ldRatePerDay,
            b.ldCapPct, b.dlpMonths ?? d.dlpMonths, b.claimNoticeDays ?? d.claimNoticeDays, b.role, b.role === "SUB" ? b.supplierId : null, b.role === "SUB" ? b.parentContractId : null,
            b.role === "SUB" ? b.subcontractApprovalRef : null])).rows[0]!;
        await db.query("INSERT INTO boq_versions (tenant_id, contract_id, number, kind) VALUES (app_tenant_id(), $1, 1, 'contract')", [r.id]);
        await auditTenant(db, req, "contract.created", "contract", r.id, { number: b.number, regime: b.governingRegime });
        return r.id;
      } catch (e) {
        if ((e as { code?: string }).code === "23505") throw conflict("رقم العقد مستخدم", "duplicate");
        if ((e as { message?: string }).message === "sub_of_sub") throw conflict("مقاول الباطن لا يتعاقد من الباطن: اختر عقداً رئيسياً", "sub_of_sub");
        if ((e as { message?: string }).message === "sub_other_project") throw badRequest("العقد الرئيسي من مشروع آخر");
        throw e;
      }
    });
    return reply.status(201).send({ id });
  });

  app.put("/contracts/:id", { preHandler: requireTenant("contracts.edit") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = contractBody.omit({ projectId: true, role: true, parentContractId: true }).parse(req.body);
    await tenantTx(req, async (db) => {
      const role = (await db.query<{ role: string }>("SELECT role FROM contracts WHERE id = $1", [id])).rows[0]?.role;
      if (role === "SUB") {
        const r = await db.query(
          `UPDATE contracts SET number = $2, title = $3, supplier_id = $4, profile = $5, pricing_model = $6, value = $7, advance_pct = coalesce($8, advance_pct),
                  retention_pct = coalesce($9, retention_pct), retention_cap_pct = coalesce($10, retention_cap_pct), ld_rate_per_day = $11, ld_cap_pct = $12,
                  subcontract_approval_ref = $13, sign_date = $14, start_date = $15, duration_days = $16 WHERE id = $1 AND status = 'draft'`,
          [id, b.number, b.title, b.supplierId, b.profile, b.pricingModel, b.value, b.advancePct ?? null, b.retentionPct ?? null, b.retentionCapPct ?? null, b.ldRatePerDay, b.ldCapPct,
            b.subcontractApprovalRef, b.signDate, b.startDate, b.durationDays]);
        if (!r.rowCount) throw conflict("العقد غير موجود أو مفعّل");
        await auditTenant(db, req, "contract.updated", "contract", id);
        return;
      }
      const r = await db.query(
        `UPDATE contracts SET number = $2, title = $3, customer_id = $4, profile = $5, pricing_model = $6, governing_regime = $7, government_client = $8, tender_date = $9, sign_date = $10,
                site_handover_date = $11, start_date = $12, duration_days = $13, value = $14, advance_pct = coalesce($15, advance_pct), retention_pct = coalesce($16, retention_pct),
                retention_cap_pct = coalesce($17, retention_cap_pct), ld_rate_per_day = $18, ld_cap_pct = $19, dlp_months = coalesce($20, dlp_months), claim_notice_days = coalesce($21, claim_notice_days)
          WHERE id = $1 AND status = 'draft'`,
        [id, b.number, b.title, b.customerId, b.profile, b.pricingModel, b.governingRegime, b.governmentClient, b.tenderDate, b.signDate, b.siteHandoverDate, b.startDate, b.durationDays,
          b.value, b.advancePct ?? null, b.retentionPct ?? null, b.retentionCapPct ?? null, b.ldRatePerDay, b.ldCapPct, b.dlpMonths ?? null, b.claimNoticeDays ?? null]);
      if (!r.rowCount) throw conflict("العقد غير موجود أو مفعّل (العقد المفعّل لا يُعدّل: التغيير بأمر تغيير)");
      await auditTenant(db, req, "contract.updated", "contract", id);
    });
    return { ok: true };
  });

  app.get("/contracts/:id", { preHandler: requireTenant("contracts.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const c = (await db.query(
        `SELECT k.id, k.number, k.title, k.role, k.status, k.profile, f.name AS "profileName", k.pricing_model AS "pricingModel", k.governing_regime AS "governingRegime",
                k.government_client AS "governmentClient", k.tender_date::text AS "tenderDate", k.sign_date::text AS "signDate", k.site_handover_date::text AS "siteHandoverDate",
                k.start_date::text AS "startDate", k.duration_days AS "durationDays", k.value::float8 AS value, k.advance_pct::float8 AS "advancePct", k.retention_pct::float8 AS "retentionPct",
                k.retention_cap_pct::float8 AS "retentionCapPct", k.ld_rate_per_day::float8 AS "ldRatePerDay", k.ld_cap_pct::float8 AS "ldCapPct", k.dlp_months AS "dlpMonths",
                k.claim_notice_days AS "claimNoticeDays", k.applied_params AS "appliedParams", k.activated_at AS "activatedAt",
                (SELECT i.id FROM ipcs i WHERE i.contract_id = k.id AND i.status IN ('draft', 'submitted', 'certified')) AS "openIpcId",
                EXISTS (SELECT 1 FROM ipcs i WHERE i.contract_id = k.id AND i.kind = 'final' AND i.status IN ('approved', 'invoiced')) AS "finalized",
                k.project_id AS "projectId", p.code AS "projectCode", p.name AS "projectName", p.specialty, s.definition AS "specialtyDefinition", k.customer_id AS "customerId", c.name AS "customerName",
                k.supplier_id AS "supplierId", sp.name AS "supplierName", sp.residency, sp.tax_id AS "supplierTaxId", k.parent_contract_id AS "parentContractId",
                pk.number AS "parentNumber", k.subcontract_approval_ref AS "subcontractApprovalRef"
           FROM contracts k JOIN projects p ON p.id = k.project_id JOIN specialty_templates s ON s.code = p.specialty JOIN contract_profiles f ON f.code = k.profile
           LEFT JOIN customers c ON c.id = k.customer_id LEFT JOIN suppliers sp ON sp.id = k.supplier_id LEFT JOIN contracts pk ON pk.id = k.parent_contract_id WHERE k.id = $1`, [id])).rows[0];
      if (!c) throw notFound("العقد غير موجود");
      return {
        ...c,
        // A main contract's subcontracts, with the share of its value each takes.
        subcontracts: (await db.query(
          `SELECT k.id, k.number, k.title, k.status, k.value::float8 AS value, s.name AS "supplierName", round(k.value / nullif(m.value, 0) * 100, 2)::float8 AS share
             FROM contracts k JOIN suppliers s ON s.id = k.supplier_id JOIN contracts m ON m.id = k.parent_contract_id WHERE k.parent_contract_id = $1 ORDER BY k.created_at`, [id])).rows,
        figures: await contractFigures(db, id),
        versions: (await db.query(`SELECT id, number, kind, status, created_at AS "createdAt" FROM boq_versions WHERE contract_id = $1 ORDER BY number`, [id])).rows,
        guarantees: (await db.query(
          `SELECT id, kind, number, bank, amount::float8 AS amount, issued_on::text AS "issuedOn", expires_on::text AS "expiresOn", status, fee::float8 AS fee,
                  (expires_on - current_date)::int AS "daysLeft" FROM bank_guarantees WHERE contract_id = $1 ORDER BY expires_on`, [id])).rows,
      };
    }, { readOnly: true });
  });

  /**
   * Activation: the BOQ must add up to the contract value; the BOQ version freezes; the statutory caps of the
   * governing law are resolved at the tender date and stored with their source (only verified values apply).
   */
  app.post("/contracts/:id/activate", { preHandler: requireTenant("contracts.activate") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const c = (await db.query<{ status: string; value: string; regime: Regime; tender_date: string | null; ld_rate: string; ld_cap: string | null }>(
        `SELECT status, value::text, governing_regime AS regime, tender_date::text, ld_rate_per_day::text AS ld_rate, ld_cap_pct::text AS ld_cap FROM contracts WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!c) throw notFound("العقد غير موجود");
      if (c.status !== "draft") throw conflict("العقد مفعّل من قبل");
      const v = (await currentVersion(db, id))!;
      // Locked: an item added while activating waits, then meets the frozen version (its guard reads FOR SHARE).
      await db.query("SELECT 1 FROM boq_versions WHERE id = $1 FOR UPDATE", [v.id]);
      const boq = (await boqTree(db, v.id)).total;
      if (Math.abs(boq - Number(c.value)) > 0.01) throw new AppError(422, "boq_mismatch", `مجموع جدول الكميات (${boq.toFixed(2)}) لا يساوي قيمة العقد (${Number(c.value).toFixed(2)})`);
      const applied: Record<string, ParamValue & { citation: string }> = {};
      let ldCap = c.ld_cap === null ? null : Number(c.ld_cap);
      const sub = (await db.query<{ role: string; supplier_id: string | null; parent: string | null; ref: string | null; status: string | null; residency: string | null;
        cls_expiry: string | null; cls_field: string | null; supplier: string | null }>(
        `SELECT k.role, k.supplier_id, k.parent_contract_id AS parent, k.subcontract_approval_ref AS ref, sp.status, s.residency, sp.classification_expiry::text AS cls_expiry,
                sp.classification_field AS cls_field, s.name AS supplier
           FROM contracts k LEFT JOIN suppliers s ON s.id = k.supplier_id LEFT JOIN subcontractor_profiles sp ON sp.supplier_id = k.supplier_id WHERE k.id = $1`, [id])).rows[0]!;
      if (sub.role === "SUB") {
        if (sub.status !== "approved") throw new AppError(422, "subcontractor_not_approved", `مقاول الباطن «${sub.supplier}» غير معتمد التأهيل: اعتمده من «مقاولو الباطن» أولاً`);
        if (sub.residency !== "non_resident" && (!sub.cls_field || !sub.cls_expiry || sub.cls_expiry < today())) {
          throw new AppError(422, "classification_expired", `تصنيف مقاول الباطن «${sub.supplier}» غير مسجل أو منتهٍ: حدّثه قبل الإسناد`);
        }
        // The main contract locked: two subcontracts activated at once are counted one after the other.
        const m = (await db.query<{ value: string; status: string; defaults: { subcontractApprovalPct?: number; subcontractMaxPct?: number } }>(
          "SELECT k.value::text, k.status, f.defaults FROM contracts k JOIN contract_profiles f ON f.code = k.profile WHERE k.id = $1 FOR UPDATE OF k", [sub.parent])).rows[0]!;
        if (m.status !== "active") throw conflict("فعّل العقد الرئيسي أولاً");
        const others = Number((await db.query<{ v: string }>("SELECT coalesce(sum(value), 0)::text AS v FROM contracts WHERE parent_contract_id = $1 AND id <> $2 AND status <> 'draft'",
          [sub.parent, id])).rows[0]!.v);
        const share = checkSubcontractShare({ mainValue: Math.round(Number(m.value) * 100), otherSubs: Math.round(others * 100), thisValue: Math.round(Number(c.value) * 100),
          approvalPct: m.defaults.subcontractApprovalPct ?? null, maxPct: m.defaults.subcontractMaxPct ?? null, approvalRef: sub.ref });
        if (!share.ok) throw new AppError(422, "subcontract_share", share.reason!, { share: share.share });
      }
      if (c.regime !== "PRIVATE") {
        const at = { date: c.tender_date!, regime: c.regime };
        const cap = await resolveParam(db, "delay_penalty_cap_other", at);
        applied["delay_penalty_cap_other"] = { ...cap, citation: cite(cap) };
        // The statutory cap is the ceiling; a lower agreed cap stands.
        ldCap = ldCap === null ? cap.value : Math.min(ldCap, cap.value);
        for (const key of ["vo_new_items_cap_pct", "vo_increase_consent_pct", "vo_total_increase_cap_pct", "vo_decrease_cap_pct"]) {
          const p = await resolveParamIfAny(db, key, at);
          if (p) applied[key] = { ...p, citation: cite(p) };
        }
      } else if (Number(c.ld_rate) > 0 && ldCap === null) {
        throw badRequest("حدد سقف غرامة التأخير المتفق عليه في العقد الخاص");
      }
      await db.query("UPDATE boq_versions SET status = 'frozen' WHERE id = $1", [v.id]);
      await db.query("UPDATE contracts SET status = 'active', activated_at = now(), ld_cap_pct = $2, applied_params = $3 WHERE id = $1", [id, ldCap, JSON.stringify(applied)]);
      await db.query("UPDATE projects SET status = 'active' WHERE id = (SELECT project_id FROM contracts WHERE id = $1) AND status = 'planning'", [id]);
      await auditTenant(db, req, "contract.activated", "contract", id, { params: Object.keys(applied) });
      return { ok: true, appliedParams: applied };
    });
  });

  // ── BOQ ─────────────────────────────────────────────────────────────────────────────────────
  app.get("/contracts/:id/boq", { preHandler: requireTenant("boq.view", "ipcs.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const q = req.query as { versionId?: string };
    return tenantTx(req, async (db) => {
      const v = q.versionId && isUuid(q.versionId)
        ? (await db.query<{ id: string; number: number; kind: string; status: string }>("SELECT id, number, kind, status FROM boq_versions WHERE id = $1 AND contract_id = $2", [q.versionId, id])).rows[0]
        : await currentVersion(db, id);
      if (!v) throw notFound("لا يوجد جدول كميات");
      const tree = await boqTree(db, v.id);
      const wbs = (await db.query<{ boq_item_id: string; code: string; share: number }>(
        `SELECT m.boq_item_id, w.code, m.share_pct::float8 AS share FROM boq_wbs m JOIN wbs_nodes w ON w.id = m.wbs_id JOIN boq_items i ON i.id = m.boq_item_id WHERE i.version_id = $1`, [v.id])).rows;
      return { version: v, ...tree, items: tree.items.map((i) => ({ ...i, wbs: wbs.filter((w) => w.boq_item_id === i.id).map((w) => ({ code: w.code, share: w.share })) })) };
    }, { readOnly: true });
  });

  const itemBody = z.object({
    parentId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
    code: z.string().trim().min(1, "أدخل رمز البند").max(40),
    description: z.string().trim().min(1, "أدخل الوصف").max(1000),
    isSection: z.boolean().default(false),
    unit: z.string().trim().max(20).nullable().optional().transform((v) => v || null),
    quantity: z.number().min(0).max(1e12).default(0),
    rate: z.number().min(0).max(1e12).default(0),
    isProvisional: z.boolean().default(false), isPrimeCost: z.boolean().default(false), isDaywork: z.boolean().default(false),
    specRef: z.string().trim().max(80).nullable().optional().transform((v) => v || null),
  });
  const draftVersion = async (db: Db, contractId: string) => {
    const v = await currentVersion(db, contractId);
    if (!v) throw notFound("العقد غير موجود");
    if (v.status !== "draft") throw conflict("جدول الكميات مثبت بعد تفعيل العقد: التغيير بأمر تغيير", "boq_frozen");
    return v;
  };

  app.post("/contracts/:id/boq/items", { preHandler: requireTenant("boq.edit") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = itemBody.parse(req.body);
    if (!b.isSection && !b.unit) throw badRequest("حدد وحدة البند");
    const itemId = await tenantTx(req, async (db) => {
      const v = await draftVersion(db, id);
      if (b.parentId && !(await db.query("SELECT 1 FROM boq_items WHERE id = $1 AND version_id = $2 AND is_section", [b.parentId, v.id])).rowCount) throw badRequest("الأب يجب أن يكون قسماً في نفس الجدول");
      const sort = (await db.query<{ n: number }>("SELECT coalesce(max(sort), 0)::int + 1 AS n FROM boq_items WHERE version_id = $1", [v.id])).rows[0]!.n;
      try {
        return (await db.query<{ id: string }>(
          `INSERT INTO boq_items (tenant_id, version_id, parent_id, code, description, is_section, unit, quantity, rate, is_provisional, is_prime_cost, is_daywork, spec_ref, sort)
           VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
          [v.id, b.parentId, b.code, b.description, b.isSection, b.isSection ? null : b.unit, b.isSection ? 0 : b.quantity, b.isSection ? 0 : b.rate, b.isProvisional, b.isPrimeCost, b.isDaywork, b.specRef, sort])).rows[0]!.id;
      } catch (e) { if ((e as { code?: string }).code === "23505") throw conflict(`الرمز «${b.code}» مستخدم في الجدول`, "duplicate"); throw e; }
    });
    return reply.status(201).send({ id: itemId });
  });

  app.put("/boq-items/:id", { preHandler: requireTenant("boq.edit") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = itemBody.omit({ parentId: true, isSection: true }).parse(req.body);
    await tenantTx(req, async (db) => {
      try {
        const r = await db.query(
          `UPDATE boq_items SET code = $2, description = $3, unit = CASE WHEN is_section THEN NULL ELSE $4 END, quantity = CASE WHEN is_section THEN 0 ELSE $5 END,
                  rate = CASE WHEN is_section THEN 0 ELSE $6 END, is_provisional = $7, is_prime_cost = $8, is_daywork = $9, spec_ref = $10 WHERE id = $1`,
          [id, b.code, b.description, b.unit, b.quantity, b.rate, b.isProvisional, b.isPrimeCost, b.isDaywork, b.specRef]);
        if (!r.rowCount) throw notFound("البند غير موجود");
      } catch (e) {
        if ((e as { message?: string }).message?.includes("boq_frozen")) throw conflict("جدول الكميات مثبت بعد تفعيل العقد", "boq_frozen");
        if ((e as { code?: string }).code === "23505") throw conflict("الرمز مستخدم", "duplicate");
        throw e;
      }
    });
    return { ok: true };
  });

  app.delete("/boq-items/:id", { preHandler: requireTenant("boq.edit") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    await tenantTx(req, async (db) => {
      try {
        if (!(await db.query("DELETE FROM boq_items WHERE id = $1", [id])).rowCount) throw notFound();
      } catch (e) { if ((e as { message?: string }).message?.includes("boq_frozen")) throw conflict("جدول الكميات مثبت", "boq_frozen"); throw e; }
    });
    return { ok: true };
  });

  // Where a BOQ item's value falls in the WBS (shares add up to at most 100%).
  app.put("/boq-items/:id/wbs", { preHandler: requireTenant("boq.edit") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ links: z.array(z.object({ wbsId: z.string().uuid(), sharePct: z.number().positive().max(100) })).max(20) }).parse(req.body);
    if (b.links.reduce((a, l) => a + l.sharePct, 0) > 100.0001) throw badRequest("مجموع النسب أكبر من 100%");
    await tenantTx(req, async (db) => {
      // The item's contract version must be a draft, and every WBS node must be of that contract's project.
      const it = (await db.query<{ status: string; project_id: string }>(
        `SELECT v.status, c.project_id FROM boq_items i JOIN boq_versions v ON v.id = i.version_id JOIN contracts c ON c.id = v.contract_id WHERE i.id = $1`, [id])).rows[0];
      if (!it) throw notFound("البند غير موجود");
      if (it.status !== "draft") throw conflict("جدول الكميات مثبت بعد تفعيل العقد", "boq_frozen");
      for (const l of b.links) {
        if (!(await db.query("SELECT 1 FROM wbs_nodes WHERE id = $1 AND project_id = $2", [l.wbsId, it.project_id])).rowCount) throw badRequest("عنصر WBS ليس من مشروع العقد");
      }
      await db.query("DELETE FROM boq_wbs WHERE boq_item_id = $1", [id]);
      for (const l of b.links) await db.query("INSERT INTO boq_wbs (tenant_id, boq_item_id, wbs_id, share_pct) VALUES (app_tenant_id(), $1, $2, $3)", [id, l.wbsId, l.sharePct]);
    });
    return { ok: true };
  });

  // Excel: template, export, and an atomic import that replaces the draft BOQ (every bad row reported).
  const unitsOf = async (db: Db, contractId: string) => new Set(((await db.query<{ d: { units: { code: string }[] } }>(
    "SELECT s.definition AS d FROM contracts k JOIN projects p ON p.id = k.project_id JOIN specialty_templates s ON s.code = p.specialty WHERE k.id = $1", [contractId])).rows[0]?.d.units ?? [])
    .map((u) => u.code));

  app.get("/contracts/:id/boq/export", { preHandler: requireTenant("boq.import") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const rows = await tenantTx(req, async (db) => {
      const v = await currentVersion(db, id);
      if (!v) throw notFound();
      const t = await boqTree(db, v.id);
      const code = new Map(t.items.map((i) => [i.id, i.code]));
      return t.items.map((i) => [i.code, i.parentId ? code.get(i.parentId) : "", i.description, i.unit ?? "", i.isSection ? "" : i.quantity, i.isSection ? "" : i.rate,
        i.isSection ? "نعم" : "لا", i.isProvisional ? "نعم" : "لا", i.specRef ?? ""]);
    }, { readOnly: true });
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("جدول الكميات", { views: [{ rightToLeft: true, state: "frozen", ySplit: 1 }] });
    ws.addRow(BOQ_HEADERS).font = { bold: true };
    for (const r of rows) ws.addRow(r);
    ws.columns = BOQ_HEADERS.map((_, i) => ({ width: i === 2 ? 50 : 14 }));
    return reply.header("content-type", XLSX).header("content-disposition", 'attachment; filename="boq.xlsx"').send(Buffer.from(await wb.xlsx.writeBuffer()));
  });

  app.post("/contracts/:id/boq/import", { preHandler: requireTenant("boq.import"), config: { rateLimit: { max: 20, timeWindow: "10 minutes" } } }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const file = await req.file({ limits: { fileSize: 15 * 1024 * 1024, files: 1 } });
    if (!file) throw badRequest("أرفق ملف Excel");
    const buf = await file.toBuffer();
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(buf as unknown as ArrayBuffer); } catch { throw badRequest("الملف ليس Excel صالحاً (.xlsx)"); }
    const ws = wb.worksheets[0];
    if (!ws) throw badRequest("الملف فارغ");
    if (ws.rowCount - 1 > MAX_BOQ_ROWS) throw badRequest(`الحد الأقصى ${MAX_BOQ_ROWS} صف`);
    const yes = (s: string) => ["نعم", "yes", "y", "1", "true"].includes(s.toLowerCase());
    const num = (s: string) => (s === "" ? 0 : Number(s.replace(/,/g, "")));
    const rows: { row: number; code: string; parent: string; description: string; unit: string; quantity: number; rate: number; section: boolean; provisional: boolean; spec: string }[] = [];
    ws.eachRow((r, n) => {
      if (n === 1) return;
      const c = (i: number) => cellText(r.getCell(i).value);
      if (!c(1) && !c(3)) return;
      rows.push({ row: n, code: c(1), parent: c(2), description: c(3), unit: c(4), quantity: num(c(5)), rate: num(c(6)), section: yes(c(7)), provisional: yes(c(8)), spec: c(9) });
    });
    return tenantTx(req, async (db) => {
      const v = await draftVersion(db, id);
      const units = await unitsOf(db, id);
      const errors: { row: number; message: string }[] = [];
      const codes = new Map<string, (typeof rows)[number]>();
      for (const r of rows) {
        if (!r.code) errors.push({ row: r.row, message: "الرمز مطلوب" });
        else if (codes.has(r.code)) errors.push({ row: r.row, message: `الرمز «${r.code}» مكرر` });
        else codes.set(r.code, r);
        if (!r.description) errors.push({ row: r.row, message: "الوصف مطلوب" });
        if (!Number.isFinite(r.quantity) || r.quantity < 0) errors.push({ row: r.row, message: "الكمية رقم موجب" });
        if (!Number.isFinite(r.rate) || r.rate < 0) errors.push({ row: r.row, message: "السعر رقم موجب" });
        if (!r.section && !units.has(r.unit)) errors.push({ row: r.row, message: `الوحدة «${r.unit}» ليست في قاموس وحدات التخصص (${[...units].join("، ")})` });
      }
      for (const r of rows) {
        if (!r.parent) continue;
        const p = codes.get(r.parent);
        if (!p) errors.push({ row: r.row, message: `الأب «${r.parent}» غير موجود في الملف` });
        else if (!p.section) errors.push({ row: r.row, message: `الأب «${r.parent}» ليس قسماً` });
        else if (p.row > r.row) errors.push({ row: r.row, message: `الأب «${r.parent}» يجب أن يسبق البند في الملف` });
      }
      if (errors.length) throw new AppError(422, "import_invalid", `في الملف ${errors.length} خطأ؛ لم يُستورد شيء`, { errors: errors.slice(0, 500) });
      await db.query("DELETE FROM boq_items WHERE version_id = $1", [v.id]);
      // Parents precede their children in the file: rows go in batches of up to 500, and a batch is sent before a row
      // whose parent is still in it, so every parent id is known when its children are inserted.
      const ids = new Map<string, string>();
      let pending: (typeof rows)[number][] = [];
      const flush = async () => {
        if (!pending.length) return;
        const values: unknown[] = [];
        const sql = pending.map((r, j) => {
          values.push(v.id, r.parent ? ids.get(r.parent)! : null, r.code, r.description, r.section, r.section ? null : r.unit, r.section ? 0 : r.quantity, r.section ? 0 : r.rate,
            r.provisional, r.spec || null, r.row);
          const o = j * 11;
          return `(app_tenant_id(), $${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}, $${o + 8}, $${o + 9}, $${o + 10}, $${o + 11})`;
        }).join(", ");
        const got = (await db.query<{ id: string; code: string }>(
          `INSERT INTO boq_items (tenant_id, version_id, parent_id, code, description, is_section, unit, quantity, rate, is_provisional, spec_ref, sort) VALUES ${sql} RETURNING id, code`, values)).rows;
        for (const g of got) ids.set(g.code, g.id);
        pending = [];
      };
      for (const r of rows) {
        if ((r.parent && !ids.has(r.parent)) || pending.length >= 500) await flush();
        pending.push(r);
      }
      await flush();
      const t = await boqTree(db, v.id);
      await auditTenant(db, req, "boq.imported", "contract", id, { rows: rows.length });
      return { ok: true, rows: rows.length, total: t.total };
    });
  });

  // ── Bank guarantees ─────────────────────────────────────────────────────────────────────────
  app.post("/contracts/:id/guarantees", { preHandler: requireTenant("guarantees.create") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({
      kind: z.enum(["bid", "performance", "advance", "retention"]), number: z.string().trim().min(1).max(60), bank: z.string().trim().min(2).max(120),
      amount: z.number().positive().max(1e13), issuedOn: date, expiresOn: date,
      fee: z.number().min(0).max(1e9).default(0), feePaidFrom: z.enum(["bank_transfer", "cash"]).nullable().optional().transform((v) => v ?? null),
    }).parse(req.body);
    if (b.expiresOn < b.issuedOn) throw badRequest("تاريخ الانتهاء قبل الإصدار");
    if (b.fee > 0 && !b.feePaidFrom) throw badRequest("حدد مصدر سداد العمولة");
    // The fee is posted: the request carries an Idempotency-Key and a replay returns the same guarantee.
    const key = idempotencyKey(req);
    const gid = await tenantTx(req, async (db) => {
      const dup = (await db.query<{ id: string }>("SELECT id FROM bank_guarantees WHERE idempotency_key = $1", [key])).rows[0];
      if (dup) return dup.id;
      if (!(await db.query("SELECT 1 FROM contracts WHERE id = $1", [id])).rowCount) throw notFound("العقد غير موجود");
      await ensureContractingAccounts(db);
      const r = (await db.query<{ id: string }>(
        `INSERT INTO bank_guarantees (tenant_id, contract_id, kind, number, bank, amount, issued_on, expires_on, fee, fee_paid_from, idempotency_key, created_by)
         VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, app_user_id()) RETURNING id`,
        [id, b.kind, b.number, b.bank, b.amount, b.issuedOn, b.expiresOn, b.fee, b.feePaidFrom, key])).rows[0]!;
      await postGuaranteeFee(db, r.id);
      await auditTenant(db, req, "guarantee.created", "bank_guarantee", r.id, { kind: b.kind });
      return r.id;
    });
    return reply.status(201).send({ id: gid });
  });

  app.post("/guarantees/:id/release", { preHandler: requireTenant("guarantees.edit") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ releasedOn: date.optional() }).parse(req.body ?? {});
    await tenantTx(req, async (db) => {
      const r = await db.query("UPDATE bank_guarantees SET status = 'released', released_on = $2 WHERE id = $1 AND status = 'active'", [id, b.releasedOn ?? today()]);
      if (!r.rowCount) throw conflict("الضمان غير موجود أو غير ساري");
      await auditTenant(db, req, "guarantee.released", "bank_guarantee", id);
    });
    return { ok: true };
  });

  // Guarantees expiring within 60 days (and permits), for the contracting dashboard.
  app.get("/contracting/alerts", { preHandler: requireTenant("guarantees.view", "projects.view") }, async (req) =>
    tenantTx(req, async (db) => ({
      guarantees: (await db.query(
        `SELECT g.id, g.kind, g.number, g.bank, g.amount::float8 AS amount, g.expires_on::text AS "expiresOn", (g.expires_on - current_date)::int AS "daysLeft", k.id AS "contractId", k.number AS "contractNumber"
           FROM bank_guarantees g JOIN contracts k ON k.id = g.contract_id WHERE g.status = 'active' AND g.expires_on <= current_date + 60 ORDER BY g.expires_on`)).rows,
      permits: (await db.query(
        `SELECT x.id, x.kind, x.number, x.expires_on::text AS "expiresOn", (x.expires_on - current_date)::int AS "daysLeft", p.id AS "projectId", p.code AS "projectCode"
           FROM project_permits x JOIN projects p ON p.id = x.project_id WHERE x.expires_on IS NOT NULL AND x.expires_on <= current_date + 60 ORDER BY x.expires_on`)).rows,
    }), { readOnly: true }));
}
