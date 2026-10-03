import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Calculator, Lock, Scale, TrendingDown } from "lucide-react";
import { useState } from "react";
import { api, errorMessage } from "../../api/client";
import { useInvalidate, useTenant } from "../../app/tenant";
import { integer, isoDay, money, percent } from "../../lib/format";
import { Button } from "../../ui/Button";
import { DataTable } from "../../ui/DataTable";
import { ConfirmDialog, Dialog } from "../../ui/Dialog";
import { SelectField, TextField } from "../../ui/Field";
import { Badge, PageHeader, StatCard } from "../../ui/Layout";
import { FormError } from "../../ui/States";
import { useToast } from "../../ui/Toast";

// Contracting C5: the work-in-progress schedule of the main contracts at a month end, the monthly close that books
// the contract asset/liability and the onerous provision, the estimated total cost, and the progress policy.
// The figures are computed by the server; the close is one server operation for all contracts.

interface WipRow { contractId: string; number: string; title: string; project: string; customer: string | null; costToDate: number; certifiedToDate: number; billedToDate: number;
  estimatedCost: number | null; error?: string; transactionPrice?: number; pct?: number; revenueToDate?: number; contractAsset?: number; contractLiability?: number;
  expectedLoss?: number; provision?: number; grossProfit?: number | null; backlog?: number; note?: string | null; lastClose: { period: string } | null; closedThisPeriod: boolean }
const lastMonth = () => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };
const Ref = ({ children }: { children: string }) => <bdi dir="ltr" className="num">{children}</bdi>;

export function ContractRevenuePage() {
  const { tenantId, can, writable } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [period, setPeriod] = useState(lastMonth());
  const q = useQuery({ queryKey: ["t", tenantId, "contracting", "wip", period],
    queryFn: () => api<{ period: string; method: "output" | "input"; items: WipRow[] }>("GET", "/t/contracting/wip", { tenant: tenantId, query: { period } }) });
  const settings = useQuery({ queryKey: ["t", tenantId, "contracting", "revenue-settings"],
    queryFn: () => api<{ method: "output" | "input"; closed: number }>("GET", "/t/contracting/revenue-settings", { tenant: tenantId }) });
  const [closing, setClosing] = useState(false);
  const [policy, setPolicy] = useState(false);
  const [estimating, setEstimating] = useState<WipRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const rows = q.data?.items ?? [];
  const sum = (k: keyof WipRow) => rows.reduce((a, r) => a + (typeof r[k] === "number" ? (r[k] as number) : 0), 0);
  const open = rows.filter((r) => !r.closedThisPeriod && !r.error);
  const blocked = rows.filter((r) => !r.closedThisPeriod && r.error);
  async function close() {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ closed: string[]; skipped: { number: string; reason: string }[] }>("POST", "/t/contracting/close", { tenant: tenantId, body: { period } });
      setClosing(false);
      if (r.skipped.length) toast.error(`أُقفل ${integer(r.closed.length)} عقد، وتعذّر ${r.skipped.map((s) => `${s.number}: ${s.reason}`).join("؛ ")}`);
      else toast.success(`أُقفل شهر ${period} لـ ${integer(r.closed.length)} عقد ورُحّلت القيود`);
      await invalidate("contracting");
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  const method = q.data?.method ?? settings.data?.method;
  return (
    <div className="page">
      <PageHeader eyebrow="المقاولات" title="الإيراد والأعمال تحت التنفيذ"
        description={<>الإيراد يُعترف به على مدى التنفيذ (المعيار 15، والقسم 23 للمنشآت الصغيرة): {method === "input" ? "بنسبة التكلفة المتكبدة إلى التكلفة الكلية المقدرة" : "بنسبة الأعمال المعتمدة إلى سعر المعاملة"}. الفرق عن المفوتر أصلُ عقد أو التزامُ عقد، والعقد المثقل تُثبت خسارته المتوقعة كاملة.</>}
        actions={<>
          {can("revenue.settings") && writable && <Button icon={<Scale />} onClick={() => setPolicy(true)}>سياسة القياس</Button>}
          {can("revenue.close") && writable && <Button variant="primary" icon={<Lock />} disabled={!open.length || !q.data}
            title={q.data && !open.length ? (rows.length && rows.every((r) => r.closedThisPeriod) ? "أُقفل هذا الشهر لكل العقود" : "لا عقد جاهز للإقفال: راجع التنبيهات في الجدول") : undefined}
            onClick={() => { setErr(null); setClosing(true); }}>إقفال {period}</Button>}
        </>} />
      <div className="toolbar row" style={{ gap: "var(--sp-2)" }}>
        <TextField label="الشهر" type="month" dir="ltr" value={period} max={isoDay().slice(0, 7)} onChange={(e) => e.target.value && setPeriod(e.target.value)} />
      </div>
      <div className="stats">
        <StatCard label="الإيراد حتى تاريخه" value={q.data ? money(sum("revenueToDate")) : "—"} icon={<Calculator />} hue="indigo" note={q.data ? `المفوتر ${money(sum("billedToDate"))}` : undefined} />
        <StatCard label="أصول العقود" value={q.data ? money(sum("contractAsset")) : "—"} icon={<Scale />} hue="sky" note="منفذ لم يُفوتر" />
        <StatCard label="التزامات العقود" value={q.data ? money(sum("contractLiability")) : "—"} icon={<Scale />} hue="violet" note="مفوتر قبل التنفيذ" />
        <StatCard label="مخصص العقود المثقلة" value={q.data ? money(sum("provision")) : "—"} icon={<TrendingDown />} hue={sum("provision") ? "red" : "green"} />
      </div>
      <section className="panel" aria-label="جدول الأعمال تحت التنفيذ">
        <DataTable caption={`الأعمال تحت التنفيذ في نهاية ${period}`} query={q} rowKey={(r) => r.contractId}
          empty={{ title: "لا عقود رئيسية مفعّلة", body: "يظهر هنا كل عقد رئيسي مفعّل بسعره وتكلفته ونسبة إنجازه وإيراده." }}
          columns={[
            { key: "number", header: "العقد", cell: (r) => <span className="stack-tight"><Link to="/w/$tenantId/contracting/contracts/$contractId" params={{ tenantId, contractId: r.contractId }}><Ref>{r.number}</Ref></Link>
              <span className="muted acc-small">{[r.project, r.customer].filter(Boolean).join(" · ")}</span>{r.closedThisPeriod && <Badge tone="success">مُقفل</Badge>}</span> },
            { key: "transactionPrice", header: "سعر المعاملة", numeric: true, cell: (r) => money(r.transactionPrice) },
            { key: "estimatedCost", header: "التكلفة المقدرة", numeric: true, cell: (r) => r.estimatedCost === null ? <span className="muted">—</span> : money(r.estimatedCost) },
            { key: "costToDate", header: "التكلفة حتى تاريخه", numeric: true, cell: (r) => money(r.costToDate) },
            { key: "pct", header: "الإنجاز", numeric: true, cell: (r) => r.error ? <Badge tone="warning">{r.error}</Badge> : percent((r.pct ?? 0) * 100) },
            { key: "revenueToDate", header: "الإيراد", numeric: true, cell: (r) => money(r.revenueToDate) },
            { key: "billedToDate", header: "المفوتر", numeric: true, cell: (r) => money(r.billedToDate) },
            { key: "contractAsset", header: "أصل / (التزام)", numeric: true, cell: (r) => r.error ? "—" : r.contractAsset ? money(r.contractAsset) : r.contractLiability ? `(${money(r.contractLiability)})` : money(0) },
            { key: "grossProfit", header: "مجمل الربح المتوقع", numeric: true, cell: (r) => r.grossProfit === undefined || r.grossProfit === null ? <span className="muted" title={r.note ?? undefined}>—</span>
              : r.grossProfit < 0 ? <span className="field-error">{money(r.grossProfit)}</span> : money(r.grossProfit) },
            { key: "backlog", header: "المتبقي من العقد", numeric: true, cell: (r) => money(r.backlog) },
          ]}
          actions={can("revenue.estimate") && writable ? (r) => <Button size="sm" variant="ghost" onClick={() => setEstimating(r)}>تقدير التكلفة</Button> : undefined} />
      </section>
      <ConfirmDialog open={closing} onClose={() => setClosing(false)} busy={busy} error={err ? errorMessage(err) : null} onConfirm={() => void close()} destructive={false}
        title={`إقفال شهر ${period}؟`} confirmLabel="إقفال الشهر وترحيل القيود"
        message={<>يُرحَّل لـ {integer(open.length)} عقد قيد بأصل أو التزام العقد ومخصص العقود المثقلة بتاريخ نهاية الشهر. الإقفال لا يُعدَّل، والشهور تُقفل بالترتيب، وتثبت بعده سياسة القياس.
          {blocked.length > 0 && <><br />لن يُقفل: {blocked.map((r) => `${r.number} (${r.error})`).join("؛ ")}.</>}</>} />
      {policy && settings.data && <PolicyDialog tenantId={tenantId} current={settings.data.method} locked={settings.data.closed > 0} onClose={() => setPolicy(false)} />}
      {estimating && <EstimateDialog tenantId={tenantId} row={estimating} onClose={() => setEstimating(null)} />}
    </div>
  );
}

function PolicyDialog({ tenantId, current, locked, onClose }: { tenantId: string; current: string; locked: boolean; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const [method, setMethod] = useState(current);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true); setError(null);
    try { await api("PUT", "/t/contracting/revenue-settings", { tenant: tenantId, body: { method } }); await invalidate("contracting"); onClose(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title="سياسة قياس الإنجاز"
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…" disabled={locked}>حفظ</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <SelectField label="الطريقة" required value={method} disabled={locked} onChange={(e) => setMethod(e.target.value)} options={[
        { value: "output", label: "المخرجات: الأعمال المعتمدة في المستخلصات ÷ سعر المعاملة" },
        { value: "input", label: "المدخلات: التكلفة المتكبدة ÷ التكلفة الكلية المقدرة" }]} />
      <p className="muted">{locked ? "أُقفلت شهور بهذه السياسة، فلا تتغير من هنا (تغيير سياسة محاسبية بأثر رجعي)." : "تُختار مرة قبل أول إقفال. طريقة المدخلات تحتاج تقدير التكلفة الكلية لكل عقد، وتكلفة المشروع كله تُنسب لعقده الرئيسي الوحيد."}</p>
      <FormError error={error} />
    </Dialog>
  );
}

function EstimateDialog({ tenantId, row, onClose }: { tenantId: string; row: WipRow; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [v, setV] = useState({ estimatedCost: row.estimatedCost ? String(row.estimatedCost) : "", asOf: isoDay(), note: "" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    const n = Number(v.estimatedCost.replace(/,/g, ""));
    if (!(n > 0)) return setError(new Error("أدخل تكلفة موجبة"));
    setBusy(true); setError(null);
    try {
      await api("POST", `/t/contracts/${row.contractId}/estimates`, { tenant: tenantId, body: { estimatedCost: n, asOf: v.asOf, note: v.note.trim() || null } });
      toast.success(`سُجّل تقدير ${row.number}`);
      await invalidate("contracting");
      onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title={`التكلفة الكلية المقدرة: ${row.number}`}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">تسجيل التقدير</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <p className="muted">التكلفة حتى تاريخه {money(row.costToDate)}. كل تقدير يُحفظ بتاريخه، والإقفال يأخذ أحدث تقدير حتى نهاية الشهر.</p>
      <div className="form-grid">
        <TextField label="التكلفة الكلية المقدرة (⃁)" required numeric inputMode="decimal" dir="ltr" value={v.estimatedCost} onChange={(e) => setV({ ...v, estimatedCost: e.target.value })} />
        <TextField label="بتاريخ" required type="date" dir="ltr" value={v.asOf} onChange={(e) => setV({ ...v, asOf: e.target.value })} />
      </div>
      <TextField label="سبب المراجعة" optional value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} maxLength={500} />
      <FormError error={error} />
    </Dialog>
  );
}
