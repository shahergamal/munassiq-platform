import ExcelJS from "exceljs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../../db/pool.ts";
import { billableShare, canMove, checkTerms, MILESTONES, quantitiesToDate, SITE_FLOW, type Milestone, type SiteStatus } from "../../lib/contracting/telecom.ts";
import { AppError, badRequest, notFound } from "../../lib/errors.ts";
import { isoDate } from "../../lib/calendar.ts";
import { auditTenant, isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";
import { today } from "../restaurants/batches.ts";
import { cellText } from "../restaurants/import.ts";
import { currentVersion } from "./projects.ts";
import { projectOpen } from "./site.ts";

// The telecom rollout (docs/contracting/ARCHITECTURE.md, C11): sites of a TELECOM_SITE project under its main
// contract, each with its scope from the contract's rate card (BOQ) and its state, moved forward by dated events
// (PAC and FAC with their certificates). The contract's milestone terms turn the states into billable quantities,
// which fill a draft IPC: the invoice still goes through the IPC, its approval and ZATCA as for any contract.

const date = isoDate;
const optText = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => v || null);
const conflict = (m: string, code = "invalid_state") => new AppError(409, code, m);
const SITE_TYPES = ["greenfield", "rooftop", "indoor", "small_cell", "fiber", "upgrade"] as const;
const MAX_SITES = 5000;

async function telecomProject(db: Db, projectId: string) {
  const p = (await db.query<{ specialty: string }>("SELECT specialty FROM projects WHERE id = $1", [projectId])).rows[0];
  if (!p) throw notFound("المشروع غير موجود");
  if (p.specialty !== "TELECOM_SITE") throw conflict("المواقع لمشاريع الاتصالات (تخصص «اتصالات بالموقع»)", "not_telecom");
}

/** The main contract the site is billed under: of this project, its rate card frozen (active). */
async function checkContract(db: Db, projectId: string, contractId: string | null) {
  if (!contractId) return;
  const c = (await db.query<{ role: string }>("SELECT role FROM contracts WHERE id = $1 AND project_id = $2", [contractId, projectId])).rows[0];
  if (!c) throw badRequest("العقد ليس من هذا المشروع");
  if (c.role !== "MAIN") throw badRequest("المواقع تُفوتر على العقد الرئيسي مع العميل");
}

async function termsOf(db: Db, contractId: string) {
  const rows = (await db.query<{ milestone: Milestone; pct: string }>("SELECT milestone, pct::text FROM contract_milestone_terms WHERE contract_id = $1", [contractId])).rows;
  return Object.fromEntries(rows.map((r) => [r.milestone, Number(r.pct)])) as Partial<Record<Milestone, number>>;
}

export default async function telecomRoutes(app: FastifyInstance) {
  // ── Sites ─────────────────────────────────────────────────────────────────────────────────
  app.get("/projects/:id/sites", { preHandler: requireTenant("telecom_sites.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const q = z.object({ status: z.enum([...SITE_FLOW, "cancelled"]).optional(), q: z.string().trim().max(60).optional() }).parse(req.query);
    return tenantTx(req, async (db) => {
      const t = today();
      const rows = (await db.query<{ status: SiteStatus; contractId: string | null; value: number; statusDate: string }>(
        `SELECT s.id, s.code, s.name, s.region, s.site_type AS "siteType", s.latitude::float8 AS latitude, s.longitude::float8 AS longitude, s.status, s.status_date::text AS "statusDate",
                s.hold_reason AS "holdReason", s.pac_ref AS "pacRef", s.pac_date::text AS "pacDate", s.fac_ref AS "facRef", s.fac_date::text AS "facDate", s.contract_id AS "contractId",
                k.number AS "contractNumber",
                coalesce((SELECT sum(i.quantity * b.rate) FROM telecom_site_items i JOIN boq_items b ON b.id = i.boq_item_id WHERE i.site_id = s.id), 0)::float8 AS value,
                (SELECT count(*)::int FROM telecom_site_items i WHERE i.site_id = s.id) AS items
           FROM telecom_sites s LEFT JOIN contracts k ON k.id = s.contract_id
          WHERE s.project_id = $1 AND ($2::text IS NULL OR s.status = $2) AND ($3::text IS NULL OR s.code ILIKE '%' || $3 || '%' OR s.name ILIKE '%' || $3 || '%')
          ORDER BY s.code LIMIT ${MAX_SITES}`, [id, q.status ?? null, q.q || null])).rows;
      const terms = new Map<string, Partial<Record<Milestone, number>>>();
      for (const c of new Set(rows.map((r) => r.contractId).filter((x): x is string => Boolean(x)))) terms.set(c, await termsOf(db, c));
      const items = rows.map((r) => {
        const share = r.contractId ? billableShare(r.status, terms.get(r.contractId) ?? {}) : 0;
        return { ...r, billableShare: share, billable: Math.round(r.value * share * 100) / 100,
          daysInStatus: Math.max(0, Math.round((Date.parse(`${t}T00:00:00Z`) - Date.parse(`${r.statusDate}T00:00:00Z`)) / 86_400_000)) };
      });
      const byStatus = Object.fromEntries([...SITE_FLOW, "cancelled"].map((s) => [s, 0])) as Record<string, number>;
      const all = (await db.query<{ status: string; n: number; held: number }>("SELECT status, count(*)::int AS n, count(*) FILTER (WHERE hold_reason IS NOT NULL)::int AS held FROM telecom_sites WHERE project_id = $1 GROUP BY status", [id])).rows;
      for (const s of all) byStatus[s.status] = s.n;
      return { items, byStatus, onHold: all.reduce((a, s) => a + s.held, 0),
        totals: { value: Math.round(items.filter((i) => i.status !== "cancelled").reduce((a, i) => a + i.value, 0) * 100) / 100, billable: Math.round(items.reduce((a, i) => a + i.billable, 0) * 100) / 100 } };
    }, { readOnly: true });
  });

  const siteBody = z.object({ code: z.string().trim().regex(/^[A-Za-z0-9._-]{1,40}$/, "رمز الموقع حروف لاتينية وأرقام و . _ -"), name: z.string().trim().min(2).max(120), region: optText(80),
    siteType: z.enum(SITE_TYPES), latitude: z.number().min(-90).max(90).nullable().optional().transform((v) => v ?? null), longitude: z.number().min(-180).max(180).nullable().optional().transform((v) => v ?? null),
    contractId: z.string().uuid().nullable().optional().transform((v) => v ?? null) });

  app.post("/projects/:id/sites", { preHandler: requireTenant("telecom_sites.create") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = siteBody.parse(req.body);
    const out = await tenantTx(req, async (db) => {
      await projectOpen(db, id);
      await telecomProject(db, id);
      await checkContract(db, id, b.contractId);
      const s = (await db.query<{ id: string }>(
        `INSERT INTO telecom_sites (tenant_id, project_id, contract_id, code, name, region, site_type, latitude, longitude, status_date)
         VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`, [id, b.contractId, b.code, b.name, b.region, b.siteType, b.latitude, b.longitude, today()])).rows[0]!;
      await db.query("INSERT INTO telecom_site_events (tenant_id, site_id, from_status, to_status, event_date, created_by) VALUES (app_tenant_id(), $1, NULL, 'planned', $2, app_user_id())", [s.id, today()]);
      return s;
    });
    return reply.status(201).send(out);
  });

  /** Sites from Excel: code, name, region, type, latitude, longitude (one sheet, header row). All or nothing. */
  app.post("/projects/:id/sites/import", { preHandler: requireTenant("telecom_sites.create"), config: { rateLimit: { max: 20, timeWindow: "10 minutes" } } }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const q = z.object({ contractId: z.string().uuid().optional() }).parse(req.query);
    const file = await req.file({ limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
    if (!file) throw badRequest("أرفق ملف Excel");
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load((await file.toBuffer()) as unknown as ArrayBuffer); } catch { throw badRequest("الملف ليس Excel صالحاً (.xlsx)"); }
    const ws = wb.worksheets[0];
    if (!ws) throw badRequest("الملف فارغ");
    if (ws.rowCount - 1 > MAX_SITES) throw badRequest(`الحد الأقصى ${MAX_SITES} موقع`);
    const TYPES: Record<string, (typeof SITE_TYPES)[number]> = { greenfield: "greenfield", "أرضي": "greenfield", rooftop: "rooftop", "سطح": "rooftop", indoor: "indoor", "داخلي": "indoor",
      small_cell: "small_cell", "خلية صغيرة": "small_cell", fiber: "fiber", "ألياف": "fiber", upgrade: "upgrade", "تحديث": "upgrade" };
    const rows: { row: number; code: string; name: string; region: string; type: string; lat: string; lng: string }[] = [];
    ws.eachRow((r, n) => {
      if (n === 1) return;
      const c = (i: number) => cellText(r.getCell(i).value);
      if (!c(1) && !c(2)) return;
      rows.push({ row: n, code: c(1), name: c(2), region: c(3), type: c(4).toLowerCase(), lat: c(5), lng: c(6) });
    });
    if (!rows.length) throw badRequest("لا مواقع في الملف");
    return tenantTx(req, async (db) => {
      await projectOpen(db, id);
      await telecomProject(db, id);
      await checkContract(db, id, q.contractId ?? null);
      const existing = new Set((await db.query<{ code: string }>("SELECT code FROM telecom_sites WHERE project_id = $1", [id])).rows.map((r) => r.code.toLowerCase()));
      const seen = new Set<string>();
      const errors: { row: number; message: string }[] = [];
      for (const r of rows) {
        if (!/^[A-Za-z0-9._-]{1,40}$/.test(r.code)) errors.push({ row: r.row, message: "رمز الموقع حروف لاتينية وأرقام و . _ -" });
        else if (seen.has(r.code.toLowerCase()) || existing.has(r.code.toLowerCase())) errors.push({ row: r.row, message: `الرمز «${r.code}» مكرر` });
        seen.add(r.code.toLowerCase());
        if (r.name.trim().length < 2) errors.push({ row: r.row, message: "اسم الموقع مطلوب" });
        if (!TYPES[r.type || "greenfield"]) errors.push({ row: r.row, message: `النوع «${r.type}» غير معروف` });
        for (const [v, lim, what] of [[r.lat, 90, "خط العرض"], [r.lng, 180, "خط الطول"]] as const) {
          if (v && !(Number.isFinite(Number(v)) && Math.abs(Number(v)) <= lim)) errors.push({ row: r.row, message: `${what} غير صالح` });
        }
      }
      if (errors.length) throw new AppError(422, "import_invalid", `في الملف ${errors.length} خطأ؛ لم يُستورد شيء`, { errors: errors.slice(0, 500) });
      for (const r of rows) {
        const s = (await db.query<{ id: string }>(
          `INSERT INTO telecom_sites (tenant_id, project_id, contract_id, code, name, region, site_type, latitude, longitude, status_date)
           VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
          [id, q.contractId ?? null, r.code, r.name.trim().slice(0, 120), r.region.slice(0, 80) || null, TYPES[r.type || "greenfield"], r.lat ? Number(r.lat) : null, r.lng ? Number(r.lng) : null, today()])).rows[0]!;
        await db.query("INSERT INTO telecom_site_events (tenant_id, site_id, from_status, to_status, event_date, created_by) VALUES (app_tenant_id(), $1, NULL, 'planned', $2, app_user_id())", [s.id, today()]);
      }
      await auditTenant(db, req, "telecom.sites_imported", "project", id, { sites: rows.length });
      return { ok: true, sites: rows.length };
    });
  });

  app.put("/telecom-sites/:id", { preHandler: requireTenant("telecom_sites.create") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = siteBody.omit({ code: true }).extend({ holdReason: optText(300) }).parse(req.body);
    await tenantTx(req, async (db) => {
      const s = (await db.query<{ project_id: string; status: string; contract_id: string | null }>("SELECT project_id, status, contract_id FROM telecom_sites WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!s) throw notFound();
      await checkContract(db, s.project_id, b.contractId);
      if (b.contractId !== s.contract_id && ["installation", "on_air", "pac", "fac"].includes(s.status)) throw conflict("لا يتغير عقد موقع بلغ التركيب: قد يكون فوتر");
      if (b.holdReason && ["fac", "cancelled"].includes(s.status)) throw conflict("الموقع في حالة نهائية");
      await db.query("UPDATE telecom_sites SET name = $2, region = $3, site_type = $4, latitude = $5, longitude = $6, contract_id = $7, hold_reason = $8 WHERE id = $1",
        [id, b.name, b.region, b.siteType, b.latitude, b.longitude, b.contractId, b.holdReason]);
    });
    return { ok: true };
  });

  app.get("/telecom-sites/:id", { preHandler: requireTenant("telecom_sites.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const s = (await db.query<{ contract_id: string | null }>(
        `SELECT s.id, s.code, s.name, s.status, s.contract_id, s.project_id AS "projectId" FROM telecom_sites s WHERE s.id = $1`, [id])).rows[0];
      if (!s) throw notFound();
      const items = (await db.query(`SELECT b.id AS "boqItemId", b.code, b.description, b.unit, b.rate::float8 AS rate, i.quantity::float8 AS quantity
                                       FROM telecom_site_items i JOIN boq_items b ON b.id = i.boq_item_id WHERE i.site_id = $1 ORDER BY b.code`, [id])).rows;
      const events = (await db.query(`SELECT from_status AS "from", to_status AS "to", event_date::text AS "date", reference, note, created_at AS "createdAt"
                                        FROM telecom_site_events WHERE site_id = $1 ORDER BY created_at`, [id])).rows;
      let rateCard: unknown[] = [];
      if (s.contract_id) {
        const v = await currentVersion(db, s.contract_id);
        if (v) rateCard = (await db.query(`SELECT id, code, description, unit, rate::float8 AS rate FROM boq_items WHERE version_id = $1 AND NOT is_section ORDER BY sort, code`, [v.id])).rows;
      }
      const { contract_id, ...rest } = s;
      return { ...rest, contractId: contract_id, items, events, rateCard };
    }, { readOnly: true });
  });

  /** The site's scope from its contract's rate card (replaced). Frozen once the site is on air. */
  app.put("/telecom-sites/:id/items", { preHandler: requireTenant("telecom_sites.create") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ items: z.array(z.object({ boqItemId: z.string().uuid(), quantity: z.number().positive().max(1e7) })).max(300) }).parse(req.body);
    if (new Set(b.items.map((i) => i.boqItemId)).size !== b.items.length) throw badRequest("بند مكرر");
    await tenantTx(req, async (db) => {
      const s = (await db.query<{ contract_id: string | null; status: string }>("SELECT contract_id, status FROM telecom_sites WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!s) throw notFound();
      if (!s.contract_id) throw badRequest("اربط الموقع بالعقد أولاً: بنوده من جدول أسعار العقد");
      if (["installation", "on_air", "pac", "fac", "cancelled"].includes(s.status)) throw conflict("نطاق الموقع ثابت من التركيب: قد يكون فوتر", "site_scope_frozen");
      const v = await currentVersion(db, s.contract_id);
      if (b.items.length) {
        const ok = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM boq_items WHERE id = ANY($1::uuid[]) AND version_id = $2 AND NOT is_section", [b.items.map((i) => i.boqItemId), v?.id])).rows[0]!.n;
        if (ok !== b.items.length) throw badRequest("البنود من جدول أسعار العقد الحالي فقط");
      }
      await db.query("DELETE FROM telecom_site_items WHERE site_id = $1", [id]);
      for (const i of b.items) await db.query("INSERT INTO telecom_site_items (tenant_id, site_id, boq_item_id, quantity) VALUES (app_tenant_id(), $1, $2, $3)", [id, i.boqItemId, i.quantity]);
    });
    return { ok: true };
  });

  /** Moves the site forward (or cancels it) on a date; PAC and FAC with their certificate number. */
  app.post("/telecom-sites/:id/advance", { preHandler: requireTenant("telecom_sites.advance") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ to: z.enum([...SITE_FLOW, "cancelled"]), date, reference: optText(80), note: optText(500) }).parse(req.body);
    if (b.date > today()) throw badRequest("تاريخ الحدث لا يكون في المستقبل");
    return tenantTx(req, async (db) => {
      const s = (await db.query<{ status: SiteStatus; status_date: string; contract_id: string | null; pac_date: string | null; items: number }>(
        "SELECT status, status_date::text, contract_id, pac_date::text, (SELECT count(*)::int FROM telecom_site_items WHERE site_id = $1) AS items FROM telecom_sites WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!s) throw notFound();
      const m = canMove(s.status, b.to);
      if (!m.ok) throw conflict(m.reason, "invalid_transition");
      // The planned date is when the site was registered, not an event on site: a rollout taken over mid-way records
      // its earlier steps with their real dates.
      if (s.status !== "planned" && b.date < s.status_date) throw badRequest(`التاريخ قبل الحالة الحالية (${s.status_date})`);
      if (["installation", "on_air", "pac", "fac"].includes(b.to) && (!s.contract_id || !s.items)) throw badRequest("موقع بلا عقد أو بلا بنود لا يُركَّب: حدد نطاقه من جدول الأسعار أولاً، فهو يثبت من التركيب");
      if ((b.to === "pac" || b.to === "fac") && !b.reference) throw badRequest(b.to === "pac" ? "أدخل رقم شهادة الاستلام الابتدائي" : "أدخل رقم شهادة الاستلام النهائي");
      if (b.to === "cancelled" && !b.note) throw badRequest("اكتب سبب الإلغاء");
      const set = b.to === "pac" ? ", pac_ref = $4, pac_date = $3" : b.to === "fac" ? ", fac_ref = $4, fac_date = $3" : "";
      await db.query(`UPDATE telecom_sites SET status = $2, status_date = $3, hold_reason = NULL${set} WHERE id = $1`, set ? [id, b.to, b.date, b.reference] : [id, b.to, b.date]);
      await db.query("INSERT INTO telecom_site_events (tenant_id, site_id, from_status, to_status, event_date, reference, note, created_by) VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, app_user_id())",
        [id, s.status, b.to, b.date, b.reference, b.note]);
      await auditTenant(db, req, "telecom.site_advanced", "telecom_site", id, { from: s.status, to: b.to });
      return { ok: true };
    });
  });

  // ── Milestone billing ─────────────────────────────────────────────────────────────────────
  app.get("/contracts/:id/milestone-terms", { preHandler: requireTenant("telecom_sites.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const t = await termsOf(db, id);
      const locked = Boolean((await db.query("SELECT 1 FROM ipcs WHERE contract_id = $1 AND status IN ('approved', 'invoiced') LIMIT 1", [id])).rowCount);
      return { items: MILESTONES.filter((m) => t[m]).map((m) => ({ milestone: m, pct: t[m] })), locked };
    }, { readOnly: true });
  });

  app.put("/contracts/:id/milestone-terms", { preHandler: requireTenant("telecom_sites.terms") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ items: z.array(z.object({ milestone: z.enum(MILESTONES), pct: z.number().positive().max(100) })).min(1).max(4) }).parse(req.body);
    const bad = checkTerms(b.items);
    if (bad) throw badRequest(bad);
    await tenantTx(req, async (db) => {
      const c = (await db.query<{ role: string; specialty: string }>("SELECT k.role, p.specialty FROM contracts k JOIN projects p ON p.id = k.project_id WHERE k.id = $1 FOR UPDATE OF k", [id])).rows[0];
      if (!c) throw notFound();
      if (c.role !== "MAIN" || c.specialty !== "TELECOM_SITE") throw conflict("شروط المراحل لعقد رئيسي في مشروع اتصالات", "not_telecom");
      if ((await db.query("SELECT 1 FROM ipcs WHERE contract_id = $1 AND status IN ('approved', 'invoiced') LIMIT 1", [id])).rowCount) {
        throw conflict("اعتُمد مستخلص بهذه الشروط: تغييرها يغيّر ما فوتر. عدّلها بأمر تغيير على العقد", "terms_locked");
      }
      await db.query("DELETE FROM contract_milestone_terms WHERE contract_id = $1", [id]);
      for (const t of b.items) await db.query("INSERT INTO contract_milestone_terms (tenant_id, contract_id, milestone, pct) VALUES (app_tenant_id(), $1, $2, $3)", [id, t.milestone, t.pct]);
      await auditTenant(db, req, "telecom.terms", "contract", id, { terms: b.items });
    });
    return { ok: true };
  });

  /**
   * Fills a draft IPC from the sites: each rate-card line's cumulative quantity = Σ site quantity × the share its
   * state has reached (matched by item code, so a later BOQ version keeps counting). Lines no site uses are left.
   */
  app.post("/ipcs/:id/fill-from-sites", { preHandler: requireTenant("ipcs.create") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const i = (await db.query<{ status: string; contract_id: string; period_to: string }>("SELECT status, contract_id, period_to::text FROM ipcs WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!i) throw notFound();
      if (i.status !== "draft") throw conflict("تُملأ كميات المستخلص وهو مسودة");
      const terms = await termsOf(db, i.contract_id);
      if (!Object.keys(terms).length) throw conflict("حدد شروط الفوترة بالمراحل للعقد أولاً", "no_terms");
      // The state each site had reached by the end of the IPC's period.
      const sites = (await db.query<{ id: string; status: SiteStatus }>(
        `SELECT s.id, coalesce((SELECT e.to_status FROM telecom_site_events e WHERE e.site_id = s.id AND e.event_date <= $2
                                 ORDER BY e.to_status = 'cancelled' DESC, array_position($3::text[], e.to_status) DESC LIMIT 1), 'planned') AS status
           FROM telecom_sites s WHERE s.contract_id = $1`, [i.contract_id, i.period_to, [...SITE_FLOW]])).rows;
      const items = (await db.query<{ site_id: string; code: string; quantity: string }>(
        `SELECT i.site_id, b.code, i.quantity::text FROM telecom_site_items i JOIN boq_items b ON b.id = i.boq_item_id JOIN telecom_sites s ON s.id = i.site_id WHERE s.contract_id = $1`, [i.contract_id])).rows;
      const q = quantitiesToDate(sites.map((s) => ({ status: s.status, items: items.filter((x) => x.site_id === s.id).map((x) => ({ code: x.code, quantity: Number(x.quantity) })) })), terms);
      const lines = (await db.query<{ id: string; code: string; previous_qty: string }>(
        `SELECT l.id, b.code, l.previous_qty::text FROM ipc_lines l JOIN boq_items b ON b.id = l.boq_item_id WHERE l.ipc_id = $1 AND l.kind = 'boq'`, [id])).rows;
      let filled = 0;
      const below: string[] = [];
      for (const l of lines) {
        if (!q.has(l.code)) continue;
        const qty = q.get(l.code)!;
        if (qty < Number(l.previous_qty)) below.push(l.code);
        await db.query("UPDATE ipc_lines SET submitted_qty = $2 WHERE id = $1", [l.id, qty]);
        filled++;
      }
      await auditTenant(db, req, "ipc.filled_from_sites", "ipc", id, { lines: filled, sites: sites.length });
      return { ok: true, lines: filled, sites: sites.filter((s) => s.status !== "cancelled").length, belowPrevious: below };
    });
  });
}
