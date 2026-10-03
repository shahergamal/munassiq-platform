import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { BadgeCheck, Building, Download, FileSignature, HandCoins, Plus, ShieldAlert, Trash2, Upload } from "lucide-react";
import { useState } from "react";
import { api, ApiError, download, errorMessage } from "../../api/client";
import { useIdempotencyKey } from "../../app/session";
import { useInvalidate, useTenant } from "../../app/tenant";
import { day, integer, isoDay, money, percent, quantity, text } from "../../lib/format";
import { Button, IconButton } from "../../ui/Button";
import { DataTable } from "../../ui/DataTable";
import { ConfirmDialog, Dialog } from "../../ui/Dialog";
import { Checkbox, SelectField, TextAreaField, TextField } from "../../ui/Field";
import { ActionMenu, Badge, PageHeader, StatCard } from "../../ui/Layout";
import { ErrorState, FormError, TableSkeleton } from "../../ui/States";
import { useToast } from "../../ui/Toast";
import { StatusTabs } from "./Inventory";
import { CustomerPicker } from "./pickers";
import { DeductionsPanel, RecordInvoiceDialog, ReleaseDialog, SubAdvanceDialog, useSubcontractors, type Deduction } from "./Subcontracting";

// Contracting (C1–C3): projects, the contract with its bill of quantities, the client's payment certificates (IPCs)
// and their tax invoices, variation orders, claims and bank guarantees. Every figure (retention, advance recovery,
// delay damages, VAT) is computed by the server; the browser sends quantities and decisions only.

const num = (s: string) => Number(s.replace(/,/g, ""));
const Ref = ({ children }: { children: string }) => <bdi dir="ltr" className="num">{children}</bdi>;
const REGIMES: Record<string, string> = { GTPL_1440: "نظام المنافسات 1440هـ", GTPL_1448: "نظام المنافسات 1448هـ", PRIVATE: "عقد خاص" };
const PRICING: Record<string, string> = { LUMP_SUM: "مقطوعية", UNIT_PRICE: "أسعار وحدات", COST_PLUS: "التكلفة زائد", GMP: "سقف مضمون", T_AND_M: "وقت ومواد", RATE_CARD: "جدول أسعار" };
const PROJECT_STATUS: Record<string, [string, "neutral" | "info" | "success" | "warning"]> = {
  planning: ["تخطيط", "neutral"], active: ["قيد التنفيذ", "info"], completed: ["مكتمل", "success"], closed: ["مغلق", "neutral"] };
const CONTRACT_STATUS: Record<string, [string, "neutral" | "info" | "success" | "warning"]> = {
  draft: ["مسودة", "warning"], active: ["مفعّل", "info"], completed: ["مكتمل", "success"], closed: ["مغلق", "neutral"] };
const IPC_STATUS: Record<string, [string, "neutral" | "info" | "success" | "warning"]> = {
  draft: ["مسودة", "neutral"], submitted: ["مقدَّم", "warning"], certified: ["اعتمده الاستشاري", "info"], approved: ["اعتمده العميل", "info"], invoiced: ["مفوتر", "success"] };
const Status = ({ map, value }: { map: Record<string, [string, "neutral" | "info" | "success" | "warning"]>; value: string }) =>
  <Badge tone={map[value]?.[1] ?? "neutral"}>{map[value]?.[0] ?? value}</Badge>;

interface Reference {
  specialties: { code: string; name: string; definition: { wbsLevels: string[]; units: { code: string; name: string }[] } }[];
  profiles: { code: string; name: string; defaults: { retentionPct: number; retentionCapPct: number; advancePct: number; dlpMonths: number; claimNoticeDays: number } }[];
}
const useReference = (tenantId: string) =>
  useQuery({ queryKey: ["t", tenantId, "contracting", "reference"], staleTime: 5 * 60_000, queryFn: () => api<Reference>("GET", "/t/contracting/reference", { tenant: tenantId }) });

// ── Projects ──────────────────────────────────────────────────────────────────────────────────
interface ProjectRow { id: string; code: string; name: string; status: string; specialtyName: string; clientName: string | null; location: string | null; contracts: number;
  contractValue: number; nextPermitExpiry: string | null }
interface Alerts { guarantees: { id: string; kind: string; number: string; bank: string; amount: number; expiresOn: string; daysLeft: number; contractId: string; contractNumber: string }[];
  permits: { id: string; kind: string; number: string; expiresOn: string; daysLeft: number; projectId: string; projectCode: string }[] }

export function ProjectsPage() {
  const { tenantId, can, writable } = useTenant();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ["t", tenantId, "contracting", "projects"], queryFn: () => api<{ items: ProjectRow[] }>("GET", "/t/projects", { tenant: tenantId }) });
  const alerts = useQuery({ queryKey: ["t", tenantId, "contracting", "alerts"], enabled: can("guarantees.view"),
    queryFn: () => api<Alerts>("GET", "/t/contracting/alerts", { tenant: tenantId }) });
  const [adding, setAdding] = useState(false);
  const items = q.data?.items ?? [];
  const soon = (alerts.data?.guarantees.length ?? 0) + (alerts.data?.permits.length ?? 0);
  return (
    <div className="page">
      <PageHeader eyebrow="المقاولات" title="المشاريع"
        description="كل مشروع مركز تكلفة مستقل تُحمَّل عليه قيوده، وتحته عقوده وجداول كمياتها ومستخلصاتها."
        actions={can("projects.create") && writable ? <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>مشروع جديد</Button> : undefined} />
      <div className="stats">
        <StatCard label="مشاريع قيد التنفيذ" value={q.data ? integer(items.filter((p) => p.status === "active").length) : "—"} icon={<Building />} hue="indigo" />
        <StatCard label="قيمة العقود الرئيسية" value={q.data ? money(items.reduce((a, p) => a + p.contractValue, 0)) : "—"} icon={<FileSignature />} hue="sky" />
        <StatCard label="ضمانات وتصاريح تنتهي خلال 60 يوماً" value={alerts.data ? integer(soon) : "—"} icon={<ShieldAlert />} hue={soon ? "amber" : "green"} />
      </div>
      {alerts.data && soon > 0 && (
        <section className="panel panel-pad stack-tight" aria-label="تنبيهات الانتهاء">
          <h2 className="acc-small">تنتهي قريباً</h2>
          <ul className="stack-tight" style={{ margin: 0, paddingInlineStart: "var(--sp-4)" }}>
            {alerts.data.guarantees.map((g) => (
              <li key={g.id}>ضمان {GUARANTEE_KIND[g.kind]} رقم <Ref>{g.number}</Ref> ({g.bank}، {money(g.amount)}) على العقد{" "}
                <Link to="/w/$tenantId/contracting/contracts/$contractId" params={{ tenantId, contractId: g.contractId }}><Ref>{g.contractNumber}</Ref></Link>{" "}
                ينتهي {day(g.expiresOn)} <Badge tone={g.daysLeft < 15 ? "danger" : "warning"}>{g.daysLeft < 0 ? "منتهٍ" : `بعد ${integer(g.daysLeft)} يوماً`}</Badge></li>
            ))}
            {alerts.data.permits.map((p) => (
              <li key={p.id}>{p.kind} رقم <Ref>{p.number}</Ref> للمشروع <Ref>{p.projectCode}</Ref> ينتهي {day(p.expiresOn)}{" "}
                <Badge tone={p.daysLeft < 15 ? "danger" : "warning"}>{p.daysLeft < 0 ? "منتهٍ" : `بعد ${integer(p.daysLeft)} يوماً`}</Badge></li>
            ))}
          </ul>
        </section>
      )}
      <section className="panel" aria-label="المشاريع">
        <DataTable caption="المشاريع" query={q} rowKey={(r) => r.id}
          onRowClick={(r) => void navigate({ to: "/w/$tenantId/contracting/projects/$projectId", params: { tenantId, projectId: r.id } })}
          empty={{ title: "لا مشاريع بعد", body: "أضف مشروعك الأول، ثم عقده مع العميل وجدول كمياته.",
            action: can("projects.create") && writable ? <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>مشروع جديد</Button> : undefined }}
          columns={[
            { key: "name", header: "المشروع", cell: (r) => <span className="stack-tight"><strong>{r.name}</strong><span className="muted num acc-small">{r.code}</span></span> },
            { key: "clientName", header: "العميل", cell: (r) => text(r.clientName) },
            { key: "specialtyName", header: "التخصص", cell: (r) => r.specialtyName },
            { key: "status", header: "الحالة", cell: (r) => <Status map={PROJECT_STATUS} value={r.status} /> },
            { key: "contracts", header: "العقود", numeric: true, cell: (r) => integer(r.contracts) },
            { key: "contractValue", header: "قيمة العقد", numeric: true, cell: (r) => money(r.contractValue) },
          ]} />
      </section>
      {adding && <ProjectDialog tenantId={tenantId} onClose={() => setAdding(false)}
        onDone={(id) => void navigate({ to: "/w/$tenantId/contracting/projects/$projectId", params: { tenantId, projectId: id } })} />}
    </div>
  );
}

function ProjectDialog({ tenantId, onClose, onDone }: { tenantId: string; onClose: () => void; onDone: (id: string) => void }) {
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const ref = useReference(tenantId);
  const [v, setV] = useState({ code: "", name: "", specialty: "BUILDING", clientId: "", clientName: "", location: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    const e: Record<string, string> = {};
    if (!/^[A-Za-z0-9-]{1,20}$/.test(v.code)) e.code = "حروف إنجليزية وأرقام وشرطة، حتى 20";
    if (v.name.trim().length < 2) e.name = "أدخل اسم المشروع";
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true); setError(null);
    try {
      const r = await api<{ id: string }>("POST", "/t/projects", { tenant: tenantId, body: { code: v.code, name: v.name.trim(), specialty: v.specialty, clientId: v.clientId || null,
        location: v.location.trim() || null } });
      toast.success(`أُنشئ المشروع ${v.code} ومركز تكلفته`);
      await invalidate("contracting");
      onDone(r.id);
    } catch (err) { if (err instanceof ApiError) setErrors(err.fieldErrors); setError(err); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title="مشروع جديد"
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الإنشاء…">إنشاء المشروع</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <div className="form-grid">
        <TextField label="رمز المشروع" required dir="ltr" value={v.code} onChange={(e) => setV({ ...v, code: e.target.value.toUpperCase() })} error={errors.code} maxLength={20}
          hint="يصبح رمز مركز التكلفة" />
        <TextField label="اسم المشروع" required value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} error={errors.name} maxLength={160} />
      </div>
      <SelectField label="التخصص" required value={v.specialty} onChange={(e) => setV({ ...v, specialty: e.target.value })} error={errors.specialty}
        hint="يحدد وحدات جدول الكميات ومستويات هيكل الأعمال" options={(ref.data?.specialties ?? []).map((s) => ({ value: s.code, label: s.name }))} />
      {v.clientId ? <p className="row" style={{ gap: "var(--sp-2)" }}>العميل: <strong>{v.clientName}</strong> <Button size="sm" variant="ghost" onClick={() => setV({ ...v, clientId: "", clientName: "" })}>تغيير</Button></p>
        : <CustomerPicker tenantId={tenantId} label="العميل" hint="اختياري الآن؛ العقد يحدد عميله" onPick={(c) => setV({ ...v, clientId: c.id, clientName: c.name })} />}
      <TextField label="الموقع" optional value={v.location} onChange={(e) => setV({ ...v, location: e.target.value })} maxLength={300} />
      <FormError error={error} />
    </Dialog>
  );
}

// ── Project detail ────────────────────────────────────────────────────────────────────────────
interface ProjectDetail { id: string; code: string; name: string; status: string; specialty: string; specialtyName: string; clientId: string | null; clientName: string | null;
  location: string | null; costCenterId: string;
  contracts: { id: string; number: string; title: string; role: string; status: string; value: number; pricingModel: string; governingRegime: string; customerName: string | null;
    parentNumber: string | null }[];
  wbs: { id: string; parentId: string | null; code: string; name: string }[];
  permits: { id: string; kind: string; number: string; issuer: string | null; expiresOn: string | null }[] }

export function ProjectPage() {
  const { tenantId, can, writable } = useTenant();
  const { projectId } = useParams({ strict: false }) as { projectId: string };
  const navigate = useNavigate();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const q = useQuery({ queryKey: ["t", tenantId, "contracting", "project", projectId], queryFn: () => api<ProjectDetail>("GET", `/t/projects/${projectId}`, { tenant: tenantId }) });
  const [contractOpen, setContractOpen] = useState<"MAIN" | "SUB" | null>(null);
  const [editingProject, setEditingProject] = useState(false);
  const [permitOpen, setPermitOpen] = useState(false);
  const [wbs, setWbs] = useState({ code: "", name: "", parentId: "" });
  const [wbsErr, setWbsErr] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{ kind: "wbs" | "permit"; id: string; label: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  if (q.isPending) return <div className="page"><TableSkeleton columns={4} /></div>;
  if (q.isError) return <div className="page"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div>;
  const p = q.data;
  const edit = can("projects.edit") && writable;
  async function addWbs() {
    if (!wbs.code.trim() || !wbs.name.trim()) return setWbsErr("أدخل الرمز والاسم");
    setWbsErr(null);
    try {
      await api("POST", `/t/projects/${projectId}/wbs`, { tenant: tenantId, body: { code: wbs.code.trim(), name: wbs.name.trim(), parentId: wbs.parentId || null } });
      setWbs({ code: "", name: "", parentId: wbs.parentId });
      await invalidate("contracting");
    } catch (e) { setWbsErr(errorMessage(e)); }
  }
  async function remove() {
    if (!removing) return;
    setBusy(true); setErr(null);
    try {
      await api("DELETE", removing.kind === "wbs" ? `/t/wbs/${removing.id}` : `/t/permits/${removing.id}`, { tenant: tenantId });
      toast.success(`حُذف ${removing.label}`);
      setRemoving(null);
      await invalidate("contracting");
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <div className="page">
      <PageHeader eyebrow="المشاريع" title={<>{p.name} <Ref>{p.code}</Ref></>}
        description={<>{p.specialtyName} · العميل: {text(p.clientName)} · {text(p.location)} · <Status map={PROJECT_STATUS} value={p.status} /></>}
        actions={<>
          <Link to="/w/$tenantId/contracting/projects" params={{ tenantId }} className="btn btn-ghost">كل المشاريع</Link>
          {can("cost_control.view") && <Link to="/w/$tenantId/contracting/projects/$projectId/control" params={{ tenantId, projectId: p.id }} className="btn">التحكم: البرنامج والتكلفة</Link>}
          {edit && <Button onClick={() => setEditingProject(true)}>تعديل المشروع</Button>}
          {can("contracts.create") && writable && p.contracts.some((c) => c.role === "MAIN" && c.status === "active") && <Button icon={<Plus />} onClick={() => setContractOpen("SUB")}>عقد باطن</Button>}
          {can("contracts.create") && writable && <Button variant="primary" icon={<FileSignature />} onClick={() => setContractOpen("MAIN")}>عقد جديد</Button>}
        </>} />
      <section className="panel" aria-label="العقود">
        <DataTable caption="العقود" query={{ ...q, data: { items: p.contracts } }} rowKey={(r) => r.id}
          onRowClick={(r) => void navigate({ to: "/w/$tenantId/contracting/contracts/$contractId", params: { tenantId, contractId: r.id } })}
          empty={{ title: "لا عقد لهذا المشروع", body: "أضف العقد مع العميل: قيمته ونسب الدفعة المقدمة والمحتجزات وغرامة التأخير، ثم جدول كمياته." }}
          columns={[
            { key: "number", header: "العقد", cell: (r) => <span className="stack-tight"><strong>{r.title}</strong><span><Ref>{r.number}</Ref>{r.role === "SUB" && <> <Badge tone="info">باطن ← {r.parentNumber}</Badge></>}</span></span> },
            { key: "customerName", header: "العميل / مقاول الباطن", cell: (r) => text(r.customerName) },
            { key: "governingRegime", header: "النظام", cell: (r) => REGIMES[r.governingRegime] ?? r.governingRegime },
            { key: "pricingModel", header: "التسعير", cell: (r) => PRICING[r.pricingModel] ?? r.pricingModel },
            { key: "status", header: "الحالة", cell: (r) => <Status map={CONTRACT_STATUS} value={r.status} /> },
            { key: "value", header: "القيمة", numeric: true, cell: (r) => money(r.value) },
          ]} />
      </section>
      <div className="form-grid">
        <section className="panel panel-pad stack" aria-label="هيكل تجزئة الأعمال">
          <h2 className="acc-small">هيكل تجزئة الأعمال (WBS)</h2>
          {p.wbs.length === 0 ? <p className="muted">لا عناصر بعد. تُربط بها بنود جدول الكميات والتكاليف.</p> : (
            <ul className="stack-tight" style={{ margin: 0, paddingInlineStart: "var(--sp-4)" }}>
              {p.wbs.map((w) => <li key={w.id} className="row" style={{ justifyContent: "space-between" }}>
                <span><Ref>{w.code}</Ref> {w.name}{w.parentId && <span className="muted acc-small"> ← {p.wbs.find((x) => x.id === w.parentId)?.code}</span>}</span>
                {edit && <IconButton label={`حذف ${w.code}`} icon={<Trash2 />} onClick={() => { setErr(null); setRemoving({ kind: "wbs", id: w.id, label: `عنصر ${w.code}` }); }} />}
              </li>)}
            </ul>
          )}
          {edit && <div className="row" style={{ gap: "var(--sp-2)", alignItems: "end", flexWrap: "wrap" }}>
            <TextField label="الرمز" dir="ltr" value={wbs.code} onChange={(e) => setWbs({ ...wbs, code: e.target.value })} maxLength={40} />
            <TextField label="الاسم" value={wbs.name} onChange={(e) => setWbs({ ...wbs, name: e.target.value })} maxLength={160} />
            <SelectField label="تحت" placeholder="المستوى الأعلى" value={wbs.parentId} onChange={(e) => setWbs({ ...wbs, parentId: e.target.value })}
              options={p.wbs.map((w) => ({ value: w.id, label: `${w.code} ${w.name}` }))} />
            <Button icon={<Plus />} onClick={() => void addWbs()}>إضافة</Button>
          </div>}
          {wbsErr && <p className="field-error" role="alert">{wbsErr}</p>}
        </section>
        <section className="panel panel-pad stack" aria-label="التصاريح">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2 className="acc-small">التصاريح والرخص</h2>
            {edit && <Button size="sm" icon={<Plus />} onClick={() => setPermitOpen(true)}>تصريح</Button>}
          </div>
          {p.permits.length === 0 ? <p className="muted">لا تصاريح مسجلة. سجّل رخصة البناء وغيرها لتنبيهك قبل انتهائها.</p> : (
            <ul className="stack-tight" style={{ margin: 0, paddingInlineStart: "var(--sp-4)" }}>
              {p.permits.map((x) => <li key={x.id} className="row" style={{ justifyContent: "space-between" }}>
                <span>{x.kind} <Ref>{x.number}</Ref>{x.issuer && ` · ${x.issuer}`} · ينتهي {day(x.expiresOn)}</span>
                {edit && <IconButton label={`حذف ${x.kind} ${x.number}`} icon={<Trash2 />} onClick={() => { setErr(null); setRemoving({ kind: "permit", id: x.id, label: `${x.kind} ${x.number}` }); }} />}
              </li>)}
            </ul>
          )}
        </section>
      </div>
      {contractOpen && <ContractDialog tenantId={tenantId} project={p} role={contractOpen} onClose={() => setContractOpen(null)}
        onDone={(id) => void navigate({ to: "/w/$tenantId/contracting/contracts/$contractId", params: { tenantId, contractId: id } })} />}
      {editingProject && <ProjectEditDialog tenantId={tenantId} project={p} onClose={() => setEditingProject(false)} />}
      {permitOpen && <PermitDialog tenantId={tenantId} projectId={projectId} onClose={() => setPermitOpen(false)} />}
      <ConfirmDialog open={Boolean(removing)} onClose={() => setRemoving(null)} busy={busy} error={err ? errorMessage(err) : null} onConfirm={() => void remove()}
        title={`حذف ${removing?.label ?? ""}؟`} confirmLabel="حذف" message="لا يُحذف عنصر عليه قيود محاسبية." />
    </div>
  );
}

function ProjectEditDialog({ tenantId, project, onClose }: { tenantId: string; project: ProjectDetail; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [v, setV] = useState({ name: project.name, clientId: project.clientId ?? "", clientName: project.clientName ?? "", location: project.location ?? "", status: project.status });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const openContracts = project.contracts.filter((c) => c.status === "active").length;
  async function submit() {
    if (v.name.trim().length < 2) return setError(new Error("أدخل اسم المشروع"));
    if (v.status === "closed" && openContracts) return setError(new Error(`للمشروع ${openContracts} عقد مفعّل: أكملها قبل إغلاقه`));
    setBusy(true); setError(null);
    try {
      await api("PUT", `/t/projects/${project.id}`, { tenant: tenantId, body: { name: v.name.trim(), clientId: v.clientId || null, location: v.location.trim() || null, status: v.status } });
      toast.success("حُفظ المشروع");
      await invalidate("contracting");
      onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title={`تعديل ${project.code}`}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">حفظ</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <div className="form-grid">
        <TextField label="الاسم" required value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} maxLength={160} />
        <SelectField label="الحالة" required value={v.status} onChange={(e) => setV({ ...v, status: e.target.value })}
          hint="المغلق لا تُحمَّل عليه مواد ولا معدات ولا عمالة" options={Object.entries(PROJECT_STATUS).map(([value, [label]]) => ({ value, label }))} />
      </div>
      {v.clientId ? <p className="row" style={{ gap: "var(--sp-2)" }}>العميل: <strong>{v.clientName}</strong> <Button size="sm" variant="ghost" onClick={() => setV({ ...v, clientId: "", clientName: "" })}>تغيير</Button></p>
        : <CustomerPicker tenantId={tenantId} label="العميل" onPick={(c) => setV({ ...v, clientId: c.id, clientName: c.name })} />}
      <TextField label="الموقع" optional value={v.location} onChange={(e) => setV({ ...v, location: e.target.value })} maxLength={300} />
      <FormError error={error} />
    </Dialog>
  );
}

function PermitDialog({ tenantId, projectId, onClose }: { tenantId: string; projectId: string; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const [v, setV] = useState({ kind: "رخصة بناء", number: "", issuer: "", expiresOn: "" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!v.number.trim()) return setError(new Error("أدخل رقم التصريح"));
    setBusy(true); setError(null);
    try {
      await api("POST", `/t/projects/${projectId}/permits`, { tenant: tenantId, body: { kind: v.kind.trim(), number: v.number.trim(), issuer: v.issuer.trim() || null, expiresOn: v.expiresOn || null } });
      await invalidate("contracting");
      onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title="تصريح أو رخصة"
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">حفظ التصريح</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <div className="form-grid">
        <TextField label="النوع" required value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })} maxLength={80} />
        <TextField label="الرقم" required dir="ltr" value={v.number} onChange={(e) => setV({ ...v, number: e.target.value })} maxLength={60} />
        <TextField label="الجهة المصدرة" optional value={v.issuer} onChange={(e) => setV({ ...v, issuer: e.target.value })} maxLength={120} />
        <TextField label="تاريخ الانتهاء" optional type="date" dir="ltr" value={v.expiresOn} onChange={(e) => setV({ ...v, expiresOn: e.target.value })} />
      </div>
      <FormError error={error} />
    </Dialog>
  );
}

type ProjectRef = Pick<ProjectDetail, "id" | "code" | "clientId" | "clientName" | "contracts">;
/** A new contract, or a draft one edited: its law decides the statutory caps, so a government contract needs its tender date. */
function ContractDialog({ tenantId, project, role, editing, onClose, onDone }: { tenantId: string; project: ProjectRef; role: "MAIN" | "SUB"; editing?: ContractDetail;
  onClose: () => void; onDone: (id: string) => void }) {
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const ref = useReference(tenantId);
  const subs = useSubcontractors(tenantId);
  const sub = role === "SUB";
  const mains = project.contracts.filter((c) => c.role === "MAIN" && c.status === "active");
  const e0 = editing;
  const [v, setV] = useState(e0 ? {
    number: e0.number, title: e0.title, customerId: e0.customerId ?? "", customerName: e0.customerName ?? "", profile: e0.profile, pricingModel: e0.pricingModel,
    governingRegime: e0.governingRegime, governmentClient: e0.governmentClient, tenderDate: e0.tenderDate ?? "", signDate: e0.signDate ?? "", value: String(e0.value),
    advancePct: String(e0.advancePct), retentionPct: String(e0.retentionPct), retentionCapPct: String(e0.retentionCapPct), ldRatePerDay: String(e0.ldRatePerDay),
    ldCapPct: e0.ldCapPct === null ? "" : String(e0.ldCapPct), supplierId: e0.supplierId ?? "", parentContractId: e0.parentContractId ?? "", subcontractApprovalRef: e0.subcontractApprovalRef ?? "",
  } : { number: "", title: "", customerId: project.clientId ?? "", customerName: project.clientName ?? "", profile: "CUSTOM", pricingModel: sub ? "LUMP_SUM" : "UNIT_PRICE",
    governingRegime: "PRIVATE", governmentClient: false, tenderDate: "", signDate: "", value: "", advancePct: "", retentionPct: "", retentionCapPct: "", ldRatePerDay: "0", ldCapPct: "",
    supplierId: "", parentContractId: mains[0]?.id ?? "", subcontractApprovalRef: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const d = ref.data?.profiles.find((x) => x.code === v.profile)?.defaults;
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  const pct = (s: string) => (s === "" ? undefined : num(s));
  async function submit() {
    const e: Record<string, string> = {};
    if (!v.number.trim()) e.number = "أدخل رقم العقد";
    if (v.title.trim().length < 2) e.title = "أدخل عنوان العقد";
    if (!sub && !v.customerId) e.customerId = "اختر العميل";
    if (sub && !v.supplierId) e.supplierId = "اختر مقاول باطن معتمداً";
    if (sub && !editing && !v.parentContractId) e.parentContractId = "اختر العقد الرئيسي";
    if (!(num(v.value) >= 0) || v.value === "") e.value = "أدخل قيمة العقد قبل الضريبة";
    if (v.governingRegime !== "PRIVATE" && !v.tenderDate) e.tenderDate = "تاريخ طرح المنافسة يحدد النظام الحاكم وسقوفه";
    for (const k of ["advancePct", "retentionPct", "retentionCapPct", "ldCapPct"] as const) if (v[k] !== "" && !(num(v[k]) >= 0 && num(v[k]) <= 100)) e[k] = "نسبة بين 0 و100";
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true); setError(null);
    try {
      const body = {
        number: v.number.trim(), title: v.title.trim(), profile: v.profile, pricingModel: v.pricingModel,
        ...(sub ? { supplierId: v.supplierId, subcontractApprovalRef: v.subcontractApprovalRef.trim() || null } : { customerId: v.customerId }),
        governingRegime: v.governingRegime, governmentClient: v.governmentClient, tenderDate: v.tenderDate || null, signDate: v.signDate || null, value: num(v.value),
        advancePct: pct(v.advancePct), retentionPct: pct(v.retentionPct), retentionCapPct: pct(v.retentionCapPct), ldRatePerDay: num(v.ldRatePerDay || "0"),
        ldCapPct: v.ldCapPct === "" ? null : num(v.ldCapPct) };
      if (editing) {
        await api("PUT", `/t/contracts/${editing.id}`, { tenant: tenantId, body });
        toast.success(`حُفظ العقد ${v.number}`);
        await invalidate("contracting");
        return onDone(editing.id);
      }
      const r = await api<{ id: string }>("POST", "/t/contracts", { tenant: tenantId, body: { ...body, projectId: project.id, role, ...(sub ? { parentContractId: v.parentContractId } : {}) } });
      toast.success(`أُنشئ العقد ${v.number} مسودة. أدخل جدول الكميات ثم فعّله.`);
      await invalidate("contracting");
      onDone(r.id);
    } catch (err) { if (err instanceof ApiError) setErrors(err.fieldErrors); setError(err); } finally { setBusy(false); }
  }
  return (
    <Dialog open wide onClose={onClose} busy={busy} onSubmit={() => void submit()} title={editing ? `تعديل العقد ${editing.number}` : sub ? `عقد باطن للمشروع ${project.code}` : `عقد جديد للمشروع ${project.code}`}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">{editing ? "حفظ العقد" : "إنشاء العقد"}</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <fieldset className="stack">
        <legend className="acc-small">{sub ? "العقد ومقاول الباطن" : "العقد والعميل"}</legend>
        <div className="form-grid">
          <TextField label="رقم العقد" required dir="ltr" value={v.number} onChange={set("number")} error={errors.number} maxLength={40} />
          <TextField label="العنوان" required value={v.title} onChange={set("title")} error={errors.title} maxLength={200} />
        </div>
        {sub ? (
          <div className="form-grid">
            <SelectField label="مقاول الباطن" required placeholder={subs.isPending ? "جارٍ التحميل…" : subs.data && !subs.data.items.some((s) => s.status === "approved") ? "لا مقاول معتمد بعد" : "اختر من المعتمدين"}
              value={v.supplierId} onChange={set("supplierId")} error={errors.supplierId}
              hint={subs.data && !subs.data.items.some((s) => s.status === "approved") ? "اعتمد تأهيل مقاول من صفحة «مقاولو الباطن» أولاً" : "المعتمد تأهيله في «مقاولو الباطن»"}
              options={(subs.data?.items ?? []).filter((s) => s.status === "approved").map((s) => ({ value: s.supplierId, label: s.name }))} />
            {!editing && <SelectField label="تحت العقد الرئيسي" required value={v.parentContractId} onChange={set("parentContractId")} error={errors.parentContractId}
              options={mains.map((m) => ({ value: m.id, label: `${m.number} · ${m.title}` }))} />}
            <TextField label="مرجع موافقة الإسناد" optional value={v.subcontractApprovalRef} onChange={set("subcontractApprovalRef")} maxLength={120}
              hint="مطلوب إذا تجاوز المسند سقف الموافقة في نموذج العقد الرئيسي (اعتماد: 30%)" />
          </div>
        ) : v.customerId ? <p className="row" style={{ gap: "var(--sp-2)" }}>العميل: <strong>{v.customerName}</strong> <Button size="sm" variant="ghost" onClick={() => setV({ ...v, customerId: "", customerName: "" })}>تغيير</Button></p>
          : <CustomerPicker tenantId={tenantId} label="العميل" required error={errors.customerId} onPick={(c) => setV({ ...v, customerId: c.id, customerName: c.name })} />}
        <div className="form-grid">
          <SelectField label="نموذج العقد" required value={v.profile} onChange={set("profile")} options={(ref.data?.profiles ?? []).map((x) => ({ value: x.code, label: x.name }))} />
          <SelectField label="التسعير" required value={v.pricingModel} onChange={set("pricingModel")} options={Object.entries(PRICING).map(([value, label]) => ({ value, label }))} />
          <TextField label="القيمة قبل الضريبة (⃁)" required numeric inputMode="decimal" dir="ltr" value={v.value} onChange={set("value")} error={errors.value} />
          <TextField label="تاريخ التوقيع" optional type="date" dir="ltr" value={v.signDate} onChange={set("signDate")} />
        </div>
      </fieldset>
      {!sub && <fieldset className="stack">
        <legend className="acc-small">النظام الحاكم</legend>
        <div className="form-grid">
          <SelectField label="النظام" required value={v.governingRegime} onChange={set("governingRegime")} hint="العقد الحكومي يبقى على نظام تاريخ طرحه حتى نهايته"
            options={Object.entries(REGIMES).map(([value, label]) => ({ value, label }))} />
          <TextField label="تاريخ طرح المنافسة" required={v.governingRegime !== "PRIVATE"} optional={v.governingRegime === "PRIVATE"} type="date" dir="ltr" value={v.tenderDate}
            onChange={set("tenderDate")} error={errors.tenderDate} />
        </div>
        <Checkbox label="العميل جهة حكومية (الضريبة تستحق بتاريخ أمر الدفع)" checked={v.governmentClient} onChange={(e) => setV({ ...v, governmentClient: e.target.checked })} />
      </fieldset>}
      <fieldset className="stack">
        <legend className="acc-small">الشروط المالية {d && <span className="muted">(الفارغ يأخذ قيمة النموذج)</span>}</legend>
        <div className="form-grid">
          <TextField label="الدفعة المقدمة %" optional numeric inputMode="decimal" dir="ltr" value={v.advancePct} onChange={set("advancePct")} error={errors.advancePct} placeholder={d ? String(d.advancePct) : ""} />
          <TextField label="المحتجزات %" optional numeric inputMode="decimal" dir="ltr" value={v.retentionPct} onChange={set("retentionPct")} error={errors.retentionPct} placeholder={d ? String(d.retentionPct) : ""} />
          <TextField label="سقف المحتجزات % من العقد" optional numeric inputMode="decimal" dir="ltr" value={v.retentionCapPct} onChange={set("retentionCapPct")} error={errors.retentionCapPct}
            placeholder={d ? String(d.retentionCapPct) : ""} hint="صفر = بلا سقف" />
          <TextField label="غرامة التأخير لليوم (⃁)" optional numeric inputMode="decimal" dir="ltr" value={v.ldRatePerDay} onChange={set("ldRatePerDay")} />
          <TextField label="سقف الغرامة المتفق عليه %" optional numeric inputMode="decimal" dir="ltr" value={v.ldCapPct} onChange={set("ldCapPct")} error={errors.ldCapPct}
            hint={v.governingRegime === "PRIVATE" ? "مطلوب في العقد الخاص إن وُجدت غرامة" : "الأدنى بينه وبين السقف النظامي الموثَّق"} />
        </div>
      </fieldset>
      <FormError error={error} />
    </Dialog>
  );
}

// ── Contract ──────────────────────────────────────────────────────────────────────────────────
interface Applied { value: number; unit: string; label: string; citation: string }
interface ContractDetail { id: string; number: string; title: string; status: string; profile: string; profileName: string; signDate: string | null; customerId: string | null;
  supplierId: string | null; pricingModel: string; governingRegime: string; governmentClient: boolean;
  tenderDate: string | null; value: number; advancePct: number; retentionPct: number; retentionCapPct: number; ldRatePerDay: number; ldCapPct: number | null; dlpMonths: number;
  claimNoticeDays: number; appliedParams: Record<string, Applied>; openIpcId: string | null; finalized: boolean; role: "MAIN" | "SUB"; supplierName: string | null;
  residency: string | null; supplierTaxId: string | null; parentContractId: string | null; parentNumber: string | null; subcontractApprovalRef: string | null;
  subcontracts: { id: string; number: string; title: string; status: string; value: number; supplierName: string; share: number | null }[]; projectId: string; projectCode: string; projectName: string; customerName: string | null;
  specialtyDefinition: Reference["specialties"][number]["definition"];
  figures: { boqTotal: number; approvedVariations: number; billedToDate: number; retentionHeld: number; advanceInvoiced: number; advanceRecovered: number; ldToDate: number;
    retentionReleasable: number; retentionReleased: number };
  guarantees: { id: string; kind: string; number: string; bank: string; amount: number; issuedOn: string; expiresOn: string; status: string; fee: number; daysLeft: number }[] }

export function ContractPage() {
  const { tenantId, can, writable } = useTenant();
  const { contractId } = useParams({ strict: false }) as { contractId: string };
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ["t", tenantId, "contracting", "contract", contractId], queryFn: () => api<ContractDetail>("GET", `/t/contracts/${contractId}`, { tenant: tenantId }) });
  const [tab, setTab] = useState("boq");
  const [activating, setActivating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [ipcOpen, setIpcOpen] = useState(false);
  const [advanceOpen, setAdvanceOpen] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [editingContract, setEditingContract] = useState(false);
  if (q.isPending) return <div className="page"><TableSkeleton columns={5} /></div>;
  if (q.isError) return <div className="page"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div>;
  const c = q.data;
  const f = c.figures;
  const active = c.status === "active";
  async function activate() {
    setBusy(true); setErr(null);
    try {
      await api("POST", `/t/contracts/${contractId}/activate`, { tenant: tenantId });
      toast.success(`فُعّل العقد ${c.number} وثُبّت جدول كمياته`);
      setActivating(false);
      await invalidate("contracting");
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  const advanceLeft = Math.round((c.value * c.advancePct) / 100 * 100) / 100 - f.advanceInvoiced;
  const isSub = c.role === "SUB";
  const vatMode = c.residency === "non_resident" ? "reverse" : c.supplierTaxId ? "charged" : "none";
  return (
    <div className="page">
      <PageHeader eyebrow={`${c.projectCode} · ${c.projectName}`} title={<>{c.title} <Ref>{c.number}</Ref></>}
        description={isSub
          ? <>عقد باطن مع {c.supplierName} تحت العقد <Link to="/w/$tenantId/contracting/contracts/$contractId" params={{ tenantId, contractId: c.parentContractId! }}><Ref>{c.parentNumber!}</Ref></Link> · {PRICING[c.pricingModel]} · <Status map={CONTRACT_STATUS} value={c.status} /></>
          : <>{text(c.customerName)} · {REGIMES[c.governingRegime]} · {PRICING[c.pricingModel]} · {c.profileName} · <Status map={CONTRACT_STATUS} value={c.status} /></>}
        actions={<>
          <Link to="/w/$tenantId/contracting/projects/$projectId" params={{ tenantId, projectId: c.projectId }} className="btn btn-ghost">المشروع</Link>
          {active && can("ipcs.invoice") && writable && advanceLeft > 0.004 && <Button icon={<HandCoins />} onClick={() => setAdvanceOpen(true)}>{isSub ? "دفعة مقدمة لمقاول الباطن" : "فاتورة الدفعة المقدمة"}</Button>}
          {can("retention.release") && writable && f.retentionReleasable > 0.004 && <Button onClick={() => setReleaseOpen(true)}>إفراج عن محتجزات</Button>}
          {c.status === "draft" && can("contracts.edit") && writable && <Button onClick={() => setEditingContract(true)}>تعديل العقد</Button>}
          {c.status === "draft" && can("contracts.activate") && writable && <Button variant="primary" icon={<BadgeCheck />} disabled={Math.abs(f.boqTotal - c.value) > 0.004}
            title={Math.abs(f.boqTotal - c.value) > 0.004 ? `مجموع جدول الكميات ${money(f.boqTotal)} يختلف عن قيمة العقد ${money(c.value)}` : undefined}
            onClick={() => { setErr(null); setActivating(true); }}>تفعيل العقد</Button>}
          {active && c.openIpcId && <Link to="/w/$tenantId/contracting/ipcs/$ipcId" params={{ tenantId, ipcId: c.openIpcId }} className="btn btn-primary">المستخلص المفتوح</Link>}
          {active && !c.openIpcId && !c.finalized && can("ipcs.create") && writable && <Button variant="primary" icon={<Plus />} onClick={() => setIpcOpen(true)}>مستخلص جديد</Button>}
        </>} />
      <div className="stats">
        <StatCard label="قيمة العقد" value={money(c.value)} icon={<FileSignature />} hue="indigo" note={f.approvedVariations ? `أوامر تغيير معتمدة ${money(f.approvedVariations)}` : undefined} />
        <StatCard label="المنفذ المعتمد حتى تاريخه" value={money(f.billedToDate)} icon={<Building />} hue="sky" note={c.value ? percent((f.billedToDate / c.value) * 100) : undefined} />
        <StatCard label={isSub ? "المحتجز من مقاول الباطن" : "المحتجزات لدى العميل"} value={money(f.retentionHeld - f.retentionReleased)} icon={<ShieldAlert />} hue="amber" note={`${percent(c.retentionPct)} ${c.retentionCapPct ? `حتى سقف ${percent(c.retentionCapPct)}` : "بلا سقف"}`} />
        <StatCard label="الدفعة المقدمة المستردة" value={money(f.advanceRecovered)} icon={<HandCoins />} hue="violet" note={`من ${money(f.advanceInvoiced)} مفوترة`} />
      </div>
      {Object.keys(c.appliedParams ?? {}).length > 0 && (
        <details className="panel panel-pad">
          <summary>القيم النظامية المطبقة على العقد (ثُبتت عند التفعيل)</summary>
          <ul className="stack-tight" style={{ marginBlockStart: "var(--sp-2)", paddingInlineStart: "var(--sp-4)" }}>
            {Object.entries(c.appliedParams).map(([k, p]) => <li key={k}><strong>{p.label}</strong>: {p.citation}</li>)}
          </ul>
        </details>
      )}
      <section className="panel" aria-label="تفاصيل العقد">
        <div className="toolbar"><StatusTabs value={tab} onChange={setTab} options={[["boq", "جدول الكميات"], ["ipcs", "المستخلصات"], ["variations", "أوامر التغيير"], ["claims", "المطالبات"],
          ["guarantees", "الضمانات"], ...(isSub ? [] : [["subs", "مقاولو الباطن"] as [string, string]])]} /></div>
        {tab === "boq" && <BoqTab tenantId={tenantId} contract={c} />}
        {tab === "ipcs" && <IpcsTab tenantId={tenantId} contractId={contractId} onOpen={(id) => void navigate({ to: "/w/$tenantId/contracting/ipcs/$ipcId", params: { tenantId, ipcId: id } })} />}
        {tab === "variations" && <VariationsTab tenantId={tenantId} contract={c} />}
        {tab === "claims" && <ClaimsTab tenantId={tenantId} contract={c} />}
        {tab === "guarantees" && <GuaranteesTab tenantId={tenantId} contract={c} />}
        {tab === "subs" && (
          <DataTable caption="عقود الباطن" query={{ ...q, data: { items: c.subcontracts } }} rowKey={(r) => r.id}
            onRowClick={(r) => void navigate({ to: "/w/$tenantId/contracting/contracts/$contractId", params: { tenantId, contractId: r.id } })}
            empty={{ title: "لا عقود باطن", body: "أضف عقد الباطن من صفحة المشروع. نسبة الإسناد تُفحص عند تفعيله مقابل سقوف نموذج هذا العقد." }}
            columns={[
              { key: "number", header: "العقد", cell: (r) => <span className="stack-tight"><strong>{r.title}</strong><Ref>{r.number}</Ref></span> },
              { key: "supplierName", header: "مقاول الباطن", cell: (r) => r.supplierName },
              { key: "status", header: "الحالة", cell: (r) => <Status map={CONTRACT_STATUS} value={r.status} /> },
              { key: "value", header: "القيمة", numeric: true, cell: (r) => money(r.value) },
              { key: "share", header: "من العقد الرئيسي", numeric: true, cell: (r) => percent(r.share ?? 0) },
            ]} />
        )}
      </section>
      <ConfirmDialog open={activating} onClose={() => setActivating(false)} busy={busy} error={err ? errorMessage(err) : null} onConfirm={() => void activate()} destructive={false}
        title={`تفعيل العقد ${c.number}؟`} confirmLabel="تفعيل العقد"
        message={<>يُثبَّت جدول الكميات فلا يُعدّل بعدها إلا بأمر تغيير، وتُطبَّق السقوف النظامية لنظام العقد في تاريخ طرحه ({day(c.tenderDate)}) إن كانت موثقة من مدير المنصة. مجموع الجدول يجب أن يساوي {money(c.value)}.</>} />
      {ipcOpen && <NewIpcDialog tenantId={tenantId} contractId={contractId} onClose={() => setIpcOpen(false)}
        onDone={(id) => void navigate({ to: "/w/$tenantId/contracting/ipcs/$ipcId", params: { tenantId, ipcId: id } })} />}
      {advanceOpen && (isSub ? <SubAdvanceDialog tenantId={tenantId} contractId={c.id} left={advanceLeft} vatMode={vatMode} onClose={() => setAdvanceOpen(false)} />
        : <AdvanceDialog tenantId={tenantId} contract={c} left={advanceLeft} onClose={() => setAdvanceOpen(false)} />)}
      {editingContract && <ContractDialog tenantId={tenantId} role={c.role} editing={c}
        project={{ id: c.projectId, code: c.projectCode, clientId: c.customerId, clientName: c.customerName, contracts: [] }}
        onClose={() => setEditingContract(false)} onDone={() => setEditingContract(false)} />}
      {releaseOpen && <ReleaseDialog tenantId={tenantId} contractId={c.id} role={c.role} held={f.retentionReleasable} onClose={() => setReleaseOpen(false)} />}
    </div>
  );
}

interface BoqItem { id: string; parentId: string | null; code: string; description: string; isSection: boolean; unit: string | null; quantity: number; rate: number; amount: number; depth: number }
function BoqTab({ tenantId, contract }: { tenantId: string; contract: ContractDetail }) {
  const { can, writable } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const q = useQuery({ queryKey: ["t", tenantId, "contracting", "boq", contract.id],
    queryFn: () => api<{ version: { status: string }; items: BoqItem[]; total: number }>("GET", `/t/contracts/${contract.id}/boq`, { tenant: tenantId }) });
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [removing, setRemoving] = useState<BoqItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const draft = q.data?.version.status === "draft";
  const edit = draft && can("boq.edit") && writable;
  const diff = q.data ? Math.round((q.data.total - contract.value) * 100) / 100 : 0;
  async function remove() {
    if (!removing) return;
    setBusy(true); setErr(null);
    try {
      await api("DELETE", `/t/boq-items/${removing.id}`, { tenant: tenantId });
      toast.success(`حُذف البند ${removing.code}`);
      setRemoving(null);
      await invalidate("contracting");
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <>
      <div className="toolbar row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: "var(--sp-2)" }}>
        <span className="muted">{q.data ? <>المجموع {money(q.data.total)}{draft && diff !== 0 && <> · <Badge tone="warning">{diff > 0 ? "يزيد" : "ينقص"} عن قيمة العقد {money(Math.abs(diff))}</Badge></>}
          {!draft && <> · <Badge tone="info">مثبت</Badge></>}</> : "…"}</span>
        <span className="row" style={{ gap: "var(--sp-2)" }}>
          {can("boq.import") && <Button size="sm" variant="ghost" icon={<Download />} loading={exporting} loadingText="جارٍ التجهيز…"
            onClick={async () => { setExporting(true); await download(`/t/contracts/${contract.id}/boq/export`, tenantId, "boq.xlsx").catch((e) => toast.error(errorMessage(e))); setExporting(false); }}>تصدير Excel</Button>}
          {draft && can("boq.import") && writable && <Button size="sm" icon={<Upload />} onClick={() => setImporting(true)}>استيراد Excel</Button>}
          {edit && <Button size="sm" icon={<Plus />} onClick={() => setAdding(true)}>بند</Button>}
        </span>
      </div>
      <DataTable caption="جدول الكميات" query={q} rowKey={(r) => r.id}
        empty={{ title: "جدول الكميات فارغ", body: draft ? "استورده من Excel (رمز البند، رمز الأب، الوصف، الوحدة، الكمية، السعر) أو أضف البنود واحداً واحداً." : "" }}
        columns={[
          { key: "code", header: "البند", sortKey: false, cell: (r) => <span style={{ paddingInlineStart: `calc(${r.depth} * var(--sp-4))` }}>{r.isSection ? <strong><Ref>{r.code}</Ref></strong> : <Ref>{r.code}</Ref>}</span> },
          { key: "description", header: "الوصف", wrap: true, sortKey: false, cell: (r) => r.isSection ? <strong>{r.description}</strong> : r.description },
          { key: "unit", header: "الوحدة", sortKey: false, cell: (r) => r.isSection ? "" : contract.specialtyDefinition.units.find((u) => u.code === r.unit)?.name ?? text(r.unit) },
          { key: "quantity", header: "الكمية", numeric: true, sortKey: false, cell: (r) => r.isSection ? "" : quantity(r.quantity) },
          { key: "rate", header: "السعر", numeric: true, sortKey: false, cell: (r) => r.isSection ? "" : money(r.rate) },
          { key: "amount", header: "المبلغ", numeric: true, sortKey: false, cell: (r) => r.isSection ? <strong>{money(r.amount)}</strong> : money(r.amount) },
        ]}
        actions={edit ? (r) => <IconButton label={`حذف البند ${r.code}`} icon={<Trash2 />} onClick={() => { setErr(null); setRemoving(r); }} /> : undefined} />
      {adding && q.data && <BoqItemDialog tenantId={tenantId} contract={contract} sections={q.data.items.filter((i) => i.isSection)} onClose={() => setAdding(false)} />}
      {importing && <BoqImportDialog tenantId={tenantId} contractId={contract.id} onClose={() => setImporting(false)} />}
      <ConfirmDialog open={Boolean(removing)} onClose={() => setRemoving(null)} busy={busy} error={err ? errorMessage(err) : null} onConfirm={() => void remove()}
        title={`حذف البند ${removing?.code ?? ""}؟`} confirmLabel="حذف البند" message={removing?.isSection ? "يُحذف القسم وكل البنود تحته." : removing?.description} />
    </>
  );
}

function BoqItemDialog({ tenantId, contract, sections, onClose }: { tenantId: string; contract: ContractDetail; sections: BoqItem[]; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const [v, setV] = useState({ parentId: "", code: "", description: "", isSection: false, unit: contract.specialtyDefinition.units[0]?.code ?? "", quantity: "", rate: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    const e: Record<string, string> = {};
    if (!v.code.trim()) e.code = "أدخل رمز البند";
    if (!v.description.trim()) e.description = "أدخل الوصف";
    if (!v.isSection && !(num(v.quantity) >= 0 && v.quantity !== "")) e.quantity = "الكمية رقم موجب";
    if (!v.isSection && !(num(v.rate) >= 0 && v.rate !== "")) e.rate = "السعر رقم موجب";
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true); setError(null);
    try {
      await api("POST", `/t/contracts/${contract.id}/boq/items`, { tenant: tenantId, body: { parentId: v.parentId || null, code: v.code.trim(), description: v.description.trim(),
        isSection: v.isSection, unit: v.isSection ? null : v.unit, quantity: v.isSection ? 0 : num(v.quantity), rate: v.isSection ? 0 : num(v.rate) } });
      await invalidate("contracting");
      setV({ ...v, code: "", description: "", quantity: "", rate: "" });
    } catch (err) { if (err instanceof ApiError) setErrors(err.fieldErrors); setError(err); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title="إضافة بند"
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الإضافة…">إضافة والاستمرار</Button><Button onClick={onClose} disabled={busy}>تم</Button></>}>
      <Checkbox label="قسم (عنوان يجمع البنود تحته)" checked={v.isSection} onChange={(e) => setV({ ...v, isSection: e.target.checked })} />
      <div className="form-grid">
        <SelectField label="تحت القسم" placeholder="المستوى الأعلى" value={v.parentId} onChange={(e) => setV({ ...v, parentId: e.target.value })}
          options={sections.map((s) => ({ value: s.id, label: `${s.code} ${s.description}` }))} />
        <TextField label="الرمز" required dir="ltr" value={v.code} onChange={(e) => setV({ ...v, code: e.target.value })} error={errors.code} maxLength={40} />
      </div>
      <TextAreaField label="الوصف" required value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} error={errors.description} maxLength={1000} />
      {!v.isSection && <div className="form-grid">
        <SelectField label="الوحدة" required value={v.unit} onChange={(e) => setV({ ...v, unit: e.target.value })} options={contract.specialtyDefinition.units.map((u) => ({ value: u.code, label: u.name }))} />
        <TextField label="الكمية" required numeric inputMode="decimal" dir="ltr" value={v.quantity} onChange={(e) => setV({ ...v, quantity: e.target.value })} error={errors.quantity} />
        <TextField label="سعر الوحدة (⃁)" required numeric inputMode="decimal" dir="ltr" value={v.rate} onChange={(e) => setV({ ...v, rate: e.target.value })} error={errors.rate} />
      </div>}
      <FormError error={error} />
    </Dialog>
  );
}

function BoqImportDialog({ tenantId, contractId, onClose }: { tenantId: string; contractId: string; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [rowErrors, setRowErrors] = useState<{ row: number; message: string }[]>([]);
  const [busy, setBusy] = useState(false);
  async function upload() {
    if (!file) return setError(new Error("اختر ملف Excel بصيغة ‎.xlsx"));
    if (file.size > 15 * 1024 * 1024) return setError(new Error("حجم الملف أكبر من 15 ميجابايت"));
    setBusy(true); setError(null); setRowErrors([]);
    const fd = new FormData();
    fd.append("file", file);
    try {
      const r = await api<{ rows: number; total: number }>("POST", `/t/contracts/${contractId}/boq/import`, { tenant: tenantId, body: fd });
      toast.success(`استُورد ${integer(r.rows)} صف، المجموع ${money(r.total)}`);
      await invalidate("contracting");
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === "import_invalid") setRowErrors(((err.details as { errors?: { row: number; message: string }[] })?.errors) ?? []);
      setError(err);
    } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} title="استيراد جدول الكميات من Excel"
      footer={<><Button variant="primary" icon={<Upload />} onClick={() => void upload()} loading={busy} loadingText="جارٍ الفحص والاستيراد…">استيراد الملف</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <p className="muted">الأعمدة بالترتيب: الرمز، رمز الأب، الوصف، الوحدة، الكمية، السعر، قسم (نعم/لا)، مبلغ مؤقت (نعم/لا)، مرجع المواصفات. صدّر الجدول الحالي لتحصل على الشكل. الاستيراد يستبدل المسودة كلها، وإذا وُجد صف خاطئ لا يُحفظ شيء.</p>
      <div className="field">
        <label className="field-label" htmlFor="boq-file">ملف Excel ‎(.xlsx)</label>
        <input id="boq-file" className="input" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => { setFile(e.target.files?.[0] ?? null); setRowErrors([]); setError(null); }} style={{ paddingBlock: "var(--sp-1)" }} />
      </div>
      <FormError error={error} />
      {rowErrors.length > 0 && (
        <div className="table-wrap panel">
          <table className="data-table">
            <caption className="sr-only">الصفوف غير الصالحة</caption>
            <thead><tr><th scope="col">الصف</th><th scope="col">المشكلة</th></tr></thead>
            <tbody>{rowErrors.map((r, i) => <tr key={i}><td className="num">{r.row}</td><td className="wrap">{r.message}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </Dialog>
  );
}

function AdvanceDialog({ tenantId, contract, left, onClose }: { tenantId: string; contract: ContractDetail; left: number; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [key] = useIdempotencyKey();
  const [amount, setAmount] = useState(String(left));
  const [means, setMeans] = useState("bank_transfer");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!(num(amount) > 0 && num(amount) <= left + 0.001)) return setError(new Error(`المبلغ بين 0 و${money(left)}`));
    setBusy(true); setError(null);
    try {
      const r = await api<{ number: string }>("POST", `/t/contracts/${contract.id}/advance`, { tenant: tenantId, idempotencyKey: key, body: { amount: num(amount), paymentMeans: means } });
      toast.success(`صدرت فاتورة الدفعة المقدمة ${r.number}. تُسترد من المستخلصات بنسبتها.`);
      await invalidate("contracting", "sales");
      onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title="فاتورة الدفعة المقدمة"
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الإصدار…">إصدار الفاتورة</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <p className="muted">الدفعة المتفق عليها {percent(contract.advancePct)} من قيمة العقد؛ المتبقي {money(left)} قبل الضريبة. تصدر فاتورة دفعة مقدمة (386) وتُضاف الضريبة عليها.</p>
      <div className="form-grid">
        <TextField label="المبلغ قبل الضريبة (⃁)" required numeric inputMode="decimal" dir="ltr" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <SelectField label="طريقة القبض" required value={means} onChange={(e) => setMeans(e.target.value)} options={[{ value: "bank_transfer", label: "تحويل بنكي" }, { value: "cash", label: "نقداً" }, { value: "card", label: "بطاقة" }]} />
      </div>
      <FormError error={error} />
    </Dialog>
  );
}

// ── IPCs ──────────────────────────────────────────────────────────────────────────────────────
interface IpcRow { id: string; number: number; kind: string; status: string; periodFrom: string; periodTo: string; currentGross: number; retention: number; advanceRecovery: number; ld: number;
  vat: number; netPayable: number; invoiceNumber: string | null; invoiceDeadline: string | null }
function IpcsTab({ tenantId, contractId, onOpen }: { tenantId: string; contractId: string; onOpen: (id: string) => void }) {
  const q = useQuery({ queryKey: ["t", tenantId, "contracting", "ipcs", contractId], queryFn: () => api<{ items: IpcRow[] }>("GET", `/t/contracts/${contractId}/ipcs`, { tenant: tenantId }) });
  const today = isoDay();
  return (
    <DataTable caption="المستخلصات" query={q} rowKey={(r) => r.id} onRowClick={(r) => onOpen(r.id)}
      empty={{ title: "لا مستخلصات بعد", body: "أنشئ المستخلص الأول لفترة العمل: تُعبّأ بنوده من جدول الكميات وأوامر التغيير المعتمدة." }}
      columns={[
        { key: "number", header: "المستخلص", cell: (r) => <span className="stack-tight"><strong>رقم {integer(r.number)}{r.kind === "final" && " (ختامي)"}</strong><span className="muted acc-small">{day(r.periodFrom)} – {day(r.periodTo)}</span></span> },
        { key: "status", header: "الحالة", cell: (r) => <>{<Status map={IPC_STATUS} value={r.status} />}{r.invoiceDeadline && <> <Badge tone={r.invoiceDeadline < today ? "danger" : "warning"}>الفاتورة قبل {day(r.invoiceDeadline)}</Badge></>}</> },
        { key: "currentGross", header: "أعمال الفترة", numeric: true, cell: (r) => r.status === "approved" || r.status === "invoiced" ? money(r.currentGross) : "—" },
        { key: "retention", header: "المحتجز", numeric: true, cell: (r) => r.status === "approved" || r.status === "invoiced" ? money(r.retention) : "—" },
        { key: "netPayable", header: "الصافي المستحق", numeric: true, cell: (r) => r.status === "approved" || r.status === "invoiced" ? <strong>{money(r.netPayable)}</strong> : "—" },
        { key: "invoiceNumber", header: "الفاتورة", cell: (r) => r.invoiceNumber ? <Ref>{r.invoiceNumber}</Ref> : "—" },
      ]} />
  );
}

function NewIpcDialog({ tenantId, contractId, onClose, onDone }: { tenantId: string; contractId: string; onClose: () => void; onDone: (id: string) => void }) {
  const invalidate = useInvalidate(tenantId);
  const now = isoDay();
  const [v, setV] = useState({ periodFrom: `${now.slice(0, 7)}-01`, periodTo: now, kind: "interim" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!v.periodFrom || !v.periodTo || v.periodTo < v.periodFrom) return setError(new Error("نهاية الفترة بعد بدايتها"));
    setBusy(true); setError(null);
    try {
      const r = await api<{ id: string }>("POST", `/t/contracts/${contractId}/ipcs`, { tenant: tenantId, body: v });
      await invalidate("contracting");
      onDone(r.id);
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title="مستخلص جديد"
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الإنشاء…">إنشاء المستخلص</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <div className="form-grid">
        <TextField label="من" required type="date" dir="ltr" value={v.periodFrom} onChange={(e) => setV({ ...v, periodFrom: e.target.value })} />
        <TextField label="إلى" required type="date" dir="ltr" value={v.periodTo} onChange={(e) => setV({ ...v, periodTo: e.target.value })} />
      </div>
      <SelectField label="النوع" required value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })}
        options={[{ value: "interim", label: "جاري" }, { value: "final", label: "ختامي (يسترد باقي الدفعة المقدمة ويغلق المستخلصات)" }]} />
      <FormError error={error} />
    </Dialog>
  );
}

// ── Variations ────────────────────────────────────────────────────────────────────────────────
interface Variation { id: string; number: number; title: string; source: string; status: string; timeImpactDays: number; contractorConsent: boolean; amount: number;
  capCheck: { violations: string[]; remaining: Record<string, number> | null; basis: string } | null;
  lines: { id: string; kind: string; code: string; description: string; unit: string | null; quantity: number; rate: number }[] | null }
const VO_SOURCE: Record<string, string> = { instruction: "تعليمات موقعية", rfi: "طلب استيضاح", design_change: "تغيير تصميم", client_request: "طلب العميل", other: "أخرى" };
function VariationsTab({ tenantId, contract }: { tenantId: string; contract: ContractDetail }) {
  const { can, writable } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const q = useQuery({ queryKey: ["t", tenantId, "contracting", "variations", contract.id], queryFn: () => api<{ items: Variation[] }>("GET", `/t/contracts/${contract.id}/variations`, { tenant: tenantId }) });
  const [adding, setAdding] = useState(false);
  const [deciding, setDeciding] = useState<{ v: Variation; action: "approve" | "reject" } | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  async function decide() {
    if (!deciding) return;
    setBusy(true); setErr(null);
    try {
      await api("POST", `/t/variations/${deciding.v.id}/${deciding.action}`, { tenant: tenantId, body: { contractorConsent: consent } });
      toast.success(deciding.action === "approve" ? `اعتُمد أمر التغيير ${deciding.v.number}` : `رُفض أمر التغيير ${deciding.v.number}`);
      setDeciding(null);
      await invalidate("contracting");
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <>
      {contract.status === "active" && can("variations.create") && writable && (
        <div className="toolbar row" style={{ justifyContent: "end" }}><Button size="sm" icon={<Plus />} onClick={() => setAdding(true)}>أمر تغيير</Button></div>
      )}
      <DataTable caption="أوامر التغيير" query={q} rowKey={(r) => r.id}
        empty={{ title: "لا أوامر تغيير", body: "أي بند جديد أو تعديل كمية بعد التفعيل يمر بأمر تغيير، ويُفحص عند اعتماده مقابل سقوف نظام العقد." }}
        columns={[
          { key: "number", header: "الأمر", cell: (r) => <span className="stack-tight"><strong>VO-{integer(r.number)} {r.title}</strong><span className="muted acc-small">{VO_SOURCE[r.source]}{r.timeImpactDays ? ` · ${integer(r.timeImpactDays)} يوماً` : ""}</span></span> },
          { key: "status", header: "الحالة", cell: (r) => r.status === "approved" ? <Badge tone="success">معتمد{r.contractorConsent ? " بموافقة المقاول" : ""}</Badge> : r.status === "rejected" ? <Badge tone="neutral">مرفوض</Badge> : <Badge tone="warning">مقترح</Badge> },
          { key: "lines", header: "البنود", wrap: true, sortKey: false, cell: (r) => (r.lines ?? []).map((l) => `${l.code} ${l.kind === "new_item" ? "جديد" : "تعديل كمية"} ${quantity(l.quantity)}`).join("، ") },
          { key: "amount", header: "القيمة", numeric: true, cell: (r) => money(r.amount) },
        ]}
        actions={can("variations.approve") && writable ? (r) => r.status === "proposed" ? <ActionMenu label={`إجراءات VO-${r.number}`} items={[
          { label: "اعتماد", onSelect: () => { setErr(null); setConsent(false); setDeciding({ v: r, action: "approve" }); } },
          { label: "رفض", onSelect: () => { setErr(null); setDeciding({ v: r, action: "reject" }); }, danger: true, separated: true },
        ]} /> : null : undefined} />
      {adding && <VariationDialog tenantId={tenantId} contract={contract} onClose={() => setAdding(false)} />}
      <ConfirmDialog open={Boolean(deciding)} onClose={() => setDeciding(null)} busy={busy} error={err ? errorMessage(err) : null} onConfirm={() => void decide()} destructive={deciding?.action === "reject"}
        title={deciding?.action === "approve" ? `اعتماد VO-${deciding.v.number}؟` : `رفض VO-${deciding?.v.number ?? ""}؟`}
        confirmLabel={deciding?.action === "approve" ? "اعتماد" : "رفض"}
        message={deciding?.action === "approve" ? `القيمة ${money(deciding.v.amount)}. يُفحص المجموع التراكمي مقابل سقوف نظام العقد، والبنود الجديدة تدخل المستخلصات التالية.` : "لا يُعدّل أمر التغيير بعد القرار."}>
        {deciding?.action === "approve" && <Checkbox label="المقاول موافق كتابياً (مطلوبة للبنود الجديدة وما فوق حد الزيادة)" checked={consent} onChange={(e) => setConsent(e.target.checked)} />}
      </ConfirmDialog>
    </>
  );
}

interface VoLine { kind: "new_item" | "change_qty"; boqItemId: string; code: string; description: string; unit: string; quantity: string; rate: string }
function VariationDialog({ tenantId, contract, onClose }: { tenantId: string; contract: ContractDetail; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const boq = useQuery({ queryKey: ["t", tenantId, "contracting", "boq", contract.id], queryFn: () => api<{ items: BoqItem[] }>("GET", `/t/contracts/${contract.id}/boq`, { tenant: tenantId }) });
  const leaves = (boq.data?.items ?? []).filter((i) => !i.isSection);
  const blank = (): VoLine => ({ kind: "new_item", boqItemId: "", code: "", description: "", unit: contract.specialtyDefinition.units[0]?.code ?? "", quantity: "", rate: "" });
  const [v, setV] = useState({ title: "", source: "client_request", timeImpactDays: "0" });
  const [lines, setLines] = useState<VoLine[]>([blank()]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const setLine = (i: number, p: Partial<VoLine>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...p } : l)));
  async function submit() {
    if (v.title.trim().length < 3) return setError(new Error("أدخل عنوان أمر التغيير"));
    const bad = lines.find((l) => !l.code.trim() || !l.description.trim() || !num(l.quantity) || !(num(l.rate) >= 0) || (l.kind === "change_qty" && !l.boqItemId));
    if (bad) return setError(new Error(`أكمل البند ${bad.code || "الجديد"}: الرمز والوصف والكمية والسعر${bad.kind === "change_qty" ? " والبند الأصلي" : ""}`));
    setBusy(true); setError(null);
    try {
      await api("POST", `/t/contracts/${contract.id}/variations`, { tenant: tenantId, body: { title: v.title.trim(), source: v.source, timeImpactDays: Math.round(num(v.timeImpactDays || "0")),
        lines: lines.map((l) => ({ kind: l.kind, boqItemId: l.kind === "change_qty" ? l.boqItemId : null, code: l.code.trim(), description: l.description.trim(), unit: l.unit || null,
          quantity: num(l.quantity), rate: num(l.rate) })) } });
      await invalidate("contracting");
      onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open wide onClose={onClose} busy={busy} onSubmit={() => void submit()} title="أمر تغيير"
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">حفظ مقترحاً</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <div className="form-grid">
        <TextField label="العنوان" required value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} maxLength={200} />
        <SelectField label="المصدر" required value={v.source} onChange={(e) => setV({ ...v, source: e.target.value })} options={Object.entries(VO_SOURCE).map(([value, label]) => ({ value, label }))} />
        <TextField label="الأثر على المدة (أيام)" numeric inputMode="numeric" dir="ltr" value={v.timeImpactDays} onChange={(e) => setV({ ...v, timeImpactDays: e.target.value })} />
      </div>
      {lines.map((l, i) => (
        <fieldset key={i} className="panel panel-pad stack-tight">
          <legend className="acc-small">البند {i + 1}</legend>
          <div className="form-grid">
            <SelectField label="النوع" required value={l.kind} onChange={(e) => setLine(i, { kind: e.target.value as VoLine["kind"] })}
              options={[{ value: "new_item", label: "بند جديد" }, { value: "change_qty", label: "تعديل كمية بند قائم" }]} />
            {l.kind === "change_qty" ? (
              <SelectField label="البند الأصلي" required placeholder="اختر البند" value={l.boqItemId}
                onChange={(e) => { const b = leaves.find((x) => x.id === e.target.value); setLine(i, b ? { boqItemId: b.id, code: b.code, description: b.description, unit: b.unit ?? "", rate: String(b.rate) } : { boqItemId: "" }); }}
                options={leaves.map((b) => ({ value: b.id, label: `${b.code} ${b.description}`.slice(0, 80) }))} />
            ) : <TextField label="الرمز" required dir="ltr" value={l.code} onChange={(e) => setLine(i, { code: e.target.value })} maxLength={40} />}
          </div>
          <TextField label="الوصف" required value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} maxLength={500} />
          <div className="form-grid">
            <SelectField label="الوحدة" value={l.unit} onChange={(e) => setLine(i, { unit: e.target.value })} options={contract.specialtyDefinition.units.map((u) => ({ value: u.code, label: u.name }))} />
            <TextField label={l.kind === "change_qty" ? "التغيير في الكمية (سالب للتخفيض)" : "الكمية"} required numeric inputMode="decimal" dir="ltr" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} />
            <TextField label="السعر (⃁)" required numeric inputMode="decimal" dir="ltr" value={l.rate} onChange={(e) => setLine(i, { rate: e.target.value })} />
          </div>
          {lines.length > 1 && <Button size="sm" variant="ghost" icon={<Trash2 />} onClick={() => setLines(lines.filter((_, j) => j !== i))}>حذف البند</Button>}
        </fieldset>
      ))}
      <Button size="sm" icon={<Plus />} onClick={() => setLines([...lines, blank()])}>بند آخر</Button>
      <p className="muted">المجموع {money(lines.reduce((a, l) => a + (num(l.quantity) || 0) * (num(l.rate) || 0), 0))}</p>
      <FormError error={error} />
    </Dialog>
  );
}

// ── Claims ────────────────────────────────────────────────────────────────────────────────────
interface Claim { id: string; number: number; title: string; kind: string; eventDate: string; noticeDeadline: string; noticeDate: string | null; amountClaimed: number | null;
  daysClaimed: number | null; status: string; noticeMissed: boolean; daysToNotice: number }
const CLAIM_STATUS: Record<string, string> = { identified: "حدث مرصود", notified: "أُخطر العميل", submitted: "قُدمت المطالبة", agreed: "اتُفق عليها", rejected: "مرفوضة", withdrawn: "مسحوبة" };
function ClaimsTab({ tenantId, contract }: { tenantId: string; contract: ContractDetail }) {
  const { can, writable } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const q = useQuery({ queryKey: ["t", tenantId, "contracting", "claims", contract.id], queryFn: () => api<{ items: Claim[] }>("GET", `/t/contracts/${contract.id}/claims`, { tenant: tenantId }) });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Claim | null>(null);
  return (
    <>
      {can("claims.create") && writable && <div className="toolbar row" style={{ justifyContent: "end" }}><Button size="sm" icon={<Plus />} onClick={() => setAdding(true)}>تسجيل حدث</Button></div>}
      <DataTable caption="المطالبات" query={q} rowKey={(r) => r.id}
        empty={{ title: "لا مطالبات", body: `سجّل أي حدث يؤثر على المدة أو التكلفة فور وقوعه: مهلة الإخطار في هذا العقد ${integer(contract.claimNoticeDays)} يوماً.` }}
        columns={[
          { key: "title", header: "الحدث", cell: (r) => <span className="stack-tight"><strong>{r.title}</strong><span className="muted acc-small">{day(r.eventDate)}</span></span> },
          { key: "status", header: "الحالة", cell: (r) => CLAIM_STATUS[r.status] ?? r.status },
          { key: "noticeDeadline", header: "مهلة الإخطار", cell: (r) => r.noticeDate ? <>أُخطر {day(r.noticeDate)}</> : r.noticeMissed ? <Badge tone="danger">فاتت {day(r.noticeDeadline)}</Badge>
            : <Badge tone={r.daysToNotice <= 7 ? "danger" : "warning"}>{day(r.noticeDeadline)} (بعد {integer(r.daysToNotice)} يوماً)</Badge> },
          { key: "amountClaimed", header: "المطالب به", numeric: true, cell: (r) => [r.amountClaimed !== null ? money(r.amountClaimed) : null, r.daysClaimed !== null ? `${integer(r.daysClaimed)} يوماً` : null].filter(Boolean).join(" · ") || "—" },
        ]}
        actions={can("claims.edit") && writable ? (r) => <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>تحديث</Button> : undefined} />
      {adding && <ClaimDialog tenantId={tenantId} contractId={contract.id} onClose={() => setAdding(false)} />}
      {editing && <ClaimStatusDialog tenantId={tenantId} claim={editing} onClose={() => { setEditing(null); void invalidate("contracting"); }} />}
    </>
  );
}

function ClaimDialog({ tenantId, contractId, onClose }: { tenantId: string; contractId: string; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const [v, setV] = useState({ title: "", kind: "time", eventDate: isoDay(), description: "", amountClaimed: "", daysClaimed: "" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (v.title.trim().length < 3 || v.description.trim().length < 5) return setError(new Error("أدخل عنوان الحدث ووصفه"));
    setBusy(true); setError(null);
    try {
      await api("POST", `/t/contracts/${contractId}/claims`, { tenant: tenantId, body: { title: v.title.trim(), kind: v.kind, eventDate: v.eventDate, description: v.description.trim(),
        amountClaimed: v.amountClaimed === "" ? null : num(v.amountClaimed), daysClaimed: v.daysClaimed === "" ? null : Math.round(num(v.daysClaimed)) } });
      await invalidate("contracting");
      onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title="تسجيل حدث قد يُطالب به"
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">تسجيل الحدث</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <div className="form-grid">
        <TextField label="العنوان" required value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} maxLength={200} />
        <TextField label="تاريخ الحدث" required type="date" dir="ltr" value={v.eventDate} max={isoDay()} onChange={(e) => setV({ ...v, eventDate: e.target.value })} />
        <SelectField label="الأثر" required value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })} options={[{ value: "time", label: "مدة" }, { value: "cost", label: "تكلفة" }, { value: "time_cost", label: "مدة وتكلفة" }]} />
      </div>
      <TextAreaField label="الوصف" required value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} maxLength={2000} />
      <div className="form-grid">
        <TextField label="المبلغ المتوقع (⃁)" optional numeric inputMode="decimal" dir="ltr" value={v.amountClaimed} onChange={(e) => setV({ ...v, amountClaimed: e.target.value })} />
        <TextField label="الأيام المتوقعة" optional numeric inputMode="numeric" dir="ltr" value={v.daysClaimed} onChange={(e) => setV({ ...v, daysClaimed: e.target.value })} />
      </div>
      <FormError error={error} />
    </Dialog>
  );
}

function ClaimStatusDialog({ tenantId, claim, onClose }: { tenantId: string; claim: Claim; onClose: () => void }) {
  const [v, setV] = useState({ status: claim.status, noticeDate: claim.noticeDate ?? "" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (v.status !== "identified" && !v.noticeDate) return setError(new Error("سجّل تاريخ إخطار العميل"));
    setBusy(true); setError(null);
    try {
      await api("PUT", `/t/claims/${claim.id}`, { tenant: tenantId, body: { status: v.status, noticeDate: v.noticeDate || null } });
      onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title={`تحديث: ${claim.title}`}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">حفظ</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <div className="form-grid">
        <SelectField label="الحالة" required value={v.status} onChange={(e) => setV({ ...v, status: e.target.value })} options={Object.entries(CLAIM_STATUS).map(([value, label]) => ({ value, label }))} />
        <TextField label="تاريخ الإخطار" optional={v.status === "identified"} required={v.status !== "identified"} type="date" dir="ltr" value={v.noticeDate} onChange={(e) => setV({ ...v, noticeDate: e.target.value })} />
      </div>
      <FormError error={error} />
    </Dialog>
  );
}

// ── Guarantees ────────────────────────────────────────────────────────────────────────────────
const GUARANTEE_KIND: Record<string, string> = { bid: "ابتدائي", performance: "نهائي (حسن تنفيذ)", advance: "دفعة مقدمة", retention: "بدل محتجزات" };
function GuaranteesTab({ tenantId, contract }: { tenantId: string; contract: ContractDetail }) {
  const { can, writable } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [releasing, setReleasing] = useState<ContractDetail["guarantees"][number] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  async function release() {
    if (!releasing) return;
    setBusy(true); setErr(null);
    try {
      await api("POST", `/t/guarantees/${releasing.id}/release`, { tenant: tenantId, body: {} });
      toast.success(`أُفرج عن الضمان ${releasing.number}`);
      setReleasing(null);
      await invalidate("contracting");
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <>
      {can("guarantees.create") && writable && <div className="toolbar row" style={{ justifyContent: "end" }}><Button size="sm" icon={<Plus />} onClick={() => setAdding(true)}>ضمان بنكي</Button></div>}
      <DataTable caption="الضمانات البنكية" query={{ isPending: false, isError: false, error: null, refetch: () => undefined, data: { items: contract.guarantees } }} rowKey={(r) => r.id}
        empty={{ title: "لا ضمانات مسجلة", body: "سجّل الضمان النهائي وضمان الدفعة المقدمة لتنبيهك قبل انتهائها، وتُرحَّل عمولة البنك على المشروع." }}
        columns={[
          { key: "kind", header: "الضمان", cell: (r) => <span className="stack-tight"><strong>{GUARANTEE_KIND[r.kind]}</strong><span className="muted acc-small">{r.bank} · <Ref>{r.number}</Ref></span></span> },
          { key: "amount", header: "المبلغ", numeric: true, cell: (r) => money(r.amount) },
          { key: "expiresOn", header: "ينتهي", cell: (r) => r.status === "active" ? <>{day(r.expiresOn)} {r.daysLeft <= 60 && <Badge tone={r.daysLeft < 15 ? "danger" : "warning"}>{r.daysLeft < 0 ? "منتهٍ" : `بعد ${integer(r.daysLeft)} يوماً`}</Badge>}</> : <Badge tone="neutral">مُفرج عنه</Badge> },
          { key: "fee", header: "العمولة", numeric: true, cell: (r) => money(r.fee) },
        ]}
        actions={can("guarantees.edit") && writable ? (r) => r.status === "active" ? <Button size="sm" variant="ghost" onClick={() => { setErr(null); setReleasing(r); }}>إفراج</Button> : null : undefined} />
      {adding && <GuaranteeDialog tenantId={tenantId} contract={contract} onClose={() => setAdding(false)} />}
      <ConfirmDialog open={Boolean(releasing)} onClose={() => setReleasing(null)} busy={busy} error={err ? errorMessage(err) : null} onConfirm={() => void release()} destructive={false}
        title={`الإفراج عن الضمان ${releasing?.number ?? ""}؟`} confirmLabel="تسجيل الإفراج" message="بعد استلام خطاب الإفراج من البنك أو العميل. لا يعود الضمان سارياً." />
    </>
  );
}

function GuaranteeDialog({ tenantId, contract, onClose }: { tenantId: string; contract: ContractDetail; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const [v, setV] = useState({ kind: "performance", number: "", bank: "", amount: "", issuedOn: isoDay(), expiresOn: "", fee: "0", feePaidFrom: "bank_transfer" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  async function submit() {
    if (!v.number.trim() || v.bank.trim().length < 2 || !(num(v.amount) > 0) || !v.expiresOn) return setError(new Error("أكمل الرقم والبنك والمبلغ وتاريخ الانتهاء"));
    if (v.expiresOn < v.issuedOn) return setError(new Error("تاريخ الانتهاء قبل الإصدار"));
    setBusy(true); setError(null);
    try {
      await api("POST", `/t/contracts/${contract.id}/guarantees`, { tenant: tenantId, body: { kind: v.kind, number: v.number.trim(), bank: v.bank.trim(), amount: num(v.amount),
        issuedOn: v.issuedOn, expiresOn: v.expiresOn, fee: num(v.fee || "0"), feePaidFrom: num(v.fee || "0") > 0 ? v.feePaidFrom : null } });
      await invalidate("contracting");
      onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title="ضمان بنكي"
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">حفظ الضمان</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <div className="form-grid">
        <SelectField label="النوع" required value={v.kind} onChange={set("kind")} options={Object.entries(GUARANTEE_KIND).map(([value, label]) => ({ value, label }))} />
        <TextField label="رقم الضمان" required dir="ltr" value={v.number} onChange={set("number")} maxLength={60} />
        <TextField label="البنك" required value={v.bank} onChange={set("bank")} maxLength={120} />
        <TextField label="المبلغ (⃁)" required numeric inputMode="decimal" dir="ltr" value={v.amount} onChange={set("amount")} />
        <TextField label="تاريخ الإصدار" required type="date" dir="ltr" value={v.issuedOn} onChange={set("issuedOn")} />
        <TextField label="تاريخ الانتهاء" required type="date" dir="ltr" value={v.expiresOn} onChange={set("expiresOn")} />
        <TextField label="عمولة البنك (⃁)" optional numeric inputMode="decimal" dir="ltr" value={v.fee} onChange={set("fee")} hint="تُرحَّل مصروفاً على مركز تكلفة المشروع" />
        {num(v.fee || "0") > 0 && <SelectField label="سُددت من" required value={v.feePaidFrom} onChange={set("feePaidFrom")} options={[{ value: "bank_transfer", label: "البنك" }, { value: "cash", label: "الصندوق" }]} />}
      </div>
      <FormError error={error} />
    </Dialog>
  );
}

// ── IPC editor ────────────────────────────────────────────────────────────────────────────────
interface IpcLine { id: string; kind: "boq" | "vo" | "mos"; code: string | null; description: string; unit: string | null; rate: number; previousQty: number; submittedQty: number;
  certifiedQty: number | null; previousAmount: number; submittedAmount: number | null; certifiedAmount: number | null; amountToDate: number; currentAmount: number }
interface IpcDetail { id: string; number: number; kind: string; status: string; periodFrom: string; periodTo: string; ldDays: number; paymentOrderDate: string | null; contractId: string;
  contractNumber: string; contractTitle: string; governmentClient: boolean; ldRatePerDay: number; ldCapPct: number | null; invoiceId: string | null; invoiceNumber: string | null;
  ldCreditNoteNumber: string | null; lines: IpcLine[]; role: "MAIN" | "SUB"; supplierName: string | null; supplierInvoice: string | null; vatMode: string | null; deductions: Deduction[];
  totals: { grossToDate: number; previousGross: number; currentGross: number; retention: number; advanceRecovery: number; advanceRecoveryVat: number; ld: number; ldVat: number; ldCapped: boolean;
    vat: number; deductions: number; reverseChargeVat: number; netPayable: number } }

export function IpcPage() {
  const { tenantId, can, writable } = useTenant();
  const { ipcId } = useParams({ strict: false }) as { ipcId: string };
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ["t", tenantId, "contracting", "ipc", ipcId], queryFn: () => api<IpcDetail>("GET", `/t/ipcs/${ipcId}`, { tenant: tenantId }) });
  // A telecom rate-card contract bills by site milestones: its draft IPC can be filled from the sites' states.
  const terms = useQuery({ enabled: Boolean(q.data && q.data.status === "draft" && q.data.role !== "SUB" && can("telecom_sites.view")),
    queryKey: ["t", tenantId, "contracting", "milestone-terms", q.data?.contractId],
    queryFn: () => api<{ items: { milestone: string; pct: number }[] }>("GET", `/t/contracts/${q.data!.contractId}/milestone-terms`, { tenant: tenantId }) });
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [ldDays, setLdDays] = useState<string | null>(null);
  const [orderDate, setOrderDate] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [confirm, setConfirm] = useState<"approve" | "invoice" | "delete" | "record" | null>(null);
  const [key, renewKey] = useIdempotencyKey();
  if (q.isPending) return <div className="page"><TableSkeleton columns={6} /></div>;
  if (q.isError) return <div className="page"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div>;
  const i = q.data;
  const t = i.totals;
  const isSub = i.role === "SUB";
  const phase = i.status === "draft" ? "submitted" : i.status === "submitted" ? "certified" : null;
  const editable = phase !== null && writable && can(phase === "submitted" ? "ipcs.create" : "ipcs.certify");
  const valueOf = (l: IpcLine) => (l.kind === "mos" ? (l.certifiedAmount ?? l.submittedAmount ?? 0) : (l.certifiedQty ?? l.submittedQty));
  const dirty = Object.keys(edits).length > 0;
  const changes = () => i.lines.filter((l) => edits[l.id] !== undefined).map((l) => (l.kind === "mos" ? { id: l.id, amount: num(edits[l.id]!) } : { id: l.id, quantity: num(edits[l.id]!) }));
  const invalid = i.lines.find((l) => edits[l.id] !== undefined && (!Number.isFinite(num(edits[l.id]!)) || edits[l.id] === "" || (l.kind !== "mos" && num(edits[l.id]!) < 0)));
  async function run(what: string, fn: () => Promise<unknown>, done: string) {
    setBusy(what); setError(null);
    try { await fn(); toast.success(done); setEdits({}); setConfirm(null); await invalidate("contracting"); } catch (e) { setError(e); } finally { setBusy(null); }
  }
  const save = () => run("save", () => api("PUT", `/t/ipcs/${ipcId}/quantities`, { tenant: tenantId, body: { lines: changes() } }), "حُفظت الكميات");
  const fill = () => dirty ? setError(new Error("لديك كميات غير محفوظة: احفظها أو تراجع عنها قبل التعبئة من المواقع"))
    : run("fill", () => api("POST", `/t/ipcs/${ipcId}/fill-from-sites`, { tenant: tenantId }), "عُبئت الكميات من حالة المواقع في نهاية الفترة");
  const submit = () => run("submit", async () => {
    if (dirty) await api("PUT", `/t/ipcs/${ipcId}/quantities`, { tenant: tenantId, body: { lines: changes() } });
    await api("POST", `/t/ipcs/${ipcId}/submit`, { tenant: tenantId, body: { ldDays: Math.round(num(ldDays ?? String(i.ldDays)) || 0) } });
  }, "قُدِّم المستخلص للاستشاري");
  const certify = () => run("certify", () => api("POST", `/t/ipcs/${ipcId}/certify`, { tenant: tenantId, body: { lines: changes() } }), "سُجّلت كميات الاستشاري");
  // Approving freezes the figures: unsaved quantities would be lost silently, so they must be saved (or certified) first.
  const approve = () => dirty ? setError(new Error("لديك كميات غير محفوظة: احفظها أو اعتمدها قبل اعتماد المستخلص"))
    : run("approve", () => api("POST", `/t/ipcs/${ipcId}/approve`, { tenant: tenantId }), "اعتُمد المستخلص وثُبتت أرقامه");
  const invoice = () => i.governmentClient && !i.paymentOrderDate && !orderDate ? setError(new Error("أدخل تاريخ أمر الدفع: الجهة الحكومية تستحق ضريبتها به"))
    : run("invoice", async () => {
    await api("POST", `/t/ipcs/${ipcId}/invoice`, { tenant: tenantId, idempotencyKey: key, body: orderDate ? { paymentOrderDate: orderDate } : {} });
    renewKey();
  }, "صدرت الفاتورة الضريبية للمستخلص");
  const remove = () => run("delete", async () => {
    await api("DELETE", `/t/ipcs/${ipcId}`, { tenant: tenantId });
    await navigate({ to: "/w/$tenantId/contracting/contracts/$contractId", params: { tenantId, contractId: i.contractId } });
  }, "حُذف المستخلص");
  const primary = i.status === "draft" && can("ipcs.create") ? <Button variant="primary" loading={busy === "submit"} loadingText="جارٍ التقديم…" disabled={Boolean(invalid)} onClick={() => void submit()}>تقديم المستخلص</Button>
    : i.status === "submitted" && can("ipcs.certify") ? <Button variant="primary" loading={busy === "certify"} loadingText="جارٍ الحفظ…" disabled={Boolean(invalid)} onClick={() => void certify()}>اعتماد كميات الاستشاري</Button>
    : (i.status === "submitted" || i.status === "certified") && can("ipcs.approve") ? <Button variant="primary" onClick={() => { setError(null); setConfirm("approve"); }}>{isSub ? "اعتماد المستخلص" : "اعتماد العميل"}</Button>
    : i.status === "approved" && can("ipcs.invoice") ? (isSub ? <Button variant="primary" icon={<FileSignature />} onClick={() => { setError(null); setConfirm("record"); }}>تسجيل فاتورة مقاول الباطن</Button>
      : <Button variant="primary" icon={<FileSignature />} onClick={() => { setError(null); setConfirm("invoice"); }}>إصدار الفاتورة الضريبية</Button>) : null;
  return (
    <div className="page">
      <PageHeader eyebrow={`العقد ${i.contractNumber} · ${i.contractTitle}`}
        title={<>المستخلص رقم {integer(i.number)}{i.kind === "final" && " (ختامي)"} <Status map={IPC_STATUS} value={i.status} /></>}
        description={<>{isSub && <>مقاول الباطن {i.supplierName} · </>}الفترة {day(i.periodFrom)} – {day(i.periodTo)}{i.supplierInvoice && <> · فاتورته <Ref>{i.supplierInvoice}</Ref></>}{i.invoiceNumber && <> · الفاتورة <Ref>{i.invoiceNumber}</Ref></>}{i.ldCreditNoteNumber && <> · إشعار دائن الغرامة <Ref>{i.ldCreditNoteNumber}</Ref></>}</>}
        actions={<>
          <Link to="/w/$tenantId/contracting/contracts/$contractId" params={{ tenantId, contractId: i.contractId }} className="btn btn-ghost">العقد</Link>
          {i.status === "draft" && can("ipcs.create") && writable && <Button variant="ghost" icon={<Trash2 />} onClick={() => { setError(null); setConfirm("delete"); }}>حذف المسودة</Button>}
          {editable && i.status === "draft" && Boolean(terms.data?.items.length) && <Button loading={busy === "fill"} loadingText="جارٍ التعبئة…" onClick={() => void fill()}>تعبئة من المواقع</Button>}
          {editable && dirty && i.status === "draft" && <Button loading={busy === "save"} loadingText="جارٍ الحفظ…" disabled={Boolean(invalid)} onClick={() => void save()}>حفظ الكميات</Button>}
          {writable && primary}
        </>} />
      <FormError error={error} />
      {invalid && <p className="field-error" role="alert">قيمة غير صالحة في البند {invalid.code ?? invalid.description}</p>}
      <div className="stats">
        <StatCard label="أعمال الفترة" value={money(t.currentGross)} icon={<Building />} hue="indigo" note={`حتى تاريخه ${money(t.grossToDate)}`} />
        <StatCard label="المحتجز" value={money(t.retention)} icon={<ShieldAlert />} hue="amber" note={isSub ? "مستحق له عند الإفراج" : "لا يُنقص وعاء الضريبة"} />
        <StatCard label="استرداد الدفعة المقدمة" value={money(t.advanceRecovery + t.advanceRecoveryVat)} icon={<HandCoins />} hue="violet" note={`منها ضريبة ${money(t.advanceRecoveryVat)}`} />
        <StatCard label={isSub ? "المستحق لمقاول الباطن" : "الصافي المستحق"} value={money(t.netPayable)} icon={<FileSignature />} hue="green"
          note={isSub && i.vatMode === "reverse" ? `احتساب عكسي ${money(t.reverseChargeVat)}` : `شامل ضريبة ${money(t.vat)}`} />
      </div>
      <section className="panel" aria-label="بنود المستخلص">
        <DataTable caption="بنود المستخلص" query={{ ...q, data: { items: i.lines } }} rowKey={(r) => r.id}
          empty={{ title: "لا بنود", body: "جدول الكميات فارغ." }}
          columns={[
            { key: "description", header: "البند", wrap: true, sortKey: false, cell: (r) => <span className="stack-tight">{r.description}{r.kind === "vo" && <Badge tone="info">أمر تغيير</Badge>}</span> },
            { key: "rate", header: "السعر", numeric: true, sortKey: false, cell: (r) => r.kind === "mos" ? "" : money(r.rate) },
            { key: "previousQty", header: "السابق", numeric: true, sortKey: false, cell: (r) => r.kind === "mos" ? money(r.previousAmount) : quantity(r.previousQty) },
            { key: "toDate", header: phase === "certified" ? "المعتمد حتى تاريخه" : "حتى تاريخه", numeric: true, sortKey: false, cell: (r) => editable ? (
              <input className="input input-sm num" dir="ltr" inputMode="decimal" aria-label={`${r.kind === "mos" ? "قيمة" : "كمية"} ${r.code ?? r.description} حتى تاريخه`} style={{ maxWidth: "9rem" }}
                value={edits[r.id] ?? String(valueOf(r))} onChange={(e) => setEdits({ ...edits, [r.id]: e.target.value })} />
            ) : r.kind === "mos" ? money(valueOf(r)) : <>{quantity(valueOf(r))}{r.certifiedQty !== null && r.certifiedQty !== r.submittedQty && <span className="muted acc-small"> (قُدّم {quantity(r.submittedQty)})</span>}</> },
            { key: "currentAmount", header: "قيمة الفترة", numeric: true, sortKey: false, cell: (r) => r.currentAmount ? money(r.currentAmount) : "—" },
          ]} />
      </section>
      <section className="panel panel-pad" aria-label="الحساب">
        <dl className="dl">
          <dt>قيمة الأعمال حتى تاريخه</dt><dd className="num">{money(t.grossToDate)}</dd>
          <dt>ناقص: السابق</dt><dd className="num">{money(t.previousGross)}</dd>
          <dt>أعمال الفترة (وعاء الضريبة)</dt><dd className="num"><strong>{money(t.currentGross)}</strong></dd>
          <dt>ضريبة القيمة المضافة</dt><dd className="num">{money(t.vat)}</dd>
          <dt>ناقص: المحتجزات</dt><dd className="num">{money(t.retention)}</dd>
          <dt>ناقص: استرداد الدفعة المقدمة وضريبتها</dt><dd className="num">{money(t.advanceRecovery + t.advanceRecoveryVat)}</dd>
          <dt>ناقص: غرامة التأخير وضريبتها{t.ldCapped && " (بلغت السقف)"}</dt><dd className="num">{money(t.ld + t.ldVat)}</dd>
          {isSub && <><dt>ناقص: الخصومات والمقاصة</dt><dd className="num">{money(t.deductions)}</dd></>}
          {isSub && i.vatMode === "reverse" && <><dt>ضريبة الاحتساب العكسي (علينا، مدخلات ومخرجات)</dt><dd className="num">{money(t.reverseChargeVat)}</dd></>}
          <dt><strong>الصافي المستحق</strong></dt><dd className="num"><strong>{money(t.netPayable)}</strong></dd>
        </dl>
        {i.status === "draft" && writable && can("ipcs.create") && (
          <TextField label="أيام التأخير المحتسبة في هذا المستخلص" optional numeric inputMode="numeric" dir="ltr" value={ldDays ?? String(i.ldDays)} onChange={(e) => setLdDays(e.target.value)}
            hint={i.ldRatePerDay ? `${money(i.ldRatePerDay)} لليوم حتى سقف ${i.ldCapPct === null ? "—" : percent(i.ldCapPct)} من قيمة العقد، تصدر إشعاراً دائناً بضريبته` : "لا غرامة تأخير في العقد"} />
        )}
      </section>
      {isSub && (i.deductions.length > 0 || ["draft", "submitted", "certified"].includes(i.status)) && (
        <DeductionsPanel key={i.deductions.map((d) => d.id).join()} tenantId={tenantId} ipcId={ipcId} items={i.deductions}
          editable={writable && can("ipcs.certify") && ["draft", "submitted", "certified"].includes(i.status)} onSaved={() => void invalidate("contracting")} />
      )}
      {confirm === "record" && <RecordInvoiceDialog tenantId={tenantId} ipcId={ipcId} vatMode={i.vatMode ?? "charged"} net={t.netPayable} onClose={() => setConfirm(null)}
        onDone={() => { toast.success("سُجّلت فاتورة مقاول الباطن ورُحّل قيدها"); setConfirm(null); void invalidate("contracting"); }} />}
      <ConfirmDialog open={confirm === "approve"} onClose={() => setConfirm(null)} busy={busy === "approve"} error={error ? errorMessage(error) : null} onConfirm={() => void approve()} destructive={false}
        title={isSub ? `اعتماد مستخلص مقاول الباطن ${i.number}؟` : `اعتماد العميل للمستخلص ${i.number}؟`} confirmLabel="اعتماد المستخلص"
        message={<>تُثبَّت الأرقام: أعمال الفترة {money(t.currentGross)}، المحتجز {money(t.retention)}، الصافي {money(t.netPayable)}. لا تُعدّل بعد الاعتماد.</>} />
      <ConfirmDialog open={confirm === "invoice"} onClose={() => setConfirm(null)} busy={busy === "invoice"} error={error ? errorMessage(error) : null} onConfirm={() => void invoice()} destructive={false}
        title={`إصدار فاتورة المستخلص ${i.number}؟`} confirmLabel="إصدار الفاتورة"
        message={<>فاتورة ضريبية بقيمة أعمال الفترة {money(t.currentGross)} وضريبتها كاملة، يُخصم منها استرداد الدفعة المقدمة، ويُسجَّل المحتجز ذمةً مستقلة.{t.ld > 0 && <> ويصدر إشعار دائن بغرامة التأخير {money(t.ld + t.ldVat)}.</>} تُرسل للهيئة ولا تُحذف بعد الإصدار.</>}>
        {i.governmentClient && <TextField label="تاريخ أمر الدفع" required type="date" dir="ltr" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} hint="الجهة الحكومية: الضريبة تستحق بتاريخ أمر الدفع أو القبض أيهما أسبق" />}
      </ConfirmDialog>
      <ConfirmDialog open={confirm === "delete"} onClose={() => setConfirm(null)} busy={busy === "delete"} error={error ? errorMessage(error) : null} onConfirm={() => void remove()}
        title={`حذف مسودة المستخلص ${i.number}؟`} confirmLabel="حذف المسودة" message="تُحذف الكميات المدخلة. المستخلصات المقدمة لا تُحذف." />
    </div>
  );
}
