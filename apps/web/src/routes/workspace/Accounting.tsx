import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  ArrowRight, Banknote, BookOpen, CalendarClock, FileChartColumn, FileText, FolderTree, HandCoins, Hourglass, Landmark, NotebookPen, Percent, Plus, Printer,
  Scale, TrendingDown, TrendingUp, Truck, Users, X,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { api, ApiError, errorMessage, type Page } from "../../api/client";
import type { Customer, Supplier } from "../../api/types";
import { useIdempotencyKey } from "../../app/session";
import { useInvalidate, useTenant } from "../../app/tenant";
import { RIYAL, addDays, day, dayTime, hijri, integer, isoDay, money, percent, text } from "../../lib/format";
import { Button, IconButton } from "../../ui/Button";
import { DataTable } from "../../ui/DataTable";
import { DateRange } from "../../ui/DateRange";
import { ConfirmDialog, Dialog } from "../../ui/Dialog";
import { Checkbox, focusFirstInvalid, SearchInput, SelectField, TextAreaField, TextField } from "../../ui/Field";
import { ActionMenu, Badge, PageHeader, StatCard, StatusBadge } from "../../ui/Layout";
import { EmptyState, ErrorState, FormError, Skeleton, TableSkeleton } from "../../ui/States";
import { ACCOUNT_TYPE_LABELS, JOURNAL_SOURCE_LABELS } from "../../ui/status";
import { useToast } from "../../ui/Toast";
import { CustomerPicker } from "./pickers";

// ── Shared ──────────────────────────────────────────────────────────────────────────────────────
export type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";
export interface Account { id: string; code: string; name: string; type: AccountType; parentId: string | null; isGroup: boolean; systemKey: string | null; isActive: boolean; netDebit: number; hasEntries: boolean }
interface Summary {
  cash: number; cardClearing: number; platformReceivable: number; receivables: number; payables: number; inventory: number; vatDue: number;
  month: { from: string; to: string; revenue: number; grossProfit: number; netProfit: number };
  lockDate: string | null; unposted: { type: string; label: string; count: number; locked: number }[];
}

const num = (s: string) => Number(s.replace(/,/g, ""));
/** Typed amount in halalas, for the live totals only (the server re-checks everything). */
const halalas = (s: string) => Math.round((num(s) || 0) * 100);
const monthStart = () => `${isoDay().slice(0, 7)}-01`;
const yearStart = () => `${isoDay().slice(0, 4)}-01-01`;
export const accountLabel = (a: Pick<Account, "code" | "name">) => `${a.code} · ${a.name}`;
/** The server returns debit minus credit; assets and expenses read it as is, the others the other way round. */
const normalBalance = (a: Account) => (a.type === "asset" || a.type === "expense" ? a.netDebit : -a.netDebit);
/** Depth of each account in the tree. The list is sorted by code, and a child's code starts with its parent's, so parents come first. */
function depths(items: Account[]) {
  const m = new Map<string, number>();
  for (const a of items) m.set(a.id, a.parentId ? (m.get(a.parentId) ?? 0) + 1 : 0);
  return m;
}
const indent = (depth: number) => ({ "--depth": depth }) as CSSProperties;

export interface CostCenter { id: string; code: string; name: string; kind: "production" | "service" | "department" | "project"; isActive: boolean; linesCount: number }
export const COST_CENTER_KINDS: Record<CostCenter["kind"], string> = { production: "إنتاجي", service: "خدمي", department: "إداري", project: "مشروع" };
/** Cost centers (a production line, a department, a project): a second axis next to the branch. */
export function useCostCenters(tenantId: string, enabled = true) {
  return useQuery({ queryKey: ["t", tenantId, "accounting", "cost-centers"], queryFn: () => api<{ items: CostCenter[] }>("GET", "/t/cost-centers", { tenant: tenantId }), enabled });
}

export function useAccounts(tenantId: string) {
  return useQuery({ queryKey: ["t", tenantId, "accounting", "accounts"], queryFn: () => api<{ items: Account[] }>("GET", "/t/accounts", { tenant: tenantId }) });
}
function useSummary(tenantId: string) {
  return useQuery({ queryKey: ["t", tenantId, "accounting", "summary"], queryFn: () => api<Summary>("GET", "/t/accounting/summary", { tenant: tenantId }) });
}

/** Where an automatic entry came from, when that document has its own page. */
function sourceHref(tenantId: string, type: string, id: string | null) {
  if (!id) return null;
  const to: Record<string, string> = { sales_document: "accounting/invoices", purchase_receipt: "purchases", pos_order: "orders", stocktake: "stocktakes", reversal: "accounting/journal" };
  return to[type] ? `/w/${tenantId}/${to[type]}/${id}` : null;
}

/** Period for accounting screens: the shared DateRange plus this month / this year. */
function usePeriod(initial: [string, string] = [monthStart(), isoDay()]) {
  const [from, setFrom] = useState(initial[0]);
  const [to, setTo] = useState(initial[1]);
  const set = (f: string, t: string) => { setFrom(f); setTo(t); };
  const preset = (label: string, f: string) => (
    <button type="button" className={`btn btn-sm ${from === f && to === isoDay() ? "btn-secondary" : "btn-ghost"}`} aria-pressed={from === f && to === isoDay()} onClick={() => set(f, isoDay())}>{label}</button>
  );
  const range = <div className="row acc-period" role="group" aria-label="الفترة">{preset("هذا الشهر", monthStart())}{preset("هذه السنة", yearStart())}<DateRange from={from} to={to} onChange={set} /></div>;
  return { from, to, set, range };
}

// ── Dashboard ───────────────────────────────────────────────────────────────────────────────────
export function AccountingDashboardPage() {
  const { tenantId, can, writable } = useTenant();
  const s = useSummary(tenantId);
  const canWrite = can("acc_receipts.create") && writable;
  const base = `/w/${tenantId}/accounting`;
  const links: { to: string; label: string; note: string; icon: ReactNode; hue: string; show: boolean }[] = [
    { to: `${base}/invoices/new`, label: "إصدار فاتورة ضريبية", note: "لمنشأة أو مبسطة", icon: <FileText />, hue: "indigo", show: canWrite },
    { to: `${base}/receipts?new=1`, label: "تسجيل سند قبض", note: "تحصيل من عميل", icon: <HandCoins />, hue: "green", show: canWrite },
    { to: `${base}/journal/new`, label: "قيد يدوي", note: "تسويات وأرصدة افتتاحية", icon: <NotebookPen />, hue: "sky", show: canWrite },
    { to: `${base}/reports?tab=trial`, label: "ميزان المراجعة", note: "أرصدة كل الحسابات", icon: <Scale />, hue: "violet", show: true },
    { to: `${base}/reports?tab=income`, label: "قائمة الدخل", note: "الإيرادات والمصروفات والربح", icon: <TrendingUp />, hue: "green", show: true },
    { to: `${base}/reports?tab=vat`, label: "إقرار ضريبة القيمة المضافة", note: "ورقة عمل للبنود 1 إلى 16", icon: <Percent />, hue: "amber", show: true },
    { to: `${base}/reports?tab=aging`, label: "أعمار الذمم", note: "العملاء والموردون حسب مدة التأخير", icon: <Hourglass />, hue: "orange", show: true },
  ];
  return (
    <div className="page">
      <PageHeader eyebrow="الحسابات" title="لوحة الحسابات" description="أرصدة الحسابات الرئيسية كما في دفتر اليومية، وأداء الشهر الحالي. كل رقم هنا يعود إلى قيود يمكن تتبعها."
        actions={canWrite && <Link to={`${base}/invoices/new`} className="btn btn-secondary"><Plus aria-hidden="true" />فاتورة ضريبية</Link>} />
      {s.isError ? <ErrorState error={s.error} onRetry={() => s.refetch()} /> : !s.data ? (
        <div className="stats" aria-busy="true"><span className="sr-only" role="status">جارٍ تحميل الأرصدة…</span>{Array.from({ length: 6 }, (_, i) => <div key={i} className="stat"><Skeleton width="40%" /><Skeleton width="70%" height={28} /></div>)}</div>
      ) : <>
        <UnpostedCallout tenantId={tenantId} items={s.data.unposted} />
        <div className="stats">
          <StatCard label="النقدية والبنك" value={money(s.data.cash)} note={`بطاقات قيد التحصيل ${money(s.data.cardClearing)}`} icon={<Banknote />} hue="green" />
          <StatCard label="العملاء" value={money(s.data.receivables)} note={`ومستحق من تطبيقات التوصيل ${money(s.data.platformReceivable)}`} icon={<Users />} hue="violet" />
          <StatCard label="الموردون والمستحقات" value={money(s.data.payables)} note="للموردين وللمصروفات المستحقة" icon={<Truck />} hue="orange" />
          <StatCard label="ضريبة مستحقة" value={money(s.data.vatDue)} note={s.data.vatDue >= 0 ? "ضريبة المخرجات ناقص المدخلات" : "رصيد لصالحك لدى الهيئة"} icon={<Landmark />} hue="amber" />
          <StatCard label="مبيعات الشهر" value={money(s.data.month.revenue)} note={`مجمل الربح ${money(s.data.month.grossProfit)}`} icon={<TrendingUp />} hue="indigo" />
          <StatCard label="صافي ربح الشهر" value={money(s.data.month.netProfit)} noteTone={s.data.month.netProfit < 0 ? "warning" : undefined}
            note={s.data.month.netProfit < 0 ? "خسارة حتى الآن هذا الشهر" : `من ${day(s.data.month.from)} إلى ${day(s.data.month.to)}`} icon={s.data.month.netProfit < 0 ? <TrendingDown /> : <FileChartColumn />} hue={s.data.month.netProfit < 0 ? "red" : "green"} />
        </div>
        <div className="dash-grid">
          <section className="panel" aria-labelledby="acc-links-h">
            <div className="card-head"><h2 id="acc-links-h">اختصارات</h2></div>
            <div className="card-body">
              <ul className="acc-links">
                {links.filter((l) => l.show).map((l) => (
                  <li key={l.to}><Link to={l.to} className="acc-link"><span className={`acc-link-icon tone-${l.hue}`} aria-hidden="true">{l.icon}</span><span className="acc-link-text"><strong>{l.label}</strong><span>{l.note}</span></span></Link></li>
                ))}
              </ul>
            </div>
          </section>
          <section className="panel" aria-labelledby="acc-period-h">
            <div className="card-head"><h2 id="acc-period-h">الفترة المحاسبية</h2></div>
            <div className="card-body stack-lg">
              <dl className="dl">
                <dt>مقفلة حتى</dt><dd>{s.data.lockDate ? <><span>{day(s.data.lockDate)}</span> <Badge tone="info">لا تُقبل قيود قبله</Badge></> : "لا يوجد إقفال"}</dd>
                <dt>قيمة المخزون</dt><dd className="num">{money(s.data.inventory)}</dd>
              </dl>
              <Link to={`${base}/settings`} className="btn btn-ghost btn-sm acc-self-start">إعدادات المحاسبة والإقفال</Link>
            </div>
          </section>
        </div>
      </>}
    </div>
  );
}

/** Operations recorded before accounting existed (or that failed to post): they are missing from every balance until posted. */
function UnpostedCallout({ tenantId, items }: { tenantId: string; items: Summary["unposted"] }) {
  const { can, writable } = useTenant();
  const toast = useToast();
  const invalidate = useInvalidate(tenantId);
  const [busy, setBusy] = useState(false);
  if (!items.length) return null;
  const canManage = can("acc_accounts.create") && writable;
  async function sync() {
    setBusy(true);
    try {
      const r = await api<{ posted: number; skipped: number }>("POST", "/t/accounting/sync", { tenant: tenantId });
      toast.success(`رُحِّلت ${integer(r.posted)} عملية، وتُركت ${integer(r.skipped)} داخل فترة مقفلة`);
      await invalidate("accounting");
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <section className="panel acc-callout" aria-labelledby="unposted-h">
      <span className="acc-link-icon tone-amber" aria-hidden="true"><Hourglass /></span>
      <div className="acc-callout-body">
        <h2 id="unposted-h">عمليات سابقة لم تُرحَّل</h2>
        <p className="muted">لا تظهر في الأرصدة والتقارير المالية حتى تُرحَّل. الترحيل ينشئ قيودها بتواريخها الأصلية، وما يقع داخل فترة مقفلة يُترك كما هو.</p>
        <ul className="acc-unposted">
          {items.map((i) => (
            <li key={i.type}><span>{i.label}</span><span className="count-dot tag-amber num">{integer(i.count)}</span>{i.locked > 0 && <span className="muted">منها {integer(i.locked)} في فترة مقفلة</span>}</li>
          ))}
        </ul>
      </div>
      {canManage ? <Button variant="primary" loading={busy} loadingText="جارٍ الترحيل…" onClick={() => void sync()}>ترحيل الآن</Button>
        : <p className="muted acc-callout-note">يرحّلها من يملك صلاحية «إدارة المحاسبة».</p>}
    </section>
  );
}

// ── Journal ─────────────────────────────────────────────────────────────────────────────────────
interface JournalRow { id: string; number: number; date: string; description: string; sourceType: string; sourceLabel: string; reversalOf: string | null; reversed: boolean; amount: number }
interface EntryLine { id: string; accountId: string; accountCode: string; accountName: string; debit: number; credit: number; memo: string | null; partnerType: string | null; partnerName: string | null; branchName: string | null; costCenterName?: string | null }
interface Entry { id: string; number: number; date: string; description: string; sourceType: string; sourceLabel: string; sourceId: string | null; reversalOf: string | null; reversedBy: string | null; createdAt: string; lines: EntryLine[] }

const isManual = (sourceType: string) => sourceType === "manual" || sourceType === "opening";

export function JournalPage() {
  const { tenantId, can, writable } = useTenant();
  const navigate = useNavigate();
  const p = usePeriod();
  const [source, setSource] = useState("");
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(1);
  useEffect(() => { const t = setTimeout(() => { setDebounced(q.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);
  useEffect(() => setPage(1), [p.from, p.to]);
  const list = useQuery({ queryKey: ["t", tenantId, "accounting", "journal", { from: p.from, to: p.to, source, q: debounced, page }], placeholderData: keepPreviousData,
    queryFn: () => api<Page<JournalRow>>("GET", "/t/accounting/journal", { tenant: tenantId, query: { from: p.from, to: p.to, source, q: debounced, page, pageSize: 25 } }) });
  const add = can("acc_journal.create") && writable && <Link to={`/w/${tenantId}/accounting/journal/new`} className="btn btn-primary"><Plus aria-hidden="true" />قيد يدوي</Link>;
  return (
    <div className="page">
      <PageHeader eyebrow="الحسابات" title="القيود اليومية" description="كل عملية مالية تُرحَّل هنا تلقائياً بقيد مزدوج. القيود لا تُعدَّل ولا تُحذف: القيد اليدوي يُصحَّح بقيد عكسي، والتلقائي من العملية نفسها." actions={add} />
      <section className="panel">
        <DataTable caption="القيود اليومية" query={list} rowKey={(r) => r.id} onPageChange={setPage}
          filtered={Boolean(source || debounced)} onClearFilters={() => { setSource(""); setQ(""); setPage(1); }}
          toolbar={<>
            {p.range}
            <select className="select acc-filter" aria-label="مصدر القيد" value={source} onChange={(e) => { setSource(e.target.value); setPage(1); }}>
              <option value="">كل المصادر</option>{Object.entries(JOURNAL_SOURCE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <SearchInput placeholder="ابحث بالبيان أو رقم القيد" value={q} onChange={setQ} />
          </>}
          onRowClick={(r) => navigate({ to: `/w/${tenantId}/accounting/journal/${r.id}` })}
          empty={{ title: "لا توجد قيود في هذه الفترة", body: "تُنشأ القيود تلقائياً مع البيع والشراء والمصروفات، ويمكنك إضافة قيد يدوي للتسويات.", action: add || undefined }}
          columns={[
            { key: "n", header: "رقم القيد", cell: (r) => <Link to={`/w/${tenantId}/accounting/journal/${r.id}`} className="num">{r.number}</Link> },
            { key: "d", header: "التاريخ", cell: (r) => day(r.date) },
            { key: "desc", header: "البيان", wrap: true, cell: (r) => <span className="acc-desc"><strong>{r.description}</strong>{r.reversed && <Badge tone="warning">معكوس</Badge>}{r.reversalOf && <Badge tone="neutral">قيد عكسي</Badge>}</span> },
            { key: "s", header: "المصدر", cell: (r) => <span className={`tag tag-${isManual(r.sourceType) ? "sky" : "indigo"}`}>{r.sourceLabel}</span> },
            { key: "a", header: "المبلغ", numeric: true, cell: (r) => money(r.amount) },
          ]} />
      </section>
    </div>
  );
}

export function JournalEntryPage() {
  const { tenantId, can, writable } = useTenant();
  const { entryId } = useParams({ strict: false }) as { entryId: string };
  const [reversing, setReversing] = useState(false);
  const e = useQuery({ queryKey: ["t", tenantId, "accounting", "journal", entryId], queryFn: () => api<Entry>("GET", `/t/accounting/journal/${entryId}`, { tenant: tenantId }) });
  if (e.isPending) return <div className="page"><TableSkeleton columns={5} rows={4} label="جارٍ تحميل القيد…" /></div>;
  if (e.isError) return <div className="page"><ErrorState error={e.error} onRetry={() => e.refetch()} /></div>;
  const d = e.data;
  const debit = d.lines.reduce((a, l) => a + Math.round(l.debit * 100), 0) / 100;
  const credit = d.lines.reduce((a, l) => a + Math.round(l.credit * 100), 0) / 100;
  const canReverse = can("acc_journal.reverse") && writable && isManual(d.sourceType) && !d.reversedBy;
  const src = sourceHref(tenantId, d.sourceType, d.sourceId);
  const back = <Link to={`/w/${tenantId}/accounting/journal`} className="btn btn-ghost"><ArrowRight aria-hidden="true" />القيود</Link>;
  return (
    <div className="page">
      <PageHeader eyebrow="القيود اليومية" title={<span className="pf-title">قيد رقم <span className="num">{d.number}</span>{d.reversedBy && <Badge tone="warning">معكوس</Badge>}</span>} description={d.description}
        actions={<>{back}{canReverse && <Button onClick={() => setReversing(true)}>عكس القيد</Button>}</>} />
      {d.reversedBy && <p className="banner banner-warning ca-banner">عُكس هذا القيد بقيد آخر، فأثره على الأرصدة صفر.&nbsp;<Link to={`/w/${tenantId}/accounting/journal/${d.reversedBy}`}>عرض القيد العكسي</Link></p>}
      {d.reversalOf && <p className="banner banner-info ca-banner">هذا قيد عكسي يلغي أثر قيد سابق.&nbsp;<Link to={`/w/${tenantId}/accounting/journal/${d.reversalOf}`}>عرض القيد الأصلي</Link></p>}
      <section className="panel" aria-labelledby="entry-facts-h">
        <div className="card-head"><h2 id="entry-facts-h">بيانات القيد</h2></div>
        <div className="card-body">
          <dl className="dl">
            <dt>التاريخ</dt><dd>{day(d.date)} <span className="muted">({hijri(d.date)})</span></dd>
            <dt>المصدر</dt><dd>{d.sourceLabel}{src && d.sourceType !== "reversal" && <> · <Link to={src}>فتح العملية</Link></>}</dd>
            <dt>سُجّل في</dt><dd>{dayTime(d.createdAt)}</dd>
          </dl>
          {!isManual(d.sourceType) && d.sourceType !== "reversal" && <p className="muted acc-small">قيد تلقائي: لا يُعكس من هنا. صحّح العملية نفسها (مرتجع، إشعار دائن، إلغاء…) فيُنشأ قيدها المقابل.</p>}
        </div>
      </section>
      <section className="panel" aria-labelledby="entry-lines-h">
        <div className="toolbar"><h2 id="entry-lines-h">أطراف القيد</h2><span className="spacer" /><span className="muted"><span className="num">{integer(d.lines.length)}</span> سطر</span></div>
        <div className="table-wrap">
          <table className="data-table">
            <caption className="sr-only">أطراف القيد رقم {d.number}</caption>
            <thead><tr><th scope="col">الحساب</th><th scope="col">البيان</th><th scope="col">العميل / المورد</th><th scope="col" className="end">مدين</th><th scope="col" className="end">دائن</th></tr></thead>
            <tbody>{d.lines.map((l) => (
              <tr key={l.id}>
                <td><Link to={`/w/${tenantId}/accounting/reports?tab=ledger&accountId=${l.accountId}`}><strong className="num">{l.accountCode}</strong> {l.accountName}</Link></td>
                <td className="wrap">{text(l.memo)}{l.branchName && <span className="muted"> · {l.branchName}</span>}{l.costCenterName && <span className="muted"> · مركز {l.costCenterName}</span>}</td>
                <td>{text(l.partnerName)}</td>
                <td className="end num">{l.debit ? money(l.debit) : "—"}</td>
                <td className="end num">{l.credit ? money(l.credit) : "—"}</td>
              </tr>
            ))}</tbody>
            <tfoot><tr><td colSpan={3}>الإجمالي</td><td className="end num">{money(debit)}</td><td className="end num">{money(credit)}</td></tr></tfoot>
          </table>
        </div>
      </section>
      {reversing && <ReverseDialog tenantId={tenantId} entry={d} onClose={() => setReversing(false)} />}
    </div>
  );
}

function ReverseDialog({ tenantId, entry, onClose }: { tenantId: string; entry: Entry; onClose: () => void }) {
  const navigate = useNavigate();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [key, renewKey] = useIdempotencyKey();
  const [reason, setReason] = useState("");
  const [date, setDate] = useState(isoDay());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function reverse() {
    if (reason.trim().length < 3) return setError("اكتب سبب العكس، مثل: قيد مكرر");
    setBusy(true); setError(null);
    try {
      const r = await api<{ id: string }>("POST", `/t/accounting/journal/${entry.id}/reverse`, { tenant: tenantId, idempotencyKey: key, body: { reason: reason.trim(), date } });
      renewKey();
      toast.success(`عُكس القيد رقم ${entry.number}`);
      await invalidate("accounting");
      onClose();
      navigate({ to: `/w/${tenantId}/accounting/journal/${r.id}` });
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <ConfirmDialog open onClose={onClose} busy={busy} error={error} onConfirm={() => void reverse()}
      title={`عكس القيد رقم ${entry.number}`} confirmLabel="ترحيل القيد العكسي"
      message={<>سيُرحَّل قيد جديد بنفس الأطراف معكوسة (المدين دائناً والدائن مديناً) فيُلغى أثر «{entry.description}». القيد الأصلي يبقى في السجل، ولا يمكن التراجع عن العكس.</>}>
      <TextAreaField label="سبب العكس" required rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      <TextField label="تاريخ القيد العكسي" type="date" required value={date} max={isoDay()} onChange={(e) => setDate(e.target.value)} hint="لا يكون داخل فترة مقفلة." />
    </ConfirmDialog>
  );
}

// ── New manual entry ────────────────────────────────────────────────────────────────────────────
interface JLine { key: string; accountId: string; debit: string; credit: string; memo: string; partner: { id: string; name: string } | null; costCenterId: string }
const emptyJLine = (): JLine => ({ key: crypto.randomUUID(), accountId: "", debit: "", credit: "", memo: "", partner: null, costCenterId: "" });

export function NewJournalEntryPage() {
  const { tenantId } = useTenant();
  const navigate = useNavigate();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const accounts = useAccounts(tenantId);
  const centers = useCostCenters(tenantId);
  const activeCenters = (centers.data?.items ?? []).filter((c) => c.isActive);
  const suppliers = useQuery({ queryKey: ["t", tenantId, "suppliers", "options"], queryFn: () => api<Page<Supplier>>("GET", "/t/suppliers", { tenant: tenantId, query: { isActive: "true", pageSize: 100 } }) });
  const [key, renewKey] = useIdempotencyKey();
  const form = useRef<HTMLFormElement>(null);
  const [date, setDate] = useState(isoDay());
  const [description, setDescription] = useState("");
  const [opening, setOpening] = useState(false);
  const [lines, setLines] = useState<JLine[]>(() => [emptyJLine(), emptyJLine()]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const leaves = (accounts.data?.items ?? []).filter((a) => !a.isGroup && a.isActive);
  const byId = new Map(leaves.map((a) => [a.id, a]));
  const partnerOf = (l: JLine) => { const k = byId.get(l.accountId)?.systemKey; return k === "ar" ? "customer" : k === "ap" ? "supplier" : null; };
  // Live totals of what was typed: display only, the server checks the balance.
  const debit = lines.reduce((a, l) => a + halalas(l.debit), 0);
  const credit = lines.reduce((a, l) => a + halalas(l.credit), 0);
  const diff = debit - credit;
  const setLine = (i: number, patch: Partial<JLine>) => setLines((ls) => ls.map((l, n) => (n === i ? { ...l, ...patch } : l)));

  function review() {
    const e: Record<string, string> = {};
    if (!date) e.date = "اختر تاريخ القيد";
    if (description.trim().length < 2) e.description = "اكتب بيان القيد، مثل: رصيد افتتاحي للصندوق";
    lines.forEach((l, i) => {
      if (!l.accountId) e[`lines.${i}.accountId`] = "اختر الحساب";
      const d = halalas(l.debit), c = halalas(l.credit);
      if ((d > 0) === (c > 0) || d < 0 || c < 0) e[`lines.${i}.debit`] = "أدخل مبلغاً في المدين أو في الدائن (واحد فقط)";
      if (partnerOf(l) && !l.partner) e[`lines.${i}.partner`] = partnerOf(l) === "customer" ? "اختر العميل" : "اختر المورد";
    });
    if (lines.length < (opening ? 1 : 2)) e.lines = "القيد يحتاج سطرين على الأقل";
    setErrors(e);
    if (Object.keys(e).length) return focusFirstInvalid(form.current);
    setError(null); setConfirming(true);
  }
  async function post() {
    setBusy(true);
    try {
      const r = await api<{ id: string }>("POST", "/t/accounting/journal", { tenant: tenantId, idempotencyKey: key, body: {
        date, description: description.trim(), opening,
        lines: lines.map((l) => ({ accountId: l.accountId, debit: num(l.debit) || 0, credit: num(l.credit) || 0, memo: l.memo.trim() || null,
          partnerType: l.partner ? partnerOf(l) : null, partnerId: l.partner?.id ?? null, costCenterId: l.costCenterId || null })),
      } });
      renewKey();
      toast.success("تم ترحيل القيد");
      await invalidate("accounting");
      navigate({ to: `/w/${tenantId}/accounting/journal/${r.id}` });
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fieldErrors);
      setError(err); setConfirming(false);
    } finally { setBusy(false); }
  }
  return (
    <form ref={form} className="page" noValidate onSubmit={(e) => { e.preventDefault(); review(); }}>
      <PageHeader eyebrow="القيود اليومية" title="قيد يدوي" description="للتسويات والأرصدة الافتتاحية. القيد لا يُعدَّل ولا يُحذف بعد ترحيله؛ التصحيح بقيد عكسي."
        actions={<Link to={`/w/${tenantId}/accounting/journal`} className="btn btn-ghost"><ArrowRight aria-hidden="true" />القيود</Link>} />
      <section className="panel panel-pad form-section" aria-labelledby="je-head">
        <h2 id="je-head">بيانات القيد</h2>
        <div className="form-grid">
          <TextField label="التاريخ" type="date" required value={date} onChange={(e) => setDate(e.target.value)} error={errors.date} hint="لا يكون داخل فترة مقفلة." />
          <TextField label="البيان" required value={description} onChange={(e) => setDescription(e.target.value)} error={errors.description} />
        </div>
        <Checkbox label="قيد أرصدة افتتاحية" checked={opening} onChange={(e) => setOpening(e.target.checked)} />
        <p className="field-hint pf-under-check">أدخل أرصدة الحسابات عند بدء استخدام النظام. الفرق بين المدين والدائن يُسجَّل تلقائياً في حساب «أرصدة افتتاحية» ضمن حقوق الملكية.</p>
      </section>
      <section className="panel panel-pad form-section" aria-labelledby="je-lines">
        <h2 id="je-lines">أطراف القيد</h2>
        {accounts.isError && <ErrorState error={accounts.error} onRetry={() => accounts.refetch()} title="تعذر تحميل دليل الحسابات" />}
        <ol className="acc-lines">
          {lines.map((l, i) => {
            const partner = partnerOf(l);
            return (
              <li key={l.key} className="acc-line">
                <div className="acc-line-grid acc-je-grid">
                  <SelectField label={`حساب السطر ${i + 1}`} required placeholder={accounts.isPending ? "جارٍ التحميل…" : "اختر الحساب"} value={l.accountId} error={errors[`lines.${i}.accountId`]}
                    onChange={(e) => setLine(i, { accountId: e.target.value, partner: null })} options={leaves.map((a) => ({ value: a.id, label: accountLabel(a) }))} />
                  <TextField label={`مدين (${RIYAL})`} numeric value={l.debit} error={errors[`lines.${i}.debit`]} onChange={(e) => setLine(i, { debit: e.target.value, credit: e.target.value ? "" : l.credit })} />
                  <TextField label={`دائن (${RIYAL})`} numeric value={l.credit} onChange={(e) => setLine(i, { credit: e.target.value, debit: e.target.value ? "" : l.debit })} />
                  <TextField label="بيان السطر" optional value={l.memo} onChange={(e) => setLine(i, { memo: e.target.value })} />
                  <IconButton label={`حذف السطر ${i + 1}`} icon={<X />} destructive className="acc-line-remove" disabled={lines.length <= 1} onClick={() => setLines((ls) => ls.filter((_, n) => n !== i))} />
                </div>
                {partner === "customer" && (l.partner
                  ? <p className="acc-partner">العميل: <strong>{l.partner.name}</strong> <Button size="sm" variant="ghost" onClick={() => setLine(i, { partner: null })}>تغيير</Button></p>
                  : <CustomerPicker tenantId={tenantId} label="العميل" required error={errors[`lines.${i}.partner`]} hint="حساب العملاء يحتاج اسم العميل ليظهر في أعمار الذمم." onPick={(c: Customer) => setLine(i, { partner: { id: c.id, name: c.name } })} />)}
                {partner === "supplier" && (
                  <SelectField label="المورد" required placeholder="اختر المورد" value={l.partner?.id ?? ""} error={errors[`lines.${i}.partner`]} hint="حساب الموردين يحتاج اسم المورد ليظهر في أعمار الذمم."
                    onChange={(e) => { const s = suppliers.data?.items.find((x) => x.id === e.target.value); setLine(i, { partner: s ? { id: s.id, name: s.name } : null }); }}
                    options={(suppliers.data?.items ?? []).map((s) => ({ value: s.id, label: s.name }))} />
                )}
                {activeCenters.length > 0 && ["revenue", "expense"].includes(byId.get(l.accountId)?.type ?? "") && (
                  <SelectField label="مركز التكلفة" optional placeholder="بدون مركز تكلفة" value={l.costCenterId}
                    onChange={(e) => setLine(i, { costCenterId: e.target.value })} options={activeCenters.map((c) => ({ value: c.id, label: `${c.code} · ${c.name}` }))}
                    hint="يُحلَّل به هذا السطر في قائمة الدخل." />
                )}
              </li>
            );
          })}
        </ol>
        {errors.lines && <span className="field-error" role="alert">{errors.lines}</span>}
        <div className="row"><Button variant="ghost" icon={<Plus />} onClick={() => setLines((ls) => [...ls, emptyJLine()])}>إضافة سطر</Button></div>
      </section>
      <FormError error={error} />
      <div className="pf-form-foot">
        <Button type="submit" variant="primary">مراجعة وترحيل القيد</Button>
        <Link to={`/w/${tenantId}/accounting/journal`} className="btn btn-ghost">إلغاء</Link>
        <span className="spacer" />
        <span className="acc-totals" aria-live="polite">
          <span>مدين <strong className="num">{money(debit / 100)}</strong></span>
          <span>دائن <strong className="num">{money(credit / 100)}</strong></span>
          {diff === 0 ? <Badge tone="success">متوازن</Badge> : opening ? <Badge tone="info">الفرق {money(Math.abs(diff) / 100)} إلى الأرصدة الافتتاحية</Badge> : <Badge tone="warning">الفرق {money(Math.abs(diff) / 100)}</Badge>}
        </span>
      </div>
      <ConfirmDialog open={confirming} onClose={() => setConfirming(false)} busy={busy} destructive={false} onConfirm={() => void post()}
        title="ترحيل القيد" confirmLabel="ترحيل القيد"
        message={<>سيُرحَّل قيد «{description.trim()}» بتاريخ {day(date)} من {integer(lines.length)} سطر. القيد لا يُعدَّل ولا يُحذف بعد الترحيل؛ التصحيح بقيد عكسي.{opening && diff !== 0 ? " الفرق يُسجَّل في حساب الأرصدة الافتتاحية." : ""}</>} />
    </form>
  );
}

// ── Cost centers ────────────────────────────────────────────────────────────────────────────────
export function CostCentersPage() {
  const { tenantId, can, writable } = useTenant();
  const navigate = useNavigate();
  const list = useCostCenters(tenantId);
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [editing, setEditing] = useState<CostCenter | "new" | null>(null);
  const canCreate = can("cost_centers.create") && writable;
  const canEdit = can("cost_centers.edit") && writable;
  const canReport = can("acc_reports.view") || can("cost_centers.view");
  async function toggle(c: CostCenter) {
    try {
      await api("PATCH", `/t/cost-centers/${c.id}`, { tenant: tenantId, body: { isActive: !c.isActive } });
      toast.success(c.isActive ? `أُوقف مركز «${c.name}»` : `فُعّل مركز «${c.name}»`);
      await invalidate("accounting");
    } catch (e) { toast.error(errorMessage(e)); }
  }
  const items = list.data?.items ?? [];
  return (
    <div className="page">
      <PageHeader eyebrow="الحسابات" title="مراكز التكلفة"
        description="تحليل ثانٍ بجانب الفرع: خط إنتاج، قسم، أو مشروع. اختره على سطور القيود اليدوية وعلى المصروفات، ثم اعرض قائمة الدخل لكل مركز."
        actions={canCreate && <Button variant="primary" icon={<Plus />} onClick={() => setEditing("new")}>إضافة مركز تكلفة</Button>} />
      <section className="panel" aria-label="مراكز التكلفة">
        {list.isPending ? <TableSkeleton columns={5} rows={3} label="جارٍ تحميل مراكز التكلفة…" />
          : list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} title="تعذر تحميل مراكز التكلفة" />
          : items.length === 0 ? <EmptyState title="لا توجد مراكز تكلفة بعد"
              action={canCreate ? <Button variant="primary" icon={<Plus />} onClick={() => setEditing("new")}>إضافة مركز تكلفة</Button> : undefined}>أنشئ مركزاً لكل خط إنتاج أو قسم تريد معرفة تكلفته وربحيته وحده.</EmptyState>
          : (
            <div className="table-wrap">
              <table className="data-table">
                <caption className="sr-only">مراكز التكلفة</caption>
                <thead><tr><th scope="col">الرمز</th><th scope="col">المركز</th><th scope="col">النوع</th><th scope="col" className="end">سطور القيود</th><th scope="col">الحالة</th><th scope="col"><span className="sr-only">إجراءات</span></th></tr></thead>
                <tbody>{items.map((c) => (
                  <tr key={c.id}>
                    <td className="num">{c.code}</td>
                    <td><strong>{c.name}</strong></td>
                    <td>{COST_CENTER_KINDS[c.kind]}</td>
                    <td className="end num">{integer(c.linesCount)}</td>
                    <td><StatusBadge kind="active" value={c.isActive} /></td>
                    <td className="end">
                      <ActionMenu label={`إجراءات مركز ${c.name}`} items={[
                        ...(canReport ? [{ label: "قائمة الدخل لهذا المركز", onSelect: () => void navigate({ to: `/w/${tenantId}/accounting/reports?tab=income&costCenterId=${c.id}` }) }] : []),
                        ...(canEdit ? [{ label: "تعديل", onSelect: () => setEditing(c) }, { label: c.isActive ? "إيقاف" : "تفعيل", onSelect: () => void toggle(c) }] : []),
                      ]} />
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
      </section>
      {editing && <CostCenterDialog tenantId={tenantId} center={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function CostCenterDialog({ tenantId, center, onClose }: { tenantId: string; center: CostCenter | null; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const form = useRef<HTMLFormElement>(null);
  const [v, setV] = useState({ code: center?.code ?? "", name: center?.name ?? "", kind: center?.kind ?? "production" as CostCenter["kind"] });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    const e: Record<string, string> = {};
    if (!center && !/^[A-Za-z0-9-]{1,20}$/.test(v.code.trim())) e.code = "حروف إنجليزية وأرقام وشرطة، مثل LINE-1";
    if (v.name.trim().length < 2) e.name = "أدخل اسم المركز";
    setErrors(e);
    if (Object.keys(e).length) return focusFirstInvalid(form.current);
    setBusy(true); setError(null);
    try {
      if (center) await api("PATCH", `/t/cost-centers/${center.id}`, { tenant: tenantId, body: { name: v.name.trim(), kind: v.kind } });
      else await api("POST", "/t/cost-centers", { tenant: tenantId, body: { code: v.code.trim(), name: v.name.trim(), kind: v.kind } });
      toast.success(center ? `حُفظ مركز «${v.name.trim()}»` : `أُضيف مركز «${v.name.trim()}»`);
      await invalidate("accounting");
      onClose();
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fieldErrors);
      setError(err);
    } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} formRef={form} onSubmit={() => void submit()} title={center ? `تعديل مركز «${center.name}»` : "إضافة مركز تكلفة"}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">{center ? "حفظ التعديلات" : "حفظ المركز"}</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <div className="form-grid">
        <TextField label="الرمز" required dir="ltr" value={v.code} disabled={Boolean(center)} onChange={(e) => setV({ ...v, code: e.target.value.toUpperCase() })} error={errors.code}
          hint={center ? "الرمز على قيود مرحّلة فلا يتغير." : "قصير وثابت، مثل LINE-1 أو MAINT."} />
        <TextField label="اسم المركز" required value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} error={errors.name} />
        <SelectField label="النوع" required value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value as CostCenter["kind"] })}
          options={Object.entries(COST_CENTER_KINDS).map(([value, label]) => ({ value, label }))} hint="الإنتاجي يحمّل تكلفته على المنتجات؛ الخدمي يخدم الإنتاج (صيانة، جودة)." />
      </div>
      <FormError error={error} />
    </Dialog>
  );
}

// ── Chart of accounts ───────────────────────────────────────────────────────────────────────────
export function AccountsPage() {
  const { tenantId, can, writable } = useTenant();
  const navigate = useNavigate();
  const toast = useToast();
  const invalidate = useInvalidate(tenantId);
  const accounts = useAccounts(tenantId);
  const [q, setQ] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [creating, setCreating] = useState<{ parentId: string } | null>(null);
  const [renaming, setRenaming] = useState<Account | null>(null);
  const canManage = can("acc_settings.manage") && writable;
  const all = accounts.data?.items ?? [];
  const depth = useMemo(() => depths(all), [all]);
  const needle = q.trim();
  const rows = all.filter((a) => (showInactive || a.isActive) && (!needle || a.code.startsWith(needle) || a.name.includes(needle)));
  async function toggle(a: Account) {
    try {
      await api("PATCH", `/t/accounts/${a.id}`, { tenant: tenantId, body: { isActive: !a.isActive } });
      toast.success(a.isActive ? `أُوقف الحساب ${a.code}` : `فُعّل الحساب ${a.code}`);
      await invalidate("accounting");
    } catch (e) { toast.error(errorMessage(e)); }
  }
  const add = canManage && <Button variant="primary" icon={<Plus />} onClick={() => setCreating({ parentId: "" })}>حساب جديد</Button>;
  return (
    <div className="page">
      <PageHeader eyebrow="الحسابات" title="دليل الحسابات" description="شجرة الحسابات التي تُرحَّل إليها القيود. الحسابات النظامية تستخدمها القيود التلقائية: يمكن تغيير اسمها ولا يمكن إيقافها." actions={add} />
      <section className="panel">
        <DataTable caption="دليل الحسابات" query={{ ...accounts, data: accounts.data ? { items: rows } : undefined }} rowKey={(a) => a.id}
          filtered={Boolean(needle)} onClearFilters={() => setQ("")}
          toolbar={<><SearchInput placeholder="ابحث برقم الحساب أو اسمه" value={q} onChange={setQ} /><Checkbox label="إظهار الحسابات الموقوفة" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /></>}
          empty={{ title: "لا توجد حسابات", body: "يُنشأ دليل الحسابات الافتراضي مع تفعيل المحاسبة للمنشأة." }}
          columns={[
            { key: "code", header: "رقم الحساب", sortKey: false, cell: (a) => <span className="num">{a.code}</span> },
            { key: "name", header: "اسم الحساب", sortKey: false, cell: (a) => (
              <span className={`acc-tree-name${a.isGroup ? " is-group" : ""}`} style={indent(needle ? 0 : depth.get(a.id) ?? 0)}>
                {a.isGroup && <FolderTree aria-hidden="true" />}{a.name}{a.systemKey && <Badge tone="neutral">نظامي</Badge>}{a.isGroup && <span className="sr-only"> (حساب رئيسي)</span>}
              </span>
            ) },
            { key: "type", header: "النوع", sortKey: false, cell: (a) => ACCOUNT_TYPE_LABELS[a.type] },
            { key: "bal", header: "الرصيد", numeric: true, sortKey: false, cell: (a) => (a.isGroup ? "—" : money(normalBalance(a))) },
            { key: "s", header: "الحالة", sortKey: false, cell: (a) => <StatusBadge kind="active" value={a.isActive} /> },
          ]}
          actions={(a) => <ActionMenu label={`إجراءات الحساب ${a.code}`} items={[
            { label: "دفتر الأستاذ", onSelect: () => navigate({ to: `/w/${tenantId}/accounting/reports?tab=ledger&accountId=${a.id}` }) },
            ...(canManage && a.isGroup ? [{ label: "إضافة حساب فرعي", onSelect: () => setCreating({ parentId: a.id }) }] : []),
            ...(canManage ? [{ label: "تعديل الاسم", onSelect: () => setRenaming(a) }] : []),
            ...(canManage && !a.systemKey ? [{ label: a.isActive ? "إيقاف الحساب" : "تفعيل الحساب", separated: true, onSelect: () => void toggle(a) }] : []),
          ]} />} />
      </section>
      {creating && <AccountDialog tenantId={tenantId} accounts={all} parentId={creating.parentId} onClose={() => setCreating(null)} />}
      {renaming && <RenameAccountDialog tenantId={tenantId} account={renaming} onClose={() => setRenaming(null)} />}
    </div>
  );
}

function AccountDialog({ tenantId, accounts, parentId, onClose }: { tenantId: string; accounts: Account[]; parentId: string; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const form = useRef<HTMLFormElement>(null);
  const groups = accounts.filter((a) => a.isGroup && a.isActive);
  const initialParent = groups.find((g) => g.id === parentId);
  const [v, setV] = useState({ parentId, code: initialParent?.code ?? "", name: "", isGroup: false });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const parent = groups.find((g) => g.id === v.parentId);
  async function submit() {
    const e: Record<string, string> = {};
    if (!parent) e.parentId = "اختر الحساب الرئيسي الذي يتبعه";
    if (!/^[0-9]{1,10}$/.test(v.code.trim())) e.code = "رقم الحساب أرقام فقط (حتى 10 خانات)";
    else if (parent && (!v.code.trim().startsWith(parent.code) || v.code.trim() === parent.code)) e.code = `يبدأ برقم الحساب الرئيسي ${parent.code} ويزيد عليه`;
    if (v.name.trim().length < 2) e.name = "أدخل اسم الحساب";
    setErrors(e);
    if (Object.keys(e).length) return focusFirstInvalid(form.current);
    setBusy(true); setError(null);
    try {
      await api("POST", "/t/accounts", { tenant: tenantId, body: { parentId: v.parentId, code: v.code.trim(), name: v.name.trim(), isGroup: v.isGroup } });
      toast.success(`أُضيف الحساب ${v.code.trim()} · ${v.name.trim()}`);
      await invalidate("accounting");
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === "account_exists") setErrors({ code: err.message });
      else if (err instanceof ApiError) setErrors(err.fieldErrors);
      setError(err);
    } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} formRef={form} title="حساب جديد" onSubmit={() => void submit()}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">إضافة الحساب</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <SelectField label="يتبع الحساب الرئيسي" required placeholder="اختر الحساب الرئيسي" value={v.parentId} error={errors.parentId}
        onChange={(e) => { const p = groups.find((g) => g.id === e.target.value); setV({ ...v, parentId: e.target.value, code: !v.code || v.code === parent?.code ? p?.code ?? "" : v.code }); }}
        options={groups.map((g) => ({ value: g.id, label: accountLabel(g) }))} hint={parent ? `نوعه: ${ACCOUNT_TYPE_LABELS[parent.type]}، ويأخذ الحساب الجديد النوع نفسه.` : undefined} />
      <div className="form-grid">
        <TextField label="رقم الحساب" required dir="ltr" inputMode="numeric" value={v.code} onChange={(e) => setV({ ...v, code: e.target.value })} error={errors.code} hint={parent ? `يبدأ بـ ${parent.code}` : undefined} />
        <TextField label="اسم الحساب" required value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} error={errors.name} />
      </div>
      <Checkbox label="حساب رئيسي (تجميعي)" checked={v.isGroup} onChange={(e) => setV({ ...v, isGroup: e.target.checked })} />
      <p className="field-hint pf-under-check">الحساب الرئيسي يجمع حسابات فرعية ولا تُرحَّل إليه قيود مباشرة.</p>
      <FormError error={error} />
    </Dialog>
  );
}

function RenameAccountDialog({ tenantId, account, onClose }: { tenantId: string; account: Account; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [name, setName] = useState(account.name);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (name.trim().length < 2) return setError("أدخل اسم الحساب");
    setBusy(true); setError(null);
    try {
      await api("PATCH", `/t/accounts/${account.id}`, { tenant: tenantId, body: { name: name.trim() } });
      toast.success("تم تعديل اسم الحساب");
      await invalidate("accounting");
      onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} title={`تعديل اسم الحساب ${account.code}`} onSubmit={() => void submit()}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">حفظ الاسم</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <TextField label="اسم الحساب" required value={name} onChange={(e) => setName(e.target.value)} hint="الاسم الجديد يظهر في كل القيود والتقارير، السابقة واللاحقة." />
      <FormError error={error} />
    </Dialog>
  );
}

// ── Financial reports ───────────────────────────────────────────────────────────────────────────
type ReportTab = "trial" | "income" | "balance" | "ledger" | "aging" | "vat";
const REPORT_TABS: [ReportTab, string][] = [["trial", "ميزان المراجعة"], ["income", "قائمة الدخل"], ["balance", "المركز المالي"], ["ledger", "دفتر الأستاذ"], ["aging", "أعمار الذمم"], ["vat", "إقرار ضريبة القيمة المضافة"]];

export function AccountingReportsPage() {
  const { tenantId } = useTenant();
  const [init] = useState(() => new URLSearchParams(window.location.search));
  const [tab, setTab] = useState<ReportTab>(() => (REPORT_TABS.some(([k]) => k === init.get("tab")) ? init.get("tab") as ReportTab : "trial"));
  const [accountId, setAccountId] = useState(init.get("accountId") ?? "");
  const [costCenterId] = useState(init.get("costCenterId") ?? "");
  const openLedger = (id: string) => { setAccountId(id); setTab("ledger"); window.scrollTo({ top: 0 }); };
  return (
    <div className="page">
      <PageHeader eyebrow="الحسابات" title="التقارير المالية" description="تُقرأ كلها من دفتر اليومية فقط، فكل رقم يعود إلى قيوده. العمليات غير المرحّلة لا تظهر فيها." />
      <div className="tabs acc-tabs no-print" role="tablist" aria-label="التقارير المالية">
        {REPORT_TABS.map(([k, l]) => <button key={k} type="button" role="tab" id={`rtab-${k}`} aria-controls={`rpanel-${k}`} aria-selected={tab === k} className="tab" onClick={() => setTab(k)}>{l}</button>)}
      </div>
      <div role="tabpanel" id={`rpanel-${tab}`} aria-labelledby={`rtab-${tab}`} className="stack-lg">
        {tab === "trial" && <TrialBalance tenantId={tenantId} onAccount={openLedger} />}
        {tab === "income" && <IncomeStatement tenantId={tenantId} onAccount={openLedger} initialCostCenter={costCenterId} />}
        {tab === "balance" && <BalanceSheet tenantId={tenantId} onAccount={openLedger} />}
        {tab === "ledger" && <Ledger tenantId={tenantId} accountId={accountId} setAccountId={setAccountId} />}
        {tab === "aging" && <Aging tenantId={tenantId} />}
        {tab === "vat" && <VatReturn tenantId={tenantId} />}
      </div>
    </div>
  );
}

/** Filters + print, then the printable report card with a heading that only prints. */
function ReportFrame({ title, period, controls, summary, children }: { title: string; period: string; controls: ReactNode; summary?: ReactNode; children: ReactNode }) {
  const { ctx } = useTenant();
  return (
    <>
      <div className="toolbar panel sr-filter-bar no-print">{controls}<span className="spacer" /><Button icon={<Printer />} onClick={() => window.print()}>طباعة التقرير</Button></div>
      {summary}
      <section className="panel acc-print" aria-label={title}>
        <div className="acc-print-only acc-print-head"><strong>{ctx.tenant.companyName}</strong><h2>{title}</h2><span>{period}</span></div>
        {children}
      </section>
    </>
  );
}

function ReportState({ q, columns, empty, children }: { q: { isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown; data?: unknown }; columns: number; empty: boolean; children: () => ReactNode }) {
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (q.isPending || !q.data) return <TableSkeleton columns={columns} rows={6} label="جارٍ تحميل التقرير…" />;
  if (empty) return <EmptyState title="لا توجد قيود في هذه الفترة">جرّب فترة أخرى، أو رحّل العمليات السابقة من لوحة الحسابات.</EmptyState>;
  return <>{children()}</>;
}

const signedDr = (v: number) => (v ? money(v) : "—");

interface TbSide { debit: number; credit: number }
interface TbRow { id: string; code: string; name: string; type: AccountType; isGroup: boolean; depth: number; opening: TbSide; period: TbSide; closing: TbSide }

function TrialBalance({ tenantId, onAccount }: { tenantId: string; onAccount: (id: string) => void }) {
  const p = usePeriod();
  const [leavesOnly, setLeavesOnly] = useState(false);
  const r = useQuery({ queryKey: ["t", tenantId, "accounting", "trial", p.from, p.to], placeholderData: keepPreviousData,
    queryFn: () => api<{ from: string; to: string; rows: TbRow[]; totals: { opening: TbSide; period: TbSide; closing: TbSide } }>("GET", "/t/accounting/trial-balance", { tenant: tenantId, query: { from: p.from, to: p.to } }) });
  const rows = (r.data?.rows ?? []).filter((x) => !leavesOnly || !x.isGroup);
  const t = r.data?.totals;
  return (
    <ReportFrame title="ميزان المراجعة" period={`من ${day(p.from)} إلى ${day(p.to)}`}
      controls={<>{p.range}<Checkbox label="الحسابات الفرعية فقط" checked={leavesOnly} onChange={(e) => setLeavesOnly(e.target.checked)} /></>}>
      <ReportState q={r} columns={8} empty={rows.length === 0}>{() => (
        <div className="table-wrap">
          <table className="data-table acc-report">
            <caption className="sr-only">ميزان المراجعة من {day(p.from)} إلى {day(p.to)}</caption>
            <thead>
              <tr><th scope="col" rowSpan={2}>رقم الحساب</th><th scope="col" rowSpan={2}>الحساب</th><th scope="colgroup" colSpan={2} className="acc-th-group">الرصيد الافتتاحي</th><th scope="colgroup" colSpan={2} className="acc-th-group">حركة الفترة</th><th scope="colgroup" colSpan={2} className="acc-th-group">الرصيد الختامي</th></tr>
              <tr>{["opening", "period", "closing"].map((k) => <Fragment key={k}><th scope="col" className="end">مدين</th><th scope="col" className="end">دائن</th></Fragment>)}</tr>
            </thead>
            <tbody>{rows.map((x) => (
              <tr key={x.id} className={x.isGroup ? "acc-group-row" : undefined}>
                <td className="num">{x.code}</td>
                <td><span className="acc-tree-name" style={indent(leavesOnly ? 0 : x.depth)}>{x.isGroup ? x.name : <button type="button" className="link-button" onClick={() => onAccount(x.id)}>{x.name}</button>}</span></td>
                {[x.opening, x.period, x.closing].map((s, i) => <Fragment key={i}><td className="end num">{signedDr(s.debit)}</td><td className="end num">{signedDr(s.credit)}</td></Fragment>)}
              </tr>
            ))}</tbody>
            {t && <tfoot><tr><td colSpan={2}>الإجمالي (الحسابات الفرعية)</td>{[t.opening, t.period, t.closing].map((s, i) => <Fragment key={i}><td className="end num">{money(s.debit)}</td><td className="end num">{money(s.credit)}</td></Fragment>)}</tr></tfoot>}
          </table>
        </div>
      )}</ReportState>
    </ReportFrame>
  );
}

interface StmtLine { id: string; code: string; name: string; amount: number }
interface StmtSection { lines: StmtLine[]; total: number }
interface Income { revenue: StmtSection; costOfSales: StmtSection; grossProfit: number; expenses: StmtSection; netProfit: number; grossMarginPercent: number | null; netMarginPercent: number | null }

/** One statement section: a title row, its accounts, and the server's total. */
function StmtRows({ title, section, totalLabel, onAccount }: { title: string; section: StmtSection; totalLabel: string; onAccount: (id: string) => void }) {
  return (
    <>
      <tr className="acc-section-row"><th scope="rowgroup" colSpan={3}>{title}</th></tr>
      {section.lines.length === 0 && <tr><td colSpan={3} className="muted">لا توجد حركة</td></tr>}
      {section.lines.map((l) => <tr key={l.id}><td className="num">{l.code}</td><td><button type="button" className="link-button" onClick={() => onAccount(l.id)}>{l.name}</button></td><td className="end num">{money(l.amount)}</td></tr>)}
      <tr className="acc-subtotal-row"><td colSpan={2}>{totalLabel}</td><td className="end num">{money(section.total)}</td></tr>
    </>
  );
}

function IncomeStatement({ tenantId, onAccount, initialCostCenter = "" }: { tenantId: string; onAccount: (id: string) => void; initialCostCenter?: string }) {
  const p = usePeriod();
  const { can } = useTenant();
  const centers = useCostCenters(tenantId, can("cost_centers.view"));
  const [cc, setCc] = useState(initialCostCenter);
  const r = useQuery({ queryKey: ["t", tenantId, "accounting", "income", p.from, p.to, cc], placeholderData: keepPreviousData,
    queryFn: () => api<Income>("GET", "/t/accounting/income-statement", { tenant: tenantId, query: { from: p.from, to: p.to, costCenterId: cc } }) });
  const d = r.data;
  const empty = Boolean(d && !d.revenue.lines.length && !d.costOfSales.lines.length && !d.expenses.lines.length);
  const center = centers.data?.items.find((c) => c.id === cc);
  const controls = <>{p.range}{(centers.data?.items.length ?? 0) > 0 && (
    <select className="select" aria-label="مركز التكلفة" value={cc} onChange={(e) => setCc(e.target.value)}>
      <option value="">كل مراكز التكلفة</option>
      {centers.data!.items.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
    </select>
  )}</>;
  return (
    <ReportFrame title={center ? `قائمة الدخل لمركز ${center.name}` : "قائمة الدخل"} period={`من ${day(p.from)} إلى ${day(p.to)}`} controls={controls}
      summary={d && !empty && <div className="stats no-print">
        <StatCard label="الإيرادات" value={money(d.revenue.total)} icon={<TrendingUp />} hue="indigo" />
        <StatCard label="مجمل الربح" value={money(d.grossProfit)} note={`هامش ${percent(d.grossMarginPercent)}`} icon={<Scale />} hue="sky" />
        <StatCard label={d.netProfit < 0 ? "صافي الخسارة" : "صافي الربح"} value={money(d.netProfit)} note={`هامش ${percent(d.netMarginPercent)}`} noteTone={d.netProfit < 0 ? "warning" : undefined} icon={d.netProfit < 0 ? <TrendingDown /> : <FileChartColumn />} hue={d.netProfit < 0 ? "red" : "green"} />
      </div>}>
      <ReportState q={r} columns={3} empty={empty}>{() => d && (
        <div className="table-wrap">
          <table className="data-table acc-report acc-statement">
            <caption className="sr-only">قائمة الدخل من {day(p.from)} إلى {day(p.to)}</caption>
            <thead><tr><th scope="col">رقم الحساب</th><th scope="col">البيان</th><th scope="col" className="end">المبلغ</th></tr></thead>
            <tbody>
              <StmtRows title="الإيرادات" section={d.revenue} totalLabel="إجمالي الإيرادات" onAccount={onAccount} />
              <StmtRows title="تكلفة المبيعات" section={d.costOfSales} totalLabel="إجمالي تكلفة المبيعات" onAccount={onAccount} />
              <tr className="acc-result-row"><td colSpan={2}>مجمل الربح <span className="muted">(هامش {percent(d.grossMarginPercent)})</span></td><td className="end num">{money(d.grossProfit)}</td></tr>
              <StmtRows title="المصروفات التشغيلية" section={d.expenses} totalLabel="إجمالي المصروفات" onAccount={onAccount} />
            </tbody>
            <tfoot><tr><td colSpan={2}>{d.netProfit < 0 ? "صافي الخسارة" : "صافي الربح"} <span className="muted">(هامش {percent(d.netMarginPercent)})</span></td><td className="end num">{money(d.netProfit)}</td></tr></tfoot>
          </table>
        </div>
      )}</ReportState>
    </ReportFrame>
  );
}

interface Bs { asOf: string; assets: StmtSection; liabilities: StmtSection; equity: StmtSection & { currentEarnings: number }; liabilitiesAndEquity: number; balanced: boolean }

function BalanceSheet({ tenantId, onAccount }: { tenantId: string; onAccount: (id: string) => void }) {
  const [asOf, setAsOf] = useState(isoDay());
  const r = useQuery({ queryKey: ["t", tenantId, "accounting", "balance", asOf], placeholderData: keepPreviousData,
    queryFn: () => api<Bs>("GET", "/t/accounting/balance-sheet", { tenant: tenantId, query: { asOf } }) });
  const d = r.data;
  const empty = Boolean(d && !d.assets.lines.length && !d.liabilities.lines.length && !d.equity.lines.length && !d.equity.currentEarnings);
  return (
    <ReportFrame title="قائمة المركز المالي" period={`كما في ${day(asOf)}`}
      controls={<label className="row"><span className="field-label">كما في</span><input type="date" className="input acc-date" value={asOf} max={isoDay()} onChange={(e) => e.target.value && setAsOf(e.target.value)} /></label>}
      summary={d && !empty && (d.balanced
        ? <p className="banner banner-info ca-banner no-print">الأصول تساوي الخصوم وحقوق الملكية: {money(d.assets.total)}</p>
        : <p className="banner banner-danger ca-banner no-print">المركز المالي غير متوازن. راجع ميزان المراجعة وأبلغ الدعم إن استمر.</p>)}>
      <ReportState q={r} columns={3} empty={empty}>{() => d && (
        <div className="acc-bs">
          <div className="table-wrap">
            <table className="data-table acc-report acc-statement">
              <caption className="sr-only">الأصول كما في {day(asOf)}</caption>
              <thead><tr><th scope="col">رقم الحساب</th><th scope="col">الأصول</th><th scope="col" className="end">المبلغ</th></tr></thead>
              <tbody>{d.assets.lines.map((l) => <tr key={l.id}><td className="num">{l.code}</td><td><button type="button" className="link-button" onClick={() => onAccount(l.id)}>{l.name}</button></td><td className="end num">{money(l.amount)}</td></tr>)}</tbody>
              <tfoot><tr><td colSpan={2}>إجمالي الأصول</td><td className="end num">{money(d.assets.total)}</td></tr></tfoot>
            </table>
          </div>
          <div className="table-wrap">
            <table className="data-table acc-report acc-statement">
              <caption className="sr-only">الخصوم وحقوق الملكية كما في {day(asOf)}</caption>
              <thead><tr><th scope="col">رقم الحساب</th><th scope="col">الخصوم وحقوق الملكية</th><th scope="col" className="end">المبلغ</th></tr></thead>
              <tbody>
                <StmtRows title="الخصوم" section={d.liabilities} totalLabel="إجمالي الخصوم" onAccount={onAccount} />
                <tr className="acc-section-row"><th scope="rowgroup" colSpan={3}>حقوق الملكية</th></tr>
                {d.equity.lines.map((l) => <tr key={l.id}><td className="num">{l.code}</td><td><button type="button" className="link-button" onClick={() => onAccount(l.id)}>{l.name}</button></td><td className="end num">{money(l.amount)}</td></tr>)}
                <tr><td /><td>أرباح (خسائر) لم تُقفل بعد <span className="muted">(الإيرادات ناقص المصروفات حتى تاريخه)</span></td><td className="end num">{money(d.equity.currentEarnings)}</td></tr>
                <tr className="acc-subtotal-row"><td colSpan={2}>إجمالي حقوق الملكية</td><td className="end num">{money(d.equity.total)}</td></tr>
              </tbody>
              <tfoot><tr><td colSpan={2}>إجمالي الخصوم وحقوق الملكية</td><td className="end num">{money(d.liabilitiesAndEquity)}</td></tr></tfoot>
            </table>
          </div>
        </div>
      )}</ReportState>
    </ReportFrame>
  );
}

interface LedgerData { account: { id: string; code: string; name: string; type: AccountType }; opening: number; closing: number; lines: { entryId: string; entryNumber: number; date: string; description: string; sourceType: string; memo: string | null; partner: string | null; debit: number; credit: number; balance: number }[] }

function Ledger({ tenantId, accountId, setAccountId }: { tenantId: string; accountId: string; setAccountId: (id: string) => void }) {
  const p = usePeriod();
  const accounts = useAccounts(tenantId);
  const r = useQuery({ enabled: Boolean(accountId), queryKey: ["t", tenantId, "accounting", "ledger", accountId, p.from, p.to], placeholderData: keepPreviousData,
    queryFn: () => api<LedgerData>("GET", "/t/accounting/ledger", { tenant: tenantId, query: { accountId, from: p.from, to: p.to } }) });
  const d = r.data;
  const list = accounts.data?.items ?? [];
  return (
    <ReportFrame title={d ? `دفتر الأستاذ: ${accountLabel(d.account)}` : "دفتر الأستاذ"} period={`من ${day(p.from)} إلى ${day(p.to)}`}
      controls={<>
        <label className="row"><span className="field-label">الحساب</span>
          <select className="select acc-account-select" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">اختر الحساب</option>{list.map((a) => <option key={a.id} value={a.id}>{accountLabel(a)}{a.isGroup ? " (رئيسي: يشمل فروعه)" : ""}</option>)}
          </select>
        </label>
        {p.range}
      </>}>
      {!accountId ? <EmptyState title="اختر حساباً لعرض حركته">يظهر الرصيد الافتتاحي وكل قيد على الحساب في الفترة ورصيده بعد كل حركة.</EmptyState> : (
        <ReportState q={r} columns={6} empty={false}>{() => d && (
          <div className="table-wrap">
            <table className="data-table acc-report">
              <caption className="sr-only">دفتر أستاذ {accountLabel(d.account)}</caption>
              <thead><tr><th scope="col">التاريخ</th><th scope="col">القيد</th><th scope="col">البيان</th><th scope="col" className="end">مدين</th><th scope="col" className="end">دائن</th><th scope="col" className="end">الرصيد</th></tr></thead>
              <tbody>
                <tr className="acc-subtotal-row"><td>{day(p.from)}</td><td colSpan={4}>رصيد افتتاحي</td><td className="end num">{money(d.opening)}</td></tr>
                {d.lines.length === 0 && <tr><td colSpan={6} className="muted">لا توجد حركة على الحساب في هذه الفترة.</td></tr>}
                {d.lines.map((l, i) => (
                  <tr key={`${l.entryId}-${i}`}>
                    <td>{day(l.date)}</td>
                    <td><Link to={`/w/${tenantId}/accounting/journal/${l.entryId}`} className="num">{l.entryNumber}</Link></td>
                    <td className="wrap">{l.description}{l.memo && <span className="muted"> · {l.memo}</span>}{l.partner && <span className="muted"> · {l.partner}</span>}</td>
                    <td className="end num">{signedDr(l.debit)}</td>
                    <td className="end num">{signedDr(l.credit)}</td>
                    <td className="end num">{money(l.balance)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr><td colSpan={5}>الرصيد الختامي</td><td className="end num">{money(d.closing)}</td></tr></tfoot>
            </table>
          </div>
        )}</ReportState>
      )}
    </ReportFrame>
  );
}

interface AgingRow { partnerId: string; name: string; current: number; d1_30: number; d31_60: number; d61_90: number; over90: number; unapplied: number; total: number }

function Aging({ tenantId }: { tenantId: string }) {
  const [kind, setKind] = useState<"receivable" | "payable">("receivable");
  const [asOf, setAsOf] = useState(isoDay());
  const r = useQuery({ queryKey: ["t", tenantId, "accounting", "aging", kind, asOf], placeholderData: keepPreviousData,
    queryFn: () => api<{ items: AgingRow[]; totals: Omit<AgingRow, "partnerId" | "name"> }>("GET", "/t/accounting/aging", { tenant: tenantId, query: { kind, asOf } }) });
  const cols: [keyof Omit<AgingRow, "partnerId" | "name">, string][] = [["current", "الحالي"], ["d1_30", "1–30 يوماً"], ["d31_60", "31–60 يوماً"], ["d61_90", "61–90 يوماً"], ["over90", "أكثر من 90 يوماً"], ["unapplied", "دفعات غير مخصصة"], ["total", "الرصيد"]];
  const title = kind === "receivable" ? "أعمار ذمم العملاء" : "أعمار ذمم الموردين";
  return (
    <ReportFrame title={title} period={`كما في ${day(asOf)}`}
      controls={<>
        <div className="segmented acc-segmented" role="group" aria-label="نوع الذمم">
          <button type="button" aria-pressed={kind === "receivable"} onClick={() => setKind("receivable")}>العملاء (مدينون)</button>
          <button type="button" aria-pressed={kind === "payable"} onClick={() => setKind("payable")}>الموردون (دائنون)</button>
        </div>
        <label className="row"><span className="field-label">كما في</span><input type="date" className="input acc-date" value={asOf} max={isoDay()} onChange={(e) => e.target.value && setAsOf(e.target.value)} /></label>
      </>}>
      {r.isError ? <ErrorState error={r.error} onRetry={() => r.refetch()} /> : !r.data ? <TableSkeleton columns={8} rows={5} label="جارٍ تحميل التقرير…" /> : r.data.items.length === 0 ? (
        <EmptyState kind="done" title={kind === "receivable" ? "لا توجد مبالغ مستحقة على العملاء" : "لا توجد مبالغ مستحقة للموردين"}>تُحسب الأعمار من قيود حساب {kind === "receivable" ? "العملاء" : "الموردين"} المرتبطة باسم العميل أو المورد.</EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="data-table acc-report">
            <caption className="sr-only">{title} كما في {day(asOf)}</caption>
            <thead><tr><th scope="col">{kind === "receivable" ? "العميل" : "المورد"}</th>{cols.map(([k, l]) => <th key={k} scope="col" className="end">{l}</th>)}</tr></thead>
            <tbody>{r.data.items.map((x) => (
              <tr key={x.partnerId}>
                <td>{kind === "payable" ? <Link to={`/w/${tenantId}/payables/${x.partnerId}`}><strong>{x.name}</strong></Link> : <strong>{x.name}</strong>}</td>
                {cols.map(([k]) => <td key={k} className="end num">{k === "total" ? <strong>{money(x[k])}</strong> : signedDr(x[k])}</td>)}
              </tr>
            ))}</tbody>
            <tfoot><tr><td>الإجمالي</td>{cols.map(([k]) => <td key={k} className="end num">{money(r.data!.totals[k])}</td>)}</tr></tfoot>
          </table>
        </div>
      )}
    </ReportFrame>
  );
}

interface VatBox { no: number; label: string; amount: number; adjustment: number; vat: number | null }
interface VatReturnData { sales: VatBox[]; salesTotal: VatBox; purchases: VatBox[]; purchasesTotal: VatBox; vatDue: number; notes: string[] }

/** Previous calendar month and quarter, the usual VAT return periods. */
function returnPeriods() {
  const t = isoDay();
  const y = Number(t.slice(0, 4)), m = Number(t.slice(5, 7));
  const iso = (yy: number, mm: number) => `${yy}-${String(mm).padStart(2, "0")}-01`;
  const prevMonth = m === 1 ? iso(y - 1, 12) : iso(y, m - 1);
  const q = Math.floor((m - 1) / 3); // current quarter 0..3
  const prevQ = q === 0 ? iso(y - 1, 10) : iso(y, q * 3 - 2);
  return { month: [prevMonth, addDays(monthStart(), -1)] as [string, string], quarter: [prevQ, addDays(q === 0 ? `${y}-01-01` : iso(y, q * 3 + 1), -1)] as [string, string] };
}

function VatReturn({ tenantId }: { tenantId: string }) {
  const periods = returnPeriods();
  const p = usePeriod(periods.month);
  const r = useQuery({ queryKey: ["t", tenantId, "accounting", "vat-return", p.from, p.to], placeholderData: keepPreviousData,
    queryFn: () => api<VatReturnData>("GET", "/t/accounting/vat-return", { tenant: tenantId, query: { from: p.from, to: p.to } }) });
  const d = r.data;
  const row = (b: VatBox, total?: boolean) => (
    <tr key={b.no} className={total ? "acc-subtotal-row" : undefined}>
      <td className="num acc-box-no">{b.no}</td><td>{b.label}</td>
      <td className="end num">{money(b.amount)}</td><td className="end num">{money(b.adjustment)}</td><td className="end num">{b.vat === null ? "—" : money(b.vat)}</td>
    </tr>
  );
  const quick = (label: string, [f, t]: [string, string]) => <button type="button" className={`btn btn-sm ${p.from === f && p.to === t ? "btn-secondary" : "btn-ghost"}`} aria-pressed={p.from === f && p.to === t} onClick={() => p.set(f, t)}>{label}</button>;
  return (
    <ReportFrame title="إقرار ضريبة القيمة المضافة (ورقة عمل)" period={`من ${day(p.from)} إلى ${day(p.to)}`}
      controls={<>{quick("الشهر السابق", periods.month)}{quick("الربع السابق", periods.quarter)}{p.range}</>}>
      <ReportState q={r} columns={5} empty={false}>{() => d && (
        <>
          <div className="table-wrap">
            <table className="data-table acc-report acc-vat">
              <caption className="sr-only">إقرار ضريبة القيمة المضافة من {day(p.from)} إلى {day(p.to)}</caption>
              <thead><tr><th scope="col">البند</th><th scope="col">البيان</th><th scope="col" className="end">المبلغ ({RIYAL})</th><th scope="col" className="end">مبلغ التعديل ({RIYAL})</th><th scope="col" className="end">مبلغ ضريبة القيمة المضافة ({RIYAL})</th></tr></thead>
              <tbody>
                <tr className="acc-section-row"><th scope="rowgroup" colSpan={5}>ضريبة القيمة المضافة على المبيعات</th></tr>
                {d.sales.map((b) => row(b))}
                {row(d.salesTotal, true)}
                <tr className="acc-section-row"><th scope="rowgroup" colSpan={5}>ضريبة القيمة المضافة على المشتريات</th></tr>
                {d.purchases.map((b) => row(b))}
                {row(d.purchasesTotal, true)}
                <tr className="acc-section-row"><th scope="rowgroup" colSpan={5}>صافي الضريبة</th></tr>
                <tr className="acc-result-row"><td className="num acc-box-no">13</td><td>إجمالي ضريبة القيمة المضافة المستحقة عن الفترة الحالية</td><td colSpan={2} /><td className="end num">{money(d.vatDue)}</td></tr>
                <tr><td className="num acc-box-no">14</td><td>تصحيحات من الفترات السابقة (بين ±5,000 ريال)</td><td colSpan={3} className="end muted">تُستكمل في بوابة الهيئة</td></tr>
                <tr><td className="num acc-box-no">15</td><td>ضريبة القيمة المضافة التي تم ترحيلها من الفترة أو الفترات السابقة</td><td colSpan={3} className="end muted">تُستكمل في بوابة الهيئة</td></tr>
                <tr><td className="num acc-box-no">16</td><td>صافي الضريبة المستحقة (أو المستردة)</td><td colSpan={3} className="end muted">تُستكمل في بوابة الهيئة</td></tr>
              </tbody>
            </table>
          </div>
          {d.notes.length > 0 && <ul className="acc-notes">{d.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
        </>
      )}</ReportState>
    </ReportFrame>
  );
}

// ── Accounting settings ─────────────────────────────────────────────────────────────────────────
interface TaxProfileData {
  vatNumber: string; companyName: string;
  profile: { legalName: string; crNumber: string | null; street: string; buildingNo: string; additionalNo: string | null; district: string; city: string; postalCode: string; updatedAt: string } | null;
  suggested: { legalName: string; city: string | null };
}

export function AccountingSettingsPage() {
  const { tenantId, can } = useTenant();
  const summary = useSummary(tenantId);
  const canManage = can("acc_settings.manage");
  return (
    <div className="page ca-page-narrow">
      <PageHeader eyebrow="الحسابات" title="إعدادات المحاسبة" description="بيانات البائع في الفواتير الضريبية، وإقفال الفترات والسنة، وتسوية الضريبة، وربط فئات المصروفات بالحسابات." />
      <TaxProfileSection tenantId={tenantId} />
      {canManage && summary.data && summary.data.unposted.length > 0 && <UnpostedCallout tenantId={tenantId} items={summary.data.unposted} />}
      {canManage ? <>
        <FiscalYearSection tenantId={tenantId} canManage />
        <PeriodLockSection tenantId={tenantId} lockDate={summary.data?.lockDate ?? null} loading={summary.isPending} />
        <VatSettlementSection tenantId={tenantId} />
        <YearCloseSection tenantId={tenantId} />
      </> : <>
        <FiscalYearSection tenantId={tenantId} canManage={false} />
        <p className="banner banner-info ca-banner">إقفال الفترات والسنة وتسوية الضريبة وربط الحسابات تحتاج صلاحية «إدارة المحاسبة».</p>
      </>}
      <ExpenseMappingSection tenantId={tenantId} canManage={canManage} />
    </div>
  );
}

function TaxProfileSection({ tenantId }: { tenantId: string }) {
  const q = useQuery({ queryKey: ["t", tenantId, "accounting", "tax-profile"], queryFn: () => api<TaxProfileData>("GET", "/t/accounting/tax-profile", { tenant: tenantId }) });
  return (
    <section className="panel" aria-labelledby="tax-profile-h">
      <div className="card-head"><h2 id="tax-profile-h">البيانات الضريبية للمنشأة</h2></div>
      <div className="card-body stack-lg">
        {q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data ? <Skeleton height={160} /> : <TaxProfileForm key={q.data.profile?.updatedAt ?? "new"} tenantId={tenantId} data={q.data} />}
      </div>
    </section>
  );
}

function TaxProfileForm({ tenantId, data }: { tenantId: string; data: TaxProfileData }) {
  const { can, writable } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const form = useRef<HTMLFormElement>(null);
  const p = data.profile;
  const [v, setV] = useState({
    legalName: p?.legalName ?? data.suggested.legalName, crNumber: p?.crNumber ?? "", street: p?.street ?? "", buildingNo: p?.buildingNo ?? "",
    additionalNo: p?.additionalNo ?? "", district: p?.district ?? "", city: p?.city ?? data.suggested.city ?? "", postalCode: p?.postalCode ?? "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const canEdit = can("acc_settings.tax_profile") && writable;
  const set = (patch: Partial<typeof v>) => setV({ ...v, ...patch });
  async function save() {
    const e: Record<string, string> = {};
    if (v.legalName.trim().length < 2) e.legalName = "أدخل الاسم النظامي للمنشأة";
    if (v.crNumber.trim() && !/^[0-9]{10}$/.test(v.crNumber.trim())) e.crNumber = "رقم السجل التجاري 10 أرقام";
    if (v.street.trim().length < 2) e.street = "أدخل اسم الشارع";
    if (!/^[0-9]{4}$/.test(v.buildingNo.trim())) e.buildingNo = "رقم المبنى 4 أرقام";
    if (v.additionalNo.trim() && !/^[0-9]{4}$/.test(v.additionalNo.trim())) e.additionalNo = "الرقم الإضافي 4 أرقام";
    if (v.district.trim().length < 2) e.district = "أدخل الحي";
    if (v.city.trim().length < 2) e.city = "أدخل المدينة";
    if (!/^[0-9]{5}$/.test(v.postalCode.trim())) e.postalCode = "الرمز البريدي 5 أرقام";
    setErrors(e);
    if (Object.keys(e).length) return focusFirstInvalid(form.current);
    setBusy(true); setError(null);
    try {
      await api("PUT", "/t/accounting/tax-profile", { tenant: tenantId, body: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x.trim() || null])) });
      toast.success("تم حفظ البيانات الضريبية للمنشأة");
      await invalidate("accounting");
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fieldErrors);
      setError(err);
    } finally { setBusy(false); }
  }
  return (
    <form ref={form} noValidate className="stack-lg" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <p className="muted acc-small">تظهر في خانة البائع في كل فاتورة ضريبية (الاسم النظامي والعنوان الوطني)، وهي مطلوبة قبل إصدار أول فاتورة.</p>
      {!p && <p className="banner banner-warning ca-banner">لم تُحفظ بعد: لا يمكن إصدار فواتير ضريبية حتى تُستكمل.</p>}
      <dl className="dl"><dt>الرقم الضريبي</dt><dd className="num">{data.vatNumber}</dd></dl>
      <div className="form-grid">
        <TextField label="الاسم النظامي للمنشأة" required disabled={!canEdit} value={v.legalName} onChange={(e) => set({ legalName: e.target.value })} error={errors.legalName} hint="كما في السجل التجاري." />
        <TextField label="رقم السجل التجاري" optional disabled={!canEdit} dir="ltr" inputMode="numeric" maxLength={10} value={v.crNumber} onChange={(e) => set({ crNumber: e.target.value })} error={errors.crNumber} />
      </div>
      <h3 className="rs-b2b-sub">العنوان الوطني</h3>
      <div className="form-grid">
        <TextField label="الشارع" required disabled={!canEdit} value={v.street} onChange={(e) => set({ street: e.target.value })} error={errors.street} />
        <TextField label="رقم المبنى" required disabled={!canEdit} dir="ltr" inputMode="numeric" maxLength={4} value={v.buildingNo} onChange={(e) => set({ buildingNo: e.target.value })} error={errors.buildingNo} hint="4 أرقام" />
        <TextField label="الرقم الإضافي" optional disabled={!canEdit} dir="ltr" inputMode="numeric" maxLength={4} value={v.additionalNo} onChange={(e) => set({ additionalNo: e.target.value })} error={errors.additionalNo} hint="4 أرقام" />
        <TextField label="الحي" required disabled={!canEdit} value={v.district} onChange={(e) => set({ district: e.target.value })} error={errors.district} />
        <TextField label="المدينة" required disabled={!canEdit} value={v.city} onChange={(e) => set({ city: e.target.value })} error={errors.city} />
        <TextField label="الرمز البريدي" required disabled={!canEdit} dir="ltr" inputMode="numeric" maxLength={5} value={v.postalCode} onChange={(e) => set({ postalCode: e.target.value })} error={errors.postalCode} hint="5 أرقام" />
      </div>
      <FormError error={error} />
      {canEdit ? <div className="row"><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">حفظ البيانات الضريبية</Button>{p && <span className="muted acc-small">آخر تحديث {dayTime(p.updatedAt)}</span>}</div>
        : <p className="muted acc-small">يعدّلها من يملك صلاحية «إعدادات المنشأة». الفواتير المصدرة سابقاً تحتفظ بالبيانات التي صدرت بها.</p>}
    </form>
  );
}

const MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
interface Fiscal { startMonth: number; year: number; currentYear: number; from: string; to: string; lockDate: string | null; yearClosed: boolean; periods: { index: number; from: string; to: string; status: "open" | "closed" | "future" }[] }
function useFiscal(tenantId: string, year?: number) {
  return useQuery({ queryKey: ["t", tenantId, "accounting", "fiscal", year ?? "current"], placeholderData: keepPreviousData,
    queryFn: () => api<Fiscal>("GET", "/t/accounting/fiscal", { tenant: tenantId, query: { year } }) });
}
/** Same rule as the server: a fiscal year is named by the calendar year it ends in. */
function fiscalRange(year: number, startMonth: number): [string, string] {
  if (startMonth === 1) return [`${year}-01-01`, `${year}-12-31`];
  const pad = (n: number) => String(n).padStart(2, "0");
  const last = new Date(Date.UTC(year, startMonth - 1, 0)).getUTCDate();
  return [`${year - 1}-${pad(startMonth)}-01`, `${year}-${pad(startMonth - 1)}-${pad(last)}`];
}

/** When the fiscal year starts, and the state of its twelve periods (closed = inside the lock date). */
function FiscalYearSection({ tenantId, canManage }: { tenantId: string; canManage: boolean }) {
  const { writable } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [year, setYear] = useState<number | undefined>(undefined);
  const f = useFiscal(tenantId, year);
  const [month, setMonth] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const d = f.data;
  const chosen = month || String(d?.startMonth ?? 1);
  async function save() {
    setBusy(true); setError(null);
    try {
      await api("PUT", "/t/accounting/fiscal", { tenant: tenantId, body: { startMonth: Number(chosen) } });
      toast.success(`تبدأ السنة المالية الآن في ${MONTHS[Number(chosen) - 1]}`);
      setMonth("");
      await invalidate("accounting");
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  const label: Record<string, [string, "success" | "neutral" | "info"]> = { closed: ["مقفلة", "neutral"], open: ["مفتوحة", "success"], future: ["لم تبدأ", "info"] };
  return (
    <section className="panel" aria-labelledby="fiscal-h">
      <div className="card-head"><span className="ca-head-icon tone-indigo" aria-hidden="true"><CalendarClock /></span><h2 id="fiscal-h">السنة المالية وفتراتها</h2></div>
      <div className="card-body stack-lg">
        {f.isError ? <ErrorState error={f.error} onRetry={() => f.refetch()} /> : !d ? <Skeleton height={120} /> : <>
          <p className="muted acc-small">تُسمّى السنة المالية بالسنة التي تنتهي فيها. الفترات أشهرها الاثنا عشر، وتُقفل الفترة حين يصل تاريخ الإقفال إلى آخر يوم فيها.</p>
          <div className="row acc-inline-form">
            <SelectField label="تبدأ السنة المالية في" required disabled={!canManage || !writable || Boolean(d.lockDate)} value={chosen} onChange={(e) => setMonth(e.target.value)}
              options={MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))}
              hint={d.lockDate ? "ثابتة بعد إقفال أول فترة." : "مثال: يوليو لسنة تنتهي في 30 يونيو."} />
            {canManage && !d.lockDate && Number(chosen) !== d.startMonth && <Button variant="primary" loading={busy} loadingText="جارٍ الحفظ…" onClick={() => void save()}>حفظ بداية السنة</Button>}
            <SelectField label="عرض السنة" value={String(d.year)} onChange={(e) => setYear(Number(e.target.value))}
              options={[d.currentYear + 1, d.currentYear, d.currentYear - 1, d.currentYear - 2].map((y) => ({ value: String(y), label: `${y}${y === d.currentYear ? " (الحالية)" : ""}` }))} />
          </div>
          {error && <p className="field-error" role="alert">{error}</p>}
          <p>السنة المالية <strong className="num">{d.year}</strong>: من {day(d.from)} إلى {day(d.to)} {d.yearClosed && <Badge tone="neutral">مقفلة</Badge>}</p>
          <div className="table-wrap">
            <table className="data-table">
              <caption className="sr-only">فترات السنة المالية {d.year}</caption>
              <thead><tr><th scope="col">الفترة</th><th scope="col">من</th><th scope="col">إلى</th><th scope="col">الحالة</th></tr></thead>
              <tbody>{d.periods.map((p) => (
                <tr key={p.index}><td className="num">{p.index}</td><td>{day(p.from)}</td><td>{day(p.to)}</td><td><Badge tone={label[p.status]![1]}>{label[p.status]![0]}</Badge></td></tr>
              ))}</tbody>
            </table>
          </div>
        </>}
      </div>
    </section>
  );
}

function PeriodLockSection({ tenantId, lockDate, loading }: { tenantId: string; lockDate: string | null; loading: boolean }) {
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [date, setDate] = useState(addDays(monthStart(), -1));
  const [confirm, setConfirm] = useState<"lock" | "unlock" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const yesterday = addDays(isoDay(), -1);
  async function apply(value: string | null) {
    setBusy(true); setError(null);
    try {
      await api("PUT", "/t/accounting/lock", { tenant: tenantId, body: { lockDate: value } });
      toast.success(value ? `أُقفلت الفترة حتى ${day(value)}` : "أُلغي إقفال الفترات");
      await invalidate("accounting");
      setConfirm(null);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <section className="panel" aria-labelledby="lock-h">
      <div className="card-head"><span className="ca-head-icon tone-sky" aria-hidden="true"><CalendarClock /></span><h2 id="lock-h">إقفال الفترة</h2></div>
      <div className="card-body stack-lg">
        <p className="muted acc-small">بعد الإقفال لا يُقبل أي قيد أو عملية مالية (بيع، شراء، مصروف، قيد) بتاريخ في يوم الإقفال أو قبله، فتبقى التقارير المقدَّمة كما هي.</p>
        <dl className="dl"><dt>الإقفال الحالي</dt><dd>{loading ? <Skeleton width="120px" /> : lockDate ? day(lockDate) : "لا يوجد إقفال"}</dd></dl>
        <div className="row acc-inline-form">
          <TextField label="إقفال حتى تاريخ" type="date" required value={date} max={yesterday} onChange={(e) => setDate(e.target.value)} hint="قبل اليوم. عادةً آخر يوم في الشهر المقدَّم عنه الإقرار." />
          <Button variant="primary" disabled={!date || date > yesterday} onClick={() => { setError(null); setConfirm("lock"); }}>إقفال حتى هذا التاريخ</Button>
          {lockDate && <Button variant="ghost" destructive onClick={() => { setError(null); setConfirm("unlock"); }}>إلغاء الإقفال</Button>}
        </div>
      </div>
      <ConfirmDialog open={confirm === "lock"} onClose={() => setConfirm(null)} busy={busy} error={error} destructive={false} onConfirm={() => void apply(date)}
        title={`إقفال الفترة حتى ${day(date)}`} confirmLabel="إقفال الفترة"
        message={<>لن يُقبل أي قيد أو عملية مالية بتاريخ {day(date)} أو قبله. العمليات غير المرحّلة داخل الفترة تبقى خارج الدفاتر. يمكن تغيير التاريخ لاحقاً بصلاحية إدارة المحاسبة.</>} />
      <ConfirmDialog open={confirm === "unlock"} onClose={() => setConfirm(null)} busy={busy} error={error} onConfirm={() => void apply(null)}
        title="إلغاء إقفال الفترات" confirmLabel="فتح كل الفترات"
        message={<>ستُفتح الفترات المقفلة حتى {day(lockDate)} للتسجيل من جديد، فقد تتغير أرقام تقارير وإقرارات قُدّمت عنها.</>} />
    </section>
  );
}

function VatSettlementSection({ tenantId }: { tenantId: string }) {
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [key, renewKey] = useIdempotencyKey();
  const prev = returnPeriods().month;
  const [from, setFrom] = useState(prev[0]);
  const [to, setTo] = useState(prev[1]);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = Boolean(from && to && from <= to && to < isoDay());
  async function settle() {
    setBusy(true); setError(null);
    try {
      const r = await api<{ id: string; vatDue: number }>("POST", "/t/accounting/vat-settlement", { tenant: tenantId, idempotencyKey: key, body: { from, to } });
      renewKey();
      toast.success(r.vatDue >= 0 ? `تمت التسوية: ضريبة مستحقة للهيئة ${money(r.vatDue)}` : `تمت التسوية: رصيد لصالحك ${money(-r.vatDue)}`);
      await invalidate("accounting");
      setConfirming(false);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <section className="panel" aria-labelledby="vat-settle-h">
      <div className="card-head"><span className="ca-head-icon tone-amber" aria-hidden="true"><Percent /></span><h2 id="vat-settle-h">تسوية ضريبة القيمة المضافة</h2></div>
      <div className="card-body stack-lg">
        <p className="muted acc-small">بعد تقديم الإقرار: ينقل ضريبة المخرجات والمدخلات للفترة إلى حساب «ضريبة مستحقة الدفع» ليُسجَّل السداد عليه. لا تُسوّى الفترة نفسها مرتين.</p>
        <div className="row acc-inline-form">
          <TextField label="من" type="date" required value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          <TextField label="إلى" type="date" required value={to} min={from} max={addDays(isoDay(), -1)} onChange={(e) => setTo(e.target.value)} />
          <Button variant="secondary" disabled={!valid} onClick={() => { setError(null); setConfirming(true); }}>تسوية الفترة</Button>
        </div>
        <Link to={`/w/${tenantId}/accounting/reports?tab=vat`} className="btn btn-ghost btn-sm acc-self-start">مراجعة الإقرار قبل التسوية</Link>
      </div>
      <ConfirmDialog open={confirming} onClose={() => setConfirming(false)} busy={busy} error={error} destructive={false} onConfirm={() => void settle()}
        title={`تسوية الضريبة من ${day(from)} إلى ${day(to)}`} confirmLabel="ترحيل قيد التسوية"
        message="سيُرحَّل قيد تسوية بتاريخ نهاية الفترة. القيد لا يُعدَّل ولا يُعكس من هنا، والفترة لا تُسوّى مرة ثانية. راجع الإقرار أولاً." />
    </section>
  );
}

function YearCloseSection({ tenantId }: { tenantId: string }) {
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [key, renewKey] = useIdempotencyKey();
  const fiscal = useFiscal(tenantId);
  const startMonth = fiscal.data?.startMonth ?? 1;
  const current = fiscal.data?.currentYear ?? Number(isoDay().slice(0, 4));
  const years = Array.from({ length: 5 }, (_, i) => String(current - 1 - i));
  const [year, setYear] = useState(years[0]!);
  const [fyFrom, fyTo] = fiscalRange(Number(year), startMonth);
  const [typed, setTyped] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function close() {
    if (typed.trim() !== year) return setError(`اكتب ${year} كما هو للتأكيد`);
    setBusy(true); setError(null);
    try {
      const r = await api<{ id: string | null; netProfit: number; lockDate: string }>("POST", "/t/accounting/close-year", { tenant: tenantId, idempotencyKey: key, body: { year: Number(year) } });
      renewKey();
      toast.success(`أُقفلت سنة ${year}: ${r.netProfit >= 0 ? "صافي ربح" : "صافي خسارة"} ${money(Math.abs(r.netProfit))} رُحِّل إلى الأرباح المبقاة، والفترات مقفلة حتى ${day(r.lockDate)}`);
      await invalidate("accounting");
      setConfirming(false); setTyped("");
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <section className="panel" aria-labelledby="year-close-h">
      <div className="card-head"><span className="ca-head-icon tone-red" aria-hidden="true"><BookOpen /></span><h2 id="year-close-h">إقفال السنة المالية</h2></div>
      <div className="card-body stack-lg">
        <p className="muted acc-small">يصفّر حسابات الإيرادات والمصروفات للسنة وينقل صافي الربح أو الخسارة إلى الأرباح المبقاة، ثم يقفل كل الفترات حتى آخر يوم في السنة. لا يمكن التراجع عنه.</p>
        <div className="row acc-inline-form">
          <SelectField label="السنة" required value={year} onChange={(e) => setYear(e.target.value)} options={years.map((y) => ({ value: y, label: y }))} hint={`من ${day(fyFrom)} إلى ${day(fyTo)}`} />
          <Button variant="ghost" destructive onClick={() => { setError(null); setTyped(""); setConfirming(true); }}>إقفال السنة…</Button>
        </div>
      </div>
      <ConfirmDialog open={confirming} onClose={() => setConfirming(false)} busy={busy} error={error} onConfirm={() => void close()}
        title={`إقفال السنة المالية ${year}`} confirmLabel={`إقفال سنة ${year} نهائياً`}
        message={<>سيُرحَّل صافي ربح أو خسارة {year} إلى الأرباح المبقاة، وتُصفَّر حسابات الإيرادات والمصروفات للسنة، وتُقفل كل الفترات حتى {day(fyTo)}. <strong>لا يمكن التراجع عن هذا الإجراء.</strong></>}>
        <TextField label={`اكتب ${year} للتأكيد`} required dir="ltr" inputMode="numeric" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
      </ConfirmDialog>
    </section>
  );
}

interface ExpenseCategoryMap { id: string; name: string; isActive: boolean; accountId: string | null; accountCode: string | null; accountName: string | null }

function ExpenseMappingSection({ tenantId, canManage }: { tenantId: string; canManage: boolean }) {
  const { writable } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const accounts = useAccounts(tenantId);
  const cats = useQuery({ queryKey: ["t", tenantId, "accounting", "expense-categories"], queryFn: () => api<{ items: ExpenseCategoryMap[] }>("GET", "/t/accounting/expense-categories", { tenant: tenantId }) });
  const [saving, setSaving] = useState<string | null>(null);
  const options = (accounts.data?.items ?? []).filter((a) => a.type === "expense" && !a.isGroup && a.isActive);
  const editable = canManage && writable;
  async function map(c: ExpenseCategoryMap, accountId: string) {
    setSaving(c.id);
    try {
      await api("PUT", `/t/accounting/expense-categories/${c.id}`, { tenant: tenantId, body: { accountId } });
      const a = options.find((x) => x.id === accountId);
      toast.success(`فئة «${c.name}» تُرحَّل الآن إلى ${a ? accountLabel(a) : "الحساب المختار"}`);
      await invalidate("accounting");
    } catch (e) { toast.error(errorMessage(e)); } finally { setSaving(null); }
  }
  return (
    <section className="panel" aria-labelledby="exp-map-h">
      <DataTable caption="ربط فئات المصروفات بالحسابات" query={cats} rowKey={(c) => c.id}
        toolbar={<div className="stack acc-toolbar-title"><h2 id="exp-map-h">ربط فئات المصروفات بالحسابات</h2><span className="muted acc-small">المصروفات الجديدة من كل فئة تُرحَّل إلى الحساب المختار. القيود السابقة لا تتغير.</span></div>}
        empty={{ title: "لا توجد فئات مصروفات", body: "أضف الفئات من صفحة المصروفات أولاً." }}
        columns={[
          { key: "name", header: "الفئة", cell: (c) => <span className="acc-desc"><strong>{c.name}</strong>{!c.isActive && <Badge tone="neutral">موقوفة</Badge>}</span> },
          { key: "account", sortKey: "accountCode", header: "حساب المصروف", cell: (c) => (editable ? (
            <span className="row acc-map-cell">
              <select className="select" aria-label={`حساب فئة ${c.name}`} value={c.accountId ?? ""} disabled={saving === c.id || accounts.isPending} onChange={(e) => e.target.value && void map(c, e.target.value)}>
                {!c.accountId && <option value="">اختر حساباً</option>}
                {options.map((a) => <option key={a.id} value={a.id}>{accountLabel(a)}</option>)}
              </select>
              {saving === c.id && <span className="spinner" aria-hidden="true" />}
            </span>
          ) : c.accountCode ? `${c.accountCode} · ${c.accountName}` : "—") },
        ]} />
    </section>
  );
}
