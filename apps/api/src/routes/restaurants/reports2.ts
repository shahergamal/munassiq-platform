import type { FastifyInstance } from "fastify";
import { round4 } from "../../lib/costing.ts";
import { notFound } from "../../lib/errors.ts";
import { systemPool } from "../../db/pool.ts";
import { isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";
import { dateRange } from "./inventory.ts";

const TZ = "Asia/Riyadh";
const inRange = (col: string) => `(${col} AT TIME ZONE '${TZ}')::date BETWEEN $1::date AND $2::date`;

// Analytical reports. All read-only, bounded by a date range, and computed from the append-only ledgers.
export default async function reports2Routes(app: FastifyInstance) {
  /**
   * Ideal vs actual usage per ingredient, from the stock ledger:
   *   ideal  = what recipes say the sales consumed (sale movements, less restocked refunds)
   *   actual = ideal + recorded waste + stocktake shortage (count adjustments)
   * Production is a conversion (raw → prepared) and belongs to neither.
   */
  app.get("/reports/ideal-vs-actual", { preHandler: requireTenant("rep_ideal_actual.view") }, async (req) => {
    const q = req.query as { from?: string; to?: string; locationId?: string };
    const { from, to } = dateRange(q);
    const loc = isUuid(q.locationId) ? q.locationId : null;
    return tenantTx(req, async (db) => {
      const { rows } = await db.query<{ ingredientId: string; name: string; unit: string; idealQty: number; idealValue: number; wasteQty: number; wasteValue: number; countQty: number; countValue: number }>(
        `SELECT i.id AS "ingredientId", i.name, u.name AS unit,
                coalesce(-sum(m.quantity) FILTER (WHERE m.movement_type IN ('sale', 'refund_return')), 0)::float8 AS "idealQty",
                coalesce(-sum(m.quantity * m.unit_cost) FILTER (WHERE m.movement_type IN ('sale', 'refund_return')), 0)::float8 AS "idealValue",
                coalesce(-sum(m.quantity) FILTER (WHERE m.movement_type = 'waste'), 0)::float8 AS "wasteQty",
                coalesce(-sum(m.quantity * m.unit_cost) FILTER (WHERE m.movement_type = 'waste'), 0)::float8 AS "wasteValue",
                coalesce(-sum(m.quantity) FILTER (WHERE m.movement_type = 'count_adjustment'), 0)::float8 AS "countQty",
                coalesce(-sum(m.quantity * m.unit_cost) FILTER (WHERE m.movement_type = 'count_adjustment'), 0)::float8 AS "countValue"
           FROM stock_movements m JOIN ingredients i ON i.id = m.ingredient_id JOIN units u ON u.id = i.base_unit_id
          WHERE ${inRange("m.created_at")} AND ($3::uuid IS NULL OR m.location_id = $3)
            AND m.movement_type IN ('sale', 'refund_return', 'waste', 'count_adjustment')
          GROUP BY i.id, i.name, u.name`, [from, to, loc]);
      const items = rows.map((r) => {
        const actualQty = round4(r.idealQty + r.wasteQty + r.countQty);
        const actualValue = round4(r.idealValue + r.wasteValue + r.countValue);
        const varianceValue = round4(actualValue - r.idealValue);
        return { ...r, idealValue: round4(r.idealValue), wasteValue: round4(r.wasteValue), countValue: round4(r.countValue), actualQty, actualValue, varianceValue,
          variancePercent: r.idealValue > 0 ? Math.round((varianceValue / r.idealValue) * 10000) / 100 : null };
      }).sort((a, b) => Math.abs(b.varianceValue) - Math.abs(a.varianceValue));
      const sum = (k: "idealValue" | "actualValue" | "wasteValue" | "countValue") => round4(items.reduce((a, x) => a + x[k], 0));
      const sales = (await db.query<{ net: number }>(`SELECT coalesce(sum(taxable), 0)::float8 AS net FROM pos_orders o WHERE ${inRange("o.created_at")} AND ($3::uuid IS NULL OR o.location_id = $3)`, [from, to, loc])).rows[0]?.net ?? 0;
      const idealValue = sum("idealValue");
      const actualValue = sum("actualValue");
      return {
        from, to, items,
        totals: {
          idealValue, actualValue, wasteValue: sum("wasteValue"), countValue: sum("countValue"), netSales: sales,
          idealFoodCostPercent: sales > 0 ? Math.round((idealValue / sales) * 10000) / 100 : null,
          actualFoodCostPercent: sales > 0 ? Math.round((actualValue / sales) * 10000) / 100 : null,
        },
      };
    }, { readOnly: true });
  });

  /** Cost share of every ingredient in one recipe; prepared ingredients are exploded one level into their raw inputs. */
  app.get("/reports/recipe-explosion", { preHandler: requireTenant("rep_recipe_explosion.view") }, async (req) => {
    const { recipeId } = req.query as { recipeId?: string };
    if (!isUuid(recipeId)) return { recipe: null, lines: [] };
    return tenantTx(req, async (db) => {
      const r = (await db.query<{ name: string; price_net: number; packaging: number }>("SELECT name, price_net::float8 AS price_net, packaging_cost::float8 AS packaging FROM recipes WHERE id = $1", [recipeId])).rows[0];
      if (!r) throw notFound();
      const { rows } = await db.query<{ ingredientId: string; name: string; unit: string; usableQty: number; rawQty: number; unitCost: number; cost: number; viaPrep: string | null; missing: boolean }>(
        `WITH ing_cost AS (
           SELECT ingredient_id, CASE WHEN sum(quantity) > 0 THEN sum(quantity * avg_cost) / sum(quantity) ELSE max(avg_cost) END AS c FROM stock_levels GROUP BY ingredient_id
         ), direct AS (
           SELECT ri.ingredient_id, ri.quantity AS usable, ri.quantity / (i.yield_percentage / 100) AS raw, i.is_prepared
             FROM recipe_items ri JOIN ingredients i ON i.id = ri.ingredient_id WHERE ri.recipe_id = $1
         ), exploded AS (
           SELECT d.ingredient_id, d.usable, d.raw, NULL::text AS via FROM direct d
            WHERE NOT d.is_prepared OR NOT EXISTS (SELECT 1 FROM prep_recipes p WHERE p.ingredient_id = d.ingredient_id)
           UNION ALL
           SELECT pi.ingredient_id, NULL, d.raw * pi.quantity / p.batch_yield, pin.name
             FROM direct d JOIN prep_recipes p ON p.ingredient_id = d.ingredient_id JOIN ingredients pin ON pin.id = d.ingredient_id
             JOIN prep_recipe_items pi ON pi.prep_recipe_id = p.id WHERE d.is_prepared
         )
         SELECT e.ingredient_id AS "ingredientId", i.name, u.name AS unit, e.usable::float8 AS "usableQty", round(e.raw, 4)::float8 AS "rawQty",
                round(coalesce(c.c, 0), 6)::float8 AS "unitCost", round(e.raw * coalesce(c.c, 0), 4)::float8 AS cost, e.via AS "viaPrep", coalesce(c.c, 0) = 0 AS missing
           FROM exploded e JOIN ingredients i ON i.id = e.ingredient_id JOIN units u ON u.id = i.base_unit_id LEFT JOIN ing_cost c ON c.ingredient_id = e.ingredient_id
          ORDER BY cost DESC`, [recipeId]);
      const ingredientCost = round4(rows.reduce((a, l) => a + l.cost, 0));
      const total = round4(ingredientCost + r.packaging);
      return {
        recipe: { id: recipeId, name: r.name, priceNet: r.price_net, packagingCost: r.packaging, ingredientCost, totalCost: total,
          foodCostPercent: r.price_net > 0 ? Math.round((total / r.price_net) * 10000) / 100 : null },
        lines: rows.map((l) => ({ ...l, sharePercent: total > 0 ? Math.round((l.cost / total) * 10000) / 100 : 0 })),
      };
    }, { readOnly: true });
  });

  /** Purchase price history per ingredient from receipts in the period (landed cost per base unit). */
  app.get("/reports/purchase-prices", { preHandler: requireTenant("rep_purchase_prices.view") }, async (req) => {
    const { from, to } = dateRange(req.query as { from?: string; to?: string });
    return tenantTx(req, async (db) => {
      const { rows } = await db.query(
        `WITH r AS (
           SELECT x.ingredient_id, x.unit_cost AS c, x.quantity * i.purchase_to_base AS q, g.created_at AS at, s.name AS supplier
             FROM goods_receipt_items x JOIN goods_receipts g ON g.id = x.receipt_id JOIN ingredients i ON i.id = x.ingredient_id
             JOIN suppliers s ON s.id = g.supplier_id
            WHERE x.quantity > 0 AND x.unit_cost IS NOT NULL AND g.received_on BETWEEN $1::date AND $2::date
         ), cur AS (
           SELECT ingredient_id, CASE WHEN sum(quantity) > 0 THEN sum(quantity * avg_cost) / sum(quantity) ELSE max(avg_cost) END AS c FROM stock_levels GROUP BY ingredient_id
         )
         SELECT i.id AS "ingredientId", i.name, u.name AS unit, count(*)::int AS receipts,
                round(min(r.c), 6)::float8 AS "minCost", round(max(r.c), 6)::float8 AS "maxCost",
                round(sum(r.c * r.q) / nullif(sum(r.q), 0), 6)::float8 AS "weightedAvg",
                round((array_agg(r.c ORDER BY r.at))[1], 6)::float8 AS "firstCost",
                round((array_agg(r.c ORDER BY r.at DESC))[1], 6)::float8 AS "lastCost",
                (array_agg(r.supplier ORDER BY r.at DESC))[1] AS "lastSupplier",
                round(coalesce(cur.c, 0), 6)::float8 AS "currentAvg"
           FROM r JOIN ingredients i ON i.id = r.ingredient_id JOIN units u ON u.id = i.base_unit_id LEFT JOIN cur ON cur.ingredient_id = i.id
          GROUP BY i.id, i.name, u.name, cur.c ORDER BY i.name`, [from, to]);
      const items = rows.map((r) => ({ ...r, changePercent: r.firstCost > 0 ? Math.round(((r.lastCost - r.firstCost) / r.firstCost) * 10000) / 100 : null }));
      return { from, to, items };
    }, { readOnly: true });
  });

  /** Closed shifts per cashier: expected vs counted cash (blind counts), in the period. */
  app.get("/reports/cashier-reconciliation", { preHandler: requireTenant("rep_cashier.view") }, async (req) => {
    const { from, to } = dateRange(req.query as { from?: string; to?: string });
    const rows = await tenantTx(req, async (db) => (await db.query<{ userId: string; shifts: number; sales: number; expected: number; counted: number; overShort: number; worst: number; lastClosed: string }>(
      `SELECT s.opened_by AS "userId", count(*)::int AS shifts,
              coalesce(sum((SELECT sum(total) FROM pos_orders o WHERE o.shift_id = s.id)), 0)::float8 AS sales,
              sum(s.expected_cash)::float8 AS expected, sum(s.counted_cash)::float8 AS counted, sum(s.over_short)::float8 AS "overShort",
              min(s.over_short)::float8 AS worst, max(s.closed_at) AS "lastClosed"
         FROM pos_shifts s WHERE s.status = 'closed' AND ${inRange("s.closed_at")}
        GROUP BY s.opened_by ORDER BY sum(s.over_short)`, [from, to])).rows, { readOnly: true });
    const ids = rows.map((r) => r.userId);
    const names = ids.length ? new Map((await systemPool.query<{ id: string; full_name: string }>(
      "SELECT u.id, u.full_name FROM users u JOIN memberships m ON m.user_id = u.id AND m.tenant_id = $1 WHERE u.id = ANY($2::uuid[])", [req.tenant!.id, ids])).rows.map((r) => [r.id, r.full_name])) : new Map<string, string>();
    return { from, to, items: rows.map(({ userId, ...r }) => ({ ...r, cashier: names.get(userId) ?? "—" })) };
  });

  /**
   * VAT summary for bookkeeping. Output VAT from issued invoices less credit notes; input VAT from received
   * purchase orders (less returns) and approved/paid expenses.
   * This is not a ZATCA return.
   */
  app.get("/reports/vat", { preHandler: requireTenant("rep_vat.view") }, async (req) => {
    const { from, to } = dateRange(req.query as { from?: string; to?: string });
    return tenantTx(req, async (db) => {
      const days = (await db.query<{ day: string; invoices: number; creditNotes: number; salesTotal: number; salesVat: number; creditTotal: number; creditVat: number }>(
        `SELECT (issued_at AT TIME ZONE '${TZ}')::date::text AS day,
                count(*) FILTER (WHERE kind = 'simplified_invoice')::int AS invoices, count(*) FILTER (WHERE kind = 'credit_note')::int AS "creditNotes",
                coalesce(sum(total) FILTER (WHERE kind = 'simplified_invoice'), 0)::float8 AS "salesTotal",
                coalesce(sum(vat) FILTER (WHERE kind = 'simplified_invoice'), 0)::float8 AS "salesVat",
                coalesce(sum(total) FILTER (WHERE kind = 'credit_note'), 0)::float8 AS "creditTotal",
                coalesce(sum(vat) FILTER (WHERE kind = 'credit_note'), 0)::float8 AS "creditVat"
           FROM e_invoices WHERE ${inRange("issued_at")} GROUP BY 1 ORDER BY 1 DESC`, [from, to])).rows;
      const input = (await db.query<{ vat: number; count: number }>(
        `SELECT coalesce(sum(vat_amount), 0)::float8 AS vat, count(*)::int AS count FROM expenses
          WHERE status IN ('approved', 'paid') AND expense_date BETWEEN $1::date AND $2::date AND vat_amount > 0`, [from, to])).rows[0] ?? { vat: 0, count: 0 };
      const purchases = (await db.query<{ vat: number; count: number; returnsVat: number }>(
        `SELECT (SELECT coalesce(sum(vat_amount), 0) FROM goods_receipts WHERE vat_amount > 0 AND received_on BETWEEN $1::date AND $2::date)::float8 AS vat,
                (SELECT count(*) FROM goods_receipts WHERE vat_amount > 0 AND received_on BETWEEN $1::date AND $2::date)::int AS count,
                (SELECT coalesce(sum(vat_amount), 0) FROM purchase_returns WHERE ${inRange("created_at")})::float8 AS "returnsVat"`, [from, to])).rows[0] ?? { vat: 0, count: 0, returnsVat: 0 };
      const c = (v: number) => Math.round(v * 100);
      const inputPurchases = (c(purchases.vat) - c(purchases.returnsVat)) / 100;
      const outputVat = days.reduce((a, d) => a + c(d.salesVat) - c(d.creditVat), 0) / 100;
      const taxableSales = days.reduce((a, d) => a + c(d.salesTotal - d.salesVat) - c(d.creditTotal - d.creditVat), 0) / 100;
      return {
        from, to, days,
        summary: {
          taxableSales, outputVat, inputVatPurchases: inputPurchases, purchasesWithVat: purchases.count, returnsVat: purchases.returnsVat,
          inputVatExpenses: input.vat, expensesWithVat: input.count, netVat: (c(outputVat) - c(inputPurchases) - c(input.vat)) / 100,
        },
        notes: ["ضريبة المشتريات بتاريخ الاستلام، مخصوماً منها ضريبة المرتجعات.", "ملخص للمتابعة وليس إقراراً ضريبياً رسمياً."],
      };
    }, { readOnly: true });
  });
}
