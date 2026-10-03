import { useQuery } from "@tanstack/react-query";
import { ClipboardCheck, Download, FileStack, FileText, HardHat, Plus, Send, ShieldAlert, Upload } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api, download, errorMessage } from "../../api/client";
import { useInvalidate, useTenant } from "../../app/tenant";
import { day, dayTime, integer, isoDay, money, percent, text } from "../../lib/format";
import { Button } from "../../ui/Button";
import { DataTable } from "../../ui/DataTable";
import { ConfirmDialog, Dialog } from "../../ui/Dialog";
import { Checkbox, SelectField, TextAreaField, TextField } from "../../ui/Field";
import { Badge, PageHeader, StatCard } from "../../ui/Layout";
import { EmptyState, ErrorState, FormError } from "../../ui/States";
import { useToast } from "../../ui/Toast";
import { StatusTabs } from "./Inventory";

// Contracting C10, the digital site: quality (inspection requests, NCRs, RFIs, the ITP), safety (incidents, permits,
// the rates on the daily reports' man-hours), document control (register, revisions, consultant review,
// transmittals) and the daily site report. Every screen works on one project, picked at the top and remembered.

interface ProjectOpt { id: string; code: string; name: string; status: string }
const Ref = ({ children }: { children: ReactNode }) => <bdi dir="ltr" className="num">{children}</bdi>;
const num = (s: string) => Number(String(s).replace(/,/g, ""));
const opts = (m: Record<string, string>) => Object.entries(m).map(([value, label]) => ({ value, label }));

const INSPECTION: Record<string, [string, "success" | "warning" | "danger" | "neutral" | "info"]> = {
  submitted: ["بانتظار الفحص", "info"], approved: ["مقبول", "success"], approved_as_noted: ["مقبول بملاحظات", "success"], rejected: ["مرفوض", "danger"], cancelled: ["ملغى", "neutral"] };
const DISPOSITION: Record<string, string> = { rework: "إعادة تنفيذ", repair: "إصلاح", use_as_is: "قبول كما هو", reject: "رفض وإزالة" };
const DISCIPLINE: Record<string, string> = { architectural: "معماري", structural: "إنشائي", mep: "كهروميكانيك", civil: "مدني", general: "عام" };
const IMPACT: Record<string, string> = { none: "بلا أثر", cost: "تكلفة", time: "مدة", cost_time: "تكلفة ومدة" };
const INCIDENT: Record<string, string> = { near_miss: "حادث وشيك", first_aid: "إسعاف أولي", medical_treatment: "علاج طبي", lost_time: "إصابة مضيعة للوقت", fatality: "وفاة",
  property_damage: "تلف ممتلكات", environmental: "بيئي" };
const PERMIT: Record<string, string> = { hot_work: "أعمال ساخنة", confined_space: "أماكن مغلقة", work_at_height: "عمل على ارتفاع", excavation: "حفريات", electrical: "أعمال كهربائية", lifting: "رفع ثقيل" };
const DOC_TYPE: Record<string, string> = { drawing: "مخطط", shop_drawing: "مخطط تنفيذي", specification: "مواصفات", method_statement: "طريقة تنفيذ", material_submittal: "اعتماد مواد",
  report: "تقرير", correspondence: "مراسلة", other: "أخرى" };
const REVIEW: Record<string, [string, "success" | "warning" | "danger"]> = { A: ["A معتمد", "success"], B: ["B معتمد بملاحظات", "success"], C: ["C يُعدَّل ويُعاد", "warning"], D: ["D مرفوض", "danger"] };
const PURPOSE: Record<string, string> = { for_approval: "للاعتماد", for_information: "للعلم", for_construction: "للتنفيذ", as_built: "كما نُفّذ" };
const WEATHER: Record<string, string> = { clear: "صحو", hot: "حار", windy: "رياح", dust: "غبار", rain: "مطر" };

/** The project the site screens work on: the last one picked in this browser, else the first open one. */
function useProject(tenantId: string) {
  const key = `mn.site.project.${tenantId}`;
  const projects = useQuery({ queryKey: ["t", tenantId, "contracting", "projects"], queryFn: () => api<{ items: ProjectOpt[] }>("GET", "/t/projects", { tenant: tenantId }) });
  const [id, setId] = useState<string>(() => { try { return sessionStorage.getItem(key) ?? ""; } catch { return ""; } });
  const items = projects.data?.items ?? [];
  useEffect(() => {
    if (items.length && !items.some((p) => p.id === id)) setId((items.find((p) => p.status !== "closed") ?? items[0])!.id);
  }, [items, id]);
  const pick = (v: string) => { setId(v); try { sessionStorage.setItem(key, v); } catch { /* private mode */ } };
  const picker = (
    <SelectField label="المشروع" value={id} onChange={(e) => pick(e.target.value)} disabled={!items.length}
      options={items.map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))} />
  );
  return { projectId: items.some((p) => p.id === id) ? id : "", picker, projects };
}

function NeedsProject({ projects, children }: { projects: ReturnType<typeof useProject>["projects"]; children: ReactNode }) {
  if (projects.isError) return <ErrorState error={projects.error} onRetry={() => void projects.refetch()} title="تعذّر تحميل المشاريع" />;
  if (projects.data && !projects.data.items.length) return <EmptyState title="لا مشاريع بعد">أنشئ المشروع من «المشاريع والعقود»، ثم سجّل عليه الفحص والسلامة والوثائق والتقارير اليومية.</EmptyState>;
  return <>{children}</>;
}

// ══ Quality ═════════════════════════════════════════════════════════════════════════════════
interface Inspection { id: string; kind: "WIR" | "MIR"; number: number; description: string; location: string | null; requestedFor: string; status: string; inspector: string | null;
  inspectedOn: string | null; comments: string | null; material: string | null; supplier: string | null; itpActivity: string | null; itpPoint: string | null; wbs: string | null;
  reinspectionOfNumber: number | null; ncrNumber: number | null; quantity: number | null }
interface Ncr { id: string; number: number; source: string; severity: string; description: string; disposition: string | null; rootCause: string | null; correctiveAction: string | null;
  costEstimate: number | null; status: string; supplier: string | null; supplierId: string | null; inspection: string | null }
interface Rfi { id: string; number: number; subject: string; question: string; discipline: string; requiredBy: string | null; status: string; answer: string | null; answeredOn: string | null;
  impact: string | null; variationNumber: number | null; claimNumber: number | null; daysLate: number }
interface ItpItem { id: string; activity: string; point: "H" | "W" | "R"; reference: string | null; criteria: string | null; frequency: string | null; isActive: boolean; passed: number; pending: number }
interface Opt { id: string; name: string }
const useSuppliers = (tenantId: string) => useQuery({ queryKey: ["t", tenantId, "suppliers", "options"], queryFn: () => api<{ items: Opt[] }>("GET", "/t/suppliers", { tenant: tenantId, query: { isActive: "true", pageSize: 100 } }) });

export function SiteQualityPage() {
  const { tenantId, can, writable } = useTenant();
  const { projectId, picker, projects } = useProject(tenantId);
  const [tab, setTab] = useState("inspections");
  const [dialog, setDialog] = useState<string | null>(null);
  const summary = useQuery({ enabled: Boolean(projectId), queryKey: ["t", tenantId, "contracting", "quality-summary", projectId],
    queryFn: () => api<{ pendingInspections: number; firstPassRate: number | null; openNcrs: number; majorNcrs: number; openRfis: number; overdueRfis: number }>("GET", `/t/projects/${projectId}/quality-summary`, { tenant: tenantId }) });
  const s = summary.data;
  const primary: Record<string, [string, string, string]> = { inspections: ["quality.record", "طلب فحص", "inspection"], ncrs: ["quality.record", "تقرير عدم مطابقة", "ncr"],
    rfis: ["quality.record", "استفسار فني", "rfi"], itp: ["quality.plan", "بند في خطة الفحص", "itp"] };
  const [perm, label, kind] = primary[tab]!;
  return (
    <div className="page">
      <PageHeader eyebrow="المقاولات" title="الجودة في الموقع"
        description="طلبات فحص الأعمال والمواد ونتيجة الاستشاري، وتقارير عدم المطابقة ومعالجتها، والاستفسارات الفنية وما ترتب عليها من تغيير أو مطالبة."
        actions={can(perm as never) && writable && projectId ? <Button variant="primary" icon={<Plus />} onClick={() => setDialog(kind)}>{label}</Button> : undefined} />
      <div className="toolbar">{picker}</div>
      <NeedsProject projects={projects}>
        <div className="stats">
          <StatCard label="بانتظار الفحص" value={s ? integer(s.pendingInspections) : "—"} icon={<ClipboardCheck />} hue="sky" />
          <StatCard label="القبول من أول فحص" value={s ? (s.firstPassRate === null ? "—" : percent(s.firstPassRate)) : "—"} icon={<ClipboardCheck />} hue="green" />
          <StatCard label="عدم مطابقة مفتوحة" value={s ? integer(s.openNcrs) : "—"} icon={<ShieldAlert />} hue={s?.majorNcrs ? "red" : "amber"} note={s?.majorNcrs ? `${integer(s.majorNcrs)} جسيمة` : undefined} />
          <StatCard label="استفسارات مفتوحة" value={s ? integer(s.openRfis) : "—"} icon={<FileText />} hue="violet" note={s?.overdueRfis ? `${integer(s.overdueRfis)} متأخرة عن موعدها` : undefined} noteTone={s?.overdueRfis ? "warning" : undefined} />
        </div>
        <section className="panel" aria-label="سجلات الجودة">
          <div className="toolbar"><StatusTabs value={tab} onChange={setTab} options={[["inspections", "طلبات الفحص"], ["ncrs", "عدم المطابقة"], ["rfis", "الاستفسارات الفنية"], ["itp", "خطة الفحص ITP"]]} /></div>
          {projectId && tab === "inspections" && <InspectionsTab projectId={projectId} />}
          {projectId && tab === "ncrs" && <NcrsTab projectId={projectId} />}
          {projectId && tab === "rfis" && <RfisTab projectId={projectId} />}
          {projectId && tab === "itp" && <ItpTab projectId={projectId} />}
        </section>
      </NeedsProject>
      {dialog === "inspection" && <InspectionDialog projectId={projectId} onClose={() => setDialog(null)} />}
      {dialog === "ncr" && <NcrDialog projectId={projectId} onClose={() => setDialog(null)} />}
      {dialog === "rfi" && <RfiDialog projectId={projectId} onClose={() => setDialog(null)} />}
      {dialog === "itp" && <ItpDialog projectId={projectId} onClose={() => setDialog(null)} />}
    </div>
  );
}

function InspectionsTab({ projectId }: { projectId: string }) {
  const { tenantId, can, writable } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const q = useQuery({ queryKey: ["t", tenantId, "contracting", "inspections", projectId], queryFn: () => api<{ items: Inspection[] }>("GET", "/t/inspections", { tenant: tenantId, query: { projectId } }) });
  const [result, setResult] = useState<Inspection | null>(null);
  const [cancelling, setCancelling] = useState<Inspection | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  async function cancel() {
    if (!cancelling) return;
    setBusy(true); setErr(null);
    try { await api("POST", `/t/inspections/${cancelling.id}/cancel`, { tenant: tenantId }); toast.success(`أُلغي ${cancelling.kind}-${cancelling.number}`); setCancelling(null); await invalidate("contracting"); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <>
      <DataTable caption="طلبات الفحص" query={q} rowKey={(r) => r.id}
        empty={{ title: "لا طلبات فحص", body: "اطلب فحص العمل (WIR) قبل تغطيته أو صبه، وفحص المواد (MIR) عند توريدها، وسجّل نتيجة الاستشاري." }}
        columns={[
          { key: "number", header: "الطلب", cell: (r) => <span className="stack-tight"><strong><Ref>{`${r.kind}-${r.number}`}</Ref></strong>
            {r.reinspectionOfNumber && <span className="muted acc-small">إعادة فحص <Ref>{`${r.kind}-${r.reinspectionOfNumber}`}</Ref></span>}</span> },
          { key: "description", header: "الوصف", wrap: true, cell: (r) => <span className="stack-tight"><span>{r.description}</span>
            <span className="muted acc-small">{[r.material && `${r.material}${r.quantity ? ` × ${r.quantity}` : ""}`, r.location, r.wbs, r.itpActivity && `${r.itpPoint}: ${r.itpActivity}`, r.supplier].filter(Boolean).join(" · ")}</span></span> },
          { key: "requestedFor", header: "الموعد", cell: (r) => day(r.requestedFor) },
          { key: "status", header: "النتيجة", cell: (r) => <span className="stack-tight"><Badge tone={INSPECTION[r.status]![1]}>{INSPECTION[r.status]![0]}</Badge>
            {r.inspectedOn && <span className="muted acc-small">{day(r.inspectedOn)}{r.inspector ? ` · ${r.inspector}` : ""}</span>}
            {r.comments && <span className="muted acc-small">{r.comments}</span>}{r.ncrNumber && <span className="acc-small">عدم مطابقة <Ref>{`#${r.ncrNumber}`}</Ref></span>}</span> },
        ]}
        actions={writable ? (r) => r.status !== "submitted" ? null : <>
          {can("quality.respond") && <Button size="sm" variant="ghost" onClick={() => setResult(r)}>النتيجة</Button>}
          {can("quality.record") && <Button size="sm" variant="ghost" onClick={() => { setErr(null); setCancelling(r); }}>إلغاء الطلب</Button>}</> : undefined} />
      {result && <ResultDialog row={result} onClose={() => setResult(null)} />}
      <ConfirmDialog open={cancelling !== null} onClose={() => setCancelling(null)} busy={busy} error={err ? errorMessage(err) : null} onConfirm={() => void cancel()}
        title={`إلغاء ${cancelling?.kind}-${cancelling?.number}؟`} confirmLabel="إلغاء الطلب" message="يبقى الطلب في السجل ملغى ولا تُسجَّل له نتيجة." />
    </>
  );
}

function InspectionDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { tenantId } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const itp = useQuery({ queryKey: ["t", tenantId, "contracting", "itp", projectId], queryFn: () => api<{ items: ItpItem[] }>("GET", `/t/projects/${projectId}/itp`, { tenant: tenantId }) });
  const materials = useQuery({ queryKey: ["t", tenantId, "ingredients", "options"], queryFn: () => api<{ items: Opt[] }>("GET", "/t/ingredients", { tenant: tenantId, query: { isActive: "true", pageSize: 100 } }) });
  const suppliers = useSuppliers(tenantId);
  const rejected = useQuery({ queryKey: ["t", tenantId, "contracting", "inspections", projectId, "rejected"],
    queryFn: () => api<{ items: Inspection[] }>("GET", "/t/inspections", { tenant: tenantId, query: { projectId, status: "rejected" } }) });
  const [v, setV] = useState({ kind: "WIR", itpItemId: "", ingredientId: "", supplierId: "", quantity: "", location: "", description: "", requestedFor: isoDay(), reinspectionOf: "" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (v.kind === "MIR" && !v.ingredientId) return setError(new Error("اختر المادة المطلوب فحصها"));
    setBusy(true); setError(null);
    try {
      const r = await api<{ number: number }>("POST", "/t/inspections", { tenant: tenantId, body: { projectId, kind: v.kind, itpItemId: v.itpItemId || null, ingredientId: v.kind === "MIR" ? v.ingredientId : null,
        supplierId: v.supplierId || null, quantity: v.quantity ? num(v.quantity) : null, location: v.location || null, description: v.description, requestedFor: v.requestedFor, reinspectionOf: v.reinspectionOf || null } });
      toast.success(`سُجّل طلب الفحص ${v.kind}-${r.number}`);
      await invalidate("contracting");
      onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  const again = (rejected.data?.items ?? []).filter((r) => r.kind === v.kind);
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title="طلب فحص"
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">تسجيل الطلب</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <div className="form-grid">
        <SelectField label="النوع" required value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value, reinspectionOf: "" })}
          options={[{ value: "WIR", label: "فحص أعمال WIR" }, { value: "MIR", label: "فحص مواد MIR" }]} />
        <TextField label="موعد الفحص المطلوب" required type="date" dir="ltr" value={v.requestedFor} onChange={(e) => setV({ ...v, requestedFor: e.target.value })} />
      </div>
      {v.kind === "MIR" && <div className="form-grid">
        <SelectField label="المادة" required value={v.ingredientId} onChange={(e) => setV({ ...v, ingredientId: e.target.value })} placeholder="اختر"
          options={(materials.data?.items ?? []).map((m) => ({ value: m.id, label: m.name }))} />
        <TextField label="الكمية" optional numeric inputMode="decimal" dir="ltr" value={v.quantity} onChange={(e) => setV({ ...v, quantity: e.target.value })} />
      </div>}
      <TextAreaField label="ما المطلوب فحصه" required value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} maxLength={1000} rows={2} />
      <div className="form-grid">
        <TextField label="الموقع في المشروع" optional value={v.location} onChange={(e) => setV({ ...v, location: e.target.value })} maxLength={200} placeholder="الدور الثاني، المحور C" />
        <SelectField label="المورد أو مقاول الباطن" optional value={v.supplierId} onChange={(e) => setV({ ...v, supplierId: e.target.value })} placeholder="—"
          options={(suppliers.data?.items ?? []).map((s) => ({ value: s.id, label: s.name }))} />
        <SelectField label="بند خطة الفحص" optional value={v.itpItemId} onChange={(e) => setV({ ...v, itpItemId: e.target.value })} placeholder="—"
          options={(itp.data?.items ?? []).filter((i) => i.isActive).map((i) => ({ value: i.id, label: `${i.point} · ${i.activity}` }))} />
        {again.length > 0 && <SelectField label="إعادة فحص لطلب مرفوض" optional value={v.reinspectionOf} onChange={(e) => setV({ ...v, reinspectionOf: e.target.value })} placeholder="—"
          options={again.map((r) => ({ value: r.id, label: `${r.kind}-${r.number} · ${r.description.slice(0, 40)}` }))} />}
      </div>
      <FormError error={error} />
    </Dialog>
  );
}

function ResultDialog({ row, onClose }: { row: Inspection; onClose: () => void }) {
  const { tenantId } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [v, setV] = useState({ status: "approved", inspector: "", inspectedOn: isoDay(), comments: "", ncr: false, severity: "minor" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (v.status !== "approved" && !v.comments.trim()) return setError(new Error("اكتب ملاحظات الاستشاري أو سبب الرفض"));
    setBusy(true); setError(null);
    try {
      const r = await api<{ ncrId: string | null }>("POST", `/t/inspections/${row.id}/result`, { tenant: tenantId, body: { status: v.status, inspector: v.inspector || null, inspectedOn: v.inspectedOn,
        comments: v.comments || null, raiseNcr: v.status === "rejected" && v.ncr ? { severity: v.severity } : null } });
      toast.success(r.ncrId ? "سُجّلت النتيجة وفُتح تقرير عدم مطابقة" : "سُجّلت نتيجة الفحص");
      await invalidate("contracting");
      onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title={`نتيجة ${row.kind}-${row.number}`}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">تسجيل النتيجة</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <p className="muted">{row.description}</p>
      <div className="form-grid">
        <SelectField label="النتيجة" required value={v.status} onChange={(e) => setV({ ...v, status: e.target.value })}
          options={[{ value: "approved", label: "مقبول" }, { value: "approved_as_noted", label: "مقبول بملاحظات" }, { value: "rejected", label: "مرفوض" }]} />
        <TextField label="تاريخ الفحص" required type="date" dir="ltr" max={isoDay()} value={v.inspectedOn} onChange={(e) => setV({ ...v, inspectedOn: e.target.value })} />
        <TextField label="المفتش" optional value={v.inspector} onChange={(e) => setV({ ...v, inspector: e.target.value })} maxLength={120} />
      </div>
      <TextAreaField label="ملاحظات الاستشاري" required={v.status !== "approved"} optional={v.status === "approved"} value={v.comments} onChange={(e) => setV({ ...v, comments: e.target.value })} maxLength={1000} rows={2} />
      {v.status === "rejected" && <div className="form-grid">
        <Checkbox label="افتح تقرير عدم مطابقة" checked={v.ncr} onChange={(e) => setV({ ...v, ncr: e.target.checked })} />
        {v.ncr && <SelectField label="الجسامة" value={v.severity} onChange={(e) => setV({ ...v, severity: e.target.value })} options={[{ value: "minor", label: "بسيطة" }, { value: "major", label: "جسيمة" }]} />}
      </div>}
      <p className="muted acc-small">النتيجة لا تُعدَّل بعد تسجيلها. الرفض يُعاد بطلب إعادة فحص.</p>
      <FormError error={error} />
    </Dialog>
  );
}

function NcrsTab({ projectId }: { projectId: string }) {
  const { tenantId, can, writable } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const q = useQuery({ queryKey: ["t", tenantId, "contracting", "site-ncrs", projectId], queryFn: () => api<{ items: Ncr[] }>("GET", "/t/site-ncrs", { tenant: tenantId, query: { projectId } }) });
  const [editing, setEditing] = useState<Ncr | null>(null);
  const [closing, setClosing] = useState<Ncr | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  async function close() {
    if (!closing) return;
    setBusy(true); setErr(null);
    try { await api("POST", `/t/site-ncrs/${closing.id}/close`, { tenant: tenantId }); toast.success(`أُغلق تقرير عدم المطابقة #${closing.number}`); setClosing(null); await invalidate("contracting"); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <>
      <DataTable caption="تقارير عدم المطابقة" query={q} rowKey={(r) => r.id}
        empty={{ title: "لا تقارير عدم مطابقة", body: "تُفتح من فحص مرفوض أو من ملاحظة الاستشاري أو المالك أو التدقيق الداخلي، وتُغلق بالمعالجة والإجراء التصحيحي." }}
        columns={[
          { key: "number", header: "التقرير", cell: (r) => <span className="stack-tight"><strong><Ref>{`#${r.number}`}</Ref></strong>{r.severity === "major" ? <Badge tone="danger">جسيمة</Badge> : <Badge tone="warning">بسيطة</Badge>}</span> },
          { key: "description", header: "الوصف", wrap: true, cell: (r) => <span className="stack-tight"><span>{r.description}</span><span className="muted acc-small">{[r.inspection, r.supplier].filter(Boolean).join(" · ")}</span></span> },
          { key: "disposition", header: "المعالجة", wrap: true, cell: (r) => r.disposition ? <span className="stack-tight"><span>{DISPOSITION[r.disposition]}</span><span className="muted acc-small">{text(r.correctiveAction)}</span></span> : <span className="muted">—</span> },
          { key: "costEstimate", header: "التكلفة المقدرة", numeric: true, cell: (r) => r.costEstimate === null ? "—" : money(r.costEstimate) },
          { key: "status", header: "الحالة", cell: (r) => r.status === "open" ? <Badge tone="warning">مفتوح</Badge> : <Badge tone="success">مغلق</Badge> },
        ]}
        actions={writable ? (r) => r.status !== "open" ? null : <>
          {can("quality.record") && <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>المعالجة</Button>}
          {can("quality.close") && <Button size="sm" variant="ghost" disabled={!r.disposition || !r.correctiveAction} title={!r.disposition || !r.correctiveAction ? "حدد المعالجة والإجراء التصحيحي أولاً" : undefined}
            onClick={() => { setErr(null); setClosing(r); }}>إغلاق</Button>}</> : undefined} />
      {editing && <NcrDialog projectId={projectId} row={editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog open={closing !== null} onClose={() => setClosing(null)} busy={busy} error={err ? errorMessage(err) : null} onConfirm={() => void close()} destructive={false}
        title={`إغلاق تقرير عدم المطابقة #${closing?.number}؟`} confirmLabel="إغلاق التقرير" message="أغلقه بعد التحقق من تنفيذ المعالجة في الموقع. المغلق لا يُعدَّل." />
    </>
  );
}

function NcrDialog({ projectId, row, onClose }: { projectId: string; row?: Ncr; onClose: () => void }) {
  const { tenantId } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const suppliers = useSuppliers(tenantId);
  const [v, setV] = useState({ source: "consultant", severity: "minor", description: "", supplierId: row?.supplierId ?? "", disposition: row?.disposition ?? "", rootCause: row?.rootCause ?? "",
    correctiveAction: row?.correctiveAction ?? "", costEstimate: row?.costEstimate === null || row?.costEstimate === undefined ? "" : String(row.costEstimate) });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true); setError(null);
    try {
      if (row) await api("PUT", `/t/site-ncrs/${row.id}`, { tenant: tenantId, body: { disposition: v.disposition || null, rootCause: v.rootCause || null, correctiveAction: v.correctiveAction || null,
        costEstimate: v.costEstimate ? num(v.costEstimate) : null, supplierId: v.supplierId || null } });
      else { const r = await api<{ number: number }>("POST", "/t/site-ncrs", { tenant: tenantId, body: { projectId, source: v.source, severity: v.severity, supplierId: v.supplierId || null, description: v.description } });
        toast.success(`فُتح تقرير عدم المطابقة #${r.number}`); }
      await invalidate("contracting");
      onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title={row ? `معالجة عدم المطابقة #${row.number}` : "تقرير عدم مطابقة"}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">{row ? "حفظ المعالجة" : "فتح التقرير"}</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      {row ? <p className="muted">{row.description}</p> : <>
        <div className="form-grid">
          <SelectField label="المصدر" required value={v.source} onChange={(e) => setV({ ...v, source: e.target.value })}
            options={[{ value: "consultant", label: "الاستشاري" }, { value: "client", label: "المالك" }, { value: "internal_audit", label: "تدقيق داخلي" }]} />
          <SelectField label="الجسامة" required value={v.severity} onChange={(e) => setV({ ...v, severity: e.target.value })} options={[{ value: "minor", label: "بسيطة" }, { value: "major", label: "جسيمة" }]} />
        </div>
        <TextAreaField label="عدم المطابقة" required value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} maxLength={1000} rows={3} />
      </>}
      <SelectField label="المسؤول (مورد أو مقاول باطن)" optional value={v.supplierId} onChange={(e) => setV({ ...v, supplierId: e.target.value })} placeholder="—"
        options={(suppliers.data?.items ?? []).map((s) => ({ value: s.id, label: s.name }))} />
      {row && <>
        <div className="form-grid">
          <SelectField label="المعالجة" value={v.disposition} onChange={(e) => setV({ ...v, disposition: e.target.value })} placeholder="—" options={opts(DISPOSITION)} />
          <TextField label="التكلفة المقدرة (⃁)" optional numeric inputMode="decimal" dir="ltr" value={v.costEstimate} onChange={(e) => setV({ ...v, costEstimate: e.target.value })} />
        </div>
        <TextAreaField label="السبب الجذري" optional value={v.rootCause} onChange={(e) => setV({ ...v, rootCause: e.target.value })} maxLength={1000} rows={2} />
        <TextAreaField label="الإجراء التصحيحي" optional value={v.correctiveAction} onChange={(e) => setV({ ...v, correctiveAction: e.target.value })} maxLength={1000} rows={2}
          hint="ما يمنع التكرار، لا الإصلاح وحده. تكلفة يتحملها مقاول باطن تُخصم في مستخلصه (خصومات المستخلص)." />
      </>}
      <FormError error={error} />
    </Dialog>
  );
}

function RfisTab({ projectId }: { projectId: string }) {
  const { tenantId, can, writable } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const q = useQuery({ queryKey: ["t", tenantId, "contracting", "rfis", projectId], queryFn: () => api<{ items: Rfi[] }>("GET", "/t/rfis", { tenant: tenantId, query: { projectId } }) });
  const [answering, setAnswering] = useState<Rfi | null>(null);
  const [linking, setLinking] = useState<Rfi | null>(null);
  async function close(r: Rfi) {
    try { await api("POST", `/t/rfis/${r.id}/close`, { tenant: tenantId }); toast.success(`أُغلق الاستفسار #${r.number}`); await invalidate("contracting"); }
    catch (e) { toast.error(errorMessage(e)); }
  }
  return (
    <>
      <DataTable caption="الاستفسارات الفنية" query={q} rowKey={(r) => r.id}
        empty={{ title: "لا استفسارات", body: "اسأل الاستشاري عن تعارض أو نقص في المخططات قبل التنفيذ. الرد الذي يغيّر التكلفة أو المدة يُربط بأمر تغيير أو مطالبة." }}
        columns={[
          { key: "number", header: "الاستفسار", cell: (r) => <span className="stack-tight"><strong><Ref>{`#${r.number}`}</Ref> {r.subject}</strong><span className="muted acc-small">{DISCIPLINE[r.discipline]}</span></span> },
          { key: "question", header: "السؤال والرد", wrap: true, cell: (r) => <span className="stack-tight"><span>{r.question}</span>{r.answer && <span className="muted acc-small">الرد: {r.answer}</span>}</span> },
          { key: "requiredBy", header: "مطلوب بتاريخ", cell: (r) => <span className="stack-tight">{day(r.requiredBy)}{r.daysLate > 0 && <Badge tone="warning">متأخر {integer(r.daysLate)} يوم</Badge>}</span> },
          { key: "impact", header: "الأثر", cell: (r) => r.impact ? <span className="stack-tight"><span>{IMPACT[r.impact]}</span>
            {r.claimNumber && <span className="acc-small">مطالبة <Ref>{`#${r.claimNumber}`}</Ref></span>}{r.variationNumber && <span className="acc-small">أمر تغيير <Ref>{`#${r.variationNumber}`}</Ref></span>}</span> : "—" },
          { key: "status", header: "الحالة", cell: (r) => r.status === "open" ? <Badge tone="info">مفتوح</Badge> : r.status === "answered" ? <Badge tone="warning">تم الرد</Badge> : <Badge tone="success">مغلق</Badge> },
        ]}
        actions={writable ? (r) => <>
          {r.status === "open" && can("quality.respond") && <Button size="sm" variant="ghost" onClick={() => setAnswering(r)}>الرد</Button>}
          {r.status !== "open" && r.impact !== "none" && !r.claimNumber && !r.variationNumber && can("quality.record") && <Button size="sm" variant="ghost" onClick={() => setLinking(r)}>ربط بتغيير أو مطالبة</Button>}
          {r.status === "answered" && can("quality.record") && <Button size="sm" variant="ghost" onClick={() => void close(r)}>إغلاق</Button>}</> : undefined} />
      {answering && <AnswerDialog row={answering} onClose={() => setAnswering(null)} />}
      {linking && <LinkDialog projectId={projectId} row={linking} onClose={() => setLinking(null)} />}
    </>
  );
}

function RfiDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { tenantId } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [v, setV] = useState({ subject: "", question: "", discipline: "architectural", requiredBy: "" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true); setError(null);
    try {
      const r = await api<{ number: number }>("POST", "/t/rfis", { tenant: tenantId, body: { projectId, ...v, requiredBy: v.requiredBy || null } });
      toast.success(`سُجّل الاستفسار #${r.number}`); await invalidate("contracting"); onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title="استفسار فني"
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">تسجيل الاستفسار</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <TextField label="الموضوع" required value={v.subject} onChange={(e) => setV({ ...v, subject: e.target.value })} maxLength={200} />
      <TextAreaField label="السؤال" required value={v.question} onChange={(e) => setV({ ...v, question: e.target.value })} maxLength={2000} rows={3} hint="اذكر المخطط ورقمه وإصداره والتعارض بالتحديد." />
      <div className="form-grid">
        <SelectField label="التخصص" required value={v.discipline} onChange={(e) => setV({ ...v, discipline: e.target.value })} options={opts(DISCIPLINE)} />
        <TextField label="الرد مطلوب بتاريخ" optional type="date" dir="ltr" value={v.requiredBy} onChange={(e) => setV({ ...v, requiredBy: e.target.value })} />
      </div>
      <FormError error={error} />
    </Dialog>
  );
}

function AnswerDialog({ row, onClose }: { row: Rfi; onClose: () => void }) {
  const { tenantId } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const [v, setV] = useState({ answer: "", answeredOn: isoDay(), impact: "none" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true); setError(null);
    try { await api("POST", `/t/rfis/${row.id}/answer`, { tenant: tenantId, body: v }); await invalidate("contracting"); onClose(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title={`الرد على الاستفسار #${row.number}`}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">تسجيل الرد</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <p className="muted">{row.question}</p>
      <TextAreaField label="رد الاستشاري" required value={v.answer} onChange={(e) => setV({ ...v, answer: e.target.value })} maxLength={2000} rows={3} />
      <div className="form-grid">
        <TextField label="تاريخ الرد" required type="date" dir="ltr" max={isoDay()} value={v.answeredOn} onChange={(e) => setV({ ...v, answeredOn: e.target.value })} />
        <SelectField label="أثر الرد" required value={v.impact} onChange={(e) => setV({ ...v, impact: e.target.value })} options={opts(IMPACT)}
          hint="رد يغيّر التكلفة أو المدة: اربطه بأمر تغيير أو أخطر بمطالبة في مهلتها." />
      </div>
      <FormError error={error} />
    </Dialog>
  );
}

function LinkDialog({ projectId, row, onClose }: { projectId: string; row: Rfi; onClose: () => void }) {
  const { tenantId } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const project = useQuery({ queryKey: ["t", tenantId, "contracting", "project", projectId], queryFn: () => api<{ contracts: { id: string; number: string; title: string }[] }>("GET", `/t/projects/${projectId}`, { tenant: tenantId }) });
  const [contractId, setContractId] = useState("");
  const [target, setTarget] = useState("");
  const records = useQuery({ enabled: Boolean(contractId), queryKey: ["t", tenantId, "contracting", "rfi-link", contractId], queryFn: async () => {
    const [c, v] = await Promise.all([api<{ items: { id: string; number: number; title: string }[] }>("GET", `/t/contracts/${contractId}/claims`, { tenant: tenantId }),
      api<{ items: { id: string; number: number; title: string }[] }>("GET", `/t/contracts/${contractId}/variations`, { tenant: tenantId }).catch(() => ({ items: [] }))]);
    return [...c.items.map((x) => ({ value: `claim:${x.id}`, label: `مطالبة #${x.number} · ${x.title}` })), ...v.items.map((x) => ({ value: `variation:${x.id}`, label: `أمر تغيير #${x.number} · ${x.title}` }))];
  } });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!target) return setError(new Error("اختر المطالبة أو أمر التغيير"));
    const [kind, id] = target.split(":");
    setBusy(true); setError(null);
    try { await api("POST", `/t/rfis/${row.id}/link`, { tenant: tenantId, body: kind === "claim" ? { claimId: id } : { variationId: id } }); await invalidate("contracting"); onClose(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title={`ربط الاستفسار #${row.number}`}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الربط…">ربط</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <p className="muted">أثر الرد: {IMPACT[row.impact ?? "none"]}. أنشئ المطالبة أو أمر التغيير من صفحة العقد أولاً إن لم يكن موجوداً.</p>
      <SelectField label="العقد" required value={contractId} onChange={(e) => { setContractId(e.target.value); setTarget(""); }} placeholder="اختر"
        options={(project.data?.contracts ?? []).map((c) => ({ value: c.id, label: `${c.number} · ${c.title}` }))} />
      {contractId && <SelectField label="المطالبة أو أمر التغيير" required value={target} onChange={(e) => setTarget(e.target.value)} placeholder={records.isLoading ? "جارٍ التحميل…" : "اختر"}
        options={records.data ?? []} />}
      <FormError error={error} />
    </Dialog>
  );
}

function ItpTab({ projectId }: { projectId: string }) {
  const { tenantId, can, writable } = useTenant();
  const q = useQuery({ queryKey: ["t", tenantId, "contracting", "itp", projectId], queryFn: () => api<{ items: ItpItem[] }>("GET", `/t/projects/${projectId}/itp`, { tenant: tenantId }) });
  const [editing, setEditing] = useState<ItpItem | null>(null);
  return (
    <>
      <DataTable caption="خطة الفحص والاختبار" query={q} rowKey={(r) => r.id}
        empty={{ title: "لا خطة فحص للمشروع", body: "أدخل أنشطة الخطة المعتمدة من الاستشاري ونقاطها: H توقف العمل حتى الفحص، W إشعار وقد يحضر، R مراجعة مستندات." }}
        columns={[
          { key: "activity", header: "النشاط", wrap: true, cell: (r) => <span className="stack-tight"><strong>{r.activity}</strong>{!r.isActive && <Badge tone="neutral">موقوف</Badge>}</span> },
          { key: "point", header: "النقطة", cell: (r) => <Badge tone={r.point === "H" ? "danger" : r.point === "W" ? "warning" : "neutral"}>{r.point === "H" ? "H توقف" : r.point === "W" ? "W حضور" : "R مراجعة"}</Badge> },
          { key: "reference", header: "المرجع والقبول", wrap: true, cell: (r) => [r.reference, r.criteria, r.frequency].filter(Boolean).join(" · ") || "—" },
          { key: "passed", header: "مقبول", numeric: true, cell: (r) => integer(r.passed) },
          { key: "pending", header: "بانتظار", numeric: true, cell: (r) => integer(r.pending) },
        ]}
        actions={can("quality.plan") && writable ? (r) => <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>تعديل</Button> : undefined} />
      {editing && <ItpDialog projectId={projectId} row={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function ItpDialog({ projectId, row, onClose }: { projectId: string; row?: ItpItem; onClose: () => void }) {
  const { tenantId } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const [v, setV] = useState({ activity: row?.activity ?? "", point: row?.point ?? "W", reference: row?.reference ?? "", criteria: row?.criteria ?? "", frequency: row?.frequency ?? "", isActive: row?.isActive ?? true });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true); setError(null);
    const body = { activity: v.activity, point: v.point, reference: v.reference || null, criteria: v.criteria || null, frequency: v.frequency || null };
    try {
      if (row) await api("PUT", `/t/itp-items/${row.id}`, { tenant: tenantId, body: { ...body, isActive: v.isActive } });
      else await api("POST", `/t/projects/${projectId}/itp`, { tenant: tenantId, body });
      await invalidate("contracting"); onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title={row ? "تعديل بند الخطة" : "بند في خطة الفحص"}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">حفظ</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <div className="form-grid">
        <TextField label="النشاط" required value={v.activity} onChange={(e) => setV({ ...v, activity: e.target.value })} maxLength={200} />
        <SelectField label="نقطة الفحص" required value={v.point} onChange={(e) => setV({ ...v, point: e.target.value as "H" })}
          options={[{ value: "H", label: "H نقطة توقف" }, { value: "W", label: "W نقطة حضور" }, { value: "R", label: "R مراجعة مستندات" }]} />
        <TextField label="المرجع" optional value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} maxLength={200} placeholder="SBC 304، المواصفة 03300" />
        <TextField label="التكرار" optional value={v.frequency} onChange={(e) => setV({ ...v, frequency: e.target.value })} maxLength={120} placeholder="كل صبة" />
      </div>
      <TextField label="معيار القبول" optional value={v.criteria} onChange={(e) => setV({ ...v, criteria: e.target.value })} maxLength={500} />
      {row && <Checkbox label="البند ساري" checked={v.isActive} onChange={(e) => setV({ ...v, isActive: e.target.checked })} />}
      <FormError error={error} />
    </Dialog>
  );
}

// ══ Safety ══════════════════════════════════════════════════════════════════════════════════
interface Incident { id: string; number: number; occurredAt: string; kind: string; description: string; location: string | null; lostDays: number; immediateAction: string | null;
  rootCause: string | null; reportedToAuthorityOn: string | null; status: string; employee: string | null; supplier: string | null }
interface Permit { id: string; number: number; kind: string; location: string; description: string; precautions: string | null; validFrom: string; validTo: string; status: string; supplier: string | null; expired: boolean }
interface HseSummary { from: string; to: string; manhours: number; lostTime: number; recordable: number; lostDays: number; ltifr: number | null; trir: number | null; daysSinceLastLti: number | null;
  activePermits: number; expiredOpenPermits: number; byKind: Record<string, number> }

export function SafetyPage() {
  const { tenantId, can, writable } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const { projectId, picker, projects } = useProject(tenantId);
  const [tab, setTab] = useState("incidents");
  const [dialog, setDialog] = useState<"incident" | "permit" | null>(null);
  const [investigating, setInvestigating] = useState<Incident | null>(null);
  const year = isoDay().slice(0, 4);
  const summary = useQuery({ enabled: Boolean(projectId), queryKey: ["t", tenantId, "contracting", "hse-summary", projectId],
    queryFn: () => api<HseSummary>("GET", "/t/hse/summary", { tenant: tenantId, query: { projectId, from: `${year}-01-01` } }) });
  const incidents = useQuery({ enabled: Boolean(projectId), queryKey: ["t", tenantId, "contracting", "incidents", projectId], queryFn: () => api<{ items: Incident[] }>("GET", "/t/hse/incidents", { tenant: tenantId, query: { projectId } }) });
  const permits = useQuery({ enabled: Boolean(projectId), queryKey: ["t", tenantId, "contracting", "permits", projectId], queryFn: () => api<{ items: Permit[] }>("GET", "/t/work-permits", { tenant: tenantId, query: { projectId } }) });
  const s = summary.data;
  async function closePermit(p: Permit) {
    try { await api("POST", `/t/work-permits/${p.id}/close`, { tenant: tenantId }); toast.success(`أُغلق التصريح #${p.number}`); await invalidate("contracting"); }
    catch (e) { toast.error(errorMessage(e)); }
  }
  return (
    <div className="page">
      <PageHeader eyebrow="المقاولات" title="السلامة والصحة المهنية"
        description="الحوادث والتحقيق فيها وتصاريح العمل، ومعدلات الإصابات محسوبة على ساعات العمل من التقارير اليومية المقدمة."
        actions={projectId && writable ? <>
          {can("hse.permits") && <Button icon={<Plus />} onClick={() => setDialog("permit")}>تصريح عمل</Button>}
          {can("hse.record") && <Button variant="primary" icon={<ShieldAlert />} onClick={() => setDialog("incident")}>تسجيل حادث</Button>}</> : undefined} />
      <div className="toolbar">{picker}</div>
      <NeedsProject projects={projects}>
        <div className="stats">
          <StatCard label={`ساعات العمل ${year}`} value={s ? integer(s.manhours) : "—"} icon={<HardHat />} hue="indigo" note={s && !s.manhours ? "من التقارير اليومية المقدمة" : undefined} />
          <StatCard label="أيام بلا إصابة مضيعة للوقت" value={s ? (s.daysSinceLastLti === null ? "لا إصابات" : integer(s.daysSinceLastLti)) : "—"} icon={<ShieldAlert />} hue="green" />
          <StatCard label="LTIFR (لكل مليون ساعة)" value={s ? (s.ltifr === null ? "—" : s.ltifr.toFixed(2)) : "—"} icon={<ShieldAlert />} hue={s?.lostTime ? "red" : "sky"} note={s ? `${integer(s.lostTime)} إصابة، ${integer(s.lostDays)} يوم ضائع` : undefined} />
          <StatCard label="TRIR (لكل 200 ألف ساعة)" value={s ? (s.trir === null ? "—" : s.trir.toFixed(2)) : "—"} icon={<ShieldAlert />} hue="violet"
            note={s?.expiredOpenPermits ? `${integer(s.expiredOpenPermits)} تصريح منتهٍ لم يُغلق` : s ? `${integer(s.activePermits)} تصريح ساري` : undefined} noteTone={s?.expiredOpenPermits ? "warning" : undefined} />
        </div>
        <section className="panel" aria-label="سجلات السلامة">
          <div className="toolbar"><StatusTabs value={tab} onChange={setTab} options={[["incidents", "الحوادث"], ["permits", "تصاريح العمل"]]} /></div>
          {tab === "incidents" && <DataTable caption="الحوادث" query={incidents} rowKey={(r) => r.id}
            empty={{ title: "لا حوادث مسجلة", body: "سجّل كل حادث حتى الوشيك منها: الحوادث الوشيكة هي ما يمنع الإصابة القادمة." }}
            columns={[
              { key: "number", header: "الحادث", cell: (r) => <span className="stack-tight"><strong><Ref>{`#${r.number}`}</Ref></strong><span className="muted acc-small">{dayTime(r.occurredAt)}</span></span> },
              { key: "kind", header: "النوع", cell: (r) => <Badge tone={["lost_time", "fatality"].includes(r.kind) ? "danger" : r.kind === "medical_treatment" ? "warning" : "neutral"}>{INCIDENT[r.kind]}</Badge> },
              { key: "description", header: "الوصف", wrap: true, cell: (r) => <span className="stack-tight"><span>{r.description}</span><span className="muted acc-small">{[r.location, r.employee, r.supplier].filter(Boolean).join(" · ")}</span></span> },
              { key: "lostDays", header: "أيام ضائعة", numeric: true, cell: (r) => r.kind === "lost_time" ? integer(r.lostDays) : "—" },
              { key: "status", header: "التحقيق", cell: (r) => r.status === "open" ? <Badge tone="warning">مفتوح</Badge> : <Badge tone="success">مغلق</Badge> },
            ]}
            actions={can("hse.record") && writable ? (r) => r.status === "open" ? <Button size="sm" variant="ghost" onClick={() => setInvestigating(r)}>التحقيق</Button> : null : undefined} />}
          {tab === "permits" && <DataTable caption="تصاريح العمل" query={permits} rowKey={(r) => r.id}
            empty={{ title: "لا تصاريح عمل", body: "الأعمال الساخنة والأماكن المغلقة والعمل على ارتفاع والحفريات والكهرباء والرفع الثقيل تبدأ بتصريح ساري ومحدد المدة." }}
            columns={[
              { key: "number", header: "التصريح", cell: (r) => <span className="stack-tight"><strong><Ref>{`#${r.number}`}</Ref></strong><span className="muted acc-small">{PERMIT[r.kind]}</span></span> },
              { key: "description", header: "العمل والموقع", wrap: true, cell: (r) => <span className="stack-tight"><span>{r.description}</span><span className="muted acc-small">{[r.location, r.supplier].filter(Boolean).join(" · ")}</span></span> },
              { key: "validTo", header: "الصلاحية", cell: (r) => <span className="stack-tight"><span>{dayTime(r.validFrom)}</span><span className="muted acc-small">حتى {dayTime(r.validTo)}</span></span> },
              { key: "status", header: "الحالة", cell: (r) => r.status === "active" ? (r.expired ? <Badge tone="danger">منتهٍ لم يُغلق</Badge> : <Badge tone="success">ساري</Badge>) : <Badge tone="neutral">{r.status === "closed" ? "مغلق" : "ملغى"}</Badge> },
            ]}
            actions={can("hse.permits") && writable ? (r) => r.status === "active" ? <Button size="sm" variant="ghost" onClick={() => void closePermit(r)}>إغلاق التصريح</Button> : null : undefined} />}
        </section>
      </NeedsProject>
      {dialog === "incident" && <IncidentDialog projectId={projectId} onClose={() => setDialog(null)} />}
      {dialog === "permit" && <PermitDialog projectId={projectId} onClose={() => setDialog(null)} />}
      {investigating && <InvestigationDialog row={investigating} onClose={() => setInvestigating(null)} />}
    </div>
  );
}

function IncidentDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { tenantId } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const suppliers = useSuppliers(tenantId);
  const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  const [v, setV] = useState({ occurredAt: now, kind: "near_miss", description: "", location: "", supplierId: "", lostDays: "0", immediateAction: "" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true); setError(null);
    try {
      const r = await api<{ number: number }>("POST", "/t/hse/incidents", { tenant: tenantId, body: { projectId, occurredAt: new Date(v.occurredAt).toISOString(), kind: v.kind, description: v.description,
        location: v.location || null, supplierId: v.supplierId || null, lostDays: v.kind === "lost_time" ? Number(v.lostDays) || 0 : 0, immediateAction: v.immediateAction || null } });
      toast.success(`سُجّل الحادث #${r.number}`); await invalidate("contracting"); onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title="تسجيل حادث"
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">تسجيل الحادث</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <div className="form-grid">
        <TextField label="وقت الحادث" required type="datetime-local" dir="ltr" max={now} value={v.occurredAt} onChange={(e) => setV({ ...v, occurredAt: e.target.value })} />
        <SelectField label="النوع" required value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })} options={opts(INCIDENT)} />
        {v.kind === "lost_time" && <TextField label="أيام الغياب" required numeric inputMode="numeric" dir="ltr" value={v.lostDays} onChange={(e) => setV({ ...v, lostDays: e.target.value })} />}
        <TextField label="المكان" optional value={v.location} onChange={(e) => setV({ ...v, location: e.target.value })} maxLength={200} />
        <SelectField label="مقاول الباطن المعني" optional value={v.supplierId} onChange={(e) => setV({ ...v, supplierId: e.target.value })} placeholder="—"
          options={(suppliers.data?.items ?? []).map((s) => ({ value: s.id, label: s.name }))} />
      </div>
      <TextAreaField label="ما حدث" required value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} maxLength={2000} rows={3} />
      <TextAreaField label="الإجراء الفوري" optional value={v.immediateAction} onChange={(e) => setV({ ...v, immediateAction: e.target.value })} maxLength={1000} rows={2} />
      <FormError error={error} />
    </Dialog>
  );
}

function InvestigationDialog({ row, onClose }: { row: Incident; onClose: () => void }) {
  const { tenantId } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [v, setV] = useState({ lostDays: String(row.lostDays), immediateAction: row.immediateAction ?? "", rootCause: row.rootCause ?? "", reportedToAuthorityOn: row.reportedToAuthorityOn ?? "" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<"save" | "close" | null>(null);
  async function save(close: boolean) {
    if (close && !v.rootCause.trim()) return setError(new Error("سجّل السبب الجذري قبل إغلاق الحادث"));
    setBusy(close ? "close" : "save"); setError(null);
    try {
      await api("PUT", `/t/hse/incidents/${row.id}`, { tenant: tenantId, body: { lostDays: Number(v.lostDays) || 0, immediateAction: v.immediateAction || null, rootCause: v.rootCause || null,
        reportedToAuthorityOn: v.reportedToAuthorityOn || null } });
      if (close) await api("POST", `/t/hse/incidents/${row.id}/close`, { tenant: tenantId });
      toast.success(close ? `أُغلق التحقيق في الحادث #${row.number}` : "حُفظ التحقيق");
      await invalidate("contracting"); onClose();
    } catch (e) { setError(e); } finally { setBusy(null); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy !== null} onSubmit={() => void save(false)} title={`التحقيق في الحادث #${row.number}`}
      footer={<><Button type="submit" variant="primary" loading={busy === "save"} loadingText="جارٍ الحفظ…">حفظ</Button>
        <Button onClick={() => void save(true)} loading={busy === "close"} loadingText="جارٍ الإغلاق…">حفظ وإغلاق</Button><Button onClick={onClose} disabled={busy !== null}>إلغاء</Button></>}>
      <p className="muted">{INCIDENT[row.kind]} · {dayTime(row.occurredAt)} · {row.description}</p>
      <div className="form-grid">
        {row.kind === "lost_time" && <TextField label="أيام الغياب" numeric inputMode="numeric" dir="ltr" value={v.lostDays} onChange={(e) => setV({ ...v, lostDays: e.target.value })} />}
        <TextField label="تاريخ الإبلاغ للجهة المختصة" optional type="date" dir="ltr" max={isoDay()} value={v.reportedToAuthorityOn} onChange={(e) => setV({ ...v, reportedToAuthorityOn: e.target.value })}
          hint="إصابات العمل تُبلَّغ للتأمينات الاجتماعية في مهلتها." />
      </div>
      <TextAreaField label="الإجراء الفوري" optional value={v.immediateAction} onChange={(e) => setV({ ...v, immediateAction: e.target.value })} maxLength={1000} rows={2} />
      <TextAreaField label="السبب الجذري والإجراء الوقائي" optional value={v.rootCause} onChange={(e) => setV({ ...v, rootCause: e.target.value })} maxLength={1000} rows={3} />
      <FormError error={error} />
    </Dialog>
  );
}

function PermitDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { tenantId } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const suppliers = useSuppliers(tenantId);
  const local = (ms: number) => new Date(ms - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  const [v, setV] = useState({ kind: "hot_work", location: "", description: "", precautions: "", supplierId: "", validFrom: local(Date.now()), validTo: local(Date.now() + 10 * 3_600_000) });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true); setError(null);
    try {
      const r = await api<{ number: number }>("POST", "/t/work-permits", { tenant: tenantId, body: { projectId, kind: v.kind, location: v.location, description: v.description, precautions: v.precautions || null,
        supplierId: v.supplierId || null, validFrom: new Date(v.validFrom).toISOString(), validTo: new Date(v.validTo).toISOString() } });
      toast.success(`صدر تصريح العمل #${r.number}`); await invalidate("contracting"); onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title="تصريح عمل"
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الإصدار…">إصدار التصريح</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <div className="form-grid">
        <SelectField label="النوع" required value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })} options={opts(PERMIT)} />
        <TextField label="المكان" required value={v.location} onChange={(e) => setV({ ...v, location: e.target.value })} maxLength={200} />
        <TextField label="من" required type="datetime-local" dir="ltr" value={v.validFrom} onChange={(e) => setV({ ...v, validFrom: e.target.value })} />
        <TextField label="إلى" required type="datetime-local" dir="ltr" value={v.validTo} onChange={(e) => setV({ ...v, validTo: e.target.value })} hint="سبعة أيام على الأكثر." />
      </div>
      <TextAreaField label="العمل" required value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} maxLength={1000} rows={2} />
      <TextAreaField label="الاحتياطات" required={["hot_work", "confined_space"].includes(v.kind)} optional={!["hot_work", "confined_space"].includes(v.kind)} value={v.precautions}
        onChange={(e) => setV({ ...v, precautions: e.target.value })} maxLength={1000} rows={2} placeholder="فحص الغاز، طفاية، مراقب حريق، عزل المصدر…" />
      <SelectField label="المنفّذ (مقاول باطن)" optional value={v.supplierId} onChange={(e) => setV({ ...v, supplierId: e.target.value })} placeholder="فريقنا"
        options={(suppliers.data?.items ?? []).map((s) => ({ value: s.id, label: s.name }))} />
      <FormError error={error} />
    </Dialog>
  );
}

// ══ Documents ═══════════════════════════════════════════════════════════════════════════════
interface DocRow { id: string; number: string; title: string; docType: string; discipline: string; latestRevision: string | null; latestRevisionId: string | null; reviewCode: string | null; revisions: number }
interface Revision { id: string; revision: string; filename: string; mime: string; sizeBytes: number; sha256: string; notes: string | null; createdAt: string; uploadedBy: string | null;
  reviewCode: string | null; reviewedOn: string | null; reviewer: string | null; reviewComments: string | null; transmittals: { number: number; recipient: string; purpose: string; sentOn: string }[] }
interface DocDetail { id: string; number: string; title: string; docType: string; discipline: string; revisions: Revision[]; suggestedRevision: string }
interface Transmittal { id: string; number: number; recipient: string; purpose: string; sentOn: string; notes: string | null; items: { document: string; title: string; revision: string }[] }

export function DocumentsPage() {
  const { tenantId, can, writable } = useTenant();
  const { projectId, picker, projects } = useProject(tenantId);
  const [tab, setTab] = useState("register");
  const [dialog, setDialog] = useState<"doc" | "transmittal" | null>(null);
  const [openDoc, setOpenDoc] = useState<string | null>(null);
  const [type, setType] = useState("");
  const docs = useQuery({ enabled: Boolean(projectId), queryKey: ["t", tenantId, "contracting", "documents", projectId, type],
    queryFn: () => api<{ items: DocRow[] }>("GET", `/t/projects/${projectId}/documents`, { tenant: tenantId, query: type ? { docType: type } : {} }) });
  const transmittals = useQuery({ enabled: Boolean(projectId) && tab === "transmittals", queryKey: ["t", tenantId, "contracting", "transmittals", projectId],
    queryFn: () => api<{ items: Transmittal[] }>("GET", `/t/projects/${projectId}/transmittals`, { tenant: tenantId }) });
  return (
    <div className="page">
      <PageHeader eyebrow="المقاولات" title="ضبط الوثائق"
        description="سجل المخططات والمواصفات واعتمادات المواد بإصداراتها كملفات لا تُستبدل، ومراجعة الاستشاري لكل إصدار، وخطابات الإرسال."
        actions={projectId && writable ? <>
          {can("documents.transmit") && <Button icon={<Send />} onClick={() => setDialog("transmittal")}>خطاب إرسال</Button>}
          {can("documents.upload") && <Button variant="primary" icon={<Plus />} onClick={() => setDialog("doc")}>وثيقة جديدة</Button>}</> : undefined} />
      <div className="toolbar row" style={{ gap: "var(--sp-2)" }}>{picker}
        {tab === "register" && <SelectField label="النوع" value={type} onChange={(e) => setType(e.target.value)} placeholder="كل الأنواع" options={opts(DOC_TYPE)} />}</div>
      <NeedsProject projects={projects}>
        <section className="panel" aria-label="الوثائق">
          <div className="toolbar"><StatusTabs value={tab} onChange={setTab} options={[["register", "سجل الوثائق"], ["transmittals", "خطابات الإرسال"]]} /></div>
          {tab === "register" && <DataTable caption="سجل الوثائق" query={docs} rowKey={(r) => r.id} onRowClick={(r) => setOpenDoc(r.id)}
            empty={type ? { title: "لا وثائق من هذا النوع", body: "غيّر النوع أو اختر «كل الأنواع»." } : { title: "لا وثائق بعد", body: "سجّل الوثيقة برقمها ثم ارفع إصداراتها: كل إصدار ملف محفوظ كما رُفع، ومراجعة الاستشاري عليه." }}
            columns={[
              { key: "number", header: "الرقم", cell: (r) => <span className="stack-tight"><strong><Ref>{r.number}</Ref></strong><span className="muted acc-small">{DOC_TYPE[r.docType]} · {DISCIPLINE[r.discipline]}</span></span> },
              { key: "title", header: "العنوان", wrap: true, cell: (r) => r.title },
              { key: "latestRevision", header: "آخر إصدار", cell: (r) => r.latestRevision ? <Ref>{r.latestRevision}</Ref> : <span className="muted">لا ملف</span> },
              { key: "reviewCode", header: "مراجعة الاستشاري", cell: (r) => r.reviewCode ? <Badge tone={REVIEW[r.reviewCode]![1]}>{REVIEW[r.reviewCode]![0]}</Badge> : <span className="muted">—</span> },
              { key: "revisions", header: "الإصدارات", numeric: true, cell: (r) => integer(r.revisions) },
            ]} />}
          {tab === "transmittals" && <DataTable caption="خطابات الإرسال" query={transmittals} rowKey={(r) => r.id}
            empty={{ title: "لا خطابات إرسال", body: "خطاب الإرسال يثبت أي إصدار ذهب لمن ولماذا. ما يُرسل للتنفيذ من المخططات التنفيذية واعتمادات المواد يشترط اعتماد الاستشاري (A أو B)." }}
            columns={[
              { key: "number", header: "الخطاب", cell: (r) => <span className="stack-tight"><strong><Ref>{`TR-${r.number}`}</Ref></strong><span className="muted acc-small">{day(r.sentOn)}</span></span> },
              { key: "recipient", header: "إلى", cell: (r) => <span className="stack-tight"><span>{r.recipient}</span><span className="muted acc-small">{PURPOSE[r.purpose]}</span></span> },
              { key: "items", header: "الإصدارات", wrap: true, sortKey: false, cell: (r) => r.items.map((i) => `${i.document} (${i.revision})`).join("، ") },
            ]} />}
        </section>
      </NeedsProject>
      {dialog === "doc" && <DocDialog projectId={projectId} onClose={() => setDialog(null)} onCreated={(id) => { setDialog(null); setOpenDoc(id); }} />}
      {dialog === "transmittal" && <TransmittalDialog projectId={projectId} docs={docs.data?.items ?? []} onClose={() => setDialog(null)} />}
      {openDoc && <DocumentDialog id={openDoc} onClose={() => setOpenDoc(null)} />}
    </div>
  );
}

function DocDialog({ projectId, onClose, onCreated }: { projectId: string; onClose: () => void; onCreated: (id: string) => void }) {
  const { tenantId } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const [v, setV] = useState({ number: "", title: "", docType: "drawing", discipline: "architectural" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true); setError(null);
    try { const r = await api<{ id: string }>("POST", `/t/projects/${projectId}/documents`, { tenant: tenantId, body: v }); await invalidate("contracting"); onCreated(r.id); }
    catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title="وثيقة جديدة"
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">تسجيل ورفع الإصدار</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <div className="form-grid">
        <TextField label="رقم الوثيقة" required dir="ltr" value={v.number} onChange={(e) => setV({ ...v, number: e.target.value })} maxLength={60} placeholder="SD-STR-001" />
        <SelectField label="النوع" required value={v.docType} onChange={(e) => setV({ ...v, docType: e.target.value })} options={opts(DOC_TYPE)} />
        <SelectField label="التخصص" required value={v.discipline} onChange={(e) => setV({ ...v, discipline: e.target.value })} options={opts(DISCIPLINE)} />
      </div>
      <TextField label="العنوان" required value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} maxLength={200} />
      <FormError error={error} />
    </Dialog>
  );
}

function DocumentDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { tenantId, can, writable } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const q = useQuery({ queryKey: ["t", tenantId, "contracting", "document", id], queryFn: () => api<DocDetail>("GET", `/t/documents/${id}`, { tenant: tenantId }) });
  const [file, setFile] = useState<File | null>(null);
  const [rev, setRev] = useState("");
  const [notes, setNotes] = useState("");
  const [reviewing, setReviewing] = useState<Revision | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const d = q.data;
  async function upload() {
    if (!file) return setError(new Error("اختر ملف الإصدار"));
    if (file.size > 15 * 1024 * 1024) return setError(new Error("حجم الملف أكبر من 15 ميجابايت"));
    setBusy(true); setError(null);
    const fd = new FormData();
    fd.append("file", file);
    try {
      const query: Record<string, string> = {};
      if (rev.trim()) query["revision"] = rev.trim().toUpperCase();
      if (notes.trim()) query["notes"] = notes.trim();
      const r = await api<{ revision: string }>("POST", `/t/documents/${id}/revisions`, { tenant: tenantId, body: fd, query });
      toast.success(`رُفع الإصدار ${r.revision}`); setFile(null); setRev(""); setNotes("");
      await invalidate("contracting");
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  async function get(r: Revision) {
    try { await download(`/t/document-revisions/${r.id}/file`, tenantId, r.filename); } catch (e) { toast.error(errorMessage(e)); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} wide title={d ? `${d.number} · ${d.title}` : "الوثيقة"}
      footer={<Button onClick={onClose} disabled={busy}>إغلاق</Button>}>
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {d && <>
        <p className="muted">{DOC_TYPE[d.docType]} · {DISCIPLINE[d.discipline]}</p>
        {can("documents.upload") && writable && <fieldset className="panel" style={{ padding: "var(--sp-3)" }}>
          <legend className="acc-small">رفع إصدار</legend>
          <div className="form-grid">
            <div className="field">
              <label className="field-label" htmlFor="rev-file">الملف (PDF أو صورة أو DWG، حتى 15 ميجابايت)</label>
              <input id="rev-file" className="input" type="file" accept=".pdf,.png,.jpg,.jpeg,.dwg" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(null); }} style={{ paddingBlock: "var(--sp-1)" }} />
            </div>
            <TextField label="رمز الإصدار" optional dir="ltr" value={rev} onChange={(e) => setRev(e.target.value)} maxLength={4} placeholder={d.suggestedRevision} hint={`التالي: ${d.suggestedRevision}`} />
            <TextField label="ملاحظة" optional value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
          </div>
          <Button variant="primary" icon={<Upload />} onClick={() => void upload()} loading={busy} loadingText="جارٍ الرفع…">رفع الإصدار</Button>
          <FormError error={error} />
        </fieldset>}
        <DataTable caption="الإصدارات" query={{ ...q, data: { items: d.revisions } }} rowKey={(r) => r.id}
          empty={{ title: "لا إصدارات", body: "ارفع أول إصدار للوثيقة." }}
          columns={[
            { key: "revision", header: "الإصدار", cell: (r) => <span className="stack-tight"><strong><Ref>{r.revision}</Ref></strong><span className="muted acc-small">{dayTime(r.createdAt)}{r.uploadedBy ? ` · ${r.uploadedBy}` : ""}</span></span> },
            { key: "filename", header: "الملف", wrap: true, cell: (r) => <span className="stack-tight"><span>{r.filename}</span><span className="muted acc-small">{integer(Math.ceil(r.sizeBytes / 1024))} ك.ب{r.notes ? ` · ${r.notes}` : ""}</span></span> },
            { key: "reviewCode", header: "مراجعة الاستشاري", wrap: true, cell: (r) => r.reviewCode ? <span className="stack-tight"><Badge tone={REVIEW[r.reviewCode]![1]}>{REVIEW[r.reviewCode]![0]}</Badge>
              <span className="muted acc-small">{day(r.reviewedOn)}{r.reviewer ? ` · ${r.reviewer}` : ""}{r.reviewComments ? ` · ${r.reviewComments}` : ""}</span></span> : <span className="muted">—</span> },
            { key: "transmittals", header: "أُرسل", sortKey: false, cell: (r) => r.transmittals.length ? r.transmittals.map((t) => `TR-${t.number} ${t.recipient}`).join("، ") : "—" },
          ]}
          actions={(r) => <>
            <Button size="sm" variant="ghost" icon={<Download />} aria-label={`تنزيل الإصدار ${r.revision}`} onClick={() => void get(r)}>تنزيل</Button>
            {!r.reviewCode && can("documents.review") && writable && <Button size="sm" variant="ghost" onClick={() => setReviewing(r)}>المراجعة</Button>}</>} />
      </>}
      {reviewing && <ReviewDialog row={reviewing} onClose={() => setReviewing(null)} />}
    </Dialog>
  );
}

function ReviewDialog({ row, onClose }: { row: Revision; onClose: () => void }) {
  const { tenantId } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const [v, setV] = useState({ code: "A", reviewedOn: isoDay(), reviewer: "", comments: "" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (v.code !== "A" && !v.comments.trim()) return setError(new Error("اكتب ملاحظات الاستشاري"));
    setBusy(true); setError(null);
    try { await api("POST", `/t/document-revisions/${row.id}/review`, { tenant: tenantId, body: { ...v, reviewer: v.reviewer || null, comments: v.comments || null } }); await invalidate("contracting"); onClose(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title={`مراجعة الإصدار ${row.revision}`}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">تسجيل المراجعة</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <div className="form-grid">
        <SelectField label="رمز المراجعة" required value={v.code} onChange={(e) => setV({ ...v, code: e.target.value })} options={Object.entries(REVIEW).map(([value, [label]]) => ({ value, label }))} />
        <TextField label="تاريخ المراجعة" required type="date" dir="ltr" max={isoDay()} value={v.reviewedOn} onChange={(e) => setV({ ...v, reviewedOn: e.target.value })} />
        <TextField label="المراجع" optional value={v.reviewer} onChange={(e) => setV({ ...v, reviewer: e.target.value })} maxLength={120} />
      </div>
      <TextAreaField label="ملاحظات الاستشاري" required={v.code !== "A"} optional={v.code === "A"} value={v.comments} onChange={(e) => setV({ ...v, comments: e.target.value })} maxLength={1000} rows={3} />
      <p className="muted acc-small">المراجعة لا تُعدَّل. C وD تُعاد بإصدار جديد.</p>
      <FormError error={error} />
    </Dialog>
  );
}

function TransmittalDialog({ projectId, docs, onClose }: { projectId: string; docs: DocRow[]; onClose: () => void }) {
  const { tenantId } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const withFiles = docs.filter((d) => d.latestRevisionId);
  const [v, setV] = useState({ recipient: "", purpose: "for_approval", sentOn: isoDay(), notes: "" });
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!picked.length) return setError(new Error("اختر الوثائق المرسلة"));
    setBusy(true); setError(null);
    try {
      const r = await api<{ number: number }>("POST", `/t/projects/${projectId}/transmittals`, { tenant: tenantId, body: { ...v, notes: v.notes || null, revisionIds: picked } });
      toast.success(`صدر خطاب الإرسال TR-${r.number}`); await invalidate("contracting"); onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title="خطاب إرسال" wide
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الإصدار…">إصدار الخطاب</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <div className="form-grid">
        <TextField label="إلى" required value={v.recipient} onChange={(e) => setV({ ...v, recipient: e.target.value })} maxLength={200} placeholder="الاستشاري، المالك، مقاول الباطن" />
        <SelectField label="الغرض" required value={v.purpose} onChange={(e) => setV({ ...v, purpose: e.target.value })} options={opts(PURPOSE)} />
        <TextField label="تاريخ الإرسال" required type="date" dir="ltr" max={isoDay()} value={v.sentOn} onChange={(e) => setV({ ...v, sentOn: e.target.value })} />
      </div>
      {withFiles.length ? <fieldset className="stack-tight">
        <legend className="field-label">آخر إصدار من كل وثيقة</legend>
        {withFiles.map((d) => <Checkbox key={d.id} label={`${d.number} (${d.latestRevision}) · ${d.title}${d.reviewCode ? ` · ${REVIEW[d.reviewCode]![0]}` : ""}`} checked={picked.includes(d.latestRevisionId!)}
          onChange={(e) => setPicked(e.target.checked ? [...picked, d.latestRevisionId!] : picked.filter((x) => x !== d.latestRevisionId))} />)}
      </fieldset> : <p className="muted">لا وثائق لها ملفات بعد.</p>}
      <TextField label="ملاحظة" optional value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} maxLength={500} />
      <FormError error={error} />
    </Dialog>
  );
}

// ══ Daily site reports ══════════════════════════════════════════════════════════════════════
interface DailyRow { id: string; reportDate: string; weather: string | null; temperature: number | null; status: string; headcount: number; manhours: number; equipmentHours: number }
interface Manpower { trade: string; supplierId: string | null; headcount: number; hours: number }
interface Equip { machineId: string | null; description: string; workingHours: number; idleHours: number }
interface DailyReport { id: string; reportDate: string; weather: string | null; temperature: number | null; workDone: string | null; issues: string | null; status: string; submittedAt: string | null;
  submittedBy: string | null; manpower: Manpower[]; equipment: Equip[] }

export function DailyReportsPage() {
  const { tenantId, can, writable } = useTenant();
  const { projectId, picker, projects } = useProject(tenantId);
  const [date, setDate] = useState<string | null>(null);
  const q = useQuery({ enabled: Boolean(projectId), queryKey: ["t", tenantId, "contracting", "daily-reports", projectId],
    queryFn: () => api<{ items: DailyRow[] }>("GET", "/t/daily-reports", { tenant: tenantId, query: { projectId } }) });
  const today = isoDay();
  const hasToday = (q.data?.items ?? []).some((r) => r.reportDate === today);
  return (
    <div className="page">
      <PageHeader eyebrow="المقاولات" title="التقارير اليومية للموقع"
        description="ما نُفّذ اليوم والطقس والعمالة بالمهنة والجهة وساعات المعدات والمعوقات. التقرير المقدَّم نهائي، وساعات عمالته أساس معدلات السلامة."
        actions={can("daily_reports.write") && writable && projectId ? <Button variant="primary" icon={<FileStack />} onClick={() => setDate(today)}>{hasToday ? "تقرير اليوم" : "كتابة تقرير اليوم"}</Button> : undefined} />
      <div className="toolbar">{picker}</div>
      <NeedsProject projects={projects}>
        <section className="panel" aria-label="التقارير اليومية">
          <DataTable caption="التقارير اليومية" query={q} rowKey={(r) => r.id} onRowClick={(r) => setDate(r.reportDate)}
            empty={{ title: "لا تقارير يومية", body: "اكتب تقرير اليوم: الأعمال المنفذة والعمالة والمعدات. يُحفظ مسودة حتى تقدّمه." }}
            columns={[
              { key: "reportDate", header: "اليوم", cell: (r) => <strong>{day(r.reportDate)}</strong> },
              { key: "weather", header: "الطقس", cell: (r) => r.weather ? `${WEATHER[r.weather]}${r.temperature !== null ? ` ${r.temperature}°` : ""}` : "—" },
              { key: "headcount", header: "العمالة", numeric: true, cell: (r) => integer(r.headcount) },
              { key: "manhours", header: "ساعات العمل", numeric: true, cell: (r) => integer(r.manhours) },
              { key: "equipmentHours", header: "ساعات المعدات", numeric: true, cell: (r) => integer(r.equipmentHours) },
              { key: "status", header: "الحالة", cell: (r) => r.status === "submitted" ? <Badge tone="success">مقدَّم</Badge> : <Badge tone="warning">مسودة</Badge> },
            ]} />
        </section>
      </NeedsProject>
      {date && projectId && <DailyDialog projectId={projectId} date={date} onClose={() => setDate(null)} />}
    </div>
  );
}

function DailyDialog({ projectId, date, onClose }: { projectId: string; date: string; onClose: () => void }) {
  const { tenantId, can, writable } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const suppliers = useSuppliers(tenantId);
  const q = useQuery({ queryKey: ["t", tenantId, "contracting", "daily-report", projectId, date], queryFn: () => api<{ report: DailyReport | null }>("GET", `/t/projects/${projectId}/daily-reports/${date}`, { tenant: tenantId }) });
  const r = q.data?.report ?? null;
  const final = r?.status === "submitted" || !can("daily_reports.write") || !writable;
  const [v, setV] = useState<{ weather: string; temperature: string; workDone: string; issues: string; manpower: { trade: string; supplierId: string; headcount: string; hours: string }[];
    equipment: { description: string; workingHours: string; idleHours: string }[] } | null>(null);
  useEffect(() => {
    if (!q.data || v) return;
    setV({ weather: r?.weather ?? "", temperature: r?.temperature === null || r?.temperature === undefined ? "" : String(r.temperature), workDone: r?.workDone ?? "", issues: r?.issues ?? "",
      manpower: r?.manpower.length ? r.manpower.map((m) => ({ trade: m.trade, supplierId: m.supplierId ?? "", headcount: String(m.headcount), hours: String(m.hours) })) : [{ trade: "", supplierId: "", headcount: "", hours: "10" }],
      equipment: (r?.equipment ?? []).map((e) => ({ description: e.description, workingHours: String(e.workingHours), idleHours: String(e.idleHours) })) });
  }, [q.data, r, v]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<"save" | "submit" | null>(null);
  const [confirm, setConfirm] = useState(false);
  async function save(): Promise<string | null> {
    if (!v) return null;
    const body = { weather: v.weather || null, temperature: v.temperature === "" ? null : Number(v.temperature), workDone: v.workDone || null, issues: v.issues || null,
      manpower: v.manpower.filter((m) => m.trade.trim() && Number(m.headcount) > 0).map((m) => ({ trade: m.trade.trim(), supplierId: m.supplierId || null, headcount: Number(m.headcount), hours: Number(m.hours) })),
      equipment: v.equipment.filter((e) => e.description.trim()).map((e) => ({ description: e.description.trim(), workingHours: Number(e.workingHours) || 0, idleHours: Number(e.idleHours) || 0 })) };
    return (await api<{ id: string }>("PUT", `/t/projects/${projectId}/daily-reports/${date}`, { tenant: tenantId, body })).id;
  }
  async function onSave() {
    setBusy("save"); setError(null);
    try { await save(); toast.success("حُفظت المسودة"); await invalidate("contracting"); onClose(); } catch (e) { setError(e); } finally { setBusy(null); }
  }
  async function onSubmit() {
    setBusy("submit"); setError(null);
    try { const id = await save(); if (id) await api("POST", `/t/daily-reports/${id}/submit`, { tenant: tenantId }); setConfirm(false); toast.success(`قُدّم تقرير ${day(date)}`); await invalidate("contracting"); onClose(); }
    catch (e) { setConfirm(false); setError(e); } finally { setBusy(null); }
  }
  const total = v ? v.manpower.reduce((a, m) => a + (Number(m.headcount) || 0) * (Number(m.hours) || 0), 0) : 0;
  return (
    <Dialog open onClose={onClose} busy={busy !== null} wide onSubmit={final ? undefined : () => void onSave()} title={`التقرير اليومي ${day(date)}`}
      footer={final ? <Button onClick={onClose}>إغلاق</Button> : <>
        <Button type="submit" variant="primary" loading={busy === "save"} loadingText="جارٍ الحفظ…">حفظ المسودة</Button>
        {can("daily_reports.submit") && <Button icon={<Send />} onClick={() => setConfirm(true)} disabled={busy !== null}>تقديم التقرير</Button>}
        <Button onClick={onClose} disabled={busy !== null}>إلغاء</Button></>}>
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {r?.status === "submitted" && <p className="muted">قُدّم {dayTime(r.submittedAt)}{r.submittedBy ? ` بواسطة ${r.submittedBy}` : ""}. التقرير المقدَّم لا يُعدَّل.</p>}
      {v && <>
        <div className="form-grid">
          <SelectField label="الطقس" optional disabled={final} value={v.weather} onChange={(e) => setV({ ...v, weather: e.target.value })} placeholder="—" options={opts(WEATHER)} />
          <TextField label="الحرارة (°م)" optional disabled={final} numeric inputMode="decimal" dir="ltr" value={v.temperature} onChange={(e) => setV({ ...v, temperature: e.target.value })} />
        </div>
        <TextAreaField label="الأعمال المنفذة" required disabled={final} value={v.workDone} onChange={(e) => setV({ ...v, workDone: e.target.value })} maxLength={4000} rows={4} />
        <TextAreaField label="المعوقات والملاحظات" optional disabled={final} value={v.issues} onChange={(e) => setV({ ...v, issues: e.target.value })} maxLength={2000} rows={2} />
        <fieldset className="stack-tight">
          <legend className="field-label">العمالة · {integer(total)} ساعة عمل</legend>
          {v.manpower.map((m, i) => (
            <div key={i} className="form-grid">
              <TextField label="المهنة" disabled={final} value={m.trade} onChange={(e) => setV({ ...v, manpower: v.manpower.map((x, j) => j === i ? { ...x, trade: e.target.value } : x) })} maxLength={80} placeholder="نجارون" />
              <SelectField label="الجهة" disabled={final} value={m.supplierId} onChange={(e) => setV({ ...v, manpower: v.manpower.map((x, j) => j === i ? { ...x, supplierId: e.target.value } : x) })} placeholder="فريقنا"
                options={(suppliers.data?.items ?? []).map((s) => ({ value: s.id, label: s.name }))} />
              <TextField label="العدد" disabled={final} numeric inputMode="numeric" dir="ltr" value={m.headcount} onChange={(e) => setV({ ...v, manpower: v.manpower.map((x, j) => j === i ? { ...x, headcount: e.target.value } : x) })} />
              <TextField label="الساعات" disabled={final} numeric inputMode="decimal" dir="ltr" value={m.hours} onChange={(e) => setV({ ...v, manpower: v.manpower.map((x, j) => j === i ? { ...x, hours: e.target.value } : x) })} />
            </div>
          ))}
          {!final && <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => setV({ ...v, manpower: [...v.manpower, { trade: "", supplierId: "", headcount: "", hours: "10" }] })}>مهنة أخرى</Button>}
        </fieldset>
        <fieldset className="stack-tight">
          <legend className="field-label">المعدات</legend>
          {v.equipment.map((e, i) => (
            <div key={i} className="form-grid">
              <TextField label="المعدة" disabled={final} value={e.description} onChange={(x) => setV({ ...v, equipment: v.equipment.map((y, j) => j === i ? { ...y, description: x.target.value } : y) })} maxLength={120} />
              <TextField label="ساعات التشغيل" disabled={final} numeric inputMode="decimal" dir="ltr" value={e.workingHours} onChange={(x) => setV({ ...v, equipment: v.equipment.map((y, j) => j === i ? { ...y, workingHours: x.target.value } : y) })} />
              <TextField label="ساعات التوقف" disabled={final} numeric inputMode="decimal" dir="ltr" value={e.idleHours} onChange={(x) => setV({ ...v, equipment: v.equipment.map((y, j) => j === i ? { ...y, idleHours: x.target.value } : y) })} />
            </div>
          ))}
          {!final && <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => setV({ ...v, equipment: [...v.equipment, { description: "", workingHours: "8", idleHours: "0" }] })}>معدة</Button>}
          {!v.equipment.length && final && <p className="muted">لا معدات.</p>}
        </fieldset>
        <FormError error={error} />
      </>}
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} busy={busy === "submit"} destructive={false} onConfirm={() => void onSubmit()}
        title={`تقديم تقرير ${day(date)}؟`} confirmLabel="تقديم التقرير" message="يُحفظ ويصبح نهائياً لا يُعدَّل، وتدخل ساعات عمالته في معدلات السلامة." />
    </Dialog>
  );
}
