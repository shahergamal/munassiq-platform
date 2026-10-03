import { z } from "zod";
import type { Permission } from "../rbac.ts";

/**
 * The assistant's ENTIRE reach into the data. Every tool is a read of an existing tenant API endpoint, run as
 * the asking user (same session, same permission check, same RLS). Tools are filtered by the user's permissions
 * BEFORE the model sees them, and re-checked when called. There is no free-form query and no write tool.
 */

type Param = { schema: z.ZodTypeAny; json: Record<string, unknown> };
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const p = {
  date: (description: string): Param => ({ schema: z.string().regex(ISO, "YYYY-MM-DD").optional(), json: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description } }),
  text: (description: string, max = 80): Param => ({ schema: z.string().trim().max(max).optional(), json: { type: "string", maxLength: max, description } }),
  id: (description: string, required = false): Param => ({ schema: required ? z.string().uuid() : z.string().uuid().optional(), json: { type: "string", format: "uuid", description } }),
  oneOf: (values: readonly string[], description: string): Param => ({ schema: z.enum(values as [string, ...string[]]).optional(), json: { type: "string", enum: values, description } }),
  bool: (description: string): Param => ({ schema: z.boolean().optional(), json: { type: "boolean", description } }),
  num: (description: string, min = 1, max = 365): Param => ({ schema: z.number().int().min(min).max(max).optional(), json: { type: "integer", minimum: min, maximum: max, description } }),
};
const FROM = p.date("Start date (inclusive), Riyadh time. Defaults to 30 days ago.");
const TO = p.date("End date (inclusive). Defaults to today.");

export interface ToolDef {
  name: string;
  /** Arabic, shown to the user while the tool runs ("يقرأ …"). */
  label: string;
  description: string;
  /** A workspace permission, or platform administration (admin tools read /api/v1/admin). */
  permission: Permission | "platform:admin";
  base?: "t" | "admin";
  params: Record<string, Param>;
  required?: string[];
  /** Endpoint under /api/v1/t, built from validated input only. */
  path: (i: Record<string, unknown>) => string;
  /** Query-string keys passed through (validated input keys that are NOT path parameters). */
  query?: string[];
  list?: boolean;
}

const t = (d: ToolDef) => d;
export { p, FROM, TO };
const listQuery = (keys: string[]) => keys;

export const TOOLS: ToolDef[] = [
  // ── Workspace & directories (catalog:read — every member has it) ─────────────────────────────
  t({ name: "workspace_overview", label: "بيانات المنشأة", permission: "settings.view", params: {},
    description: "Company profile, subscription/plan status and limits usage, VAT rate and cashier discount limit. Call first when you need the company name or settings.",
    path: () => "/context" }),
  t({ name: "search_ingredients", label: "المواد الخام", permission: "ingredients.view", list: true,
    params: { q: p.text("Name, SKU or barcode contains"), category: p.text("Exact category"), stock: p.oneOf(["low", "zero"], "low = below minimum, zero = out of stock"), isActive: p.oneOf(["true", "false"], "Active filter; omit for all") },
    description: "Raw materials with base unit, total stock quantity (base units: g, ml, pcs), minimum stock, weighted-average cost per base unit (SAR) and yield %.",
    path: () => "/ingredients", query: listQuery(["q", "category", "stock", "isActive"]) }),
  t({ name: "list_suppliers", label: "الموردون", permission: "suppliers.view", list: true,
    params: { q: p.text("Name, code or phone contains") }, description: "Suppliers with tax id, contact and payment terms (days).", path: () => "/suppliers", query: ["q"] }),
  t({ name: "list_locations", label: "المطابخ والمستودعات", permission: "locations.view", list: true, params: {},
    description: "Kitchens and warehouses (stock locations) with their ids — use the id to filter stock reads.", path: () => "/locations" }),
  t({ name: "list_branches", label: "الفروع", permission: "branches.view", list: true, params: {}, description: "Branches.", path: () => "/branches" }),

  // ── Stock (stock:read) ──────────────────────────────────────────────────────────────────────
  t({ name: "stock_levels", label: "رصيد المخزون", permission: "stock.view", list: true,
    params: { q: p.text("Ingredient name or SKU contains"), locationId: p.id("Only this location") },
    description: "Stock on hand per location and ingredient: quantity (base units), average cost, value (SAR), and a below-minimum flag.",
    path: () => "/stock", query: ["q", "locationId"] }),
  t({ name: "stock_movements", label: "حركة المواد", permission: "movements.view", list: true,
    params: { from: FROM, to: TO, ingredientId: p.id("Only this ingredient"), locationId: p.id("Only this location"),
      type: p.oneOf(["purchase", "sale", "refund_return", "transfer_out", "transfer_in", "waste", "count_adjustment", "production_in", "production_out", "purchase_return"], "Movement type") },
    description: "Immutable stock ledger lines (signed quantity, unit cost, value) — the audit trail of every stock change.",
    path: () => "/stock/movements", query: ["from", "to", "ingredientId", "locationId", "type"] }),
  t({ name: "list_transfers", label: "التحويلات", permission: "transfers.view", list: true,
    params: { status: p.oneOf(["draft", "in_transit", "completed", "cancelled"], "Status") }, description: "Transfers between locations with item count and value.", path: () => "/transfers", query: ["status"] }),
  t({ name: "expiry_summary", label: "ملخص الصلاحية", permission: "batches.view", params: { days: p.num("Window in days for 'expiring soon' (default 7)"), locationId: p.id("Only this location") },
    description: "Expired and soon-expiring stock (batch count and value at average cost), and tracked items holding stock with no expiry date yet.",
    path: () => "/stock/batches/summary", query: ["days", "locationId"] }),
  t({ name: "list_batches", label: "الدفعات والصلاحية", permission: "batches.view", list: true,
    params: { status: p.oneOf(["expired", "expiring", "ok", "all"], "expired = past its date; expiring = within `days`"), days: p.num("Window in days (default 7)"), locationId: p.id("Only this location"), q: p.text("Ingredient name or batch number contains") },
    description: "Stock batches (lots) with batch number, expiry date, days left, remaining quantity and value, location and source (receipt/transfer/production).",
    path: () => "/stock/batches", query: ["status", "days", "locationId", "q"] }),
  t({ name: "list_waste", label: "سجلات الهدر", permission: "waste.view", list: true,
    params: { from: FROM, to: TO, reason: p.oneOf(["expired", "spoiled", "damaged", "prep_error", "overproduction", "other"], "Waste reason") },
    description: "Waste records with reason, location and cost.", path: () => "/waste", query: ["from", "to", "reason"] }),
  t({ name: "list_stocktakes", label: "عمليات الجرد", permission: "stocktakes.view", list: true,
    params: { status: p.oneOf(["counting", "posted", "cancelled"], "Status") }, description: "Physical counts with location and variance value.", path: () => "/stocktakes", query: ["status"] }),
  t({ name: "stocktake_detail", label: "تفاصيل جرد", permission: "stocktakes.view", params: { id: p.id("Stocktake id", true) }, required: ["id"],
    description: "One stocktake: each ingredient's system vs counted quantity and variance.", path: (i) => `/stocktakes/${i.id}` }),
  t({ name: "production_runs", label: "دفعات الإنتاج", permission: "prep_recipes.view", list: true,
    params: { prepRecipeId: p.id("Only this prepared item") }, description: "Production runs of prepared items (sauces, doughs) with cost.", path: () => "/production-runs", query: ["prepRecipeId"] }),

  // ── Purchasing (purchases:read) ─────────────────────────────────────────────────────────────
  t({ name: "list_purchase_orders", label: "أوامر الشراء", permission: "purchases.view", list: true,
    params: { status: p.oneOf(["draft", "approved", "partially_received", "received", "closed", "cancelled"], "Status"), q: p.text("Supplier, invoice or PO number contains") },
    description: "Purchase orders with supplier, location, status, net total, VAT and grand total (SAR).", path: () => "/purchases", query: ["status", "q"] }),
  t({ name: "purchase_order_detail", label: "تفاصيل أمر شراء", permission: "purchases.view", params: { id: p.id("Purchase order id", true) }, required: ["id"],
    description: "One purchase order: lines (quantity, unit price, landed unit cost), discount, shipping, fees, VAT.", path: (i) => `/purchases/${i.id}` }),
  t({ name: "list_purchase_returns", label: "مرتجعات المشتريات", permission: "purchase_returns.view", list: true, params: {},
    description: "Returns to suppliers with value and VAT.", path: () => "/purchase-returns" }),
  t({ name: "supplier_balances", label: "مستحقات الموردين", permission: "payables.view", list: true,
    params: { onlyOpen: p.oneOf(["true", "false"], "true = only suppliers we owe") },
    description: "Per supplier: purchases, returns, payments and balance owed (SAR, VAT included), plus the total owed.", path: () => "/payables", query: ["onlyOpen"] }),
  t({ name: "supplier_statement", label: "كشف حساب مورد", permission: "payables.view", params: { id: p.id("Supplier id", true), from: FROM, to: TO }, required: ["id"],
    description: "Statement of account for one supplier: opening balance, each document, running balance.", path: (i) => `/suppliers/${i.id}/statement`, query: ["from", "to"] }),

  // ── Recipes (recipes:read) ──────────────────────────────────────────────────────────────────
  t({ name: "list_recipes", label: "وصفات المنيو", permission: "recipes.view", list: true,
    params: { q: p.text("Name or code contains"), status: p.oneOf(["draft", "approved", "archived"], "Status") },
    description: "Menu recipes with selling price (net), current cost and food-cost %.", path: () => "/recipes", query: ["q", "status"] }),
  t({ name: "recipe_detail", label: "تفاصيل وصفة", permission: "recipes.view", params: { id: p.id("Recipe id", true) }, required: ["id"],
    description: "One recipe: ingredients with quantity, yield and line cost; total cost and margin.", path: (i) => `/recipes/${i.id}` }),
  t({ name: "list_prep_recipes", label: "الوصفات التحضيرية", permission: "prep_recipes.view", list: true, params: { q: p.text("Name contains") },
    description: "Prepared items (sub-recipes) with estimated unit cost.", path: () => "/prep-recipes", query: ["q"] }),

  // ── Sales (pos:read) ────────────────────────────────────────────────────────────────────────
  t({ name: "list_orders", label: "الطلبات", permission: "orders.view", list: true, params: { from: FROM, to: TO },
    description: "Sales orders with channel, location, table/delivery app, items count, VAT, total and refund status.", path: () => "/pos/orders", query: ["from", "to"] }),
  t({ name: "order_detail", label: "تفاصيل طلب", permission: "orders.view", params: { id: p.id("Order id", true) }, required: ["id"],
    description: "One order: items, modifiers, discount, payments, customer, refunds.", path: (i) => `/pos/orders/${i.id}` }),
  t({ name: "list_shifts", label: "الشفتات", permission: "shifts.view", list: true, params: { status: p.oneOf(["open", "closed"], "Status") },
    description: "Cashier shifts: cashier, location, orders, sales, expected vs counted cash, over/short.", path: () => "/pos/shifts", query: ["status"] }),
  t({ name: "list_customers", label: "العملاء", permission: "customers.view", list: true, params: { q: p.text("Name or phone contains") },
    description: "Customers with order count and total spend.", path: () => "/customers", query: ["q"] }),

  // ── Expenses (expenses:read) ────────────────────────────────────────────────────────────────
  t({ name: "list_expenses", label: "المصروفات", permission: "expenses.view", list: true,
    params: { from: FROM, to: TO, status: p.oneOf(["pending", "approved", "paid", "cancelled"], "Status") },
    description: "Operating expenses with category, net amount, VAT, total and status, plus period totals.", path: () => "/expenses", query: ["from", "to", "status"] }),

  // ── Reports (reports:read) ──────────────────────────────────────────────────────────────────
  t({ name: "report_daily_sales", label: "المبيعات اليومية", permission: "rep_daily_sales.view", list: true, params: { from: FROM, to: TO },
    description: "Per day: orders, net sales, VAT, total, ingredient cost, gross profit, refunds.", path: () => "/reports/daily-sales", query: ["from", "to"] }),
  t({ name: "report_sales_by_channel", label: "المبيعات حسب القناة", permission: "rep_sales_channel.view", list: true, params: { from: FROM, to: TO },
    description: "Sales split by channel and delivery app, with app commissions.", path: () => "/reports/sales-by-channel", query: ["from", "to"] }),
  t({ name: "report_menu_profitability", label: "ربحية المنيو", permission: "rep_menu_profit.view", list: true, params: { from: FROM, to: TO },
    description: "Per menu item: price, ideal cost, food-cost %, quantity sold, revenue, actual cost.", path: () => "/reports/menu-profitability", query: ["from", "to"] }),
  t({ name: "report_stock_valuation", label: "تقييم المخزون", permission: "rep_stock_valuation.view", list: true, params: {},
    description: "Current stock value per location at weighted-average cost, and items below minimum.", path: () => "/reports/stock-valuation" }),
  t({ name: "report_waste_analysis", label: "تحليل الهدر", permission: "rep_waste.view", params: { from: FROM, to: TO },
    description: "Waste cost by reason and by ingredient over the period.", path: () => "/reports/waste-analysis", query: ["from", "to"] }),
  t({ name: "report_stock_variance", label: "انحرافات الجرد", permission: "rep_stock_variance.view", list: true, params: { from: FROM, to: TO },
    description: "Stocktake shortages/surpluses by ingredient (quantity and value) over the period.", path: () => "/reports/stock-variance", query: ["from", "to"] }),
  t({ name: "report_expenses", label: "تقرير المصروفات", permission: "rep_expenses.view", params: { from: FROM, to: TO },
    description: "Expenses by category vs net sales (expense ratio).", path: () => "/reports/expenses", query: ["from", "to"] }),
  t({ name: "report_ideal_vs_actual", label: "المثالي مقابل الفعلي", permission: "rep_ideal_actual.view", list: true, params: { from: FROM, to: TO, locationId: p.id("Only this location") },
    description: "Ideal usage (from sales x recipes) vs actual usage (ledger incl. waste and count adjustments) per ingredient, with variance and food-cost %.", path: () => "/reports/ideal-vs-actual", query: ["from", "to", "locationId"] }),
  t({ name: "report_recipe_explosion", label: "تفجير تكلفة الوصفة", permission: "rep_recipe_explosion.view", list: true, params: { recipeId: p.id("Recipe id", true) }, required: ["recipeId"],
    description: "Cost share of every raw ingredient in one recipe, with prepared items exploded.", path: () => "/reports/recipe-explosion", query: ["recipeId"] }),
  t({ name: "report_purchase_prices", label: "أسعار الشراء", permission: "rep_purchase_prices.view", list: true, params: { from: FROM, to: TO },
    description: "Per ingredient: receipts, min/max/first/last landed cost and % change — price increases.", path: () => "/reports/purchase-prices", query: ["from", "to"] }),
  t({ name: "report_cashier_reconciliation", label: "تسوية الكاشير", permission: "rep_cashier.view", list: true, params: { from: FROM, to: TO },
    description: "Per cashier: closed shifts, sales and cash over/short.", path: () => "/reports/cashier-reconciliation", query: ["from", "to"] }),
  t({ name: "report_vat", label: "ضريبة القيمة المضافة", permission: "rep_vat.view", params: { from: FROM, to: TO },
    description: "Output VAT (invoices less credit notes), input VAT (purchases less returns, expenses) and net VAT. Not an official return.", path: () => "/reports/vat", query: ["from", "to"] }),
  t({ name: "contracting_portfolio", label: "محفظة المشاريع", permission: "con_reports.view", params: {},
    description: "Contracting portfolio per project: contract value with variations and agreed claims, certified, billed, receivable, retention, cost to date, committed, estimate at completion (basis: evm/budget/estimate, null when unknown), forecast margin and %, backlog, SPI/CPI, open NCRs, lost-time injuries, flags (loss, behind, over_cost, lti, no_estimate); and totals.",
    path: () => "/contracting/portfolio" }),
];

export const TOOL_BY_NAME = new Map(TOOLS.map((d) => [d.name, d]));

/** Validated input for a tool; rejects unknown keys so nothing unexpected reaches a URL. */
export function parseToolInput(def: ToolDef, input: unknown) {
  const shape = Object.fromEntries(Object.entries(def.params).map(([k, v]) => [k, v.schema]));
  return z.object(shape).strict().safeParse(input ?? {});
}

/** URL for a validated input: path from the tool, query from its whitelisted keys only. */
export function toolUrl(def: ToolDef, input: Record<string, unknown>) {
  const qs = new URLSearchParams();
  for (const k of def.query ?? []) {
    const v = input[k];
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  if (def.list) qs.set("pageSize", "100");
  const q = qs.toString();
  return `/api/v1/${def.base ?? "t"}${def.path(input)}${q ? `?${q}` : ""}`;
}

export function toolSchema(def: ToolDef) {
  return {
    type: "object" as const,
    properties: Object.fromEntries(Object.entries(def.params).map(([k, v]) => [k, v.json])),
    required: def.required ?? [],
    additionalProperties: false,
  };
}
