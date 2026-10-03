import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../../db/pool.ts";
import { accountIdOf, ensureContractingAccounts } from "../../lib/contracting/accounts.ts";
import { computeIpc, h, lineToDate, linePrevious, type IpcLineInput } from "../../lib/contracting/ipc.ts";
import { computeSubIpc, subVatMode } from "../../lib/contracting/subIpc.ts";
import { checkVariationCaps, type VoCaps } from "../../lib/contracting/variations.ts";
import { postSubcontractIpc } from "../../lib/accounting/posting.ts";
import { AppError, badRequest, notFound } from "../../lib/errors.ts";
import { formatMoney } from "../../lib/money.ts";
import { auditTenant, isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";
import { addDays, today } from "../restaurants/batches.ts";
import { idempotencyKey } from "../restaurants/purchases.ts";
import { issueSalesDocument, sendToZatca, type DocInput } from "../restaurants/sales.ts";
import { currentVersion } from "./projects.ts";

// Client payment certificates (IPCs), the advance, variation orders and claims (docs/contracting/ARCHITECTURE.md, C3).
// The IPC is the contractual document; its tax invoice (388, or 386 for the advance, 381 for delay damages) is issued
// by the existing sales-document engine and sent through the existing ZATCA service, never by a parallel path.

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح");
const conflict = (m: string, code = "invalid_state") => new AppError(409, code, m);
const riyals = (v: number) => Math.round(v) / 100;
const APPROVED = "('approved', 'invoiced')";

interface ContractRow { id: string; status: string; value: string; role: "MAIN" | "SUB"; customer_id: string; supplier_id: string | null; residency: string | null; supplier_tax_id: string | null;
  advance_pct: string; retention_pct: string; retention_cap_pct: string; ld_rate: string;
  ld_cap: string | null; government_client: boolean; regime: string; tender_date: string | null; applied_params: Record<string, { value: number }>; claim_notice_days: number;
  customer_type: string; vat_number: string | null; other_id: string | null; project_branch: string | null; number: string }
async function loadContract(db: Db, id: string, lock = false) {
  const c = (await db.query<ContractRow>(
    `SELECT k.id, k.status, k.value::text, k.role, k.customer_id, k.supplier_id, s.residency, s.tax_id AS supplier_tax_id, k.advance_pct::text, k.retention_pct::text, k.retention_cap_pct::text, k.ld_rate_per_day::text AS ld_rate,
            k.ld_cap_pct::text AS ld_cap, k.government_client, k.governing_regime AS regime, k.tender_date::text, k.applied_params, k.claim_notice_days, k.number,
            c.customer_type, c.vat_number, c.other_id, p.branch_id AS project_branch
       FROM contracts k LEFT JOIN customers c ON c.id = k.customer_id LEFT JOIN suppliers s ON s.id = k.supplier_id JOIN projects p ON p.id = k.project_id
      WHERE k.id = $1 ${lock ? "FOR UPDATE OF k" : ""}`, [id])).rows[0];
  if (!c) throw notFound("العقد غير موجود");
  return c;
}
const invoiceTypeOf = (c: ContractRow) => (c.customer_type === "business" || c.vat_number || c.other_id || c.government_client ? "standard" : "simplified") as "standard" | "simplified";
const vatRate = async (db: Db) => Number((await db.query<{ r: string }>("SELECT vat_rate_percent::text AS r FROM tenant_settings")).rows[0]?.r ?? 15);

/** What the contract's approved IPCs and advances add up to (halalas). */
async function history(db: Db, contractId: string) {
  const r = (await db.query<{ prev: string; retained: string; ld: string; recovered: string; advance: string }>(
    `SELECT coalesce((SELECT gross_to_date FROM ipcs WHERE contract_id = $1 AND status IN ${APPROVED} ORDER BY number DESC LIMIT 1), 0)::text AS prev,
            coalesce((SELECT sum(retention_current) FROM ipcs WHERE contract_id = $1 AND status IN ${APPROVED}), 0)::text AS retained,
            coalesce((SELECT sum(ld_amount) FROM ipcs WHERE contract_id = $1 AND status IN ${APPROVED}), 0)::text AS ld,
            coalesce((SELECT sum(advance_recovery) FROM ipcs WHERE contract_id = $1 AND status IN ${APPROVED}), 0)::text AS recovered,
            -- The advance invoiced, less what credit notes refunded of it.
            (coalesce((SELECT sum(taxable) FROM sales_documents WHERE contract_id = $1 AND kind = 'prepayment'), 0)
              - coalesce((SELECT sum(n.taxable) FROM sales_documents n JOIN sales_documents p ON p.id = n.original_id
                           WHERE p.contract_id = $1 AND p.kind = 'prepayment' AND n.kind = 'credit_note'), 0)
              + coalesce((SELECT sum(taxable) FROM subcontract_advances WHERE contract_id = $1), 0))::text AS advance`, [contractId])).rows[0]!;
  return { previousGross: h(Number(r.prev)), retainedToDate: h(Number(r.retained)), ldToDate: h(Number(r.ld)), advanceRecovered: h(Number(r.recovered)), advanceTaxable: h(Number(r.advance)) };
}

interface LineRow { id: string; kind: "boq" | "vo" | "mos"; description: string; unit: string | null; rate: number; submitted_qty: number; certified_qty: number | null;
  previous_qty: number; submitted_amount: number | null; certified_amount: number | null; previous_amount: number; code: string | null; boq_item_id: string | null; variation_line_id: string | null }
async function linesOf(db: Db, ipcId: string) {
  return (await db.query<LineRow>(
    `SELECT l.id, l.kind, l.description, l.unit, l.rate::float8 AS rate, l.submitted_qty::float8 AS submitted_qty, l.certified_qty::float8 AS certified_qty, l.previous_qty::float8 AS previous_qty,
            l.submitted_amount::float8 AS submitted_amount, l.certified_amount::float8 AS certified_amount, l.previous_amount::float8 AS previous_amount,
            coalesce(b.code, v.code) AS code, l.boq_item_id, l.variation_line_id
       FROM ipc_lines l LEFT JOIN boq_items b ON b.id = l.boq_item_id LEFT JOIN variation_lines v ON v.id = l.variation_line_id
      WHERE l.ipc_id = $1 ORDER BY l.kind = 'mos', b.sort, v.code`, [ipcId])).rows;
}
/** The quantity/amount that counts: certified once the consultant has certified, submitted before. */
const toInput = (l: LineRow): IpcLineInput => ({ kind: l.kind, rate: l.rate, qtyToDate: l.certified_qty ?? l.submitted_qty, previousQty: l.previous_qty,
  amountToDate: l.certified_amount ?? l.submitted_amount ?? 0, previousAmount: l.previous_amount });

/** The IPC's figures: a client IPC (what we invoice), or a subcontractor's (what we owe, with set-off and reverse charge). */
async function compute(db: Db, ipc: { id: string; contract_id: string; kind: string; ld_days: number }, lines: LineRow[]) {
  const c = await loadContract(db, ipc.contract_id);
  const hist = await history(db, ipc.contract_id);
  const terms = {
    contractValue: h(Number(c.value)), retentionPct: Number(c.retention_pct), retentionCapPct: Number(c.retention_cap_pct),
    advanceTaxable: hist.advanceTaxable, advanceRecovered: hist.advanceRecovered, ldRatePerDay: h(Number(c.ld_rate)), ldCapPct: c.ld_cap === null ? null : Number(c.ld_cap), vatRatePct: await vatRate(db),
  };
  const opts = { final: ipc.kind === "final", ldDays: ipc.ld_days };
  try {
    if (c.role === "SUB") {
      const deductions = (await db.query<{ amount: string }>("SELECT amount::text FROM ipc_deductions WHERE ipc_id = $1", [ipc.id])).rows.map((d) => ({ amount: h(Number(d.amount)) }));
      return { ...computeSubIpc(lines.map(toInput), { ...terms, vatMode: subVatMode(c.residency ?? "resident", c.supplier_tax_id) }, hist, { ...opts, deductions }), role: c.role };
    }
    const r = computeIpc(lines.map(toInput), terms, hist, opts);
    return { ...r, deductions: 0, reverseChargeVat: 0, netSupply: r.current - r.advanceRecovery - r.ld, role: c.role };
  } catch (e) {
    if ((e as Error).message === "ld_cap_unknown") throw new AppError(422, "ld_cap_unknown", "لا يوجد سقف لغرامة التأخير في العقد: فعّله بقيمة نظامية موثقة أو حدد السقف المتفق عليه");
    throw e;
  }
}
const summary = (r: Awaited<ReturnType<typeof compute>>) => ({
  grossToDate: riyals(r.grossToDate), previousGross: riyals(r.previousGross), currentGross: riyals(r.current), retention: riyals(r.retention),
  advanceRecovery: riyals(r.advanceRecovery), advanceRecoveryVat: riyals(r.advanceRecoveryVat), ld: riyals(r.ld), ldVat: riyals(r.ldVat), ldCapped: r.ldCapped,
  vat: riyals(r.vat), deductions: riyals(r.deductions), reverseChargeVat: riyals(r.reverseChargeVat), netPayable: riyals(r.net),
});

async function lockIpc(db: Db, id: string) {
  const i = (await db.query<{ id: string; contract_id: string; number: number; kind: string; status: string; ld_days: number; period_to: string; payment_order_date: string | null; sales_document_id: string | null }>(
    "SELECT id, contract_id, number, kind, status, ld_days, period_to::text, payment_order_date::text, sales_document_id FROM ipcs WHERE id = $1 FOR UPDATE", [id])).rows[0];
  if (!i) throw notFound("المستخلص غير موجود");
  return i;
}

export default async function ipcRoutes(app: FastifyInstance) {
  // ── The advance (prepayment invoice, 386) ─────────────────────────────────────────────────
  app.post("/contracts/:id/advance", { preHandler: requireTenant("ipcs.invoice") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const key = idempotencyKey(req);
    const b = z.object({ amount: z.number().positive().max(1e13).optional(), paymentMeans: z.enum(["bank_transfer", "cash", "card"]).default("bank_transfer") }).parse(req.body ?? {});
    let invoiceType: "standard" | "simplified" = "standard";
    const out = await tenantTx(req, async (db) => {
      const dup = (await db.query<{ id: string; doc_number: string }>("SELECT id, doc_number FROM sales_documents WHERE idempotency_key = $1", [key])).rows[0];
      if (dup) return { id: dup.id, number: dup.doc_number, replay: true };
      const c = await loadContract(db, id, true);
      if (c.status !== "active") throw conflict("الدفعة المقدمة على عقد مفعّل");
      if (c.role !== "MAIN") throw conflict("الدفعة المقدمة لمقاول الباطن تُسجَّل من «دفعة مقدمة لمقاول الباطن»");
      invoiceType = invoiceTypeOf(c);
      const allowed = Math.round(Number(c.value) * Number(c.advance_pct));
      const already = (await history(db, id)).advanceTaxable;
      const amount = b.amount === undefined ? allowed - already : h(b.amount);
      if (amount <= 0) throw conflict("لا متبقٍ من الدفعة المقدمة المتفق عليها");
      if (already + amount > allowed) throw conflict(`الدفعة أكبر من المتفق عليه في العقد (${c.advance_pct}% = ${riyals(allowed)} قبل الضريبة)`, "advance_exceeds_contract");
      await ensureContractingAccounts(db);
      const doc: DocInput = {
        kind: "prepayment", invoiceType, customerId: c.customer_id, branchId: c.project_branch, originalId: null, reason: null, supplyDate: null,
        paymentMeans: b.paymentMeans, notes: `الدفعة المقدمة على العقد ${c.number}`, contractId: id,
        lines: [{ description: `دفعة مقدمة على العقد ${c.number} / Advance payment`, quantity: 1, unitPrice: riyals(amount), discount: 0, vatCategory: "S",
          exemptionCode: null, exemptionReason: null, accountId: null }],
      };
      const r = await issueSalesDocument(db, doc, key, req);
      await auditTenant(db, req, "contract.advance", "sales_document", r.id, { contract: c.number, amount: riyals(amount) });
      return r;
    });
    const zatca = await sendToZatca(req, invoiceType, out);
    return reply.status(out.replay ? 200 : 201).send({ id: out.id, number: out.number, zatca });
  });

  // ── IPCs ──────────────────────────────────────────────────────────────────────────────────
  app.get("/contracts/:id/ipcs", { preHandler: requireTenant("ipcs.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => ({
      items: (await db.query(
        `SELECT i.id, i.number, i.kind, i.status, i.period_from::text AS "periodFrom", i.period_to::text AS "periodTo", i.current_gross::float8 AS "currentGross",
                i.gross_to_date::float8 AS "grossToDate", i.retention_current::float8 AS retention, i.advance_recovery::float8 AS "advanceRecovery", i.ld_amount::float8 AS ld,
                i.vat::float8 AS vat, i.net_payable::float8 AS "netPayable", d.doc_number AS "invoiceNumber", i.sales_document_id AS "invoiceId",
                -- A tax invoice is due within 15 days after the month the supply was completed (ZATCA contracting guideline).
                CASE WHEN i.status = 'approved' AND k.role = 'MAIN' THEN (date_trunc('month', i.period_to) + interval '1 month' + interval '14 days')::date::text END AS "invoiceDeadline",
                i.supplier_invoice AS "supplierInvoice", i.deductions::float8 AS deductions
           FROM ipcs i JOIN contracts k ON k.id = i.contract_id LEFT JOIN sales_documents d ON d.id = i.sales_document_id WHERE i.contract_id = $1 ORDER BY i.number DESC`, [id])).rows,
    }), { readOnly: true });
  });

  // A new IPC: every billable line of the contract, with what earlier approved IPCs certified as "previous".
  app.post("/contracts/:id/ipcs", { preHandler: requireTenant("ipcs.create") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ periodFrom: date, periodTo: date, kind: z.enum(["interim", "final"]).default("interim") }).parse(req.body);
    if (b.periodTo < b.periodFrom) throw badRequest("نهاية الفترة قبل بدايتها");
    if (b.periodFrom > today()) throw badRequest("فترة المستخلص لم تبدأ بعد");
    const ipcId = await tenantTx(req, async (db) => {
      const c = await loadContract(db, id, true);
      // After final acceptance the contract is completed: only its final IPC (the final account) may follow.
      if (c.status !== "active" && !(c.status === "completed" && b.kind === "final")) throw conflict(c.status === "completed" ? "استُلم العقد نهائياً: يبقى المستخلص الختامي فقط" : "المستخلصات على عقد مفعّل");
      if ((await db.query("SELECT 1 FROM ipcs WHERE contract_id = $1 AND kind = 'final' AND status IN ('approved', 'invoiced')", [id])).rowCount) throw conflict("صدر المستخلص الختامي للعقد");
      const last = (await db.query<{ id: string; period_to: string }>(`SELECT id, period_to::text FROM ipcs WHERE contract_id = $1 AND status IN ${APPROVED} ORDER BY number DESC LIMIT 1`, [id])).rows[0];
      if (last && b.periodFrom <= last.period_to) throw badRequest(`الفترة تبدأ بعد نهاية المستخلص السابق (${last.period_to})`);
      const n = (await db.query<{ n: number }>("SELECT coalesce(max(number), 0)::int + 1 AS n FROM ipcs WHERE contract_id = $1", [id])).rows[0]!.n;
      let r: { id: string };
      try {
        r = (await db.query<{ id: string }>(
          "INSERT INTO ipcs (tenant_id, contract_id, number, kind, period_from, period_to, created_by) VALUES (app_tenant_id(), $1, $2, $3, $4, $5, app_user_id()) RETURNING id",
          [id, n, b.kind, b.periodFrom, b.periodTo])).rows[0]!;
      } catch (e) { if ((e as { code?: string }).code === "23505") throw conflict("للعقد مستخلص مفتوح: أكمله أو احذفه أولاً", "ipc_open"); throw e; }
      const v = (await currentVersion(db, id))!;
      // Previous = the last approved IPC's counted (certified, else submitted) cumulative figures.
      await db.query(
        `INSERT INTO ipc_lines (tenant_id, ipc_id, kind, boq_item_id, description, unit, rate, previous_qty, submitted_qty)
         SELECT app_tenant_id(), $1, 'boq', b.id, b.code || ' — ' || b.description, b.unit, b.rate,
                coalesce((SELECT coalesce(pl.certified_qty, pl.submitted_qty) FROM ipc_lines pl WHERE pl.ipc_id = $3 AND pl.boq_item_id = b.id), 0),
                coalesce((SELECT coalesce(pl.certified_qty, pl.submitted_qty) FROM ipc_lines pl WHERE pl.ipc_id = $3 AND pl.boq_item_id = b.id), 0)
           FROM boq_items b WHERE b.version_id = $2 AND NOT b.is_section`, [r.id, v.id, last?.id ?? null]);
      await db.query(
        `INSERT INTO ipc_lines (tenant_id, ipc_id, kind, variation_line_id, description, unit, rate, previous_qty, submitted_qty)
         SELECT app_tenant_id(), $1, 'vo', l.id, 'VO-' || o.number || ' ' || l.code || ' — ' || l.description, l.unit, l.rate,
                coalesce((SELECT coalesce(pl.certified_qty, pl.submitted_qty) FROM ipc_lines pl WHERE pl.ipc_id = $3 AND pl.variation_line_id = l.id), 0),
                coalesce((SELECT coalesce(pl.certified_qty, pl.submitted_qty) FROM ipc_lines pl WHERE pl.ipc_id = $3 AND pl.variation_line_id = l.id), 0)
           FROM variation_lines l JOIN variations o ON o.id = l.variation_id WHERE o.contract_id = $2 AND o.status = 'approved' AND l.kind = 'new_item'`, [r.id, id, last?.id ?? null]);
      const prevMos = last ? Number((await db.query<{ a: string | null }>("SELECT coalesce(certified_amount, submitted_amount)::text AS a FROM ipc_lines WHERE ipc_id = $1 AND kind = 'mos'", [last.id])).rows[0]?.a ?? 0) : 0;
      await db.query("INSERT INTO ipc_lines (tenant_id, ipc_id, kind, description, previous_amount, submitted_amount) VALUES (app_tenant_id(), $1, 'mos', 'مواد بالموقع / Materials on site', $2, $2)", [r.id, prevMos]);
      await auditTenant(db, req, "ipc.created", "ipc", r.id, { contract: c.number, number: n });
      return r.id;
    });
    return reply.status(201).send({ id: ipcId });
  });

  app.get("/ipcs/:id", { preHandler: requireTenant("ipcs.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const i = (await db.query<Record<string, unknown> & { id: string; contract_id: string; kind: string; ld_days: number; status: string }>(
        `SELECT i.id, i.number, i.kind, i.status, i.period_from::text AS "periodFrom", i.period_to::text AS "periodTo", i.ld_days, i.payment_order_date::text AS "paymentOrderDate",
                i.notes, i.contract_id, k.number AS "contractNumber", k.title AS "contractTitle", k.government_client AS "governmentClient", k.ld_rate_per_day::float8 AS "ldRatePerDay",
                k.ld_cap_pct::float8 AS "ldCapPct", k.applied_params AS "appliedParams", i.sales_document_id AS "invoiceId", d.doc_number AS "invoiceNumber",
                i.ld_credit_note_id AS "ldCreditNoteId", n.doc_number AS "ldCreditNoteNumber", i.certified_at AS "certifiedAt", i.approved_at AS "approvedAt",
                i.gross_to_date::float8 AS "grossToDateStored", i.net_payable::float8 AS "netPayableStored", k.role, sp.name AS "supplierName",
                i.supplier_invoice AS "supplierInvoice", i.supplier_invoice_date::text AS "supplierInvoiceDate",
                CASE WHEN k.role = 'SUB' THEN CASE WHEN sp.residency = 'non_resident' THEN 'reverse' WHEN sp.tax_id IS NOT NULL THEN 'charged' ELSE 'none' END END AS "vatMode"
           FROM ipcs i JOIN contracts k ON k.id = i.contract_id LEFT JOIN suppliers sp ON sp.id = k.supplier_id LEFT JOIN sales_documents d ON d.id = i.sales_document_id LEFT JOIN sales_documents n ON n.id = i.ld_credit_note_id
          WHERE i.id = $1`, [id])).rows[0];
      if (!i) throw notFound("المستخلص غير موجود");
      const lines = await linesOf(db, id);
      const r = await compute(db, i, lines);
      return {
        ...i, ldDays: i.ld_days, contractId: i.contract_id,
        lines: lines.map((l) => {
          const inp = toInput(l);
          return { id: l.id, kind: l.kind, code: l.code, description: l.description, unit: l.unit, rate: l.rate, previousQty: l.previous_qty, submittedQty: l.submitted_qty,
            certifiedQty: l.certified_qty, previousAmount: l.previous_amount, submittedAmount: l.submitted_amount, certifiedAmount: l.certified_amount,
            amountToDate: riyals(lineToDate(inp)), currentAmount: riyals(lineToDate(inp) - linePrevious(inp)) };
        }),
        totals: summary(r),
        deductions: (await db.query(
          `SELECT x.id, x.kind, x.description, x.amount::float8 AS amount, x.cost_code_id AS "costCodeId", c.code AS "costCode"
             FROM ipc_deductions x LEFT JOIN cost_codes c ON c.id = x.cost_code_id WHERE x.ipc_id = $1 ORDER BY x.description`, [id])).rows,
      };
    }, { readOnly: true });
  });

  // Quantities: ours while draft (submitted); the consultant's once submitted (certified). Cumulative to date.
  const qtyBody = z.object({ lines: z.array(z.object({ id: z.string().uuid(), quantity: z.number().min(0).max(1e12).optional(), amount: z.number().min(0).max(1e13).optional() })).max(60_000) });
  async function setQuantities(req: FastifyRequest, which: "submitted" | "certified") {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = qtyBody.parse(req.body);
    return tenantTx(req, async (db) => {
      const i = await lockIpc(db, id);
      if (which === "submitted" && i.status !== "draft") throw conflict("الكميات المقدمة تُعدّل والمستخلص مسودة");
      if (which === "certified" && i.status !== "submitted") throw conflict("الكميات المعتمدة بعد تقديم المستخلص وقبل اعتماده");
      for (const l of b.lines) {
        if (l.quantity !== undefined) await db.query(`UPDATE ipc_lines SET ${which}_qty = $3 WHERE id = $1 AND ipc_id = $2 AND kind <> 'mos'`, [l.id, id, l.quantity]);
        if (l.amount !== undefined) await db.query(`UPDATE ipc_lines SET ${which}_amount = $3 WHERE id = $1 AND ipc_id = $2 AND kind = 'mos'`, [l.id, id, l.amount]);
      }
      if (which === "certified") {
        await db.query("UPDATE ipcs SET status = 'certified', certified_by = app_user_id(), certified_at = now() WHERE id = $1", [id]);
        await auditTenant(db, req, "ipc.certified", "ipc", id, { lines: b.lines.length });
      }
      return { ok: true };
    });
  }
  app.put("/ipcs/:id/quantities", { preHandler: requireTenant("ipcs.create") }, (req) => setQuantities(req, "submitted"));
  app.post("/ipcs/:id/certify", { preHandler: requireTenant("ipcs.certify") }, (req) => setQuantities(req, "certified"));

  app.post("/ipcs/:id/submit", { preHandler: requireTenant("ipcs.create") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ ldDays: z.number().int().min(0).max(36500).default(0), notes: z.string().trim().max(1000).nullable().optional().transform((v) => v || null) }).parse(req.body ?? {});
    return tenantTx(req, async (db) => {
      const i = await lockIpc(db, id);
      if (i.status !== "draft") throw conflict("المستخلص مقدَّم من قبل");
      const r = await compute(db, { ...i, ld_days: b.ldDays }, await linesOf(db, id));
      if (r.current === 0 && i.kind !== "final") throw badRequest("لا أعمال جديدة في هذا المستخلص");
      await db.query("UPDATE ipcs SET status = 'submitted', ld_days = $2, notes = $3, submitted_at = now() WHERE id = $1", [id, b.ldDays, b.notes]);
      await auditTenant(db, req, "ipc.submitted", "ipc", id);
      return { ok: true, totals: summary(r) };
    });
  });

  // The client's approval freezes the figures (retention, advance recovery, damages, VAT, net).
  app.post("/ipcs/:id/approve", { preHandler: requireTenant("ipcs.approve") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const i = await lockIpc(db, id);
      if (i.status !== "certified" && i.status !== "submitted") throw conflict("يُعتمد المستخلص المقدَّم أو المعتمد من الاستشاري");
      // Four eyes: whoever prepared or certified the IPC does not also approve it (the owner excepted).
      const who = (await db.query<{ created_by: string; certified_by: string | null }>("SELECT created_by, certified_by FROM ipcs WHERE id = $1", [id])).rows[0]!;
      if (req.tenant!.role !== "owner" && [who.created_by, who.certified_by].includes(req.tenant!.userId)) {
        throw new AppError(403, "same_approver", "لا تعتمد مستخلصاً أعددته أو اعتمدت كمياته بنفسك: يعتمده غيرك");
      }
      await db.query("SELECT 1 FROM contracts WHERE id = $1 FOR UPDATE", [i.contract_id]);
      const r = await compute(db, i, await linesOf(db, id));
      // A period that reduces the work, or whose deductions exceed it, is not an IPC to approve: it is corrected by a
      // credit note on an earlier invoice (and, for a subcontractor, by its credit note to us).
      if (r.current < 0) throw new AppError(422, "negative_period", "أعمال هذه الفترة بالسالب: عالج التخفيض بإشعار دائن على فاتورة سابقة بدل مستخلص");
      if (r.net < 0) throw new AppError(422, "negative_net", "الخصومات والاستردادات أكبر من أعمال الفترة: قلّلها أو أجّلها لمستخلص تالٍ");
      if (r.role === "SUB" && r.advanceRecovery + r.ld > r.current) throw new AppError(422, "negative_net", "الغرامة واسترداد الدفعة أكبر من أعمال الفترة: قسّمها على المستخلصات");
      await db.query(
        `UPDATE ipcs SET status = 'approved', gross_to_date = $2, previous_gross = $3, current_gross = $4, retention_current = $5, advance_recovery = $6, ld_amount = $7,
                vat = $8, net_payable = $9, deductions = $10, reverse_charge_vat = $11, approved_by = app_user_id(), approved_at = now() WHERE id = $1`,
        [id, formatMoney(r.grossToDate), formatMoney(r.previousGross), formatMoney(r.current), formatMoney(r.retention), formatMoney(r.advanceRecovery), formatMoney(r.ld),
          formatMoney(r.vat), formatMoney(r.net), formatMoney(r.deductions), formatMoney(r.reverseChargeVat)]);
      await auditTenant(db, req, "ipc.approved", "ipc", id, { net: riyals(r.net) });
      return { ok: true, totals: summary(r) };
    });
  });

  /**
   * The tax invoice from the approved IPC: the full value of this period's work (retention does not reduce the VAT
   * base), the advance recovered as prepayment lines (KSA-26…32), the retention booked apart; delay damages as a
   * credit note with VAT on that invoice. Government client: VAT is due at the payment order, so it is required.
   */
  app.post("/ipcs/:id/invoice", { preHandler: requireTenant("ipcs.invoice") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const key = idempotencyKey(req);
    const b = z.object({ paymentOrderDate: date.optional() }).parse(req.body ?? {});
    if (b.paymentOrderDate && b.paymentOrderDate > today()) throw badRequest("تاريخ أمر الدفع في المستقبل");
    let invoiceType: "standard" | "simplified" = "standard";
    const out = await tenantTx(req, async (db) => {
      const i = await lockIpc(db, id);
      if (i.status === "invoiced") {
        const d = (await db.query<{ doc_number: string }>("SELECT doc_number FROM sales_documents WHERE id = $1", [i.sales_document_id])).rows[0]!;
        return { id: i.sales_document_id!, number: d.doc_number, replay: true, ld: null as null | { id: string; number: string; zatcaDocument?: string | null } };
      }
      if (i.status !== "approved") throw conflict("تصدر الفاتورة من مستخلص معتمد من العميل");
      const c = await loadContract(db, i.contract_id);
      if (c.role !== "MAIN") throw conflict("مستخلص مقاول الباطن لا نصدر له فاتورة: سجّل فاتورته إلينا");
      if (c.government_client && !b.paymentOrderDate && !i.payment_order_date) {
        throw new AppError(422, "payment_order_required", "العميل جهة حكومية: الضريبة تستحق بتاريخ أمر الدفع أو القبض أيهما أسبق. أدخل تاريخ أمر الدفع");
      }
      invoiceType = invoiceTypeOf(c);
      const s = (await db.query<{ current: string; retention: string; recovery: string; ld: string }>(
        "SELECT current_gross::text AS current, retention_current::text AS retention, advance_recovery::text AS recovery, ld_amount::text AS ld FROM ipcs WHERE id = $1", [id])).rows[0]!;
      const current = h(Number(s.current));
      if (current <= 0) throw conflict("لا قيمة موجبة للفوترة في هذا المستخلص");
      await ensureContractingAccounts(db);
      const revenue = await accountIdOf(db, "contract_revenue");
      const rate = await vatRate(db);
      const lines = (await linesOf(db, id)).map((l) => { const inp = toInput(l); return { l, cur: lineToDate(inp) - linePrevious(inp) }; }).filter((x) => x.cur !== 0);
      // One invoice line per line of work (amount as a single unit, so the invoice equals the IPC to the halala);
      // if any line went down this period, the period is billed as one line.
      const docLines = lines.some((x) => x.cur < 0)
        ? [{ description: `أعمال المستخلص ${i.number} للعقد ${c.number}`, quantity: 1, unitPrice: riyals(current), discount: 0, vatCategory: "S" as const, exemptionCode: null, exemptionReason: null, accountId: revenue }]
        : lines.map(({ l, cur }) => ({ description: l.kind === "boq" || l.kind === "vo" ? `${l.description} (${(l.certified_qty ?? l.submitted_qty) - l.previous_qty} ${l.unit ?? ""} × ${l.rate})`.slice(0, 300) : l.description,
            quantity: 1, unitPrice: riyals(cur), discount: 0, vatCategory: "S" as const, exemptionCode: null, exemptionReason: null, accountId: revenue }));
      const recovery = h(Number(s.recovery));
      const doc: DocInput = {
        kind: "invoice", invoiceType, customerId: c.customer_id, branchId: c.project_branch, originalId: null, reason: null, supplyDate: i.period_to,
        paymentMeans: "credit", notes: `المستخلص رقم ${i.number} للفترة حتى ${i.period_to}، العقد ${c.number}`, contractId: c.id,
        applyPrepayments: recovery > 0, prepaymentLimit: recovery + Math.round(recovery * rate / 100), retentionAmount: h(Number(s.retention)), lines: docLines,
      };
      const inv = await issueSalesDocument(db, doc, key, req);
      let ld: { id: string; number: string; zatcaDocument?: string | null } | null = null;
      const ldAmount = h(Number(s.ld));
      if (ldAmount > 0) {
        ld = await issueSalesDocument(db, {
          kind: "credit_note", invoiceType, customerId: c.customer_id, branchId: c.project_branch, originalId: inv.id, reason: "غرامة تأخير مرتبطة بالأداء (تخفيض للعوض)", supplyDate: null,
          paymentMeans: "credit", notes: null, contractId: c.id,
          lines: [{ description: `غرامة تأخير على المستخلص ${i.number} / Delay damages`, quantity: 1, unitPrice: riyals(ldAmount), discount: 0, vatCategory: "S", exemptionCode: null, exemptionReason: null, accountId: revenue }],
        // A replay of this request returns early above (the IPC is already invoiced), so the note needs its own key only once.
        }, crypto.randomUUID(), req);
      }
      await db.query("UPDATE ipcs SET status = 'invoiced', sales_document_id = $2, ld_credit_note_id = $3, payment_order_date = coalesce($4, payment_order_date) WHERE id = $1",
        [id, inv.id, ld?.id ?? null, b.paymentOrderDate ?? null]);
      await auditTenant(db, req, "ipc.invoiced", "ipc", id, { invoice: inv.number, creditNote: ld?.number ?? null });
      return { ...inv, ld };
    });
    const zatca = await sendToZatca(req, invoiceType, out);
    const ldZatca = out.ld ? await sendToZatca(req, invoiceType, { replay: false, zatcaDocument: out.ld.zatcaDocument }) : null;
    return reply.status(out.replay ? 200 : 201).send({ id: out.id, number: out.number, zatca, creditNote: out.ld ? { id: out.ld.id, number: out.ld.number, zatca: ldZatca } : null });
  });

  // ── Subcontractor IPCs: set-off deductions, and recording the subcontractor's invoice ────────
  app.put("/ipcs/:id/deductions", { preHandler: requireTenant("ipcs.certify") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ items: z.array(z.object({
      // Compensation only: materials or equipment supplied to the subcontractor are invoiced with VAT, not set off.
      kind: z.enum(["damages", "other"]), description: z.string().trim().min(3, "صف الخصم").max(300),
      amount: z.number().positive().max(1e13), costCodeId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
    })).max(100) }).parse(req.body);
    return tenantTx(req, async (db) => {
      const i = await lockIpc(db, id);
      const c = await loadContract(db, i.contract_id);
      if (c.role !== "SUB") throw conflict("الخصومات على مستخلصات مقاولي الباطن");
      if (!["draft", "submitted", "certified"].includes(i.status)) throw conflict("المستخلص معتمد: لا تتغير خصوماته");
      await db.query("DELETE FROM ipc_deductions WHERE ipc_id = $1", [id]);
      for (const x of b.items) {
        await db.query("INSERT INTO ipc_deductions (tenant_id, ipc_id, kind, description, amount, cost_code_id) VALUES (app_tenant_id(), $1, $2, $3, $4, $5)",
          [id, x.kind, x.description, x.amount, x.costCodeId]);
      }
      await auditTenant(db, req, "ipc.deductions", "ipc", id, { count: b.items.length, total: b.items.reduce((a, x) => a + x.amount, 0) });
      return { ok: true };
    });
  });

  /**
   * The subcontractor's invoice for an approved IPC: its number (required when it charges VAT, the evidence for our
   * input VAT) and date. Recording it books the cost on the project and what we owe; payment is a supplier payment
   * (where withholding applies to a non-resident).
   */
  app.post("/ipcs/:id/record", { preHandler: requireTenant("ipcs.invoice") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ supplierInvoice: z.string().trim().min(1).max(60).nullable().optional().transform((v) => v || null), supplierInvoiceDate: date.optional() }).parse(req.body ?? {});
    if (b.supplierInvoiceDate && b.supplierInvoiceDate > today()) throw badRequest("تاريخ فاتورة مقاول الباطن في المستقبل");
    return tenantTx(req, async (db) => {
      const i = await lockIpc(db, id);
      const c = await loadContract(db, i.contract_id);
      if (c.role !== "SUB") throw conflict("هذا مستخلص عميل: يصدر فاتورته من «إصدار الفاتورة»");
      if (i.status === "invoiced") return { ok: true, replay: true };
      if (i.status !== "approved") throw conflict("يُسجَّل المستخلص بعد اعتماده");
      if (subVatMode(c.residency ?? "resident", c.supplier_tax_id) === "charged" && !b.supplierInvoice) {
        throw new AppError(422, "supplier_invoice_required", "مقاول الباطن مسجل في الضريبة: أدخل رقم فاتورته الضريبية، فهي سند خصم ضريبة المدخلات");
      }
      await ensureContractingAccounts(db);
      await db.query("UPDATE ipcs SET status = 'invoiced', supplier_invoice = $2, supplier_invoice_date = $3 WHERE id = $1", [id, b.supplierInvoice, b.supplierInvoiceDate ?? (i.period_to < today() ? i.period_to : today())]);
      await postSubcontractIpc(db, id);
      await auditTenant(db, req, "ipc.recorded", "ipc", id, { supplierInvoice: b.supplierInvoice });
      return { ok: true };
    });
  });

  app.delete("/ipcs/:id", { preHandler: requireTenant("ipcs.create") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    await tenantTx(req, async (db) => {
      const r = await db.query("DELETE FROM ipcs WHERE id = $1 AND status = 'draft'", [id]);
      if (!r.rowCount) throw conflict("يُحذف المستخلص المسودة فقط");
      await auditTenant(db, req, "ipc.deleted", "ipc", id);
    });
    return { ok: true };
  });

  // ── Variation orders ──────────────────────────────────────────────────────────────────────
  app.get("/contracts/:id/variations", { preHandler: requireTenant("variations.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => ({
      items: (await db.query(
        `SELECT o.id, o.number, o.title, o.source, o.status, o.time_impact_days AS "timeImpactDays", o.contractor_consent AS "contractorConsent", o.cap_check AS "capCheck",
                o.created_at AS "createdAt", o.decided_at AS "decidedAt",
                coalesce((SELECT sum(l.quantity * l.rate) FROM variation_lines l WHERE l.variation_id = o.id), 0)::float8 AS amount,
                (SELECT json_agg(json_build_object('id', l.id, 'kind', l.kind, 'code', l.code, 'description', l.description, 'unit', l.unit, 'quantity', l.quantity::float8, 'rate', l.rate::float8) ORDER BY l.code)
                   FROM variation_lines l WHERE l.variation_id = o.id) AS lines
           FROM variations o WHERE o.contract_id = $1 ORDER BY o.number DESC`, [id])).rows,
    }), { readOnly: true });
  });

  app.post("/contracts/:id/variations", { preHandler: requireTenant("variations.create") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({
      title: z.string().trim().min(3, "أدخل عنوان أمر التغيير").max(200),
      source: z.enum(["instruction", "rfi", "design_change", "client_request", "other"]),
      timeImpactDays: z.number().int().min(-3650).max(3650).default(0),
      lines: z.array(z.object({
        kind: z.enum(["new_item", "change_qty"]), boqItemId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
        code: z.string().trim().min(1).max(40), description: z.string().trim().min(1).max(500), unit: z.string().trim().max(20).nullable().optional().transform((v) => v || null),
        quantity: z.number().refine((v) => v !== 0, "الكمية لا تكون صفراً").refine((v) => Math.abs(v) <= 1e12), rate: z.number().min(0).max(1e12),
      })).min(1, "أضف بنداً").max(500),
    }).parse(req.body);
    const vid = await tenantTx(req, async (db) => {
      const c = await loadContract(db, id, true);
      if (c.status !== "active") throw conflict("أوامر التغيير على عقد مفعّل");
      const v = (await currentVersion(db, id))!;
      for (const l of b.lines) {
        if (l.kind === "new_item" && (l.boqItemId || l.quantity < 0)) throw badRequest("البند الجديد بكمية موجبة ودون بند قائم");
        if (l.kind === "change_qty" && !(l.boqItemId && (await db.query("SELECT 1 FROM boq_items WHERE id = $1 AND version_id = $2 AND NOT is_section", [l.boqItemId, v.id])).rowCount)) {
          throw badRequest(`تعديل كمية «${l.code}» يحتاج بنداً من جدول العقد`);
        }
      }
      const n = (await db.query<{ n: number }>("SELECT coalesce(max(number), 0)::int + 1 AS n FROM variations WHERE contract_id = $1", [id])).rows[0]!.n;
      const r = (await db.query<{ id: string }>(
        "INSERT INTO variations (tenant_id, contract_id, number, title, source, time_impact_days, created_by) VALUES (app_tenant_id(), $1, $2, $3, $4, $5, app_user_id()) RETURNING id",
        [id, n, b.title, b.source, b.timeImpactDays])).rows[0]!;
      for (const l of b.lines) {
        await db.query("INSERT INTO variation_lines (tenant_id, variation_id, kind, boq_item_id, code, description, unit, quantity, rate) VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8)",
          [r.id, l.kind, l.boqItemId, l.code, l.description, l.unit, l.quantity, l.rate]);
      }
      await auditTenant(db, req, "variation.created", "variation", r.id, { number: n });
      return r.id;
    });
    return reply.status(201).send({ id: vid });
  });

  /** Approval checks the caps of the contract's law (Art. 67 GTPL 1448, resolved at activation) on the cumulative totals. */
  app.post("/variations/:id/:action", { preHandler: requireTenant("variations.approve") }, async (req) => {
    const { id, action } = req.params as { id: string; action: string };
    if (!isUuid(id) || !["approve", "reject"].includes(action)) throw notFound();
    const b = z.object({ contractorConsent: z.boolean().default(false) }).parse(req.body ?? {});
    return tenantTx(req, async (db) => {
      const o = (await db.query<{ contract_id: string; status: string }>("SELECT contract_id, status FROM variations WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!o) throw notFound("أمر التغيير غير موجود");
      if (o.status !== "proposed") throw conflict("أمر التغيير مقرر من قبل");
      if (action === "reject") {
        await db.query("UPDATE variations SET status = 'rejected', decided_by = app_user_id(), decided_at = now() WHERE id = $1", [id]);
        await auditTenant(db, req, "variation.rejected", "variation", id);
        return { ok: true };
      }
      const c = await loadContract(db, o.contract_id, true);
      const amounts = async (where: string, params: unknown[]) => (await db.query<{ n: string; inc: string; dec: string }>(
        `SELECT coalesce(sum(l.quantity * l.rate) FILTER (WHERE l.kind = 'new_item'), 0)::text AS n,
                coalesce(sum(l.quantity * l.rate) FILTER (WHERE l.kind = 'change_qty' AND l.quantity > 0), 0)::text AS inc,
                coalesce(-sum(l.quantity * l.rate) FILTER (WHERE l.kind = 'change_qty' AND l.quantity < 0), 0)::text AS dec
           FROM variation_lines l JOIN variations v ON v.id = l.variation_id WHERE ${where}`, params)).rows[0]!;
      const toH = (x: { n: string; inc: string; dec: string }) => ({ newItems: h(Number(x.n)), increase: h(Number(x.inc)), decrease: h(Number(x.dec)) });
      const approved = toH(await amounts("v.contract_id = $1 AND v.status = 'approved'", [o.contract_id]));
      const proposed = toH(await amounts("v.id = $1", [id]));
      const p = c.applied_params ?? {};
      const caps: VoCaps | null = p["vo_total_increase_cap_pct"] ? {
        newItemsPct: p["vo_new_items_cap_pct"]?.value ?? 0, increaseConsentPct: p["vo_increase_consent_pct"]?.value ?? 0,
        totalIncreasePct: p["vo_total_increase_cap_pct"].value, decreasePct: p["vo_decrease_cap_pct"]?.value ?? 0,
      } : null;
      const check = checkVariationCaps({ contractValue: h(Number(c.value)), approved, proposed, caps, consent: b.contractorConsent });
      const record = { ...check, basis: caps ? "المادة 67 من نظام المنافسات 1448 (القيم الموثقة عند تفعيل العقد)" : "لا سقوف نظامية لنظام هذا العقد",
        remaining: check.remaining && Object.fromEntries(Object.entries(check.remaining).map(([k, v]) => [k, riyals(v)])),
        totals: Object.fromEntries(Object.entries(check.totals).map(([k, v]) => [k, riyals(v)])) };
      if (!check.ok) throw new AppError(409, "variation_cap", check.violations.join("، "), record);
      await db.query("UPDATE variations SET status = 'approved', contractor_consent = $2, cap_check = $3, decided_by = app_user_id(), decided_at = now() WHERE id = $1",
        [id, b.contractorConsent, JSON.stringify(record)]);
      await auditTenant(db, req, "variation.approved", "variation", id, { consent: b.contractorConsent });
      return { ok: true, capCheck: record };
    });
  });

  // ── Claims (a register with notice deadlines; not revenue until agreed — C5 variable consideration) ──
  app.get("/contracts/:id/claims", { preHandler: requireTenant("claims.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => ({
      items: (await db.query(
        `SELECT id, number, title, kind, event_date::text AS "eventDate", notice_deadline::text AS "noticeDeadline", notice_date::text AS "noticeDate", description,
                amount_claimed::float8 AS "amountClaimed", days_claimed AS "daysClaimed", amount_assessed::float8 AS "amountAssessed", days_assessed AS "daysAssessed", status,
                (notice_date IS NULL AND notice_deadline < current_date) AS "noticeMissed", (notice_deadline - current_date)::int AS "daysToNotice"
           FROM claims WHERE contract_id = $1 ORDER BY number DESC`, [id])).rows,
    }), { readOnly: true });
  });

  app.post("/contracts/:id/claims", { preHandler: requireTenant("claims.create") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({
      title: z.string().trim().min(3).max(200), kind: z.enum(["time", "cost", "time_cost"]), eventDate: date,
      description: z.string().trim().min(5, "صف الحدث").max(2000),
      amountClaimed: z.number().min(0).max(1e13).nullable().optional().transform((v) => v ?? null), daysClaimed: z.number().int().min(0).max(36500).nullable().optional().transform((v) => v ?? null),
    }).parse(req.body);
    if (b.eventDate > today()) throw badRequest("تاريخ الحدث لا يكون في المستقبل");
    const cid = await tenantTx(req, async (db) => {
      const c = await loadContract(db, id);
      await db.query("SELECT 1 FROM contracts WHERE id = $1 FOR UPDATE", [id]);
      const n = (await db.query<{ n: number }>("SELECT coalesce(max(number), 0)::int + 1 AS n FROM claims WHERE contract_id = $1", [id])).rows[0]!.n;
      const r = (await db.query<{ id: string }>(
        `INSERT INTO claims (tenant_id, contract_id, number, title, kind, event_date, notice_deadline, description, amount_claimed, days_claimed, created_by)
         VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, app_user_id()) RETURNING id`,
        [id, n, b.title, b.kind, b.eventDate, addDays(b.eventDate, c.claim_notice_days), b.description, b.amountClaimed, b.daysClaimed])).rows[0]!;
      await auditTenant(db, req, "claim.created", "claim", r.id);
      return r.id;
    });
    return reply.status(201).send({ id: cid });
  });

  app.put("/claims/:id", { preHandler: requireTenant("claims.edit") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({
      status: z.enum(["identified", "notified", "submitted", "agreed", "rejected", "withdrawn"]), noticeDate: date.nullable().optional().transform((v) => v ?? null),
      amountAssessed: z.number().min(0).max(1e13).nullable().optional().transform((v) => v ?? null), daysAssessed: z.number().int().min(0).max(36500).nullable().optional().transform((v) => v ?? null),
    }).parse(req.body);
    if (b.status !== "identified" && !b.noticeDate) throw badRequest("سجّل تاريخ الإخطار");
    // An agreed claim enters the transaction price (revenue): a decision for whoever holds claims.agree.
    if (b.status === "agreed" && !req.tenant!.permissions.includes("claims.agree")) throw new AppError(403, "forbidden", "الاتفاق على مطالبة يحتاج صلاحية «اعتماد المطالبات»");
    if (b.status === "agreed" && b.amountAssessed === null && b.daysAssessed === null) throw badRequest("أدخل المبلغ أو الأيام المتفق عليها");
    await tenantTx(req, async (db) => {
      let r;
      try {
        r = await db.query("UPDATE claims SET status = $2, notice_date = $3, amount_assessed = $4, days_assessed = $5 WHERE id = $1", [id, b.status, b.noticeDate, b.amountAssessed, b.daysAssessed]);
      } catch (e) { if ((e as { message?: string }).message?.includes("claim_final")) throw conflict("المطالبة محسومة: لا تتغير", "claim_final"); throw e; }
      if (!r.rowCount) throw notFound("المطالبة غير موجودة");
      await auditTenant(db, req, "claim.updated", "claim", id, { status: b.status });
    });
    return { ok: true };
  });
}
