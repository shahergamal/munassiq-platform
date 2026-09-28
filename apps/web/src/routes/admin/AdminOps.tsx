import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle, ArrowRight, BadgeCheck, Building2, CalendarClock, Clock3, Factory, HardHat, Headset, Hourglass, Layers,
  Receipt, RefreshCw, Repeat, TrendingUp, UserCheck, Users, UserX, UtensilsCrossed, Wallet, type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { api, ApiError, type Page } from "../../api/client";
import { RIYAL, addDays, day, dayTime, integer, isoDay, money, percent } from "../../lib/format";
import { Button } from "../../ui/Button";
import { DataTable } from "../../ui/DataTable";
import { DateRange } from "../../ui/DateRange";
import { focusFirstInvalid, SearchInput, SelectField, TextField } from "../../ui/Field";
import { Badge, PageHeader, StatCard, StatusBadge } from "../../ui/Layout";
import { ErrorState, FormError, Skeleton } from "../../ui/States";
import { useTablePrefs } from "../../ui/tablePrefs";
import { useToast } from "../../ui/Toast";

const useDebounced = (v: string) => {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v.trim()), 300); return () => clearTimeout(t); }, [v]);
  return d;
};

/** Share of a limit, as a bar with a text value next to it (the bar alone never carries the number). */
function Meter({ used, limit, label }: { used: number; limit: number | null; label: string }) {
  const ratio = limit ? Math.min(1, used / limit) : 0;
  const tone = ratio >= 1 ? "is-full" : ratio >= 0.8 ? "is-near" : "";
  return (
    <span className="meter-cell">
      <span className={`meter ${tone}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={limit ?? 0} aria-valuenow={used}><span style={{ inlineSize: `${Math.round(ratio * 100)}%` }} /></span>
      <span className="num">{integer(used)} / {limit === null ? "—" : integer(limit)}</span>
    </span>
  );
}

// ── Subscriptions ─────────────────────────────────────────────────────────────────────────────
interface SubRow { id: string; tenantId: string; companyName: string; sector: string; planName: string; status: string; startsAt: string; endsAt: string; daysLeft: number; totalDays: number; totalValue: number }
interface SubSummary { active: number; trial: number; expiring: number; lapsed: number }

export function AdminSubscriptions() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const debounced = useDebounced(q);
  const [status, setStatus] = useState("");
  const [expiring, setExpiring] = useState(false);
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [debounced]);
  const prefs = useTablePrefs("admin-subscriptions", { server: true, onSortChange: () => setPage(1) });
  const list = useQuery({
    queryKey: ["admin", "subscriptions", { q: debounced, status, expiring, page, sort: prefs.sortParam }],
    queryFn: () => api<Page<SubRow> & { summary: SubSummary }>("GET", "/admin/subscriptions", { query: { q: debounced, status, expiring: expiring ? "true" : "", page, pageSize: 25, sort: prefs.sortParam } }),
    placeholderData: keepPreviousData,
  });
  const s = list.data?.summary;
  return (
    <div className="page">
      <PageHeader title="الاشتراكات" description="باقة كل عميل ومدتها وقيمتها. افتح العميل لتمديد الاشتراك أو تغيير باقته." />
      <div className="stats stats-4">
        <StatCard label="اشتراكات مدفوعة سارية" value={s ? integer(s.active) : "…"} icon={<BadgeCheck />} hue="green" />
        <StatCard label="تجارب جارية" value={s ? integer(s.trial) : "…"} icon={<Hourglass />} hue="sky" />
        <StatCard label="تنتهي خلال 30 يوماً" value={s ? integer(s.expiring) : "…"} icon={<CalendarClock />} hue="amber" note={s?.expiring ? "تواصل للتجديد" : "لا شيء قريب"} noteTone={s?.expiring ? "warning" : undefined} />
        <StatCard label="منتهية أو معلّقة" value={s ? integer(s.lapsed) : "…"} icon={<AlertTriangle />} hue="red" />
      </div>
      <section className="panel">
        <DataTable caption="الاشتراكات" prefs={prefs} query={list} rowKey={(r) => r.id} onPageChange={setPage}
          onRowClick={(r) => navigate({ to: `/admin/tenants/${r.tenantId}` })}
          filtered={Boolean(debounced || status || expiring)} onClearFilters={() => { setQ(""); setStatus(""); setExpiring(false); }}
          empty={{ title: "لا توجد اشتراكات", body: "تُنشأ الاشتراكات مع كل منشأة جديدة." }}
          toolbar={<>
            <SearchInput placeholder="ابحث باسم المنشأة أو بريد المالك" value={q} onChange={setQ} />
            <select className="select" aria-label="حالة الاشتراك" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              <option value="">كل الحالات</option><option value="active">ساري</option><option value="trial">تجريبي</option><option value="suspended">معلّق</option><option value="expired">منتهٍ</option>
            </select>
            <label className="checkbox"><input type="checkbox" checked={expiring} onChange={(e) => { setExpiring(e.target.checked); setPage(1); }} />تنتهي خلال 30 يوماً</label>
          </>}
          columns={[
            { key: "c", sortKey: "companyName", header: "العميل", cell: (r) => <strong>{r.companyName}</strong> },
            { key: "p", sortKey: "planName", header: "الباقة", cell: (r) => r.planName },
            { key: "s", sortKey: "status", header: "الحالة", cell: (r) => <StatusBadge kind="subscription" value={r.status} /> },
            { key: "d", sortKey: "endsAt", header: "الفترة", cell: (r) => <span className="muted">{day(r.startsAt)} ← {day(r.endsAt)}</span> },
            { key: "u", sortKey: false, header: "استهلاك المدة", cell: (r) => {
              const used = Math.max(0, Math.min(r.totalDays, r.totalDays - r.daysLeft));
              return <Meter used={used} limit={r.totalDays} label={`استُهلك ${used} من ${r.totalDays} يوماً`} />;
            } },
            { key: "l", sortKey: "daysLeft", header: "المتبقي", numeric: true, cell: (r) => (
              <Badge tone={r.daysLeft < 0 ? "danger" : r.daysLeft <= 7 ? "danger" : r.daysLeft <= 30 ? "warning" : "neutral"}>
                <Clock3 aria-hidden="true" className="badge-icon" />{r.daysLeft < 0 ? `منتهٍ منذ ${integer(-r.daysLeft)} يوم` : `${integer(r.daysLeft)} يوم`}
              </Badge>
            ) },
            { key: "v", sortKey: "totalValue", header: "القيمة", numeric: true, cell: (r) => money(r.totalValue) },
          ]} />
      </section>
    </div>
  );
}

// ── Sectors ───────────────────────────────────────────────────────────────────────────────────
interface SectorRow { key: string; nameAr: string; isAvailable: boolean; activeTenants: number; allTenants: number; plans: number; waitlist: number; waitlist30: number }
const SECTOR_ICON: Record<string, LucideIcon> = { restaurants: UtensilsCrossed, manufacturing: Factory, contracting: HardHat };

export function AdminSectors() {
  const q = useQuery({ queryKey: ["admin", "sectors"], queryFn: () => api<{ items: SectorRow[] }>("GET", "/admin/sectors") });
  return (
    <div className="page">
      <PageHeader title="القطاعات" description="ما هو مبني ومتاح للتسجيل، وحجم الطلب على القطاعات القادمة من قائمة الاهتمام."
        actions={<Link to="/admin/waitlist" className="btn btn-secondary">قائمة الاهتمام</Link>} />
      {q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <div className="stats">
          {(q.data?.items ?? [null, null, null]).map((s, i) => {
            if (!s) return <div key={i} className="stat"><Skeleton width="40%" /><Skeleton width="70%" /></div>;
            const Icon = SECTOR_ICON[s.key] ?? Building2;
            return (
              <article key={s.key} className="panel sector-card">
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span className={`stat-icon static tone-${s.isAvailable ? "indigo" : "sky"}`} aria-hidden="true"><Icon /></span>
                  <Badge tone={s.isAvailable ? "success" : "neutral"}>{s.isAvailable ? "متاح للتسجيل" : "قيد التجهيز"}</Badge>
                </div>
                <h2>{s.nameAr}</h2>
                <dl className="dl">
                  <dt>منشآت نشطة</dt><dd className="num">{integer(s.activeTenants)} <span className="muted">من {integer(s.allTenants)}</span></dd>
                  <dt>باقات فعّالة</dt><dd className="num">{integer(s.plans)}</dd>
                  <dt>مهتمون</dt><dd className="num">{integer(s.waitlist)} <span className="muted">({integer(s.waitlist30)} آخر 30 يوماً)</span></dd>
                </dl>
                <p className="muted sector-note">{s.isAvailable ? "القطاع مبني ويسجّل عملاء جدداً." : "لا يُفتح للتسجيل قبل بناء وحداته، حتى لا يشترك عميل في شيء غير موجود."}</p>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Limit usage ───────────────────────────────────────────────────────────────────────────────
interface UsageRow { id: string; companyName: string; status: string; planName: string | null; branchesUsed: number; branchesLimit: number | null; usersUsed: number; usersLimit: number | null; locations: number; peak: number }

export function AdminUsage() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const debounced = useDebounced(q);
  const [near, setNear] = useState(false);
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [debounced]);
  const prefs = useTablePrefs("admin-usage", { server: true, onSortChange: () => setPage(1) });
  const list = useQuery({
    queryKey: ["admin", "usage", { q: debounced, near, page, sort: prefs.sortParam }],
    queryFn: () => api<Page<UsageRow>>("GET", "/admin/usage", { query: { q: debounced, near: near ? "true" : "", page, pageSize: 25, sort: prefs.sortParam } }),
    placeholderData: keepPreviousData,
  });
  return (
    <div className="page">
      <PageHeader title="استهلاك الحدود" description="عدد فروع ومستخدمي كل عميل مقابل حدود باقته. من بلغ 80% فأكثر فرصة ترقية، ومن بلغ الحد لن يضيف المزيد. افتح العميل لتعديل حدوده." />
      <section className="panel">
        <DataTable caption="استهلاك الحدود" prefs={prefs} query={list} rowKey={(r) => r.id} onPageChange={setPage}
          onRowClick={(r) => navigate({ to: `/admin/tenants/${r.id}` })}
          filtered={Boolean(debounced || near)} onClearFilters={() => { setQ(""); setNear(false); }}
          empty={{ title: "لا يوجد عملاء بعد", body: "" }}
          toolbar={<>
            <SearchInput placeholder="ابحث باسم المنشأة أو بريد المالك" value={q} onChange={setQ} />
            <label className="checkbox"><input type="checkbox" checked={near} onChange={(e) => { setNear(e.target.checked); setPage(1); }} />قريب من الحد (80% فأكثر)</label>
          </>}
          columns={[
            { key: "c", sortKey: "companyName", header: "العميل", cell: (r) => <><strong>{r.companyName}</strong>{r.status !== "active" && <> <StatusBadge kind="tenant" value={r.status} /></>}</> },
            { key: "p", sortKey: "planName", header: "الباقة", cell: (r) => r.planName ?? <span className="muted">بلا اشتراك ساري</span> },
            { key: "b", sortKey: "branchesUsed", header: "الفروع", cell: (r) => <Meter used={r.branchesUsed} limit={r.branchesLimit} label={`الفروع ${r.branchesUsed} من ${r.branchesLimit ?? "—"}`} /> },
            { key: "u", sortKey: "usersUsed", header: "المستخدمون", cell: (r) => <Meter used={r.usersUsed} limit={r.usersLimit} label={`المستخدمون ${r.usersUsed} من ${r.usersLimit ?? "—"}`} /> },
            { key: "l", sortKey: "locations", header: "المطابخ والمستودعات", numeric: true, cell: (r) => integer(r.locations) },
            { key: "k", sortKey: "peak", header: "الأعلى", numeric: true, cell: (r) => <Badge tone={r.peak >= 100 ? "danger" : r.peak >= 80 ? "warning" : "neutral"}>{percent(r.peak)}</Badge> },
          ]} />
      </section>
    </div>
  );
}

// ── Reports ───────────────────────────────────────────────────────────────────────────────────
const SECTOR_OPTIONS = [["", "كل القطاعات"], ["restaurants", "المطاعم"], ["manufacturing", "التصنيع"], ["contracting", "المقاولات"]] as const;

function useReportFilters() {
  const [from, setFrom] = useState(addDays(isoDay(), -29));
  const [to, setTo] = useState(isoDay());
  const [sector, setSector] = useState("");
  const bar = (
    <div className="toolbar panel report-bar">
      <DateRange from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} />
      <select className="select" aria-label="القطاع" value={sector} onChange={(e) => setSector(e.target.value)}>
        {SECTOR_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  );
  return { from, to, sector, bar };
}

interface Financial {
  from: string; to: string;
  summary: { activePaid: number; mrr: number; runningTrials: number; renewalsDue: number; renewalsMrr: number; contracts: number; contractsValue: number };
  byPlan: { code: string; planName: string; sectorName: string; monthlyPrice: number; active: number; trials: number; mrr: number }[];
  contracts: { id: string; tenantId: string; companyName: string; planName: string; status: string; startsAt: string; endsAt: string; totalValue: number }[];
}

export function AdminFinancialReport() {
  const navigate = useNavigate();
  const f = useReportFilters();
  const r = useQuery({ queryKey: ["admin", "report", "financial", f.from, f.to, f.sector], queryFn: () => api<Financial>("GET", "/admin/reports/financial", { query: { from: f.from, to: f.to, sector: f.sector } }), placeholderData: keepPreviousData });
  const s = r.data?.summary;
  return (
    <div className="page">
      <PageHeader title="التقرير المالي" description="الإيراد الشهري المتكرر يُحسب من أسعار الباقات للاشتراكات المدفوعة السارية الآن. العقود حسب تاريخ بدايتها في الفترة." />
      {f.bar}
      {r.isError ? <ErrorState error={r.error} onRetry={() => r.refetch()} /> : <>
        <div className="stats stats-4">
          <StatCard label="الإيراد الشهري المتكرر" value={s ? money(s.mrr) : "…"} icon={<Wallet />} hue="indigo" note={s ? `${integer(s.activePaid)} اشتراك مدفوع ساري` : undefined} />
          <StatCard label="متوسط الاشتراك الشهري" value={s ? money(s.activePaid ? s.mrr / s.activePaid : 0) : "…"} icon={<TrendingUp />} hue="green" note={s ? `${integer(s.runningTrials)} تجربة جارية` : undefined} />
          <StatCard label="تجديدات خلال 30 يوماً" value={s ? integer(s.renewalsDue) : "…"} icon={<Repeat />} hue="amber" note={s ? `بقيمة شهرية ${money(s.renewalsMrr)}` : undefined} />
          <StatCard label="عقود بدأت في الفترة" value={s ? integer(s.contracts) : "…"} icon={<Receipt />} hue="violet" note={s ? `إجمالي قيمتها ${money(s.contractsValue)}` : undefined} />
        </div>
        <section className="panel">
          <DataTable caption="حسب الباقة" query={{ ...r, data: r.data ? { items: r.data.byPlan } : undefined }} rowKey={(x) => x.code}
            toolbar={<h2>حسب الباقة</h2>} empty={{ title: "لا توجد باقات", body: "" }}
            columns={[
              { key: "planName", header: "الباقة", cell: (x) => <strong>{x.planName}</strong> },
              { key: "sectorName", header: "القطاع", cell: (x) => x.sectorName },
              { key: "monthlyPrice", header: "السعر الشهري", numeric: true, cell: (x) => money(x.monthlyPrice) },
              { key: "active", header: "مدفوعة سارية", numeric: true, cell: (x) => integer(x.active) },
              { key: "trials", header: "تجارب", numeric: true, cell: (x) => integer(x.trials) },
              { key: "mrr", header: "الإيراد الشهري", numeric: true, cell: (x) => money(x.mrr) },
            ]} />
        </section>
        <section className="panel">
          <DataTable caption="عقود بدأت في الفترة" query={{ ...r, data: r.data ? { items: r.data.contracts } : undefined }} rowKey={(x) => x.id}
            onRowClick={(x) => navigate({ to: `/admin/tenants/${x.tenantId}` })}
            toolbar={<h2>عقود بدأت في الفترة</h2>} empty={{ title: "لا عقود مدفوعة بدأت في هذه الفترة", body: "غيّر الفترة أو القطاع." }}
            columns={[
              { key: "companyName", header: "العميل", cell: (x) => <strong>{x.companyName}</strong> },
              { key: "planName", header: "الباقة", cell: (x) => x.planName },
              { key: "status", header: "الحالة", cell: (x) => <StatusBadge kind="subscription" value={x.status} /> },
              { key: "startsAt", header: "البداية", cell: (x) => day(x.startsAt) },
              { key: "endsAt", header: "النهاية", cell: (x) => day(x.endsAt) },
              { key: "totalValue", header: "القيمة", numeric: true, cell: (x) => money(x.totalValue) },
            ]} />
        </section>
      </>}
    </div>
  );
}

interface Operations {
  from: string; to: string;
  summary: { newTenants: number; activeTenants: number; blockedTenants: number; trialsStarted: number; converted: number; dormantTenants: number; newUsers: number; activeUsers14: number; suspendedUsers: number; supportSessions: number; waitlist: number };
  daily: { day: string; tenants: number; users: number }[];
}

export function AdminOperationsReport() {
  const f = useReportFilters();
  const r = useQuery({ queryKey: ["admin", "report", "operations", f.from, f.to, f.sector], queryFn: () => api<Operations>("GET", "/admin/reports/operations", { query: { from: f.from, to: f.to, sector: f.sector } }), placeholderData: keepPreviousData });
  const s = r.data?.summary;
  const conversion = s && s.newTenants ? (s.converted / s.newTenants) * 100 : null;
  return (
    <div className="page">
      <PageHeader title="التقرير التشغيلي" description="نمو العملاء ونشاطهم في الفترة. «خامل» = منشأة نشطة لم يسجّل أي من أعضائها الدخول منذ 14 يوماً." />
      {f.bar}
      {r.isError ? <ErrorState error={r.error} onRetry={() => r.refetch()} /> : <>
        <div className="stats stats-4">
          <StatCard label="منشآت جديدة" value={s ? integer(s.newTenants) : "…"} icon={<Building2 />} hue="indigo" note={s ? `${integer(s.trialsStarted)} تجربة بدأت` : undefined} />
          <StatCard label="تحوّلت إلى مدفوع" value={s ? integer(s.converted) : "…"} icon={<BadgeCheck />} hue="green" note={conversion === null ? "لا منشآت جديدة" : `نسبة التحويل ${percent(conversion)}`} />
          <StatCard label="منشآت خاملة" value={s ? integer(s.dormantTenants) : "…"} icon={<UserX />} hue="amber" note={s ? `من ${integer(s.activeTenants)} منشأة نشطة` : undefined} noteTone={s?.dormantTenants ? "warning" : undefined} />
          <StatCard label="مستخدمون نشطون (14 يوماً)" value={s ? integer(s.activeUsers14) : "…"} icon={<UserCheck />} hue="sky" note={s ? `${integer(s.newUsers)} حساب جديد في الفترة` : undefined} />
        </div>
        <div className="stats">
          <StatCard label="منشآت موقوفة" value={s ? integer(s.blockedTenants) : "…"} icon={<AlertTriangle />} hue="red" />
          <StatCard label="حسابات موقوفة" value={s ? integer(s.suspendedUsers) : "…"} icon={<Users />} hue="orange" />
          <StatCard label="جلسات دعم في الفترة" value={s ? integer(s.supportSessions) : "…"} icon={<Headset />} hue="violet" />
          <StatCard label="اهتمام بقطاعات قادمة" value={s ? integer(s.waitlist) : "…"} icon={<Layers />} hue="sky" />
        </div>
        <section className="panel">
          <DataTable caption="التسجيل اليومي" query={{ ...r, data: r.data ? { items: r.data.daily } : undefined }} rowKey={(x) => x.day}
            toolbar={<h2>التسجيل اليومي</h2>} empty={{ title: "لا أيام في الفترة", body: "" }}
            columns={[
              { key: "day", header: "اليوم", cell: (x) => <strong>{day(x.day)}</strong> },
              { key: "tenants", header: "منشآت جديدة", numeric: true, cell: (x) => integer(x.tenants) },
              { key: "users", header: "حسابات جديدة", numeric: true, cell: (x) => integer(x.users) },
            ]} />
        </section>
      </>}
    </div>
  );
}

// ── Platform settings ─────────────────────────────────────────────────────────────────────────
interface General { trialDays: number; defaultVatPercent: number; defaultDiscountApprovalPercent: number }

export function AdminSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["admin", "settings"], queryFn: () => api<{ settings: General; defaults: General; updatedAt: string | null; updatedBy: string | null }>("GET", "/admin/settings") });
  const [v, setV] = useState<Record<keyof General, string> | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.data && !v) setV({ trialDays: String(q.data.settings.trialDays), defaultVatPercent: String(q.data.settings.defaultVatPercent), defaultDiscountApprovalPercent: String(q.data.settings.defaultDiscountApprovalPercent) });
  }, [q.data, v]);
  if (q.isError) return <div className="page"><ErrorState error={q.error} onRetry={() => q.refetch()} /></div>;
  const dirty = Boolean(v && q.data && (Number(v.trialDays) !== q.data.settings.trialDays || Number(v.defaultVatPercent) !== q.data.settings.defaultVatPercent || Number(v.defaultDiscountApprovalPercent) !== q.data.settings.defaultDiscountApprovalPercent));

  async function save(form: HTMLFormElement) {
    if (!v) return;
    const e: Record<string, string> = {};
    const days = Number(v.trialDays), vat = Number(v.defaultVatPercent), disc = Number(v.defaultDiscountApprovalPercent);
    if (!(Number.isInteger(days) && days >= 1 && days <= 90)) e.trialDays = "عدد أيام صحيح من 1 إلى 90";
    if (!(vat >= 0 && vat <= 100) || v.defaultVatPercent === "") e.defaultVatPercent = "نسبة بين 0 و100";
    if (!(disc >= 0 && disc <= 100) || v.defaultDiscountApprovalPercent === "") e.defaultDiscountApprovalPercent = "نسبة بين 0 و100";
    setErrors(e);
    if (Object.keys(e).length) return focusFirstInvalid(form);
    setBusy(true); setError(null);
    try {
      await api("PUT", "/admin/settings", { body: { trialDays: days, defaultVatPercent: vat, defaultDiscountApprovalPercent: disc } });
      await qc.invalidateQueries({ queryKey: ["admin", "settings"] });
      setV(null);
      toast.success("تم حفظ إعدادات المنصة. تسري على المنشآت الجديدة من الآن");
    } catch (err) { if (err instanceof ApiError) setErrors(err.fieldErrors); setError(err); } finally { setBusy(false); }
  }

  return (
    <div className="page" style={{ maxWidth: 860 }}>
      <PageHeader title="إعدادات المنصة" description={q.data?.updatedAt ? `آخر تعديل ${dayTime(q.data.updatedAt)}${q.data.updatedBy ? ` بواسطة ${q.data.updatedBy}` : ""}` : "القيم الافتراضية للمنصة."} />
      <p className="banner banner-info settings-note"><RefreshCw aria-hidden="true" />هذه القيم تُكتب في كل منشأة <strong>جديدة</strong> عند إنشائها. المنشآت الحالية تحتفظ بإعداداتها ويغيّرها مالكها من إعدادات منشأته.</p>
      {!v ? <div className="panel panel-pad stack"><Skeleton height={38} /><Skeleton height={38} /></div> : (
        <form className="panel panel-pad form-section" noValidate onSubmit={(e) => { e.preventDefault(); void save(e.currentTarget); }}>
          <section className="form-section" aria-labelledby="st-trial"><h2 id="st-trial">التجربة المجانية</h2>
            <div className="form-grid">
              <TextField label="مدة التجربة (يوم)" required numeric value={v.trialDays} onChange={(e) => setV({ ...v, trialDays: e.target.value })} error={errors.trialDays} hint={`الافتراضي ${q.data!.defaults.trialDays} يوماً`} />
            </div>
          </section>
          <section className="form-section" aria-labelledby="st-tax"><h2 id="st-tax">الضريبة والخصم للمنشآت الجديدة</h2>
            <div className="form-grid">
              <TextField label="ضريبة القيمة المضافة ٪" required numeric value={v.defaultVatPercent} onChange={(e) => setV({ ...v, defaultVatPercent: e.target.value })} error={errors.defaultVatPercent} hint="15٪ في المملكة حالياً" />
              <TextField label="أقصى خصم للكاشير دون موافقة ٪" required numeric value={v.defaultDiscountApprovalPercent} onChange={(e) => setV({ ...v, defaultDiscountApprovalPercent: e.target.value })} error={errors.defaultDiscountApprovalPercent} />
            </div>
          </section>
          <FormError error={error} />
          <div className="row">
            <Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…" disabled={!dirty}>حفظ الإعدادات</Button>
            {dirty && <Button onClick={() => setV(null)}>تجاهل التغييرات</Button>}
          </div>
        </form>
      )}
    </div>
  );
}

// ── New customer ──────────────────────────────────────────────────────────────────────────────
interface PlanOpt { code: string; nameAr: string; sector: string; monthlyPrice: number; isActive: boolean }
interface SectorOpt { key: string; nameAr: string; isAvailable: boolean }

export function AdminNewTenant() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const plans = useQuery({ queryKey: ["admin", "plans"], queryFn: () => api<{ items: PlanOpt[] }>("GET", "/admin/plans") });
  const sectors = useQuery({ queryKey: ["admin", "sectors"], queryFn: () => api<{ items: SectorOpt[] }>("GET", "/admin/sectors") });
  const [v, setV] = useState({ ownerEmail: "", companyName: "", taxId: "", city: "", sector: "restaurants", planCode: "", endsAt: addDays(isoDay(), 365), totalValue: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const trialCode = `${v.sector}-trial`;
  const sectorPlans = (plans.data?.items ?? []).filter((p) => p.sector === v.sector && p.isActive);
  const paid = Boolean(v.planCode && v.planCode !== trialCode);
  const chosen = sectorPlans.find((p) => p.code === v.planCode);

  async function submit(form: HTMLFormElement) {
    const e: Record<string, string> = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.ownerEmail.trim())) e.ownerEmail = "أدخل بريد المالك الصحيح";
    if (v.companyName.trim().length < 2) e.companyName = "أدخل اسم المنشأة";
    if (!/^[0-9]{10,15}$/.test(v.taxId.trim())) e.taxId = "10 إلى 15 رقماً";
    if (paid && !(v.endsAt > isoDay())) e.endsAt = "تاريخ النهاية بعد اليوم";
    if (paid && v.totalValue !== "" && !(Number(v.totalValue) >= 0)) e.totalValue = "رقم صفر أو أكبر";
    setErrors(e);
    if (Object.keys(e).length) return focusFirstInvalid(form);
    setBusy(true); setError(null);
    try {
      const r = await api<{ id: string }>("POST", "/admin/tenants", { body: {
        ownerEmail: v.ownerEmail.trim(), companyName: v.companyName.trim(), taxId: v.taxId.trim(), city: v.city.trim() || null, sector: v.sector,
        ...(paid ? { planCode: v.planCode, endsAt: v.endsAt, totalValue: Number(v.totalValue) || 0 } : {}),
      } });
      await Promise.all([qc.invalidateQueries({ queryKey: ["admin", "tenants"] }), qc.invalidateQueries({ queryKey: ["admin", "subscriptions"] })]);
      toast.success(`تم إنشاء «${v.companyName.trim()}» وإسنادها إلى ${v.ownerEmail.trim()}`);
      navigate({ to: `/admin/tenants/${r.id}` });
    } catch (err) { if (err instanceof ApiError) setErrors(err.fieldErrors); setError(err); } finally { setBusy(false); }
  }

  if (plans.isError || sectors.isError) return <div className="page"><ErrorState error={plans.error ?? sectors.error} onRetry={() => { void plans.refetch(); void sectors.refetch(); }} /></div>;
  const available = (sectors.data?.items ?? []).filter((s) => s.isAvailable);
  return (
    <form className="page" style={{ maxWidth: 900 }} noValidate onSubmit={(e) => { e.preventDefault(); void submit(e.currentTarget); }}>
      <PageHeader title="عميل جديد" description="تُنشأ المنشأة لحساب موجود ومفعّل، ويصبح صاحبه مالكها. لا نُنشئ حسابات أو كلمات مرور نيابة عن أحد."
        actions={<Link to="/admin/tenants" className="btn btn-ghost"><ArrowRight aria-hidden="true" />العملاء</Link>} />
      <section className="panel panel-pad form-section" aria-labelledby="nt-owner">
        <h2 id="nt-owner">المالك والمنشأة</h2>
        <div className="form-grid">
          <TextField label="بريد المالك" required type="email" dir="ltr" autoComplete="off" value={v.ownerEmail} onChange={(e) => setV({ ...v, ownerEmail: e.target.value })} error={errors.ownerEmail} hint="يجب أن يكون قد سجّل وفعّل بريده" />
          <TextField label="اسم المنشأة" required value={v.companyName} onChange={(e) => setV({ ...v, companyName: e.target.value })} error={errors.companyName} />
          <TextField label="الرقم الضريبي أو السجل التجاري" required dir="ltr" inputMode="numeric" value={v.taxId} onChange={(e) => setV({ ...v, taxId: e.target.value })} error={errors.taxId} />
          <TextField label="المدينة" optional value={v.city} onChange={(e) => setV({ ...v, city: e.target.value })} />
        </div>
      </section>
      <section className="panel panel-pad form-section" aria-labelledby="nt-plan">
        <h2 id="nt-plan">الاشتراك</h2>
        <div className="form-grid">
          <SelectField label="القطاع" required value={v.sector} onChange={(e) => setV({ ...v, sector: e.target.value, planCode: "" })}
            options={available.map((s) => ({ value: s.key, label: s.nameAr }))} hint="القطاعات المبنية فقط" />
          <SelectField label="الباقة" required value={v.planCode} onChange={(e) => setV({ ...v, planCode: e.target.value })}
            options={[{ value: "", label: "التجربة المجانية (المدة من إعدادات المنصة)" }, ...sectorPlans.filter((p) => p.code !== trialCode).map((p) => ({ value: p.code, label: `${p.nameAr} · ${money(p.monthlyPrice)} شهرياً` }))]} />
          {paid && <>
            <TextField label="نهاية الاشتراك" required type="date" value={v.endsAt} min={addDays(isoDay(), 1)} onChange={(e) => setV({ ...v, endsAt: e.target.value })} error={errors.endsAt} />
            <TextField label={`القيمة الإجمالية للعقد (${RIYAL})`} optional numeric value={v.totalValue} onChange={(e) => setV({ ...v, totalValue: e.target.value })} error={errors.totalValue}
              hint={chosen ? `للمرجع: ${money(chosen.monthlyPrice * 12)} لسنة بسعر الباقة` : undefined} />
          </>}
        </div>
      </section>
      <FormError error={error} />
      <div className="lc-bar panel">
        <Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الإنشاء…">إنشاء المنشأة</Button>
        <Link to="/admin/tenants" className="btn btn-ghost">إلغاء</Link>
      </div>
    </form>
  );
}
