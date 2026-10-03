import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../../db/pool.ts";
import { addMonths, finalAcceptanceBlockers } from "../../lib/contracting/handover.ts";
import { resolveParam, type Regime } from "../../lib/contracting/params.ts";
import { AppError, badRequest, notFound } from "../../lib/errors.ts";
import { auditTenant, isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";
import { today } from "../restaurants/batches.ts";

// Handover, the defects liability period and closing a contract (docs/contracting/ARCHITECTURE.md, C12).
// Taking over starts the DLP (the contract's months) and, for works the decennial liability covers, its ten years
// (a verified regulatory value; while unverified it is shown as pending, never assumed). Snags and defects are
// tracked to verified. Final acceptance needs them all verified; the contract is then completed (its final IPC may
// follow), and closed once its retention is released and its guarantees are returned.

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح");
const optText = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => v || null);
const conflict = (m: string, code = "invalid_state") => new AppError(409, code, m);
const notFuture = (d: string | null | undefined, what: string) => { if (d && d > today()) throw badRequest(`${what} لا يكون في المستقبل`); };
// Retention still held on a contract: what its invoiced IPCs retained, less what was released.
const HELD = `coalesce((SELECT sum(i.retention_current) FROM ipcs i WHERE i.contract_id = k.id AND i.status = 'invoiced'), 0)
            - coalesce((SELECT sum(r.amount) FROM retention_releases r WHERE r.contract_id = k.id), 0)`;

interface ContractRow { id: string; status: string; role: string; dlp_months: number; governing_regime: Regime; specialty: string; number: string }
async function contract(db: Db, id: string, lock = false) {
  const c = (await db.query<ContractRow>(
    `SELECT k.id, k.status, k.role, k.dlp_months, k.governing_regime, p.specialty, k.number FROM contracts k JOIN projects p ON p.id = k.project_id WHERE k.id = $1${lock ? " FOR UPDATE OF k" : ""}`, [id])).rows[0];
  if (!c) throw notFound("العقد غير موجود");
  return c;
}
const handoverOf = async (db: Db, id: string) => (await db.query<{ taking_over_on: string; dlp_ends_on: string; final_on: string | null }>(
  "SELECT taking_over_on::text, dlp_ends_on::text, final_on::text FROM contract_handovers WHERE contract_id = $1", [id])).rows[0] ?? null;
// The decennial liability covers buildings and fixed structures; a telecom site rollout or an O&M contract is not one.
const DECENNIAL = new Set(["BUILDING", "LINEAR", "MEP", "FITOUT", "EPC"]);

export default async function handoverRoutes(app: FastifyInstance) {
  app.get("/contracts/:id/handover", { preHandler: requireTenant("handover.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const c = await contract(db, id);
      const h = (await db.query(
        `SELECT taking_over_on::text AS "takingOverOn", taking_over_ref AS "takingOverRef", dlp_months AS "dlpMonths", dlp_ends_on::text AS "dlpEndsOn", final_on::text AS "finalOn",
                final_ref AS "finalRef", early_final_reason AS "earlyFinalReason", decennial_months AS "decennialMonths", decennial_until::text AS "decennialUntil",
                decennial_basis AS "decennialBasis", insurer, policy_no AS "policyNo", policy_until::text AS "policyUntil", notes
           FROM contract_handovers WHERE contract_id = $1`, [id])).rows[0] ?? null;
      const items = (await db.query(
        `SELECT h.id, h.number, h.kind, h.description, h.location, h.reported_on::text AS "reportedOn", h.due_on::text AS "dueOn", h.status, h.fixed_on::text AS "fixedOn",
                h.verified_on::text AS "verifiedOn", s.name AS supplier, (h.status = 'open' AND h.due_on < $2::date) AS overdue
           FROM handover_items h LEFT JOIN suppliers s ON s.id = h.supplier_id WHERE h.contract_id = $1 ORDER BY h.status = 'verified', h.number`, [id, today()])).rows;
      const k = (await db.query<{ held: string; guarantees: number; in_progress: number }>(
        `SELECT (${HELD})::text AS held,
                (SELECT count(*)::int FROM bank_guarantees g WHERE g.contract_id = k.id AND g.status = 'active') AS guarantees,
                (SELECT count(*)::int FROM ipcs i WHERE i.contract_id = k.id AND i.status IN ('draft', 'submitted', 'certified')) AS in_progress
           FROM contracts k WHERE k.id = $1`, [id])).rows[0]!;
      const guarantees = (await db.query(`SELECT id, kind, number, bank, amount::float8 AS amount, expires_on::text AS "expiresOn" FROM bank_guarantees WHERE contract_id = $1 AND status = 'active' ORDER BY kind`, [id])).rows;
      return { status: c.status, role: c.role, dlpMonths: c.dlp_months, decennialApplies: DECENNIAL.has(c.specialty), handover: h, items,
        retentionHeld: Number(k.held), activeGuarantees: guarantees, ipcsInProgress: k.in_progress };
    }, { readOnly: true });
  });

  /** Taking over (provisional acceptance): the DLP runs from here, and the decennial liability where it applies. */
  app.post("/contracts/:id/taking-over", { preHandler: requireTenant("handover.accept") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ date, reference: z.string().trim().min(1).max(80), notes: optText(1000) }).parse(req.body);
    notFuture(b.date, "تاريخ الاستلام");
    return tenantTx(req, async (db) => {
      const c = await contract(db, id, true);
      if (c.status !== "active") throw conflict("الاستلام الابتدائي لعقد مفعّل");
      if (await handoverOf(db, id)) throw conflict("سُجّل الاستلام الابتدائي لهذا العقد من قبل", "duplicate");
      let decennial: { months: number; until: string; basis: string } | null = null;
      let decennialNote: string | null = null;
      if (DECENNIAL.has(c.specialty)) {
        try {
          const p = await resolveParam(db, "decennial_liability_months", { date: b.date, regime: c.governing_regime });
          decennial = { months: p.value, until: addMonths(b.date, p.value), basis: `${p.legalBasis}، ${p.sourceTitle}` };
        } catch (e) {
          if (!(e instanceof AppError) || !["param_unverified", "param_missing"].includes(e.code)) throw e;
          decennialNote = "مدة المسؤولية العشرية لم يوثّقها مدير المنصة بعد، فلم تُحسب نهايتها";
        }
      }
      await db.query(
        `INSERT INTO contract_handovers (tenant_id, contract_id, taking_over_on, taking_over_ref, dlp_months, dlp_ends_on, decennial_months, decennial_until, decennial_basis, notes, created_by)
         VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, app_user_id())`,
        [id, b.date, b.reference, c.dlp_months, addMonths(b.date, c.dlp_months), decennial?.months ?? null, decennial?.until ?? null, decennial?.basis ?? null, b.notes]);
      await auditTenant(db, req, "contract.taking_over", "contract", id, { date: b.date });
      return { ok: true, dlpEndsOn: addMonths(b.date, c.dlp_months), decennialUntil: decennial?.until ?? null, note: decennialNote };
    });
  });

  app.post("/contracts/:id/handover-items", { preHandler: requireTenant("handover.record") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ kind: z.enum(["snag", "defect"]), description: z.string().trim().min(3).max(1000), location: optText(200), reportedOn: date,
      dueOn: date.nullable().optional().transform((v) => v ?? null), supplierId: z.string().uuid().nullable().optional().transform((v) => v ?? null) }).parse(req.body);
    notFuture(b.reportedOn, "تاريخ الإبلاغ");
    if (b.dueOn && b.dueOn < b.reportedOn) throw badRequest("موعد الإصلاح قبل الإبلاغ");
    const out = await tenantTx(req, async (db) => {
      await contract(db, id, true);
      const h = await handoverOf(db, id);
      if (!h) throw conflict("سجّل الاستلام الابتدائي أولاً: الملاحظات والعيوب بعده");
      if (h.final_on) throw conflict("استُلم العقد نهائياً: العيب بعد ذلك مطالبة بالمسؤولية العشرية أو بالضمان القانوني", "final_accepted");
      if (b.reportedOn < h.taking_over_on) throw badRequest("الإبلاغ قبل الاستلام الابتدائي");
      if (b.kind === "defect" && b.reportedOn > h.dlp_ends_on) throw badRequest(`انتهت فترة الضمان في ${h.dlp_ends_on}`);
      const n = (await db.query<{ n: number }>("SELECT coalesce(max(number), 0)::int + 1 AS n FROM handover_items WHERE contract_id = $1", [id])).rows[0]!.n;
      const r = (await db.query<{ id: string }>(
        `INSERT INTO handover_items (tenant_id, contract_id, number, kind, description, location, reported_on, due_on, supplier_id, created_by)
         VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, app_user_id()) RETURNING id`, [id, n, b.kind, b.description, b.location, b.reportedOn, b.dueOn, b.supplierId])).rows[0]!;
      return { id: r.id, number: n };
    });
    return reply.status(201).send(out);
  });

  /** Fixed by the responsible party, then verified on site; each with its date. */
  app.post("/handover-items/:id/:action", { preHandler: requireTenant("handover.record") }, async (req) => {
    const { id, action } = req.params as { id: string; action: string };
    if (!isUuid(id) || !["fix", "verify"].includes(action)) throw notFound();
    const b = z.object({ date }).parse(req.body);
    notFuture(b.date, "التاريخ");
    await tenantTx(req, async (db) => {
      const h = (await db.query<{ status: string; fixed_on: string | null; reported_on: string; created_by: string }>(
        "SELECT status, fixed_on::text, reported_on::text, created_by FROM handover_items WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!h) throw notFound();
      if (action === "fix") {
        if (h.status !== "open") throw conflict("سُجّل إصلاحه من قبل");
        if (b.date < h.reported_on) throw badRequest("الإصلاح قبل الإبلاغ");
        await db.query("UPDATE handover_items SET status = 'fixed', fixed_on = $2 WHERE id = $1", [id, b.date]);
      } else {
        if (h.status !== "fixed") throw conflict("يُتحقق من الإصلاح بعد تسجيله");
        if (b.date < h.fixed_on!) throw badRequest("التحقق قبل الإصلاح");
        await db.query("UPDATE handover_items SET status = 'verified', verified_on = $2, verified_by = app_user_id() WHERE id = $1", [id, b.date]);
      }
      await auditTenant(db, req, `handover_item.${action}`, "handover_item", id);
    });
    return { ok: true };
  });

  app.put("/contracts/:id/decennial", { preHandler: requireTenant("handover.accept") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ insurer: optText(120), policyNo: optText(80), policyUntil: date.nullable().optional().transform((v) => v ?? null) }).parse(req.body);
    await tenantTx(req, async (db) => {
      const r = await db.query("UPDATE contract_handovers SET insurer = $2, policy_no = $3, policy_until = $4 WHERE contract_id = $1", [id, b.insurer, b.policyNo, b.policyUntil]);
      if (!r.rowCount) throw conflict("سجّل الاستلام الابتدائي أولاً");
    });
    return { ok: true };
  });

  /** Final acceptance: every snag and defect verified, no IPC in progress, the DLP over (or the owner's early release). */
  app.post("/contracts/:id/final-acceptance", { preHandler: requireTenant("handover.accept") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ date, reference: z.string().trim().min(1).max(80), earlyReason: optText(500) }).parse(req.body);
    notFuture(b.date, "تاريخ الاستلام النهائي");
    return tenantTx(req, async (db) => {
      const c = await contract(db, id, true);
      if (c.status !== "active") throw conflict("الاستلام النهائي لعقد مفعّل");
      const h = await handoverOf(db, id);
      if (!h) throw conflict("الاستلام النهائي بعد الابتدائي");
      if (b.date < h.taking_over_on) throw badRequest("الاستلام النهائي قبل الابتدائي");
      const s = (await db.query<{ open: number; ipcs: number }>(
        `SELECT (SELECT count(*)::int FROM handover_items WHERE contract_id = $1 AND status <> 'verified') AS open,
                (SELECT count(*)::int FROM ipcs WHERE contract_id = $1 AND status IN ('draft', 'submitted', 'certified')) AS ipcs`, [id])).rows[0]!;
      const blockers = finalAcceptanceBlockers({ openItems: s.open, ipcsInProgress: s.ipcs, dlpEndsOn: h.dlp_ends_on, date: b.date, earlyReason: b.earlyReason });
      if (blockers.length) throw new AppError(409, "not_ready", `لا يكتمل الاستلام النهائي: ${blockers.join("؛ ")}`, { blockers });
      await db.query("UPDATE contract_handovers SET final_on = $2, final_ref = $3, early_final_reason = $4 WHERE contract_id = $1",
        [id, b.date, b.reference, b.date < h.dlp_ends_on ? b.earlyReason : null]);
      await db.query("UPDATE contracts SET status = 'completed' WHERE id = $1", [id]);
      await auditTenant(db, req, "contract.final_acceptance", "contract", id, { date: b.date, early: b.date < h.dlp_ends_on });
      return { ok: true };
    });
  });

  /** Closing: completed, no retention held, every guarantee returned. */
  app.post("/contracts/:id/close", { preHandler: requireTenant("handover.accept") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    await tenantTx(req, async (db) => {
      const c = await contract(db, id, true);
      if (c.status !== "completed") throw conflict("يُقفل العقد بعد استلامه النهائي");
      const s = (await db.query<{ held: string; guarantees: number; ipcs: number }>(
        `SELECT (${HELD})::text AS held, (SELECT count(*)::int FROM bank_guarantees g WHERE g.contract_id = k.id AND g.status = 'active') AS guarantees,
                (SELECT count(*)::int FROM ipcs i WHERE i.contract_id = k.id AND i.status IN ('draft', 'submitted', 'certified', 'approved')) AS ipcs
           FROM contracts k WHERE k.id = $1`, [id])).rows[0]!;
      const left: string[] = [];
      if (Math.round(Number(s.held) * 100) > 0) left.push(`محتجز قائم ${Number(s.held).toFixed(2)}`);
      if (s.guarantees) left.push(`${s.guarantees} ضمان بنكي لم يُرد`);
      if (s.ipcs) left.push("مستخلص لم تصدر فاتورته");
      if (left.length) throw new AppError(409, "not_ready", `لا يُقفل العقد: ${left.join("؛ ")}`, { blockers: left });
      await db.query("UPDATE contracts SET status = 'closed' WHERE id = $1", [id]);
      await auditTenant(db, req, "contract.closed", "contract", id);
    });
    return { ok: true };
  });

  /** Every contract after taking over: in the DLP, awaiting closing, or under the decennial liability. */
  app.get("/contracting/handovers", { preHandler: requireTenant("handover.view") }, async (req) =>
    tenantTx(req, async (db) => {
      const t = today();
      return {
        today: t,
        items: (await db.query(
          `SELECT k.id, k.number, k.title, k.role, k.status, p.code AS "projectCode", p.name AS "projectName", h.taking_over_on::text AS "takingOverOn", h.dlp_ends_on::text AS "dlpEndsOn",
                  h.final_on::text AS "finalOn", h.decennial_until::text AS "decennialUntil", h.policy_until::text AS "policyUntil", (h.dlp_ends_on - $1::date)::int AS "dlpDaysLeft",
                  (SELECT count(*)::int FROM handover_items i WHERE i.contract_id = k.id AND i.status <> 'verified') AS "openItems",
                  (SELECT count(*)::int FROM handover_items i WHERE i.contract_id = k.id AND i.status = 'open' AND i.due_on < $1::date) AS "overdueItems",
                  (${HELD})::float8 AS "retentionHeld",
                  (SELECT count(*)::int FROM bank_guarantees g WHERE g.contract_id = k.id AND g.status = 'active') AS "activeGuarantees"
             FROM contract_handovers h JOIN contracts k ON k.id = h.contract_id JOIN projects p ON p.id = k.project_id
            ORDER BY k.status = 'closed', h.dlp_ends_on`, [t])).rows,
      };
    }, { readOnly: true }));
}
