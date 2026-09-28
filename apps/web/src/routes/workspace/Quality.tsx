import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ClipboardCheck, GitBranch, Plus, ShieldAlert, ShieldCheck, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { api, ApiError } from "../../api/client";
import type { Ingredient } from "../../api/types";
import { useIdempotencyKey } from "../../app/session";
import { useInvalidate, useTenant } from "../../app/tenant";
import { day, dayTime, integer, quantity, text } from "../../lib/format";
import { Button, IconButton } from "../../ui/Button";
import { DataTable } from "../../ui/DataTable";
import { Dialog } from "../../ui/Dialog";
import { Checkbox, focusFirstInvalid, SearchInput, SelectField, TextAreaField, TextField } from "../../ui/Field";
import { ActionMenu, Badge, PageHeader, StatCard, StatusBadge } from "../../ui/Layout";
import { EmptyState, ErrorState, FormError, TableSkeleton } from "../../ui/States";
import { useToast } from "../../ui/Toast";
import { StatusTabs, useLocations } from "./Inventory";
import { IngredientPicker } from "./pickers";

// Quality for factories: inspect received and produced lots against their plan (the server judges each value),
// hold and release lots, non-conformance reports, and a batch's trace from supplier to customer.

const num = (s: string) => Number(s.replace(/,/g, ""));
interface Characteristic { name: string; kind: "numeric" | "check"; min: number | null; max: number | null; unit: string | null }
const STAGE: Record<string, string> = { receipt: "فحص الاستلام", production: "فحص الإنتاج" };
const DECISION: Record<string, { label: string; tone: "success" | "warning" | "danger" }> = {
  accepted: { label: "مقبول", tone: "success" }, on_hold: { label: "محجوز", tone: "warning" }, rejected: { label: "مرفوض", tone: "danger" },
};
const range = (c: Characteristic) => c.kind === "check" ? "مطابق / غير مطابق"
  : `${c.min !== null ? `من ${quantity(c.min)}` : ""}${c.min !== null && c.max !== null ? " " : ""}${c.max !== null ? `إلى ${quantity(c.max)}` : ""}${c.unit ? ` ${c.unit}` : ""}`;
const Ref = ({ children }: { children: string }) => <bdi dir="ltr" className="num">{children}</bdi>;

// ── Inspections ─────────────────────────────────────────────────────────────────────────────────
interface Pending {
  batchId: string; batchNo: string; remaining: number; expiryDate: string | null; receivedAt: string; itemId: string; itemName: string; unit: string;
  locationName: string; planId: string; planName: string; stage: string; characteristics: Characteristic[]; source: string | null;
}
interface Held { batchId: string; batchNo: string; remaining: number; itemName: string; unit: string; locationName: string; heldAt: string; reason: string | null; fromLocationId: string | null }
interface Inspection { id: string; number: number; decision: string; results: { name: string; value: number | boolean | null; pass: boolean }[]; quantity: number; notes: string | null;
  inspectedAt: string; itemName: string; batchId: string | null; batchNo: string | null; planName: string; stage: string }

export function QualityPage() {
  const { tenantId, can, writable } = useTenant();
  const [tab, setTab] = useState("pending");
  const [inspecting, setInspecting] = useState<Pending | null>(null);
  const [releasing, setReleasing] = useState<Held | null>(null);
  const pending = useQuery({ queryKey: ["t", tenantId, "quality", "pending"], queryFn: () => api<{ items: Pending[] }>("GET", "/t/qc/pending", { tenant: tenantId }) });
  const log = useQuery({ queryKey: ["t", tenantId, "quality", "inspections"], queryFn: () => api<{ items: Inspection[]; held: Held[] }>("GET", "/t/qc/inspections", { tenant: tenantId }) });
  const canInspect = can("qc_inspections.create") && writable;
  const canRelease = can("qc_inspections.release") && writable;
  const traceTo = useTraceLink(tenantId);
  return (
    <div className="page">
      <PageHeader eyebrow="الجودة" title="فحوصات الجودة"
        description="كل تشغيلة مستلمة أو منتجة لصنف له خطة فحص تنتظر هنا. أدخل القياسات فيحكم الخادم على كل خاصية؛ المعلّق والمرفوض يُنقل إلى حجر الجودة ولا يُصرف ولا يُسلَّم حتى يُفرج عنه."
        actions={can("qc_plans.view") && <Link to={`/w/${tenantId}/manufacturing/qc-plans`} className="btn btn-secondary">خطط الفحص</Link>} />
      <div className="stats">
        <StatCard label="بانتظار الفحص" value={pending.data ? integer(pending.data.items.length) : "—"} icon={<ClipboardCheck />} hue={pending.data?.items.length ? "amber" : "green"} />
        <StatCard label="محجوز في الحجر" value={log.data ? integer(log.data.held.length) : "—"} icon={<ShieldAlert />} hue={log.data?.held.length ? "red" : "green"} />
      </div>
      <section className="panel" aria-label="الفحوصات">
        <div className="toolbar">
          <StatusTabs value={tab} onChange={setTab} options={[["pending", "بانتظار الفحص"], ["held", "المحجوز"], ["log", "سجل الفحوصات"]]} />
        </div>
        {tab === "pending" && (
          <DataTable caption="تشغيلات بانتظار الفحص" query={pending} rowKey={(r) => r.batchId}
            empty={{ title: "لا شيء بانتظار الفحص", body: "تظهر هنا التشغيلات المستلمة أو المنتجة للأصناف التي لها خطة فحص مفعّلة." }}
            columns={[
              { key: "itemName", header: "الصنف والتشغيلة", cell: (r) => <span className="stack-tight"><strong>{r.itemName}</strong><span className="muted acc-small"><Ref>{r.batchNo}</Ref></span></span> },
              { key: "stage", header: "المرحلة", cell: (r) => STAGE[r.stage] ?? r.stage },
              { key: "source", header: "المصدر", cell: (r) => text(r.source) },
              { key: "locationName", header: "الموقع", cell: (r) => r.locationName },
              { key: "remaining", header: "الكمية", numeric: true, cell: (r) => <>{quantity(r.remaining)} {r.unit}</> },
              { key: "receivedAt", header: "منذ", cell: (r) => day(r.receivedAt) },
            ]}
            actions={canInspect ? (r) => <Button size="sm" onClick={() => setInspecting(r)}>فحص</Button> : undefined} />
        )}
        {tab === "held" && (
          <DataTable caption="التشغيلات المحجوزة" query={{ ...log, data: log.data ? { items: log.data.held } : undefined }} rowKey={(r) => r.batchId}
            empty={{ title: "لا توجد تشغيلات محجوزة", body: "كل ما في المخزون مُفرج عنه." }}
            columns={[
              { key: "itemName", header: "الصنف والتشغيلة", cell: (r) => <span className="stack-tight"><strong>{r.itemName}</strong><span className="muted acc-small"><Ref>{r.batchNo}</Ref></span></span> },
              { key: "remaining", header: "الكمية", numeric: true, cell: (r) => <>{quantity(r.remaining)} {r.unit}</> },
              { key: "reason", header: "السبب", wrap: true, cell: (r) => text(r.reason) },
              { key: "heldAt", header: "حُجز في", cell: (r) => dayTime(r.heldAt) },
            ]}
            actions={(r) => {
              const items = [...(canRelease ? [{ label: "إفراج", onSelect: () => setReleasing(r) }] : []), ...(traceTo ? [{ label: "تتبع التشغيلة", onSelect: () => traceTo(r.batchId) }] : [])];
              return items.length ? <ActionMenu label={`إجراءات ${r.batchNo}`} items={items} /> : null;
            }} />
        )}
        {tab === "log" && (
          <DataTable caption="سجل الفحوصات" query={{ ...log, data: log.data ? { items: log.data.items } : undefined }} rowKey={(r) => r.id}
            empty={{ title: "لم يُسجَّل فحص بعد" }}
            columns={[
              { key: "number", header: "الفحص", cell: (r) => <Ref>{`QC-${r.number}`}</Ref> },
              { key: "itemName", header: "الصنف والتشغيلة", cell: (r) => <span className="stack-tight"><strong>{r.itemName}</strong><span className="muted acc-small">{r.batchNo ? <Ref>{r.batchNo}</Ref> : "—"}</span></span> },
              { key: "decision", header: "القرار", cell: (r) => <Badge tone={DECISION[r.decision]?.tone ?? "neutral"}>{DECISION[r.decision]?.label ?? r.decision}</Badge> },
              { key: "results", header: "خارج الحدود", wrap: true, sortKey: false, cell: (r) => {
                const bad = r.results.filter((x) => !x.pass);
                return bad.length ? bad.map((x) => `${x.name}: ${typeof x.value === "boolean" ? (x.value ? "مطابق" : "غير مطابق") : quantity(x.value)}`).join("، ") : "—";
              } },
              { key: "inspectedAt", header: "الوقت", cell: (r) => dayTime(r.inspectedAt) },
            ]}
            actions={(r) => r.batchId && traceTo ? <Button size="sm" variant="ghost" onClick={() => traceTo(r.batchId!)}>تتبع</Button> : null} />
        )}
      </section>
      {inspecting && <InspectDialog tenantId={tenantId} lot={inspecting} onClose={() => setInspecting(null)} />}
      {releasing && <ReleaseDialog tenantId={tenantId} lot={releasing} onClose={() => setReleasing(null)} />}
    </div>
  );
}

function InspectDialog({ tenantId, lot, onClose }: { tenantId: string; lot: Pending; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const form = useRef<HTMLFormElement>(null);
  const [key] = useIdempotencyKey();
  const [values, setValues] = useState<Record<string, string | boolean>>(() => Object.fromEntries(lot.characteristics.map((c) => [c.name, c.kind === "check" ? false : ""])));
  const [decision, setDecision] = useState<"auto" | "hold" | "reject">("auto");
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  // A preview only, so the inspector sees what is out before submitting; the server decides.
  const out = lot.characteristics.filter((c) => {
    const v = values[c.name];
    if (c.kind === "check") return v !== true;
    if (v === "" || !Number.isFinite(num(String(v)))) return false;
    const n = num(String(v));
    return (c.min !== null && n < c.min) || (c.max !== null && n > c.max);
  });
  async function submit() {
    const e: Record<string, string> = {};
    for (const c of lot.characteristics) if (c.kind === "numeric" && (values[c.name] === "" || !Number.isFinite(num(String(values[c.name]))))) e[c.name] = "أدخل القياس";
    setErrors(e);
    if (Object.keys(e).length) return focusFirstInvalid(form.current);
    setBusy(true); setError(null);
    try {
      const body = { batchId: lot.batchId, planId: lot.planId, notes: notes.trim() || null, decision: decision === "auto" ? undefined : decision,
        values: Object.fromEntries(lot.characteristics.map((c) => [c.name, c.kind === "check" ? values[c.name] === true : num(String(values[c.name]))])) };
      const r = await api<{ decision: string }>("POST", "/t/qc/inspections", { tenant: tenantId, idempotencyKey: key, body });
      const d = DECISION[r.decision]?.label ?? r.decision;
      toast.success(r.decision === "accepted" ? `قُبلت التشغيلة ${lot.batchNo}` : `${d}: نُقلت ${lot.batchNo} إلى حجر الجودة${r.decision === "rejected" ? " وفُتح تقرير عدم مطابقة" : ""}`);
      await invalidate("quality", "stock");
      onClose();
    } catch (err) { setError(err); } finally { setBusy(false); }
  }
  const verdict = decision === "reject" ? "رفض ونقل إلى الحجر" : decision === "hold" ? "حجز حتى قرار الجودة" : out.length ? "حجز (خصائص خارج الحدود)" : "قبول";
  return (
    <Dialog open wide onClose={onClose} busy={busy} formRef={form} onSubmit={() => void submit()} title={`فحص ${lot.itemName} · ${lot.batchNo}`}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ التسجيل…">تسجيل الفحص: {verdict}</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <p className="muted acc-small">{lot.planName} · {quantity(lot.remaining)} {lot.unit} في {lot.locationName}{lot.source ? ` · ${lot.source}` : ""}</p>
      <div className="form-grid">
        {lot.characteristics.map((c) => c.kind === "check"
          ? <Checkbox key={c.name} label={`${c.name}: مطابق`} checked={values[c.name] === true} onChange={(e) => setValues({ ...values, [c.name]: e.target.checked })} />
          : <TextField key={c.name} name={c.name} label={`${c.name}${c.unit ? ` (${c.unit})` : ""}`} required numeric inputMode="decimal" dir="ltr" hint={`الحد المقبول: ${range(c)}`}
              value={String(values[c.name] ?? "")} onChange={(e) => setValues({ ...values, [c.name]: e.target.value })}
              error={errors[c.name] ?? (out.includes(c) ? "خارج الحد المقبول" : undefined)} />)}
      </div>
      <fieldset className="stack-tight">
        <legend className="acc-small">القرار</legend>
        <div className="segmented" role="group" aria-label="القرار">
          {([["auto", out.length ? "حسب النتيجة (حجز)" : "حسب النتيجة (قبول)"], ["hold", "حجز"], ["reject", "رفض"]] as const).map(([v, l]) =>
            <button key={v} type="button" aria-pressed={decision === v} onClick={() => setDecision(v)}>{l}</button>)}
        </div>
        <p className="muted acc-small">الرفض يفتح تقرير عدم مطابقة تلقائياً. لا يُقبل ما فيه خاصية خارج الحد.</p>
      </fieldset>
      <TextAreaField label="ملاحظات" optional value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
      <FormError error={error} />
    </Dialog>
  );
}

function ReleaseDialog({ tenantId, lot, onClose }: { tenantId: string; lot: Held; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const locations = useLocations(tenantId);
  const [reason, setReason] = useState("");
  const [to, setTo] = useState(lot.fromLocationId ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    const e: Record<string, string> = {};
    if (reason.trim().length < 3) e.reason = "اذكر سبب الإفراج (إعادة القياس، قرار الاستخدام كما هو…)";
    if (!to) e.to = "اختر موقع الإفراج";
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true); setError(null);
    try {
      await api("POST", `/t/qc/batches/${lot.batchId}/release`, { tenant: tenantId, body: { reason: reason.trim(), toLocationId: to } });
      toast.success(`أُفرج عن ${lot.batchNo}: ${quantity(lot.remaining)} ${lot.unit} عادت إلى المخزون`);
      await invalidate("quality", "stock");
      onClose();
    } catch (err) { if (err instanceof ApiError) setErrors(err.fieldErrors); setError(err); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title={`الإفراج عن ${lot.itemName} · ${lot.batchNo}`}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الإفراج…">إفراج وإعادة إلى المخزون</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <p className="acc-small">تعود {quantity(lot.remaining)} {lot.unit} بنفس رقم التشغيلة وتكلفتها. القرار يُسجَّل باسمك في سجل التدقيق.</p>
      <SelectField label="تعود إلى" required placeholder="اختر الموقع" value={to} onChange={(e) => setTo(e.target.value)} error={errors.to ?? errors.toLocationId}
        options={(locations.data?.items ?? []).filter((l) => l.locationType !== "quarantine").map((l) => ({ value: l.id, label: l.name }))} />
      <TextAreaField label="سبب الإفراج" required value={reason} onChange={(e) => setReason(e.target.value)} error={errors.reason} maxLength={300} />
      <FormError error={error} />
    </Dialog>
  );
}

// ── Plans ───────────────────────────────────────────────────────────────────────────────────────
interface Plan { id: string; itemId: string; itemName: string; sku: string; stage: string; name: string; characteristics: Characteristic[]; isActive: boolean; inspections: number }

export function QcPlansPage() {
  const { tenantId, can, writable } = useTenant();
  const list = useQuery({ queryKey: ["t", tenantId, "quality", "plans"], queryFn: () => api<{ items: Plan[] }>("GET", "/t/qc/plans", { tenant: tenantId }) });
  const [editing, setEditing] = useState<Plan | "new" | null>(null);
  const canCreate = can("qc_plans.create") && writable;
  const canEdit = can("qc_plans.edit") && writable;
  return (
    <div className="page">
      <PageHeader eyebrow="الجودة" title="خطط الفحص"
        description="لكل صنف خطة للاستلام وأخرى للإنتاج: ما يُقاس وحدود قبوله. أي تشغيلة جديدة للصنف تظهر في قائمة الفحص تلقائياً."
        actions={canCreate && <Button variant="primary" icon={<Plus />} onClick={() => setEditing("new")}>إضافة خطة فحص</Button>} />
      <section className="panel" aria-label="خطط الفحص">
        <DataTable caption="خطط الفحص" query={list} rowKey={(r) => r.id} onRowClick={canEdit ? (r) => setEditing(r) : undefined}
          empty={{ title: "لا توجد خطط فحص بعد", body: "ابدأ بالخامات الحرجة: حدد ما يُقاس عند الاستلام (الرطوبة، الوزن، سلامة العبوة) وحدود القبول.",
            action: canCreate ? <Button variant="primary" icon={<Plus />} onClick={() => setEditing("new")}>إضافة خطة فحص</Button> : undefined }}
          columns={[
            { key: "itemName", header: "الصنف", cell: (r) => <span className="stack-tight"><strong>{r.itemName}</strong><span className="muted num acc-small">{r.sku}</span></span> },
            { key: "stage", header: "المرحلة", cell: (r) => STAGE[r.stage] ?? r.stage },
            { key: "name", header: "الخطة", cell: (r) => r.name },
            { key: "characteristics", header: "الخصائص", wrap: true, sortKey: false, cell: (r) => r.characteristics.map((c) => c.name).join("، ") },
            { key: "inspections", header: "فحوصات", numeric: true, cell: (r) => integer(r.inspections) },
            { key: "isActive", header: "الحالة", cell: (r) => <StatusBadge kind="active" value={r.isActive} /> },
          ]} />
      </section>
      {editing && <PlanDialog tenantId={tenantId} plan={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

type CharRow = { name: string; kind: "numeric" | "check"; min: string; max: string; unit: string };
function PlanDialog({ tenantId, plan, onClose }: { tenantId: string; plan: Plan | null; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const form = useRef<HTMLFormElement>(null);
  const [item, setItem] = useState<{ id: string; name: string } | null>(plan ? { id: plan.itemId, name: plan.itemName } : null);
  const [stage, setStage] = useState(plan?.stage ?? "receipt");
  const [name, setName] = useState(plan?.name ?? "");
  const [active, setActive] = useState(plan?.isActive ?? true);
  const [rows, setRows] = useState<CharRow[]>(plan?.characteristics.map((c) => ({ name: c.name, kind: c.kind, min: c.min === null ? "" : String(c.min), max: c.max === null ? "" : String(c.max), unit: c.unit ?? "" }))
    ?? [{ name: "", kind: "numeric", min: "", max: "", unit: "" }]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (i: number, p: Partial<CharRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  async function submit() {
    const e: Record<string, string> = {};
    if (!plan && !item) e.item = "اختر الصنف";
    if (name.trim().length < 2) e.name = "أدخل اسم الخطة";
    rows.forEach((r, i) => {
      if (!r.name.trim()) e[`c${i}`] = "أدخل اسم الخاصية";
      else if (r.kind === "numeric" && r.min === "" && r.max === "") e[`c${i}`] = "حدد الحد الأدنى أو الأعلى";
      else if (r.kind === "numeric" && r.min !== "" && r.max !== "" && num(r.min) > num(r.max)) e[`c${i}`] = "الحد الأدنى أكبر من الأعلى";
    });
    if (new Set(rows.map((r) => r.name.trim())).size !== rows.length) e.c0 = e.c0 ?? "اسم خاصية مكرر";
    setErrors(e);
    if (Object.keys(e).length) return focusFirstInvalid(form.current);
    setBusy(true); setError(null);
    const characteristics = rows.map((r) => ({ name: r.name.trim(), kind: r.kind, min: r.kind === "numeric" && r.min !== "" ? num(r.min) : null,
      max: r.kind === "numeric" && r.max !== "" ? num(r.max) : null, unit: r.unit.trim() || null }));
    try {
      if (plan) await api("PUT", `/t/qc/plans/${plan.id}`, { tenant: tenantId, body: { name: name.trim(), characteristics, isActive: active } });
      else await api("POST", "/t/qc/plans", { tenant: tenantId, body: { itemId: item!.id, stage, name: name.trim(), characteristics } });
      toast.success(plan ? `حُفظت «${name.trim()}»` : `أُضيفت خطة فحص «${item!.name}»`);
      await invalidate("quality");
      onClose();
    } catch (err) { if (err instanceof ApiError) setErrors(err.fieldErrors); setError(err); } finally { setBusy(false); }
  }
  return (
    <Dialog open wide onClose={onClose} busy={busy} formRef={form} onSubmit={() => void submit()} title={plan ? `تعديل «${plan.name}»` : "خطة فحص جديدة"}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">{plan ? "حفظ التعديلات" : "حفظ الخطة"}</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <div className="form-grid">
        {plan ? <p className="acc-small"><strong>{plan.itemName}</strong> · {STAGE[plan.stage]}</p> : <>
          {item ? <p className="acc-small">الصنف: <strong>{item.name}</strong> <Button size="sm" variant="ghost" onClick={() => setItem(null)}>تغيير</Button></p>
            : <IngredientPicker tenantId={tenantId} label="الصنف" required onPick={(i: Ingredient) => setItem({ id: i.id, name: i.name })} error={errors.item} />}
          <SelectField label="المرحلة" required value={stage} onChange={(e) => setStage(e.target.value)} options={[{ value: "receipt", label: "عند استلام المشتريات" }, { value: "production", label: "عند خروج الإنتاج" }]} />
        </>}
        <TextField label="اسم الخطة" required value={name} onChange={(e) => setName(e.target.value)} error={errors.name} placeholder="فحص استلام الدقيق" />
        {plan && <Checkbox label="مفعّلة" checked={active} onChange={(e) => setActive(e.target.checked)} />}
      </div>
      <fieldset className="qc-chars">
        <legend className="acc-small">الخصائص وحدود القبول</legend>
        {rows.map((r, i) => (
          <div key={i} className="qc-char-row">
            <TextField label="الخاصية" required name={`c${i}`} value={r.name} onChange={(e) => set(i, { name: e.target.value })} error={errors[`c${i}`]} />
            <SelectField label="النوع" value={r.kind} onChange={(e) => set(i, { kind: e.target.value as CharRow["kind"] })} options={[{ value: "numeric", label: "قياس" }, { value: "check", label: "مطابق/غير" }]} />
            <TextField label="من" numeric inputMode="decimal" dir="ltr" disabled={r.kind === "check"} value={r.min} onChange={(e) => set(i, { min: e.target.value })} />
            <TextField label="إلى" numeric inputMode="decimal" dir="ltr" disabled={r.kind === "check"} value={r.max} onChange={(e) => set(i, { max: e.target.value })} />
            <TextField label="الوحدة" optional disabled={r.kind === "check"} value={r.unit} onChange={(e) => set(i, { unit: e.target.value })} />
            <IconButton label={`حذف الخاصية ${r.name || i + 1}`} icon={<Trash2 />} disabled={rows.length === 1} onClick={() => setRows(rows.filter((_, j) => j !== i))} />
          </div>
        ))}
        <div><Button size="sm" icon={<Plus />} disabled={rows.length >= 40} onClick={() => setRows([...rows, { name: "", kind: "numeric", min: "", max: "", unit: "" }])}>إضافة خاصية</Button></div>
      </fieldset>
      <FormError error={error} />
    </Dialog>
  );
}

// ── Non-conformance ─────────────────────────────────────────────────────────────────────────────
interface Ncr { id: string; number: number; status: "open" | "closed"; description: string; disposition: string | null; rootCause: string | null; correctiveAction: string | null;
  quantity: number | null; createdAt: string; closedAt: string | null; itemName: string; unit: string; batchId: string | null; batchNo: string | null; supplierName: string | null; inspectionNumber: number | null }
const DISPOSITION: Record<string, string> = { rework: "إعادة تشغيل", scrap: "إتلاف", return_to_supplier: "إرجاع للمورد", use_as_is: "استخدام كما هو (تنازل)" };

export function NcrsPage() {
  const { tenantId, can, writable } = useTenant();
  const [status, setStatus] = useState("open");
  const list = useQuery({ queryKey: ["t", tenantId, "quality", "ncrs", status], queryFn: () => api<{ items: Ncr[] }>("GET", "/t/ncrs", { tenant: tenantId, query: status === "all" ? {} : { status } }) });
  const [creating, setCreating] = useState(false);
  const [closing, setClosing] = useState<Ncr | null>(null);
  const canCreate = can("ncrs.create") && writable;
  const canClose = can("ncrs.close") && writable;
  const traceTo = useTraceLink(tenantId);
  return (
    <div className="page">
      <PageHeader eyebrow="الجودة" title="تقارير عدم المطابقة"
        description="كل رفض في الفحص يفتح تقريراً تلقائياً، ويمكن فتحه يدوياً لشكوى عميل أو ملاحظة في الإنتاج. يُقفل التقرير بالقرار والسبب الجذري والإجراء التصحيحي."
        actions={canCreate && <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>فتح تقرير</Button>} />
      <section className="panel" aria-label="التقارير">
        <DataTable caption="تقارير عدم المطابقة" query={list} rowKey={(r) => r.id} filtered={status !== "all"} onClearFilters={() => setStatus("all")}
          toolbar={<StatusTabs value={status} onChange={setStatus} options={[["open", "مفتوحة"], ["closed", "مقفلة"], ["all", "الكل"]]} />}
          empty={{ title: "لا توجد تقارير", body: "لم يُسجَّل عدم مطابقة." }}
          columns={[
            { key: "number", header: "التقرير", cell: (r) => <Ref>{`NCR-${r.number}`}</Ref> },
            { key: "itemName", header: "الصنف", cell: (r) => <span className="stack-tight"><strong>{r.itemName}</strong><span className="muted acc-small">{r.batchNo ? <Ref>{r.batchNo}</Ref> : "بلا تشغيلة"}{r.supplierName ? ` · ${r.supplierName}` : ""}</span></span> },
            { key: "description", header: "المشكلة", wrap: true, cell: (r) => r.description },
            { key: "status", header: "الحالة", cell: (r) => r.status === "open" ? <Badge tone="warning">مفتوح</Badge> : <Badge tone="success">{DISPOSITION[r.disposition ?? ""] ?? "مقفل"}</Badge> },
            { key: "createdAt", header: "فُتح", cell: (r) => day(r.createdAt) },
          ]}
          actions={(r) => {
            const items = [...(r.status === "open" && canClose ? [{ label: "إقفال بالقرار", onSelect: () => setClosing(r) }] : []),
              ...(r.batchId && traceTo ? [{ label: "تتبع التشغيلة", onSelect: () => traceTo(r.batchId!) }] : [])];
            return items.length ? <ActionMenu label={`إجراءات NCR-${r.number}`} items={items} /> : null;
          }} />
      </section>
      {creating && <NcrDialog tenantId={tenantId} onClose={() => setCreating(false)} />}
      {closing && <CloseNcrDialog tenantId={tenantId} ncr={closing} onClose={() => setClosing(null)} />}
    </div>
  );
}

function NcrDialog({ tenantId, onClose }: { tenantId: string; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [item, setItem] = useState<{ id: string; name: string; unit: string } | null>(null);
  const [description, setDescription] = useState("");
  const [qty, setQty] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    const e: Record<string, string> = {};
    if (!item) e.item = "اختر الصنف";
    if (description.trim().length < 5) e.description = "صف المشكلة (5 أحرف على الأقل)";
    if (qty && !(num(qty) > 0)) e.quantity = "كمية أكبر من صفر";
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true); setError(null);
    try {
      await api("POST", "/t/ncrs", { tenant: tenantId, body: { itemId: item!.id, description: description.trim(), quantity: qty ? num(qty) : null } });
      toast.success(`فُتح تقرير عدم مطابقة لـ«${item!.name}»`);
      await invalidate("quality");
      onClose();
    } catch (err) { if (err instanceof ApiError) setErrors(err.fieldErrors); setError(err); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title="فتح تقرير عدم مطابقة"
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">فتح التقرير</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      {item ? <p className="acc-small">الصنف: <strong>{item.name}</strong> <Button size="sm" variant="ghost" onClick={() => setItem(null)}>تغيير</Button></p>
        : <IngredientPicker tenantId={tenantId} label="الصنف" required onPick={(i) => setItem({ id: i.id, name: i.name, unit: i.baseUnitName })} error={errors.item} />}
      <TextAreaField label="المشكلة" required value={description} onChange={(e) => setDescription(e.target.value)} error={errors.description} maxLength={1000} />
      <TextField label={`الكمية المتأثرة${item ? ` (${item.unit})` : ""}`} optional numeric inputMode="decimal" dir="ltr" value={qty} onChange={(e) => setQty(e.target.value)} error={errors.quantity} />
      <FormError error={error} />
    </Dialog>
  );
}

function CloseNcrDialog({ tenantId, ncr, onClose }: { tenantId: string; ncr: Ncr; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [v, setV] = useState({ disposition: "", rootCause: "", correctiveAction: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    const e: Record<string, string> = {};
    if (!v.disposition) e.disposition = "اختر القرار";
    if (v.rootCause.trim().length < 3) e.rootCause = "اذكر السبب الجذري";
    if (v.correctiveAction.trim().length < 3) e.correctiveAction = "اذكر الإجراء التصحيحي";
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true); setError(null);
    try {
      await api("POST", `/t/ncrs/${ncr.id}/close`, { tenant: tenantId, body: { disposition: v.disposition, rootCause: v.rootCause.trim(), correctiveAction: v.correctiveAction.trim() } });
      toast.success(`أُقفل NCR-${ncr.number}: ${DISPOSITION[v.disposition]}`);
      await invalidate("quality");
      onClose();
    } catch (err) { if (err instanceof ApiError) setErrors(err.fieldErrors); setError(err); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title={`إقفال NCR-${ncr.number}`}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الإقفال…">إقفال التقرير</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <p className="acc-small"><strong>{ncr.itemName}</strong>{ncr.batchNo ? <> · <Ref>{ncr.batchNo}</Ref></> : null}: {ncr.description}</p>
      <fieldset className="stack-tight">
        <legend className="acc-small">القرار</legend>
        {Object.entries(DISPOSITION).map(([value, label]) => (
          <label key={value} className="checkbox"><input type="radio" name="disposition" value={value} checked={v.disposition === value} onChange={() => setV({ ...v, disposition: value })} /> {label}</label>
        ))}
        {errors.disposition && <p className="field-error" role="alert">{errors.disposition}</p>}
        <p className="muted acc-small">القرار يُسجَّل فقط. نفّذ حركته من صفحته: الإتلاف من «التالف والإتلاف»، والإرجاع من «مرتجعات المشتريات»، والاستخدام بالإفراج من «فحوصات الجودة».</p>
      </fieldset>
      <TextAreaField label="السبب الجذري" required value={v.rootCause} onChange={(e) => setV({ ...v, rootCause: e.target.value })} error={errors.rootCause} maxLength={1000} />
      <TextAreaField label="الإجراء التصحيحي" required value={v.correctiveAction} onChange={(e) => setV({ ...v, correctiveAction: e.target.value })} error={errors.correctiveAction} maxLength={1000} />
      <FormError error={error} />
    </Dialog>
  );
}

/** Opens the trace page on a batch; null without the permission. */
function useTraceLink(tenantId: string) {
  const { can } = useTenant();
  const navigate = useNavigate();
  return can("trace.view") ? (batchId: string) => void navigate({ to: `/w/${tenantId}/manufacturing/trace`, search: { batch: batchId } as never }) : null;
}

// ── Trace ───────────────────────────────────────────────────────────────────────────────────────
interface Node { batchId: string; batchNo: string; itemName: string; unit: string; location: string; quantity: number; remaining: number; expiryDate: string | null; productionDate: string | null }
interface Back extends Node { origin: { kind: string; label: string; date?: string }; inputs: Back[] }
interface Fwd { kind: string; label: string; date?: string; quantity?: number; batch?: Node; next: Fwd[] }
interface Trace { batch: Node; backward: Back; forward: Fwd[]; inspections: { number: number; decision: string; inspectedAt: string; planName: string }[] }
interface Found { id: string; batchNo: string; itemName: string; locationName: string; quantity: number; remaining: number; expiryDate: string | null; sourceType: string; receivedAt: string }

export function TracePage() {
  const { tenantId } = useTenant();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string | null>(() => new URLSearchParams(window.location.search).get("batch"));
  const found = useQuery({ queryKey: ["t", tenantId, "quality", "trace-search", q], enabled: q.trim().length >= 2,
    queryFn: () => api<{ items: Found[] }>("GET", "/t/trace/search", { tenant: tenantId, query: { q: q.trim() } }) });
  const tr = useQuery({ queryKey: ["t", tenantId, "quality", "trace", picked], enabled: Boolean(picked),
    queryFn: () => api<Trace>("GET", `/t/trace/batches/${picked}`, { tenant: tenantId }) });
  return (
    <div className="page">
      <PageHeader eyebrow="الجودة" title="تتبع التشغيلات"
        description="من أين جاءت التشغيلة (المورد وسند الاستلام، أو أمر التشغيل ومدخلاته) وإلى أين ذهبت (أوامر تشغيل، نقل، عملاء). للاستدعاء: ابحث عن تشغيلة الخامة المعيبة لترى كل عميل استلم منها." />
      <section className="panel" aria-label="البحث">
        <div className="toolbar"><SearchInput label="رقم التشغيلة أو الصنف" value={q} onChange={setQ} placeholder="مثال: GRN-12 أو MO-7-1" /></div>
        {q.trim().length >= 2 && (found.isError ? <ErrorState error={found.error} onRetry={() => found.refetch()} /> : found.isPending ? <TableSkeleton columns={4} rows={3} /> : !found.data.items.length
          ? <EmptyState kind="filtered" title={`لا تشغيلة تطابق «${q.trim()}»`} action={<Button variant="ghost" onClick={() => setQ("")}>مسح البحث</Button>} />
          : <ul className="stack-tight" aria-label="نتائج البحث">{found.data.items.map((b) => (
              <li key={b.id}><Button variant={picked === b.id ? "secondary" : "ghost"} aria-pressed={picked === b.id} onClick={() => setPicked(b.id)}>
                <Ref>{b.batchNo}</Ref> · {b.itemName} · {b.locationName} · {quantity(b.remaining)} متبقٍ من {quantity(b.quantity)}
              </Button></li>))}</ul>)}
      </section>
      {!picked ? <section className="panel"><EmptyState title="اختر تشغيلة">ابحث برقم التشغيلة، أو افتح التتبع من الفحوصات أو تقارير عدم المطابقة.</EmptyState></section>
        : tr.isError ? <ErrorState error={tr.error} onRetry={() => tr.refetch()} /> : tr.isPending ? <TableSkeleton columns={3} rows={5} label="جارٍ التتبع…" /> : <>
        <section className="panel" aria-labelledby="tr-id">
          <h2 id="tr-id"><Ref>{tr.data.batch.batchNo}</Ref> · {tr.data.batch.itemName}</h2>
          <p className="muted acc-small">{tr.data.batch.location} · {quantity(tr.data.batch.remaining)} {tr.data.batch.unit} متبقٍ من {quantity(tr.data.batch.quantity)}
            {tr.data.batch.productionDate ? ` · إنتاج ${day(tr.data.batch.productionDate)}` : ""}{tr.data.batch.expiryDate ? ` · ينتهي ${day(tr.data.batch.expiryDate)}` : ""}</p>
          {tr.data.inspections.length > 0 && <p className="acc-small">الفحوصات: {tr.data.inspections.map((x) => <span key={x.number}><Ref>{`QC-${x.number}`}</Ref> <Badge tone={DECISION[x.decision]?.tone ?? "neutral"}>{DECISION[x.decision]?.label}</Badge> </span>)}</p>}
        </section>
        <section className="panel" aria-labelledby="tr-back">
          <div className="toolbar"><h2 id="tr-back"><GitBranch aria-hidden /> من أين جاءت</h2></div>
          <ul className="trace-tree root"><BackNode n={tr.data.backward} onPick={setPicked} /></ul>
        </section>
        <section className="panel" aria-labelledby="tr-fwd">
          <div className="toolbar"><h2 id="tr-fwd"><ShieldCheck aria-hidden /> إلى أين ذهبت</h2></div>
          {tr.data.forward.length ? <ul className="trace-tree root">{tr.data.forward.map((f, i) => <FwdNode key={i} f={f} onPick={setPicked} />)}</ul>
            : <EmptyState kind="done" title="لم يُستخدم منها شيء بعد">كل الكمية ما زالت في {tr.data.batch.location}.</EmptyState>}
        </section>
      </>}
    </div>
  );
}

function BackNode({ n, onPick }: { n: Back; onPick: (id: string) => void }) {
  return (
    <li className="trace-node">
      <span><Button size="sm" variant="ghost" onClick={() => onPick(n.batchId)}><Ref>{n.batchNo}</Ref></Button> {n.itemName} · {quantity(n.quantity)} {n.unit} · {n.location}</span>
      <span className="muted acc-small">{n.origin.label}{n.origin.date ? ` · ${day(n.origin.date)}` : ""}</span>
      {n.inputs.length > 0 && <ul className="trace-tree">{n.inputs.map((x) => <BackNode key={x.batchId} n={x} onPick={onPick} />)}</ul>}
    </li>
  );
}

function FwdNode({ f, onPick }: { f: Fwd; onPick: (id: string) => void }) {
  return (
    <li className="trace-node">
      <span>{f.kind === "customer" ? <strong>{f.label}</strong> : f.label}{f.quantity !== undefined ? ` · ${quantity(f.quantity)}` : ""}{f.date ? ` · ${day(f.date)}` : ""}</span>
      {f.batch && <span className="muted acc-small"><Button size="sm" variant="ghost" onClick={() => onPick(f.batch!.batchId)}><Ref>{f.batch.batchNo}</Ref></Button> {f.batch.itemName} · {f.batch.location}</span>}
      {f.next.length > 0 && <ul className="trace-tree">{f.next.map((x, i) => <FwdNode key={i} f={x} onPick={onPick} />)}</ul>}
    </li>
  );
}
