import { useQuery } from "@tanstack/react-query";
import { Boxes, Flag, Plus, Tractor, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, ApiError, type Page } from "../../api/client";
import type { Location } from "../../api/types";
import { useIdempotencyKey } from "../../app/session";
import { useInvalidate, useTenant } from "../../app/tenant";
import { day, integer, isoDay, money, percent, quantity } from "../../lib/format";
import { Button, IconButton } from "../../ui/Button";
import { DataTable } from "../../ui/DataTable";
import { Dialog } from "../../ui/Dialog";
import { Checkbox, SelectField, TextField } from "../../ui/Field";
import { Badge, PageHeader, StatCard } from "../../ui/Layout";
import { ErrorState, FormError } from "../../ui/States";
import { useToast } from "../../ui/Toast";
import { StatusTabs } from "./Inventory";
import { IngredientPicker } from "./pickers";

// Contracting C7: materials issued from site stores to projects (on WBS and cost code, and the BOQ item they served),
// consumption against the BOQ's norms, local content, and equipment charged to projects by daily timesheets.
// Costs are weighted-average costs taken by the server; charges use the machine's internal rate.

const num = (s: string) => Number(String(s).replace(/,/g, ""));
const OWNERSHIP: Record<string, string> = { owned: "مملوكة", rented: "مستأجرة", subcontractor: "من مقاول باطن" };
interface ProjectOpt { id: string; code: string; name: string }
const useProjects = (tenantId: string) => useQuery({ queryKey: ["t", tenantId, "contracting", "projects"], queryFn: () => api<{ items: ProjectOpt[] }>("GET", "/t/projects", { tenant: tenantId }) });

export function SiteMaterialsPage() {
  const { tenantId, can } = useTenant();
  const [tab, setTab] = useState(can("site_stores.view") ? "issues" : "equipment");
  return (
    <div className="page">
      <PageHeader eyebrow="المقاولات" title="مواد المواقع والمعدات"
        description="صرف المواد من مخزن الموقع على المشروع وعنصر WBS ورمز التكلفة، ومقارنة المصروف بالكميات النظرية للأعمال المعتمدة، والمحتوى المحلي، وتحميل المعدات بساعات تشغيلها." />
      <section className="panel" aria-label="مواد المواقع والمعدات">
        <div className="toolbar"><StatusTabs value={tab} onChange={setTab} options={[
          ...(can("site_stores.view") ? [["issues", "صرف وإرجاع المواد"], ["consumption", "الاستهلاك مقابل الجدول"], ["local", "المحتوى المحلي"]] as [string, string][] : []),
          ...(can("equipment.view") ? [["equipment", "المعدات"]] as [string, string][] : [])]} /></div>
        {tab === "issues" && <IssuesTab tenantId={tenantId} />}
        {tab === "consumption" && <ConsumptionTab tenantId={tenantId} />}
        {tab === "local" && <LocalContentTab tenantId={tenantId} />}
        {tab === "equipment" && <EquipmentTab tenantId={tenantId} />}
      </section>
    </div>
  );
}

interface IssueRow { id: string; number: number; kind: string; issuedOn: string; projectCode: string; locationName: string; wbsCode: string | null; costCode: string | null; value: number;
  lines: { name: string; quantity: number; unit: string; boq: string | null }[] | null }
function IssuesTab({ tenantId }: { tenantId: string }) {
  const { can, writable } = useTenant();
  const q = useQuery({ queryKey: ["t", tenantId, "contracting", "site-issues"], queryFn: () => api<{ items: IssueRow[] }>("GET", "/t/site-issues", { tenant: tenantId }) });
  const [open, setOpen] = useState<"issue" | "return" | null>(null);
  return (
    <>
      {can("site_stores.issue") && writable && <div className="toolbar row" style={{ justifyContent: "end", gap: "var(--sp-2)" }}>
        <Button size="sm" onClick={() => setOpen("return")}>إرجاع للمخزن</Button>
        <Button size="sm" variant="primary" icon={<Plus />} onClick={() => setOpen("issue")}>صرف مواد</Button>
      </div>}
      <DataTable caption="سندات صرف وإرجاع المواد" query={q} rowKey={(r) => r.id}
        empty={{ title: "لا سندات صرف", body: "أنشئ مخزن موقع للمشروع من «المستودعات» (النوع: مخزن موقع)، واستلم فيه أو حوّل إليه، ثم اصرف منه على بنود المشروع." }}
        columns={[
          { key: "number", header: "السند", cell: (r) => <span className="stack-tight"><strong className="num">#{r.number}</strong>{r.kind === "return" ? <Badge tone="info">إرجاع</Badge> : <Badge tone="neutral">صرف</Badge>}</span> },
          { key: "issuedOn", header: "التاريخ", cell: (r) => day(r.issuedOn) },
          { key: "projectCode", header: "المشروع", cell: (r) => <span className="stack-tight"><span className="num">{r.projectCode}</span><span className="muted acc-small">{r.locationName}</span></span> },
          { key: "lines", header: "المواد", wrap: true, sortKey: false, cell: (r) => (r.lines ?? []).map((l) => `${l.name} ${quantity(l.quantity)} ${l.unit}${l.boq ? ` (بند ${l.boq})` : ""}`).join("، ") },
          { key: "wbsCode", header: "WBS / الرمز", cell: (r) => [r.wbsCode, r.costCode].filter(Boolean).join(" · ") || "—" },
          { key: "value", header: "القيمة", numeric: true, cell: (r) => money(r.kind === "return" ? -r.value : r.value) },
        ]} />
      {open && <IssueDialog tenantId={tenantId} kind={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function IssueDialog({ tenantId, kind, onClose }: { tenantId: string; kind: "issue" | "return"; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [key] = useIdempotencyKey();
  const projects = useProjects(tenantId);
  const [v, setV] = useState({ projectId: "", locationId: "", issuedOn: isoDay(), wbsId: "", notes: "" });
  const [lines, setLines] = useState<{ ingredientId: string; name: string; unit: string; quantity: string; boqItemId: string }[]>([]);
  const locations = useQuery({ queryKey: ["t", tenantId, "locations", "sites"], queryFn: () => api<Page<Location & { projectId: string | null }>>("GET", "/t/locations", { tenant: tenantId, query: { pageSize: 100, isActive: "true" } }) });
  const project = useQuery({ enabled: Boolean(v.projectId), queryKey: ["t", tenantId, "contracting", "project", v.projectId],
    queryFn: () => api<{ wbs: { id: string; code: string; name: string }[]; contracts: { id: string; role: string; status: string }[] }>("GET", `/t/projects/${v.projectId}`, { tenant: tenantId }) });
  const main = project.data?.contracts.find((c) => c.role === "MAIN" && c.status !== "draft");
  const boq = useQuery({ enabled: Boolean(main), queryKey: ["t", tenantId, "contracting", "boq", main?.id],
    queryFn: () => api<{ items: { id: string; code: string; description: string; isSection: boolean }[] }>("GET", `/t/contracts/${main!.id}/boq`, { tenant: tenantId }) });
  const sites = (locations.data?.items ?? []).filter((l) => l.locationType === "site" && l.projectId === v.projectId);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!v.projectId || !v.locationId) return setError(new Error("اختر المشروع ومخزن الموقع"));
    if (!lines.length || lines.some((l) => !(num(l.quantity) > 0))) return setError(new Error("أضف المواد بكميات موجبة"));
    setBusy(true); setError(null);
    try {
      await api("POST", "/t/site-issues", { tenant: tenantId, idempotencyKey: key, body: { kind, projectId: v.projectId, locationId: v.locationId, issuedOn: v.issuedOn,
        wbsId: v.wbsId || null, notes: v.notes.trim() || null, lines: lines.map((l) => ({ ingredientId: l.ingredientId, quantity: num(l.quantity), boqItemId: l.boqItemId || null })) } });
      toast.success(kind === "issue" ? "صُرفت المواد وحُمّلت تكلفتها على المشروع" : "أُرجعت المواد للمخزن وخُصمت من تكلفة المشروع");
      await invalidate("contracting", "stock");
      onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open wide onClose={onClose} busy={busy} onSubmit={() => void submit()} title={kind === "issue" ? "صرف مواد على مشروع" : "إرجاع مواد من مشروع"}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ التسجيل…">{kind === "issue" ? "صرف" : "إرجاع"}</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <div className="form-grid">
        <SelectField label="المشروع" required placeholder="اختر المشروع" value={v.projectId} onChange={(e) => setV({ ...v, projectId: e.target.value, locationId: "", wbsId: "" })}
          options={(projects.data?.items ?? []).map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))} />
        <SelectField label="مخزن الموقع" required placeholder={v.projectId && !sites.length ? "لا مخزن موقع للمشروع" : "اختر المخزن"} value={v.locationId}
          onChange={(e) => setV({ ...v, locationId: e.target.value })} options={sites.map((l) => ({ value: l.id, label: l.name }))}
          hint={v.projectId && locations.data && !sites.length ? "أضفه من «المستودعات ومخازن المواقع» (النوع: مخزن موقع، والمشروع)" : undefined} />
        <SelectField label="عنصر WBS" placeholder="بلا" value={v.wbsId} onChange={(e) => setV({ ...v, wbsId: e.target.value })}
          options={(project.data?.wbs ?? []).map((w) => ({ value: w.id, label: `${w.code} ${w.name}` }))} />
        <TextField label="التاريخ" required type="date" dir="ltr" value={v.issuedOn} max={isoDay()} onChange={(e) => setV({ ...v, issuedOn: e.target.value })} />
      </div>
      {lines.map((l, i) => (
        <div key={l.ingredientId + i} className="row" style={{ gap: "var(--sp-2)", alignItems: "end", flexWrap: "wrap" }}>
          <TextField label={`${l.name} (${l.unit})`} required numeric inputMode="decimal" dir="ltr" value={l.quantity} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />
          <SelectField label="لبند" placeholder="بلا" value={l.boqItemId} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, boqItemId: e.target.value } : x)))}
            options={(boq.data?.items ?? []).filter((b) => !b.isSection).map((b) => ({ value: b.id, label: `${b.code} ${b.description}`.slice(0, 60) }))} />
          <IconButton label={`حذف ${l.name}`} icon={<Trash2 />} onClick={() => setLines(lines.filter((_, j) => j !== i))} />
        </div>
      ))}
      {v.locationId && <IngredientPicker tenantId={tenantId} label="إضافة مادة" locationId={v.locationId} exclude={lines.map((l) => l.ingredientId)}
        onPick={(g) => setLines([...lines, { ingredientId: g.id, name: g.name, unit: g.baseUnitName, quantity: "", boqItemId: "" }])} />}
      <FormError error={error} />
    </Dialog>
  );
}

interface ConsumptionRow { boqItemId: string; code: string; description: string; ingredientId: string; material: string; unit: string; norm: number; certifiedQty: number;
  issuedQty: number; issuedValue: number; theoretical: number; variance: number; wastePct: number | null }
function ConsumptionTab({ tenantId }: { tenantId: string }) {
  const projects = useProjects(tenantId);
  const [projectId, setProjectId] = useState("");
  const project = useQuery({ enabled: Boolean(projectId), queryKey: ["t", tenantId, "contracting", "project", projectId],
    queryFn: () => api<{ contracts: { id: string; role: string; status: string; number: string }[] }>("GET", `/t/projects/${projectId}`, { tenant: tenantId }) });
  const main = project.data?.contracts.find((c) => c.role === "MAIN" && c.status !== "draft");
  const q = useQuery({ enabled: Boolean(main), queryKey: ["t", tenantId, "contracting", "consumption", main?.id],
    queryFn: () => api<{ items: ConsumptionRow[] }>("GET", `/t/contracts/${main!.id}/consumption`, { tenant: tenantId }) });
  return (
    <>
      <div className="toolbar"><SelectField label="المشروع" placeholder="اختر المشروع" value={projectId} onChange={(e) => setProjectId(e.target.value)}
        options={(projects.data?.items ?? []).map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))} /></div>
      {!projectId && <p className="muted panel-pad">اختر مشروعاً لترى المصروف من كل مادة مقابل ما تحتاجه الأعمال المعتمدة.</p>}
      {project.isError && <ErrorState error={project.error} onRetry={() => void project.refetch()} />}
      {projectId && !main && project.data && <p className="muted panel-pad">لا عقد رئيسي مفعّل لهذا المشروع.</p>}
      {main && <DataTable caption="الاستهلاك مقابل الكميات النظرية" query={q} rowKey={(r) => `${r.boqItemId}:${r.ingredientId}`}
        empty={{ title: "لا معدلات نظرية", body: "تأتي معدلات المواد لكل وحدة من تحليل أسعار العطاء عند تحويله إلى عقد، أو تُدخل للبند." }}
        columns={[
          { key: "code", header: "البند", cell: (r) => <span className="stack-tight"><strong className="num">{r.code}</strong><span className="muted acc-small">{r.description}</span></span> },
          { key: "material", header: "المادة", cell: (r) => `${r.material} (${quantity(r.norm)} ${r.unit} للوحدة)` },
          { key: "certifiedQty", header: "المنفذ المعتمد", numeric: true, cell: (r) => quantity(r.certifiedQty) },
          { key: "theoretical", header: "النظري", numeric: true, cell: (r) => quantity(r.theoretical) },
          { key: "issuedQty", header: "المصروف", numeric: true, cell: (r) => quantity(r.issuedQty) },
          { key: "wastePct", header: "الفرق", numeric: true, cell: (r) => r.wastePct === null ? "—" : <Badge tone={r.wastePct > 5 ? "danger" : r.wastePct < -5 ? "warning" : "success"}>{percent(r.wastePct)}</Badge> },
          { key: "issuedValue", header: "قيمة المصروف", numeric: true, cell: (r) => money(r.issuedValue) },
        ]} />}
    </>
  );
}

interface LcRow { name: string; mandatoryList: boolean; certificate: string | null; pct: number | null; validTo: string | null; value: number; localValue: number; missingCertificate: boolean }
function LocalContentTab({ tenantId }: { tenantId: string }) {
  const { can, writable } = useTenant();
  const projects = useProjects(tenantId);
  const [projectId, setProjectId] = useState("");
  const [editing, setEditing] = useState(false);
  const q = useQuery({ enabled: Boolean(projectId), queryKey: ["t", tenantId, "contracting", "local-content", projectId],
    queryFn: () => api<{ from: string; to: string; total: number; localValue: number; localPct: number | null; items: LcRow[] }>("GET", `/t/projects/${projectId}/local-content`, { tenant: tenantId }) });
  return (
    <>
      <div className="toolbar row" style={{ justifyContent: "space-between", gap: "var(--sp-2)", flexWrap: "wrap" }}>
        <SelectField label="المشروع" placeholder="اختر المشروع" value={projectId} onChange={(e) => setProjectId(e.target.value)}
          options={(projects.data?.items ?? []).map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))} />
        {can("site_stores.edit") && writable && <Button size="sm" icon={<Flag />} onClick={() => setEditing(true)}>شهادة محتوى محلي لصنف</Button>}
      </div>
      {q.data && <div className="stats">
        <StatCard label="المواد المصروفة" value={money(q.data.total)} icon={<Boxes />} hue="indigo" note={`${day(q.data.from)} – ${day(q.data.to)}`} />
        <StatCard label="المحتوى المحلي" value={q.data.localPct === null ? "—" : percent(q.data.localPct)} icon={<Flag />} hue="green" note={money(q.data.localValue)} />
        <StatCard label="أصناف قائمة إلزامية بلا شهادة" value={integer(q.data.items.filter((i) => i.missingCertificate).length)} icon={<Flag />} hue={q.data.items.some((i) => i.missingCertificate) ? "red" : "green"} />
      </div>}
      {projectId && <DataTable caption="المحتوى المحلي للمواد المصروفة" query={q} rowKey={(r) => r.name}
        empty={{ title: "لا مواد مصروفة في الفترة" }}
        columns={[
          { key: "name", header: "الصنف", cell: (r) => <span className="stack-tight"><strong>{r.name}</strong>{r.mandatoryList && <Badge tone="info">قائمة إلزامية</Badge>}</span> },
          { key: "certificate", header: "الشهادة", cell: (r) => r.certificate ? <span className="stack-tight"><bdi dir="ltr">{r.certificate}</bdi><span className="muted acc-small">{percent(r.pct ?? 0)} حتى {day(r.validTo)}</span></span>
            : r.missingCertificate ? <Badge tone="danger">مطلوبة</Badge> : "—" },
          { key: "value", header: "القيمة", numeric: true, cell: (r) => money(r.value) },
          { key: "localValue", header: "المحلي منها", numeric: true, cell: (r) => money(r.localValue) },
        ]} />}
      {editing && <LocalContentDialog tenantId={tenantId} onClose={() => { setEditing(false); void q.refetch(); }} />}
    </>
  );
}

function LocalContentDialog({ tenantId, onClose }: { tenantId: string; onClose: () => void }) {
  const toast = useToast();
  const [item, setItem] = useState<{ id: string; name: string } | null>(null);
  const [v, setV] = useState({ mandatoryList: false, certificate: "", pct: "", validTo: "" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!item) return setError(new Error("اختر الصنف"));
    if (Boolean(v.certificate.trim()) !== (v.pct !== "")) return setError(new Error("رقم الشهادة ونسبتها معاً"));
    setBusy(true); setError(null);
    try {
      await api("PUT", `/t/ingredients/${item.id}/local-content`, { tenant: tenantId, body: { mandatoryList: v.mandatoryList, certificate: v.certificate.trim() || null,
        pct: v.pct === "" ? null : num(v.pct), validTo: v.validTo || null } });
      toast.success(`حُفظ المحتوى المحلي لـ ${item.name}`);
      onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title="المحتوى المحلي لصنف"
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">حفظ</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      {item ? <p className="row" style={{ gap: "var(--sp-2)" }}>الصنف: <strong>{item.name}</strong> <Button size="sm" variant="ghost" onClick={() => setItem(null)}>تغيير</Button></p>
        : <IngredientPicker tenantId={tenantId} label="الصنف" onPick={(g) => {
            setItem({ id: g.id, name: g.name });
            // Start from what the item already carries, so saving never wipes a certificate by accident.
            void api<{ mandatoryList: boolean; certificate: string | null; pct: number | null; validTo: string | null }>("GET", `/t/ingredients/${g.id}/local-content`, { tenant: tenantId })
              .then((c) => setV({ mandatoryList: c.mandatoryList, certificate: c.certificate ?? "", pct: c.pct === null ? "" : String(c.pct), validTo: c.validTo ?? "" }))
              .catch((e) => setError(e));
          }} />}
      <Checkbox label="منتج في القائمة الإلزامية (شهادة المحتوى المحلي مطلوبة)" checked={v.mandatoryList} onChange={(e) => setV({ ...v, mandatoryList: e.target.checked })} />
      <div className="form-grid">
        <TextField label="رقم الشهادة" optional dir="ltr" value={v.certificate} onChange={(e) => setV({ ...v, certificate: e.target.value })} maxLength={60} />
        <TextField label="نسبة المحتوى المحلي %" optional numeric inputMode="decimal" dir="ltr" value={v.pct} onChange={(e) => setV({ ...v, pct: e.target.value })} />
        <TextField label="سارية حتى" optional type="date" dir="ltr" value={v.validTo} onChange={(e) => setV({ ...v, validTo: e.target.value })} />
      </div>
      <FormError error={error} />
    </Dialog>
  );
}

interface EquipmentRow { id: string; code: string; name: string; ownership: string; hourlyRate: number; idleRatePct: number; isActive: boolean; operatingHours: number; idleHours: number;
  breakdownHours: number; fuelLiters: number; charged: number; days: number; projects: string[]; utilisation: number | null }
function EquipmentTab({ tenantId }: { tenantId: string }) {
  const { can, writable } = useTenant();
  const [range] = useState(() => { const to = isoDay(); const d = new Date(); d.setUTCDate(d.getUTCDate() - 29); return { from: d.toISOString().slice(0, 10), to }; });
  const q = useQuery({ queryKey: ["t", tenantId, "contracting", "equipment", range], queryFn: () => api<{ items: EquipmentRow[] }>("GET", "/t/equipment", { tenant: tenantId, query: range }) });
  const [adding, setAdding] = useState(false);
  const [rate, setRate] = useState<EquipmentRow | null>(null);
  const [sheet, setSheet] = useState<EquipmentRow | null>(null);
  return (
    <>
      {can("machines.create") && writable && <div className="toolbar row" style={{ justifyContent: "end" }}><Button size="sm" icon={<Plus />} onClick={() => setAdding(true)}>معدة</Button></div>}
      <DataTable caption="المعدات آخر 30 يوماً" query={q} rowKey={(r) => r.id}
        empty={{ title: "لا معدات", body: "أضف معداتك (المملوكة والمستأجرة) وسعرها الداخلي للساعة، ثم سجّل ساعات تشغيلها اليومية على المشاريع." }}
        columns={[
          { key: "name", header: "المعدة", cell: (r) => <span className="stack-tight"><strong>{r.name}</strong><span className="muted acc-small"><bdi dir="ltr">{r.code}</bdi> · {OWNERSHIP[r.ownership]} · {money(r.hourlyRate)}/ساعة</span></span> },
          { key: "operatingHours", header: "تشغيل", numeric: true, cell: (r) => `${quantity(r.operatingHours)} س` },
          { key: "idleHours", header: "توقف / عطل", numeric: true, cell: (r) => `${quantity(r.idleHours)} / ${quantity(r.breakdownHours)} س` },
          { key: "utilisation", header: "الاستغلال", numeric: true, cell: (r) => r.utilisation === null ? "—" : <Badge tone={r.utilisation >= 70 ? "success" : r.utilisation >= 40 ? "warning" : "danger"}>{percent(r.utilisation)}</Badge> },
          { key: "fuelLiters", header: "الوقود (لتر)", numeric: true, cell: (r) => quantity(r.fuelLiters) },
          { key: "charged", header: "المحمّل على المشاريع", numeric: true, cell: (r) => <span className="stack-tight">{money(r.charged)}<span className="muted acc-small">{r.projects.join("، ")}</span></span> },
        ]}
        actions={writable ? (r) => <span className="row" style={{ gap: "var(--sp-1)" }}>
          {can("equipment.create") && r.isActive && <Button size="sm" variant="ghost" icon={<Tractor />} onClick={() => setSheet(r)}>يوم تشغيل</Button>}
          {can("equipment.edit") && <Button size="sm" variant="ghost" onClick={() => setRate(r)}>السعر</Button>}
        </span> : undefined} />
      {adding && <MachineDialog tenantId={tenantId} onClose={() => setAdding(false)} />}
      {rate && <RateDialog tenantId={tenantId} row={rate} onClose={() => setRate(null)} />}
      {sheet && <TimesheetDialog tenantId={tenantId} row={sheet} onClose={() => setSheet(null)} />}
    </>
  );
}

function MachineDialog({ tenantId, onClose }: { tenantId: string; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const [v, setV] = useState({ code: "", name: "", ownership: "owned", hourlyRate: "", idleRatePct: "0" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!/^[A-Za-z0-9-]{1,20}$/.test(v.code) || v.name.trim().length < 2) return setError(new Error("الرمز حروف إنجليزية وأرقام وشرطة، والاسم حرفان على الأقل"));
    setBusy(true); setError(null);
    try {
      const r = await api<{ id: string }>("POST", "/t/machines", { tenant: tenantId, body: { code: v.code, name: v.name.trim() } });
      await api("PUT", `/t/machines/${r.id}/equipment`, { tenant: tenantId, body: { ownership: v.ownership, hourlyRate: num(v.hourlyRate || "0"), idleRatePct: num(v.idleRatePct || "0") } });
      await invalidate("contracting");
      onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title="معدة جديدة"
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">إضافة</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <div className="form-grid">
        <TextField label="الرمز" required dir="ltr" value={v.code} onChange={(e) => setV({ ...v, code: e.target.value.toUpperCase() })} maxLength={20} />
        <TextField label="الاسم" required value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} maxLength={120} />
        <SelectField label="الملكية" required value={v.ownership} onChange={(e) => setV({ ...v, ownership: e.target.value })} options={Object.entries(OWNERSHIP).map(([value, label]) => ({ value, label }))} />
        <TextField label="السعر الداخلي للساعة (⃁)" required numeric inputMode="decimal" dir="ltr" value={v.hourlyRate} onChange={(e) => setV({ ...v, hourlyRate: e.target.value })} />
        <TextField label="ساعة التوقف % من السعر" optional numeric inputMode="decimal" dir="ltr" value={v.idleRatePct} onChange={(e) => setV({ ...v, idleRatePct: e.target.value })} />
      </div>
      <p className="muted">الصيانة الوقائية وأوامر الإصلاح لها من «المعدات وخطط الصيانة».</p>
      <FormError error={error} />
    </Dialog>
  );
}

function RateDialog({ tenantId, row, onClose }: { tenantId: string; row: EquipmentRow; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const [v, setV] = useState({ ownership: row.ownership, hourlyRate: String(row.hourlyRate), idleRatePct: String(row.idleRatePct) });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true); setError(null);
    try {
      await api("PUT", `/t/machines/${row.id}/equipment`, { tenant: tenantId, body: { ownership: v.ownership, hourlyRate: num(v.hourlyRate || "0"), idleRatePct: num(v.idleRatePct || "0") } });
      await invalidate("contracting");
      onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title={`سعر ${row.name}`}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">حفظ</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <p className="muted">يسري على الأيام التي تُسجَّل بعد الحفظ؛ الأيام المسجلة تبقى بسعرها.</p>
      <div className="form-grid">
        <SelectField label="الملكية" required value={v.ownership} onChange={(e) => setV({ ...v, ownership: e.target.value })} options={Object.entries(OWNERSHIP).map(([value, label]) => ({ value, label }))} />
        <TextField label="السعر للساعة (⃁)" required numeric inputMode="decimal" dir="ltr" value={v.hourlyRate} onChange={(e) => setV({ ...v, hourlyRate: e.target.value })} />
        <TextField label="ساعة التوقف %" required numeric inputMode="decimal" dir="ltr" value={v.idleRatePct} onChange={(e) => setV({ ...v, idleRatePct: e.target.value })} />
      </div>
      <FormError error={error} />
    </Dialog>
  );
}

function TimesheetDialog({ tenantId, row, onClose }: { tenantId: string; row: EquipmentRow; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const projects = useProjects(tenantId);
  const [v, setV] = useState({ projectId: "", workDate: isoDay(), operatingHours: "", idleHours: "0", breakdownHours: "0", fuelLiters: "0" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const charge = (num(v.operatingHours) || 0) * row.hourlyRate + (num(v.idleHours) || 0) * row.hourlyRate * row.idleRatePct / 100;
  async function submit() {
    if (!v.projectId) return setError(new Error("اختر المشروع"));
    setBusy(true); setError(null);
    try {
      await api("POST", "/t/equipment-timesheets", { tenant: tenantId, body: { machineId: row.id, projectId: v.projectId, workDate: v.workDate, operatingHours: num(v.operatingHours || "0"),
        idleHours: num(v.idleHours || "0"), breakdownHours: num(v.breakdownHours || "0"), fuelLiters: num(v.fuelLiters || "0") } });
      toast.success(`حُمّل يوم ${row.name} على المشروع`);
      await invalidate("contracting");
      onClose();
    } catch (e) { if (e instanceof ApiError && e.code === "duplicate") setError(new Error("سُجّل هذا اليوم للمعدة من قبل")); else setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title={`يوم تشغيل: ${row.name}`}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ التسجيل…">تسجيل</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <div className="form-grid">
        <SelectField label="المشروع" required placeholder="اختر المشروع" value={v.projectId} onChange={(e) => setV({ ...v, projectId: e.target.value })}
          options={(projects.data?.items ?? []).map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))} />
        <TextField label="اليوم" required type="date" dir="ltr" value={v.workDate} max={isoDay()} onChange={(e) => setV({ ...v, workDate: e.target.value })} />
        <TextField label="ساعات التشغيل" required numeric inputMode="decimal" dir="ltr" value={v.operatingHours} onChange={(e) => setV({ ...v, operatingHours: e.target.value })} />
        <TextField label="ساعات التوقف" optional numeric inputMode="decimal" dir="ltr" value={v.idleHours} onChange={(e) => setV({ ...v, idleHours: e.target.value })} />
        <TextField label="ساعات العطل" optional numeric inputMode="decimal" dir="ltr" value={v.breakdownHours} onChange={(e) => setV({ ...v, breakdownHours: e.target.value })} />
        <TextField label="الوقود (لتر)" optional numeric inputMode="decimal" dir="ltr" value={v.fuelLiters} onChange={(e) => setV({ ...v, fuelLiters: e.target.value })} />
      </div>
      <p className="muted">يُحمَّل على المشروع نحو {money(Math.round(charge * 100) / 100)} (يحسبه الخادم بسعر المعدة). ساعات العطل لا تُحمَّل.</p>
      <FormError error={error} />
    </Dialog>
  );
}
