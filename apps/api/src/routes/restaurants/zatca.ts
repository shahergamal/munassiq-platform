import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenantTx } from "../../db/pool.ts";
import { notFound } from "../../lib/errors.ts";
import { pageMeta, parsePage } from "../../lib/pagination.ts";
import { onboard, seller, submit, submitPending, zatcaMessages } from "../../lib/zatca/service.ts";
import { lastWorkerRun } from "../../lib/zatca/worker.ts";
import { auditTenant, isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";

/**
 * The workspace's own link to ZATCA (Fatoora): its owner onboards the e-invoicing device with an OTP from the
 * Fatoora portal, then watches clearance/reporting and resends what failed. Secrets never leave the server.
 */

// Characters ZATCA's SDK refuses in the certificate request fields.
const safe = (label: string) => z.string().trim().min(2, `أدخل ${label}`).max(80).refine((v) => !/[!@#$%&*_<=]/.test(v), `${label} لا يحتوي الرموز ! @ # $ % & * _ < =`);

/** The QR ZATCA put in the cleared invoice (standard documents print this one). */
const qrOf = (xml: string | null) => (xml ? /<cbc:ID>QR<\/cbc:ID>\s*<cac:Attachment>\s*<cbc:EmbeddedDocumentBinaryObject[^>]*>([^<]+)</.exec(xml)?.[1] ?? null : null);

export default async function zatcaRoutes(app: FastifyInstance) {
  app.get("/zatca/status", { preHandler: requireTenant("zatca.view") }, async (req) =>
    tenantTx(req, async (db) => {
      const sel = await seller(db);
      // The latest device per branch (and the workspace-wide one): each signs its own chain.
      const devices = (await db.query(
        `SELECT DISTINCT ON (coalesce(v.branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
                v.id, v.environment, v.status, v.common_name AS "commonName", v.invoice_types AS "invoiceTypes", v.organization_unit AS "organizationUnit",
                v.location, v.industry, v.last_icv::int AS "lastIcv", v.certificate_expires_at AS "certificateExpiresAt", v.onboarded_at AS "onboardedAt",
                v.compliance_results AS "complianceResults", v.failure, v.created_at AS "createdAt", v.branch_id AS "branchId", b.name AS "branchName"
           FROM zatca_devices v LEFT JOIN branches b ON b.id = v.branch_id WHERE v.status IN ('active', 'onboarding', 'failed')
          ORDER BY coalesce(v.branch_id, '00000000-0000-0000-0000-000000000000'::uuid), (v.status = 'active') DESC, v.created_at DESC`)).rows;
      const device = devices.find((d) => !d.branchId) ?? devices[0] ?? null;
      const counts = (await db.query<{ pending: number; rejected: number; accepted: number; warnings: number; overdue: number }>(
        `WITH last AS (
           SELECT d.id, d.invoice_type, d.created_at,
                  (SELECT s.outcome FROM zatca_submissions s WHERE s.document_id = d.id ORDER BY s.created_at DESC LIMIT 1) AS outcome
             FROM zatca_documents d)
         SELECT count(*) FILTER (WHERE outcome IS NULL OR outcome = 'error')::int AS pending,
                count(*) FILTER (WHERE outcome = 'rejected')::int AS rejected,
                count(*) FILTER (WHERE outcome = 'accepted')::int AS accepted,
                count(*) FILTER (WHERE outcome = 'accepted_with_warnings')::int AS warnings,
                count(*) FILTER (WHERE (outcome IS NULL OR outcome = 'error') AND created_at < now() - interval '20 hours')::int AS overdue
           FROM last`)).rows[0];
      const oldest = (await db.query<{ at: Date | null }>(
        `SELECT min(d.created_at) AS at FROM zatca_documents d
          WHERE NOT EXISTS (SELECT 1 FROM zatca_submissions s WHERE s.document_id = d.id AND s.outcome <> 'error')`)).rows[0]!.at;
      return { readiness: { ready: sel.problems.length === 0, problems: sel.problems, sellerName: sel.party.name, vatNumber: sel.party.vatNumber },
        device, devices, counts, oldestPendingAt: oldest, worker: lastWorkerRun() };
    }, { readOnly: true }));

  app.post("/zatca/onboard", { preHandler: requireTenant("zatca.onboard"), config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } }, async (req) => {
    const b = z.object({
      environment: z.enum(["sandbox", "simulation", "production"]),
      otp: z.string().trim().regex(/^\d{6}$/, "رمز التحقق 6 أرقام من بوابة فاتورة"),
      invoiceTypes: z.enum(["1100", "0100", "1000"]),
      organizationUnit: safe("اسم الفرع"),
      location: safe("عنوان الفرع (العنوان المختصر)"),
      industry: safe("نشاط المنشأة"),
      branchId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
    }).parse(req.body);
    const ctx = { tenantId: req.tenant!.id, userId: req.tenant!.userId };
    try {
      const out = await onboard(ctx, b);
      await withTenantTx(ctx, (db) => auditTenant(db, req, "zatca.onboarded", "zatca_device", out.deviceId, { environment: b.environment, invoiceTypes: b.invoiceTypes, branchId: b.branchId }));
      return out;
    } catch (err) {
      const deviceId = (err as { details?: { deviceId?: string } }).details?.deviceId;
      if (deviceId) await withTenantTx(ctx, (db) => auditTenant(db, req, "zatca.onboarding_failed", "zatca_device", deviceId, { environment: b.environment })).catch(() => undefined);
      throw err;
    }
  });

  app.get("/zatca/documents", { preHandler: requireTenant("zatca.view") }, async (req) => {
    const q = req.query as { status?: string; page?: string; pageSize?: string };
    const page = parsePage(q);
    const status = ["pending", "rejected", "accepted", "warnings"].includes(q.status ?? "") ? q.status : null;
    return tenantTx(req, async (db) => {
      const { rows } = await db.query(
        `WITH d AS (
           SELECT d.id, d.doc_number AS "number", d.kind, d.invoice_type AS "invoiceType", d.source_type AS "sourceType", d.source_id AS "sourceId",
                  d.icv::int AS icv, d.created_at AS "createdAt", s.outcome, s.mode, s.http_status AS "httpStatus", s.response, s.created_at AS "submittedAt"
             FROM zatca_documents d
             LEFT JOIN LATERAL (SELECT * FROM zatca_submissions x WHERE x.document_id = d.id ORDER BY x.created_at DESC LIMIT 1) s ON true)
         SELECT *, count(*) OVER()::int AS "_total" FROM d
          WHERE $1::text IS NULL OR ($1 = 'pending' AND (outcome IS NULL OR outcome = 'error')) OR ($1 = 'rejected' AND outcome = 'rejected')
             OR ($1 = 'accepted' AND outcome = 'accepted') OR ($1 = 'warnings' AND outcome = 'accepted_with_warnings')
          ORDER BY icv DESC LIMIT $2 OFFSET $3`, [status, page.pageSize, page.offset]);
      return {
        items: rows.map(({ _total, response, ...r }) => ({ ...r, ...zatcaMessages(response) })),
        meta: pageMeta(page, rows[0]?._total ?? 0),
      };
    }, { readOnly: true });
  });

  app.post("/zatca/documents/:id/submit", { preHandler: requireTenant("zatca.submit") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return submit({ tenantId: req.tenant!.id, userId: req.tenant!.userId }, id);
  });

  app.post("/zatca/submit-pending", { preHandler: requireTenant("zatca.submit") }, async (req) =>
    submitPending({ tenantId: req.tenant!.id, userId: req.tenant!.userId }));

  /** The legal XML: ZATCA's cleared copy for standard documents, the signed document otherwise. Named as ZATCA asks. */
  app.get("/zatca/documents/:id/xml", { preHandler: requireTenant("zatca.view") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const d = await tenantTx(req, async (db) => (await db.query<{ number: string; xml: string; cleared: string | null; vat: string; created_at: Date }>(
      `SELECT d.doc_number AS number, d.xml, (SELECT s.cleared_xml FROM zatca_submissions s WHERE s.document_id = d.id AND s.cleared_xml IS NOT NULL ORDER BY s.created_at DESC LIMIT 1) AS cleared,
              (SELECT tax_id FROM tenants) AS vat, d.created_at FROM zatca_documents d WHERE d.id = $1`, [id])).rows[0], { readOnly: true });
    if (!d) throw notFound("المستند غير موجود");
    const stamp = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Riyadh", dateStyle: "short", timeStyle: "medium" }).format(d.created_at).replace(/[-:]/g, "").replace(" ", "T");
    const name = `${d.vat}_${stamp}_${d.number.replace(/[^A-Za-z0-9]/g, "-")}.xml`;
    return reply.header("content-type", "application/xml; charset=utf-8").header("content-disposition", `attachment; filename="${name}"`)
      .header("cache-control", "private, no-store").send(d.cleared ?? d.xml);
  });
}

/** ZATCA state of one sales document, for its detail page. */
export async function zatcaStateOf(db: import("../../db/pool.ts").Db, sourceType: string, sourceId: string) {
  const r = (await db.query<{ id: string; icv: number; environment: string; outcome: string | null; mode: string | null; response: unknown; cleared: string | null; at: Date | null }>(
    `SELECT d.id, d.icv::int AS icv, v.environment, s.outcome, s.mode, s.response, s.cleared_xml AS cleared, s.created_at AS at
       FROM zatca_documents d JOIN zatca_devices v ON v.id = d.device_id
       LEFT JOIN LATERAL (SELECT * FROM zatca_submissions x WHERE x.document_id = d.id ORDER BY x.created_at DESC LIMIT 1) s ON true
      WHERE d.source_type = $1 AND d.source_id = $2`, [sourceType, sourceId])).rows[0];
  if (!r) return null;
  return { documentId: r.id, icv: r.icv, environment: r.environment, outcome: r.outcome, mode: r.mode, submittedAt: r.at, clearedQr: qrOf(r.cleared), ...zatcaMessages(r.response) };
}
