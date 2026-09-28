import {
  Armchair, Calculator, Layers, LineChart, Percent, Target, ArrowLeftRight, Bike, ClipboardCheck, CookingPot, ListPlus, Split, Users, History, Landmark, PieChart, Receipt, Soup, Trash2, Undo2, Wallet,
  BarChart3, Boxes, Building2, ChefHat, Clock3, LayoutDashboard, MapPin, PackageOpen, ReceiptText, Scale,
  BookOpen, FileChartColumn, FileText, HandCoins, ListTree, NotebookPen, SlidersHorizontal, Link2, CreditCard,
  CalendarClock, CalendarDays, Banknote, UserCheck, IdCard, Cog, ListChecks, OctagonAlert, GitBranch, Wrench, Drill, Factory, FileCheck, Gauge, GanttChart, Radar, Handshake, Network, Tags, Globe, Settings, Server, HardDrive, ClipboardList, PackageCheck, Star, RefreshCcw, Award, ShieldCheck, ShoppingCart, Store, TabletSmartphone, TrendingUp, Truck, Warehouse, type LucideIcon,
} from "lucide-react";
import type { Permission } from "../api/types";

export interface NavItem {
  label: string; to: string; icon: LucideIcon; /** null = every member */ permission: Permission | null;
  /** The same page under another sector's name (a factory's "items" are a restaurant's "ingredients"). */
  labels?: Partial<Record<string, string>>;
}
export interface NavGroup { label: string; items: NavItem[] }

// Stage 1: only screens that have a real backend. Modules without one are not listed (no dead links).
export const NAV: NavGroup[] = [
  { label: "الرئيسية", items: [{ label: "لوحة المتابعة", to: "/w/$tenantId", icon: LayoutDashboard, permission: null }] },
  {
    label: "البيانات الأساسية",
    items: [
      { label: "المواد الخام", labels: { manufacturing: "الأصناف" }, to: "/w/$tenantId/ingredients", icon: PackageOpen, permission: "ingredients.view" },
      { label: "الموردون", to: "/w/$tenantId/suppliers", icon: Truck, permission: "suppliers.view" },
      { label: "الفروع", to: "/w/$tenantId/branches", icon: Store, permission: "branches.view" },
      { label: "المطابخ والمستودعات", labels: { manufacturing: "المستودعات ومواقع الإنتاج" }, to: "/w/$tenantId/locations", icon: MapPin, permission: "locations.view" },
      { label: "وحدات القياس", to: "/w/$tenantId/units", icon: Scale, permission: "units.view" },
      { label: "الصالات والطاولات", to: "/w/$tenantId/dining", icon: Armchair, permission: "dining.view" },
      { label: "تطبيقات التوصيل", to: "/w/$tenantId/platforms", icon: Bike, permission: "platforms.view" },
    ],
  },
  {
    label: "المشتريات",
    items: [
      { label: "طلبات الشراء", to: "/w/$tenantId/requisitions", icon: ClipboardList, permission: "requisitions.view" },
      { label: "أوامر الشراء", to: "/w/$tenantId/purchases", icon: ShoppingCart, permission: "purchases.view" },
      { label: "سندات الاستلام", to: "/w/$tenantId/goods-receipts", icon: PackageCheck, permission: "goods_receipts.view" },
      { label: "مرتجعات المشتريات", to: "/w/$tenantId/purchase-returns", icon: Undo2, permission: "purchase_returns.view" },
    ],
  },
  {
    label: "المخزون",
    items: [
      { label: "رصيد المخزون", to: "/w/$tenantId/stock", icon: Warehouse, permission: "stock.view" },
      { label: "الصلاحية والدفعات", to: "/w/$tenantId/batches", icon: CalendarClock, permission: "batches.view" },
      { label: "التحويلات بين المواقع", to: "/w/$tenantId/transfers", icon: ArrowLeftRight, permission: "transfers.view" },
      { label: "الهدر والتلف", labels: { manufacturing: "التالف والإتلاف" }, to: "/w/$tenantId/waste", icon: Trash2, permission: "waste.view" },
      { label: "الجرد الفعلي", to: "/w/$tenantId/stocktakes", icon: ClipboardCheck, permission: "stocktakes.view" },
      { label: "حركة المواد", labels: { manufacturing: "حركة الأصناف" }, to: "/w/$tenantId/movements", icon: History, permission: "movements.view" },
    ],
  },
  {
    label: "التصنيع",
    items: [
      { label: "أوامر التشغيل", to: "/w/$tenantId/manufacturing/orders", icon: Factory, permission: "mos.view" },
      { label: "تخطيط الاحتياجات", to: "/w/$tenantId/manufacturing/mrp", icon: Radar, permission: "mrp.view" },
      { label: "جدولة الإنتاج", to: "/w/$tenantId/manufacturing/schedule", icon: GanttChart, permission: "mrp.view" },
      { label: "قوائم المواد", to: "/w/$tenantId/manufacturing/boms", icon: ListTree, permission: "boms.view" },
      { label: "مراكز العمل", to: "/w/$tenantId/manufacturing/work-centers", icon: Cog, permission: "work_centers.view" },
    ],
  },
  {
    label: "الجودة",
    items: [
      { label: "فحوصات الجودة", to: "/w/$tenantId/manufacturing/quality", icon: ShieldCheck, permission: "qc_inspections.view" },
      { label: "خطط الفحص", to: "/w/$tenantId/manufacturing/qc-plans", icon: ListChecks, permission: "qc_plans.view" },
      { label: "عدم المطابقة", to: "/w/$tenantId/manufacturing/ncrs", icon: OctagonAlert, permission: "ncrs.view" },
      { label: "تتبع التشغيلات", to: "/w/$tenantId/manufacturing/trace", icon: GitBranch, permission: "trace.view" },
    ],
  },
  {
    label: "الصيانة",
    items: [
      { label: "أوامر الصيانة", to: "/w/$tenantId/manufacturing/maintenance", icon: Wrench, permission: "maintenance.view" },
      { label: "الآلات وخطط الصيانة", to: "/w/$tenantId/manufacturing/machines", icon: Drill, permission: "machines.view" },
    ],
  },
  {
    label: "الوصفات",
    items: [
      { label: "وصفات المنيو", to: "/w/$tenantId/recipes", icon: ChefHat, permission: "recipes.view" },
      { label: "الوصفات التحضيرية والإنتاج", to: "/w/$tenantId/prep-recipes", icon: Soup, permission: "prep_recipes.view" },
      { label: "الإضافات والخيارات", to: "/w/$tenantId/modifiers", icon: ListPlus, permission: "modifiers.view" },
    ],
  },
  {
    label: "المبيعات",
    items: [
      { label: "عروض الأسعار وأوامر البيع", to: "/w/$tenantId/sales/orders", icon: Handshake, permission: "sales_orders.view" },
      { label: "قوائم أسعار العملاء", to: "/w/$tenantId/sales/price-lists", icon: Tags, permission: "price_lists.view" },
      { label: "شاشة الكاشير", to: "/w/$tenantId/pos", icon: TabletSmartphone, permission: "pos.sell" },
      { label: "شاشة المطبخ", to: "/w/$tenantId/kitchen", icon: CookingPot, permission: "kitchen.use" },
      { label: "العملاء", to: "/w/$tenantId/customers", icon: Users, permission: "customers.view" },
      { label: "الشفتات", to: "/w/$tenantId/shifts", icon: Clock3, permission: "shifts.view" },
      { label: "الطلبات والمرتجعات", to: "/w/$tenantId/orders", icon: ReceiptText, permission: "orders.view" },
    ],
  },
  {
    label: "المالية",
    items: [
      { label: "مستحقات الموردين", to: "/w/$tenantId/payables", icon: Landmark, permission: "payables.view" },
      { label: "المصروفات", to: "/w/$tenantId/expenses", icon: Wallet, permission: "expenses.view" },
    ],
  },
  {
    label: "الموارد البشرية",
    items: [
      { label: "الموظفون", to: "/w/$tenantId/hr/employees", icon: IdCard, permission: "employees.view" },
      { label: "الحضور والعمل الإضافي", to: "/w/$tenantId/hr/attendance", icon: UserCheck, permission: "attendance.view" },
      { label: "الإجازات", to: "/w/$tenantId/hr/leaves", icon: CalendarDays, permission: "leaves.view" },
      { label: "مسير الرواتب", to: "/w/$tenantId/hr/payroll", icon: Banknote, permission: "payroll.view" },
    ],
  },
  {
    label: "الحسابات",
    items: [
      { label: "لوحة الحسابات", to: "/w/$tenantId/accounting", icon: BookOpen, permission: "acc_overview.view" },
      { label: "الفواتير الضريبية", to: "/w/$tenantId/accounting/invoices", icon: FileText, permission: "acc_invoices.view" },
      { label: "سندات القبض", to: "/w/$tenantId/accounting/receipts", icon: HandCoins, permission: "acc_receipts.view" },
      { label: "القيود اليومية", to: "/w/$tenantId/accounting/journal", icon: NotebookPen, permission: "acc_journal.view" },
      { label: "دليل الحسابات", to: "/w/$tenantId/accounting/accounts", icon: ListTree, permission: "acc_accounts.view" },
      { label: "مراكز التكلفة", to: "/w/$tenantId/accounting/cost-centers", icon: Network, permission: "cost_centers.view" },
      { label: "التقارير المالية", to: "/w/$tenantId/accounting/reports", icon: FileChartColumn, permission: "acc_reports.view" },
      { label: "الربط مع الهيئة (فاتورة)", to: "/w/$tenantId/accounting/zatca", icon: Link2, permission: "zatca.view" },
      { label: "بوابات الدفع (ميسّر وتاب)", to: "/w/$tenantId/accounting/payments", icon: CreditCard, permission: "gateways.view" },
      { label: "إعدادات المحاسبة", to: "/w/$tenantId/accounting/settings", icon: SlidersHorizontal, permission: "acc_settings.view" },
    ],
  },
  {
    label: "التقارير",
    items: [
      { label: "المبيعات اليومية", to: "/w/$tenantId/reports/daily-sales", icon: BarChart3, permission: "rep_daily_sales.view" },
      { label: "المبيعات حسب القناة", to: "/w/$tenantId/reports/sales-by-channel", icon: Split, permission: "rep_sales_channel.view" },
      { label: "تسوية الكاشير", to: "/w/$tenantId/reports/cashier-reconciliation", icon: Calculator, permission: "rep_cashier.view" },
      { label: "ضريبة القيمة المضافة", to: "/w/$tenantId/reports/vat", icon: Percent, permission: "rep_vat.view" },
      { label: "المثالي مقابل الفعلي", to: "/w/$tenantId/reports/ideal-vs-actual", icon: Target, permission: "rep_ideal_actual.view" },
      { label: "ربحية المنيو", to: "/w/$tenantId/reports/menu-profitability", icon: TrendingUp, permission: "rep_menu_profit.view" },
      { label: "هندسة المنيو", to: "/w/$tenantId/reports/menu-engineering", icon: Star, permission: "rep_menu_eng.view" },
      { label: "دوران المخزون والراكد", to: "/w/$tenantId/reports/stock-turnover", icon: RefreshCcw, permission: "rep_stock_turnover.view" },
      { label: "تقييم الموردين", to: "/w/$tenantId/reports/supplier-performance", icon: Award, permission: "rep_supplier_perf.view" },
      { label: "تفجير تكلفة الوصفة", to: "/w/$tenantId/reports/recipe-explosion", icon: Layers, permission: "rep_recipe_explosion.view" },
      { label: "أسعار الشراء وتغيّرها", to: "/w/$tenantId/reports/purchase-prices", icon: LineChart, permission: "rep_purchase_prices.view" },
      { label: "تقييم المخزون", to: "/w/$tenantId/reports/stock-valuation", icon: Boxes, permission: "rep_stock_valuation.view" },
      { label: "تحليل الهدر", to: "/w/$tenantId/reports/waste-analysis", icon: PieChart, permission: "rep_waste.view" },
      { label: "انحرافات الجرد", to: "/w/$tenantId/reports/stock-variance", icon: Scale, permission: "rep_stock_variance.view" },
      { label: "المصروفات", to: "/w/$tenantId/reports/expenses", icon: Receipt, permission: "rep_expenses.view" },
      { label: "مطابقة فواتير الموردين", to: "/w/$tenantId/reports/purchase-matching", icon: FileCheck, permission: "rep_purchase_match.view" },
      { label: "ضريبة الاستقطاع", to: "/w/$tenantId/reports/withholding", icon: Percent, permission: "rep_withholding.view" },
      { label: "الإنتاج والتكاليف", to: "/w/$tenantId/reports/production", icon: Factory, permission: "rep_production.view" },
      { label: "كفاءة المعدات (OEE)", to: "/w/$tenantId/reports/oee", icon: Gauge, permission: "rep_oee.view" },
      { label: "الرواتب والتأمينات", to: "/w/$tenantId/reports/payroll", icon: Banknote, permission: "rep_payroll.view" },
    ],
  },
  {
    label: "الإعدادات",
    items: [
      { label: "المنشأة والضريبة", to: "/w/$tenantId/settings", icon: Building2, permission: "settings.view" },
      { label: "الأعضاء والصلاحيات", to: "/w/$tenantId/members", icon: Settings, permission: "members.view" },
      { label: "الاشتراك والفوترة", to: "/w/$tenantId/billing", icon: CreditCard, permission: "billing.view" },
    ],
  },
];

/** Platform admin sidebar: sections like the workspace; settings pinned at the bottom. */
export const ADMIN_NAV: { label: string; items: { label: string; to: string; icon: LucideIcon }[] }[] = [
  { label: "", items: [{ label: "نظرة عامة", to: "/admin", icon: LayoutDashboard }] },
  { label: "العملاء", items: [
    { label: "العملاء", to: "/admin/tenants", icon: Building2 },
    { label: "الاشتراكات", to: "/admin/subscriptions", icon: CalendarClock },
    { label: "استهلاك الحدود", to: "/admin/usage", icon: Gauge },
    { label: "المدفوعات والمساحة", to: "/admin/billing", icon: HardDrive },
    { label: "المستخدمون", to: "/admin/users", icon: Users },
  ] },
  { label: "المنتج", items: [
    { label: "الباقات", to: "/admin/plans", icon: Boxes },
    { label: "القطاعات", to: "/admin/sectors", icon: Layers },
    { label: "الأدوار والصلاحيات", to: "/admin/roles", icon: ShieldCheck },
    { label: "الصفحة العامة", to: "/admin/landing", icon: Globe },
  ] },
  { label: "التقارير والمتابعة", items: [
    { label: "التقرير المالي", to: "/admin/reports/financial", icon: Wallet },
    { label: "التقرير التشغيلي", to: "/admin/reports/operations", icon: BarChart3 },
    { label: "سجل التدقيق", to: "/admin/audit", icon: ReceiptText },
    { label: "قائمة الاهتمام", to: "/admin/waitlist", icon: Clock3 },
  ] },
  { label: "التشغيل", items: [
    { label: "الخادم والحماية", to: "/admin/server", icon: Server },
  ] },
];
export const ADMIN_PINNED = [{ label: "إعدادات المنصة", to: "/admin/settings", icon: Settings }];
