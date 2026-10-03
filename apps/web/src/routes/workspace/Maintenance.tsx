import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlarmClock, CalendarCheck, Plus, Timer, Trash2, Wrench } from "lucide-react";
import { useRef, useState } from "react";
import { api, ApiError, errorMessage } from "../../api/client";
import { useIdempotencyKey } from "../../app/session";
import { useInvalidate, useTenant } from "../../app/tenant";
import { day, dayTime, integer, money, percent, quantity, text } from "../../lib/format";
import { Button, IconButton } from "../../ui/Button";
import { DataTable } from "../../ui/DataTable";
import { ConfirmDialog, Dialog } from "../../ui/Dialog";
import { Checkbox, focusFirstInvalid, SelectField, TextAreaField, TextField } from "../../ui/Field";
import { ActionMenu, Badge, PageHeader, StatCard, StatusBadge } from "../../ui/Layout";
import { FormError, TableSkeleton } from "../../ui/States";
import { useToast } from "../../ui/Toast";
import { StatusTabs, useLocations } from "./Inventory";
import { IngredientPicker } from "./pickers";

// Maintenance for factories: machines, preventive plans (by calendar or meter), maintenance orders whose spare
// parts the server takes out of stock into maintenance expense, and reliability (MTBF, MTTR) from breakdowns.

const num = (s: string) => Number(s.replace(/,/g, ""));
const Ref = ({ children }: { children: string }) => <bdi dir="ltr" className="num">{children}</bdi>;
/** "2026-09-28T14:05" in the browser's clock, for datetime-local inputs. */
const localNow = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const hours = (m: number | null | undefined) => (m === null || m === undefined ? "—" : `${quantity(Math.round((m / 60) * 10) / 10)} س`);

interface Machine { id: string; code: string; name: string; workCenterId: string | null; workCenterName: string | null; serialNo: string | null; meterUnit: string | null;
  meterReading: number; isActive: boolean; plans: number; openOrders: number }
interface PartRow { itemId: string; name: string; unit: string; quantity: string }
function useMachines(tenantId: string) {
  return useQuery({ queryKey: ["t", tenantId, "maintenance", "machines"], queryFn: () => api<{ items: Machine[] }>("GET", "/t/machines", { tenant: tenantId }) });
}

/** Spare parts picked from the item list, each with a quantity in its base unit. */
function PartsEditor({ tenantId, rows, onChange, error }: { tenantId: string; rows: PartRow[]; onChange: (r: PartRow[]) => void; error?: string }) {
  return (
    <fieldset className="stack-tight">
      <legend className="acc-small">قطع الغيار</legend>
      {rows.map((p, i) => (
        <div key={p.itemId} className="row" style={{ gap: "var(--sp-2)", alignItems: "end" }}>
          <TextField label={`${p.name} (${p.unit})`} required numeric inputMode="decimal" dir="ltr" value={p.quantity} name={`part${i}`}
            onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />
          <IconButton label={`حذف ${p.name}`} icon={<Trash2 />} onClick={() => onChange(rows.filter((_, j) => j !== i))} />
        </div>
      ))}
      <IngredientPicker tenantId={tenantId} label="إضافة قطعة" types="spare_part,consumable" exclude={rows.map((r) => r.itemId)} placeholder="اكتب اسم القطعة"
        onPick={(i) => onChange([...rows, { itemId: i.id, name: i.name, unit: i.baseUnitName, quantity: "1" }])} error={error} />
    </fieldset>
  );
}
const partsBody = (rows: PartRow[]) => rows.map((p) => ({ itemId: p.itemId, quantity: num(p.quantity) }));
const partsInvalid = (rows: PartRow[]) => rows.find((p) => !(num(p.quantity) > 0));

// ── Orders and reliability ─────────────────────────────────────────────────────────────────────
interface Order { id: string; number: number; kind: "preventive" | "corrective"; status: "open" | "done" | "cancelled"; dueDate: string; plannedMinutes: number; description: string;
  failedAt: string | null; completedAt: string | null; downtimeMinutes: number | null; partsCost: number; machineId: string; machineCode: string; machineName: string; planName: string | null }
interface Kpis { from: string; to: string; periodDays: number; totals: { failures: number; downtimeMinutes: number; partsCost: number; preventiveCompliance: number | null };
  items: { machineId: string; code: string; name: string; failures: number; downtimeMinutes: number; mtbfHours: number; mttrHours: number; availability: number;
    preventiveDone: number; preventiveOnTime: number; partsCost: number; openOrders: number; overdueOrders: number }[] }

export function MaintenancePage() {
  const { tenantId, can, writable } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [tab, setTab] = useState("open");
  const orders = useQuery({ queryKey: ["t", tenantId, "maintenance", "orders", tab], enabled: tab !== "kpis",
    queryFn: () => api<{ today: string; items: Order[] }>("GET", "/t/maintenance/orders", { tenant: tenantId, query: { status: tab === "done" ? "done" : "open" } }) });
  const kpis = useQuery({ queryKey: ["t", tenantId, "maintenance", "kpis"], queryFn: () => api<Kpis>("GET", "/t/maintenance/kpis", { tenant: tenantId }) });
  const [breakdown, setBreakdown] = useState(false);
  const [completing, setCompleting] = useState<Order | null>(null);
  const [cancelling, setCancelling] = useState<Order | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const canCreate = can("maintenance.create") && writable;
  const k = kpis.data;
  const overdue = k?.items.reduce((a, x) => a + x.overdueOrders, 0) ?? 0;
  async function generate() {
    setGenerating(true);
    try {
      const r = await api<{ created: number }>("POST", "/t/maintenance/generate", { tenant: tenantId });
      toast.success(r.created ? `فُتح ${integer(r.created)} أمر صيانة وقائية مستحق` : "لا توجد صيانة مستحقة بلا أمر مفتوح");
      await invalidate("maintenance", "manufacturing");
    } catch (e) { toast.error(errorMessage(e)); } finally { setGenerating(false); }
  }
  async function cancel() {
    if (!cancelling) return;
    if (reason.trim().length < 3) return setErr("اذكر سبب الإلغاء");
    setBusy(true); setErr(null);
    try {
      await api("POST", `/t/maintenance/orders/${cancelling.id}/cancel`, { tenant: tenantId, body: { reason: reason.trim() } });
      toast.success(`أُلغي WO-${cancelling.number}`);
      setCancelling(null); setReason("");
      await invalidate("maintenance", "manufacturing");
    } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <div className="page">
      <PageHeader eyebrow="الصيانة" title="أوامر الصيانة"
        description="الصيانة الوقائية المستحقة من خطط الآلات، والأعطال وإصلاحها. قطع الغيار المصروفة تخرج من المخزون إلى مصروف الصيانة بقيد واحد، ووقت التوقف يحسب متوسط الوقت بين الأعطال ومتوسط الإصلاح."
        actions={<>
          {can("machines.view") && <Link to={`/w/${tenantId}/manufacturing/machines`} className="btn btn-ghost">{can("work_centers.view") ? "الآلات والخطط" : "المعدات والخطط"}</Link>}
          {canCreate && <Button loading={generating} loadingText="جارٍ الفحص…" icon={<CalendarCheck />} onClick={() => void generate()}>فتح أوامر المستحق</Button>}
          {canCreate && <Button variant="primary" icon={<AlarmClock />} onClick={() => setBreakdown(true)}>تسجيل عطل</Button>}
        </>} />
      <div className="stats">
        <StatCard label="أوامر متأخرة" value={k ? integer(overdue) : "—"} icon={<AlarmClock />} hue={overdue ? "red" : "green"} />
        <StatCard label={`أعطال آخر ${k ? integer(k.periodDays) : 90} يوماً`} value={k ? integer(k.totals.failures) : "—"} icon={<Wrench />} hue="amber" note={k ? `توقف ${hours(k.totals.downtimeMinutes)}` : undefined} />
        <StatCard label="الالتزام بالوقائية" value={k?.totals.preventiveCompliance === null || !k ? "—" : percent(k.totals.preventiveCompliance * 100)} icon={<CalendarCheck />} hue="sky" note="المنجز في موعده أو قبله" />
        <StatCard label="قطع الغيار المصروفة" value={k ? money(k.totals.partsCost) : "—"} icon={<Timer />} hue="violet" />
      </div>
      <section className="panel" aria-label="أوامر الصيانة">
        <div className="toolbar"><StatusTabs value={tab} onChange={setTab} options={[["open", "المفتوحة"], ["done", "المنجزة"], ["kpis", "الموثوقية"]]} /></div>
        {tab !== "kpis" ? (
          <DataTable caption={tab === "open" ? "أوامر الصيانة المفتوحة" : "أوامر الصيانة المنجزة"} query={orders} rowKey={(r) => r.id}
            empty={tab === "open" ? { title: "لا أوامر صيانة مفتوحة", body: "افتح أوامر الصيانة الوقائية المستحقة، أو سجّل عطلاً عند توقف آلة." } : { title: "لم يُنجز أمر صيانة بعد" }}
            columns={[
              { key: "number", header: "الأمر", cell: (r) => <Ref>{`WO-${r.number}`}</Ref> },
              { key: "machineName", header: can("work_centers.view") ? "الآلة" : "المعدة", cell: (r) => <span className="stack-tight"><strong>{r.machineName}</strong><span className="muted num acc-small">{r.machineCode}</span></span> },
              { key: "kind", header: "النوع", cell: (r) => r.kind === "corrective" ? <Badge tone="danger">إصلاح عطل</Badge> : <Badge tone="info">وقائية</Badge> },
              { key: "description", header: "العمل", wrap: true, cell: (r) => r.planName ?? r.description },
              ...(tab === "open" ? [
                { key: "dueDate", header: "الموعد", cell: (r: Order) => <>{day(r.dueDate)} {orders.data && r.dueDate < orders.data.today && <Badge tone="danger">متأخر</Badge>}</> },
                { key: "plannedMinutes", header: "المدة", numeric: true, cell: (r: Order) => hours(r.plannedMinutes) },
              ] : [
                { key: "completedAt", header: "أُنجز", cell: (r: Order) => dayTime(r.completedAt) },
                { key: "downtimeMinutes", header: "التوقف", numeric: true, cell: (r: Order) => hours(r.downtimeMinutes) },
                { key: "partsCost", header: "القطع", numeric: true, cell: (r: Order) => money(r.partsCost) },
              ]),
            ]}
            actions={tab === "open" && writable ? (r) => {
              const items = [...(can("maintenance.complete") ? [{ label: "إنجاز الأمر", onSelect: () => setCompleting(r) }] : []),
                ...(can("maintenance.cancel") ? [{ label: "إلغاء", onSelect: () => { setErr(null); setReason(""); setCancelling(r); }, danger: true, separated: true }] : [])];
              return items.length ? <ActionMenu label={`إجراءات WO-${r.number}`} items={items} /> : null;
            } : undefined} />
        ) : (
          <DataTable caption={`موثوقية الآلات من ${k ? day(k.from) : ""} إلى ${k ? day(k.to) : ""}`} query={{ ...kpis, data: k ? { items: k.items } : undefined }} rowKey={(r) => r.machineId}
            empty={can("work_centers.view") ? { title: "لا توجد آلات", body: "أضف آلاتك من «الآلات والخطط» لترى موثوقيتها." } : { title: "لا توجد معدات", body: "أضف معداتك من «المعدات والخطط» لترى موثوقيتها." }}
            columns={[
              { key: "name", header: can("work_centers.view") ? "الآلة" : "المعدة", cell: (r) => <span className="stack-tight"><strong>{r.name}</strong><span className="muted num acc-small">{r.code}</span></span> },
              { key: "failures", header: "الأعطال", numeric: true, cell: (r) => integer(r.failures) },
              { key: "downtimeMinutes", header: "التوقف", numeric: true, cell: (r) => hours(r.downtimeMinutes) },
              { key: "mtbfHours", header: "بين الأعطال (MTBF)", numeric: true, cell: (r) => <>{quantity(r.mtbfHours)} س{!r.failures && <span className="muted acc-small"> (بلا عطل)</span>}</> },
              { key: "mttrHours", header: "الإصلاح (MTTR)", numeric: true, cell: (r) => r.failures ? `${quantity(r.mttrHours)} س` : "—" },
              { key: "availability", header: "الجاهزية", numeric: true, cell: (r) => percent(r.availability * 100) },
              { key: "preventiveDone", header: "وقائية في موعدها", numeric: true, cell: (r) => r.preventiveDone ? `${integer(r.preventiveOnTime)} من ${integer(r.preventiveDone)}` : "—" },
              { key: "partsCost", header: "القطع", numeric: true, cell: (r) => money(r.partsCost) },
            ]} />
        )}
      </section>
      {breakdown && <BreakdownDialog tenantId={tenantId} onClose={() => setBreakdown(false)} />}
      {completing && <CompleteDialog tenantId={tenantId} order={completing} onClose={() => setCompleting(null)} />}
      <ConfirmDialog open={Boolean(cancelling)} onClose={() => setCancelling(null)} busy={busy} error={err} onConfirm={() => void cancel()}
        title={`إلغاء WO-${cancelling?.number ?? ""}؟`} confirmLabel="إلغاء الأمر"
        message={<>{cancelling?.machineName}: {cancelling?.planName ?? cancelling?.description}. لا تُصرف قطع ولا يُسجَّل توقف. الخطة تبقى مستحقة.</>}>
        <TextField label="سبب الإلغاء" required value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
      </ConfirmDialog>
    </div>
  );
}

function BreakdownDialog({ tenantId, onClose }: { tenantId: string; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const machines = useMachines(tenantId);
  const [key] = useIdempotencyKey();
  const [v, setV] = useState({ machineId: "", description: "", failedAt: localNow() });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    const e: Record<string, string> = {};
    if (!v.machineId) e.machineId = "اختر الآلة";
    if (v.description.trim().length < 3) e.description = "صف العطل";
    if (!v.failedAt || new Date(v.failedAt).getTime() > Date.now() + 60_000) e.failedAt = "وقت التوقف لا يكون في المستقبل";
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true); setError(null);
    try {
      await api("POST", "/t/maintenance/orders", { tenant: tenantId, idempotencyKey: key, body: { machineId: v.machineId, kind: "corrective", description: v.description.trim(),
        failedAt: new Date(v.failedAt).toISOString() } });
      toast.success("سُجّل العطل وفُتح أمر إصلاح. أنجزه عند عودة الآلة للعمل.");
      await invalidate("maintenance", "manufacturing");
      onClose();
    } catch (err) { if (err instanceof ApiError) setErrors(err.fieldErrors); setError(err); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title="تسجيل عطل"
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ التسجيل…">فتح أمر الإصلاح</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <SelectField label="الآلة" required placeholder="اختر الآلة" value={v.machineId} onChange={(e) => setV({ ...v, machineId: e.target.value })} error={errors.machineId}
        options={(machines.data?.items ?? []).filter((m) => m.isActive).map((m) => ({ value: m.id, label: `${m.name} (${m.code})` }))} />
      <TextField label="توقفت في" required type="datetime-local" dir="ltr" value={v.failedAt} onChange={(e) => setV({ ...v, failedAt: e.target.value })} error={errors.failedAt}
        hint="يُحسب التوقف من هذا الوقت حتى الإنجاز" />
      <TextAreaField label="العطل" required value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} error={errors.description} maxLength={1000} />
      <FormError error={error} />
    </Dialog>
  );
}

interface OrderDetail extends Order { meterUnit: string | null; meterReading: number; parts: { itemId: string; quantity: number }[]; items: { id: string; name: string; unit: string }[] }

function CompleteDialog({ tenantId, order, onClose }: { tenantId: string; order: Order; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const locations = useLocations(tenantId);
  const form = useRef<HTMLFormElement>(null);
  const [key] = useIdempotencyKey();
  const d = useQuery({ queryKey: ["t", tenantId, "maintenance", "order", order.id], queryFn: () => api<OrderDetail>("GET", `/t/maintenance/orders/${order.id}`, { tenant: tenantId }) });
  const [parts, setParts] = useState<PartRow[] | null>(null);
  const [v, setV] = useState({ completedAt: localNow(), downtime: "", meter: "", findings: "", locationId: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  // The plan's usual parts are the starting point; the technician edits what was really used.
  const rows = parts ?? (d.data ? d.data.parts.map((p) => { const i = d.data!.items.find((x) => x.id === p.itemId); return { itemId: p.itemId, name: i?.name ?? "", unit: i?.unit ?? "", quantity: String(p.quantity) }; }) : []);
  async function submit() {
    const e: Record<string, string> = {};
    const bad = partsInvalid(rows);
    if (bad) e[`part${rows.indexOf(bad)}`] = "كمية أكبر من صفر";
    if (rows.length && !v.locationId) e.locationId = "اختر المستودع الذي تُصرف منه القطع";
    if (v.downtime && !(num(v.downtime) >= 0)) e.downtime = "صفر أو أكبر";
    if (v.meter && d.data && num(v.meter) < d.data.meterReading) e.meter = `لا تقل عن القراءة الحالية ${quantity(d.data.meterReading)}`;
    if (new Date(v.completedAt).getTime() > Date.now() + 60_000) e.completedAt = "وقت الإنجاز لا يكون في المستقبل";
    setErrors(e);
    if (Object.keys(e).length) return focusFirstInvalid(form.current);
    setBusy(true); setError(null);
    try {
      await api("POST", `/t/maintenance/orders/${order.id}/complete`, { tenant: tenantId, idempotencyKey: key, body: {
        completedAt: new Date(v.completedAt).toISOString(), downtimeMinutes: v.downtime ? Math.round(num(v.downtime)) : null, meterAtService: v.meter ? num(v.meter) : null,
        findings: v.findings.trim() || null, locationId: v.locationId || null, parts: partsBody(rows) } });
      toast.success(`أُنجز WO-${order.number}${rows.length ? " وصُرفت القطع إلى مصروف الصيانة" : ""}`);
      await invalidate("maintenance", "manufacturing", "stock");
      onClose();
    } catch (err) { if (err instanceof ApiError) setErrors(err.fieldErrors); setError(err); } finally { setBusy(false); }
  }
  return (
    <Dialog open wide onClose={onClose} busy={busy} formRef={form} onSubmit={() => void submit()} title={`إنجاز WO-${order.number} · ${order.machineName}`}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الإنجاز…">إنجاز الأمر</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <p className="muted acc-small">{order.planName ?? order.description}{order.failedAt ? ` · توقفت ${dayTime(order.failedAt)}` : ""}</p>
      {d.isPending ? <TableSkeleton columns={2} rows={3} /> : <>
        <div className="form-grid">
          <TextField label="أُنجز في" required type="datetime-local" dir="ltr" value={v.completedAt} onChange={(e) => setV({ ...v, completedAt: e.target.value })} error={errors.completedAt} />
          <TextField label="التوقف بالدقائق" optional numeric inputMode="numeric" dir="ltr" value={v.downtime} onChange={(e) => setV({ ...v, downtime: e.target.value })} error={errors.downtime}
            hint={order.failedAt ? "فارغ = من وقت التوقف حتى الإنجاز" : `فارغ = المدة المخططة ${integer(order.plannedMinutes)} دقيقة`} />
          {d.data?.meterUnit && <TextField label={`العدّاد (${d.data.meterUnit})`} optional numeric inputMode="decimal" dir="ltr" value={v.meter} onChange={(e) => setV({ ...v, meter: e.target.value })}
            error={errors.meter} hint={`الحالية ${quantity(d.data.meterReading)}`} />}
        </div>
        <PartsEditor tenantId={tenantId} rows={rows} onChange={setParts} />
        {rows.length > 0 && <SelectField label="تُصرف القطع من" required placeholder="اختر المستودع" value={v.locationId} onChange={(e) => setV({ ...v, locationId: e.target.value })} error={errors.locationId}
          options={(locations.data?.items ?? []).filter((l) => l.locationType !== "quarantine").map((l) => ({ value: l.id, label: l.name }))} />}
        <TextAreaField label="ما وُجد وما عُمل" optional value={v.findings} onChange={(e) => setV({ ...v, findings: e.target.value })} maxLength={2000} />
      </>}
      <FormError error={error ?? (d.isError ? d.error : null)} />
    </Dialog>
  );
}

// ── Machines and plans ─────────────────────────────────────────────────────────────────────────
interface Plan { id: string; machineId: string; machineName: string; name: string; triggerKind: "days" | "meter"; intervalValue: number; plannedMinutes: number; tasks: string | null;
  parts: { itemId: string; quantity: number }[]; lastDoneOn: string | null; lastMeter: number | null; meter: number; meterUnit: string | null; isActive: boolean; openOrder: number | null;
  dueOn: string | null; dueMeter: number | null; daysLeft: number | null; state: "overdue" | "due" | "ok" }
interface PartItem { id: string; name: string; unit: string }
const STATE = { overdue: { label: "متأخرة", tone: "danger" }, due: { label: "مستحقة قريباً", tone: "warning" }, ok: { label: "في موعدها", tone: "success" } } as const;

export function MachinesPage() {
  const { tenantId, can, writable } = useTenant();
  const machines = useMachines(tenantId);
  const plans = useQuery({ queryKey: ["t", tenantId, "maintenance", "plans"], queryFn: () => api<{ today: string; items: Plan[]; partItems: PartItem[] }>("GET", "/t/maintenance/plans", { tenant: tenantId }) });
  const [editing, setEditing] = useState<Machine | "new" | null>(null);
  const [meterOf, setMeterOf] = useState<Machine | null>(null);
  const [plan, setPlan] = useState<Plan | "new" | null>(null);
  const canCreate = can("machines.create") && writable;
  const canEdit = can("machines.edit") && writable;
  // A contractor's machines are its equipment on sites; work centers belong to factories.
  const factoryFloor = can("work_centers.view");
  return (
    <div className="page">
      <PageHeader eyebrow="الصيانة" title={factoryFloor ? "الآلات وخطط الصيانة" : "المعدات وخطط الصيانة"}
        description={factoryFloor ? "الآلة مربوطة بمركز عمل: صيانتها تشغل وقته في جدولة الإنتاج، وقطع غيارها تُحمَّل على مركز تكلفته. خطة الصيانة الوقائية تُستحق بالأيام أو بقراءة العدّاد."
          : "المعدات وعدّاداتها، وخطط الصيانة الوقائية بالأيام أو بساعات التشغيل. تحميلها على المشاريع من «مواد المواقع والمعدات»."}
        actions={<>
          {canEdit && <Button icon={<Plus />} onClick={() => setPlan("new")} disabled={!machines.data?.items.length}>إضافة خطة</Button>}
          {canCreate && <Button variant="primary" icon={<Plus />} onClick={() => setEditing("new")}>{factoryFloor ? "إضافة آلة" : "إضافة معدة"}</Button>}
        </>} />
      <section className="panel" aria-label="الآلات">
        <DataTable caption="الآلات" query={machines} rowKey={(r) => r.id} onRowClick={canEdit ? (r) => setEditing(r) : undefined}
          empty={{ title: factoryFloor ? "لا توجد آلات بعد" : "لا توجد معدات بعد",
            body: factoryFloor ? "أضف الآلات والخطوط التي تحتاج صيانة، واربطها بمراكز العمل." : "أضف معداتك، ثم حدّد سعرها الداخلي للساعة من «مواد المواقع والمعدات» لتُحمَّل على المشاريع.",
            action: canCreate ? <Button variant="primary" icon={<Plus />} onClick={() => setEditing("new")}>{factoryFloor ? "إضافة آلة" : "إضافة معدة"}</Button> : undefined }}
          columns={[
            { key: "name", header: factoryFloor ? "الآلة" : "المعدة", cell: (r) => <span className="stack-tight"><strong>{r.name}</strong><span className="muted num acc-small">{r.code}{r.serialNo ? ` · ${r.serialNo}` : ""}</span></span> },
            ...(factoryFloor ? [{ key: "workCenterName", header: "مركز العمل", cell: (r: Machine) => text(r.workCenterName) }] : []),
            { key: "meterReading", header: "العدّاد", numeric: true, cell: (r) => r.meterUnit ? `${quantity(r.meterReading)} ${r.meterUnit}` : "—" },
            { key: "plans", header: "خطط", numeric: true, cell: (r) => integer(r.plans) },
            { key: "openOrders", header: "أوامر مفتوحة", numeric: true, cell: (r) => integer(r.openOrders) },
            { key: "isActive", header: "الحالة", cell: (r) => <StatusBadge kind="active" value={r.isActive} /> },
          ]}
          actions={canEdit ? (r) => <ActionMenu label={`إجراءات ${r.name}`} items={[{ label: "تعديل", onSelect: () => setEditing(r) },
            ...(r.meterUnit ? [{ label: "تحديث العدّاد", onSelect: () => setMeterOf(r) }] : [])]} /> : undefined} />
      </section>
      <section className="panel" aria-labelledby="mp-h">
        <div className="toolbar"><h2 id="mp-h">خطط الصيانة الوقائية</h2></div>
        <DataTable caption="خطط الصيانة الوقائية" query={plans} rowKey={(r) => r.id} onRowClick={canEdit ? (r) => setPlan(r) : undefined}
          empty={{ title: "لا توجد خطط بعد", body: "خطة لكل عمل دوري: تشحيم شهري، تغيير فلتر كل 500 ساعة تشغيل…",
            action: canEdit && machines.data?.items.length ? <Button icon={<Plus />} onClick={() => setPlan("new")}>إضافة خطة</Button> : undefined }}
          columns={[
            { key: "name", header: "الخطة", cell: (r) => <span className="stack-tight"><strong>{r.name}</strong><span className="muted acc-small">{r.machineName}</span></span> },
            { key: "intervalValue", header: "كل", cell: (r) => r.triggerKind === "days" ? `${integer(r.intervalValue)} يوم` : `${quantity(r.intervalValue)} ${r.meterUnit ?? ""}` },
            { key: "due", header: "الاستحقاق التالي", sortKey: false, cell: (r) => r.triggerKind === "days" ? day(r.dueOn) : `عند ${quantity(r.dueMeter)} (الآن ${quantity(r.meter)})` },
            { key: "state", header: "الحالة", cell: (r) => !r.isActive ? <StatusBadge kind="active" value={false} /> : r.openOrder ? <Badge tone="info">أمر مفتوح WO-{r.openOrder}</Badge>
              : <Badge tone={STATE[r.state].tone}>{STATE[r.state].label}</Badge> },
            { key: "lastDoneOn", header: "آخر تنفيذ", cell: (r) => day(r.lastDoneOn) },
          ]} />
      </section>
      {editing && <MachineDialog tenantId={tenantId} machine={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {meterOf && <MeterDialog tenantId={tenantId} machine={meterOf} onClose={() => setMeterOf(null)} />}
      {plan && <PlanDialog tenantId={tenantId} plan={plan === "new" ? null : plan} machines={machines.data?.items ?? []} partItems={plans.data?.partItems ?? []} onClose={() => setPlan(null)} />}
    </div>
  );
}

function MachineDialog({ tenantId, machine, onClose }: { tenantId: string; machine: Machine | null; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const form = useRef<HTMLFormElement>(null);
  const { can } = useTenant();
  const centers = useQuery({ enabled: can("work_centers.view"), queryKey: ["t", tenantId, "manufacturing", "work-centers"], queryFn: () => api<{ items: { id: string; name: string; isActive: boolean }[] }>("GET", "/t/work-centers", { tenant: tenantId }) });
  const [v, setV] = useState({ code: machine?.code ?? "", name: machine?.name ?? "", workCenterId: machine?.workCenterId ?? "", serialNo: machine?.serialNo ?? "",
    meterUnit: machine?.meterUnit ?? "", isActive: machine?.isActive ?? true });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    const e: Record<string, string> = {};
    if (!/^[A-Za-z0-9-]{1,20}$/.test(v.code.trim())) e.code = "حروف إنجليزية وأرقام وشرطة، مثل PACK-1";
    if (v.name.trim().length < 2) e.name = "أدخل اسم الآلة";
    setErrors(e);
    if (Object.keys(e).length) return focusFirstInvalid(form.current);
    setBusy(true); setError(null);
    const body = { code: v.code.trim(), name: v.name.trim(), workCenterId: v.workCenterId || null, serialNo: v.serialNo.trim() || null, meterUnit: v.meterUnit.trim() || null, isActive: v.isActive };
    try {
      if (machine) await api("PUT", `/t/machines/${machine.id}`, { tenant: tenantId, body });
      else await api("POST", "/t/machines", { tenant: tenantId, body });
      toast.success(machine ? `حُفظت «${body.name}»` : `أُضيفت «${body.name}»`);
      await invalidate("maintenance");
      onClose();
    } catch (err) { if (err instanceof ApiError) setErrors(err.fieldErrors); setError(err); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} formRef={form} onSubmit={() => void submit()} title={machine ? `تعديل «${machine.name}»` : can("work_centers.view") ? "إضافة آلة" : "إضافة معدة"}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">{machine ? "حفظ التعديلات" : "حفظ الآلة"}</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <div className="form-grid">
        <TextField label="الرمز" required dir="ltr" value={v.code} onChange={(e) => setV({ ...v, code: e.target.value.toUpperCase() })} error={errors.code} />
        <TextField label="الاسم" required value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} error={errors.name} />
        {can("work_centers.view") && <SelectField label="مركز العمل" optional placeholder="بدون مركز عمل" value={v.workCenterId} onChange={(e) => setV({ ...v, workCenterId: e.target.value })}
          options={(centers.data?.items ?? []).filter((c) => c.isActive || c.id === v.workCenterId).map((c) => ({ value: c.id, label: c.name }))}
          hint="صيانتها تحجز وقته في جدولة الإنتاج" />}
        <TextField label="الرقم التسلسلي" optional dir="ltr" value={v.serialNo} onChange={(e) => setV({ ...v, serialNo: e.target.value })} />
        <TextField label="وحدة العدّاد" optional value={v.meterUnit} onChange={(e) => setV({ ...v, meterUnit: e.target.value })} placeholder="ساعة تشغيل، دورة…" hint="لازمة لخطط الصيانة بالعدّاد" />
        {machine && <Checkbox label="نشطة" checked={v.isActive} onChange={(e) => setV({ ...v, isActive: e.target.checked })} />}
      </div>
      <FormError error={error} />
    </Dialog>
  );
}

function MeterDialog({ tenantId, machine, onClose }: { tenantId: string; machine: Machine; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [reading, setReading] = useState(String(machine.meterReading));
  const [fieldErr, setFieldErr] = useState<string | undefined>();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!(num(reading) >= machine.meterReading)) return setFieldErr(`لا تقل عن القراءة الحالية ${quantity(machine.meterReading)}`);
    setFieldErr(undefined); setBusy(true); setError(null);
    try {
      await api("POST", `/t/machines/${machine.id}/meter`, { tenant: tenantId, body: { reading: num(reading) } });
      toast.success(`عدّاد «${machine.name}»: ${quantity(num(reading))} ${machine.meterUnit ?? ""}`);
      await invalidate("maintenance");
      onClose();
    } catch (err) { setError(err); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title={`تحديث عدّاد «${machine.name}»`}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">حفظ القراءة</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <TextField label={`القراءة (${machine.meterUnit})`} required numeric inputMode="decimal" dir="ltr" value={reading} onChange={(e) => setReading(e.target.value)} error={fieldErr}
        hint="العدّاد يتقدم فقط؛ الخطط بالعدّاد تُستحق عند بلوغ فترتها" />
      <FormError error={error} />
    </Dialog>
  );
}

function PlanDialog({ tenantId, plan, machines, partItems, onClose }: { tenantId: string; plan: Plan | null; machines: Machine[]; partItems: PartItem[]; onClose: () => void }) {
  const { can } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const form = useRef<HTMLFormElement>(null);
  const [v, setV] = useState({ machineId: plan?.machineId ?? "", name: plan?.name ?? "", triggerKind: plan?.triggerKind ?? "days" as "days" | "meter",
    intervalValue: plan ? String(plan.intervalValue) : "30", plannedMinutes: String(plan?.plannedMinutes ?? 60), tasks: plan?.tasks ?? "", lastDoneOn: "", isActive: plan?.isActive ?? true });
  const [parts, setParts] = useState<PartRow[] | null>(plan ? null : []);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const rows = parts ?? (plan?.parts ?? []).map((p) => { const i = partItems.find((x) => x.id === p.itemId); return { itemId: p.itemId, name: i?.name ?? "", unit: i?.unit ?? "", quantity: String(p.quantity) }; });
  const machine = machines.find((m) => m.id === v.machineId);
  async function submit() {
    const e: Record<string, string> = {};
    if (!plan && !v.machineId) e.machineId = "اختر الآلة";
    if (v.name.trim().length < 2) e.name = "أدخل اسم الخطة";
    if (!(num(v.intervalValue) > 0)) e.intervalValue = "فترة أكبر من صفر";
    if (!(num(v.plannedMinutes) >= 1)) e.plannedMinutes = "دقيقة واحدة على الأقل";
    if (!plan && v.triggerKind === "meter" && !machine?.meterUnit) e.triggerKind = "حدد وحدة عدّاد الآلة أولاً من «تعديل»";
    const bad = partsInvalid(rows);
    if (bad) e[`part${rows.indexOf(bad)}`] = "كمية أكبر من صفر";
    setErrors(e);
    if (Object.keys(e).length) return focusFirstInvalid(form.current);
    setBusy(true); setError(null);
    const common = { name: v.name.trim(), intervalValue: num(v.intervalValue), plannedMinutes: Math.round(num(v.plannedMinutes)), tasks: v.tasks.trim() || null, parts: partsBody(rows) };
    try {
      if (plan) await api("PUT", `/t/maintenance/plans/${plan.id}`, { tenant: tenantId, body: { ...common, isActive: v.isActive } });
      else await api("POST", "/t/maintenance/plans", { tenant: tenantId, body: { ...common, machineId: v.machineId, triggerKind: v.triggerKind, lastDoneOn: v.lastDoneOn || null } });
      toast.success(plan ? `حُفظت «${common.name}»` : `أُضيفت خطة «${common.name}»`);
      await invalidate("maintenance");
      onClose();
    } catch (err) { if (err instanceof ApiError) setErrors(err.fieldErrors); setError(err); } finally { setBusy(false); }
  }
  return (
    <Dialog open wide onClose={onClose} busy={busy} formRef={form} onSubmit={() => void submit()} title={plan ? `تعديل «${plan.name}»` : "خطة صيانة وقائية"}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">{plan ? "حفظ التعديلات" : "حفظ الخطة"}</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <div className="form-grid">
        {plan ? <p className="acc-small">الآلة: <strong>{plan.machineName}</strong></p>
          : <SelectField label="الآلة" required placeholder="اختر الآلة" value={v.machineId} onChange={(e) => setV({ ...v, machineId: e.target.value })} error={errors.machineId}
              options={machines.filter((m) => m.isActive).map((m) => ({ value: m.id, label: `${m.name} (${m.code})` }))} />}
        <TextField label="اسم الخطة" required value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} error={errors.name} placeholder="تشحيم شهري" />
        {!plan && (
          <fieldset className="stack-tight">
            <legend className="acc-small">تُستحق كل</legend>
            <div className="segmented" role="group" aria-label="نوع الاستحقاق">
              <button type="button" aria-pressed={v.triggerKind === "days"} onClick={() => setV({ ...v, triggerKind: "days" })}>عدد أيام</button>
              <button type="button" aria-pressed={v.triggerKind === "meter"} onClick={() => setV({ ...v, triggerKind: "meter" })}>قراءة عدّاد</button>
            </div>
            {errors.triggerKind && <span className="field-error" role="alert">{errors.triggerKind}</span>}
          </fieldset>
        )}
        <TextField label={v.triggerKind === "days" ? "الفترة بالأيام" : `الفترة (${machine?.meterUnit ?? plan?.meterUnit ?? "وحدة العدّاد"})`} required numeric inputMode="decimal" dir="ltr"
          value={v.intervalValue} onChange={(e) => setV({ ...v, intervalValue: e.target.value })} error={errors.intervalValue} />
        <TextField label="مدة التنفيذ بالدقائق" required numeric inputMode="numeric" dir="ltr" value={v.plannedMinutes} onChange={(e) => setV({ ...v, plannedMinutes: e.target.value })}
          error={errors.plannedMinutes} hint={can("work_centers.view") ? "تحجز وقت مركز العمل في الجدولة" : "مدة الصيانة المتوقعة"} />
        {!plan && v.triggerKind === "days" && <TextField label="آخر تنفيذ" optional type="date" dir="ltr" value={v.lastDoneOn} onChange={(e) => setV({ ...v, lastDoneOn: e.target.value })}
          hint="فارغ = مستحقة من اليوم" />}
        {plan && <Checkbox label="مفعّلة" checked={v.isActive} onChange={(e) => setV({ ...v, isActive: e.target.checked })} />}
      </div>
      <TextAreaField label="خطوات العمل" optional value={v.tasks} onChange={(e) => setV({ ...v, tasks: e.target.value })} maxLength={2000} />
      <PartsEditor tenantId={tenantId} rows={rows} onChange={setParts} />
      <FormError error={error} />
    </Dialog>
  );
}
