import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../../db/pool.ts";
import { postEquipmentTimesheet, postSiteIssue } from "../../lib/accounting/posting.ts";
import { ensureContractingAccounts } from "../../lib/contracting/accounts.ts";
import { consumption, equipmentCharge, utilisation } from "../../lib/contracting/site.ts";
import { AppError, badRequest, notFound } from "../../lib/errors.ts";
import { auditTenant, isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";
import { today } from "../restaurants/batches.ts";
import { dateRange, movement, putIn, takeOut } from "../restaurants/inventory.ts";
import { idempotencyKey } from "../restaurants/purchases.ts";

// Site materials, local content and equipment (docs/contracting/ARCHITECTURE.md, C7). Stock moves through the shared
// inventory functions (weighted-average cost, never negative); every issue and timesheet posts to the project.

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح");
const optUuid = z.string().uuid().nullable().optional().transform((v) => v ?? null);
const conflict = (m: string, code = "invalid_state") => new AppError(409, code, m);
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Issues and timesheets go to a project still being worked on. */
export async function projectOpen(db: Db, projectId: string) {
  const p = (await db.query<{ status: string }>("SELECT status FROM projects WHERE id = $1", [projectId])).rows[0];
  if (!p) throw notFound("المشروع غير موجود");
  if (p.status === "closed") throw conflict("المشروع مغلق: لا تُحمَّل عليه تكاليف جديدة", "project_closed");
}

export default async function siteRoutes(app: FastifyInstance) {
  // ── Local content on an item ──────────────────────────────────────────────────────────────
  app.get("/ingredients/:id/local-content", { preHandler: requireTenant("site_stores.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const r = (await db.query(`SELECT mandatory_list AS "mandatoryList", lc_certificate AS certificate, lc_pct::float8 AS pct, lc_valid_to::text AS "validTo" FROM ingredients WHERE id = $1`, [id])).rows[0];
      if (!r) throw notFound("الصنف غير موجود");
      return r;
    }, { readOnly: true });
  });
  app.put("/ingredients/:id/local-content", { preHandler: requireTenant("site_stores.edit") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ mandatoryList: z.boolean(), certificate: z.string().trim().min(1).max(60).nullable().optional().transform((v) => v || null),
      pct: z.number().min(0).max(100).nullable().optional().transform((v) => v ?? null), validTo: date.nullable().optional().transform((v) => v ?? null) }).parse(req.body);
    if ((b.certificate === null) !== (b.pct === null)) throw badRequest("الشهادة ونسبتها معاً");
    await tenantTx(req, async (db) => {
      const r = await db.query("UPDATE ingredients SET mandatory_list = $2, lc_certificate = $3, lc_pct = $4, lc_valid_to = $5 WHERE id = $1", [id, b.mandatoryList, b.certificate, b.pct, b.validTo]);
      if (!r.rowCount) throw notFound("الصنف غير موجود");
      await auditTenant(db, req, "ingredient.local_content", "ingredient", id, b);
    });
    return { ok: true };
  });

  // ── Site issues and returns ───────────────────────────────────────────────────────────────
  app.get("/site-issues", { preHandler: requireTenant("site_stores.view") }, async (req) => {
    const q = req.query as { projectId?: string };
    return tenantTx(req, async (db) => ({
      items: (await db.query(
        `SELECT x.id, x.number, x.kind, x.issued_on::text AS "issuedOn", p.code AS "projectCode", l.name AS "locationName", w.code AS "wbsCode", c.code AS "costCode", x.notes,
                (SELECT coalesce(sum(round(quantity * unit_cost, 2)), 0) FROM site_issue_lines WHERE issue_id = x.id)::float8 AS value,
                (SELECT json_agg(json_build_object('name', i.name, 'quantity', s.quantity::float8, 'unit', u.name, 'boq', b.code) ORDER BY i.name)
                   FROM site_issue_lines s JOIN ingredients i ON i.id = s.ingredient_id JOIN units u ON u.id = i.base_unit_id LEFT JOIN boq_items b ON b.id = s.boq_item_id
                  WHERE s.issue_id = x.id) AS lines
           FROM site_issues x JOIN projects p ON p.id = x.project_id JOIN locations l ON l.id = x.location_id
           LEFT JOIN wbs_nodes w ON w.id = x.wbs_id LEFT JOIN cost_codes c ON c.id = x.cost_code_id
          WHERE ($1::uuid IS NULL OR x.project_id = $1) ORDER BY x.number DESC LIMIT 300`, [isUuid(q.projectId) ? q.projectId : null])).rows,
    }), { readOnly: true });
  });

  app.post("/site-issues", { preHandler: requireTenant("site_stores.issue") }, async (req, reply) => {
    const key = idempotencyKey(req);
    const b = z.object({
      kind: z.enum(["issue", "return"]), projectId: z.string().uuid(), locationId: z.string().uuid("اختر مخزن الموقع"), issuedOn: date.optional(),
      wbsId: optUuid, costCodeId: optUuid, notes: z.string().trim().max(500).nullable().optional().transform((v) => v || null),
      lines: z.array(z.object({ ingredientId: z.string().uuid(), quantity: z.number().positive().max(1e9), boqItemId: optUuid })).min(1, "أضف صنفاً").max(200),
    }).parse(req.body);
    if (new Set(b.lines.map((l) => `${l.ingredientId}:${l.boqItemId}`)).size !== b.lines.length) throw badRequest("الصنف مكرر لنفس البند");
    if (b.issuedOn && b.issuedOn > today()) throw badRequest("تاريخ السند في المستقبل");
    const out = await tenantTx(req, async (db) => {
      const dup = (await db.query<{ id: string; number: string }>("SELECT id, number::text FROM site_issues WHERE idempotency_key = $1", [key])).rows[0];
      if (dup) return { ...dup, replay: true };
      const loc = (await db.query<{ project_id: string | null }>("SELECT project_id FROM locations WHERE id = $1 AND is_active", [b.locationId])).rows[0];
      if (!loc || loc.project_id !== b.projectId) throw badRequest("المخزن ليس مخزن موقع لهذا المشروع");
      await projectOpen(db, b.projectId);
      for (const l of b.lines.filter((x) => x.boqItemId)) {
        const ok = (await db.query(`SELECT 1 FROM boq_items i JOIN boq_versions v ON v.id = i.version_id JOIN contracts c ON c.id = v.contract_id
                                     WHERE i.id = $1 AND c.project_id = $2 AND NOT i.is_section`, [l.boqItemId, b.projectId])).rowCount;
        if (!ok) throw badRequest("البند ليس من عقود هذا المشروع");
      }
      if (b.wbsId && !(await db.query("SELECT 1 FROM wbs_nodes WHERE id = $1 AND project_id = $2", [b.wbsId, b.projectId])).rowCount) throw badRequest("عنصر WBS ليس من هذا المشروع");
      const costCode = b.costCodeId ?? (await db.query<{ id: string }>("SELECT id FROM cost_codes WHERE code = 'MAT' AND is_active")).rows[0]?.id ?? null;
      let lines: { ingredientId: string; quantity: number; unitCost: number; boqItemId: string | null }[];
      if (b.kind === "issue") {
        const taken = await takeOut(db, b.locationId, b.lines);
        lines = taken.map((t, i) => ({ ...t, boqItemId: b.lines[i]!.boqItemId }));
      } else {
        // A return comes back at what the project was charged for it, and never more than it took.
        lines = [];
        for (const l of b.lines) {
          // One return at a time per project and item: two at once must not both pass the check below.
          await db.query("SELECT pg_advisory_xact_lock(hashtext('site_return:' || $1 || ':' || $2))", [b.projectId, l.ingredientId]);
          const net = (await db.query<{ q: string; v: string }>(
            `SELECT coalesce(sum(CASE WHEN x.kind = 'issue' THEN s.quantity ELSE -s.quantity END), 0)::text AS q,
                    coalesce(sum(CASE WHEN x.kind = 'issue' THEN s.quantity * s.unit_cost ELSE -s.quantity * s.unit_cost END), 0)::text AS v
               FROM site_issue_lines s JOIN site_issues x ON x.id = s.issue_id WHERE x.project_id = $1 AND s.ingredient_id = $2`, [b.projectId, l.ingredientId])).rows[0]!;
          if (Number(net.q) + 1e-9 < l.quantity) throw conflict(`المرتجع أكبر من المصروف للمشروع (${Number(net.q)})`, "exceeds_issued");
          lines.push({ ingredientId: l.ingredientId, quantity: l.quantity, unitCost: Number(net.q) > 0 ? Number(net.v) / Number(net.q) : 0, boqItemId: l.boqItemId });
        }
        await putIn(db, b.locationId, lines);
      }
      const n = (await db.query<{ n: string }>("SELECT next_counter('site_issue')::text AS n")).rows[0]!.n;
      const r = (await db.query<{ id: string }>(
        `INSERT INTO site_issues (tenant_id, number, kind, project_id, location_id, issued_on, wbs_id, cost_code_id, notes, idempotency_key, created_by)
         VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, app_user_id()) RETURNING id`,
        [n, b.kind, b.projectId, b.locationId, b.issuedOn ?? today(), b.wbsId, costCode, b.notes, key])).rows[0]!;
      for (const l of lines) {
        await db.query("INSERT INTO site_issue_lines (tenant_id, issue_id, ingredient_id, quantity, unit_cost, boq_item_id) VALUES (app_tenant_id(), $1, $2, $3, $4, $5)",
          [r.id, l.ingredientId, l.quantity, l.unitCost, l.boqItemId]);
        await movement(db, { locationId: b.locationId, ingredientId: l.ingredientId, type: b.kind === "issue" ? "site_issue" : "site_return",
          quantity: b.kind === "issue" ? -l.quantity : l.quantity, unitCost: l.unitCost, refType: b.kind === "issue" ? "site_issue" : "site_return", refId: r.id });
      }
      await ensureContractingAccounts(db);
      await postSiteIssue(db, r.id);
      await auditTenant(db, req, `site.${b.kind}`, "site_issue", r.id, { lines: lines.length });
      return { id: r.id, number: n, replay: false };
    });
    return reply.status(out.replay ? 200 : 201).send(out);
  });

  // ── Norms and consumption against the BOQ ─────────────────────────────────────────────────
  app.put("/boq-items/:id/norms", { preHandler: requireTenant("site_stores.edit") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ norms: z.array(z.object({ ingredientId: z.string().uuid(), qtyPerUnit: z.number().positive().max(1e9) })).max(50) }).parse(req.body);
    await tenantTx(req, async (db) => {
      if (!(await db.query("SELECT 1 FROM boq_items WHERE id = $1 AND NOT is_section", [id])).rowCount) throw notFound("البند غير موجود");
      await db.query("DELETE FROM boq_item_norms WHERE boq_item_id = $1", [id]);
      for (const x of b.norms) await db.query("INSERT INTO boq_item_norms (tenant_id, boq_item_id, ingredient_id, qty_per_unit) VALUES (app_tenant_id(), $1, $2, $3)", [id, x.ingredientId, x.qtyPerUnit]);
      await auditTenant(db, req, "boq.norms", "boq_item", id, { count: b.norms.length });
    });
    return { ok: true };
  });

  /** Issued materials against what the certified work should have needed, per BOQ item and material. */
  app.get("/contracts/:id/consumption", { preHandler: requireTenant("site_stores.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const rows = (await db.query<{ boq_item_id: string; code: string; description: string; ingredient_id: string; material: string; unit: string; norm: number; certified: number;
        issued: number; value: number }>(
        `SELECT n.boq_item_id, b.code, b.description, n.ingredient_id, i.name AS material, u.name AS unit, n.qty_per_unit::float8 AS norm,
                coalesce((SELECT coalesce(l.certified_qty, l.submitted_qty) FROM ipc_lines l JOIN ipcs x ON x.id = l.ipc_id
                           WHERE l.boq_item_id = b.id AND x.status IN ('approved', 'invoiced') ORDER BY x.number DESC LIMIT 1), 0)::float8 AS certified,
                coalesce((SELECT sum(CASE WHEN s.kind = 'issue' THEN l.quantity ELSE -l.quantity END) FROM site_issue_lines l JOIN site_issues s ON s.id = l.issue_id
                           WHERE l.boq_item_id = b.id AND l.ingredient_id = n.ingredient_id), 0)::float8 AS issued,
                coalesce((SELECT sum(CASE WHEN s.kind = 'issue' THEN 1 ELSE -1 END * l.quantity * l.unit_cost) FROM site_issue_lines l JOIN site_issues s ON s.id = l.issue_id
                           WHERE l.boq_item_id = b.id AND l.ingredient_id = n.ingredient_id), 0)::float8 AS value
           FROM boq_item_norms n JOIN boq_items b ON b.id = n.boq_item_id JOIN boq_versions v ON v.id = b.version_id JOIN ingredients i ON i.id = n.ingredient_id JOIN units u ON u.id = i.base_unit_id
          WHERE v.contract_id = $1 ORDER BY b.sort, i.name`, [id])).rows;
      return { items: rows.map((r) => ({ boqItemId: r.boq_item_id, code: r.code, description: r.description, ingredientId: r.ingredient_id, material: r.material, unit: r.unit,
        norm: r.norm, certifiedQty: r.certified, issuedQty: r.issued, issuedValue: r2(r.value), ...consumption({ certifiedQty: r.certified, normPerUnit: r.norm, issuedQty: r.issued }) })) };
    }, { readOnly: true });
  });

  /** Local content of the materials issued to a project in a period: the value carried by valid certificates. */
  app.get("/projects/:id/local-content", { preHandler: requireTenant("site_stores.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const { from, to } = dateRange(req.query as { from?: string; to?: string });
    return tenantTx(req, async (db) => {
      const rows = (await db.query<{ name: string; mandatory: boolean; certificate: string | null; pct: number | null; valid_to: string | null; value: number; certified_value: number }>(
        `SELECT i.name, i.mandatory_list AS mandatory, i.lc_certificate AS certificate, i.lc_pct::float8 AS pct, i.lc_valid_to::text AS valid_to,
                sum(CASE WHEN s.kind = 'issue' THEN 1 ELSE -1 END * l.quantity * l.unit_cost)::float8 AS value,
                sum(CASE WHEN i.lc_certificate IS NOT NULL AND (i.lc_valid_to IS NULL OR i.lc_valid_to >= s.issued_on)
                         THEN CASE WHEN s.kind = 'issue' THEN 1 ELSE -1 END * l.quantity * l.unit_cost * i.lc_pct / 100 ELSE 0 END)::float8 AS certified_value
           FROM site_issue_lines l JOIN site_issues s ON s.id = l.issue_id JOIN ingredients i ON i.id = l.ingredient_id
          WHERE s.project_id = $1 AND s.issued_on BETWEEN $2::date AND $3::date
          GROUP BY i.id ORDER BY value DESC`, [id, from, to])).rows;
      const total = rows.reduce((a, r) => a + r.value, 0);
      const local = rows.reduce((a, r) => a + r.certified_value, 0);
      return { from, to, total: r2(total), localValue: r2(local), localPct: total > 0 ? Math.round((local / total) * 10_000) / 100 : null,
        items: rows.map((r) => ({ name: r.name, mandatoryList: r.mandatory, certificate: r.certificate, pct: r.pct, validTo: r.valid_to, value: r2(r.value), localValue: r2(r.certified_value),
          missingCertificate: r.mandatory && !r.certificate })) };
    }, { readOnly: true });
  });

  // ── Equipment ─────────────────────────────────────────────────────────────────────────────
  app.put("/machines/:id/equipment", { preHandler: requireTenant("equipment.edit") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ ownership: z.enum(["owned", "rented", "subcontractor"]), hourlyRate: z.number().min(0).max(1e7), idleRatePct: z.number().min(0).max(100).default(0) }).parse(req.body);
    await tenantTx(req, async (db) => {
      const r = await db.query("UPDATE machines SET ownership = $2, hourly_rate = $3, idle_rate_pct = $4 WHERE id = $1", [id, b.ownership, b.hourlyRate, b.idleRatePct]);
      if (!r.rowCount) throw notFound("المعدة غير موجودة");
      await auditTenant(db, req, "machine.rate", "machine", id, b);
    });
    return { ok: true };
  });

  app.post("/equipment-timesheets", { preHandler: requireTenant("equipment.create") }, async (req, reply) => {
    const b = z.object({
      machineId: z.string().uuid(), projectId: z.string().uuid(), workDate: date, operatingHours: z.number().min(0).max(24), idleHours: z.number().min(0).max(24).default(0),
      breakdownHours: z.number().min(0).max(24).default(0), fuelLiters: z.number().min(0).max(1e5).default(0), wbsId: optUuid,
      notes: z.string().trim().max(300).nullable().optional().transform((v) => v || null),
    }).parse(req.body);
    if (b.operatingHours + b.idleHours + b.breakdownHours > 24) throw badRequest("مجموع الساعات أكثر من 24");
    if (b.workDate > today()) throw badRequest("اليوم لم يأتِ بعد");
    const id = await tenantTx(req, async (db) => {
      await projectOpen(db, b.projectId);
      const mc = (await db.query<{ rate: string; idle: string; active: boolean }>("SELECT hourly_rate::text AS rate, idle_rate_pct::text AS idle, is_active AS active FROM machines WHERE id = $1",
        [b.machineId])).rows[0];
      if (!mc?.active) throw notFound("المعدة غير موجودة أو موقوفة");
      if (b.wbsId && !(await db.query("SELECT 1 FROM wbs_nodes WHERE id = $1 AND project_id = $2", [b.wbsId, b.projectId])).rowCount) throw badRequest("عنصر WBS ليس من هذا المشروع");
      const amount = equipmentCharge({ operatingHours: b.operatingHours, idleHours: b.idleHours, hourlyRate: Math.round(Number(mc.rate) * 100), idleRatePct: Number(mc.idle) });
      let r: { id: string };
      try {
        r = (await db.query<{ id: string }>(
          `INSERT INTO equipment_timesheets (tenant_id, machine_id, project_id, work_date, operating_hours, idle_hours, breakdown_hours, fuel_liters, wbs_id, hourly_rate, idle_rate_pct, amount, notes, created_by)
           VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, app_user_id()) RETURNING id`,
          [b.machineId, b.projectId, b.workDate, b.operatingHours, b.idleHours, b.breakdownHours, b.fuelLiters, b.wbsId, mc.rate, mc.idle, amount / 100, b.notes])).rows[0]!;
      } catch (e) { if ((e as { code?: string }).code === "23505") throw conflict("سُجّل يوم هذه المعدة من قبل", "duplicate"); throw e; }
      await ensureContractingAccounts(db);
      await postEquipmentTimesheet(db, r.id);
      await auditTenant(db, req, "equipment.timesheet", "machine", b.machineId, { projectId: b.projectId, amount: amount / 100 });
      return r.id;
    });
    return reply.status(201).send({ id });
  });

  /** Equipment on projects in a period: hours, utilisation, fuel and the cost charged. */
  app.get("/equipment", { preHandler: requireTenant("equipment.view") }, async (req) => {
    const { from, to } = dateRange(req.query as { from?: string; to?: string });
    return tenantTx(req, async (db) => {
      const rows = (await db.query<{ id: string; code: string; name: string; ownership: string; rate: number; idle_pct: number; active: boolean; op: number; idle: number; bd: number;
        fuel: number; amount: number; days: number; projects: string[] | null }>(
        `SELECT m.id, m.code, m.name, m.ownership, m.hourly_rate::float8 AS rate, m.idle_rate_pct::float8 AS idle_pct, m.is_active AS active,
                coalesce(sum(t.operating_hours), 0)::float8 AS op, coalesce(sum(t.idle_hours), 0)::float8 AS idle, coalesce(sum(t.breakdown_hours), 0)::float8 AS bd,
                coalesce(sum(t.fuel_liters), 0)::float8 AS fuel, coalesce(sum(t.amount), 0)::float8 AS amount, count(t.id)::int AS days,
                array_agg(DISTINCT p.code) FILTER (WHERE p.code IS NOT NULL) AS projects
           FROM machines m LEFT JOIN equipment_timesheets t ON t.machine_id = m.id AND t.work_date BETWEEN $1::date AND $2::date LEFT JOIN projects p ON p.id = t.project_id
          GROUP BY m.id ORDER BY m.code`, [from, to])).rows;
      return { from, to, items: rows.map((r) => ({ id: r.id, code: r.code, name: r.name, ownership: r.ownership, hourlyRate: r.rate, idleRatePct: r.idle_pct, isActive: r.active,
        operatingHours: r.op, idleHours: r.idle, breakdownHours: r.bd, fuelLiters: r.fuel, charged: r2(r.amount), days: r.days, projects: r.projects ?? [],
        utilisation: utilisation(r.op, r.idle, r.bd) })) };
    }, { readOnly: true });
  });
}
