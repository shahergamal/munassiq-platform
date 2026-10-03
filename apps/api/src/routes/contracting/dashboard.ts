import type { FastifyInstance } from "fastify";
import { requireTenant, tenantTx } from "../../plugins/auth.ts";
import { today } from "../restaurants/batches.ts";

// The contracting workspace's home: where the money and the deadlines are. Main contracts' value, work certified,
// what is billed and owed, retention both ways; then what needs doing now (IPCs waiting at each step, invoices due
// within the 15-day rule, claim notices running out, guarantees, permits and subcontractor documents expiring).

export default async function contractingDashboardRoutes(app: FastifyInstance) {
  app.get("/contracting/dashboard", { preHandler: requireTenant("projects.view") }, async (req) =>
    tenantTx(req, async (db) => {
      const asOf = today();
      const k = (await db.query<Record<string, number>>(
        `SELECT (SELECT count(*) FROM projects WHERE status IN ('planning', 'active'))::int AS projects,
                coalesce((SELECT sum(value) FROM contracts WHERE role = 'MAIN' AND status = 'active'), 0)::float8 AS "contractValue",
                coalesce((SELECT sum(l.quantity * l.rate) FROM variation_lines l JOIN variations v ON v.id = l.variation_id JOIN contracts c ON c.id = v.contract_id
                           WHERE v.status = 'approved' AND c.role = 'MAIN' AND c.status = 'active'), 0)::float8 AS variations,
                coalesce((SELECT sum(x.g) FROM (SELECT DISTINCT ON (i.contract_id) i.gross_to_date AS g FROM ipcs i JOIN contracts c ON c.id = i.contract_id
                           WHERE c.role = 'MAIN' AND c.status = 'active' AND i.status IN ('approved', 'invoiced') ORDER BY i.contract_id, i.number DESC) x), 0)::float8 AS certified,
                coalesce((SELECT sum(d.taxable) FROM sales_documents d WHERE d.contract_id IS NOT NULL AND d.kind = 'invoice' AND date_trunc('month', d.issue_date) = date_trunc('month', $1::date)), 0)::float8 AS "billedThisMonth",
                -- What clients owe on contract invoices (after advances deducted and retention held apart).
                coalesce((SELECT sum(d.total - d.prepaid_amount - d.retention_amount
                                     - coalesce((SELECT sum(n.total) FROM sales_documents n WHERE n.original_id = d.id AND n.kind = 'credit_note'), 0)
                                     - coalesce((SELECT sum(r.amount) FROM customer_receipts r WHERE r.document_id = d.id), 0))
                           FROM sales_documents d WHERE d.contract_id IS NOT NULL AND d.kind = 'invoice' AND d.payment_means = 'credit'), 0)::float8 AS receivable,
                (coalesce((SELECT sum(i.retention_current) FROM ipcs i JOIN contracts c ON c.id = i.contract_id WHERE c.role = 'MAIN' AND i.status = 'invoiced'), 0)
                  - coalesce((SELECT sum(r.amount) FROM retention_releases r JOIN contracts c ON c.id = r.contract_id WHERE c.role = 'MAIN'), 0))::float8 AS "retentionReceivable",
                (coalesce((SELECT sum(i.retention_current) FROM ipcs i JOIN contracts c ON c.id = i.contract_id WHERE c.role = 'SUB' AND i.status = 'invoiced'), 0)
                  - coalesce((SELECT sum(r.amount) FROM retention_releases r JOIN contracts c ON c.id = r.contract_id WHERE c.role = 'SUB'), 0))::float8 AS "retentionPayable"`,
        [asOf])).rows[0]!;
      const ipcs = (await db.query(
        `SELECT i.id, i.number, i.status, i.kind, c.id AS "contractId", c.number AS "contractNumber", c.role, coalesce(cu.name, s.name) AS party, p.code AS project,
                i.period_to::text AS "periodTo", i.net_payable::float8 AS "netPayable",
                CASE WHEN i.status = 'approved' AND c.role = 'MAIN' THEN (date_trunc('month', i.period_to) + interval '1 month' + interval '14 days')::date::text END AS "invoiceDeadline"
           FROM ipcs i JOIN contracts c ON c.id = i.contract_id JOIN projects p ON p.id = c.project_id LEFT JOIN customers cu ON cu.id = c.customer_id LEFT JOIN suppliers s ON s.id = c.supplier_id
          WHERE i.status IN ('draft', 'submitted', 'certified', 'approved') ORDER BY i.status = 'approved' DESC, i.period_to LIMIT 20`)).rows;
      const deadlines = (await db.query(
        `SELECT * FROM (
           SELECT 'claim' AS kind, x.id, c.id AS "contractId", c.number AS ref, x.title AS label, x.notice_deadline::text AS due FROM claims x JOIN contracts c ON c.id = x.contract_id
            WHERE x.notice_date IS NULL AND x.status = 'identified' AND x.notice_deadline <= $1::date + 14
           UNION ALL
           SELECT 'guarantee', g.id, c.id, g.number, g.bank, g.expires_on::text FROM bank_guarantees g JOIN contracts c ON c.id = g.contract_id
            WHERE g.status = 'active' AND g.expires_on <= $1::date + 60
           UNION ALL
           SELECT 'permit', x.id, NULL, x.number, x.kind || ' · ' || p.code, x.expires_on::text FROM project_permits x JOIN projects p ON p.id = x.project_id
            WHERE x.expires_on IS NOT NULL AND x.expires_on <= $1::date + 60
           UNION ALL
           SELECT 'subcontractor', sp.supplier_id, NULL, s.code, s.name, (SELECT min(v) FROM unnest(ARRAY[sp.classification_expiry, sp.zakat_cert_expiry, sp.gosi_cert_expiry, sp.insurance_expiry]) v)::text
             FROM subcontractor_profiles sp JOIN suppliers s ON s.id = sp.supplier_id
            WHERE sp.status = 'approved' AND (SELECT min(v) FROM unnest(ARRAY[sp.classification_expiry, sp.zakat_cert_expiry, sp.gosi_cert_expiry, sp.insurance_expiry]) v) <= $1::date + 60
         ) d ORDER BY due LIMIT 30`, [asOf])).rows;
      return { asOf, ...k, backlog: Math.round((k.contractValue! + k.variations! - k.certified!) * 100) / 100, ipcs, deadlines };
    }, { readOnly: true }));
}
