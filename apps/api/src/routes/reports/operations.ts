import ExcelJS from "exceljs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { badRequest } from "../../lib/errors.ts";
import type { PayLine } from "../../lib/hr/payroll.ts";
import { openHr } from "../../lib/hr/seal.ts";
import { oee } from "../../lib/manufacturing/oee.ts";
import { requireTenant, tenantTx } from "../../plugins/auth.ts";
import { addDays, today } from "../restaurants/batches.ts";
import { moCostSummary } from "../manufacturing/production.ts";

// M8 reports (ARCHITECTURE.md): production and costs, equipment effectiveness (OEE), payroll and GOSI. Read-only;
// every figure is computed from the records the other modules post, with the same functions they use.

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

/** `?format=xlsx` returns the same figures as a workbook (one sheet per table, right to left). */
const wantsXlsx = (req: FastifyRequest) => (req.query as { format?: string }).format === "xlsx";
interface Sheet { name: string; columns: { header: string; key: string; width?: number }[]; rows: Record<string, unknown>[] }
async function sendSheets(reply: FastifyReply, file: string, sheets: Sheet[]) {
  const wb = new ExcelJS.Workbook();
  for (const sh of sheets) {
    const ws = wb.addWorksheet(sh.name, { views: [{ rightToLeft: true, state: "frozen", ySplit: 1 }] });
    ws.columns = sh.columns.map((c) => ({ ...c, width: c.width ?? 16 }));
    ws.getRow(1).font = { bold: true };
    for (const r of sh.rows) ws.addRow(r);
  }
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  return reply.header("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    .header("content-disposition", `attachment; filename="${file}.xlsx"`).header("cache-control", "private, no-store").send(buf);
}

/** A date range from the query (default: the last 30 days, today included). */
function range(q: { from?: string; to?: string }) {
  const to = q.to && ISO.test(q.to) ? q.to : today();
  const from = q.from && ISO.test(q.from) ? q.from : addDays(to, -29);
  if (from > to) throw badRequest("بداية الفترة بعد نهايتها");
  return { from, to, days: Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1 };
}

export default async function operationsReportRoutes(app: FastifyInstance) {
  /**
   * Production in a period: per order, what was made and scrapped (from output events in the period); for orders
   * closed in the period, the actual unit cost against standard and the price / usage / efficiency variances. Per
   * product, the same rolled up.
   */
  app.get("/reports/production", { preHandler: requireTenant("rep_production.view") }, async (req, reply) => {
    const { from, to } = range(req.query as { from?: string; to?: string });
    const data = await tenantTx(req, async (db) => {
      const rows = (await db.query<{ id: string; n: number; item_id: string; item: string; unit: string; status: string; quantity: number; produced_total: number; std: number | null;
        location_id: string; closed_in: boolean; made: number; scrap: number }>(
        `SELECT o.id, o.mo_number::int AS n, o.item_id, i.name AS item, u.name AS unit, o.status, o.quantity::float8 AS quantity, o.produced_quantity::float8 AS produced_total,
                o.standard_unit_cost::float8 AS std, o.location_id, (o.closed_at AT TIME ZONE 'Asia/Riyadh')::date BETWEEN $1::date AND $2::date AS closed_in,
                coalesce(sum((e.detail->>'quantity')::numeric), 0)::float8 AS made, coalesce(sum((e.detail->>'scrapQuantity')::numeric), 0)::float8 AS scrap
           FROM manufacturing_orders o JOIN ingredients i ON i.id = o.item_id JOIN units u ON u.id = i.base_unit_id
           LEFT JOIN mo_events e ON e.mo_id = o.id AND e.kind = 'output' AND (e.created_at AT TIME ZONE 'Asia/Riyadh')::date BETWEEN $1::date AND $2::date
          WHERE o.status <> 'cancelled'
          GROUP BY o.id, i.name, u.name
         HAVING count(e.id) > 0 OR (o.closed_at AT TIME ZONE 'Asia/Riyadh')::date BETWEEN $1::date AND $2::date
          ORDER BY o.mo_number`, [from, to])).rows;
      const orders = [];
      for (const o of rows) {
        const base = { moId: o.id, number: o.n, itemId: o.item_id, itemName: o.item, unit: o.unit, status: o.status, ordered: o.quantity, made: o.made, scrap: o.scrap,
          yield: o.made + o.scrap > 0 ? r4(o.made / (o.made + o.scrap)) : null, standardUnitCost: o.std };
        if (!o.closed_in) { orders.push({ ...base, closed: null }); continue; }
        const { costs } = await moCostSummary(db, o.id, { quantity: o.quantity, producedQuantity: o.produced_total, standardUnitCost: o.std, status: o.status, locationId: o.location_id });
        // Actual cost of the good output: its standard plus the variance that closed the order's WIP to zero.
        const actual = r2(costs.standardForOutput + costs.variance);
        orders.push({ ...base, closed: { produced: o.produced_total, standardValue: costs.standardForOutput, actualValue: actual,
          actualUnitCost: o.produced_total > 0 ? r4(actual / o.produced_total) : null, variance: costs.variance, price: costs.price, usage: costs.usage, efficiency: costs.efficiency } });
      }
      const items = new Map<string, { itemId: string; itemName: string; unit: string; made: number; scrap: number; standardValue: number; actualValue: number; producedClosed: number; orders: number }>();
      for (const o of orders) {
        const it = items.get(o.itemId) ?? { itemId: o.itemId, itemName: o.itemName, unit: o.unit, made: 0, scrap: 0, standardValue: 0, actualValue: 0, producedClosed: 0, orders: 0 };
        it.made += o.made; it.scrap += o.scrap; it.orders++;
        if (o.closed) { it.standardValue += o.closed.standardValue; it.actualValue += o.closed.actualValue; it.producedClosed += o.closed.produced; }
        items.set(o.itemId, it);
      }
      const byItem = [...items.values()].map((x) => ({ ...x, made: r4(x.made), scrap: r4(x.scrap), standardValue: r2(x.standardValue), actualValue: r2(x.actualValue),
        yield: x.made + x.scrap > 0 ? r4(x.made / (x.made + x.scrap)) : null,
        standardUnitCost: x.producedClosed ? r4(x.standardValue / x.producedClosed) : null, actualUnitCost: x.producedClosed ? r4(x.actualValue / x.producedClosed) : null,
        variancePct: x.standardValue ? r4((x.actualValue - x.standardValue) / x.standardValue) : null }));
      const closed = orders.filter((o) => o.closed).map((o) => o.closed!);
      const sum = (k: "variance" | "price" | "usage" | "efficiency" | "standardValue" | "actualValue") => r2(closed.reduce((a, c) => a + c[k], 0));
      return { from, to, orders, items: byItem, totals: { orders: orders.length, closed: closed.length, standardValue: sum("standardValue"), actualValue: sum("actualValue"),
        variance: sum("variance"), price: sum("price"), usage: sum("usage"), efficiency: sum("efficiency") } };
    }, { readOnly: true });
    if (!wantsXlsx(req)) return data;
    return sendSheets(reply, `production-${from}-${to}`, [
      { name: "حسب المنتج", columns: [{ header: "المنتج", key: "itemName", width: 28 }, { header: "المنتج الجيد", key: "made" }, { header: "الهالك", key: "scrap" }, { header: "المردود", key: "yield" },
        { header: "تكلفة الوحدة المعيارية", key: "standardUnitCost" }, { header: "تكلفة الوحدة الفعلية", key: "actualUnitCost" }, { header: "الفرق %", key: "variancePct" }], rows: data.items },
      { name: "أوامر التشغيل", columns: [{ header: "الأمر", key: "mo" }, { header: "المنتج", key: "itemName", width: 28 }, { header: "المطلوب", key: "ordered" }, { header: "أُنتج", key: "made" },
        { header: "الهالك", key: "scrap" }, { header: "المعيارية", key: "std" }, { header: "الفعلية", key: "act" }, { header: "انحراف السعر", key: "price" }, { header: "انحراف الكمية", key: "usage" },
        { header: "انحراف الكفاءة", key: "efficiency" }],
        rows: data.orders.map((o) => ({ mo: `MO-${o.number}`, itemName: o.itemName, ordered: o.ordered, made: o.made, scrap: o.scrap, std: o.closed?.standardValue ?? null,
          act: o.closed?.actualValue ?? null, price: o.closed?.price ?? null, usage: o.closed?.usage ?? null, efficiency: o.closed?.efficiency ?? null })) },
    ]);
  });

  // OEE per work center over a period (definitions in lib/manufacturing/oee.ts).
  app.get("/reports/oee", { preHandler: requireTenant("rep_oee.view") }, async (req, reply) => {
    const { from, to, days } = range(req.query as { from?: string; to?: string });
    const data = await tenantTx(req, async (db) => {
      const rows = (await db.query<{ id: string; code: string; name: string; mpd: number; down: number; run: number; std: number; good: number; scrap: number }>(
        `WITH out AS (
           SELECT e.mo_id, sum((e.detail->>'quantity')::numeric) AS good, sum((e.detail->>'scrapQuantity')::numeric) AS scrap
             FROM mo_events e WHERE e.kind = 'output' AND (e.created_at AT TIME ZONE 'Asia/Riyadh')::date BETWEEN $1::date AND $2::date GROUP BY e.mo_id)
         SELECT w.id, w.code, w.name, (w.hours_per_day * 60)::float8 AS mpd,
                coalesce((SELECT sum(m.downtime_minutes) FROM maintenance_orders m JOIN machines x ON x.id = m.machine_id
                           WHERE x.work_center_id = w.id AND m.status = 'done' AND (m.completed_at AT TIME ZONE 'Asia/Riyadh')::date BETWEEN $1::date AND $2::date), 0)::float8 AS down,
                coalesce((SELECT sum((e.detail->>'minutes')::numeric) FROM mo_events e JOIN mo_operations op ON op.mo_id = e.mo_id AND op.seq = (e.detail->>'seq')::int
                           WHERE e.kind = 'labor' AND op.work_center_id = w.id AND (e.created_at AT TIME ZONE 'Asia/Riyadh')::date BETWEEN $1::date AND $2::date), 0)::float8 AS run,
                coalesce((SELECT sum(op.planned_minutes * out.good / o.quantity) FROM out JOIN manufacturing_orders o ON o.id = out.mo_id
                           JOIN mo_operations op ON op.mo_id = o.id WHERE op.work_center_id = w.id), 0)::float8 AS std,
                coalesce((SELECT sum(out.good) FROM out WHERE EXISTS (SELECT 1 FROM mo_operations op WHERE op.mo_id = out.mo_id AND op.work_center_id = w.id)), 0)::float8 AS good,
                coalesce((SELECT sum(out.scrap) FROM out WHERE EXISTS (SELECT 1 FROM mo_operations op WHERE op.mo_id = out.mo_id AND op.work_center_id = w.id)), 0)::float8 AS scrap
           FROM work_centers w WHERE w.is_active ORDER BY w.code`, [from, to])).rows;
      const items = rows.map((w) => {
        const input = { plannedMinutes: w.mpd * days, downtimeMinutes: w.down, runMinutes: w.run, standardMinutes: w.std, good: w.good, scrap: w.scrap };
        return { workCenterId: w.id, code: w.code, name: w.name, ...Object.fromEntries(Object.entries(input).map(([k, v]) => [k, r2(v)])), ...oee(input) };
      });
      return { from, to, days, items };
    }, { readOnly: true });
    if (!wantsXlsx(req)) return data;
    return sendSheets(reply, `oee-${from}-${to}`, [{ name: "OEE", columns: [{ header: "مركز العمل", key: "name", width: 24 }, { header: "OEE", key: "oee" }, { header: "الجاهزية", key: "availability" },
      { header: "الأداء", key: "performance" }, { header: "الجودة", key: "quality" }, { header: "المخطط (دقيقة)", key: "plannedMinutes" }, { header: "التوقف", key: "downtimeMinutes" },
      { header: "المسجل", key: "runMinutes" }, { header: "المعياري المكتسب", key: "standardMinutes" }, { header: "الجيد", key: "good" }, { header: "الهالك", key: "scrap" }, { header: "التحميل", key: "utilization" }],
      rows: data.items }]);
  });

  /**
   * Payroll by month and cost center (approved runs), and the GOSI report: contribution base and each branch of
   * contribution (pension, SANED, occupational hazards) per scheme, for the month's payment to GOSI.
   */
  app.get("/reports/payroll", { preHandler: requireTenant("rep_payroll.view") }, async (req, reply) => {
    const q = req.query as { from?: string; to?: string };
    const P = /^\d{4}-(0[1-9]|1[0-2])$/;
    const to = q.to && P.test(q.to) ? q.to : today().slice(0, 7);
    const from = q.from && P.test(q.from) ? q.from : `${Number(to.slice(0, 4)) - (to.slice(5) === "12" ? 0 : 1)}-${to.slice(5) === "12" ? "01" : String(Number(to.slice(5)) + 1).padStart(2, "0")}`;
    const data = await tenantTx(req, async (db) => {
      const lines = (await db.query<{ period: string; status: string; cc: string | null; cc_name: string | null; amounts_enc: string }>(
        `SELECT r.period, r.status, l.cost_center_id AS cc, c.name AS cc_name, l.amounts_enc FROM payroll_lines l JOIN payroll_runs r ON r.id = l.run_id
           LEFT JOIN cost_centers c ON c.id = l.cost_center_id WHERE r.status <> 'draft' AND r.period BETWEEN $1 AND $2 ORDER BY r.period`, [from, to])).rows;
      type Agg = { headcount: number; gross: number; gosiEmployee: number; gosiEmployer: number; eosAccrual: number; deductions: number; net: number };
      const blank = (): Agg => ({ headcount: 0, gross: 0, gosiEmployee: 0, gosiEmployer: 0, eosAccrual: 0, deductions: 0, net: 0 });
      const add = (a: Agg, l: PayLine) => { a.headcount++; a.gross += l.gross; a.gosiEmployee += l.gosiEmployee; a.gosiEmployer += l.gosiEmployer; a.eosAccrual += l.eosAccrual; a.deductions += l.deductions; a.net += l.net; };
      const riyal = (a: Agg) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, k === "headcount" ? v : v / 100]));
      const months = new Map<string, Agg & { status: string }>();
      const centers = new Map<string, Agg & { name: string }>();
      const gosi = new Map<string, { scheme: string; employees: number; base: number; employeePension: number; employeeSaned: number; employerPension: number; employerSaned: number; employerHazard: number }>();
      for (const x of lines) {
        const l = openHr<PayLine & { scheme: string }>(x.amounts_enc);
        const m = months.get(x.period) ?? { ...blank(), status: x.status }; add(m, l); months.set(x.period, m);
        const ck = x.cc ?? "none";
        const c = centers.get(ck) ?? { ...blank(), name: x.cc_name ?? "بلا مركز تكلفة" }; add(c, l); centers.set(ck, c);
        const gk = `${x.period}|${l.scheme}`;
        const g = gosi.get(gk) ?? { scheme: l.scheme, employees: 0, base: 0, employeePension: 0, employeeSaned: 0, employerPension: 0, employerSaned: 0, employerHazard: 0 };
        g.employees++; g.base += l.gosiBase;
        g.employeePension += l.gosiDetail.employee.pension; g.employeeSaned += l.gosiDetail.employee.saned;
        g.employerPension += l.gosiDetail.employer.pension; g.employerSaned += l.gosiDetail.employer.saned; g.employerHazard += l.gosiDetail.employer.hazard;
        gosi.set(gk, g);
      }
      return {
        from, to,
        months: [...months].map(([period, a]) => ({ period, ...riyal(a), status: a.status })),
        costCenters: [...centers.values()].map((a) => ({ ...riyal(a), name: a.name })),
        gosi: [...gosi].map(([k, g]) => ({ period: k.split("|")[0], ...Object.fromEntries(Object.entries(g).map(([f, v]) => [f, typeof v === "number" && f !== "employees" ? v / 100 : v])) })),
      };
    }, { readOnly: true });
    if (!wantsXlsx(req)) return data;
    const money = [{ header: "الموظفون", key: "headcount" }, { header: "الإجمالي", key: "gross" }, { header: "تأمينات الموظفين", key: "gosiEmployee" },
      { header: "تأمينات صاحب العمل", key: "gosiEmployer" }, { header: "نهاية الخدمة", key: "eosAccrual" }, { header: "الاستقطاعات", key: "deductions" }, { header: "الصافي", key: "net" }];
    return sendSheets(reply, `payroll-${from}-${to}`, [
      { name: "حسب الشهر", columns: [{ header: "الشهر", key: "period" }, ...money], rows: data.months },
      { name: "حسب مركز التكلفة", columns: [{ header: "مركز التكلفة", key: "name", width: 24 }, ...money], rows: data.costCenters },
      { name: "التأمينات", columns: [{ header: "الشهر", key: "period" }, { header: "الفئة", key: "scheme" }, { header: "المشتركون", key: "employees" }, { header: "الوعاء", key: "base" },
        { header: "معاشات الموظف", key: "employeePension" }, { header: "معاشات المنشأة", key: "employerPension" }, { header: "ساند الموظف", key: "employeeSaned" },
        { header: "ساند المنشأة", key: "employerSaned" }, { header: "الأخطار", key: "employerHazard" }], rows: data.gosi },
    ]);
  });
}
