import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../../db/pool.ts";
import { priceTender, type Markups, type Resource } from "../../lib/contracting/tender.ts";
import { AppError, badRequest, notFound } from "../../lib/errors.ts";
import { auditTenant, isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";
import { today } from "../restaurants/batches.ts";

// Estimating and tendering (docs/contracting/ARCHITECTURE.md, C6): the tender's BOQ with a rate build-up per item,
// priced by the server (lib/contracting/tender.ts), submitted as an offer, and converted when won into a project and
// a draft main contract with the priced BOQ and its estimated cost.

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح");
const optDate = date.nullable().optional().transform((v) => v ?? null);
const conflict = (m: string, code = "invalid_state") => new AppError(409, code, m);
const h = (v: string | number | null | undefined) => Math.round(Number(v ?? 0) * 100);
const riyals = (v: number) => v / 100;
const locked = (e: unknown) => {
  if ((e as { message?: string }).message?.includes("tender_locked")) return conflict("العطاء مقدَّم: لا يتغير تسعيره", "tender_locked");
  if ((e as { code?: string }).code === "23505") return conflict("الرمز مستخدم في هذا العطاء", "duplicate");
  return e;
};

interface ItemRow { id: string; parent_id: string | null; code: string; description: string; is_section: boolean; unit: string | null; quantity: number; direct_rate: number | null; sort: number }
interface ResRow { id: string; item_id: string; kind: Resource["kind"]; ingredient_id: string | null; description: string; unit: string | null; quantity: number; unit_cost: number; waste_pct: number }

/** The tender priced: every item with its build-up, the sections' totals, and the offer's totals (halalas inside, riyals out). */
async function priced(db: Db, tenderId: string) {
  const t = (await db.query<{ overhead: string; risk: string; profit: string }>("SELECT overhead_pct::text AS overhead, risk_pct::text AS risk, profit_pct::text AS profit FROM tenders WHERE id = $1",
    [tenderId])).rows[0];
  if (!t) throw notFound("العطاء غير موجود");
  const m: Markups = { overheadPct: Number(t.overhead), riskPct: Number(t.risk), profitPct: Number(t.profit) };
  const items = (await db.query<ItemRow>(
    `SELECT id, parent_id, code, description, is_section, unit, quantity::float8 AS quantity, direct_rate::float8 AS direct_rate, sort FROM tender_items WHERE tender_id = $1 ORDER BY sort, code`,
    [tenderId])).rows;
  const res = (await db.query<ResRow>(
    `SELECT r.id, r.item_id, r.kind, r.ingredient_id, r.description, r.unit, r.quantity::float8 AS quantity, r.unit_cost::float8 AS unit_cost, r.waste_pct::float8 AS waste_pct
       FROM tender_resources r JOIN tender_items i ON i.id = r.item_id WHERE i.tender_id = $1 ORDER BY r.kind, r.description`, [tenderId])).rows;
  const leaves = items.filter((i) => !i.is_section);
  const price = priceTender(leaves.map((i) => ({ quantity: i.quantity, directRate: i.direct_rate === null ? null : h(i.direct_rate),
    resources: res.filter((r) => r.item_id === i.id).map((r) => ({ kind: r.kind, quantity: r.quantity, unitCost: h(r.unit_cost), wastePct: r.waste_pct })) })), m);
  const byId = new Map(leaves.map((i, n) => [i.id, price.items[n]!]));
  const children = new Map<string | null, ItemRow[]>();
  for (const i of items) children.set(i.parent_id, [...(children.get(i.parent_id) ?? []), i]);
  const total = (i: ItemRow): number => (i.is_section ? (children.get(i.id) ?? []).reduce((a, c) => a + total(c), 0) : byId.get(i.id)!.amount);
  const walk = (parent: string | null, depth: number): (ItemRow & { depth: number })[] => (children.get(parent) ?? []).flatMap((i) => [{ ...i, depth }, ...walk(i.id, depth + 1)]);
  return {
    markups: m, leaves, byId,
    items: walk(null, 0).map((i) => {
      const p = byId.get(i.id);
      return { id: i.id, parentId: i.parent_id, code: i.code, description: i.description, isSection: i.is_section, unit: i.unit, quantity: i.quantity, depth: i.depth,
        directRate: i.direct_rate, amount: riyals(total(i)),
        ...(p ? { directCost: riyals(p.direct), costRate: riyals(p.costRate), rate: riyals(p.rate), byKind: Object.fromEntries(Object.entries(p.byKind).map(([k, v]) => [k, riyals(v)])) } : {}),
        resources: res.filter((r) => r.item_id === i.id).map((r) => ({ id: r.id, kind: r.kind, ingredientId: r.ingredient_id, description: r.description, unit: r.unit, quantity: r.quantity,
          unitCost: r.unit_cost, wastePct: r.waste_pct })) };
    }),
    totals: { total: riyals(price.total), cost: riyals(price.cost), direct: riyals(price.direct), margin: riyals(price.margin), marginPct: price.marginPct,
      byKind: Object.fromEntries(Object.entries(price.byKind).map(([k, v]) => [k, riyals(v)])) },
    totalHalalas: price.total, costHalalas: price.cost,
  };
}

const headerBody = z.object({
  number: z.string().trim().min(1, "أدخل رقم العطاء").max(40), title: z.string().trim().min(2, "أدخل عنوان العطاء").max(200),
  customerId: z.string().uuid().nullable().optional().transform((v) => v ?? null), specialty: z.string().regex(/^[A-Z_]{2,30}$/, "اختر التخصص"),
  governingRegime: z.enum(["GTPL_1440", "GTPL_1448", "PRIVATE"]).default("PRIVATE"), tenderDate: optDate, submissionDue: optDate,
  overheadPct: z.number().min(0).max(100).default(0), riskPct: z.number().min(0).max(100).default(0), profitPct: z.number().min(0).max(100).default(0),
});

export default async function tenderRoutes(app: FastifyInstance) {
  app.get("/tenders", { preHandler: requireTenant("tenders.view") }, async (req) =>
    tenantTx(req, async (db) => {
      const rows = (await db.query<{ id: string; number: string; title: string; status: string; customer: string | null; submission_due: string | null; submitted_total: string | null;
        contract_id: string | null; specialty: string }>(
        `SELECT t.id, t.number, t.title, t.status, c.name AS customer, t.submission_due::text AS submission_due, t.submitted_total::text, t.contract_id, s.name AS specialty
           FROM tenders t LEFT JOIN customers c ON c.id = t.customer_id JOIN specialty_templates s ON s.code = t.specialty ORDER BY t.created_at DESC LIMIT 500`)).rows;
      const items = [];
      for (const r of rows) {
        const p = r.status === "draft" ? (await priced(db, r.id)).totals : null;
        items.push({ id: r.id, number: r.number, title: r.title, status: r.status, customerName: r.customer, specialtyName: r.specialty, submissionDue: r.submission_due,
          total: p ? p.total : Number(r.submitted_total ?? 0), marginPct: p?.marginPct ?? null, contractId: r.contract_id });
      }
      const decided = rows.filter((r) => r.status === "won" || r.status === "lost");
      return { items, winRate: decided.length ? Math.round((rows.filter((r) => r.status === "won").length / decided.length) * 10_000) / 100 : null };
    }, { readOnly: true }));

  app.post("/tenders", { preHandler: requireTenant("tenders.create") }, async (req, reply) => {
    const b = headerBody.parse(req.body);
    if (b.governingRegime !== "PRIVATE" && !b.tenderDate) throw badRequest("المنافسة الحكومية تحتاج تاريخ طرحها: هو ما يحدد النظام الحاكم");
    const id = await tenantTx(req, async (db) => {
      try {
        const r = (await db.query<{ id: string }>(
          `INSERT INTO tenders (tenant_id, number, title, customer_id, specialty, governing_regime, tender_date, submission_due, overhead_pct, risk_pct, profit_pct, created_by)
           VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, app_user_id()) RETURNING id`,
          [b.number, b.title, b.customerId, b.specialty, b.governingRegime, b.tenderDate, b.submissionDue, b.overheadPct, b.riskPct, b.profitPct])).rows[0]!;
        await auditTenant(db, req, "tender.created", "tender", r.id, { number: b.number });
        return r.id;
      } catch (e) { throw locked(e); }
    });
    return reply.status(201).send({ id });
  });

  app.put("/tenders/:id", { preHandler: requireTenant("tenders.edit") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = headerBody.parse(req.body);
    if (b.governingRegime !== "PRIVATE" && !b.tenderDate) throw badRequest("المنافسة الحكومية تحتاج تاريخ طرحها: هو ما يحدد النظام الحاكم");
    await tenantTx(req, async (db) => {
      try {
        const r = await db.query(
          `UPDATE tenders SET number = $2, title = $3, customer_id = $4, specialty = $5, governing_regime = $6, tender_date = $7, submission_due = $8, overhead_pct = $9, risk_pct = $10,
                  profit_pct = $11 WHERE id = $1 AND status = 'draft'`,
          [id, b.number, b.title, b.customerId, b.specialty, b.governingRegime, b.tenderDate, b.submissionDue, b.overheadPct, b.riskPct, b.profitPct]);
        if (!r.rowCount) throw conflict("العطاء غير موجود أو مقدَّم");
      } catch (e) { throw locked(e); }
      await auditTenant(db, req, "tender.updated", "tender", id);
    });
    return { ok: true };
  });

  app.get("/tenders/:id", { preHandler: requireTenant("tenders.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const t = (await db.query(
        `SELECT t.id, t.number, t.title, t.status, t.customer_id AS "customerId", c.name AS "customerName", t.specialty, s.name AS "specialtyName", s.definition AS "specialtyDefinition",
                t.governing_regime AS "governingRegime", t.tender_date::text AS "tenderDate", t.submission_due::text AS "submissionDue", t.overhead_pct::float8 AS "overheadPct",
                t.risk_pct::float8 AS "riskPct", t.profit_pct::float8 AS "profitPct", t.submitted_total::float8 AS "submittedTotal", t.outcome_note AS "outcomeNote", t.contract_id AS "contractId"
           FROM tenders t LEFT JOIN customers c ON c.id = t.customer_id JOIN specialty_templates s ON s.code = t.specialty WHERE t.id = $1`, [id])).rows[0];
      if (!t) throw notFound("العطاء غير موجود");
      const p = await priced(db, id);
      return { ...t, items: p.items, totals: p.totals };
    }, { readOnly: true });
  });

  const itemBody = z.object({
    parentId: z.string().uuid().nullable().optional().transform((v) => v ?? null), code: z.string().trim().min(1, "أدخل الرمز").max(40),
    description: z.string().trim().min(1, "أدخل الوصف").max(1000), isSection: z.boolean().default(false), unit: z.string().trim().max(20).nullable().optional().transform((v) => v || null),
    quantity: z.number().min(0).max(1e12).default(0), directRate: z.number().min(0).max(1e12).nullable().optional().transform((v) => v ?? null),
  });
  app.post("/tenders/:id/items", { preHandler: requireTenant("tenders.edit") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = itemBody.parse(req.body);
    const iid = await tenantTx(req, async (db) => {
      if (b.parentId && !(await db.query("SELECT 1 FROM tender_items WHERE id = $1 AND tender_id = $2 AND is_section", [b.parentId, id])).rowCount) throw badRequest("الأب ليس قسماً في هذا العطاء");
      const sort = (await db.query<{ n: number }>("SELECT coalesce(max(sort), 0)::int + 10 AS n FROM tender_items WHERE tender_id = $1", [id])).rows[0]!.n;
      try {
        return (await db.query<{ id: string }>(
          `INSERT INTO tender_items (tenant_id, tender_id, parent_id, code, description, is_section, unit, quantity, direct_rate, sort)
           VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
          [id, b.parentId, b.code, b.description, b.isSection, b.isSection ? null : b.unit, b.isSection ? 0 : b.quantity, b.isSection ? null : b.directRate, sort])).rows[0]!.id;
      } catch (e) { throw locked(e); }
    });
    return reply.status(201).send({ id: iid });
  });

  app.put("/tender-items/:id", { preHandler: requireTenant("tenders.edit") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = itemBody.omit({ parentId: true, isSection: true }).parse(req.body);
    await tenantTx(req, async (db) => {
      try {
        const r = await db.query(`UPDATE tender_items SET code = $2, description = $3, unit = CASE WHEN is_section THEN NULL ELSE $4 END, quantity = CASE WHEN is_section THEN 0 ELSE $5 END,
                                         direct_rate = CASE WHEN is_section THEN NULL ELSE $6 END WHERE id = $1`, [id, b.code, b.description, b.unit, b.quantity, b.directRate]);
        if (!r.rowCount) throw notFound("البند غير موجود");
      } catch (e) { throw locked(e); }
    });
    return { ok: true };
  });

  app.delete("/tender-items/:id", { preHandler: requireTenant("tenders.edit") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    await tenantTx(req, async (db) => {
      try { if (!(await db.query("DELETE FROM tender_items WHERE id = $1", [id])).rowCount) throw notFound(); } catch (e) { throw locked(e); }
    });
    return { ok: true };
  });

  // The item's build-up, replaced as a whole. A material from the item master costs its weighted average when no cost is given.
  app.put("/tender-items/:id/resources", { preHandler: requireTenant("tenders.edit") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ resources: z.array(z.object({
      kind: z.enum(["material", "labor", "equipment", "subcontract"]), ingredientId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
      description: z.string().trim().max(200).optional(), unit: z.string().trim().max(20).nullable().optional().transform((v) => v || null),
      quantity: z.number().positive().max(1e9), unitCost: z.number().min(0).max(1e12).optional(), wastePct: z.number().min(0).max(100).default(0),
    })).max(100) }).parse(req.body);
    await tenantTx(req, async (db) => {
      const item = (await db.query<{ is_section: boolean }>("SELECT is_section FROM tender_items WHERE id = $1", [id])).rows[0];
      if (!item) throw notFound("البند غير موجود");
      if (item.is_section) throw badRequest("القسم لا يُسعَّر: سعّر بنوده");
      try {
        await db.query("DELETE FROM tender_resources WHERE item_id = $1", [id]);
        for (const r of b.resources) {
          let description = r.description ?? "";
          let unitCost = r.unitCost;
          let unit = r.unit;
          if (r.ingredientId) {
            const g = (await db.query<{ name: string; avg: string | null; unit: string }>(
              `SELECT i.name, (SELECT sum(s.quantity * s.avg_cost) / nullif(sum(s.quantity), 0) FROM stock_levels s WHERE s.ingredient_id = i.id)::text AS avg, u.code AS unit
                 FROM ingredients i JOIN units u ON u.id = i.base_unit_id WHERE i.id = $1`, [r.ingredientId])).rows[0];
            if (!g) throw badRequest("الصنف غير موجود");
            description ||= g.name;
            unit ??= g.unit;
            unitCost ??= Number(g.avg ?? 0);
          }
          if (!description) throw badRequest("صف المورد");
          if (unitCost === undefined) throw badRequest(`أدخل تكلفة «${description}»`);
          await db.query(
            "INSERT INTO tender_resources (tenant_id, item_id, kind, ingredient_id, description, unit, quantity, unit_cost, waste_pct) VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8)",
            [id, r.kind, r.ingredientId, description, unit, r.quantity, unitCost, r.wastePct]);
        }
      } catch (e) { throw locked(e); }
    });
    return { ok: true };
  });

  // Submitting freezes the priced offer.
  app.post("/tenders/:id/submit", { preHandler: requireTenant("tenders.edit") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const t = (await db.query<{ status: string; customer_id: string | null }>("SELECT status, customer_id FROM tenders WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!t) throw notFound("العطاء غير موجود");
      if (t.status !== "draft") throw conflict("العطاء مقدَّم من قبل");
      if (!t.customer_id) throw badRequest("حدد العميل قبل تقديم العطاء");
      const p = await priced(db, id);
      if (p.totalHalalas <= 0) throw badRequest("العطاء بلا قيمة: سعّر بنوده أولاً");
      const unpriced = p.leaves.filter((i) => i.quantity > 0 && p.byId.get(i.id)!.rate === 0);
      if (unpriced.length) throw new AppError(422, "unpriced_items", `بنود بلا سعر: ${unpriced.slice(0, 10).map((i) => i.code).join("، ")}`);
      await db.query("UPDATE tenders SET status = 'submitted', submitted_total = $2, submitted_at = now() WHERE id = $1", [id, riyals(p.totalHalalas)]);
      await auditTenant(db, req, "tender.submitted", "tender", id, { total: riyals(p.totalHalalas) });
      return { ok: true, total: riyals(p.totalHalalas) };
    });
  });

  app.post("/tenders/:id/outcome", { preHandler: requireTenant("tenders.edit") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ status: z.enum(["won", "lost", "cancelled"]), note: z.string().trim().max(500).nullable().optional().transform((v) => v || null) }).parse(req.body);
    await tenantTx(req, async (db) => {
      const t = (await db.query<{ status: string }>("SELECT status FROM tenders WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!t) throw notFound("العطاء غير موجود");
      if (b.status === "won" && t.status !== "submitted") throw conflict("يُرسى العطاء المقدَّم فقط");
      if (!["draft", "submitted"].includes(t.status)) throw conflict("نتيجة العطاء مسجلة من قبل");
      await db.query("UPDATE tenders SET status = $2, outcome_note = $3 WHERE id = $1", [id, b.status, b.note]);
      await auditTenant(db, req, `tender.${b.status}`, "tender", id, { note: b.note });
    });
    return { ok: true };
  });

  /**
   * A won tender becomes a draft main contract: in an existing project or a new one (its own cost center), with the
   * priced BOQ at the selling rates, and the cost without profit as the contract's first estimated cost.
   */
  app.post("/tenders/:id/convert", { preHandler: requireTenant("tenders.convert") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({
      projectId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
      newProject: z.object({ code: z.string().trim().regex(/^[A-Za-z0-9-]{1,20}$/, "رمز المشروع حروف إنجليزية وأرقام وشرطة"), name: z.string().trim().min(2).max(160) }).nullable().optional(),
      contractNumber: z.string().trim().min(1).max(40), profile: z.string().regex(/^[A-Z0-9_]{2,30}$/), pricingModel: z.enum(["LUMP_SUM", "UNIT_PRICE", "COST_PLUS", "GMP", "T_AND_M", "RATE_CARD"]),
    }).parse(req.body);
    if (!b.projectId && !b.newProject) throw badRequest("اختر مشروعاً أو أنشئ مشروعاً جديداً");
    const out = await tenantTx(req, async (db) => {
      const t = (await db.query<{ status: string; contract_id: string | null; customer_id: string; title: string; specialty: string; regime: string; tender_date: string | null; number: string }>(
        "SELECT status, contract_id, customer_id, title, specialty, governing_regime AS regime, tender_date::text, number FROM tenders WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!t) throw notFound("العطاء غير موجود");
      if (t.status !== "won") throw conflict("يُحوَّل العطاء بعد ترسيته");
      if (t.contract_id) throw conflict("حُوّل العطاء إلى عقد من قبل");
      const prof = (await db.query<{ defaults: { retentionPct: number; retentionCapPct: number; advancePct: number; dlpMonths: number; claimNoticeDays: number } }>(
        "SELECT defaults FROM contract_profiles WHERE code = $1", [b.profile])).rows[0];
      if (!prof) throw badRequest("نموذج العقد غير موجود");
      let projectId = b.projectId;
      if (!projectId) {
        let cc: string;
        try {
          cc = (await db.query<{ id: string }>("INSERT INTO cost_centers (tenant_id, code, name, kind) VALUES (app_tenant_id(), $1, $2, 'project') RETURNING id", [b.newProject!.code, b.newProject!.name])).rows[0]!.id;
        } catch (e) { if ((e as { code?: string }).code === "23505") throw conflict(`رمز «${b.newProject!.code}» مستخدم`, "duplicate"); throw e; }
        projectId = (await db.query<{ id: string }>(
          "INSERT INTO projects (tenant_id, code, name, client_id, specialty, cost_center_id, created_by) VALUES (app_tenant_id(), $1, $2, $3, $4, $5, app_user_id()) RETURNING id",
          [b.newProject!.code, b.newProject!.name, t.customer_id, t.specialty, cc])).rows[0]!.id;
      } else {
        const p = (await db.query<{ specialty: string }>("SELECT specialty FROM projects WHERE id = $1", [projectId])).rows[0];
        if (!p) throw notFound("المشروع غير موجود");
        if (p.specialty !== t.specialty) throw badRequest("تخصص المشروع يختلف عن تخصص العطاء (الوحدات)");
      }
      const p = await priced(db, id);
      const d = prof.defaults;
      let contractId: string;
      try {
        contractId = (await db.query<{ id: string }>(
          `INSERT INTO contracts (tenant_id, project_id, number, title, role, customer_id, profile, pricing_model, governing_regime, tender_date, value, advance_pct, retention_pct,
                                  retention_cap_pct, dlp_months, claim_notice_days, created_by)
           VALUES (app_tenant_id(), $1, $2, $3, 'MAIN', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, app_user_id()) RETURNING id`,
          [projectId, b.contractNumber, t.title, t.customer_id, b.profile, b.pricingModel, t.regime, t.tender_date, riyals(p.totalHalalas), d.advancePct, d.retentionPct, d.retentionCapPct,
            d.dlpMonths, d.claimNoticeDays])).rows[0]!.id;
      } catch (e) { if ((e as { code?: string }).code === "23505") throw conflict("رقم العقد مستخدم", "duplicate"); throw e; }
      const v = (await db.query<{ id: string }>("INSERT INTO boq_versions (tenant_id, contract_id, number, kind) VALUES (app_tenant_id(), $1, 1, 'contract') RETURNING id", [contractId])).rows[0]!.id;
      // Parents first (the priced list is in tree order): the BOQ keeps the tender's structure at the selling rate.
      const ids = new Map<string, string>();
      let sort = 0;
      for (const i of p.items) {
        const r = (await db.query<{ id: string }>(
          `INSERT INTO boq_items (tenant_id, version_id, parent_id, code, description, is_section, unit, quantity, rate, sort)
           VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
          [v, i.parentId ? ids.get(i.parentId) : null, i.code, i.description, i.isSection, i.isSection ? null : i.unit, i.isSection ? 0 : i.quantity, i.isSection ? 0 : (i.rate ?? 0), sort += 10])).rows[0]!;
        ids.set(i.id, r.id);
        // The tender's materials from the item master become the BOQ item's norms (net of waste), for consumption reports.
        for (const x of i.resources.filter((x) => x.kind === "material" && x.ingredientId)) {
          await db.query(`INSERT INTO boq_item_norms (tenant_id, boq_item_id, ingredient_id, qty_per_unit) VALUES (app_tenant_id(), $1, $2, $3)
                          ON CONFLICT (tenant_id, boq_item_id, ingredient_id) DO UPDATE SET qty_per_unit = boq_item_norms.qty_per_unit + EXCLUDED.qty_per_unit`, [r.id, x.ingredientId, x.quantity]);
        }
      }
      await db.query("INSERT INTO contract_estimates (tenant_id, contract_id, estimated_cost, as_of, note, created_by) VALUES (app_tenant_id(), $1, $2, $3, $4, app_user_id())",
        [contractId, riyals(p.costHalalas), today(), `من العطاء ${t.number} (التكلفة بلا ربح)`]);
      await db.query("UPDATE tenders SET contract_id = $2 WHERE id = $1", [id, contractId]);
      await auditTenant(db, req, "tender.converted", "tender", id, { contractId });
      return { contractId, projectId };
    });
    return reply.status(201).send(out);
  });
}
