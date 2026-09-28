import type { FastifyInstance } from "fastify";
import { foodCostPercent } from "../../lib/costing.ts";
import { badRequest } from "../../lib/errors.ts";
import { pageMeta, parsePage, sortSql } from "../../lib/pagination.ts";
import { requireTenant, tenantTx } from "../../plugins/auth.ts";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TZ = "Asia/Riyadh";
const MENU_SORT = ["name", "priceNet", "idealCost", "foodCostPercent", "qtySold", "revenue", "actualCost"];

function range(q: { from?: string; to?: string }, maxDays = 92): { from: string; to: string } {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date()); // YYYY-MM-DD in the reporting zone, not UTC
  const to = DATE.test(q.to ?? "") ? (q.to as string) : today;
  const from = DATE.test(q.from ?? "") ? (q.from as string) : new Date(Date.parse(to) - 29 * 86_400_000).toISOString().slice(0, 10);
  if (Date.parse(from) > Date.parse(to)) throw badRequest("تاريخ البداية بعد تاريخ النهاية");
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > maxDays) throw badRequest(`الفترة القصوى ${maxDays} يوماً`);
  return { from, to };
}

// All reports are read-only transactions, paginated or bounded, and gated by reports:read.
export default async function reportsRoutes(app: FastifyInstance) {
  app.get("/reports/daily-sales", { preHandler: requireTenant("rep_daily_sales.view") }, async (req) => {
    const { from, to } = range(req.query as { from?: string; to?: string });
    return tenantTx(req, async (db) => {
      const { rows } = await db.query(
        `WITH sales AS (
           SELECT (o.created_at AT TIME ZONE '${TZ}')::date AS day, count(*)::int AS orders,
                  sum(o.taxable) AS net, sum(o.vat) AS vat, sum(o.total) AS total, sum(o.cost_total) AS cost
             FROM pos_orders o
            WHERE (o.created_at AT TIME ZONE '${TZ}')::date BETWEEN $1::date AND $2::date
            GROUP BY 1
         ), refunds AS (
           SELECT (f.created_at AT TIME ZONE '${TZ}')::date AS day, sum(f.amount) AS amount
             FROM pos_refunds f
            WHERE (f.created_at AT TIME ZONE '${TZ}')::date BETWEEN $1::date AND $2::date
            GROUP BY 1
         )
         SELECT s.day::text AS day, s.orders, s.net::float8 AS "netSales", s.vat::float8 AS vat, s.total::float8 AS total,
                s.cost::float8 AS cost, (s.net - s.cost)::float8 AS "grossProfit", coalesce(r.amount, 0)::float8 AS refunds
           FROM sales s LEFT JOIN refunds r ON r.day = s.day
          ORDER BY s.day DESC`, [from, to]);
      return { from, to, items: rows };
    }, { readOnly: true });
  });

  app.get("/reports/menu-profitability", { preHandler: requireTenant("rep_menu_profit.view") }, async (req) => {
    const q = req.query as { from?: string; to?: string; page?: string; pageSize?: string; sort?: string };
    const { from, to } = range(q);
    const page = parsePage(q);
    return tenantTx(req, async (db) => {
      // "idealCost" and "foodCostPercent" are selected only so the list can be sorted by them; the returned values are recomputed below.
      const { rows } = await db.query(
        `WITH ing_cost AS (
           SELECT ingredient_id, CASE WHEN sum(quantity) > 0 THEN sum(quantity * avg_cost) / sum(quantity) ELSE max(avg_cost) END AS avg_cost
             FROM stock_levels GROUP BY ingredient_id
         ), rc AS (
           SELECT ri.recipe_id, coalesce(sum(ri.quantity / (i.yield_percentage / 100) * coalesce(c.avg_cost, 0)), 0)::float8 AS ingredient_cost,
                  count(*) FILTER (WHERE coalesce(c.avg_cost, 0) = 0)::int AS missing_cost
             FROM recipe_items ri JOIN ingredients i ON i.id = ri.ingredient_id LEFT JOIN ing_cost c ON c.ingredient_id = ri.ingredient_id GROUP BY ri.recipe_id
         ), sold AS (
           SELECT oi.recipe_id, sum(oi.quantity)::int AS qty, sum(oi.line_net - oi.discount)::float8 AS revenue, sum(oi.cost)::float8 AS actual_cost
             FROM pos_order_items oi JOIN pos_orders o ON o.id = oi.order_id
            WHERE (o.created_at AT TIME ZONE '${TZ}')::date BETWEEN $1::date AND $2::date GROUP BY oi.recipe_id
         )
         SELECT r.id, r.code, r.name, r.category, r.status, r.price_net::float8 AS "priceNet", r.packaging_cost::float8 AS "packagingCost",
                coalesce(rc.ingredient_cost, 0) AS "ingredientCost", coalesce(rc.missing_cost, 0) AS "missingCost",
                coalesce(sold.qty, 0) AS "qtySold", coalesce(sold.revenue, 0) AS revenue, coalesce(sold.actual_cost, 0) AS "actualCost",
                coalesce(rc.ingredient_cost, 0) + r.packaging_cost::float8 AS "idealCost",
                CASE WHEN r.price_net > 0 THEN (coalesce(rc.ingredient_cost, 0) + r.packaging_cost::float8) / r.price_net::float8 * 100 END AS "foodCostPercent",
                count(*) OVER()::int AS "_total"
           FROM recipes r LEFT JOIN rc ON rc.recipe_id = r.id LEFT JOIN sold ON sold.recipe_id = r.id
          WHERE r.status <> 'archived' ORDER BY ${sortSql(q.sort, MENU_SORT)}coalesce(sold.revenue, 0) DESC, r.name LIMIT $3 OFFSET $4`,
        [from, to, page.pageSize, page.offset]);
      const items = rows.map(({ _total, ...r }) => {
        const cost = Number(r.ingredientCost) + Number(r.packagingCost);
        return { ...r, idealCost: cost, idealMargin: Number(r.priceNet) - cost, foodCostPercent: foodCostPercent(cost, Number(r.priceNet)) };
      });
      return { from, to, items, meta: pageMeta(page, rows[0]?._total ?? 0) };
    }, { readOnly: true });
  });

  app.get("/reports/stock-valuation", { preHandler: requireTenant("rep_stock_valuation.view") }, async (req) =>
    tenantTx(req, async (db) => {
      const { rows } = await db.query(
        `SELECT l.id AS "locationId", l.name AS "locationName", count(sl.*)::int AS items,
                coalesce(sum(sl.quantity * sl.avg_cost), 0)::float8 AS value,
                count(*) FILTER (WHERE sl.quantity < i.min_stock)::int AS "belowMin"
           FROM locations l
           LEFT JOIN stock_levels sl ON sl.location_id = l.id
           LEFT JOIN ingredients i ON i.id = sl.ingredient_id
          GROUP BY l.id, l.name ORDER BY l.name LIMIT 200`);
      const total = rows.reduce((a, r) => a + Number(r.value), 0);
      return { items: rows, total: Math.round(total * 100) / 100 };
    }, { readOnly: true }));
}
