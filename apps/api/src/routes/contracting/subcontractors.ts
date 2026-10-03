import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { postRetentionRelease, postSubcontractAdvance } from "../../lib/accounting/posting.ts";
import { ensureContractingAccounts } from "../../lib/contracting/accounts.ts";
import { subVatMode } from "../../lib/contracting/subIpc.ts";
import { AppError, badRequest, notFound } from "../../lib/errors.ts";
import { auditTenant, isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";
import { today } from "../restaurants/batches.ts";
import { idempotencyKey } from "../restaurants/purchases.ts";

// Subcontractors (docs/contracting/ARCHITECTURE.md, C4): qualification of the supplier as a subcontractor, advances
// paid to it, and retention released in both directions, with the retention aging. The subcontract itself is a
// contract of role SUB (projects.ts) and its IPCs are ipcs.ts.

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح");
const optDate = date.nullable().optional().transform((v) => v ?? null);
const conflict = (m: string, code = "invalid_state") => new AppError(409, code, m);
const optText = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => v || null);

export default async function subcontractorRoutes(app: FastifyInstance) {
  // Every supplier with its qualification (a supplier becomes a subcontractor once it has a profile).
  app.get("/subcontractors", { preHandler: requireTenant("subcontractors.view") }, async (req) =>
    tenantTx(req, async (db) => ({
      today: today(),
      items: (await db.query(
        `SELECT s.id AS "supplierId", s.code, s.name, s.tax_id AS "taxId", s.residency, p.cr_number AS "crNumber", p.classification_field AS "classificationField",
                p.classification_grade AS "classificationGrade", p.classification_expiry::text AS "classificationExpiry", p.zakat_cert_expiry::text AS "zakatCertExpiry",
                p.gosi_cert_expiry::text AS "gosiCertExpiry", p.insurance_expiry::text AS "insuranceExpiry", p.specialties, p.status, p.rating, p.rated_at::text AS "ratedAt", p.notes,
                (SELECT count(*)::int FROM contracts k WHERE k.supplier_id = s.id AND k.status = 'active') AS "activeContracts",
                (SELECT coalesce(sum(k.value), 0)::float8 FROM contracts k WHERE k.supplier_id = s.id AND k.status <> 'draft') AS "contractValue",
                (SELECT coalesce(sum(i.retention_current), 0)::float8 FROM ipcs i JOIN contracts k ON k.id = i.contract_id WHERE k.supplier_id = s.id AND i.status = 'invoiced')
                  - (SELECT coalesce(sum(r.amount), 0)::float8 FROM retention_releases r JOIN contracts k ON k.id = r.contract_id WHERE k.supplier_id = s.id) AS "retentionHeld",
                -- The first of its documents to expire (classification, zakat, GOSI, insurance).
                (SELECT min(x) FROM unnest(ARRAY[p.classification_expiry, p.zakat_cert_expiry, p.gosi_cert_expiry, p.insurance_expiry]) x)::text AS "nextExpiry"
           FROM suppliers s JOIN subcontractor_profiles p ON p.supplier_id = s.id ORDER BY p.status = 'approved' DESC, s.name`)).rows,
    }), { readOnly: true }));

  const profileBody = z.object({
    crNumber: optText(30), classificationField: optText(120), classificationGrade: optText(20), classificationExpiry: optDate,
    zakatCertExpiry: optDate, gosiCertExpiry: optDate, insuranceExpiry: optDate, specialties: optText(300),
    rating: z.number().int().min(1).max(5).nullable().optional().transform((v) => v ?? null), notes: optText(1000),
  });
  // Creating or updating the qualification; a change to an approved subcontractor's documents keeps it approved.
  app.put("/subcontractors/:supplierId", { preHandler: requireTenant("subcontractors.edit", "subcontractors.create") }, async (req) => {
    const { supplierId } = req.params as { supplierId: string };
    if (!isUuid(supplierId)) throw notFound();
    const b = profileBody.parse(req.body);
    await tenantTx(req, async (db) => {
      if (!(await db.query("SELECT 1 FROM suppliers WHERE id = $1", [supplierId])).rowCount) throw notFound("المورد غير موجود");
      await db.query(
        `INSERT INTO subcontractor_profiles (tenant_id, supplier_id, cr_number, classification_field, classification_grade, classification_expiry, zakat_cert_expiry, gosi_cert_expiry,
                                             insurance_expiry, specialties, rating, rated_at, notes)
         VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN $10::smallint IS NULL THEN NULL ELSE current_date END, $11)
         ON CONFLICT (tenant_id, supplier_id) DO UPDATE SET cr_number = EXCLUDED.cr_number, classification_field = EXCLUDED.classification_field,
           classification_grade = EXCLUDED.classification_grade, classification_expiry = EXCLUDED.classification_expiry, zakat_cert_expiry = EXCLUDED.zakat_cert_expiry,
           gosi_cert_expiry = EXCLUDED.gosi_cert_expiry, insurance_expiry = EXCLUDED.insurance_expiry, specialties = EXCLUDED.specialties, notes = EXCLUDED.notes,
           rating = EXCLUDED.rating,
           rated_at = CASE WHEN EXCLUDED.rating IS DISTINCT FROM subcontractor_profiles.rating THEN current_date ELSE subcontractor_profiles.rated_at END`,
        [supplierId, b.crNumber, b.classificationField, b.classificationGrade, b.classificationExpiry, b.zakatCertExpiry, b.gosiCertExpiry, b.insuranceExpiry, b.specialties,
          b.rating, b.notes]);
      await auditTenant(db, req, "subcontractor.saved", "supplier", supplierId, { rating: b.rating });
    });
    return { ok: true };
  });

  app.post("/subcontractors/:supplierId/:action", { preHandler: requireTenant("subcontractors.approve") }, async (req) => {
    const { supplierId, action } = req.params as { supplierId: string; action: string };
    if (!isUuid(supplierId) || !["approve", "suspend"].includes(action)) throw notFound();
    const b = z.object({ reason: z.string().trim().max(300).optional() }).parse(req.body ?? {});
    await tenantTx(req, async (db) => {
      const p = (await db.query<{ residency: string; cr: string | null; field: string | null; expiry: string | null; name: string }>(
        `SELECT s.residency, p.cr_number AS cr, p.classification_field AS field, p.classification_expiry::text AS expiry, s.name
           FROM subcontractor_profiles p JOIN suppliers s ON s.id = p.supplier_id WHERE p.supplier_id = $1 FOR UPDATE OF p`, [supplierId])).rows[0];
      if (!p) throw notFound("سجّل تأهيل مقاول الباطن أولاً");
      if (action === "approve") {
        // A resident subcontractor is registered and classified; a non-resident has neither locally.
        if (p.residency !== "non_resident" && (!p.cr || !p.field || !p.expiry)) throw badRequest("أدخل السجل التجاري ومجال التصنيف وتاريخ انتهائه قبل الاعتماد");
        if (p.expiry && p.expiry < today()) throw badRequest("التصنيف منتهٍ: حدّثه قبل الاعتماد");
        await db.query("UPDATE subcontractor_profiles SET status = 'approved', approved_by = app_user_id(), approved_at = now() WHERE supplier_id = $1", [supplierId]);
      } else {
        if (!b.reason || b.reason.length < 3) throw badRequest("اذكر سبب الإيقاف");
        await db.query("UPDATE subcontractor_profiles SET status = 'suspended' WHERE supplier_id = $1", [supplierId]);
      }
      await auditTenant(db, req, `subcontractor.${action === "approve" ? "approved" : "suspended"}`, "supplier", supplierId, { reason: b.reason ?? null });
    });
    return { ok: true };
  });

  // ── Advance paid to a subcontractor ───────────────────────────────────────────────────────
  app.post("/contracts/:id/subcontract-advance", { preHandler: requireTenant("ipcs.invoice") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const key = idempotencyKey(req);
    const b = z.object({ amount: z.number().positive().max(1e13).optional(), supplierInvoice: optText(60), advanceDate: date.optional() }).parse(req.body ?? {});
    if (b.advanceDate && b.advanceDate > today()) throw badRequest("التاريخ في المستقبل");
    const out = await tenantTx(req, async (db) => {
      const dup = (await db.query<{ id: string }>("SELECT id FROM subcontract_advances WHERE idempotency_key = $1", [key])).rows[0];
      if (dup) return { id: dup.id, replay: true };
      const c = (await db.query<{ role: string; status: string; value: string; pct: string; residency: string; tax_id: string | null; number: string }>(
        `SELECT k.role, k.status, k.value::text, k.advance_pct::text AS pct, s.residency, s.tax_id, k.number
           FROM contracts k JOIN suppliers s ON s.id = k.supplier_id WHERE k.id = $1 FOR UPDATE OF k`, [id])).rows[0];
      if (!c || c.role !== "SUB") throw notFound("عقد الباطن غير موجود");
      if (c.status !== "active") throw conflict("الدفعة المقدمة على عقد باطن مفعّل");
      const allowed = Math.round(Number(c.value) * Number(c.pct));
      const already = Math.round(Number((await db.query<{ v: string }>("SELECT coalesce(sum(taxable), 0)::text AS v FROM subcontract_advances WHERE contract_id = $1", [id])).rows[0]!.v) * 100);
      const amount = b.amount === undefined ? allowed - already : Math.round(b.amount * 100);
      if (amount <= 0) throw conflict("لا متبقٍ من الدفعة المقدمة المتفق عليها");
      if (already + amount > allowed) throw conflict(`الدفعة أكبر من المتفق عليه (${c.pct}%)`, "advance_exceeds_contract");
      const mode = subVatMode(c.residency, c.tax_id);
      if (mode === "charged" && !b.supplierInvoice) throw new AppError(422, "supplier_invoice_required", "مقاول الباطن مسجل في الضريبة: أدخل رقم فاتورة الدفعة المقدمة");
      const rate = Number((await db.query<{ r: string }>("SELECT vat_rate_percent::text AS r FROM tenant_settings")).rows[0]!.r);
      const vat = Math.round(amount * rate / 100);
      const n = (await db.query<{ n: number }>("SELECT coalesce(max(number), 0)::int + 1 AS n FROM subcontract_advances WHERE contract_id = $1", [id])).rows[0]!.n;
      await ensureContractingAccounts(db);
      const r = (await db.query<{ id: string }>(
        `INSERT INTO subcontract_advances (tenant_id, contract_id, number, taxable, vat, reverse_charge_vat, supplier_invoice, advance_date, idempotency_key, created_by)
         VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, app_user_id()) RETURNING id`,
        [id, n, amount / 100, mode === "charged" ? vat / 100 : 0, mode === "reverse" ? vat / 100 : 0, b.supplierInvoice, b.advanceDate ?? today(), key])).rows[0]!;
      await postSubcontractAdvance(db, r.id);
      await auditTenant(db, req, "subcontract.advance", "contract", id, { amount: amount / 100 });
      return { id: r.id, replay: false };
    });
    return reply.status(out.replay ? 200 : 201).send(out);
  });

  // ── Retention ─────────────────────────────────────────────────────────────────────────────
  /** Held = retention on the IPCs invoiced (ours by the client) or recorded (a subcontractor's), less releases. */
  const heldSql = `coalesce((SELECT sum(i.retention_current) FROM ipcs i WHERE i.contract_id = k.id AND i.status = 'invoiced'), 0)
                 - coalesce((SELECT sum(r.amount) FROM retention_releases r WHERE r.contract_id = k.id), 0)`;

  app.post("/contracts/:id/retention-release", { preHandler: requireTenant("retention.release") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const key = idempotencyKey(req);
    const b = z.object({ amount: z.number().positive().max(1e13), releasedOn: date.optional(), method: z.enum(["bank_transfer", "cash", "cheque"]).optional(),
      reason: z.string().trim().min(3, "اذكر سبب الإفراج (الاستلام الابتدائي، نهاية فترة الضمان…)").max(300) }).parse(req.body);
    const out = await tenantTx(req, async (db) => {
      const dup = (await db.query<{ id: string }>("SELECT id FROM retention_releases WHERE idempotency_key = $1", [key])).rows[0];
      if (dup) return { id: dup.id, replay: true };
      if (!(await db.query("SELECT 1 FROM contracts WHERE id = $1 FOR UPDATE", [id])).rowCount) throw notFound("العقد غير موجود");
      // Read after the lock: a release committed by another request meanwhile is counted.
      const c = (await db.query<{ role: string; held: string; number: string }>(`SELECT k.role, (${heldSql})::text AS held, k.number FROM contracts k WHERE k.id = $1`, [id])).rows[0]!;
      if (Math.round(b.amount * 100) > Math.round(Number(c.held) * 100)) throw conflict(`المحتجز القائم ${Number(c.held).toFixed(2)} فقط`, "exceeds_retention");
      if (c.role === "MAIN" && !b.method) throw badRequest("كيف قبضت المحتجز من العميل؟");
      await ensureContractingAccounts(db);
      const r = (await db.query<{ id: string }>(
        `INSERT INTO retention_releases (tenant_id, contract_id, amount, released_on, method, reason, idempotency_key, created_by)
         VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, app_user_id()) RETURNING id`,
        [id, b.amount, b.releasedOn ?? today(), c.role === "MAIN" ? b.method : null, b.reason, key])).rows[0]!;
      await postRetentionRelease(db, r.id);
      await auditTenant(db, req, "retention.released", "contract", id, { amount: b.amount, role: c.role });
      return { id: r.id, replay: false };
    });
    return reply.status(out.replay ? 200 : 201).send(out);
  });

  /**
   * Retention aging, per contract: receivable (held by clients) and payable (held from subcontractors). Releases
   * settle the oldest IPCs first; the rest is aged from the IPC's period end. The release is usually due at the end
   * of the defects liability period, shown for each contract.
   */
  app.get("/contracting/retention", { preHandler: requireTenant("retention.view") }, async (req) =>
    tenantTx(req, async (db) => {
      const asOf = today();
      const rows = (await db.query<{ id: string; number: string; title: string; role: string; party: string; project: string; dlp_end: string | null; released: string;
        items: { d: string; amt: string }[] | null }>(
        `SELECT k.id, k.number, k.title, k.role, coalesce(c.name, s.name) AS party, p.code AS project,
                (SELECT (max(i.period_to) + make_interval(months => k.dlp_months))::date::text FROM ipcs i WHERE i.contract_id = k.id AND i.kind = 'final' AND i.status = 'invoiced') AS dlp_end,
                coalesce((SELECT sum(r.amount) FROM retention_releases r WHERE r.contract_id = k.id), 0)::text AS released,
                (SELECT json_agg(json_build_object('d', i.period_to, 'amt', i.retention_current) ORDER BY i.number) FROM ipcs i
                  WHERE i.contract_id = k.id AND i.status = 'invoiced' AND i.retention_current > 0) AS items
           FROM contracts k JOIN projects p ON p.id = k.project_id LEFT JOIN customers c ON c.id = k.customer_id LEFT JOIN suppliers s ON s.id = k.supplier_id
          WHERE k.status <> 'draft'`)).rows;
      const day = (d: string) => Date.parse(`${d}T00:00:00Z`);
      const now = day(asOf);
      const items = rows.map((r) => {
        let released = Math.round(Number(r.released) * 100);
        const b = { d0_180: 0, d181_365: 0, d366_730: 0, over730: 0 };
        for (const it of r.items ?? []) {
          const amt = Math.round(Number(it.amt) * 100);
          const used = Math.min(released, amt);
          released -= used;
          const open = amt - used;
          if (!open) continue;
          const age = Math.floor((now - day(it.d)) / 86_400_000);
          if (age <= 180) b.d0_180 += open; else if (age <= 365) b.d181_365 += open; else if (age <= 730) b.d366_730 += open; else b.over730 += open;
        }
        const total = b.d0_180 + b.d181_365 + b.d366_730 + b.over730;
        return { contractId: r.id, number: r.number, title: r.title, role: r.role, party: r.party, project: r.project, dlpEnd: r.dlp_end,
          d0_180: b.d0_180 / 100, d181_365: b.d181_365 / 100, d366_730: b.d366_730 / 100, over730: b.over730 / 100, total: total / 100 };
      }).filter((x) => x.total !== 0);
      const sum = (role: string) => items.filter((x) => x.role === role).reduce((a, x) => a + Math.round(x.total * 100), 0) / 100;
      return { asOf, items, totals: { receivable: sum("MAIN"), payable: sum("SUB") } };
    }, { readOnly: true }));
}
