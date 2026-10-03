import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { Activity, CalendarRange, Camera, Gauge, Upload, Wallet } from "lucide-react";
import { useState } from "react";
import { api, errorMessage } from "../../api/client";
import { useInvalidate, useTenant } from "../../app/tenant";
import { day, isoDay, money, percent } from "../../lib/format";
import { Button } from "../../ui/Button";
import { DataTable } from "../../ui/DataTable";
import { ConfirmDialog, Dialog } from "../../ui/Dialog";
import { TextField } from "../../ui/Field";
import { Badge, PageHeader, StatCard } from "../../ui/Layout";
import { FormError } from "../../ui/States";
import { useToast } from "../../ui/Toast";
import { StatusTabs } from "./Inventory";

// Contracting C9: a project's control room. The programme (from P6 / MS Project) with the site's progress, the budget
// per cost code against actual, commitments and forecast, earned value with the S-curve, and the cash-flow forecast.
// Every figure is the server's; the screen only shows it and sends progress, budgets and files.

interface Act { id: string; parentId: string | null; code: string; name: string; isSummary: boolean; depth: number; start: string | null; finish: string | null;
  budget: number; pctComplete: number; actualStart: string | null; actualFinish: string | null; late: boolean }
interface CostLine { costCodeId: string | null; costCode: string; costName: string; wbsId: string | null; wbs: string | null; budget: number; actual: number; committed: number; forecast: number; variance: number }
interface Evm { asOf: string; activities: number; budgeted: "activities" | "project" | "none"; bac: number; pv: number; ev: number; ac: number; sv: number; cv: number;
  spi: number | null; cpi: number | null; eac: number; etc: number; vac: number; tcpi: number | null; curve: { period: string; pv: number; ev: number | null; ac: number | null }[]; snapshots: string[] }
interface Flow { period: string; inflow: number; outflow: number; net: number; cumulative: number }
const Ref = ({ children }: { children: string }) => <bdi dir="ltr" className="num">{children}</bdi>;
const ratio = (v: number | null) => (v === null ? "—" : v.toFixed(2));
const lastMonth = () => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };

export function ProjectControlPage() {
  const { projectId } = useParams({ strict: false }) as { projectId: string };
  const { tenantId } = useTenant();
  const [tab, setTab] = useState("evm");
  const project = useQuery({ queryKey: ["t", tenantId, "contracting", "project", projectId],
    queryFn: () => api<{ name: string; code: string }>("GET", `/t/projects/${projectId}`, { tenant: tenantId }) });
  return (
    <div className="page">
      <PageHeader eyebrow="المشاريع" title={<>التحكم في المشروع{project.data && <>: {project.data.name} <Ref>{project.data.code}</Ref></>}</>}
        description="أين يقف المشروع من برنامجه وموازنته: الإنجاز من الموقع، والتكلفة من الدفاتر، والالتزامات من أوامر الشراء وعقود الباطن."
        actions={<Link to="/w/$tenantId/contracting/projects/$projectId" params={{ tenantId, projectId }} className="btn btn-ghost">صفحة المشروع</Link>} />
      <div className="toolbar"><StatusTabs value={tab} onChange={setTab} options={[["evm", "القيمة المكتسبة"], ["schedule", "البرنامج الزمني"], ["cost", "الموازنة والتكلفة"], ["cash", "التدفق النقدي"]]} /></div>
      {tab === "evm" && <EvmTab projectId={projectId} />}
      {tab === "schedule" && <ScheduleTab projectId={projectId} />}
      {tab === "cost" && <CostTab projectId={projectId} />}
      {tab === "cash" && <CashTab projectId={projectId} />}
    </div>
  );
}

function EvmTab({ projectId }: { projectId: string }) {
  const { tenantId, can, writable } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const q = useQuery({ queryKey: ["t", tenantId, "contracting", "evm", projectId], queryFn: () => api<Evm>("GET", `/t/projects/${projectId}/evm`, { tenant: tenantId }) });
  const [period, setPeriod] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const e = q.data;
  async function snapshot() {
    if (!period) return;
    setBusy(true); setErr(null);
    try { await api("POST", `/t/projects/${projectId}/evm/snapshot`, { tenant: tenantId, body: { period } }); toast.success(`ثُبّتت القيمة المكتسبة لشهر ${period}`); setPeriod(null); await invalidate("contracting"); }
    catch (x) { setErr(x); } finally { setBusy(false); }
  }
  if (q.isError) return <section className="panel"><p className="field-error">تعذّر تحميل القيمة المكتسبة: {errorMessage(q.error)}</p><Button onClick={() => void q.refetch()}>إعادة المحاولة</Button></section>;
  if (e && (!e.activities || !e.bac)) {
    return <section className="panel empty-state"><h2>{!e.activities ? "لا برنامج زمني بعد" : "لا موازنة للمشروع"}</h2>
      <p className="muted">{!e.activities ? "استورد البرنامج من Primavera P6 أو MS Project من تبويب «البرنامج الزمني»، ثم سجّل الإنجاز من الموقع." : "أدخل موازنة المشروع حسب رموز التكلفة من تبويب «الموازنة والتكلفة»: هي خط الأساس (BAC) الذي تُقاس عليه القيمة المكتسبة."}</p></section>;
  }
  const tone = (v: number | null) => (v === null ? undefined : v < 0.95 ? "warning" as const : undefined);
  return (
    <>
      <div className="stats">
        <StatCard label="القيمة المخططة (PV)" value={e ? money(e.pv) : "—"} icon={<CalendarRange />} hue="indigo" note={e ? `الموازنة ${money(e.bac)}` : undefined} />
        <StatCard label="القيمة المكتسبة (EV)" value={e ? money(e.ev) : "—"} icon={<Activity />} hue="green" note={e ? `مؤشر الجدول SPI ${ratio(e.spi)}` : undefined} noteTone={tone(e?.spi ?? null)} />
        <StatCard label="التكلفة الفعلية (AC)" value={e ? money(e.ac) : "—"} icon={<Wallet />} hue="sky" note={e ? `مؤشر التكلفة CPI ${ratio(e.cpi)}` : undefined} noteTone={tone(e?.cpi ?? null)} />
        <StatCard label="التكلفة المتوقعة عند الإنجاز (EAC)" value={e ? money(e.eac) : "—"} icon={<Gauge />} hue={e && e.vac < 0 ? "red" : "violet"}
          note={e ? `${e.vac < 0 ? "تجاوز" : "وفر"} ${money(Math.abs(e.vac))} · TCPI ${ratio(e.tcpi)}` : undefined} />
      </div>
      <section className="panel" aria-label="منحنى S">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: "var(--sp-2)" }}>
          <h2 className="panel-title">منحنى S</h2>
          {can("cost_control.snapshot") && writable && <Button icon={<Camera />} onClick={() => { setErr(null); setPeriod(lastMonth()); }}>تثبيت شهر</Button>}
        </div>
        {e ? <SCurve curve={e.curve} /> : <p className="muted">جارٍ التحميل…</p>}
        <p className="muted acc-small">المخطط من البرنامج. المكتسب والفعلي يظهران للشهور المثبّتة ({e?.snapshots.length ?? 0}). {e?.budgeted === "project" && "الأنشطة بلا موازنات، فوُزّعت موازنة المشروع عليها بمدتها."}</p>
      </section>
      <ConfirmDialog open={period !== null} onClose={() => setPeriod(null)} busy={busy} error={err ? errorMessage(err) : null} destructive={false} onConfirm={() => void snapshot()}
        title={`تثبيت القيمة المكتسبة لشهر ${period ?? ""}؟`} confirmLabel="تثبيت"
        message={<>تُحفظ PV وEV وAC كما هي في نهاية الشهر لتُرسم على المنحنى. التثبيت لا يُعدَّل، فحدّث الإنجاز قبله.
          <TextField label="الشهر" type="month" dir="ltr" value={period ?? ""} max={lastMonth()} onChange={(x) => x.target.value && setPeriod(x.target.value)} /></>} />
    </>
  );
}

/** PV as a line through every month, EV and AC as points on the months that were snapshotted. */
function SCurve({ curve }: { curve: Evm["curve"] }) {
  if (curve.length < 2) return <p className="muted">البرنامج أقصر من شهرين.</p>;
  const W = 640, H = 220, P = 36;
  const step = Math.ceil(curve.length / 8);
  const max = Math.max(1, ...curve.map((c) => Math.max(c.pv, c.ev ?? 0, c.ac ?? 0)));
  const x = (i: number) => W - P - (i * (W - 2 * P)) / (curve.length - 1);
  const y = (v: number) => H - P - (v / max) * (H - 2 * P);
  const line = (k: "pv" | "ev" | "ac") => curve.map((c, i) => (c[k] === null ? null : `${x(i)},${y(c[k] as number)}`)).filter(Boolean).join(" ");
  const series: [("pv" | "ev" | "ac"), string, string][] = [["pv", "var(--on-indigo)", "المخطط"], ["ev", "var(--on-green)", "المكتسب"], ["ac", "var(--on-red)", "الفعلي"]];
  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="منحنى القيمة المخططة والمكتسبة والفعلية" style={{ width: "100%", height: "auto" }}>
        <line x1={P} x2={W - P} y1={H - P} y2={H - P} stroke="var(--divider)" />
        {series.map(([k, color]) => <polyline key={k} points={line(k)} fill="none" stroke={color} strokeWidth={k === "pv" ? 2 : 2.5} strokeDasharray={k === "pv" ? "5 4" : undefined} />)}
        {series.slice(1).flatMap(([k, color]) => curve.map((c, i) => c[k] === null ? null : <circle key={`${k}${i}`} cx={x(i)} cy={y(c[k] as number)} r={3.5} fill={color} />))}
        {curve.map((c, i) => (i % step === 0 || (i === curve.length - 1 && i % step >= step / 2)) && <text key={c.period} x={x(i)} y={H - P + 16} fontSize="11" textAnchor="middle" fill="var(--text-muted)">{c.period}</text>)}
      </svg>
      <figcaption className="row" style={{ gap: "var(--sp-3)" }}>{series.map(([k, color, label]) => <span key={k} className="acc-small"><span aria-hidden style={{ color }}>●</span> {label}</span>)}</figcaption>
    </figure>
  );
}

function ScheduleTab({ projectId }: { projectId: string }) {
  const { tenantId, can, writable } = useTenant();
  const q = useQuery({ queryKey: ["t", tenantId, "contracting", "schedule", projectId], queryFn: () => api<{ today: string; items: Act[] }>("GET", `/t/projects/${projectId}/schedule`, { tenant: tenantId }) });
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState<Act | null>(null);
  const edit = can("cost_control.schedule") && writable;
  const late = (q.data?.items ?? []).filter((a) => a.late).length;
  return (
    <section className="panel" aria-label="البرنامج الزمني">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: "var(--sp-2)" }}>
        <h2 className="panel-title">البرنامج الزمني {late > 0 && <Badge tone="warning">{late} نشاط متأخر</Badge>}</h2>
        {edit && <Button variant="primary" icon={<Upload />} onClick={() => setImporting(true)}>استيراد البرنامج</Button>}
      </div>
      <DataTable caption="أنشطة البرنامج" query={q} rowKey={(r) => r.id}
        empty={{ title: "لا برنامج زمني بعد", body: "صدّر البرنامج من Primavera P6 بصيغة XER أو من MS Project بصيغة XML واستورده. إعادة الاستيراد تحدّث التواريخ وتحتفظ بإنجاز الموقع." }}
        columns={[
          { key: "code", header: "النشاط", cell: (r) => <span style={{ paddingInlineStart: `calc(${r.depth} * var(--sp-4))` }} className="stack-tight">
            {r.isSummary ? <strong>{r.name}</strong> : <span>{r.name}</span>}<span className="muted acc-small"><Ref>{r.code}</Ref>{r.late && <> <Badge tone="warning">متأخر</Badge></>}</span></span> },
          { key: "start", header: "البداية المخططة", cell: (r) => r.isSummary ? "" : day(r.start) },
          { key: "finish", header: "النهاية المخططة", cell: (r) => r.isSummary ? "" : day(r.finish) },
          { key: "actualStart", header: "البداية الفعلية", cell: (r) => r.isSummary ? "" : day(r.actualStart) },
          { key: "pctComplete", header: "الإنجاز", numeric: true, cell: (r) => r.isSummary ? "" : percent(r.pctComplete) },
        ]}
        actions={edit ? (r) => r.isSummary ? null : <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>تحديث الإنجاز</Button> : undefined} />
      {importing && <ImportDialog projectId={projectId} onClose={() => setImporting(false)} />}
      {editing && <ProgressDialog act={editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

function ImportDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { tenantId } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function upload() {
    if (!file) return setError(new Error("اختر ملف البرنامج (.xer أو .xml)"));
    if (file.size > 20 * 1024 * 1024) return setError(new Error("حجم الملف أكبر من 20 ميجابايت"));
    setBusy(true); setError(null);
    const fd = new FormData();
    fd.append("file", file);
    try {
      const r = await api<{ activities: number; summaries: number }>("POST", `/t/projects/${projectId}/schedule/import`, { tenant: tenantId, body: fd });
      toast.success(`استُورد ${r.activities} نشاط و${r.summaries} عنصر تجميعي`);
      await invalidate("contracting");
      onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} title="استيراد البرنامج الزمني"
      footer={<><Button variant="primary" icon={<Upload />} onClick={() => void upload()} loading={busy} loadingText="جارٍ الاستيراد…">استيراد الملف</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <p className="muted">من Primavera P6: ملف ← تصدير ← XER. من MS Project: حفظ باسم ← XML. تُقرأ الأنشطة بتواريخ خط الأساس وتسلسل WBS. النشاط الموجود يُحدَّث برمزه، وإنجاز الموقع لا يُستبدل إلا إذا حمل الملف إنجازاً.</p>
      <div className="field">
        <label className="field-label" htmlFor="sched-file">ملف البرنامج</label>
        <input id="sched-file" className="input" type="file" accept=".xer,.xml" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(null); }} style={{ paddingBlock: "var(--sp-1)" }} />
      </div>
      <FormError error={error} />
    </Dialog>
  );
}

function ProgressDialog({ act, onClose }: { act: Act; onClose: () => void }) {
  const { tenantId } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const [v, setV] = useState({ pct: String(act.pctComplete), start: act.actualStart ?? "", finish: act.actualFinish ?? "" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    const pct = Number(v.pct);
    if (!(pct >= 0 && pct <= 100)) return setError(new Error("النسبة بين 0 و100"));
    if (pct > 0 && !v.start) return setError(new Error("أدخل تاريخ البدء الفعلي"));
    setBusy(true); setError(null);
    try {
      await api("PUT", `/t/schedule-activities/${act.id}/progress`, { tenant: tenantId, body: { pctComplete: pct, actualStart: v.start || null, actualFinish: pct === 100 ? v.finish || null : null } });
      await invalidate("contracting");
      onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title={`إنجاز ${act.name}`}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">حفظ الإنجاز</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <p className="muted">المخطط من {day(act.start)} إلى {day(act.finish)}.</p>
      <div className="form-grid">
        <TextField label="نسبة الإنجاز الفعلية (%)" required numeric inputMode="decimal" dir="ltr" value={v.pct} onChange={(e) => setV({ ...v, pct: e.target.value })} />
        <TextField label="البدء الفعلي" type="date" dir="ltr" max={isoDay()} value={v.start} onChange={(e) => setV({ ...v, start: e.target.value })} optional={Number(v.pct) === 0} />
        {Number(v.pct) === 100 && <TextField label="الانتهاء الفعلي" type="date" dir="ltr" max={isoDay()} value={v.finish} onChange={(e) => setV({ ...v, finish: e.target.value })} optional />}
      </div>
      <FormError error={error} />
    </Dialog>
  );
}

function CostTab({ projectId }: { projectId: string }) {
  const { tenantId, can, writable } = useTenant();
  const q = useQuery({ queryKey: ["t", tenantId, "contracting", "cost-control", projectId],
    queryFn: () => api<{ asOf: string; lines: CostLine[]; totals: Omit<CostLine, "costCodeId" | "costCode" | "costName" | "wbsId" | "wbs"> }>("GET", `/t/projects/${projectId}/cost-control`, { tenant: tenantId }) });
  const [budgeting, setBudgeting] = useState(false);
  const t = q.data?.totals;
  return (
    <>
      <div className="stats">
        <StatCard label="الموازنة" value={t ? money(t.budget) : "—"} icon={<Wallet />} hue="indigo" />
        <StatCard label="التكلفة الفعلية" value={t ? money(t.actual) : "—"} icon={<Activity />} hue="sky" />
        <StatCard label="الالتزامات" value={t ? money(t.committed) : "—"} icon={<CalendarRange />} hue="violet" note="أوامر شراء مفتوحة وعقود باطن لم تُعتمد" />
        <StatCard label="المتوقع عند الإنجاز" value={t ? money(t.forecast) : "—"} icon={<Gauge />} hue={t && t.variance < 0 ? "red" : "green"}
          note={t ? `${t.variance < 0 ? "تجاوز" : "وفر"} ${money(Math.abs(t.variance))}` : undefined} />
      </div>
      <section className="panel" aria-label="التحكم في التكلفة">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: "var(--sp-2)" }}>
          <h2 className="panel-title">حسب رمز التكلفة</h2>
          {can("cost_control.budget") && writable && <Button variant="primary" onClick={() => setBudgeting(true)} disabled={!q.data}>موازنة المشروع</Button>}
        </div>
        <DataTable caption="الموازنة والتكلفة" query={q.data ? { ...q, data: { items: q.data.lines } } : q} rowKey={(r) => `${r.costCodeId}:${r.wbsId}`}
          empty={{ title: "لا موازنة ولا تكلفة بعد", body: "أدخل موازنة المشروع حسب رموز التكلفة. التكلفة الفعلية تأتي من القيود على مركز تكلفة المشروع." }}
          columns={[
            { key: "costCode", header: "رمز التكلفة", cell: (r) => <span className="stack-tight"><strong>{r.costName}</strong><span className="muted acc-small"><Ref>{r.costCode}</Ref>{r.wbs && <> · <Ref>{r.wbs}</Ref></>}</span></span> },
            { key: "budget", header: "الموازنة", numeric: true, cell: (r) => money(r.budget) },
            { key: "actual", header: "الفعلي", numeric: true, cell: (r) => money(r.actual) },
            { key: "committed", header: "الملتزم به", numeric: true, cell: (r) => money(r.committed) },
            { key: "forecast", header: "المتوقع", numeric: true, cell: (r) => money(r.forecast) },
            { key: "variance", header: "الفرق", numeric: true, cell: (r) => r.variance < 0 ? <span className="field-error">{money(r.variance)}</span> : money(r.variance) },
          ]} />
        <p className="muted acc-small">المتوقع = الفعلي + الأكبر من الالتزامات وما تبقى من الموازنة. التكلفة بلا رمز تظهر «غير مصنّف» ولا تضيع.</p>
      </section>
      {budgeting && q.data && <BudgetDialog projectId={projectId} lines={q.data.lines} onClose={() => setBudgeting(false)} />}
    </>
  );
}

function BudgetDialog({ projectId, lines, onClose }: { projectId: string; lines: CostLine[]; onClose: () => void }) {
  const { tenantId } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const ref = useQuery({ queryKey: ["t", tenantId, "contracting", "reference"],
    queryFn: () => api<{ costCodes: { id: string; code: string; name: string; isActive: boolean }[] }>("GET", "/t/contracting/reference", { tenant: tenantId }) });
  // Project-level lines are edited here; lines on WBS elements are kept as they are.
  const [amounts, setAmounts] = useState<Record<string, string>>(() => Object.fromEntries(lines.filter((l) => !l.wbsId && l.costCodeId && l.budget).map((l) => [l.costCodeId!, String(l.budget)])));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const total = Object.values(amounts).reduce((a, v) => a + (Number(v.replace(/,/g, "")) || 0), 0);
  async function submit() {
    const own = Object.entries(amounts).map(([costCodeId, v]) => ({ wbsId: null, costCodeId, amount: Number(v.replace(/,/g, "")) || 0 }));
    if (own.some((l) => l.amount < 0)) return setError(new Error("المبالغ لا تكون سالبة"));
    const kept = lines.filter((l) => l.wbsId && l.costCodeId && l.budget).map((l) => ({ wbsId: l.wbsId, costCodeId: l.costCodeId!, amount: l.budget }));
    setBusy(true); setError(null);
    try { await api("PUT", `/t/projects/${projectId}/budget`, { tenant: tenantId, body: { lines: [...own, ...kept] } }); toast.success("حُفظت موازنة المشروع"); await invalidate("contracting"); onClose(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title="موازنة المشروع"
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…" disabled={!ref.data}>حفظ الموازنة</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <p className="muted">خط الأساس الذي تُقاس عليه التكلفة والقيمة المكتسبة، قبل الضريبة. المجموع {money(total)}.</p>
      {ref.isError && <p className="field-error">تعذّر تحميل رموز التكلفة. أغلق وأعد المحاولة.</p>}
      <div className="form-grid">
        {(ref.data?.costCodes ?? []).filter((c) => c.isActive || amounts[c.id]).map((c) => (
          <TextField key={c.id} label={`${c.name} (${c.code})`} numeric inputMode="decimal" dir="ltr" optional value={amounts[c.id] ?? ""}
            onChange={(e) => setAmounts({ ...amounts, [c.id]: e.target.value })} />
        ))}
      </div>
      <FormError error={error} />
    </Dialog>
  );
}

function CashTab({ projectId }: { projectId: string }) {
  const { tenantId } = useTenant();
  const [months, setMonths] = useState(12);
  const q = useQuery({ queryKey: ["t", tenantId, "contracting", "cashflow", projectId, months],
    queryFn: () => api<{ basis: string; hasSchedule: boolean; items: Flow[] }>("GET", `/t/projects/${projectId}/cashflow`, { tenant: tenantId, query: { months } }) });
  const low = (q.data?.items ?? []).reduce((m, x) => Math.min(m, x.cumulative), 0);
  return (
    <section className="panel" aria-label="التدفق النقدي المتوقع">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: "var(--sp-2)" }}>
        <h2 className="panel-title">التدفق النقدي المتوقع {low < 0 && <Badge tone="warning">أقصى تمويل مطلوب {money(-low)}</Badge>}</h2>
        <StatusTabs value={String(months)} onChange={(v) => setMonths(Number(v))} options={[["6", "6 أشهر"], ["12", "12 شهراً"], ["24", "24 شهراً"]]} />
      </div>
      {q.data && !q.data.hasSchedule && <p className="muted">لا برنامج زمني: يُفترض أن المتبقي كله في الشهر الحالي. استورد البرنامج لتوزيعه على الشهور.</p>}
      <DataTable caption="التدفق النقدي" query={q} rowKey={(r) => r.period}
        empty={{ title: "لا تدفقات متوقعة", body: "يظهر هنا المتبقي من قيمة العقود الرئيسية وتكلفة المشروع موزعين على شهور البرنامج." }}
        columns={[
          { key: "period", header: "الشهر", cell: (r) => <Ref>{r.period}</Ref> },
          { key: "inflow", header: "المقبوضات", numeric: true, cell: (r) => money(r.inflow) },
          { key: "outflow", header: "المدفوعات", numeric: true, cell: (r) => money(r.outflow) },
          { key: "net", header: "الصافي", numeric: true, cell: (r) => r.net < 0 ? <span className="field-error">{money(r.net)}</span> : money(r.net) },
          { key: "cumulative", header: "التراكمي", numeric: true, cell: (r) => r.cumulative < 0 ? <span className="field-error">{money(r.cumulative)}</span> : money(r.cumulative) },
        ]} />
      <p className="muted acc-small">{q.data?.basis}. المقبوضات بعد خصم المحتجزات واسترداد الدفعة المقدمة، وتتأخر بمدة سداد العميل. المدفوعات = التكلفة المتوقعة المتبقية (EAC − AC).</p>
    </section>
  );
}
