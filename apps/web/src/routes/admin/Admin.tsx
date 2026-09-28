import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { ArrowRight, Building2, CalendarClock, Check, ChevronLeft, CreditCard, Plus, ShieldAlert, Users, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type Page } from "../../api/client";
import { AppFrame } from "../../app/AppFrame";
import { AssistantLauncher } from "../../app/Assistant";
import { ADMIN_NAV, ADMIN_PINNED } from "../../app/nav";
import { useLogout, useMe } from "../../app/session";
import { RIYAL, addDays, day, dayTime, integer, isoDay, money, text } from "../../lib/format";
import { Button } from "../../ui/Button";
import { DataTable } from "../../ui/DataTable";
import { ConfirmDialog, Dialog } from "../../ui/Dialog";
import { SearchInput, SelectField, TextAreaField, TextField } from "../../ui/Field";
import { ActionMenu, Badge, PageHeader, StatCard, StatusBadge, type Hue } from "../../ui/Layout";
import { EmptyState, ErrorState, FormError, Skeleton, TableSkeleton } from "../../ui/States";
import { type CatalogModule, permKey } from "../../ui/permissions";
import { AUDIT_LABELS, ROLE_LABELS } from "../../ui/status";
import { useTablePrefs } from "../../ui/tablePrefs";
import { bytes, mbLabel } from "./AdminServer";
import { useToast } from "../../ui/Toast";

export function AdminShell() {
  const me = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  if (me.isPending) return <p className="page" role="status" aria-busy="true">جارٍ التحقق من الصلاحية…</p>;
  // Clear 403. No silent "claim super-admin" attempt: the first admin is created from the server console.
  if (!me.data?.user.isPlatformAdmin) {
    return <div className="page"><EmptyState kind="permission" title="هذه الصفحة لمدير المنصة فقط" action={<Link to="/app" className="btn btn-secondary">العودة لمنشآتي</Link>}>حسابك لا يملك صلاحية إدارة المنصة.</EmptyState></div>;
  }
  const toItem = (n: { label: string; to: string; icon: LucideIcon }) => ({ label: n.label, href: n.to, icon: n.icon, current: n.to === "/admin" ? pathname === "/admin" || pathname === "/admin/" : pathname === n.to || pathname.startsWith(`${n.to}/`) });
  const groups = ADMIN_NAV.map((g) => ({ label: g.label, items: g.items.map(toItem) }));
  const pinned = ADMIN_PINNED.map(toItem);
  const all = [...groups.flatMap((g) => g.items.map((i) => ({ ...i, group: g.label }))), ...pinned.map((i) => ({ ...i, group: "" }))];
  const current = all.find((i) => i.current);
  return (
    <>
    <AppFrame
      home="/admin"
      storageKey={`mn.sidebar.admin.v1.${me.data.user.id}`}
      context={<div className="workspace-card"><span className="workspace-initial" aria-hidden="true"><ShieldAlert /></span><span className="workspace-name">إدارة المنصة</span></div>}
      groups={groups}
      pinned={pinned}
      crumbs={["إدارة المنصة", ...(current?.group && current.group !== current.label ? [current.group] : []), current?.label ?? "نظرة عامة"]}
      roleLabel="مدير المنصة"
      account={[
        { label: "حسابي وكلمة المرور", onSelect: () => navigate({ to: "/account" }) },
        { label: "منشآتي", onSelect: () => navigate({ to: "/app" }) },
        { label: "تسجيل الخروج", onSelect: logout, separated: true },
      ]}
    >
      <Outlet />
    </AppFrame>
    <AssistantLauncher scope={{ kind: "platform" }} companyName="إدارة المنصة" firstName={me.data.user.fullName.trim().split(/\s+/)[0] ?? ""} />
    </>
  );
}

interface Stats { activeTenants: number; blockedTenants: number; users: number; runningTrials: number; expiringSoon: number; paidActive: number; waitlist: number }

/** Same order as the cards: the warning first, then paid subscriptions, tenants and people, each in its own hue. */
type OverviewKpi = { label: string; icon: React.ReactNode; hue: Hue };
const OVERVIEW_KPIS: [OverviewKpi, OverviewKpi, OverviewKpi, OverviewKpi] = [
  { label: "اشتراكات تنتهي خلال 7 أيام", icon: <CalendarClock />, hue: "amber" },
  { label: "اشتراكات مدفوعة سارية", icon: <CreditCard />, hue: "green" },
  { label: "منشآت نشطة", icon: <Building2 />, hue: "indigo" },
  { label: "المستخدمون", icon: <Users />, hue: "violet" },
];

export function AdminOverview() {
  const s = useQuery({ queryKey: ["admin", "stats"], queryFn: () => api<Stats>("GET", "/admin/stats") });
  const expiring = useQuery({ queryKey: ["admin", "tenants", "overview"], queryFn: () => api<Page<TenantRow>>("GET", "/admin/tenants", { query: { pageSize: 100 } }) });
  const soon = (expiring.data?.items ?? []).filter((t) => t.endsAt && t.endsAt <= addDays(isoDay(), 7) && t.status === "active").slice(0, 10);
  return (
    <div className="page">
      <PageHeader title="نظرة عامة" description="ما يحتاج متابعة أولاً: اشتراكات تنتهي خلال 7 أيام." />
      {s.isError ? <ErrorState error={s.error} onRetry={() => s.refetch()} /> : (
        <div className="stats stats-4">
          {s.isPending ? OVERVIEW_KPIS.map((k) => (
            <div key={k.label} className="stat" aria-busy="true"><span className={`stat-icon tone-${k.hue}`} aria-hidden="true">{k.icon}</span><span className="label">{k.label}</span><Skeleton width="45%" height={28} /><Skeleton width="60%" /></div>
          )) : <>
            <StatCard {...OVERVIEW_KPIS[0]} value={integer(s.data.expiringSoon)} noteTone={s.data.expiringSoon ? "warning" : undefined} note={s.data.expiringSoon ? "تواصل للتجديد" : "لا شيء عاجل"} />
            <StatCard {...OVERVIEW_KPIS[1]} value={integer(s.data.paidActive)} note={`${integer(s.data.runningTrials)} تجربة جارية`} />
            <StatCard {...OVERVIEW_KPIS[2]} value={integer(s.data.activeTenants)} note={`${integer(s.data.blockedTenants)} موقوفة`} />
            <StatCard {...OVERVIEW_KPIS[3]} value={integer(s.data.users)} note={`${integer(s.data.waitlist)} في قائمة الاهتمام`} />
          </>}
        </div>
      )}
      <section className="panel">
        <DataTable caption="اشتراكات تنتهي قريباً" query={{ ...expiring, data: expiring.data ? { items: soon } : undefined }} rowKey={(t) => t.id}
          toolbar={<h2>تنتهي قريباً</h2>}
          empty={{ title: "لا توجد اشتراكات تنتهي خلال 7 أيام", body: "" }}
          columns={[
            { key: "name", sortKey: "companyName", header: "المنشأة", cell: (t) => <Link to={`/admin/tenants/${t.id}`}><strong>{t.companyName}</strong></Link> },
            { key: "sub", sortKey: "subscriptionStatus", header: "الاشتراك", cell: (t) => <StatusBadge kind="subscription" value={t.subscriptionStatus} /> },
            { key: "end", sortKey: "endsAt", header: "ينتهي", cell: (t) => day(t.endsAt) },
            { key: "owner", sortKey: "ownerEmail", header: "المالك", cell: (t) => <span dir="ltr">{t.ownerEmail}</span> },
          ]} />
      </section>
    </div>
  );
}

interface TenantRow { id: string; companyName: string; sector: string; status: string; taxId: string; taxIdVerified: boolean; createdAt: string; ownerEmail: string; subscriptionStatus: string | null; endsAt: string | null; planName: string | null; duplicateTaxId: boolean }

export function AdminTenants() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const prefs = useTablePrefs("admin-tenants", { server: true, onSortChange: () => setPage(1) });
  useEffect(() => { const t = setTimeout(() => { setDebounced(q.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);
  const list = useQuery({ queryKey: ["admin", "tenants", { q: debounced, status, page, sort: prefs.sortParam }], queryFn: () => api<Page<TenantRow>>("GET", "/admin/tenants", { query: { q: debounced, status, page, pageSize: 25, sort: prefs.sortParam } }), placeholderData: keepPreviousData });
  return (
    <div className="page">
      <PageHeader title="العملاء" description="ابحث باسم المنشأة أو بريد المالك أو الرقم الضريبي."
        actions={<Link to="/admin/tenants/new" className="btn btn-primary"><Plus aria-hidden="true" />عميل جديد</Link>} />
      <section className="panel">
        <DataTable caption="العملاء" prefs={prefs} query={list} rowKey={(t) => t.id} onPageChange={setPage} filtered={Boolean(debounced || status)} onClearFilters={() => { setQ(""); setStatus(""); }}
          toolbar={<>
            <SearchInput placeholder="اسم المنشأة، بريد المالك، الرقم الضريبي" value={q} onChange={setQ} />
            <select className="select" aria-label="الحالة" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              <option value="">كل الحالات</option><option value="active">نشطة</option><option value="blocked">موقوفة</option><option value="archived">مؤرشفة</option>
            </select>
          </>}
          onRowClick={(t) => navigate({ to: `/admin/tenants/${t.id}` })}
          empty={{ title: "لا يوجد عملاء بعد", body: "تظهر المنشآت هنا عند إنشائها من صفحة التسجيل." }}
          columns={[
            { key: "name", sortKey: "companyName", header: "المنشأة", cell: (t) => <Link to={`/admin/tenants/${t.id}`}><strong>{t.companyName}</strong></Link> },
            { key: "owner", sortKey: "ownerEmail", header: "المالك", cell: (t) => <span dir="ltr">{t.ownerEmail}</span> },
            { key: "tax", sortKey: "taxId", header: "الرقم الضريبي", cell: (t) => <span className="row" style={{ flexWrap: "nowrap" }}><span className="num">{t.taxId}</span>{t.taxIdVerified ? <Badge tone="success">موثّق</Badge> : t.duplicateTaxId ? <Badge tone="warning">مكرر</Badge> : null}</span> },
            { key: "plan", sortKey: "planName", header: "الباقة", cell: (t) => text(t.planName) },
            { key: "sub", sortKey: "subscriptionStatus", header: "الاشتراك", cell: (t) => <StatusBadge kind="subscription" value={t.subscriptionStatus} /> },
            { key: "end", sortKey: "endsAt", header: "ينتهي", cell: (t) => day(t.endsAt) },
            { key: "status", sortKey: "status", header: "الحالة", cell: (t) => <StatusBadge kind="tenant" value={t.status} /> },
          ]} />
      </section>
    </div>
  );
}

const HUES: Hue[] = ["indigo", "sky", "green", "orange", "violet", "amber"];
/** A stable avatar tint per person. */
const hueOf = (id: string) => HUES[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length]!;
const initials = (name: string) => name.trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join("");

interface TenantDetail {
  id: string; companyName: string; sector: string; status: string; blockedReason: string | null; taxId: string; taxIdVerified: boolean; city: string | null; createdAt: string;
  ownerEmail: string; ownerName: string; subscriptionStatus: string | null; startsAt: string | null; endsAt: string | null; totalValue: number | null; planCode: string | null; planName: string | null;
  branchesOverride: number | null; usersOverride: number | null; branchesLimit: number | null; usersLimit: number | null; branchesUsed: number; usersUsed: number;
  /** Assistant questions per member per day: override (null = platform default, 0 = off), default, and usage. */
  assistantOverride: number | null; assistantDefault: number; assistantTurnsToday: number; assistantTurns30: number;
  storageLimitMb: number | null; storageUsedBytes: number; storageMeasuredAt: string | null; storageExtraMb: number;
  members: { userId: string; email: string; fullName: string; role: string; roleName: string | null; isActive: boolean }[];
}

export function AdminTenantDetail() {
  const { tenantId } = useParams({ strict: false }) as { tenantId: string };
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const t = useQuery({ queryKey: ["admin", "tenant", tenantId], queryFn: () => api<TenantDetail>("GET", `/admin/tenants/${tenantId}`) });
  const [dialog, setDialog] = useState<null | "sub" | "limits" | "block" | "unblock" | "verify" | "support">(null);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["admin"] })]);
  if (t.isPending) return <div className="page"><TableSkeleton columns={3} rows={5} /></div>;
  if (t.isError) return <div className="page"><ErrorState error={t.error} onRetry={() => t.refetch()} /></div>;
  const d = t.data;
  const done = async (msg: string) => { setDialog(null); toast.success(msg); await refresh(); };
  return (
    <div className="page">
      <PageHeader eyebrow="عميل" title={<span className="ca-title">{d.companyName}<StatusBadge kind="tenant" value={d.status} /></span>}
        description={<>{d.ownerName} · <span dir="ltr">{d.ownerEmail}</span> · أُنشئت {day(d.createdAt)}</>}
        actions={<>
          <Link to="/admin/tenants" className="btn btn-ghost"><ArrowRight aria-hidden="true" />العملاء</Link>
          <Button onClick={() => setDialog("support")}>دخول دعم (قراءة فقط)</Button>
          <Button variant="primary" onClick={() => setDialog("sub")}>تعديل الاشتراك</Button>
        </>} />
      {d.status === "blocked" && <p className="banner banner-danger ca-banner"><ShieldAlert aria-hidden="true" />موقوفة: {d.blockedReason}</p>}

      <div className="ca-facts">
        <section className="panel" aria-labelledby="t-sub">
          <div className="card-head"><span className="ca-head-icon tone-green" aria-hidden="true"><CreditCard /></span><h2 id="t-sub">الاشتراك</h2></div>
          <div className="card-body">
            <dl className="dl">
              <dt>الباقة</dt><dd>{text(d.planName)}</dd>
              <dt>الحالة</dt><dd><StatusBadge kind="subscription" value={d.subscriptionStatus} /></dd>
              <dt>الفترة</dt><dd>{day(d.startsAt)} ← {day(d.endsAt)}</dd>
              <dt>القيمة</dt><dd className="num">{money(d.totalValue)}</dd>
            </dl>
          </div>
        </section>
        <section className="panel" aria-labelledby="t-lim">
          <div className="card-head"><span className="ca-head-icon tone-sky" aria-hidden="true"><Users /></span><h2 id="t-lim">الحدود</h2><span className="spacer" /><Button size="sm" variant="ghost" onClick={() => setDialog("limits")}>تعديل</Button></div>
          <div className="card-body">
            <dl className="dl">
              <dt>الفروع</dt><dd>{integer(d.branchesUsed)} من {integer(d.branchesLimit)} {d.branchesOverride !== null && <Badge tone="info">استثناء</Badge>}</dd>
              <dt>المستخدمون</dt><dd>{integer(d.usersUsed)} من {integer(d.usersLimit)} {d.usersOverride !== null && <Badge tone="info">استثناء</Badge>}</dd>
              <dt>مساحة التخزين</dt>
              <dd>{bytes(d.storageUsedBytes)} من {d.storageLimitMb === null ? "—" : mbLabel(d.storageLimitMb)} {d.storageExtraMb > 0 && <Badge tone="info">+{mbLabel(d.storageExtraMb)} إضافية</Badge>}
                <span className="muted"> · {d.storageMeasuredAt ? `قيست ${dayTime(d.storageMeasuredAt)}` : "لم تُقس بعد"}</span></dd>
              <dt>أسئلة المساعد يومياً</dt>
              <dd>
                {d.assistantOverride === 0 ? <Badge tone="danger">موقوف</Badge> : <>{integer(d.assistantOverride ?? d.assistantDefault)} لكل عضو {d.assistantOverride !== null && <Badge tone="info">استثناء</Badge>}</>}
                <span className="muted"> · اليوم {integer(d.assistantTurnsToday)}، آخر 30 يوماً {integer(d.assistantTurns30)}</span>
              </dd>
            </dl>
          </div>
        </section>
        <section className="panel" aria-labelledby="t-id">
          <div className="card-head"><span className="ca-head-icon tone-indigo" aria-hidden="true"><Building2 /></span><h2 id="t-id">الهوية</h2><span className="spacer" />
            <ActionMenu label="إجراءات المنشأة" items={[
              ...(!d.taxIdVerified ? [{ label: "توثيق الرقم الضريبي", onSelect: () => setDialog("verify") }] : []),
              d.status === "blocked"
                ? { label: "إعادة تفعيل المنشأة", separated: true, onSelect: () => setDialog("unblock") }
                : { label: "إيقاف المنشأة", danger: true, separated: true, onSelect: () => setDialog("block") },
            ]} />
          </div>
          <div className="card-body">
            <dl className="dl">
              <dt>الحالة</dt><dd><StatusBadge kind="tenant" value={d.status} /></dd>
              <dt>الرقم الضريبي</dt><dd><span className="num">{d.taxId}</span> {d.taxIdVerified ? <Badge tone="success">موثّق</Badge> : <Badge tone="warning">غير موثّق</Badge>}</dd>
              <dt>القطاع</dt><dd>{d.sector === "restaurants" ? "المطاعم" : d.sector}</dd>
              <dt>المدينة</dt><dd>{text(d.city)}</dd>
            </dl>
          </div>
        </section>
      </div>

      <section className="panel">
        <DataTable caption="أعضاء المنشأة" query={{ ...t, data: { items: d.members } }} rowKey={(m) => m.userId} empty={{ title: "لا يوجد أعضاء", body: "" }}
          toolbar={<h2>الأعضاء</h2>}
          columns={[
            { key: "n", sortKey: "fullName", header: "الاسم", cell: (m) => (
              <span className="ca-person-cell"><span className={`avatar tone-${hueOf(m.userId)}`} aria-hidden="true">{initials(m.fullName)}</span><strong>{m.fullName}</strong></span>
            ) },
            { key: "e", sortKey: "email", header: "البريد", cell: (m) => <span dir="ltr">{m.email}</span> },
            { key: "r", sortKey: "role", header: "الدور", cell: (m) => (m.role === "custom" ? `${m.roleName} (مخصص)` : ROLE_LABELS[m.role] ?? m.role) },
            { key: "s", sortKey: "isActive", header: "الحالة", cell: (m) => <StatusBadge kind="active" value={m.isActive} /> },
          ]} />
      </section>
      <Link to={`/admin/audit?tenantId=${d.id}`} className="btn btn-ghost" style={{ alignSelf: "flex-start" }}>سجل التدقيق لهذه المنشأة<ChevronLeft aria-hidden="true" /></Link>

      {dialog === "sub" && <SubscriptionDialog t={d} onClose={() => setDialog(null)} onDone={() => done("تم تحديث الاشتراك")} />}
      {dialog === "limits" && <LimitsDialog t={d} onClose={() => setDialog(null)} onDone={() => done("تم تحديث الحدود")} />}
      {(dialog === "block" || dialog === "unblock") && <BlockDialog t={d} block={dialog === "block"} onClose={() => setDialog(null)} onDone={() => done(dialog === "block" ? `تم إيقاف ${d.companyName}` : `تمت إعادة تفعيل ${d.companyName}`)} />}
      {dialog === "verify" && <SimpleConfirm title="توثيق الرقم الضريبي" label="توثيق الرقم" destructive={false} path={`/admin/tenants/${d.id}/verify-tax-id`}
        message={<>بعد التوثيق يصبح الرقم <span className="num">{d.taxId}</span> محجوزاً لـ<strong>{d.companyName}</strong> ولا يمكن لمنشأة أخرى توثيقه.</>} onClose={() => setDialog(null)} onDone={() => done("تم توثيق الرقم الضريبي")} />}
      {dialog === "support" && <SupportDialog t={d} onClose={() => setDialog(null)} onStarted={() => { setDialog(null); navigate({ to: `/w/${d.id}` }); }} />}
    </div>
  );
}

function SimpleConfirm({ title, label, message, path, destructive, onClose, onDone }: { title: string; label: string; message: React.ReactNode; path: string; destructive: boolean; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <ConfirmDialog open onClose={onClose} busy={busy} error={error} title={title} confirmLabel={label} destructive={destructive} message={message}
    onConfirm={async () => { setBusy(true); setError(null); try { await api("POST", path); onDone(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }} />;
}

function BlockDialog({ t, block, onClose, onDone }: { t: TenantDetail; block: boolean; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <ConfirmDialog open onClose={onClose} busy={busy} error={error} destructive={block}
      title={block ? `إيقاف ${t.companyName}` : `إعادة تفعيل ${t.companyName}`} confirmLabel={block ? "إيقاف المنشأة" : "إعادة التفعيل"}
      message={block ? <>سيفقد كل أعضاء <strong>{t.companyName}</strong> القدرة على أي حفظ فوراً، وتبقى بياناتهم للقراءة. السبب يظهر لفريق المنصة ويُسجَّل في التدقيق.</> : <>ستعود <strong>{t.companyName}</strong> لقبول الحفظ إذا كان اشتراكها سارياً.</>}
      onConfirm={async () => {
        if (block && reason.trim().length < 3) return setError("اكتب سبب الإيقاف (3 أحرف على الأقل)");
        setBusy(true); setError(null);
        try { await api("POST", `/admin/tenants/${t.id}/status`, { body: block ? { status: "blocked", reason: reason.trim() } : { status: "active" } }); onDone(); }
        catch (e) { setError((e as Error).message); } finally { setBusy(false); }
      }}>
      {block && <TextAreaField label="سبب الإيقاف" required value={reason} onChange={(e) => setReason(e.target.value)} />}
    </ConfirmDialog>
  );
}

interface Plan { code: string; nameAr: string; sector: string; monthlyPrice: number; branchesLimit: number; usersLimit: number; isActive: boolean }

function SubscriptionDialog({ t, onClose, onDone }: { t: TenantDetail; onClose: () => void; onDone: () => void }) {
  const plans = useQuery({ queryKey: ["admin", "plans"], queryFn: () => api<{ items: Plan[] }>("GET", "/admin/plans"), staleTime: Infinity });
  const [v, setV] = useState({ planCode: t.planCode ?? "", status: t.subscriptionStatus ?? "active", startsAt: t.startsAt ?? isoDay(), endsAt: t.endsAt ?? addDays(isoDay(), 30), totalValue: String(t.totalValue ?? 0) });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!v.planCode) return setError("اختر الباقة");
    if (v.endsAt <= v.startsAt) return setError("تاريخ النهاية يجب أن يكون بعد البداية");
    setBusy(true); setError(null);
    try { await api("PUT", `/admin/tenants/${t.id}/subscription`, { body: { ...v, totalValue: Number(v.totalValue) || 0 } }); onDone(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} title={`اشتراك ${t.companyName}`} onSubmit={() => void submit()}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">حفظ الاشتراك</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <div className="form-grid">
        <SelectField label="الباقة" required value={v.planCode} onChange={(e) => setV({ ...v, planCode: e.target.value })} placeholder={plans.isPending ? "جارٍ التحميل…" : "اختر الباقة"}
          options={(plans.data?.items ?? []).filter((p) => p.sector === t.sector && p.isActive).map((p) => ({ value: p.code, label: `${p.nameAr} · ${money(p.monthlyPrice)} شهرياً · ${p.branchesLimit} فروع / ${p.usersLimit} مستخدمين` }))} />
        <SelectField label="الحالة" required value={v.status} onChange={(e) => setV({ ...v, status: e.target.value })}
          options={[{ value: "trial", label: "تجريبي" }, { value: "active", label: "ساري" }, { value: "suspended", label: "معلّق (قراءة فقط)" }, { value: "expired", label: "منتهٍ" }]} />
        <TextField label="من" type="date" required value={v.startsAt} onChange={(e) => setV({ ...v, startsAt: e.target.value })} />
        <TextField label="إلى" type="date" required value={v.endsAt} min={v.startsAt} onChange={(e) => setV({ ...v, endsAt: e.target.value })} />
        <TextField label={`القيمة الإجمالية (${RIYAL})`} numeric value={v.totalValue} onChange={(e) => setV({ ...v, totalValue: e.target.value })} />
      </div>
      <FormError error={error} />
    </Dialog>
  );
}

function LimitsDialog({ t, onClose, onDone }: { t: TenantDetail; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState({
    branches: t.branchesOverride === null ? "" : String(t.branchesOverride),
    users: t.usersOverride === null ? "" : String(t.usersOverride),
    assistant: t.assistantOverride === null ? "" : String(t.assistantOverride),
    extraGb: String(t.storageExtraMb / 1024),
  });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const parse = (s: string) => (s.trim() === "" ? null : Number(s));
  async function submit() {
    const b = parse(v.branches); const u = parse(v.users); const a = parse(v.assistant);
    if ((b !== null && !(Number.isInteger(b) && b >= 1)) || (u !== null && !(Number.isInteger(u) && u >= 1))) return setError("الحد رقم صحيح من 1 فأكثر، أو اتركه فارغاً لحد الباقة");
    if (a !== null && !(Number.isInteger(a) && a >= 0 && a <= 10_000)) return setError("أسئلة المساعد رقم صحيح من 0 إلى 10000، أو اتركه فارغاً للحد الافتراضي");
    const extraMb = Math.round(Number(v.extraGb || "0") * 1024);
    if (!(extraMb >= 0)) return setError("المساحة الإضافية رقم بالجيجابايت، أو 0");
    setBusy(true); setError(null);
    try {
      await api("PUT", `/admin/tenants/${t.id}/limits`, { body: { branchesLimit: b, usersLimit: u, assistantDailyTurns: a } });
      if (extraMb !== t.storageExtraMb) await api("PUT", `/admin/tenants/${t.id}/storage`, { body: { extraMb } });
      onDone();
    }
    catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} title={`حدود ${t.companyName}`} onSubmit={() => void submit()}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">حفظ الحدود</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <p className="muted">اترك الحقل فارغاً لاستخدام حد الباقة. الاستثناء لا يلغي الحد، بل يستبدله.</p>
      <div className="form-grid">
        <TextField label="الفروع" optional numeric value={v.branches} onChange={(e) => setV({ ...v, branches: e.target.value })} hint={`المستخدم حالياً ${integer(t.branchesUsed)}`} />
        <TextField label="المستخدمون" optional numeric value={v.users} onChange={(e) => setV({ ...v, users: e.target.value })} hint={`المستخدم حالياً ${integer(t.usersUsed)}`} />
      </div>
      <TextField label="أسئلة المساعد الذكي يومياً لكل عضو" optional numeric value={v.assistant} onChange={(e) => setV({ ...v, assistant: e.target.value })}
        hint={`فارغ = الافتراضي (${integer(t.assistantDefault)})، و0 = إيقاف المساعد لهذه المنشأة. استُخدم اليوم ${integer(t.assistantTurnsToday)} سؤالاً.`} />
      <TextField label="مساحة إضافية (جيجابايت)" numeric value={v.extraGb} onChange={(e) => setV({ ...v, extraGb: e.target.value })}
        hint={`فوق مساحة الباقة. تشمل ما اشتراه العميل: تقليلها يلغي جزءاً مما دفع ثمنه. الحالي ${mbLabel(t.storageExtraMb)}.`} />
      <FormError error={error} />
    </Dialog>
  );
}

function SupportDialog({ t, onClose, onStarted }: { t: TenantDetail; onClose: () => void; onStarted: () => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (reason.trim().length < 5) return setError("اكتب سبب الدخول (5 أحرف على الأقل)، مثل رقم تذكرة الدعم");
    setBusy(true); setError(null);
    try { await api("POST", "/admin/support-sessions", { body: { tenantId: t.id, reason: reason.trim() } }); onStarted(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} title={`جلسة دعم: ${t.companyName}`} onSubmit={() => void submit()}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ البدء…">بدء جلسة الدعم</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <p>تمنحك قراءة فقط لبيانات المنشأة لمدة 60 دقيقة. البدء والسبب يُسجَّلان في سجل التدقيق.</p>
      <TextAreaField label="سبب الدخول" required value={reason} onChange={(e) => setReason(e.target.value)} />
      <FormError error={error} />
    </Dialog>
  );
}

interface UserRow { id: string; email: string; fullName: string; status: string; isPlatformAdmin: boolean; emailVerified: boolean; lastLoginAt: string | null; tenantsCount: number }

export function AdminUsers() {
  const qc = useQueryClient();
  const me = useMe();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(1);
  const [target, setTarget] = useState<{ user: UserRow; action: "suspend" | "restore" } | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prefs = useTablePrefs("admin-users", { server: true, onSortChange: () => setPage(1) });
  useEffect(() => { const t = setTimeout(() => { setDebounced(q.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);
  const list = useQuery({ queryKey: ["admin", "users", { q: debounced, page, sort: prefs.sortParam }], queryFn: () => api<Page<UserRow>>("GET", "/admin/users", { query: { q: debounced, page, pageSize: 25, sort: prefs.sortParam } }), placeholderData: keepPreviousData });

  async function confirm() {
    if (!target) return;
    if (target.action === "suspend" && reason.trim().length < 3) return setError("اكتب سبب الإيقاف (3 أحرف على الأقل)");
    setBusy(true); setError(null);
    try {
      await api("POST", `/admin/users/${target.user.id}/${target.action}`, { body: target.action === "suspend" ? { reason: reason.trim() } : undefined });
      toast.success(target.action === "suspend" ? `تم إيقاف ${target.user.email} وإنهاء جلساته` : `تمت إعادة تفعيل ${target.user.email}`);
      setTarget(null); setReason("");
      await qc.invalidateQueries({ queryKey: ["admin", "users"] });
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="page">
      <PageHeader title="المستخدمون" description="الإيقاف يُنهي كل جلسات المستخدم فوراً في عملية واحدة." />
      <section className="panel">
        <DataTable caption="المستخدمون" prefs={prefs} query={list} rowKey={(u) => u.id} onPageChange={setPage} filtered={Boolean(debounced)} onClearFilters={() => setQ("")}
          toolbar={<SearchInput placeholder="ابحث بالبريد أو الاسم" value={q} onChange={setQ} />}
          empty={{ title: "لا يوجد مستخدمون", body: "" }}
          columns={[
            { key: "name", sortKey: "fullName", header: "الاسم", cell: (u) => <strong>{u.fullName}{u.isPlatformAdmin && <> <Badge tone="info">مدير المنصة</Badge></>}</strong> },
            { key: "email", sortKey: "email", header: "البريد", cell: (u) => <span className="row" style={{ flexWrap: "nowrap" }}><span dir="ltr">{u.email}</span>{!u.emailVerified && <Badge tone="warning">غير مفعّل</Badge>}</span> },
            { key: "tenants", sortKey: "tenantsCount", header: "المنشآت", numeric: true, cell: (u) => integer(u.tenantsCount) },
            { key: "login", sortKey: "lastLoginAt", header: "آخر دخول", cell: (u) => dayTime(u.lastLoginAt) },
            { key: "status", sortKey: "status", header: "الحالة", cell: (u) => <StatusBadge kind="user" value={u.status} /> },
          ]}
          actions={(u) => (u.id === me.data?.user.id ? null : (
            <ActionMenu label={`إجراءات ${u.email}`} items={[u.status === "active"
              ? { label: "إيقاف الحساب", danger: true, onSelect: () => { setError(null); setReason(""); setTarget({ user: u, action: "suspend" }); } }
              : { label: "إعادة تفعيل الحساب", onSelect: () => { setError(null); setTarget({ user: u, action: "restore" }); } }]} />
          ))} />
      </section>
      <ConfirmDialog open={Boolean(target)} onClose={() => setTarget(null)} busy={busy} error={error} onConfirm={() => void confirm()} destructive={target?.action === "suspend"}
        title={target?.action === "suspend" ? "إيقاف حساب" : "إعادة تفعيل حساب"} confirmLabel={target?.action === "suspend" ? `إيقاف ${target.user.email}` : "إعادة التفعيل"}
        message={target?.action === "suspend" ? <>سيُمنع <strong>{target.user.fullName}</strong> (<span dir="ltr">{target.user.email}</span>) من الدخول، وتُنهى جلساته المفتوحة الآن.</> : <>سيتمكن <strong>{target?.user.fullName}</strong> من الدخول مجدداً.</>}>
        {target?.action === "suspend" && <TextAreaField label="سبب الإيقاف" required value={reason} onChange={(e) => setReason(e.target.value)} />}
      </ConfirmDialog>
    </div>
  );
}

interface AuditRow { id: number; at: string; action: string; entityType: string | null; entityId: string | null; tenantId: string | null; meta: Record<string, unknown>; actorEmail: string | null }

export function AdminAudit() {
  const search = useRouterState({ select: (s) => s.location.search }) as { tenantId?: string };
  const [page, setPage] = useState(1);
  const prefs = useTablePrefs("admin-audit", { server: true, onSortChange: () => setPage(1) });
  const list = useQuery({ queryKey: ["admin", "audit", { tenantId: search.tenantId ?? "", page, sort: prefs.sortParam }], queryFn: () => api<Page<AuditRow>>("GET", "/admin/audit", { query: { tenantId: search.tenantId, page, pageSize: 50, sort: prefs.sortParam } }), placeholderData: keepPreviousData });
  return (
    <div className="page">
      <PageHeader title="سجل التدقيق" description={search.tenantId ? "مصفّى على منشأة واحدة. السجل للإضافة فقط ولا يمكن تعديله أو حذفه." : "كل عملية حساسة في المنصة. السجل للإضافة فقط ولا يمكن تعديله أو حذفه."}
        actions={search.tenantId && <Link to="/admin/audit" className="btn btn-ghost">إزالة التصفية</Link>} />
      <section className="panel">
        <DataTable caption="سجل التدقيق" prefs={prefs} query={list} rowKey={(a) => String(a.id)} onPageChange={setPage} empty={{ title: "لا توجد سجلات", body: "" }}
          columns={[
            { key: "at", sortKey: "at", header: "الوقت", cell: (a) => dayTime(a.at) },
            { key: "action", sortKey: "action", header: "العملية", cell: (a) => <strong>{AUDIT_LABELS[a.action] ?? a.action}</strong> },
            { key: "actor", sortKey: "actorEmail", header: "المنفّذ", cell: (a) => <span dir="ltr">{text(a.actorEmail)}</span> },
            { key: "meta", header: "التفاصيل", wrap: true, cell: (a) => {
              const reason = a.meta?.["reason"];
              return reason ? `السبب: ${String(reason)}` : Object.keys(a.meta ?? {}).length ? <span className="muted num" style={{ fontSize: "var(--fs-xs)" }}>{JSON.stringify(a.meta)}</span> : "—";
            } },
          ]} />
      </section>
    </div>
  );
}

interface WaitRow { id: string; email: string; companyName: string; sector: string; phone: string | null; createdAt: string }

export function AdminWaitlist() {
  const [page, setPage] = useState(1);
  const prefs = useTablePrefs("admin-waitlist", { server: true, onSortChange: () => setPage(1) });
  const list = useQuery({ queryKey: ["admin", "waitlist", { page, sort: prefs.sortParam }], queryFn: () => api<Page<WaitRow>>("GET", "/admin/waitlist", { query: { page, pageSize: 50, sort: prefs.sortParam } }), placeholderData: keepPreviousData });
  const SECTOR: Record<string, string> = { manufacturing: "التصنيع", contracting: "المقاولات" };
  return (
    <div className="page">
      <PageHeader title="قائمة الاهتمام" description="من سجّلوا اهتمامهم بقطاعات لم تُطلق بعد." />
      <section className="panel">
        <DataTable caption="قائمة الاهتمام" prefs={prefs} query={list} rowKey={(w) => w.id} onPageChange={setPage} empty={{ title: "لا أحد في القائمة بعد", body: "" }}
          columns={[
            { key: "c", sortKey: "companyName", header: "المنشأة", cell: (w) => <strong>{w.companyName}</strong> },
            { key: "s", sortKey: "sector", header: "القطاع", cell: (w) => SECTOR[w.sector] ?? w.sector },
            { key: "e", sortKey: "email", header: "البريد", cell: (w) => <span dir="ltr">{w.email}</span> },
            { key: "p", sortKey: "phone", header: "الجوال", cell: (w) => <span className="num">{text(w.phone)}</span> },
            { key: "d", sortKey: "createdAt", header: "التاريخ", cell: (w) => day(w.createdAt) },
          ]} />
      </section>
    </div>
  );
}

interface AdminPlan {
  code: string; nameAr: string; sector: string; sectorName: string; monthlyPrice: number; branchesLimit: number; usersLimit: number; storageLimitMb: number; isActive: boolean; tenantsCount: number;
  description: string | null; features: string[]; badge: string | null; isFeatured: boolean; isPublic: boolean; annualPrice: number | null; sortOrder: number;
}

export function AdminPlans() {
  const plans = useQuery({ queryKey: ["admin", "plans"], queryFn: () => api<{ items: AdminPlan[] }>("GET", "/admin/plans") });
  const [editing, setEditing] = useState<AdminPlan | "new" | null>(null);
  return (
    <div className="page">
      <PageHeader title="الباقات" description="أسعار وحدود كل باقة وما يظهر منها في الصفحة العامة. تغيير الحدود يسري فوراً على كل المشتركين في الباقة، إلا من له استثناء خاص."
        actions={<Button variant="primary" icon={<Plus />} onClick={() => setEditing("new")}>باقة جديدة</Button>} />
      <section className="panel">
        <DataTable caption="الباقات" query={plans} rowKey={(p) => p.code} onRowClick={(p) => setEditing(p)}
          empty={{ title: "لا توجد باقات", body: "" }}
          columns={[
            { key: "n", sortKey: "nameAr", header: "الباقة", cell: (p) => <><strong>{p.nameAr}</strong><div className="muted num" style={{ fontSize: "var(--fs-xs)" }}>{p.code}</div></> },
            { key: "s", sortKey: "sectorName", header: "القطاع", cell: (p) => p.sectorName },
            { key: "pr", sortKey: "monthlyPrice", header: "السعر الشهري", numeric: true, cell: (p) => money(p.monthlyPrice) },
            { key: "b", sortKey: "branchesLimit", header: "الفروع", numeric: true, cell: (p) => integer(p.branchesLimit) },
            { key: "u", sortKey: "usersLimit", header: "المستخدمون", numeric: true, cell: (p) => integer(p.usersLimit) },
            { key: "st", sortKey: "storageLimitMb", header: "المساحة", numeric: true, cell: (p) => mbLabel(p.storageLimitMb) },
            { key: "t", sortKey: "tenantsCount", header: "المشتركون", numeric: true, cell: (p) => integer(p.tenantsCount) },
            { key: "a", sortKey: "isActive", header: "الحالة", cell: (p) => <StatusBadge kind="active" value={p.isActive} /> },
            { key: "pub", sortKey: "isPublic", header: "الصفحة العامة", cell: (p) => (p.isPublic ? <Badge tone="info">معروضة{p.isFeatured ? " · مميزة" : ""}</Badge> : <span className="muted">مخفية</span>) },
          ]} />
      </section>
      {editing && <PlanDialog plan={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function PlanDialog({ plan, onClose }: { plan: AdminPlan | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [v, setV] = useState({
    code: plan?.code ?? "restaurants-", nameAr: plan?.nameAr ?? "", monthlyPrice: String(plan?.monthlyPrice ?? ""), branchesLimit: String(plan?.branchesLimit ?? 1), usersLimit: String(plan?.usersLimit ?? 5), storageGb: String((plan?.storageLimitMb ?? 1024) / 1024), isActive: plan?.isActive ?? true,
    description: plan?.description ?? "", features: (plan?.features ?? []).join("\n"), badge: plan?.badge ?? "", annualPrice: plan?.annualPrice == null ? "" : String(plan.annualPrice),
    sortOrder: String(plan?.sortOrder ?? 0), isFeatured: plan?.isFeatured ?? false, isPublic: plan?.isPublic ?? false,
  });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const limitsChanged = plan && (Number(v.branchesLimit) !== plan.branchesLimit || Number(v.usersLimit) !== plan.usersLimit);
  async function save() {
    if (v.nameAr.trim().length < 2) return setError("أدخل اسم الباقة");
    if (!(Number(v.monthlyPrice) >= 0) || v.monthlyPrice === "") return setError("أدخل السعر الشهري (صفر للمجانية)");
    if (!(Number.isInteger(Number(v.branchesLimit)) && Number(v.branchesLimit) >= 1) || !(Number.isInteger(Number(v.usersLimit)) && Number(v.usersLimit) >= 1)) return setError("الحدود أرقام صحيحة من 1");
    const storageLimitMb = Math.round(Number(v.storageGb) * 1024);
    if (!(storageLimitMb >= 10)) return setError("المساحة بالجيجابايت، مثل 1 أو 0.2");
    setBusy(true); setError(null);
    const features = v.features.split("\n").map((x) => x.trim()).filter(Boolean);
    if (features.length > 12) return setError("12 ميزة على الأكثر، واحدة في كل سطر");
    if (v.annualPrice !== "" && !(Number(v.annualPrice) >= 0)) return setError("السعر السنوي رقم صفر أو أكبر، أو اتركه فارغاً");
    const body = {
      nameAr: v.nameAr.trim(), monthlyPrice: Number(v.monthlyPrice), branchesLimit: Number(v.branchesLimit), usersLimit: Number(v.usersLimit), storageLimitMb, isActive: v.isActive,
      description: v.description.trim() || null, features, badge: v.badge.trim() || null, annualPrice: v.annualPrice === "" ? null : Number(v.annualPrice),
      sortOrder: Math.max(0, Math.round(Number(v.sortOrder) || 0)), isFeatured: v.isFeatured, isPublic: v.isPublic,
    };
    try {
      if (plan) await api("PATCH", `/admin/plans/${plan.code}`, { body });
      else await api("POST", "/admin/plans", { body: { ...body, code: v.code.trim(), sector: v.code.split("-")[0] } });
      toast.success(`تم حفظ باقة ${body.nameAr}`);
      await qc.invalidateQueries({ queryKey: ["admin", "plans"] });
      onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open wide onClose={onClose} busy={busy} title={plan ? `تعديل ${plan.nameAr}` : "باقة جديدة"} onSubmit={() => void save()}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">حفظ الباقة</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <section className="form-section" aria-labelledby="plan-core"><h3 id="plan-core">السعر والحدود</h3>
      <div className="form-grid">
        {!plan && <TextField label="الرمز" required dir="ltr" value={v.code} onChange={(e) => setV({ ...v, code: e.target.value.toLowerCase() })} hint="يبدأ بالقطاع، مثل restaurants-gold" />}
        <TextField label="الاسم" required value={v.nameAr} onChange={(e) => setV({ ...v, nameAr: e.target.value })} />
        <TextField label={`السعر الشهري (${RIYAL})`} required numeric value={v.monthlyPrice} onChange={(e) => setV({ ...v, monthlyPrice: e.target.value })} />
        <TextField label="حد الفروع" required numeric value={v.branchesLimit} onChange={(e) => setV({ ...v, branchesLimit: e.target.value })} />
        <TextField label="حد المستخدمين" required numeric value={v.usersLimit} onChange={(e) => setV({ ...v, usersLimit: e.target.value })} />
        <TextField label="مساحة التخزين (جيجابايت)" required numeric value={v.storageGb} onChange={(e) => setV({ ...v, storageGb: e.target.value })} hint="حجم بيانات المنشأة المسموح. العميل يستطيع شراء مساحة إضافية فوقه" />
      </div>
      <label className="checkbox"><input type="checkbox" checked={v.isActive} onChange={(e) => setV({ ...v, isActive: e.target.checked })} />متاحة لاشتراكات جديدة</label>
      </section>
      <section className="form-section" aria-labelledby="plan-public"><h3 id="plan-public">العرض في الصفحة العامة</h3>
        <label className="checkbox"><input type="checkbox" checked={v.isPublic} onChange={(e) => setV({ ...v, isPublic: e.target.checked })} />تظهر في قسم الباقات بالصفحة العامة</label>
        <div className="form-grid">
          <TextField label={`السعر السنوي (${RIYAL})`} optional numeric value={v.annualPrice} onChange={(e) => setV({ ...v, annualPrice: e.target.value })} hint="يظهر عند اختيار «سنوياً». اتركه فارغاً إن لم يوجد" />
          <TextField label="شارة" optional value={v.badge} maxLength={30} onChange={(e) => setV({ ...v, badge: e.target.value })} hint="مثل: الأكثر طلباً" />
          <TextField label="الترتيب" numeric value={v.sortOrder} onChange={(e) => setV({ ...v, sortOrder: e.target.value })} hint="الأصغر يظهر أولاً" />
        </div>
        <TextAreaField label="وصف قصير" optional maxLength={300} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} />
        <TextAreaField label="المزايا" optional rows={5} value={v.features} onChange={(e) => setV({ ...v, features: e.target.value })} hint="ميزة في كل سطر، حتى 12" />
        <label className="checkbox"><input type="checkbox" checked={v.isFeatured} onChange={(e) => setV({ ...v, isFeatured: e.target.checked })} />مميزة (إطار أزرق وزر أساسي)</label>
      </section>
      {limitsChanged && plan!.tenantsCount > 0 && <p className="banner banner-warning ca-banner">يوجد {integer(plan!.tenantsCount)} مشترك في هذه الباقة وسيسري عليهم الحد الجديد فوراً. من تجاوز الحد الجديد لن يستطيع إضافة المزيد حتى يُرقّى.</p>}
      <FormError error={error} />
    </Dialog>
  );
}



export function AdminRoles() {
  const r = useQuery({ queryKey: ["admin", "roles"], queryFn: () => api<{ catalog: CatalogModule[]; permissions: string[]; roles: { role: string; permissions: string[] }[] }>("GET", "/admin/roles") });
  return (
    <div className="page">
      <PageHeader title="الأدوار والصلاحيات" description="المصفوفة التي يطبقها الخادم على كل طلب: لكل صفحة إجراءاتها (عرض، إضافة، تعديل، حذف، اعتماد…). الأدوار الجاهزة جزء من الكود ومغطاة باختبارات، لذلك تُعرض هنا للقراءة فقط. كل منشأة تنشئ أدوارها المخصصة من هذه الصلاحيات." />
      {r.isPending ? <TableSkeleton columns={6} rows={10} /> : r.isError ? <ErrorState error={r.error} onRetry={() => r.refetch()} /> : r.data.catalog.map((m) => (
        <section key={m.key} className="panel" aria-labelledby={`adm-${m.key}`}>
          <div className="toolbar"><h2 id={`adm-${m.key}`}>{m.label}</h2><Badge>للقراءة فقط</Badge></div>
          <div className="table-wrap">
            <table className="data-table ca-perm-matrix">
              <caption className="sr-only">صلاحيات {m.label}</caption>
              <thead><tr><th scope="col">الصفحة · الإجراء</th>{r.data.roles.map((x) => <th key={x.role} scope="col">{ROLE_LABELS[x.role] ?? x.role}</th>)}</tr></thead>
              <tbody>{m.pages.flatMap((p) => p.actions.map((a) => {
                const key = permKey(p.key, a.key);
                return (
                  <tr key={key}>
                    <td><strong>{p.label}</strong> · {a.label}{a.sensitive && <> <Badge tone="warning">حساسة</Badge></>}</td>
                    {r.data.roles.map((x) => <td key={x.role}>{x.permissions.includes(key) ? <Badge tone="success"><Check aria-hidden="true" />مسموح</Badge> : <span className="muted"><span aria-hidden="true">—</span><span className="sr-only">غير مسموح</span></span>}</td>)}
                  </tr>
                );
              }))}</tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}
