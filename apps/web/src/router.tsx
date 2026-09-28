import { fetchMfa, mfaKey, MfaVerifyPage } from "./routes/auth/Mfa";
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, createRoute, createRouter, Link, Outlet, redirect, useParams, useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { Permission } from "./api/types";
import { fetchMe, meKey } from "./app/session";
import { useTenant } from "./app/tenant";
import { WorkspaceShell } from "./app/WorkspaceShell";
import { AdminAudit, AdminOverview, AdminPlans, AdminRoles, AdminShell, AdminTenantDetail, AdminTenants, AdminUsers, AdminWaitlist } from "./routes/admin/Admin";
import { CashierReconciliationReport, IdealVsActualReport, PurchasePricesReport, RecipeExplosionReport, VatReport } from "./routes/workspace/Reports2";
import { ForgotPasswordPage, LoginPage, RegisterPage, ResetPasswordPage, VerifyEmailPage } from "./routes/auth/AuthPages";
import { AccountPage, AppEntryPage, OnboardingPage } from "./routes/EntryPages";
import { LandingPage, PolicyPage } from "./routes/Landing";
import { AdminLanding } from "./routes/admin/AdminLanding";
import { AdminFinancialReport, AdminNewTenant, AdminOperationsReport, AdminSectors, AdminSettings, AdminSubscriptions, AdminUsage } from "./routes/admin/AdminOps";
import { DashboardPage, StockPage } from "./routes/workspace/Dashboard";
import { BranchesPage, LocationsPage, SuppliersPage } from "./routes/workspace/Directories";
import { IngredientsPage, UnitsPage } from "./routes/workspace/Ingredients";
import { MovementsPage, NewTransferPage, NewWastePage, StocktakeSheetPage, StocktakesPage, StockVarianceReport, TransferDetailPage, TransfersPage, WasteAnalysisReport, WastePage } from "./routes/workspace/Inventory";
import { PriceListsPage, PurchaseMatchingReport } from "./routes/workspace/PriceLists";
import { SalesOrderEditorPage, SalesOrderPage, SalesOrdersPage } from "./routes/workspace/SalesOrders";
import { MrpPage, ProductionSchedulePage } from "./routes/workspace/Planning";
import { NcrsPage, QcPlansPage, QualityPage, TracePage } from "./routes/workspace/Quality";
import { MachinesPage, MaintenancePage } from "./routes/workspace/Maintenance";
import { AttendancePage, EmployeePage, EmployeesPage, LeavesPage, PayrollPage, PayrollRunPage } from "./routes/workspace/Hr";
import { OeeReport, PayrollReport, ProductionReport } from "./routes/workspace/OpsReports";
import { BomEditorPage, BomsPage, ManufacturingOrderPage, ManufacturingOrdersPage, WorkCentersPage } from "./routes/workspace/Manufacturing";
import { AccountingDashboardPage, AccountingReportsPage, AccountingSettingsPage, AccountsPage, CostCentersPage, JournalEntryPage, JournalPage, NewJournalEntryPage } from "./routes/workspace/Accounting";
import { InvoiceDetailPage, InvoicesPage, NewInvoicePage, ReceiptsPage } from "./routes/workspace/Invoices";
import { ZatcaPage } from "./routes/workspace/Zatca";
import { BatchDetailPage, BatchesPage } from "./routes/workspace/Batches";
import { RoleEditorPage } from "./routes/workspace/Roles";
import { GoodsReceiptDetailPage, GoodsReceiptsPage, NewRequisitionPage, ReceiveGoodsPage, RequisitionDetailPage, RequisitionsPage } from "./routes/workspace/Procurement";
import { MenuEngineeringReport, StockTurnoverReport, SupplierPerformanceReport } from "./routes/workspace/Reports3";
import { PaymentsPage } from "./routes/workspace/Payments";
import { BillingPage } from "./routes/workspace/Billing";
import { AdminBillingPage, AdminServerPage } from "./routes/admin/AdminServer";
import { ExpensesPage, ExpensesReport, NewPurchaseReturnPage, PayablesPage, PurchaseReturnsPage, SupplierStatementPage, WithholdingReport } from "./routes/workspace/Finance";
import { PosPage } from "./routes/workspace/Pos";
import { CustomersPage, DiningPage, KitchenPage, ModifiersPage, PlatformsPage, SalesByChannelReport } from "./routes/workspace/PosSetup";
import { PrepRecipeEditorPage, PrepRecipesPage } from "./routes/workspace/Prep";
import { NewPurchasePage, PurchaseDetailPage, PurchasesPage } from "./routes/workspace/Purchases";
import { RecipeEditorPage, RecipesPage } from "./routes/workspace/Recipes";
import { DailySalesReport, MenuProfitabilityReport, OrderDetailPage, OrdersPage, ShiftsPage, StockValuationReport } from "./routes/workspace/Sales";
import { MembersPage, SettingsPage } from "./routes/workspace/Settings";
import { EmptyState, ErrorState } from "./ui/States";

/** Hides a page the role cannot use, with a reason (the server still refuses the requests). */
/** A page opens with its own permission (or any of a few, for a document several pages link to); null = any member. */
function Guard({ p, children }: { p: Permission | Permission[] | null; children: ReactNode }) {
  const { can, tenantId } = useTenant();
  if (p !== null && !(Array.isArray(p) ? p : [p]).some((x) => can(x))) {
    return <div className="page"><EmptyState kind="permission" title="هذه الصفحة غير متاحة لدورك" action={<Link to={`/w/${tenantId}`} className="btn btn-secondary">لوحة المتابعة</Link>}>اطلب من مالك المنشأة تعديل دورك إذا كنت تحتاجها.</EmptyState></div>;
  }
  return <>{children}</>;
}

function NotFound() {
  return <div className="page"><EmptyState title="الصفحة غير موجودة" action={<Link to="/app" className="btn btn-secondary">العودة للبداية</Link>}>ربما تغيّر الرابط أو كُتب بشكل غير صحيح.</EmptyState></div>;
}

/**
 * A page that failed while loading (the server busy, the network down): the same Arabic error state as the rest of
 * the app, with a retry that reloads the route, never the router's default English screen.
 */
function RouteError({ error, reset }: { error: unknown; reset: () => void }) {
  const router = useRouter();
  return <div className="page"><ErrorState error={error} title="تعذر فتح الصفحة" onRetry={() => { reset(); void router.invalidate(); }} /></div>;
}

const root = createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: Outlet, notFoundComponent: NotFound, errorComponent: RouteError });

const publicRoute = (path: string, component: () => ReactNode) => createRoute({ getParentRoute: () => root, path, component });

const authed = createRoute({
  getParentRoute: () => root,
  id: "authed",
  beforeLoad: async ({ context, location }) => {
    const me = await context.queryClient.ensureQueryData({ queryKey: meKey, queryFn: fetchMe });
    if (!me) throw redirect({ to: "/login", search: { next: location.href } as never });
    const mfa = await context.queryClient.ensureQueryData({ queryKey: mfaKey, queryFn: fetchMfa });
    if (mfa.pending) throw redirect({ to: "/mfa", search: { next: location.href } as never });
  },
  component: Outlet,
});

const workspace = createRoute({
  getParentRoute: () => authed,
  path: "/w/$tenantId",
  component: function Workspace() {
    const { tenantId } = useParams({ strict: false }) as { tenantId: string };
    return <WorkspaceShell key={tenantId} tenantId={tenantId} />;
  },
});

const w = (path: string, p: Permission | Permission[] | null, Page: () => ReactNode) =>
  createRoute({ getParentRoute: () => workspace, path, component: () => <Guard p={p}><Page /></Guard> });

const admin = createRoute({ getParentRoute: () => authed, path: "/admin", component: AdminShell });
const a = (path: string, Page: () => ReactNode) => createRoute({ getParentRoute: () => admin, path, component: Page });

const tree = root.addChildren([
  publicRoute("/", LandingPage),
  publicRoute("/privacy", () => <PolicyPage which="privacy" />),
  publicRoute("/terms", () => <PolicyPage which="terms" />),
  publicRoute("/security", () => <PolicyPage which="security" />),
  publicRoute("/login", LoginPage),
  publicRoute("/mfa", MfaVerifyPage),
  publicRoute("/register", RegisterPage),
  publicRoute("/verify-email", VerifyEmailPage),
  publicRoute("/forgot-password", ForgotPasswordPage),
  publicRoute("/reset-password", ResetPasswordPage),
  authed.addChildren([
    createRoute({ getParentRoute: () => authed, path: "/app", component: AppEntryPage }),
    createRoute({ getParentRoute: () => authed, path: "/onboarding", component: OnboardingPage }),
    createRoute({ getParentRoute: () => authed, path: "/account", component: AccountPage }),
    workspace.addChildren([
      w("/", null, DashboardPage),
      w("/ingredients", "ingredients.view", IngredientsPage),
      w("/suppliers", "suppliers.view", SuppliersPage),
      w("/branches", "branches.view", BranchesPage),
      w("/locations", "locations.view", LocationsPage),
      w("/units", "units.view", UnitsPage),
      w("/stock", "stock.view", StockPage),
      w("/movements", "movements.view", MovementsPage),
      w("/transfers", "transfers.view", TransfersPage),
      w("/transfers/new", "transfers.create", NewTransferPage),
      w("/transfers/$transferId", "transfers.view", TransferDetailPage),
      w("/waste", "waste.view", WastePage),
      w("/waste/new", "waste.create", NewWastePage),
      w("/stocktakes", "stocktakes.view", StocktakesPage),
      w("/stocktakes/$stocktakeId", "stocktakes.view", StocktakeSheetPage),
      w("/purchases", "purchases.view", PurchasesPage),
      w("/purchases/new", "purchases.create", NewPurchasePage),
      w("/purchases/$poId", "purchases.view", PurchaseDetailPage),
      w("/purchases/$poId/receive", "goods_receipts.create", ReceiveGoodsPage),
      w("/requisitions", "requisitions.view", RequisitionsPage),
      w("/requisitions/new", "requisitions.create", NewRequisitionPage),
      w("/requisitions/$requisitionId", "requisitions.view", RequisitionDetailPage),
      w("/goods-receipts", "goods_receipts.view", GoodsReceiptsPage),
      w("/goods-receipts/$grnId", ["goods_receipts.view", "payables.view", "batches.view"], GoodsReceiptDetailPage),
      w("/batches", "batches.view", BatchesPage),
      w("/batches/$batchId", "batches.view", BatchDetailPage),
      w("/purchase-returns", "purchase_returns.view", PurchaseReturnsPage),
      w("/purchase-returns/new", "purchase_returns.create", NewPurchaseReturnPage),
      w("/payables", "payables.view", PayablesPage),
      w("/payables/$supplierId", "payables.view", SupplierStatementPage),
      w("/expenses", "expenses.view", ExpensesPage),
      w("/accounting", "acc_overview.view", AccountingDashboardPage),
      w("/accounting/invoices", "acc_invoices.view", InvoicesPage),
      w("/accounting/invoices/new", "acc_invoices.create", NewInvoicePage),
      w("/accounting/invoices/$docId", "acc_invoices.view", InvoiceDetailPage),
      w("/accounting/receipts", "acc_receipts.view", ReceiptsPage),
      w("/accounting/journal", "acc_journal.view", JournalPage),
      w("/accounting/journal/new", "acc_journal.create", NewJournalEntryPage),
      w("/accounting/journal/$entryId", "acc_journal.view", JournalEntryPage),
      w("/accounting/accounts", "acc_accounts.view", AccountsPage),
      w("/accounting/cost-centers", "cost_centers.view", CostCentersPage),
      w("/accounting/reports", "acc_reports.view", AccountingReportsPage),
      w("/accounting/settings", "acc_settings.view", AccountingSettingsPage),
      w("/accounting/zatca", "zatca.view", ZatcaPage),
      w("/accounting/payments", "gateways.view", PaymentsPage),
      w("/billing", "billing.view", BillingPage),
      w("/reports/withholding", "rep_withholding.view", WithholdingReport),
      w("/reports/production", "rep_production.view", ProductionReport),
      w("/reports/oee", "rep_oee.view", OeeReport),
      w("/reports/payroll", "rep_payroll.view", PayrollReport),
      w("/sales/price-lists", "price_lists.view", PriceListsPage),
      w("/reports/purchase-matching", "rep_purchase_match.view", PurchaseMatchingReport),
      w("/sales/orders", "sales_orders.view", SalesOrdersPage),
      w("/sales/orders/new", "sales_orders.create", SalesOrderEditorPage),
      w("/sales/orders/$orderId", "sales_orders.view", SalesOrderPage),
      w("/sales/orders/$orderId/edit", "sales_orders.create", SalesOrderEditorPage),
      w("/manufacturing/mrp", "mrp.view", MrpPage),
      w("/manufacturing/schedule", "mrp.view", ProductionSchedulePage),
      w("/hr/employees", "employees.view", EmployeesPage),
      w("/hr/employees/$employeeId", "employees.view", EmployeePage),
      w("/hr/attendance", "attendance.view", AttendancePage),
      w("/hr/leaves", "leaves.view", LeavesPage),
      w("/hr/payroll", "payroll.view", PayrollPage),
      w("/hr/payroll/$runId", "payroll.view", PayrollRunPage),
      w("/manufacturing/quality", "qc_inspections.view", QualityPage),
      w("/manufacturing/qc-plans", "qc_plans.view", QcPlansPage),
      w("/manufacturing/ncrs", "ncrs.view", NcrsPage),
      w("/manufacturing/trace", "trace.view", TracePage),
      w("/manufacturing/maintenance", "maintenance.view", MaintenancePage),
      w("/manufacturing/machines", "machines.view", MachinesPage),
      w("/manufacturing/work-centers", "work_centers.view", WorkCentersPage),
      w("/manufacturing/boms", "boms.view", BomsPage),
      w("/manufacturing/boms/new", "boms.create", BomEditorPage),
      w("/manufacturing/boms/$bomId", "boms.view", BomEditorPage),
      w("/manufacturing/orders", "mos.view", ManufacturingOrdersPage),
      w("/manufacturing/orders/$moId", "mos.view", ManufacturingOrderPage),
      w("/prep-recipes", "prep_recipes.view", PrepRecipesPage),
      w("/prep-recipes/new", "prep_recipes.create", PrepRecipeEditorPage),
      w("/prep-recipes/$prepId", "prep_recipes.view", PrepRecipeEditorPage),
      w("/recipes", "recipes.view", RecipesPage),
      w("/recipes/new", "recipes.create", RecipeEditorPage),
      w("/recipes/$recipeId", "recipes.view", RecipeEditorPage),
      w("/pos", "pos.sell", PosPage),
      w("/kitchen", "kitchen.use", KitchenPage),
      w("/customers", "customers.view", CustomersPage),
      w("/dining", "dining.view", DiningPage),
      w("/platforms", "platforms.view", PlatformsPage),
      w("/modifiers", "modifiers.view", ModifiersPage),
      w("/shifts", "shifts.view", ShiftsPage),
      w("/orders", "orders.view", OrdersPage),
      w("/orders/$orderId", "orders.view", OrderDetailPage),
      w("/reports/daily-sales", "rep_daily_sales.view", DailySalesReport),
      w("/reports/menu-profitability", "rep_menu_profit.view", MenuProfitabilityReport),
      w("/reports/stock-valuation", "rep_stock_valuation.view", StockValuationReport),
      w("/reports/waste-analysis", "rep_waste.view", WasteAnalysisReport),
      w("/reports/stock-variance", "rep_stock_variance.view", StockVarianceReport),
      w("/reports/expenses", "rep_expenses.view", ExpensesReport),
      w("/reports/sales-by-channel", "rep_sales_channel.view", SalesByChannelReport),
      w("/reports/ideal-vs-actual", "rep_ideal_actual.view", IdealVsActualReport),
      w("/reports/recipe-explosion", "rep_recipe_explosion.view", RecipeExplosionReport),
      w("/reports/purchase-prices", "rep_purchase_prices.view", PurchasePricesReport),
      w("/reports/cashier-reconciliation", "rep_cashier.view", CashierReconciliationReport),
      w("/reports/vat", "rep_vat.view", VatReport),
      w("/reports/menu-engineering", "rep_menu_eng.view", MenuEngineeringReport),
      w("/reports/stock-turnover", "rep_stock_turnover.view", StockTurnoverReport),
      w("/reports/supplier-performance", "rep_supplier_perf.view", SupplierPerformanceReport),
      w("/settings", "settings.view", SettingsPage),
      w("/members", ["members.view", "roles.view"], MembersPage),
      w("/members/roles/$roleId", "roles.view", RoleEditorPage),
    ]),
    admin.addChildren([
      a("/", AdminOverview),
      a("/tenants", AdminTenants),
      a("/tenants/new", AdminNewTenant),
      a("/subscriptions", AdminSubscriptions),
      a("/usage", AdminUsage),
      a("/sectors", AdminSectors),
      a("/reports/financial", AdminFinancialReport),
      a("/reports/operations", AdminOperationsReport),
      a("/settings", AdminSettings),
      a("/tenants/$tenantId", AdminTenantDetail),
      a("/users", AdminUsers),
      a("/audit", AdminAudit),
      a("/waitlist", AdminWaitlist),
      a("/plans", AdminPlans),
      a("/server", AdminServerPage),
      a("/billing", AdminBillingPage),
      a("/roles", AdminRoles),
      a("/landing", AdminLanding),
    ]),
  ]),
]);

export function buildRouter(queryClient: QueryClient) {
  return createRouter({ routeTree: tree, context: { queryClient }, defaultPreload: false, scrollRestoration: true, defaultErrorComponent: RouteError });
}
