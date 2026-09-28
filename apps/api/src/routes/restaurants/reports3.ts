import type { FastifyInstance } from "fastify";
import { isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";
import { dateRange } from "./inventory.ts";

const TZ = "Asia/Riyadh";
const inRange = (col: string) => `(${col} AT TIME ZONE '${TZ}')::date BETWEEN $1::date AND $2::date`;
const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;

/**
 * Management reports a restaurant finance head asks for: menu engineering, stock turnover and dead stock, and
 * supplier performance. Read-only, bounded by a date range, from the append-only ledgers.
 */
export default async function reports3Routes(app: FastifyInstance) {
  /**
   * Menu engineering (Kasavana & Smith): each item by popularity (share of items sold vs 70% of an even share) and
   * contribution margin (net price − food cost, vs the weighted average). Star / Plowhorse / Puzzle / Dog.
   */
  app.get("/reports/menu-engineering", { preHandler: requireTenant("rep_menu_eng.view") }, async (req) => {
    const { from, to } = dateRange(req.query as { from?: string; to?: string });
    return tenantTx(req, async (db) => {
      const { rows } = await db.query<{ recipeId: string; name: string; category: string | null; sold: number; sales: number; cost: number }>(
        `SELECT r.id AS "recipeId", r.name, r.category, sum(x.quantity)::float8 AS sold,
                sum(x.line_net - x.discount)::float8 AS sales, sum(x.cost)::float8 AS cost
           FROM pos_order_items x JOIN pos_orders o ON o.id = x.order_id JOIN recipes r ON r.id = x.recipe_id
          WHERE ${inRange("o.created_at")} GROUP BY r.id, r.name, r.category`, [from, to]);
      const totalSold = rows.reduce((a, r) => a + r.sold, 0);
      const totalCm = rows.reduce((a, r) => a + (r.sales - r.cost), 0);
      const popularityLine = rows.length ? (1 / rows.length) * 0.7 : 0;
      const avgCm = totalSold ? totalCm / totalSold : 0;
      const items = rows.map((r) => {
        const cm = r.sold ? (r.sales - r.cost) / r.sold : 0;
        const mix = totalSold ? r.sold / totalSold : 0;
        const popular = mix >= popularityLine;
        const profitable = cm >= avgCm;
        return {
          ...r, mixPercent: Math.round(mix * 10000) / 100, avgPrice: r.sold ? Math.round((r.sales / r.sold) * 100) / 100 : 0,
          unitCost: r.sold ? Math.round((r.cost / r.sold) * 100) / 100 : 0, contributionMargin: Math.round(cm * 100) / 100,
          totalMargin: Math.round((r.sales - r.cost) * 100) / 100, foodCostPercent: r.sales ? Math.round((r.cost / r.sales) * 10000) / 100 : 0,
          class: popular && profitable ? "star" : popular ? "plowhorse" : profitable ? "puzzle" : "dog",
        };
      }).sort((a, b) => b.totalMargin - a.totalMargin);
      return {
        from, to, items,
        thresholds: { popularityPercent: Math.round(popularityLine * 10000) / 100, averageMargin: Math.round(avgCm * 100) / 100 },
        totals: { sold: totalSold, margin: Math.round(totalCm * 100) / 100 },
      };
    }, { readOnly: true });
  });

  /**
   * Stock turnover per ingredient: usage (what left the shelf into sales, production, waste) against what is on hand.
   * Days on hand = stock value ÷ average daily usage. Dead stock = on hand but nothing used for `idleDays`.
   */
  app.get("/reports/stock-turnover", { preHandler: requireTenant("rep_stock_turnover.view") }, async (req) => {
    const q = req.query as { from?: string; to?: string; locationId?: string; idleDays?: string };
    const { from, to } = dateRange(q);
    const loc = isUuid(q.locationId) ? q.locationId : null;
    const idle = Math.min(Math.max(Number(q.idleDays) || 30, 7), 365);
    return tenantTx(req, async (db) => {
      const { rows } = await db.query<{ ingredientId: string; name: string; category: string | null; unit: string; onHand: number; stockValue: number; usedQty: number; usedValue: number; lastUsedAt: string | null }>(
        `WITH used AS (
           SELECT m.ingredient_id, -sum(m.quantity)::float8 AS q, -sum(m.quantity * m.unit_cost)::float8 AS v
             FROM stock_movements m
            WHERE m.movement_type IN ('sale', 'refund_return', 'production_out', 'waste') AND ${inRange("m.created_at")} AND ($3::uuid IS NULL OR m.location_id = $3)
            GROUP BY 1),
         last AS (
           SELECT m.ingredient_id, max(m.created_at) AS at FROM stock_movements m
            WHERE m.movement_type IN ('sale', 'production_out', 'waste') AND ($3::uuid IS NULL OR m.location_id = $3) GROUP BY 1),
         st AS (
           SELECT ingredient_id, sum(quantity)::float8 AS q, sum(quantity * avg_cost)::float8 AS v FROM stock_levels
            WHERE $3::uuid IS NULL OR location_id = $3 GROUP BY 1)
         SELECT i.id AS "ingredientId", i.name, i.category, u.name AS unit,
                coalesce(st.q, 0) AS "onHand", round(coalesce(st.v, 0)::numeric, 2)::float8 AS "stockValue",
                coalesce(used.q, 0) AS "usedQty", round(coalesce(used.v, 0)::numeric, 2)::float8 AS "usedValue", last.at AS "lastUsedAt"
           FROM ingredients i JOIN units u ON u.id = i.base_unit_id
           LEFT JOIN st ON st.ingredient_id = i.id LEFT JOIN used ON used.ingredient_id = i.id LEFT JOIN last ON last.ingredient_id = i.id
          WHERE i.is_active AND (coalesce(st.q, 0) > 0 OR coalesce(used.q, 0) > 0)`, [from, to, loc]);
      const span = days(from, to);
      const now = Date.now();
      const items = rows.map((r) => {
        const daily = r.usedValue / span;
        const idleFor = r.lastUsedAt ? Math.floor((now - Date.parse(r.lastUsedAt)) / 86_400_000) : null;
        return {
          ...r,
          turnover: r.stockValue > 0 ? Math.round((r.usedValue / r.stockValue) * 100) / 100 : null,
          daysOnHand: daily > 0 ? Math.round(r.stockValue / daily) : null,
          idleDays: idleFor,
          dead: r.onHand > 0 && (idleFor === null || idleFor >= idle),
        };
      }).sort((a, b) => b.stockValue - a.stockValue);
      const stockValue = items.reduce((a, r) => a + r.stockValue, 0);
      const usedValue = items.reduce((a, r) => a + r.usedValue, 0);
      const deadValue = items.filter((r) => r.dead).reduce((a, r) => a + r.stockValue, 0);
      return {
        from, to, idleDays: idle, items,
        totals: {
          stockValue: Math.round(stockValue * 100) / 100, usedValue: Math.round(usedValue * 100) / 100,
          turnover: stockValue > 0 ? Math.round((usedValue / stockValue) * 100) / 100 : null,
          daysOnHand: usedValue > 0 ? Math.round(stockValue / (usedValue / span)) : null,
          deadValue: Math.round(deadValue * 100) / 100, deadCount: items.filter((r) => r.dead).length,
        },
      };
    }, { readOnly: true });
  });

  /**
   * Supplier performance: what we bought (net, VAT), price variance against the PO, quality (rejected lines),
   * delivery on time against the PO's expected date, invoices that do not match the receipt, and what is still on order.
   */
  app.get("/reports/supplier-performance", { preHandler: requireTenant("rep_supplier_perf.view") }, async (req) => {
    const { from, to } = dateRange(req.query as { from?: string; to?: string });
    return tenantTx(req, async (db) => {
      const { rows } = await db.query(
        `WITH g AS (
           SELECT g.*, po.expected_date FROM goods_receipts g JOIN purchase_orders po ON po.id = g.purchase_order_id
            WHERE g.received_on BETWEEN $1::date AND $2::date),
         lines AS (
           SELECT g.supplier_id, sum((x.unit_price - x.ordered_price) * x.quantity) AS pv, count(*) FILTER (WHERE x.rejected_quantity > 0) AS rejected,
                  sum(x.rejected_quantity * x.ordered_price) AS rejected_value, count(*) AS lines
             FROM goods_receipt_items x JOIN g ON g.id = x.receipt_id GROUP BY 1),
         open AS (
           SELECT po.supplier_id, sum((pi.quantity - pi.received_quantity) * pi.unit_price) AS v
             FROM purchase_items pi JOIN purchase_orders po ON po.id = pi.purchase_order_id
            WHERE po.status IN ('approved', 'partially_received') GROUP BY 1)
         SELECT s.id AS "supplierId", s.name,
                count(g.id)::int AS receipts, coalesce(sum(g.total), 0)::float8 AS net, coalesce(sum(g.vat_amount), 0)::float8 AS vat,
                round(coalesce(max(lines.pv), 0), 2)::float8 AS "priceVariance",
                coalesce(max(lines.rejected), 0)::int AS "rejectedLines", coalesce(max(lines.lines), 0)::int AS lines,
                round(coalesce(max(lines.rejected_value), 0), 2)::float8 AS "rejectedValue",
                count(g.id) FILTER (WHERE g.expected_date IS NOT NULL)::int AS "withDueDate",
                count(g.id) FILTER (WHERE g.expected_date IS NOT NULL AND g.received_on <= g.expected_date)::int AS "onTime",
                count(g.id) FILTER (WHERE g.invoice_amount IS NOT NULL AND abs(g.invoice_amount - g.grand_total) >= 0.01)::int AS "invoiceMismatches",
                count(g.id) FILTER (WHERE g.supplier_invoice IS NULL AND NOT g.legacy)::int AS "missingInvoices",
                round(coalesce(max(open.v), 0), 2)::float8 AS "onOrder"
           FROM suppliers s LEFT JOIN g ON g.supplier_id = s.id LEFT JOIN lines ON lines.supplier_id = s.id LEFT JOIN open ON open.supplier_id = s.id
          GROUP BY s.id, s.name
         HAVING count(g.id) > 0 OR coalesce(max(open.v), 0) > 0
          ORDER BY net DESC`, [from, to]);
      const total = rows.reduce((a: number, r: { net: number }) => a + r.net, 0);
      return {
        from, to, total: Math.round(total * 100) / 100,
        items: rows.map((r: { net: number; onTime: number; withDueDate: number; rejectedLines: number; lines: number }) => ({
          ...r,
          sharePercent: total ? Math.round((r.net / total) * 10000) / 100 : 0,
          onTimePercent: r.withDueDate ? Math.round((r.onTime / r.withDueDate) * 10000) / 100 : null,
          qualityPercent: r.lines ? Math.round(((r.lines - r.rejectedLines) / r.lines) * 10000) / 100 : null,
        })),
      };
    }, { readOnly: true });
  });
}
