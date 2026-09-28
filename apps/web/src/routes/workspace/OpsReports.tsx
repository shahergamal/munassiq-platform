import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Download, Factory, Gauge, Percent, ShieldCheck, TrendingDown, Users } from "lucide-react";
import { useState } from "react";
import { api, download } from "../../api/client";
import { Button } from "../../ui/Button";
import { useToast } from "../../ui/Toast";
import { useTenant } from "../../app/tenant";
import { addDays, integer, isoDay, money, percent, quantity } from "../../lib/format";
import { DataTable } from "../../ui/DataTable";
import { TextField } from "../../ui/Field";
import { Badge, PageHeader, StatCard } from "../../ui/Layout";
import { EmptyState, ErrorState, TableSkeleton } from "../../ui/States";

// M8 reports: production and costs, equipment effectiveness (OEE), payroll and GOSI. The server computes every
// figure; these pages choose the period and lay the numbers out.

const pct = (v: number | null | undefined) => (v === null || v === undefined ? "—" : percent(v * 100));
const Ref = ({ children }: { children: string }) => <bdi dir="ltr" className="num">{children}</bdi>;

/** The same report as an Excel workbook, built on the server. */
function ExcelButton({ path, file, range }: { path: string; file: string; range: { from: string; to: string } }) {
  const { tenantId } = useTenant();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return <Button icon={<Download />} loading={busy} loadingText="جارٍ التجهيز…" disabled={range.from > range.to} onClick={async () => {
    setBusy(true);
    try { await download(`${path}?from=${range.from}&to=${range.to}&format=xlsx`, tenantId, `${file}.xlsx`); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }}>تصدير Excel</Button>;
}

function Range({ from, to, onChange, month }: { from: string; to: string; onChange: (f: string, t: string) => void; month?: boolean }) {
  const max = month ? isoDay().slice(0, 7) : isoDay();
  return (
    <div className="toolbar panel sr-filter-bar">
      <TextField label="من" type={month ? "month" : "date"} dir="ltr" max={max} value={from} onChange={(e) => onChange(e.target.value || from, to)} />
      <TextField label="إلى" type={month ? "month" : "date"} dir="ltr" max={max} value={to} onChange={(e) => onChange(from, e.target.value || to)}
        error={from > to ? "البداية بعد النهاية" : undefined} />
    </div>
  );
}

// ── Production and costs ────────────────────────────────────────────────────────────────────────
interface ProdOrder { moId: string; number: number; itemName: string; unit: string; status: string; ordered: number; made: number; scrap: number; yield: number | null; standardUnitCost: number | null;
  closed: { produced: number; standardValue: number; actualValue: number; actualUnitCost: number | null; variance: number; price: number; usage: number; efficiency: number } | null }
interface ProdItem { itemId: string; itemName: string; unit: string; made: number; scrap: number; yield: number | null; orders: number; standardUnitCost: number | null; actualUnitCost: number | null; variancePct: number | null }
interface Prod { from: string; to: string; orders: ProdOrder[]; items: ProdItem[]; totals: { orders: number; closed: number; standardValue: number; actualValue: number; variance: number; price: number; usage: number; efficiency: number } }

export function ProductionReport() {
  const { tenantId } = useTenant();
  const [r, setR] = useState({ from: addDays(isoDay(), -29), to: isoDay() });
  const q = useQuery({ queryKey: ["t", tenantId, "reports", "production", r], enabled: r.from <= r.to,
    queryFn: () => api<Prod>("GET", "/t/reports/production", { tenant: tenantId, query: r }) });
  const d = q.data;
  const variance = (v: number) => <span className={v > 0 ? "text-danger" : v < 0 ? "text-success" : undefined}>{money(v)}</span>;
  return (
    <div className="page">
      <PageHeader eyebrow="التقارير" title="الإنتاج والتكاليف"
        description="ما أُنتج وما هُلك في الفترة، ولأوامر التشغيل المقفلة فيها: التكلفة الفعلية مقابل المعيارية وانحرافاتها (سعر المواد، كمياتها، كفاءة الوقت). الانحراف الموجب تكلفة زائدة."
        actions={<ExcelButton path="/t/reports/production" file={`production-${r.from}-${r.to}`} range={r} />} />
      <Range from={r.from} to={r.to} onChange={(from, to) => setR({ from, to })} />
      {q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !d ? <TableSkeleton columns={6} rows={4} label="جارٍ حساب التقرير…" /> : !d.orders.length
        ? <section className="panel"><EmptyState kind="filtered" title="لا إنتاج في هذه الفترة">وسّع الفترة، أو سجّل إنتاج أوامر التشغيل.</EmptyState></section> : <>
        <div className="stats">
          <StatCard label="أوامر في الفترة" value={integer(d.totals.orders)} icon={<Factory />} hue="indigo" note={`${integer(d.totals.closed)} مقفل`} />
          <StatCard label="الفعلي مقابل المعياري" value={money(d.totals.actualValue)} icon={<Gauge />} hue="sky" note={`المعياري ${money(d.totals.standardValue)} للأوامر المقفلة`} />
          <StatCard label="صافي الانحراف" value={money(d.totals.variance)} icon={<TrendingDown />} hue={d.totals.variance > 0 ? "red" : "green"}
            note={`سعر ${money(d.totals.price)} · كمية ${money(d.totals.usage)} · كفاءة ${money(d.totals.efficiency)}`} />
        </div>
        <section className="panel" aria-labelledby="pr-items">
          <div className="toolbar"><h2 id="pr-items">حسب المنتج</h2></div>
          <DataTable caption="الإنتاج حسب المنتج" query={{ ...q, data: { items: d.items } }} rowKey={(x) => x.itemId} empty={{ title: "—" }}
            columns={[
              { key: "itemName", header: "المنتج", cell: (x) => <strong>{x.itemName}</strong> },
              { key: "made", header: "المنتج الجيد", numeric: true, cell: (x) => `${quantity(x.made)} ${x.unit}` },
              { key: "scrap", header: "الهالك", numeric: true, cell: (x) => x.scrap ? quantity(x.scrap) : "—" },
              { key: "yield", header: "المردود", numeric: true, cell: (x) => pct(x.yield) },
              { key: "standardUnitCost", header: "تكلفة الوحدة المعيارية", numeric: true, cell: (x) => x.standardUnitCost === null ? "—" : money(x.standardUnitCost) },
              { key: "actualUnitCost", header: "الفعلية", numeric: true, cell: (x) => x.actualUnitCost === null ? "—" : money(x.actualUnitCost) },
              { key: "variancePct", header: "الفرق", numeric: true, cell: (x) => x.variancePct === null ? "—" : <Badge tone={x.variancePct > 0.02 ? "danger" : x.variancePct < -0.02 ? "success" : "neutral"}>{pct(x.variancePct)}</Badge> },
            ]} />
        </section>
        <section className="panel" aria-labelledby="pr-orders">
          <div className="toolbar"><h2 id="pr-orders">أوامر التشغيل</h2></div>
          <DataTable caption="أوامر التشغيل في الفترة" query={{ ...q, data: { items: d.orders } }} rowKey={(o) => o.moId} empty={{ title: "—" }}
            columns={[
              { key: "number", header: "الأمر", cell: (o) => <span><Link to={`/w/${tenantId}/manufacturing/orders/${o.moId}`}><Ref>{`MO-${o.number}`}</Ref></Link> · {o.itemName}</span> },
              { key: "made", header: "أُنتج في الفترة", numeric: true, cell: (o) => `${quantity(o.made)} من ${quantity(o.ordered)}` },
              { key: "scrap", header: "الهالك", numeric: true, cell: (o) => o.scrap ? quantity(o.scrap) : "—" },
              { key: "yield", header: "المردود", numeric: true, cell: (o) => pct(o.yield) },
              { key: "actual", header: "الفعلية / المعيارية", numeric: true, sortKey: false, cell: (o) => o.closed ? `${money(o.closed.actualValue)} / ${money(o.closed.standardValue)}` : <Badge tone="info">لم يُقفل</Badge> },
              { key: "variance", header: "سعر · كمية · كفاءة", numeric: true, sortKey: false, cell: (o) => o.closed ? <>{variance(o.closed.price)} · {variance(o.closed.usage)} · {variance(o.closed.efficiency)}</> : "—" },
            ]} />
        </section>
      </>}
    </div>
  );
}

// ── OEE ─────────────────────────────────────────────────────────────────────────────────────────
interface OeeRow { workCenterId: string; code: string; name: string; plannedMinutes: number; downtimeMinutes: number; runMinutes: number; standardMinutes: number; good: number; scrap: number;
  availability: number; performance: number; quality: number; oee: number; utilization: number }

export function OeeReport() {
  const { tenantId } = useTenant();
  const [r, setR] = useState({ from: addDays(isoDay(), -29), to: isoDay() });
  const q = useQuery({ queryKey: ["t", tenantId, "reports", "oee", r], enabled: r.from <= r.to,
    queryFn: () => api<{ days: number; items: OeeRow[] }>("GET", "/t/reports/oee", { tenant: tenantId, query: r }) });
  const tone = (v: number) => (v >= 0.85 ? "success" : v >= 0.6 ? "warning" : "danger") as "success" | "warning" | "danger";
  return (
    <div className="page">
      <PageHeader eyebrow="التقارير" title="كفاءة المعدات (OEE)"
        description="الجاهزية = (الوقت المخطط − توقف الصيانة) ÷ المخطط. الأداء = الدقائق المعيارية للإنتاج ÷ الدقائق المسجلة. الجودة = الجيد ÷ (الجيد + الهالك). الوقت المخطط ساعات مركز العمل × أيام الفترة (كل الأيام، بلا تقويم ورديات بعد)."
        actions={<ExcelButton path="/t/reports/oee" file={`oee-${r.from}-${r.to}`} range={r} />} />
      <Range from={r.from} to={r.to} onChange={(from, to) => setR({ from, to })} />
      <section className="panel" aria-label="كفاءة المعدات">
        <DataTable caption="كفاءة مراكز العمل" query={q} rowKey={(w) => w.workCenterId}
          empty={{ title: "لا مراكز عمل", body: "أضف مراكز العمل وسجّل الوقت والإنتاج على أوامر التشغيل." }}
          columns={[
            { key: "name", header: "مركز العمل", cell: (w) => <span className="stack-tight"><strong>{w.name}</strong><span className="muted num acc-small">{w.code}</span></span> },
            { key: "oee", header: "OEE", numeric: true, cell: (w) => w.runMinutes ? <Badge tone={tone(w.oee)}>{pct(w.oee)}</Badge> : <span className="muted">لم يعمل</span> },
            { key: "availability", header: "الجاهزية", numeric: true, cell: (w) => pct(w.availability) },
            { key: "performance", header: "الأداء", numeric: true, cell: (w) => w.runMinutes ? pct(w.performance) : "—" },
            { key: "quality", header: "الجودة", numeric: true, cell: (w) => w.good + w.scrap ? pct(w.quality) : "—" },
            { key: "downtimeMinutes", header: "التوقف", numeric: true, cell: (w) => w.downtimeMinutes ? `${quantity(w.downtimeMinutes / 60)} س` : "—" },
            { key: "utilization", header: "التحميل", numeric: true, cell: (w) => pct(w.utilization) },
          ]} />
      </section>
    </div>
  );
}

// ── Payroll ─────────────────────────────────────────────────────────────────────────────────────
interface PayAgg { headcount: number; gross: number; gosiEmployee: number; gosiEmployer: number; eosAccrual: number; deductions: number; net: number }
interface PayRep { months: (PayAgg & { period: string; status: string })[]; costCenters: (PayAgg & { name: string })[];
  gosi: { period: string; scheme: string; employees: number; base: number; employeePension: number; employeeSaned: number; employerPension: number; employerSaned: number; employerHazard: number }[] }
const SCHEME: Record<string, string> = { old: "سعودي · النظام القديم", new: "سعودي · النظام الجديد", non_saudi: "غير سعودي" };

export function PayrollReport() {
  const { tenantId } = useTenant();
  const now = isoDay().slice(0, 7);
  const [r, setR] = useState({ from: `${Number(now.slice(0, 4)) - 1}-${now.slice(5)}`, to: now });
  const q = useQuery({ queryKey: ["t", tenantId, "reports", "payroll", r], enabled: r.from <= r.to,
    queryFn: () => api<PayRep>("GET", "/t/reports/payroll", { tenant: tenantId, query: r }) });
  const d = q.data;
  const total = (k: keyof PayAgg) => (d?.months ?? []).reduce((a, m) => a + m[k], 0);
  return (
    <div className="page">
      <PageHeader eyebrow="التقارير" title="الرواتب والتأمينات"
        description="مجاميع المسيرات المعتمدة حسب الشهر ومركز التكلفة، وتقرير التأمينات الشهري بوعاء كل نظام وفروع الاشتراك (المعاشات، ساند، الأخطار) للسداد للمؤسسة."
        actions={<ExcelButton path="/t/reports/payroll" file={`payroll-${r.from}-${r.to}`} range={r} />} />
      <Range month from={r.from} to={r.to} onChange={(from, to) => setR({ from, to })} />
      {q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !d ? <TableSkeleton columns={6} rows={4} /> : !d.months.length
        ? <section className="panel"><EmptyState kind="filtered" title="لا مسيرات معتمدة في هذه الفترة" action={<Link to={`/w/${tenantId}/hr/payroll`} className="btn btn-secondary">مسير الرواتب</Link>}>اعتمد مسير الشهر ليظهر هنا.</EmptyState></section> : <>
        <div className="stats">
          <StatCard label="إجمالي الرواتب" value={money(total("gross"))} icon={<Users />} hue="indigo" note={`${integer(d.months.length)} شهر`} />
          <StatCard label="التأمينات (الحصتان)" value={money(total("gosiEmployee") + total("gosiEmployer"))} icon={<ShieldCheck />} hue="sky" note={`صاحب العمل ${money(total("gosiEmployer"))}`} />
          <StatCard label="مخصص نهاية الخدمة" value={money(total("eosAccrual"))} icon={<Percent />} hue="amber" />
        </div>
        <section className="panel" aria-labelledby="py-m">
          <div className="toolbar"><h2 id="py-m">حسب الشهر</h2></div>
          <DataTable caption="الرواتب حسب الشهر" query={{ ...q, data: { items: d.months } }} rowKey={(m) => m.period} empty={{ title: "—" }}
            columns={[
              { key: "period", header: "الشهر", cell: (m) => <><Ref>{m.period}</Ref> {m.status === "paid" ? <Badge tone="success">مصروف</Badge> : <Badge tone="info">معتمد</Badge>}</> },
              { key: "headcount", header: "الموظفون", numeric: true, cell: (m) => integer(m.headcount) },
              { key: "gross", header: "الإجمالي", numeric: true, cell: (m) => money(m.gross) },
              { key: "gosiEmployee", header: "تأمينات الموظفين", numeric: true, cell: (m) => money(m.gosiEmployee) },
              { key: "gosiEmployer", header: "تأمينات صاحب العمل", numeric: true, cell: (m) => money(m.gosiEmployer) },
              { key: "eosAccrual", header: "نهاية الخدمة", numeric: true, cell: (m) => money(m.eosAccrual) },
              { key: "net", header: "الصافي", numeric: true, cell: (m) => money(m.net) },
            ]} />
        </section>
        <section className="panel" aria-labelledby="py-c">
          <div className="toolbar"><h2 id="py-c">حسب مركز التكلفة</h2></div>
          <DataTable caption="الرواتب حسب مركز التكلفة" query={{ ...q, data: { items: d.costCenters } }} rowKey={(c) => c.name} empty={{ title: "—" }}
            columns={[
              { key: "name", header: "مركز التكلفة", cell: (c) => <strong>{c.name}</strong> },
              { key: "gross", header: "الإجمالي", numeric: true, cell: (c) => money(c.gross) },
              { key: "gosiEmployer", header: "تأمينات صاحب العمل", numeric: true, cell: (c) => money(c.gosiEmployer) },
              { key: "eosAccrual", header: "نهاية الخدمة", numeric: true, cell: (c) => money(c.eosAccrual) },
              { key: "cost", header: "التكلفة الكلية", numeric: true, sortKey: false, cell: (c) => money(c.gross + c.gosiEmployer + c.eosAccrual) },
            ]} />
        </section>
        <section className="panel" aria-labelledby="py-g">
          <div className="toolbar"><h2 id="py-g">التأمينات الاجتماعية</h2></div>
          <DataTable caption="تقرير التأمينات" query={{ ...q, data: { items: d.gosi } }} rowKey={(g) => `${g.period}-${g.scheme}`} empty={{ title: "—" }}
            columns={[
              { key: "period", header: "الشهر", cell: (g) => <Ref>{g.period}</Ref> },
              { key: "scheme", header: "الفئة", cell: (g) => SCHEME[g.scheme] ?? g.scheme },
              { key: "employees", header: "المشتركون", numeric: true, cell: (g) => integer(g.employees) },
              { key: "base", header: "الوعاء", numeric: true, cell: (g) => money(g.base) },
              { key: "pension", header: "المعاشات (موظف + منشأة)", numeric: true, sortKey: false, cell: (g) => `${money(g.employeePension)} + ${money(g.employerPension)}` },
              { key: "saned", header: "ساند", numeric: true, sortKey: false, cell: (g) => `${money(g.employeeSaned)} + ${money(g.employerSaned)}` },
              { key: "employerHazard", header: "الأخطار", numeric: true, cell: (g) => money(g.employerHazard) },
              { key: "due", header: "المستحق للمؤسسة", numeric: true, sortKey: false,
                cell: (g) => <strong>{money(g.employeePension + g.employerPension + g.employeeSaned + g.employerSaned + g.employerHazard)}</strong> },
            ]} />
        </section>
      </>}
    </div>
  );
}
