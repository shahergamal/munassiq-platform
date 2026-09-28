import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { BarChart3, BookOpen, ChefHat, House, LayoutGrid, ShoppingCart, Store, TabletSmartphone, TrendingUp, Warehouse, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { MeTenant, TenantContext } from "../api/types";
import { daysUntil, integer, isoDay, money } from "../lib/format";
import { Button } from "../ui/Button";
import { ErrorState } from "../ui/States";
import { ROLE_LABELS } from "../ui/status";
import type { Permission } from "../api/types";
import { AssistantLauncher, openAssistant } from "./Assistant";
import { AppFrame, type FrameActions, type FrameGroup, type FrameItem } from "./AppFrame";
import { NAV, type NavGroup } from "./nav";
import { useCan, useLogout, useMe, useTenantContext } from "./session";

export const wpath = (tenantId: string, to: string) => to.replace("$tenantId", tenantId);

function useVisibleNav(ctx: TenantContext | undefined): NavGroup[] {
  const can = useCan(ctx);
  const sector = ctx?.tenant.sector ?? "restaurants";
  return NAV.map((g) => ({ ...g, items: g.items.filter((i) => i.permission === null || can(i.permission)).map((i) => ({ ...i, label: i.labels?.[sector] ?? i.label })) }))
    .filter((g) => g.items.length > 0);
}

/** Exact match for the dashboards (their paths prefix other pages), prefix match for everything else. */
const EXACT = new Set(["/w/$tenantId", "/w/$tenantId/accounting"]);
function isCurrent(pathname: string, href: string, isRoot: boolean) {
  return isRoot ? pathname === href || pathname === `${href}/` : pathname === href || pathname.startsWith(`${href}/`);
}

const HOME_GROUP = "الرئيسية";
const PINNED_GROUP = "الإعدادات";

export function WorkspaceShell({ tenantId }: { tenantId: string }) {
  const me = useMe();
  const ctx = useTenantContext(tenantId);
  const logout = useLogout();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const nav = useVisibleNav(ctx.data);

  if (ctx.isError) {
    // 403: not a member (or membership revoked). Never render another tenant's page from a URL guess.
    return <div className="page"><ErrorState error={ctx.error} title="لا يمكن فتح هذه المنشأة" onRetry={() => ctx.refetch()} /><Link to="/app" className="btn btn-secondary" style={{ alignSelf: "center" }}>العودة لمنشآتي</Link></div>;
  }

  const c = ctx.data;
  const tenants = me.data?.tenants ?? [];
  const current = tenants.find((t) => t.id === tenantId);
  const days = daysUntil(c?.subscription.endsAt);
  const toItem = (i: NavGroup["items"][number]): FrameItem => {
    const href = wpath(tenantId, i.to);
    return { label: i.label, href, icon: i.icon, current: isCurrent(pathname, href, EXACT.has(i.to)) };
  };
  const groups: FrameGroup[] = nav.filter((g) => g.label !== PINNED_GROUP).map((g) => ({ label: g.label === HOME_GROUP ? "" : g.label, items: g.items.map(toItem) }));
  const pinned = nav.find((g) => g.label === PINNED_GROUP)?.items.map(toItem) ?? [];
  const activeGroup = nav.find((g) => g.items.some((i) => toItem(i).current));
  const activeItem = activeGroup?.items.find((i) => toItem(i).current);
  const crumbs = [c?.tenant.companyName ?? "مُنَسِّق", ...(activeGroup && activeGroup.label !== HOME_GROUP && activeGroup.items.length > 1 ? [activeGroup.label] : []), ...(activeItem ? [activeItem.label] : [])];
  const roleLabel = c ? (c.role === "custom" ? c.roleName ?? "دور مخصص" : ROLE_LABELS[c.role] ?? c.role) : undefined;
  const has = (p: Permission) => Boolean(c?.permissions.includes(p));
  const home = `/w/${tenantId}`;
  const isHome = pathname === home || pathname === `${home}/`;
  // Full-screen tools keep the whole height (the cashier's pay button sits at the bottom).
  const fullScreen = /\/(pos|kitchen)\/?$/.test(pathname);
  const shortcuts = SHORTCUTS.filter((s) => has(s.permission)).map((s) => ({ ...s, href: wpath(tenantId, s.to) }));

  return (
    <>
    <AppFrame
      home={`/w/${tenantId}`}
      storageKey={`mn.sidebar.v1.${me.data?.user.id ?? "anon"}`}
      context={<TenantSwitcher tenants={tenants} current={current} fallback={c?.tenant.companyName ?? ""} onPick={(id) => navigate({ to: `/w/${id}` })} />}
      groups={groups}
      pinned={pinned}
      crumbs={crumbs}
      roleLabel={roleLabel}
      status={c && days !== null && (
        <span className={["sub-pill only-wide", !c.operational ? "is-danger" : days <= 3 ? "is-warning" : ""].join(" ")} title={c.subscription.planName ?? undefined}>
          <span className="sub-dot" aria-hidden="true" />
          {!c.operational ? "الاشتراك غير ساري" : days === 0 ? "ينتهي الاشتراك اليوم" : `${c.subscription.status === "trial" ? "التجربة" : "الاشتراك"}: متبقٍ ${integer(days)} يوماً`}
        </span>
      )}
      account={[
        { label: "حسابي وكلمة المرور", onSelect: () => navigate({ to: "/account" }) },
        { label: "منشآتي", onSelect: () => navigate({ to: "/app" }) },
        ...(me.data?.user.isPlatformAdmin ? [{ label: "إدارة المنصة", onSelect: () => navigate({ to: "/admin" }) }] : []),
        { label: "تسجيل الخروج", onSelect: logout, separated: true },
      ]}
      mobile={{
        pill: <Link to="/app" className="m-hero-pill"><Store aria-hidden="true" /><span>{c?.tenant.companyName ?? "منشآتي"}</span></Link>,
        hero: isHome ? (a) => <HomeHero tenantId={tenantId} shortcuts={shortcuts.slice(0, 3)} actions={a} canReport={has("rep_daily_sales.view")} days={days} /> : undefined,
        tabbar: fullScreen ? undefined : (a) => (
          <TabBar pathname={pathname} home={home} tabs={shortcuts.filter((s) => s.tab).slice(0, 2)} actions={a} ai={has("assistant.use")} />
        ),
      }}
      banners={<>
        {c && !c.operational && !c.readOnlySupport && (
          <div className="banner banner-danger" role="status">
            المنشأة غير مفعّلة: الاشتراك منتهٍ أو الحساب موقوف. يمكنك الاطلاع على البيانات فقط، وأي حفظ سيُرفض. تواصل مع إدارة المنصة لتجديد الاشتراك.
          </div>
        )}
        {c?.limits.storage?.limitMb && c.limits.storage.usedMb >= c.limits.storage.limitMb && (
          <div className="banner banner-warning" role="status">
            امتلأت مساحة التخزين في باقتك: الاستيراد وحفظ الملفات متوقفان، والبيع والمخزون يعملان كالمعتاد.
            {c.permissions.includes("billing.pay") && <> <Link to={`/w/${tenantId}/billing`}>شراء مساحة إضافية</Link></>}
          </div>
        )}
        {c?.readOnlySupport && <SupportBanner session={c.supportSession} companyName={c.tenant.companyName} />}
      </>}
    >
      {ctx.isPending ? <div className="page" aria-busy="true"><span className="sr-only" role="status">جارٍ تحميل بيانات المنشأة…</span></div> : <Outlet />}
    </AppFrame>
    {/* Outside the frame: the top bar's backdrop-filter would trap a fixed-position child. */}
    {c?.permissions.includes("assistant.use") && <AssistantLauncher key={tenantId} scope={{ kind: "tenant", tenantId }} companyName={c.tenant.companyName} firstName={me.data?.user.fullName.trim().split(/\s+/)[0] ?? ""} />}
    </>
  );
}

function TenantSwitcher({ tenants, current, fallback, onPick }: { tenants: MeTenant[]; current: MeTenant | undefined; fallback: string; onPick: (id: string) => void }) {
  const name = current?.companyName ?? fallback;
  if (tenants.length <= 1) {
    return <div className="workspace-card"><span className="workspace-initial" aria-hidden="true">{name.trim()[0] ?? "م"}</span><span className="workspace-name">{name}</span></div>;
  }
  return (
    <label className="workspace-card is-select">
      <span className="workspace-initial" aria-hidden="true">{name.trim()[0] ?? "م"}</span>
      <span className="sr-only">المنشأة الحالية</span>
      <select value={current?.id ?? ""} onChange={(e) => onPick(e.target.value)}>
        {tenants.map((t) => <option key={t.id} value={t.id}>{t.companyName}</option>)}
      </select>
    </label>
  );
}

function SupportBanner({ session, companyName }: { session: { id: string; expiresAt: string } | null; companyName: string }) {
  const navigate = useNavigate();
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const mins = session ? Math.max(0, Math.ceil((Date.parse(session.expiresAt) - now) / 60_000)) : null;
  return (
    <div className="banner banner-info" role="status">
      <span>جلسة دعم فني في «{companyName}»: قراءة فقط ومسجّلة في سجل التدقيق.{mins !== null && ` تنتهي خلال ${integer(mins)} دقيقة.`}</span>
      <span className="spacer" />
      {session && <Button size="sm" loading={busy} loadingText="جارٍ الإنهاء…" onClick={async () => {
        setBusy(true);
        await api("DELETE", `/admin/support-sessions/${session.id}`).catch(() => undefined);
        navigate({ to: "/admin/tenants" });
      }}>إنهاء جلسة الدعم</Button>}
    </div>
  );
}

interface Shortcut { label: string; to: string; icon: LucideIcon; permission: Permission; tab?: boolean }
/** The most used screens, first that the member may open. The first three are the home quick actions; `tab` ones are also bottom tabs. */
const SHORTCUTS: Shortcut[] = [
  { label: "الكاشير", to: "/w/$tenantId/pos", icon: TabletSmartphone, permission: "pos.sell", tab: true },
  { label: "المشتريات", to: "/w/$tenantId/purchases", icon: ShoppingCart, permission: "purchases.view" },
  { label: "المخزون", to: "/w/$tenantId/stock", icon: Warehouse, permission: "stock.view", tab: true },
  { label: "التقارير", to: "/w/$tenantId/reports/daily-sales", icon: BarChart3, permission: "rep_daily_sales.view", tab: true },
  { label: "الوصفات", to: "/w/$tenantId/recipes", icon: ChefHat, permission: "recipes.view" },
  { label: "الحسابات", to: "/w/$tenantId/accounting", icon: BookOpen, permission: "acc_overview.view", tab: true },
];
type Linked = Shortcut & { href: string };

/** Phone home header: three quick actions + "all pages", then today's figure (the reference's "next prayer" slot). */
function HomeHero({ tenantId, shortcuts, actions, canReport, days }: { tenantId: string; shortcuts: Linked[]; actions: FrameActions; canReport: boolean; days: number | null }) {
  const today = isoDay();
  // Same query as the dashboard's sales card, so the two share one request and never disagree.
  const sales = useQuery({ enabled: canReport, queryKey: ["t", tenantId, "reports", "daily", today],
    queryFn: () => api<{ items: { orders: number; total: number; grossProfit: number }[] }>("GET", "/t/reports/daily-sales", { tenant: tenantId, query: { from: today, to: today } }) });
  const row = sales.data?.items[0];
  return (
    <>
      <nav className="m-quick" aria-label="اختصارات">
        {shortcuts.map((s) => (
          <Link key={s.href} to={s.href} className="m-quick-item"><s.icon aria-hidden="true" /><span>{s.label}</span></Link>
        ))}
        <button type="button" className="m-quick-item" onClick={actions.openMenu}><LayoutGrid aria-hidden="true" /><span>كل الصفحات</span></button>
      </nav>
      {canReport ? (
        <Link to={`/w/${tenantId}/reports/daily-sales`} className="m-next" aria-live="polite">
          <span className="m-next-icon" aria-hidden="true"><TrendingUp /></span>
          <span className="m-next-text">
            {sales.isPending ? <><strong>مبيعات اليوم</strong><span>جارٍ التحميل…</span></>
              : sales.isError ? <><strong>مبيعات اليوم</strong><span>تعذر التحميل. اضغط لفتح التقرير</span></>
              : <><strong>مبيعات اليوم <span className="num">{money(row?.total ?? 0)}</span></strong>
                  <span>{row ? `${integer(row.orders)} طلب · مجمل الربح ${money(row.grossProfit)}` : "لا توجد مبيعات بعد اليوم"}</span></>}
          </span>
        </Link>
      ) : days !== null ? (
        <div className="m-next">
          <span className="m-next-icon" aria-hidden="true"><TrendingUp /></span>
          <span className="m-next-text"><strong>الاشتراك</strong><span>{days === 0 ? "ينتهي اليوم" : `متبقٍ ${integer(days)} يوماً`}</span></span>
        </div>
      ) : null}
    </>
  );
}

/** Phone bottom navigation: home, two most used screens, all pages, and the assistant pill. */
function TabBar({ pathname, home, tabs, actions, ai }: { pathname: string; home: string; tabs: Linked[]; actions: FrameActions; ai: boolean }) {
  const isHome = pathname === home || pathname === `${home}/`;
  return (
    <nav className="m-tabbar" aria-label="التنقل السفلي">
      <Link to={home} activeOptions={{ exact: true }} className="m-tab" aria-current={isHome ? "page" : undefined}><span className="m-tab-icon"><House aria-hidden="true" /></span><span>الرئيسية</span></Link>
      {tabs.map((t) => {
        const current = pathname === t.href || pathname.startsWith(`${t.href}/`);
        return <Link key={t.href} to={t.href} className="m-tab" aria-current={current ? "page" : undefined}><span className="m-tab-icon"><t.icon aria-hidden="true" /></span><span>{t.label}</span></Link>;
      })}
      <button type="button" className="m-tab" onClick={actions.openMenu}><span className="m-tab-icon"><LayoutGrid aria-hidden="true" /></span><span>القائمة</span></button>
      {ai && (
        <button type="button" className="m-ai-pill" onClick={openAssistant} aria-label="المساعد الذكي">
          <span className="m-ai-dots" aria-hidden="true"><i /><i /><i /></span><span>مُنَسِّق <b>AI</b></span>
        </button>
      )}
    </nav>
  );
}
