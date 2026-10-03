import ExcelJS from "exceljs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../../db/pool.ts";
import { badRequest } from "../../lib/errors.ts";
import { requireTenant, tenantTx } from "../../plugins/auth.ts";
import { today } from "../restaurants/batches.ts";
import { projectCashFlow, projectEvm } from "./control.ts";

// The executive view of the contracting portfolio (docs/contracting/ARCHITECTURE.md, C13): per project, the
// contract value with approved variations and agreed claims, what was certified, billed and collected, the cost
// to date and the estimate at completion, the forecast margin and the schedule and cost indices, with the flags a
// director acts on; and the cash forecast of all projects together. Every figure is the server's.

const h = (v: string | number | null | undefined) => Math.round(Number(v ?? 0) * 100);
const r = (v: number) => Math.round(v) / 100;

interface Row { id: string; code: string; name: string; status: string; client: string | null; value: string; claims: string; certified: string; billed: string; receivable: string;
  retention: string; committed: string; estimate: string | null; open_ncrs: number; lti: number }

/** The portfolio on a date: one row per project not closed, and the totals. */
async function portfolio(db: Db, asOf: string) {
  const rows = (await db.query<Row>(
    `WITH k AS (SELECT * FROM contracts WHERE role = 'MAIN' AND status IN ('active', 'completed'))
     SELECT p.id, p.code, p.name, p.status, c.name AS client,
            coalesce((SELECT sum(k.value + coalesce((SELECT sum(l.quantity * l.rate) FROM variation_lines l JOIN variations v ON v.id = l.variation_id
                                                       WHERE v.contract_id = k.id AND v.status = 'approved'), 0)) FROM k WHERE k.project_id = p.id), 0)::text AS value,
            coalesce((SELECT sum(x.amount_assessed) FROM claims x JOIN k ON k.id = x.contract_id WHERE k.project_id = p.id AND x.status = 'agreed'), 0)::text AS claims,
            coalesce((SELECT sum((SELECT gross_to_date FROM ipcs i WHERE i.contract_id = k.id AND i.status IN ('approved', 'invoiced') ORDER BY i.number DESC LIMIT 1)) FROM k WHERE k.project_id = p.id), 0)::text AS certified,
            coalesce((SELECT sum(CASE d.kind WHEN 'credit_note' THEN -d.taxable ELSE d.taxable END) FROM sales_documents d
                       WHERE d.kind IN ('invoice', 'debit_note', 'credit_note') AND d.issue_date <= $1
                         AND coalesce(d.contract_id, (SELECT o.contract_id FROM sales_documents o WHERE o.id = d.original_id)) IN (SELECT id FROM k WHERE k.project_id = p.id)), 0)::text AS billed,
            coalesce((SELECT sum(d.total - d.prepaid_amount - d.retention_amount
                                 - coalesce((SELECT sum(n.total) FROM sales_documents n WHERE n.original_id = d.id AND n.kind = 'credit_note'), 0)
                                 - coalesce((SELECT sum(x.amount) FROM customer_receipts x WHERE x.document_id = d.id), 0))
                        FROM sales_documents d JOIN k ON k.id = d.contract_id WHERE k.project_id = p.id AND d.kind = 'invoice'), 0)::text AS receivable,
            coalesce((SELECT sum(coalesce((SELECT sum(i.retention_current) FROM ipcs i WHERE i.contract_id = k.id AND i.status = 'invoiced'), 0)
                                 - coalesce((SELECT sum(x.amount) FROM retention_releases x WHERE x.contract_id = k.id), 0)) FROM k WHERE k.project_id = p.id), 0)::text AS retention,
            (coalesce((SELECT sum((i.quantity - i.received_quantity) * i.unit_price) FROM purchase_items i JOIN purchase_orders o ON o.id = i.purchase_order_id JOIN locations l ON l.id = o.location_id
                        WHERE l.project_id = p.id AND o.status IN ('approved', 'partially_received') AND i.quantity > i.received_quantity), 0)
             + coalesce((SELECT sum(s.value + coalesce((SELECT sum(vl.quantity * vl.rate) FROM variation_lines vl JOIN variations v ON v.id = vl.variation_id WHERE v.contract_id = s.id AND v.status = 'approved'), 0)
                                  - coalesce((SELECT gross_to_date FROM ipcs i WHERE i.contract_id = s.id AND i.status = 'invoiced' ORDER BY i.number DESC LIMIT 1), 0))
                          FROM contracts s WHERE s.project_id = p.id AND s.role = 'SUB' AND s.status = 'active'), 0))::text AS committed,
            (SELECT sum((SELECT e.estimated_cost FROM contract_estimates e WHERE e.contract_id = k.id AND e.as_of <= $1 ORDER BY e.as_of DESC, e.created_at DESC LIMIT 1)) FROM k WHERE k.project_id = p.id)::text AS estimate,
            (SELECT count(*)::int FROM site_ncrs n WHERE n.project_id = p.id AND n.status = 'open') AS open_ncrs,
            (SELECT count(*)::int FROM hse_incidents x WHERE x.project_id = p.id AND x.kind IN ('lost_time', 'fatality') AND x.occurred_at >= date_trunc('year', $1::date)) AS lti
       FROM projects p LEFT JOIN customers c ON c.id = p.client_id
      WHERE p.status <> 'closed' ORDER BY p.code LIMIT 500`, [asOf])).rows;
  const items: ReturnType<typeof toItem>[] = [];
  for (const p of rows) items.push(toItem(p, await projectEvm(db, p.id, asOf)));
  const sum = (k: "contractValue" | "certified" | "billed" | "receivable" | "retentionReceivable" | "costToDate" | "committed" | "backlog") => r(items.reduce((a, x) => a + h(x[k]), 0));
  const known = items.filter((x) => x.margin !== null);
  return { asOf, items, totals: { contractValue: sum("contractValue"), certified: sum("certified"), billed: sum("billed"), receivable: sum("receivable"),
    retentionReceivable: sum("retentionReceivable"), costToDate: sum("costToDate"), committed: sum("committed"), backlog: sum("backlog"),
    margin: r(known.reduce((a, x) => a + h(x.margin), 0)), marginOf: r(known.reduce((a, x) => a + h(x.contractValue), 0)), unknownMargin: items.length - known.length } };
}

function toItem(p: Row, e: Awaited<ReturnType<typeof projectEvm>>) {
  const value = h(p.value) + h(p.claims);
  const committed = Math.max(0, h(p.committed));
  // The estimate at completion: earned value where there is a programme and a budget; else the budget with what
  // is committed; else the contract's latest estimated total cost (C5). None of these: unknown, not zero.
  const basis = e.acts.length && e.bac ? "evm" : e.bac ? "budget" : p.estimate !== null ? "estimate" : null;
  const eac = basis === "evm" ? e.eac : basis === "budget" ? e.ac + Math.max(committed, e.bac - e.ac) : basis === "estimate" ? Math.max(h(p.estimate), e.ac) : null;
  const margin = eac === null ? null : value - eac;
  const certified = h(p.certified);
  return { id: p.id, code: p.code, name: p.name, status: p.status, client: p.client, contractValue: r(value), certified: r(certified),
    progressPct: value ? Math.round((certified / value) * 1000) / 10 : null, billed: r(h(p.billed)), receivable: r(h(p.receivable)), retentionReceivable: r(h(p.retention)),
    costToDate: r(e.ac), committed: r(committed), budget: r(e.bac), eac: eac === null ? null : r(eac), eacBasis: basis, margin: margin === null ? null : r(margin),
    marginPct: margin === null || !value ? null : Math.round((margin / value) * 1000) / 10, backlog: r(Math.max(0, value - certified)),
    spi: basis === "evm" ? e.spi : null, cpi: basis === "evm" ? e.cpi : null, openNcrs: p.open_ncrs, lostTimeInjuries: p.lti,
    flags: [margin !== null && margin < 0 ? "loss" : null, basis === "evm" && e.spi !== null && e.spi < 0.9 ? "behind" : null,
      basis === "evm" && e.cpi !== null && e.cpi < 0.9 ? "over_cost" : null, p.lti ? "lti" : null, !basis && value ? "no_estimate" : null].filter(Boolean) as string[] };
}

const FLAG: Record<string, string> = { loss: "خسارة متوقعة", behind: "متأخر عن البرنامج", over_cost: "تجاوز التكلفة", lti: "إصابة مضيعة للوقت", no_estimate: "بلا تقدير للتكلفة" };

export default async function portfolioRoutes(app: FastifyInstance) {
  app.get("/contracting/portfolio", { preHandler: requireTenant("con_reports.view") }, async (req) => {
    const q = z.object({ asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.query);
    const asOf = q.asOf ?? today();
    if (asOf > today()) throw badRequest("التاريخ لا يكون في المستقبل");
    return tenantTx(req, (db) => portfolio(db, asOf), { readOnly: true });
  });

  app.get("/contracting/portfolio.xlsx", { preHandler: requireTenant("con_reports.export"), config: { rateLimit: { max: 20, timeWindow: "10 minutes" } } }, async (req, reply) => {
    const p = await tenantTx(req, (db) => portfolio(db, today()), { readOnly: true });
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("محفظة المشاريع", { views: [{ rightToLeft: true, state: "frozen", ySplit: 1 }] });
    ws.columns = [
      { header: "المشروع", key: "code", width: 12 }, { header: "الاسم", key: "name", width: 32 }, { header: "العميل", key: "client", width: 24 },
      { header: "قيمة العقود", key: "contractValue", width: 16 }, { header: "المعتمد", key: "certified", width: 16 }, { header: "الإنجاز %", key: "progressPct", width: 10 },
      { header: "المفوتر", key: "billed", width: 16 }, { header: "الذمم القائمة", key: "receivable", width: 16 }, { header: "المحتجز لدى العملاء", key: "retentionReceivable", width: 16 },
      { header: "التكلفة حتى تاريخه", key: "costToDate", width: 16 }, { header: "الملتزم به", key: "committed", width: 16 }, { header: "التكلفة المتوقعة", key: "eac", width: 16 },
      { header: "الهامش المتوقع", key: "margin", width: 16 }, { header: "الهامش %", key: "marginPct", width: 10 }, { header: "المتبقي", key: "backlog", width: 16 },
      { header: "SPI", key: "spi", width: 8 }, { header: "CPI", key: "cpi", width: 8 }, { header: "تنبيهات", key: "flags", width: 30 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const x of p.items) ws.addRow({ ...x, flags: x.flags.map((f) => FLAG[f]).join("، ") });
    ws.addRow({ code: "الإجمالي", ...p.totals }).font = { bold: true };
    for (const k of ["contractValue", "certified", "billed", "receivable", "retentionReceivable", "costToDate", "committed", "eac", "margin", "backlog"]) ws.getColumn(k).numFmt = "#,##0.00";
    return reply.header("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("content-disposition", `attachment; filename="portfolio.xlsx"; filename*=UTF-8''${encodeURIComponent(`محفظة المشاريع ${p.asOf}.xlsx`)}`)
      .header("cache-control", "private, no-store").send(Buffer.from(await wb.xlsx.writeBuffer()));
  });

  /** The months ahead for all projects with an active main contract: in, out, net and the cumulative position. */
  app.get("/contracting/cash-forecast", { preHandler: requireTenant("con_reports.view") }, async (req) => {
    const q = z.object({ months: z.coerce.number().int().min(1).max(36).default(12) }).parse(req.query);
    return tenantTx(req, async (db) => {
      const asOf = today();
      const projects = (await db.query<{ id: string; code: string; name: string }>(
        "SELECT DISTINCT p.id, p.code, p.name FROM projects p JOIN contracts k ON k.project_id = p.id WHERE k.role = 'MAIN' AND k.status = 'active' AND p.status <> 'closed' ORDER BY p.code LIMIT 200")).rows;
      const total = new Map<string, { inflow: number; outflow: number }>();
      const perProject = [];
      for (const p of projects) {
        const f = await projectCashFlow(db, p.id, q.months, asOf);
        for (const m of f.items) {
          const t = total.get(m.period) ?? { inflow: 0, outflow: 0 };
          total.set(m.period, { inflow: t.inflow + m.inflow, outflow: t.outflow + m.outflow });
        }
        perProject.push({ id: p.id, code: p.code, name: p.name, hasSchedule: f.hasSchedule, net: r(f.items.reduce((a, m) => a + m.net, 0)),
          lowest: r(Math.min(0, ...f.items.map((m) => m.cumulative))) });
      }
      let cumulative = 0;
      const items = [...total.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([period, t]) => {
        cumulative += t.inflow - t.outflow;
        return { period, inflow: r(t.inflow), outflow: r(t.outflow), net: r(t.inflow - t.outflow), cumulative: r(cumulative) };
      });
      return { asOf, basis: "قبل ضريبة القيمة المضافة، دون الرصيد النقدي الحالي", items, projects: perProject };
    }, { readOnly: true });
  });
}
