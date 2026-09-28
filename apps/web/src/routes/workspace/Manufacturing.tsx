import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowRight, CircleCheck, ClipboardList, Copy, Factory, Gauge, Hammer, PackageCheck, Plus, Timer, Trash2, Undo2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, errorMessage, type Page } from "../../api/client";
import type { Ingredient } from "../../api/types";
import { useIdempotencyKey } from "../../app/session";
import { useInvalidate, useTenant } from "../../app/tenant";
import { cost, day, dayTime, integer, isoDay, money, percent, quantity, text } from "../../lib/format";
import { Button, IconButton } from "../../ui/Button";
import { DataTable } from "../../ui/DataTable";
import { ConfirmDialog, Dialog } from "../../ui/Dialog";
import { Checkbox, focusFirstInvalid, SearchInput, SelectField, TextAreaField, TextField } from "../../ui/Field";
import { ActionMenu, Badge, PageHeader, StatCard, StatusBadge } from "../../ui/Layout";
import { EmptyState, ErrorState, FormError, TableSkeleton } from "../../ui/States";
import { useToast } from "../../ui/Toast";
import { useCostCenters } from "./Accounting";
import { StatusTabs, useLocations } from "./Inventory";
import { IngredientPicker } from "./pickers";

// Production for factory workspaces: work centers → bills of materials (versioned, costed on the server) →
// manufacturing orders (confirm, issue, time, output, close). Every figure shown comes from the API.

const num = (s: string) => Number(s.replace(/,/g, ""));
type Tone = "neutral" | "info" | "success" | "warning" | "danger";

// ── Work centers ────────────────────────────────────────────────────────────────────────────────
interface WorkCenter {
  id: string; code: string; name: string; locationId: string | null; locationName: string | null; costCenterId: string | null; costCenterName: string | null;
  hoursPerDay: number; laborRate: number; overheadRate: number; isActive: boolean; activeBoms: number;
}
function useWorkCenters(tenantId: string) {
  return useQuery({ queryKey: ["t", tenantId, "manufacturing", "work-centers"], queryFn: () => api<{ items: WorkCenter[] }>("GET", "/t/work-centers", { tenant: tenantId }) });
}

export function WorkCentersPage() {
  const { tenantId, can, writable } = useTenant();
  const list = useWorkCenters(tenantId);
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [editing, setEditing] = useState<WorkCenter | "new" | null>(null);
  const canCreate = can("work_centers.create") && writable;
  const canEdit = can("work_centers.edit") && writable;
  async function toggle(w: WorkCenter) {
    try {
      await api("PATCH", `/t/work-centers/${w.id}`, { tenant: tenantId, body: { isActive: !w.isActive } });
      toast.success(w.isActive ? `أُوقف «${w.name}»` : `فُعّل «${w.name}»`);
      await invalidate("manufacturing");
    } catch (e) { toast.error(errorMessage(e)); }
  }
  return (
    <div className="page">
      <PageHeader eyebrow="التصنيع" title="مراكز العمل"
        description="الآلة أو الخط أو القسم الذي تتم فيه العمليات. سعر ساعة العمالة والأعباء الصناعية هنا هو ما يُحمَّل على المنتج في التكلفة المعيارية وفي أوامر التشغيل."
        actions={canCreate && <Button variant="primary" icon={<Plus />} onClick={() => setEditing("new")}>إضافة مركز عمل</Button>} />
      <section className="panel" aria-label="مراكز العمل">
        <DataTable caption="مراكز العمل" query={list} rowKey={(r) => r.id} onRowClick={canEdit ? (r) => setEditing(r) : undefined}
          empty={{ title: "لا توجد مراكز عمل بعد", body: "أضف أفرانك وخطوطك وأقسام التشغيل بأسعار ساعتها، ثم استخدمها في عمليات قوائم المواد.",
            action: canCreate ? <Button variant="primary" icon={<Plus />} onClick={() => setEditing("new")}>إضافة مركز عمل</Button> : undefined }}
          columns={[
            { key: "name", header: "مركز العمل", cell: (r) => <span className="stack-tight"><strong>{r.name}</strong><span className="muted num acc-small">{r.code}</span></span> },
            { key: "locationName", header: "الموقع", cell: (r) => text(r.locationName) },
            { key: "hoursPerDay", header: "ساعات اليوم", numeric: true, cell: (r) => quantity(r.hoursPerDay) },
            { key: "laborRate", header: "العمالة / ساعة", numeric: true, cell: (r) => money(r.laborRate) },
            { key: "overheadRate", header: "الأعباء / ساعة", numeric: true, cell: (r) => money(r.overheadRate) },
            { key: "costCenterName", header: "مركز التكلفة", cell: (r) => text(r.costCenterName) },
            { key: "activeBoms", header: "قوائم معتمدة", numeric: true, cell: (r) => integer(r.activeBoms) },
            { key: "isActive", header: "الحالة", cell: (r) => <StatusBadge kind="active" value={r.isActive} /> },
          ]}
          actions={canEdit ? (r) => <ActionMenu label={`إجراءات ${r.name}`} items={[{ label: "تعديل", onSelect: () => setEditing(r) }, { label: r.isActive ? "إيقاف" : "تفعيل", onSelect: () => void toggle(r) }]} /> : undefined} />
      </section>
      {editing && <WorkCenterDialog tenantId={tenantId} wc={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function WorkCenterDialog({ tenantId, wc, onClose }: { tenantId: string; wc: WorkCenter | null; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const locations = useLocations(tenantId);
  const centers = useCostCenters(tenantId);
  const form = useRef<HTMLFormElement>(null);
  const [v, setV] = useState({
    code: wc?.code ?? "", name: wc?.name ?? "", locationId: wc?.locationId ?? "", costCenterId: wc?.costCenterId ?? "",
    hoursPerDay: String(wc?.hoursPerDay ?? 8), laborRate: String(wc?.laborRate ?? 0), overheadRate: String(wc?.overheadRate ?? 0),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    const e: Record<string, string> = {};
    if (!wc && !/^[A-Za-z0-9-]{1,20}$/.test(v.code.trim())) e.code = "حروف إنجليزية وأرقام وشرطة، مثل OVEN-1";
    if (v.name.trim().length < 2) e.name = "أدخل اسم مركز العمل";
    if (!(num(v.hoursPerDay) > 0 && num(v.hoursPerDay) <= 24)) e.hoursPerDay = "من 1 إلى 24 ساعة";
    if (!(num(v.laborRate) >= 0)) e.laborRate = "صفر أو أكبر";
    if (!(num(v.overheadRate) >= 0)) e.overheadRate = "صفر أو أكبر";
    setErrors(e);
    if (Object.keys(e).length) return focusFirstInvalid(form.current);
    setBusy(true); setError(null);
    const body = { name: v.name.trim(), locationId: v.locationId || null, costCenterId: v.costCenterId || null,
      hoursPerDay: num(v.hoursPerDay), laborRate: num(v.laborRate), overheadRate: num(v.overheadRate) };
    try {
      if (wc) await api("PATCH", `/t/work-centers/${wc.id}`, { tenant: tenantId, body });
      else await api("POST", "/t/work-centers", { tenant: tenantId, body: { ...body, code: v.code.trim() } });
      toast.success(wc ? `حُفظ «${body.name}»` : `أُضيف «${body.name}»`);
      await invalidate("manufacturing");
      onClose();
    } catch (err) { if (err instanceof ApiError) setErrors(err.fieldErrors); setError(err); } finally { setBusy(false); }
  }
  return (
    <Dialog open wide onClose={onClose} busy={busy} formRef={form} onSubmit={() => void submit()} title={wc ? `تعديل «${wc.name}»` : "إضافة مركز عمل"}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">{wc ? "حفظ التعديلات" : "حفظ مركز العمل"}</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <div className="form-grid">
        <TextField label="الرمز" required dir="ltr" disabled={Boolean(wc)} value={v.code} onChange={(e) => setV({ ...v, code: e.target.value.toUpperCase() })} error={errors.code} />
        <TextField label="الاسم" required value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} error={errors.name} />
        <SelectField label="الموقع" optional placeholder="بدون موقع" value={v.locationId} onChange={(e) => setV({ ...v, locationId: e.target.value })}
          options={(locations.data?.items ?? []).map((l) => ({ value: l.id, label: l.name }))} />
        <SelectField label="مركز التكلفة" optional placeholder="بدون" value={v.costCenterId} onChange={(e) => setV({ ...v, costCenterId: e.target.value })}
          options={(centers.data?.items ?? []).filter((c) => c.isActive).map((c) => ({ value: c.id, label: `${c.code} · ${c.name}` }))} />
      </div>
      <div className="form-grid">
        <TextField label="ساعات التشغيل في اليوم" required numeric value={v.hoursPerDay} onChange={(e) => setV({ ...v, hoursPerDay: e.target.value })} error={errors.hoursPerDay} />
        <TextField label="تكلفة ساعة العمالة المباشرة" required numeric value={v.laborRate} onChange={(e) => setV({ ...v, laborRate: e.target.value })} error={errors.laborRate}
          hint="أجور من يعملون على المركز في الساعة." />
        <TextField label="الأعباء الصناعية للساعة" required numeric value={v.overheadRate} onChange={(e) => setV({ ...v, overheadRate: e.target.value })} error={errors.overheadRate}
          hint="كهرباء، إهلاك الآلة، إشراف… لكل ساعة تشغيل." />
      </div>
      {wc && <p className="muted acc-small">الأسعار الجديدة تُطبَّق على التكاليف المعيارية وأوامر التشغيل التي تُؤكَّد بعد الحفظ. الأوامر المؤكدة تحتفظ بأسعارها.</p>}
      <FormError error={error} />
    </Dialog>
  );
}

// ── Bills of materials ──────────────────────────────────────────────────────────────────────────
const BOM_STATUS: Record<string, [string, Tone]> = { draft: ["مسودة", "warning"], active: ["معتمدة", "success"], archived: ["مؤرشفة", "neutral"] };
interface BomRow { id: string; version: number; status: string; quantity: number; itemId: string; itemName: string; itemSku: string; unit: string; componentsCount: number; operationsCount: number; activatedAt: string | null }

export function BomsPage() {
  const { tenantId, can } = useTenant();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  useEffect(() => { const t = setTimeout(() => { setDebounced(q.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);
  const list = useQuery({ queryKey: ["t", tenantId, "manufacturing", "boms", { debounced, status, page }], placeholderData: keepPreviousData,
    queryFn: () => api<Page<BomRow>>("GET", "/t/boms", { tenant: tenantId, query: { q: debounced, status, page, pageSize: 25 } }) });
  const canCreate = can("boms.create");
  const open = (id: string) => navigate({ to: `/w/${tenantId}/manufacturing/boms/${id}` });
  return (
    <div className="page">
      <PageHeader eyebrow="التصنيع" title="قوائم المواد"
        description="مكونات كل منتج وعملياته، بإصدارات. الإصدار المعتمد هو ما تستخدمه أوامر التشغيل، وتكلفته المعيارية تُحسب في الخادم من متوسط تكلفة المكونات وأسعار مراكز العمل."
        actions={canCreate && <Link to={`/w/${tenantId}/manufacturing/boms/new`} className="btn btn-primary"><Plus aria-hidden="true" />قائمة مواد جديدة</Link>} />
      <section className="panel" aria-label="قوائم المواد">
        <DataTable caption="قوائم المواد" query={list} rowKey={(r) => r.id} onRowClick={(r) => open(r.id)} onPageChange={setPage}
          filtered={Boolean(debounced || status)} onClearFilters={() => { setQ(""); setStatus(""); }}
          toolbar={<><SearchInput placeholder="ابحث باسم المنتج أو رمزه" value={q} onChange={setQ} />
            <StatusTabs value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={[["", "الكل"], ["active", "المعتمدة"], ["draft", "المسودات"], ["archived", "المؤرشفة"]]} /></>}
          empty={{ title: "لا توجد قوائم مواد بعد", body: "ابدأ بالمنتج الذي تصنعه أكثر: مكوناته بكمياتها، وعملياته على مراكز العمل.",
            action: canCreate ? <Link to={`/w/${tenantId}/manufacturing/boms/new`} className="btn btn-primary"><Plus aria-hidden="true" />قائمة مواد جديدة</Link> : undefined }}
          columns={[
            { key: "itemName", sortKey: false, header: "المنتج", cell: (r) => <span className="stack-tight"><strong>{r.itemName}</strong><span className="muted num acc-small">{r.itemSku}</span></span> },
            { key: "version", sortKey: false, header: "الإصدار", numeric: true, cell: (r) => <span className="num">v{r.version}</span> },
            { key: "status", sortKey: false, header: "الحالة", cell: (r) => <Badge tone={BOM_STATUS[r.status]![1]}>{BOM_STATUS[r.status]![0]}</Badge> },
            { key: "quantity", sortKey: false, header: "كمية الدفعة", numeric: true, cell: (r) => <>{quantity(r.quantity)} {r.unit}</> },
            { key: "componentsCount", sortKey: false, header: "المكونات", numeric: true, cell: (r) => integer(r.componentsCount) },
            { key: "operationsCount", sortKey: false, header: "العمليات", numeric: true, cell: (r) => integer(r.operationsCount) },
            { key: "activatedAt", sortKey: false, header: "اعتُمدت", cell: (r) => (r.activatedAt ? day(r.activatedAt) : "—") },
          ]} />
      </section>
    </div>
  );
}

interface BomDetail {
  id: string; version: number; status: string; quantity: number; notes: string | null; itemId: string; itemName: string; itemSku: string; itemType: string; unit: string;
  versions: { id: string; version: number; status: string }[];
  lines: { componentId: string; quantity: number; scrapPercent: number; phantom: boolean; name: string; sku: string; unit: string; itemType: string; hasBom: boolean; unitCost: number | null; cost: number | null }[];
  operations: { seq: number; name: string; workCenterId: string; workCenterName: string; setupMinutes: number; runMinutes: number; labor: number | null; overhead: number | null }[];
  byproducts: { itemId: string; quantity: number; costShare: number; name: string; unit: string; value: number | null }[];
  cost: { material: number; labor: number; overhead: number; total: number; mainCost: number; unitCost: number } | null;
  costError: string | null;
}
interface DLine { key: string; componentId: string; name: string; unit: string; quantity: string; scrap: string; phantom: boolean; hasBom: boolean }
interface DOp { key: string; name: string; workCenterId: string; setup: string; run: string }
interface DBy { key: string; itemId: string; name: string; unit: string; quantity: string; share: string }
const k = () => crypto.randomUUID();

export function BomEditorPage() {
  const { tenantId, can, writable } = useTenant();
  const { bomId } = useParams({ strict: false }) as { bomId?: string };
  const isNew = !bomId || bomId === "new";
  const d = useQuery({ enabled: !isNew, queryKey: ["t", tenantId, "manufacturing", "boms", bomId], queryFn: () => api<BomDetail>("GET", `/t/boms/${bomId}`, { tenant: tenantId }) });
  if (!isNew && d.isPending) return <div className="page"><TableSkeleton columns={5} rows={6} label="جارٍ تحميل قائمة المواد…" /></div>;
  if (!isNew && d.isError) return <div className="page"><ErrorState error={d.error} onRetry={() => d.refetch()} /></div>;
  const bom = isNew ? null : d.data!;
  const editable = (isNew ? can("boms.create") : bom!.status === "draft" && can("boms.edit")) && writable;
  return editable ? <BomForm key={bom?.id ?? "new"} tenantId={tenantId} bom={bom} /> : <BomView tenantId={tenantId} bom={bom!} />;
}

function BomHeader({ tenantId, bom }: { tenantId: string; bom: BomDetail | null }) {
  return (
    <PageHeader eyebrow="قوائم المواد"
      title={bom ? <span className="pf-title">{bom.itemName} <span className="num muted">v{bom.version}</span><Badge tone={BOM_STATUS[bom.status]![1]}>{BOM_STATUS[bom.status]![0]}</Badge></span> : "قائمة مواد جديدة"}
      description={bom ? <>كمية الدفعة <strong className="num">{quantity(bom.quantity)}</strong> {bom.unit}. الإصدار المعتمد لا يُعدَّل؛ التغيير بإصدار جديد.</> : "المكونات والعمليات لدفعة واحدة من المنتج. تُحسب التكلفة المعيارية بعد الحفظ."}
      actions={<Link to={`/w/${tenantId}/manufacturing/boms`} className="btn btn-ghost"><ArrowRight aria-hidden="true" />قوائم المواد</Link>} />
  );
}

function CostPanel({ bom }: { bom: BomDetail }) {
  if (bom.costError) return <p className="banner banner-warning ca-banner" role="status">لا يمكن حساب التكلفة بعد: {bom.costError}</p>;
  if (!bom.cost) return null;
  const c = bom.cost;
  return (
    <div className="stats">
      <StatCard label={`التكلفة المعيارية لكل ${bom.unit}`} value={cost(c.unitCost)} icon={<Gauge />} hue="indigo" note={`دفعة ${quantity(bom.quantity)} = ${money(c.mainCost)}`} />
      <StatCard label="المواد" value={money(c.material)} icon={<ClipboardList />} hue="sky" note={c.total ? `${percent((c.material / c.total) * 100)} من التكلفة` : undefined} />
      <StatCard label="العمالة والأعباء" value={money(c.labor + c.overhead)} icon={<Timer />} hue="amber" note={`عمالة ${money(c.labor)} · أعباء ${money(c.overhead)}`} />
      {c.total !== c.mainCost && <StatCard label="على المنتجات الثانوية" value={money(c.total - c.mainCost)} icon={<Copy />} hue="violet" />}
    </div>
  );
}

function BomView({ tenantId, bom }: { tenantId: string; bom: BomDetail }) {
  const { can, writable } = useTenant();
  const navigate = useNavigate();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"archive" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function copy() {
    setBusy(true);
    try {
      const r = await api<{ id: string }>("POST", "/t/boms", { tenant: tenantId, body: { itemId: bom.itemId, copyFrom: bom.id } });
      toast.success("أُنشئ إصدار جديد مسودة من هذا الإصدار");
      await invalidate("manufacturing");
      navigate({ to: `/w/${tenantId}/manufacturing/boms/${r.id}` });
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  }
  async function archive() {
    setBusy(true); setErr(null);
    try {
      await api("POST", `/t/boms/${bom.id}/archive`, { tenant: tenantId });
      toast.success("أُرشف الإصدار. لن تُنشأ منه أوامر تشغيل جديدة");
      setConfirm(null);
      await invalidate("manufacturing");
    } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <div className="page">
      <BomHeader tenantId={tenantId} bom={bom} />
      <div className="row">
        {can("boms.create") && writable && <Button variant="primary" icon={<Copy />} loading={busy} loadingText="جارٍ الإنشاء…" onClick={() => void copy()}>إصدار جديد من هذا</Button>}
        {can("mos.create") && bom.status === "active" && writable && <Link to={`/w/${tenantId}/manufacturing/orders?new=${bom.itemId}`} className="btn btn-secondary"><Factory aria-hidden="true" />أمر تشغيل لهذا المنتج</Link>}
        <span className="spacer" />
        {bom.versions.length > 1 && <span className="muted acc-small">الإصدارات: {bom.versions.map((v, i) => <span key={v.id}>{i ? " · " : ""}{v.id === bom.id ? <strong className="num">v{v.version}</strong> : <Link to={`/w/${tenantId}/manufacturing/boms/${v.id}`} className="num">v{v.version}</Link>}</span>)}</span>}
        {can("boms.approve") && bom.status === "active" && writable && <Button variant="ghost" destructive onClick={() => setConfirm("archive")}>أرشفة</Button>}
      </div>
      <CostPanel bom={bom} />
      <BomTables bom={bom} />
      {bom.notes && <section className="panel panel-pad"><h2>ملاحظات</h2><p className="wrap">{bom.notes}</p></section>}
      <ConfirmDialog open={confirm === "archive"} onClose={() => setConfirm(null)} busy={busy} error={err} onConfirm={() => void archive()}
        title={`أرشفة ${bom.itemName} v${bom.version}`} confirmLabel="أرشفة الإصدار"
        message="لن يبقى للمنتج إصدار معتمد، فلا تُنشأ له أوامر تشغيل حتى يُعتمد إصدار آخر. الأوامر القائمة تكمل بإصدارها." />
    </div>
  );
}

function BomTables({ bom }: { bom: BomDetail }) {
  return (
    <>
      <section className="panel" aria-labelledby="bom-lines-h">
        <div className="toolbar"><h2 id="bom-lines-h">المكونات</h2></div>
        <div className="table-wrap">
          <table className="data-table">
            <caption className="sr-only">مكونات {bom.itemName}</caption>
            <thead><tr><th scope="col">المكون</th><th scope="col" className="end">الكمية</th><th scope="col" className="end">هالك متوقع</th><th scope="col" className="end">تكلفة الوحدة</th><th scope="col" className="end">التكلفة</th></tr></thead>
            <tbody>{bom.lines.map((l) => (
              <tr key={l.componentId}>
                <td><strong>{l.name}</strong> <span className="muted num">{l.sku}</span>{l.phantom && <> <Badge tone="info">وهمي</Badge></>}{l.hasBom && !l.phantom && <> <Badge tone="neutral">له قائمة مواد</Badge></>}</td>
                <td className="end num">{quantity(l.quantity)} {l.unit}</td>
                <td className="end num">{l.scrapPercent ? percent(l.scrapPercent) : "—"}</td>
                <td className="end num">{cost(l.unitCost)}</td>
                <td className="end num">{money(l.cost)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </section>
      {bom.operations.length > 0 && (
        <section className="panel" aria-labelledby="bom-ops-h">
          <div className="toolbar"><h2 id="bom-ops-h">العمليات</h2></div>
          <div className="table-wrap">
            <table className="data-table">
              <caption className="sr-only">عمليات {bom.itemName}</caption>
              <thead><tr><th scope="col">#</th><th scope="col">العملية</th><th scope="col">مركز العمل</th><th scope="col" className="end">إعداد (دقيقة)</th><th scope="col" className="end">تشغيل الدفعة (دقيقة)</th><th scope="col" className="end">العمالة</th><th scope="col" className="end">الأعباء</th></tr></thead>
              <tbody>{bom.operations.map((o) => (
                <tr key={o.seq}><td className="num">{o.seq}</td><td><strong>{o.name}</strong></td><td>{o.workCenterName}</td><td className="end num">{quantity(o.setupMinutes)}</td>
                  <td className="end num">{quantity(o.runMinutes)}</td><td className="end num">{money(o.labor)}</td><td className="end num">{money(o.overhead)}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      )}
      {bom.byproducts.length > 0 && (
        <section className="panel" aria-labelledby="bom-by-h">
          <div className="toolbar"><h2 id="bom-by-h">المنتجات الثانوية</h2></div>
          <div className="table-wrap">
            <table className="data-table">
              <caption className="sr-only">المنتجات الثانوية</caption>
              <thead><tr><th scope="col">المنتج</th><th scope="col" className="end">الكمية</th><th scope="col" className="end">نصيبه من التكلفة</th><th scope="col" className="end">القيمة</th></tr></thead>
              <tbody>{bom.byproducts.map((b) => (
                <tr key={b.itemId}><td><strong>{b.name}</strong></td><td className="end num">{quantity(b.quantity)} {b.unit}</td><td className="end num">{percent(b.costShare)}</td><td className="end num">{money(b.value)}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

function BomForm({ tenantId, bom }: { tenantId: string; bom: BomDetail | null }) {
  const { can } = useTenant();
  const navigate = useNavigate();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const wcs = useWorkCenters(tenantId);
  const form = useRef<HTMLFormElement>(null);
  const [item, setItem] = useState<{ id: string; name: string; unit: string } | null>(bom ? { id: bom.itemId, name: bom.itemName, unit: bom.unit } : null);
  const [qty, setQty] = useState(bom ? String(bom.quantity) : "");
  const [notes, setNotes] = useState(bom?.notes ?? "");
  const [lines, setLines] = useState<DLine[]>(() => (bom?.lines ?? []).map((l) => ({ key: k(), componentId: l.componentId, name: l.name, unit: l.unit, quantity: String(l.quantity), scrap: l.scrapPercent ? String(l.scrapPercent) : "", phantom: l.phantom, hasBom: l.hasBom })));
  const [ops, setOps] = useState<DOp[]>(() => (bom?.operations ?? []).map((o) => ({ key: k(), name: o.name, workCenterId: o.workCenterId, setup: o.setupMinutes ? String(o.setupMinutes) : "", run: String(o.runMinutes) })));
  const [bys, setBys] = useState<DBy[]>(() => (bom?.byproducts ?? []).map((b) => ({ key: k(), itemId: b.itemId, name: b.name, unit: b.unit, quantity: String(b.quantity), share: String(b.costShare) })));
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<"save" | "activate" | "delete" | null>(null);
  const [confirm, setConfirm] = useState<"activate" | "delete" | null>(null);
  const activeWcs = (wcs.data?.items ?? []).filter((w) => w.isActive);
  const touch = <T,>(f: (v: T) => void) => (v: T) => { setDirty(true); f(v); };
  const setLine = (i: number, p: Partial<DLine>) => { setDirty(true); setLines((ls) => ls.map((l, n) => (n === i ? { ...l, ...p } : l))); };
  const setOp = (i: number, p: Partial<DOp>) => { setDirty(true); setOps((ls) => ls.map((l, n) => (n === i ? { ...l, ...p } : l))); };
  const setBy = (i: number, p: Partial<DBy>) => { setDirty(true); setBys((ls) => ls.map((l, n) => (n === i ? { ...l, ...p } : l))); };

  function validate() {
    const e: Record<string, string> = {};
    if (!item) e.item = "اختر المنتج";
    if (!(num(qty) > 0)) e.quantity = "كمية الدفعة أكبر من صفر";
    if (!lines.length) e.lines = "أضف مكوّناً واحداً على الأقل";
    lines.forEach((l, i) => {
      if (!(num(l.quantity) > 0)) e[`lines.${i}.quantity`] = "كمية أكبر من صفر";
      if (l.scrap && !(num(l.scrap) >= 0 && num(l.scrap) < 100)) e[`lines.${i}.scrapPercent`] = "من 0 إلى أقل من 100";
    });
    ops.forEach((o, i) => {
      if (o.name.trim().length < 2) e[`operations.${i}.name`] = "اسم العملية";
      if (!o.workCenterId) e[`operations.${i}.workCenterId`] = "اختر مركز العمل";
      if (!(num(o.run || "0") >= 0) || !(num(o.setup || "0") >= 0)) e[`operations.${i}.runMinutes`] = "دقائق صفر أو أكثر";
    });
    bys.forEach((b, i) => { if (!(num(b.quantity) > 0)) e[`byproducts.${i}.quantity`] = "كمية أكبر من صفر"; });
    if (bys.reduce((a, b) => a + (num(b.share) || 0), 0) >= 100) e.byproducts = "مجموع أنصبة المنتجات الثانوية أقل من 100٪";
    setErrors(e);
    return Object.keys(e).length === 0;
  }
  const payload = () => ({
    quantity: num(qty), notes: notes.trim() || null,
    lines: lines.map((l) => ({ componentId: l.componentId, quantity: num(l.quantity), scrapPercent: num(l.scrap || "0"), phantom: l.phantom })),
    operations: ops.map((o) => ({ name: o.name.trim(), workCenterId: o.workCenterId, setupMinutes: num(o.setup || "0"), runMinutes: num(o.run || "0") })),
    byproducts: bys.map((b) => ({ itemId: b.itemId, quantity: num(b.quantity), costShare: num(b.share || "0") })),
  });
  async function save(): Promise<string | null> {
    if (!validate()) { focusFirstInvalid(form.current); return null; }
    setBusy("save"); setError(null);
    try {
      let id = bom?.id ?? null;
      if (id) await api("PUT", `/t/boms/${id}`, { tenant: tenantId, body: payload() });
      else id = (await api<{ id: string }>("POST", "/t/boms", { tenant: tenantId, body: { itemId: item!.id, ...payload() } })).id;
      setDirty(false);
      await invalidate("manufacturing");
      toast.success("حُفظت المسودة وحُسبت تكلفتها");
      if (!bom) navigate({ to: `/w/${tenantId}/manufacturing/boms/${id}` });
      return id;
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fieldErrors);
      setError(err);
      return null;
    } finally { setBusy(null); }
  }
  async function activate() {
    setBusy("activate"); setError(null);
    try {
      const r = await api<{ unitCost: number }>("POST", `/t/boms/${bom!.id}/activate`, { tenant: tenantId });
      toast.success(`اعتُمد الإصدار v${bom!.version}: التكلفة المعيارية ${cost(r.unitCost)} لكل ${bom!.unit}`);
      setConfirm(null);
      await invalidate("manufacturing");
    } catch (err) { setError(err); setConfirm(null); } finally { setBusy(null); }
  }
  async function remove() {
    setBusy("delete");
    try {
      await api("DELETE", `/t/boms/${bom!.id}`, { tenant: tenantId });
      toast.success("حُذفت المسودة");
      await invalidate("manufacturing");
      navigate({ to: `/w/${tenantId}/manufacturing/boms` });
    } catch (err) { setError(err); setConfirm(null); } finally { setBusy(null); }
  }
  const exclude = useMemo(() => [item?.id ?? "", ...lines.map((l) => l.componentId), ...bys.map((b) => b.itemId)], [item, lines, bys]);

  return (
    <form ref={form} className="page" noValidate onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <BomHeader tenantId={tenantId} bom={bom} />
      {bom && !dirty && <CostPanel bom={bom} />}
      {bom && dirty && <p className="banner banner-info ca-banner" role="status">عدّلت القائمة: احفظ المسودة لتُحسب تكلفتها المعيارية من جديد.</p>}
      <section className="panel panel-pad form-section" aria-labelledby="bf-h">
        <h2 id="bf-h">المنتج والدفعة</h2>
        <div className="form-grid">
          {bom ? <TextField label="المنتج" value={bom.itemName} disabled />
            : item ? <div className="field"><span className="field-label">المنتج</span><p className="acc-partner"><strong>{item.name}</strong> <Button size="sm" variant="ghost" onClick={() => setItem(null)}>تغيير</Button></p></div>
            : <IngredientPicker tenantId={tenantId} label="المنتج" required types="finished,semi_finished" placeholder="اسم المنتج التام أو نصف المصنّع" error={errors.item}
                onPick={(i: Ingredient) => { setItem({ id: i.id, name: i.name, unit: i.baseUnit }); setDirty(true); }} />}
          <TextField label={`كمية الدفعة${item ? ` (${item.unit})` : ""}`} required numeric value={qty} onChange={(e) => touch(setQty)(e.target.value)} error={errors.quantity}
            hint="الكمية التي تنتجها المكونات أدناه، مثل 500 كجم أو 1,000 حبة." />
        </div>
      </section>

      <section className="panel panel-pad form-section" aria-labelledby="bl-h">
        <h2 id="bl-h">المكونات</h2>
        {lines.length > 0 && (
          <ol className="acc-lines">
            {lines.map((l, i) => (
              <li key={l.key} className="acc-line">
                <div className="acc-line-grid mfg-line-grid">
                  <div className="field"><span className="field-label">المكون {i + 1}</span><strong>{l.name}</strong>{l.hasBom && <span className="muted acc-small">له قائمة مواد: يُحسب بتكلفتها</span>}</div>
                  <TextField label={`الكمية (${l.unit})`} required numeric value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} error={errors[`lines.${i}.quantity`]} />
                  <TextField label="هالك متوقع ٪" optional numeric value={l.scrap} onChange={(e) => setLine(i, { scrap: e.target.value })} error={errors[`lines.${i}.scrapPercent`]} />
                  {l.hasBom ? <Checkbox label="وهمي (يُفجَّر لمكوناته)" checked={l.phantom} onChange={(e) => setLine(i, { phantom: e.target.checked })} /> : <span />}
                  <IconButton label={`حذف ${l.name}`} icon={<X />} destructive className="acc-line-remove" onClick={() => { setDirty(true); setLines((ls) => ls.filter((_, n) => n !== i)); }} />
                </div>
              </li>
            ))}
          </ol>
        )}
        {errors.lines && <span className="field-error" role="alert">{errors.lines}</span>}
        <IngredientPicker tenantId={tenantId} label="إضافة مكوّن" exclude={exclude} placeholder="ابحث عن خامة أو نصف مصنّع أو مادة تعبئة"
          onPick={(i: Ingredient) => { setDirty(true); setLines((ls) => [...ls, { key: k(), componentId: i.id, name: i.name, unit: i.baseUnit, quantity: "", scrap: "", phantom: false, hasBom: i.itemType === "semi_finished" }]); }} />
      </section>

      <section className="panel panel-pad form-section" aria-labelledby="bo-h">
        <h2 id="bo-h">العمليات <span className="muted acc-small">(اختياري)</span></h2>
        {!activeWcs.length && !wcs.isPending && <p className="muted acc-small">لا توجد مراكز عمل نشطة. {can("work_centers.create") && <Link to={`/w/${tenantId}/manufacturing/work-centers`}>أضف مركز عمل</Link>} لتحمّل العمالة والأعباء على المنتج.</p>}
        {ops.length > 0 && (
          <ol className="acc-lines">
            {ops.map((o, i) => (
              <li key={o.key} className="acc-line">
                <div className="acc-line-grid mfg-line-grid">
                  <TextField label={`العملية ${i + 1}`} required value={o.name} onChange={(e) => setOp(i, { name: e.target.value })} error={errors[`operations.${i}.name`]} />
                  <SelectField label="مركز العمل" required placeholder="اختر" value={o.workCenterId} onChange={(e) => setOp(i, { workCenterId: e.target.value })} error={errors[`operations.${i}.workCenterId`]}
                    options={activeWcs.map((w) => ({ value: w.id, label: w.name }))} />
                  <TextField label="إعداد (دقيقة)" optional numeric value={o.setup} onChange={(e) => setOp(i, { setup: e.target.value })} hint="مرة لكل أمر." />
                  <TextField label="تشغيل الدفعة (دقيقة)" required numeric value={o.run} onChange={(e) => setOp(i, { run: e.target.value })} error={errors[`operations.${i}.runMinutes`]} />
                  <IconButton label={`حذف العملية ${i + 1}`} icon={<X />} destructive className="acc-line-remove" onClick={() => { setDirty(true); setOps((ls) => ls.filter((_, n) => n !== i)); }} />
                </div>
              </li>
            ))}
          </ol>
        )}
        <div className="row"><Button variant="ghost" icon={<Plus />} disabled={!activeWcs.length} onClick={() => { setDirty(true); setOps((ls) => [...ls, { key: k(), name: "", workCenterId: activeWcs[0]?.id ?? "", setup: "", run: "" }]); }}>إضافة عملية</Button></div>
      </section>

      <section className="panel panel-pad form-section" aria-labelledby="bb-h">
        <h2 id="bb-h">المنتجات الثانوية <span className="muted acc-small">(اختياري)</span></h2>
        <p className="muted acc-small">ما يخرج مع المنتج الرئيسي (نخالة، قصاصات قابلة للبيع…). نصيبه من التكلفة يُخصم من تكلفة المنتج الرئيسي.</p>
        {bys.length > 0 && (
          <ol className="acc-lines">
            {bys.map((b, i) => (
              <li key={b.key} className="acc-line">
                <div className="acc-line-grid mfg-line-grid">
                  <div className="field"><span className="field-label">المنتج الثانوي</span><strong>{b.name}</strong></div>
                  <TextField label={`الكمية في الدفعة (${b.unit})`} required numeric value={b.quantity} onChange={(e) => setBy(i, { quantity: e.target.value })} error={errors[`byproducts.${i}.quantity`]} />
                  <TextField label="نصيبه من التكلفة ٪" required numeric value={b.share} onChange={(e) => setBy(i, { share: e.target.value })} />
                  <span />
                  <IconButton label={`حذف ${b.name}`} icon={<X />} destructive className="acc-line-remove" onClick={() => { setDirty(true); setBys((ls) => ls.filter((_, n) => n !== i)); }} />
                </div>
              </li>
            ))}
          </ol>
        )}
        {errors.byproducts && <span className="field-error" role="alert">{errors.byproducts}</span>}
        <IngredientPicker tenantId={tenantId} label="إضافة منتج ثانوي" exclude={exclude} placeholder="ابحث عن الصنف"
          onPick={(i: Ingredient) => { setDirty(true); setBys((ls) => [...ls, { key: k(), itemId: i.id, name: i.name, unit: i.baseUnit, quantity: "", share: "0" }]); }} />
      </section>

      <section className="panel panel-pad form-section">
        <TextAreaField label="ملاحظات" optional rows={2} value={notes} onChange={(e) => touch(setNotes)(e.target.value)} />
      </section>

      <FormError error={error} />
      <div className="pf-form-foot">
        <Button type="submit" variant={bom && !dirty ? "secondary" : "primary"} loading={busy === "save"} loadingText="جارٍ الحفظ…">{bom ? "حفظ المسودة" : "حفظ وحساب التكلفة"}</Button>
        {bom && can("boms.approve") && <Button variant={dirty ? "secondary" : "primary"} icon={<CircleCheck />} disabled={dirty || Boolean(bom.costError)} onClick={() => setConfirm("activate")}>اعتماد الإصدار</Button>}
        <Link to={`/w/${tenantId}/manufacturing/boms`} className="btn btn-ghost">إلغاء</Link>
        <span className="spacer" />
        {bom && can("boms.delete") && <Button variant="ghost" destructive icon={<Trash2 />} onClick={() => setConfirm("delete")}>حذف المسودة</Button>}
      </div>
      {bom && <>
        <ConfirmDialog open={confirm === "activate"} onClose={() => setConfirm(null)} busy={busy === "activate"} destructive={false} onConfirm={() => void activate()}
          title={`اعتماد ${bom.itemName} v${bom.version}`} confirmLabel="اعتماد الإصدار"
          message={<>يصبح هذا الإصدار ما تستخدمه أوامر التشغيل الجديدة بتكلفة معيارية {cost(bom.cost?.unitCost)} لكل {bom.unit}{bom.versions.some((v) => v.status === "active") ? "، ويُؤرشف الإصدار المعتمد الحالي" : ""}. بعد الاعتماد لا يُعدَّل؛ التغيير بإصدار جديد.</>} />
        <ConfirmDialog open={confirm === "delete"} onClose={() => setConfirm(null)} busy={busy === "delete"} onConfirm={() => void remove()}
          title={`حذف مسودة v${bom.version}`} confirmLabel="حذف المسودة" message="تُحذف هذه المسودة نهائياً. الإصدارات الأخرى لا تتأثر." />
      </>}
    </form>
  );
}

// ── Manufacturing orders ────────────────────────────────────────────────────────────────────────
const MO_STATUS: Record<string, [string, Tone]> = {
  draft: ["مسودة", "neutral"], confirmed: ["مؤكد", "info"], in_progress: ["قيد التنفيذ", "warning"], closed: ["مقفل", "success"], cancelled: ["ملغى", "danger"],
};
interface MoRow {
  id: string; number: number; status: string; quantity: number; producedQuantity: number; plannedStart: string | null; dueDate: string | null; itemName: string; itemSku: string;
  unit: string; bomVersion: number; locationName: string; standardUnitCost: number | null; wip: number; late: boolean;
}

export function ManufacturingOrdersPage() {
  const { tenantId, can, writable } = useTenant();
  const navigate = useNavigate();
  const [init] = useState(() => new URLSearchParams(window.location.search));
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [status, setStatus] = useState("open");
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState<string | null>(init.get("new"));
  useEffect(() => { const t = setTimeout(() => { setDebounced(q.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);
  const list = useQuery({ queryKey: ["t", tenantId, "manufacturing", "orders", { debounced, status, page }], placeholderData: keepPreviousData,
    queryFn: () => api<Page<MoRow> & { counts: Record<string, number> }>("GET", "/t/manufacturing-orders", { tenant: tenantId, query: { q: debounced, status, page, pageSize: 25 } }) });
  const counts = list.data?.counts ?? {};
  const canCreate = can("mos.create") && writable;
  return (
    <div className="page">
      <PageHeader eyebrow="التصنيع" title="أوامر التشغيل"
        description="كل أمر يصرف المواد ويحمّل ساعات التشغيل ويُدخل الإنتاج بالتكلفة المعيارية، وعند الإقفال يُرحَّل الفرق انحرافاً فيعود رصيد الإنتاج تحت التشغيل إلى صفر."
        actions={canCreate && <Button variant="primary" icon={<Plus />} onClick={() => setCreating("")}>أمر تشغيل جديد</Button>} />
      <div className="stats">
        <StatCard label="قيد التنفيذ" value={integer(counts.in_progress ?? 0)} icon={<Hammer />} hue="amber" />
        <StatCard label="مؤكدة لم تبدأ" value={integer(counts.confirmed ?? 0)} icon={<ClipboardList />} hue="sky" />
        <StatCard label="مسودات" value={integer(counts.draft ?? 0)} icon={<Factory />} hue="indigo" />
      </div>
      <section className="panel" aria-label="أوامر التشغيل">
        <DataTable caption="أوامر التشغيل" query={list} rowKey={(r) => r.id} onPageChange={setPage} onRowClick={(r) => navigate({ to: `/w/${tenantId}/manufacturing/orders/${r.id}` })}
          filtered={Boolean(debounced) || status !== "open"} onClearFilters={() => { setQ(""); setStatus("open"); }}
          toolbar={<><SearchInput placeholder="ابحث برقم الأمر أو اسم المنتج" value={q} onChange={setQ} />
            <StatusTabs value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={[["open", "المفتوحة"], ["in_progress", "قيد التنفيذ"], ["draft", "المسودات"], ["closed", "المقفلة"], ["", "الكل"]]} /></>}
          empty={{ title: "لا توجد أوامر تشغيل مفتوحة", body: "أنشئ أمراً لمنتج له قائمة مواد معتمدة، ثم أكّده لتصرف المواد وتسجّل الإنتاج.",
            action: canCreate ? <Button variant="primary" icon={<Plus />} onClick={() => setCreating("")}>أمر تشغيل جديد</Button> : undefined }}
          columns={[
            { key: "number", sortKey: false, header: "الأمر", cell: (r) => <strong><bdi dir="ltr" className="num">MO-{r.number}</bdi></strong> },
            { key: "itemName", sortKey: false, header: "المنتج", cell: (r) => <span className="stack-tight"><strong>{r.itemName}</strong><span className="muted acc-small">v{r.bomVersion} · {r.locationName}</span></span> },
            { key: "status", sortKey: false, header: "الحالة", cell: (r) => <span className="row" style={{ gap: "var(--sp-1)" }}><Badge tone={MO_STATUS[r.status]![1]}>{MO_STATUS[r.status]![0]}</Badge>{r.late && <Badge tone="danger">متأخر</Badge>}</span> },
            { key: "progress", sortKey: false, header: "المنتَج / المخطط", numeric: true, cell: (r) => <>{quantity(r.producedQuantity)} / {quantity(r.quantity)} {r.unit}</> },
            { key: "dueDate", sortKey: false, header: "التسليم", cell: (r) => (r.dueDate ? day(r.dueDate) : "—") },
            { key: "wip", sortKey: false, header: "تحت التشغيل", numeric: true, cell: (r) => (r.wip ? money(r.wip) : "—") },
          ]} />
      </section>
      {creating !== null && <NewMoDialog tenantId={tenantId} initialItemId={creating || null} onClose={() => setCreating(null)} />}
    </div>
  );
}

interface Plan { unitCost: number; total: number; minutes: number; components: { componentId: string; quantity: number; name: string; unit: string; available: number | null }[] }

function NewMoDialog({ tenantId, initialItemId, onClose }: { tenantId: string; initialItemId: string | null; onClose: () => void }) {
  const navigate = useNavigate();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const locations = useLocations(tenantId);
  const centers = useCostCenters(tenantId);
  const [key, renewKey] = useIdempotencyKey();
  const form = useRef<HTMLFormElement>(null);
  const [item, setItem] = useState<{ id: string; name: string; unit: string } | null>(null);
  const [v, setV] = useState({ quantity: "", locationId: "", outputLocationId: "", dueDate: "", costCenterId: "", notes: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const itemId = item?.id ?? initialItemId;
  const bom = useQuery({ enabled: Boolean(itemId), queryKey: ["t", tenantId, "manufacturing", "boms", { active: itemId }],
    queryFn: () => api<Page<BomRow>>("GET", "/t/boms", { tenant: tenantId, query: { itemId: itemId!, status: "active", pageSize: 1 } }) });
  const active = bom.data?.items[0];
  useEffect(() => { if (active && !item) setItem({ id: active.itemId, name: active.itemName, unit: active.unit }); }, [active, item]);
  const [debQty, setDebQty] = useState(0);
  useEffect(() => { const t = setTimeout(() => setDebQty(num(v.quantity) || 0), 350); return () => clearTimeout(t); }, [v.quantity]);
  const plan = useQuery({ enabled: Boolean(active && debQty > 0), placeholderData: keepPreviousData,
    queryKey: ["t", tenantId, "manufacturing", "plan", active?.id, debQty, v.locationId],
    queryFn: () => api<Plan>("GET", `/t/boms/${active!.id}/plan`, { tenant: tenantId, query: { quantity: debQty, locationId: v.locationId || undefined } }) });
  const short = (plan.data?.components ?? []).filter((c) => c.available !== null && c.available < c.quantity);

  async function submit() {
    const e: Record<string, string> = {};
    if (!item) e.itemId = "اختر المنتج";
    else if (!active && !bom.isPending) e.itemId = "لا توجد قائمة مواد معتمدة لهذا المنتج";
    if (!(num(v.quantity) > 0)) e.quantity = "كمية أكبر من صفر";
    if (!v.locationId) e.locationId = "اختر موقع الإنتاج";
    setErrors(e);
    if (Object.keys(e).length) return focusFirstInvalid(form.current);
    setBusy(true); setError(null);
    try {
      const r = await api<{ id: string }>("POST", "/t/manufacturing-orders", { tenant: tenantId, idempotencyKey: key, body: {
        itemId: item!.id, bomId: active?.id, quantity: num(v.quantity), locationId: v.locationId, outputLocationId: v.outputLocationId || undefined,
        dueDate: v.dueDate || null, plannedStart: isoDay(), costCenterId: v.costCenterId || null, notes: v.notes.trim() || null } });
      renewKey();
      toast.success("أُنشئ أمر التشغيل مسودة. أكّده لبدء الصرف والإنتاج");
      await invalidate("manufacturing");
      navigate({ to: `/w/${tenantId}/manufacturing/orders/${r.id}` });
    } catch (err) { if (err instanceof ApiError) setErrors(err.fieldErrors); setError(err); } finally { setBusy(false); }
  }
  const locOptions = (locations.data?.items ?? []).map((l) => ({ value: l.id, label: l.name }));
  return (
    <Dialog open wide onClose={onClose} busy={busy} formRef={form} onSubmit={() => void submit()} title="أمر تشغيل جديد"
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الإنشاء…">إنشاء الأمر</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      {item ? <p className="acc-partner">المنتج: <strong>{item.name}</strong>{active && <span className="muted"> · قائمة المواد v{active.version}</span>} <Button size="sm" variant="ghost" onClick={() => setItem(null)}>تغيير</Button></p>
        : <IngredientPicker tenantId={tenantId} label="المنتج" required types="finished,semi_finished" placeholder="اسم المنتج" error={errors.itemId}
            onPick={(i: Ingredient) => setItem({ id: i.id, name: i.name, unit: i.baseUnit })} />}
      {item && !bom.isPending && !active && <p className="field-error" role="alert">لا توجد قائمة مواد معتمدة لهذا المنتج. <Link to={`/w/${tenantId}/manufacturing/boms/new`}>أنشئ قائمته واعتمدها</Link>.</p>}
      <div className="form-grid">
        <TextField label={`الكمية المطلوبة${item ? ` (${item.unit})` : ""}`} required numeric value={v.quantity} onChange={(e) => setV({ ...v, quantity: e.target.value })} error={errors.quantity} />
        <TextField label="تاريخ التسليم" optional type="date" min={isoDay()} value={v.dueDate} onChange={(e) => setV({ ...v, dueDate: e.target.value })} />
        <SelectField label="موقع الإنتاج" required placeholder="اختر" value={v.locationId} onChange={(e) => setV({ ...v, locationId: e.target.value })} error={errors.locationId} options={locOptions}
          hint="تُصرف منه المكونات." />
        <SelectField label="يُستلم الإنتاج في" optional placeholder="نفس موقع الإنتاج" value={v.outputLocationId} onChange={(e) => setV({ ...v, outputLocationId: e.target.value })} options={locOptions} />
        {(centers.data?.items ?? []).some((c) => c.isActive) && (
          <SelectField label="مركز التكلفة" optional placeholder="بدون" value={v.costCenterId} onChange={(e) => setV({ ...v, costCenterId: e.target.value })}
            options={(centers.data?.items ?? []).filter((c) => c.isActive).map((c) => ({ value: c.id, label: `${c.code} · ${c.name}` }))} hint="يُحمَّل عليه الانحراف والهالك غير العادي." />
        )}
      </div>
      {plan.data && debQty > 0 && (
        <div className="stack-tight" role="status" aria-live="polite">
          <p>التكلفة المعيارية اليوم: <strong>{cost(plan.data.unitCost)}</strong> لكل {item?.unit} · الإجمالي <strong>{money(plan.data.total)}</strong> · التشغيل <span className="num">{integer(plan.data.minutes)}</span> دقيقة</p>
          <div className="table-wrap">
            <table className="data-table">
              <caption className="sr-only">احتياج المكونات</caption>
              <thead><tr><th scope="col">المكون</th><th scope="col" className="end">المطلوب</th>{v.locationId && <th scope="col" className="end">المتاح في الموقع</th>}</tr></thead>
              <tbody>{plan.data.components.map((c) => (
                <tr key={c.componentId}><td>{c.name}</td><td className="end num">{quantity(c.quantity)} {c.unit}</td>
                  {v.locationId && <td className="end num">{c.available !== null && c.available < c.quantity ? <Badge tone="warning">{quantity(c.available)}</Badge> : quantity(c.available)}</td>}</tr>
              ))}</tbody>
            </table>
          </div>
          {short.length > 0 && <p className="muted acc-small">رصيد {integer(short.length)} مكوّن في الموقع لا يكفي الآن. يمكنك إنشاء الأمر، والصرف يحتاج الرصيد (حوّل أو اشترِ أولاً).</p>}
        </div>
      )}
      <TextAreaField label="ملاحظات" optional rows={2} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} />
      <FormError error={error} />
    </Dialog>
  );
}

interface MoDetail {
  id: string; number: number; status: string; quantity: number; producedQuantity: number; plannedStart: string | null; dueDate: string | null; notes: string | null;
  createdAt: string; confirmedAt: string | null; closedAt: string | null; cancelledAt: string | null; cancelReason: string | null; standardUnitCost: number | null;
  itemId: string; itemName: string; itemSku: string; unit: string; trackExpiry: boolean; bomId: string; bomVersion: number;
  locationName: string; outputLocationName: string; costCenterName: string | null;
  components: { componentId: string; name: string; sku: string; unit: string; requiredQty: number; standardCost: number; issuedQty: number; issuedValue: number; remainingQty: number; availableQty: number }[];
  operations: { seq: number; name: string; workCenterName: string; plannedMinutes: number; actualMinutes: number; laborRate: number; overheadRate: number }[];
  byproducts: { itemId: string; name: string; unit: string; perUnit: number; unitCost: number }[];
  events: { id: string; number: number; kind: string; detail: Record<string, any>; wipDelta: number; createdAt: string; journalId: string | null; journalNumber: number | null }[];
  costs: { materials: number; conversion: number; output: number; variance: number; wip: number; standardForOutput: number; price: number; usage: number; efficiency: number };
}
const EVENT_LABEL: Record<string, string> = { issue: "صرف مواد", return: "إرجاع مواد", labor: "تحميل تشغيل", output: "إنتاج", close: "إقفال" };

export function ManufacturingOrderPage() {
  const { tenantId, can, writable } = useTenant();
  const { moId } = useParams({ strict: false }) as { moId: string };
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [dialog, setDialog] = useState<"issue" | "return" | "labor" | "produce" | "close" | "cancel" | "confirm" | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [key, renewKey] = useIdempotencyKey();
  const m = useQuery({ queryKey: ["t", tenantId, "manufacturing", "orders", moId], queryFn: () => api<MoDetail>("GET", `/t/manufacturing-orders/${moId}`, { tenant: tenantId }) });
  if (m.isPending) return <div className="page"><TableSkeleton columns={5} rows={6} label="جارٍ تحميل أمر التشغيل…" /></div>;
  if (m.isError) return <div className="page"><ErrorState error={m.error} onRetry={() => m.refetch()} /></div>;
  const d = m.data;
  const refresh = () => invalidate("manufacturing", "stock", "ingredients", "accounting", "batches");
  const done = async (msg: string) => { toast.success(msg); setDialog(null); await refresh(); };
  async function simple(path: "confirm" | "close" | "cancel") {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ variance?: number; standardUnitCost?: number }>("POST", `/t/manufacturing-orders/${d.id}/${path}`, {
        tenant: tenantId, ...(path === "close" ? { idempotencyKey: key } : {}), ...(path === "cancel" ? { body: { reason: reason.trim() } } : {}) });
      if (path === "close") renewKey();
      await done(path === "confirm" ? `تأكد الأمر بتكلفة معيارية ${cost(r.standardUnitCost)} لكل ${d.unit}`
        : path === "close" ? `أُقفل الأمر${r.variance ? ` وانحرافه ${money(r.variance)} رُحِّل إلى انحرافات الإنتاج` : " بلا انحراف"}` : "أُلغي الأمر");
    } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  }
  const working = d.status === "confirmed" || d.status === "in_progress";
  const w = writable;
  const progress = d.quantity ? Math.min(100, (d.producedQuantity / d.quantity) * 100) : 0;
  const primary = d.status === "draft" && can("mos.confirm") ? <Button variant="primary" icon={<CircleCheck />} onClick={() => { setErr(null); setDialog("confirm"); }}>تأكيد الأمر</Button>
    : d.status === "confirmed" && can("mos.issue") ? <Button variant="primary" icon={<ClipboardList />} onClick={() => setDialog("issue")}>صرف المواد</Button>
    // Once the plan is produced, closing is what is left to do.
    : d.status === "in_progress" && d.producedQuantity >= d.quantity && can("mos.close") ? <Button variant="primary" icon={<CircleCheck />} onClick={() => { setErr(null); setDialog("close"); }}>إقفال الأمر</Button>
    : d.status === "in_progress" && can("mos.produce") ? <Button variant="primary" icon={<PackageCheck />} onClick={() => setDialog("produce")}>تسجيل إنتاج</Button> : null;
  const more = [
    ...(working && can("mos.produce") && (d.status === "confirmed" || d.producedQuantity >= d.quantity) ? [{ label: d.status === "confirmed" ? "تسجيل إنتاج (صرف تلقائي)" : "تسجيل إنتاج إضافي", onSelect: () => setDialog("produce") }] : []),
    ...(d.status === "in_progress" && can("mos.issue") ? [{ label: "صرف مواد", onSelect: () => setDialog("issue") }, { label: "إرجاع مواد لم تُستخدم", onSelect: () => setDialog("return") }] : []),
    ...(working && can("mos.labor") && d.operations.length ? [{ label: "تسجيل ساعات تشغيل", onSelect: () => setDialog("labor") }] : []),
    ...(d.status === "in_progress" && d.producedQuantity < d.quantity && can("mos.close") ? [{ label: "إقفال الأمر…", separated: true, onSelect: () => { setErr(null); setDialog("close"); } }] : []),
    ...((d.status === "draft" || d.status === "confirmed") && can("mos.cancel") && !d.events.length ? [{ label: "إلغاء الأمر", danger: true, separated: true, onSelect: () => { setErr(null); setReason(""); setDialog("cancel"); } }] : []),
  ];
  return (
    <div className="page">
      <PageHeader eyebrow="أوامر التشغيل"
        title={<span className="pf-title"><bdi dir="ltr" className="num">MO-{d.number}</bdi> · {d.itemName}<Badge tone={MO_STATUS[d.status]![1]}>{MO_STATUS[d.status]![0]}</Badge></span>}
        description={<>{quantity(d.quantity)} {d.unit} من قائمة المواد <Link to={`/w/${tenantId}/manufacturing/boms/${d.bomId}`}>v{d.bomVersion}</Link> · الإنتاج في {d.locationName}{d.outputLocationName !== d.locationName ? ` ويُستلم في ${d.outputLocationName}` : ""}{d.dueDate ? ` · التسليم ${day(d.dueDate)}` : ""}</>}
        actions={<><Link to={`/w/${tenantId}/manufacturing/orders`} className="btn btn-ghost"><ArrowRight aria-hidden="true" />الأوامر</Link>
          {w && primary}{w && more.length > 0 && <ActionMenu label="إجراءات أخرى للأمر" items={more} />}</>} />
      {d.status === "cancelled" && <p className="banner banner-warning ca-banner">أُلغي الأمر في {dayTime(d.cancelledAt)}: {d.cancelReason}</p>}
      {d.status === "draft" && <p className="banner banner-info ca-banner">مسودة: التأكيد يجمّد المكونات والعمليات وتكلفة الوحدة المعيارية من قائمة المواد المعتمدة وأسعار اليوم.</p>}

      {d.status !== "draft" && d.status !== "cancelled" && (
        <div className="stats">
          <StatCard label="المنتَج" value={<>{quantity(d.producedQuantity)} <span className="muted acc-small">/ {quantity(d.quantity)} {d.unit}</span></>} icon={<PackageCheck />} hue="green" note={`${percent(progress)} من المخطط`} />
          <StatCard label="التكلفة المعيارية للوحدة" value={cost(d.standardUnitCost)} icon={<Gauge />} hue="indigo" note={`الإنتاج بالمعياري ${money(d.costs.standardForOutput)}`} />
          <StatCard label="المواد والتشغيل الفعلي" value={money(d.costs.materials + d.costs.conversion)} icon={<Timer />} hue="sky" note={`مواد ${money(d.costs.materials)} · تشغيل ${money(d.costs.conversion)}`} />
          <StatCard label={d.status === "closed" ? "الانحراف المرحّل" : "تحت التشغيل الآن"} value={money(d.status === "closed" ? d.costs.variance : d.costs.wip)} icon={<Factory />} hue={d.status === "closed" && d.costs.variance > 0 ? "red" : "amber"}
            note={d.status === "closed" ? "صفر تحت التشغيل بعد الإقفال" : "يُرحَّل الباقي انحرافاً عند الإقفال"} />
        </div>
      )}
      {(d.status === "in_progress" || d.status === "closed") && (
        <section className="panel panel-pad" aria-labelledby="var-h">
          <h2 id="var-h">تحليل الانحرافات</h2>
          <p className="muted acc-small">مقارنة ما دخل الأمر بما يستحقه إنتاجه بالمعيار. موجب = تكلفة أعلى من المعيار.</p>
          <dl className="dl">
            <dt>انحراف السعر (المواد)</dt><dd className="num">{money(d.costs.price)}</dd>
            <dt>انحراف الكمية (المواد)</dt><dd className="num">{money(d.costs.usage)}</dd>
            <dt>انحراف الكفاءة (الوقت)</dt><dd className="num">{money(d.costs.efficiency)}</dd>
          </dl>
        </section>
      )}

      <section className="panel" aria-labelledby="mo-comp-h">
        <div className="toolbar"><h2 id="mo-comp-h">المكونات</h2></div>
        {d.status === "draft" ? <p className="card-body muted">تظهر المكونات بكمياتها عند تأكيد الأمر.</p> : (
          <div className="table-wrap">
            <table className="data-table">
              <caption className="sr-only">مكونات الأمر</caption>
              <thead><tr><th scope="col">المكون</th><th scope="col" className="end">المطلوب</th><th scope="col" className="end">المصروف</th><th scope="col" className="end">المتبقي</th><th scope="col" className="end">المتاح في الموقع</th><th scope="col" className="end">قيمة المصروف</th></tr></thead>
              <tbody>{d.components.map((c) => (
                <tr key={c.componentId}>
                  <td><strong>{c.name}</strong> <span className="muted num">{c.sku}</span></td>
                  <td className="end num">{quantity(c.requiredQty)} {c.unit}</td>
                  <td className="end num">{quantity(c.issuedQty)}</td>
                  <td className="end num">{c.remainingQty > 0 ? quantity(c.remainingQty) : <Badge tone="success">مكتمل</Badge>}</td>
                  <td className="end num">{working && c.remainingQty > c.availableQty ? <Badge tone="warning">{quantity(c.availableQty)}</Badge> : quantity(c.availableQty)}</td>
                  <td className="end num">{money(c.issuedValue)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>

      {d.operations.length > 0 && (
        <section className="panel" aria-labelledby="mo-ops-h">
          <div className="toolbar"><h2 id="mo-ops-h">العمليات</h2></div>
          <div className="table-wrap">
            <table className="data-table">
              <caption className="sr-only">عمليات الأمر</caption>
              <thead><tr><th scope="col">#</th><th scope="col">العملية</th><th scope="col">مركز العمل</th><th scope="col" className="end">المخطط (دقيقة)</th><th scope="col" className="end">الفعلي (دقيقة)</th><th scope="col" className="end">سعر الساعة</th></tr></thead>
              <tbody>{d.operations.map((o) => (
                <tr key={o.seq}><td className="num">{o.seq}</td><td><strong>{o.name}</strong></td><td>{o.workCenterName}</td><td className="end num">{quantity(o.plannedMinutes)}</td>
                  <td className="end num">{quantity(o.actualMinutes)}</td><td className="end num">{money(o.laborRate + o.overheadRate)}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      )}

      <section className="panel" aria-labelledby="mo-ev-h">
        <div className="toolbar"><h2 id="mo-ev-h">سجل الأمر</h2></div>
        {d.events.length === 0 ? <EmptyState title="لا توجد عمليات بعد">{working ? "ابدأ بصرف المواد، أو سجّل إنتاجاً بصرف تلقائي." : "تُسجَّل هنا عمليات الصرف والتشغيل والإنتاج وقيودها."}</EmptyState> : (
          <div className="table-wrap">
            <table className="data-table">
              <caption className="sr-only">سجل عمليات الأمر</caption>
              <thead><tr><th scope="col">الوقت</th><th scope="col">العملية</th><th scope="col">التفاصيل</th><th scope="col" className="end">أثرها على تحت التشغيل</th><th scope="col">القيد</th></tr></thead>
              <tbody>{d.events.map((e) => (
                <tr key={e.id}>
                  <td>{dayTime(e.createdAt)}</td>
                  <td><strong>{EVENT_LABEL[e.kind] ?? e.kind}</strong></td>
                  <td className="wrap">{eventDetail(e, d)}</td>
                  <td className="end num">{e.wipDelta ? money(e.wipDelta) : "—"}</td>
                  <td>{e.journalId ? <Link to={`/w/${tenantId}/accounting/journal/${e.journalId}`} className="num">{e.journalNumber}</Link> : "—"}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>
      {d.notes && <section className="panel panel-pad"><h2>ملاحظات</h2><p className="wrap">{d.notes}</p></section>}

      {dialog === "issue" && <IssueDialog tenantId={tenantId} mo={d} mode="issue" onClose={() => setDialog(null)} onDone={done} />}
      {dialog === "return" && <IssueDialog tenantId={tenantId} mo={d} mode="return" onClose={() => setDialog(null)} onDone={done} />}
      {dialog === "labor" && <LaborDialog tenantId={tenantId} mo={d} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === "produce" && <ProduceDialog tenantId={tenantId} mo={d} onClose={() => setDialog(null)} onDone={done} />}
      <ConfirmDialog open={dialog === "confirm"} onClose={() => setDialog(null)} busy={busy} error={err} destructive={false} onConfirm={() => void simple("confirm")}
        title={`تأكيد MO-${d.number}`} confirmLabel="تأكيد الأمر"
        message="تُجمَّد المكونات والعمليات من قائمة المواد المعتمدة، وتُحسب تكلفة الوحدة المعيارية بأسعار اليوم. بعدها يمكن الصرف والإنتاج، ولا يُعدَّل الأمر." />
      <ConfirmDialog open={dialog === "close"} onClose={() => setDialog(null)} busy={busy} error={err} onConfirm={() => void simple("close")}
        title={`إقفال MO-${d.number}`} confirmLabel="إقفال الأمر وترحيل الانحراف"
        message={<>الإنتاج {quantity(d.producedQuantity)} من {quantity(d.quantity)} {d.unit}. الباقي تحت التشغيل <strong>{money(d.costs.wip)}</strong> يُرحَّل إلى «انحرافات الإنتاج»{d.costs.wip < 0 ? " (دائن: تكلفة أقل من المعيار)" : ""}. لا يمكن الصرف أو الإنتاج على الأمر بعد إقفاله.{d.components.some((c) => c.issuedQty > 0 && d.producedQuantity === 0) ? " لم يُسجَّل أي إنتاج: كل ما صُرف سيصبح انحرافاً. أرجع المواد غير المستخدمة أولاً." : ""}</>} />
      <ConfirmDialog open={dialog === "cancel"} onClose={() => setDialog(null)} busy={busy} error={err} onConfirm={() => void simple("cancel")}
        title={`إلغاء MO-${d.number}`} confirmLabel="إلغاء الأمر" message="يُلغى الأمر ولا يُحذف. لم تُصرف عليه مواد، فلا أثر على المخزون أو الحسابات.">
        <TextField label="سبب الإلغاء" required value={reason} onChange={(e) => setReason(e.target.value)} />
      </ConfirmDialog>
    </div>
  );
}

function eventDetail(e: MoDetail["events"][number], d: MoDetail) {
  const name = (id: string) => d.components.find((c) => c.componentId === id)?.name ?? d.byproducts.find((b) => b.itemId === id)?.name ?? "";
  const x = e.detail;
  if (e.kind === "issue" || e.kind === "return") return (x.lines as { componentId: string; quantity: number }[]).map((l) => `${name(l.componentId)} ${quantity(l.quantity)}`).join("، ") + (x.note ? ` · ${x.note}` : "");
  if (e.kind === "labor") return `${x.operation}: ${quantity(x.minutes)} دقيقة (عمالة ${money(x.labor)}، أعباء ${money(x.overhead)})`;
  if (e.kind === "output") {
    const parts = [x.quantity ? `${quantity(x.quantity)} ${d.unit} بقيمة ${money(x.value)}` : null, x.batch ? `تشغيلة ${x.batch.batchNo}${x.batch.expiryDate ? ` تنتهي ${day(x.batch.expiryDate)}` : ""}` : null,
      x.scrapQuantity ? `هالك ${quantity(x.scrapQuantity)} (${x.scrapReason}) ${money(x.scrapValue)}` : null,
      ...((x.byproducts ?? []) as { itemId: string; quantity: number }[]).map((b) => `${name(b.itemId)} ${quantity(b.quantity)}`), x.backflush ? "صرف تلقائي" : null];
    return parts.filter(Boolean).join(" · ");
  }
  return x.variance ? `انحراف ${money(x.variance)}` : "بلا انحراف";
}

function IssueDialog({ tenantId, mo, mode, onClose, onDone }: { tenantId: string; mo: MoDetail; mode: "issue" | "return"; onClose: () => void; onDone: (m: string) => Promise<void> }) {
  const [key, renewKey] = useIdempotencyKey();
  const rows = mode === "issue" ? mo.components : mo.components.filter((c) => c.issuedQty > 0);
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries(rows.map((c) => [c.componentId, mode === "issue" ? (c.remainingQty > 0 ? String(Math.min(c.remainingQty, c.availableQty)) : "") : ""])));
  const [note, setNote] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    const lines = rows.map((c) => ({ componentId: c.componentId, quantity: num(qty[c.componentId] ?? "") || 0 })).filter((l) => l.quantity > 0);
    if (!lines.length) return setError(new Error("أدخل كمية لمكوّن واحد على الأقل"));
    const over = mode === "return" ? rows.find((c) => (num(qty[c.componentId] ?? "") || 0) > c.issuedQty) : rows.find((c) => (num(qty[c.componentId] ?? "") || 0) > c.availableQty);
    if (over) return setError(new Error(mode === "return" ? `لا يُرجع من «${over.name}» أكثر مما صُرف` : `رصيد «${over.name}» في ${mo.locationName} لا يكفي`));
    setBusy(true); setError(null);
    try {
      await api("POST", `/t/manufacturing-orders/${mo.id}/${mode}`, { tenant: tenantId, idempotencyKey: key, body: { lines, note: note.trim() || null } });
      renewKey();
      await onDone(mode === "issue" ? "صُرفت المواد وأُضيفت قيمتها إلى الإنتاج تحت التشغيل" : "أُرجعت المواد إلى المخزون بتكلفتها");
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open wide onClose={onClose} busy={busy} onSubmit={() => void submit()} title={mode === "issue" ? `صرف مواد لـ MO-${mo.number}` : `إرجاع مواد من MO-${mo.number}`}
      footer={<><Button type="submit" variant="primary" icon={mode === "issue" ? <ClipboardList /> : <Undo2 />} loading={busy} loadingText="جارٍ التسجيل…">{mode === "issue" ? "صرف المواد" : "إرجاع المواد"}</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <p className="muted acc-small">{mode === "issue" ? `تُصرف من ${mo.locationName} بمتوسط التكلفة، والأقرب انتهاءً أولاً. الكميات مقترحة بالمتبقي حتى حد الرصيد.` : "تعود إلى موقع الإنتاج بالتكلفة التي صُرفت بها للأمر."}</p>
      <div className="table-wrap">
        <table className="data-table">
          <caption className="sr-only">الكميات</caption>
          <thead><tr><th scope="col">المكون</th><th scope="col" className="end">{mode === "issue" ? "المتبقي" : "المصروف"}</th>{mode === "issue" && <th scope="col" className="end">المتاح</th>}<th scope="col" className="end">الكمية</th></tr></thead>
          <tbody>{rows.map((c) => (
            <tr key={c.componentId}>
              <td>{c.name}</td>
              <td className="end num">{quantity(mode === "issue" ? c.remainingQty : c.issuedQty)} {c.unit}</td>
              {mode === "issue" && <td className="end num">{quantity(c.availableQty)}</td>}
              <td className="end"><input className="input input-sm num" inputMode="decimal" aria-label={`كمية ${c.name}`} value={qty[c.componentId] ?? ""} onChange={(e) => setQty({ ...qty, [c.componentId]: e.target.value })} style={{ maxWidth: 120 }} /></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <TextField label="ملاحظة" optional value={note} onChange={(e) => setNote(e.target.value)} />
      <FormError error={error} />
    </Dialog>
  );
}

function LaborDialog({ tenantId, mo, onClose, onDone }: { tenantId: string; mo: MoDetail; onClose: () => void; onDone: (m: string) => Promise<void> }) {
  const [key, renewKey] = useIdempotencyKey();
  const next = mo.operations.find((o) => o.actualMinutes < o.plannedMinutes) ?? mo.operations[0]!;
  const [seq, setSeq] = useState(String(next.seq));
  const [minutes, setMinutes] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const op = mo.operations.find((o) => String(o.seq) === seq)!;
  const m = num(minutes) || 0;
  async function submit() {
    if (!(m > 0)) return setErrors({ minutes: "دقائق أكبر من صفر" });
    setErrors({}); setBusy(true); setError(null);
    try {
      await api("POST", `/t/manufacturing-orders/${mo.id}/labor`, { tenant: tenantId, idempotencyKey: key, body: { seq: Number(seq), minutes: m } });
      renewKey();
      await onDone(`حُمّلت ${quantity(m)} دقيقة من «${op.name}» على الأمر`);
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title="تسجيل ساعات تشغيل"
      footer={<><Button type="submit" variant="primary" icon={<Timer />} loading={busy} loadingText="جارٍ التسجيل…">تسجيل الوقت</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <SelectField label="العملية" required value={seq} onChange={(e) => setSeq(e.target.value)}
        options={mo.operations.map((o) => ({ value: String(o.seq), label: `${o.seq}. ${o.name} (${o.workCenterName}) · ${quantity(o.actualMinutes)} / ${quantity(o.plannedMinutes)} دقيقة` }))} />
      <TextField label="المدة (دقيقة)" required numeric value={minutes} onChange={(e) => setMinutes(e.target.value)} error={errors.minutes} />
      {m > 0 && <p role="status">يُحمَّل على الأمر <strong>{money(Math.round((m / 60) * (op.laborRate + op.overheadRate) * 100) / 100)}</strong> (عمالة {money(Math.round((m / 60) * op.laborRate * 100) / 100)} + أعباء {money(Math.round((m / 60) * op.overheadRate * 100) / 100)}) — يُحسب نهائياً في الخادم.</p>}
      <FormError error={error} />
    </Dialog>
  );
}

function ProduceDialog({ tenantId, mo, onClose, onDone }: { tenantId: string; mo: MoDetail; onClose: () => void; onDone: (m: string) => Promise<void> }) {
  const [key, renewKey] = useIdempotencyKey();
  const nothingIssued = mo.components.every((c) => c.issuedQty === 0);
  const left = Math.max(0, mo.quantity - mo.producedQuantity);
  const form = useRef<HTMLFormElement>(null);
  const [v, setV] = useState({ quantity: left ? String(left) : "", scrap: "", scrapReason: "", batchNo: "", expiry: "", backflush: nothingIssued });
  const [bys, setBys] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const q = num(v.quantity) || 0;
  async function submit() {
    const e: Record<string, string> = {};
    if (!(q >= 0) || (q === 0 && !(num(v.scrap) > 0))) e.quantity = "أدخل الكمية الجيدة أو الهالك";
    if (v.scrap && !(num(v.scrap) >= 0)) e.scrapQuantity = "صفر أو أكثر";
    if (num(v.scrap) > 0 && v.scrapReason.trim().length < 2) e.scrapReason = "اذكر سبب الهالك";
    setErrors(e);
    if (Object.keys(e).length) return focusFirstInvalid(form.current);
    setBusy(true); setError(null);
    try {
      await api("POST", `/t/manufacturing-orders/${mo.id}/produce`, { tenant: tenantId, idempotencyKey: key, body: {
        quantity: q, scrapQuantity: num(v.scrap) || 0, scrapReason: v.scrapReason.trim() || null, batchNo: v.batchNo.trim() || null, expiryDate: v.expiry || null,
        backflush: v.backflush, ...(mo.byproducts.length ? { byproducts: mo.byproducts.map((b) => ({ itemId: b.itemId, quantity: bys[b.itemId] !== undefined && bys[b.itemId] !== "" ? num(bys[b.itemId]!) : b.perUnit * q })) } : {}) } });
      renewKey();
      await onDone(`سُجّل إنتاج ${quantity(q)} ${mo.unit} ودخل ${mo.outputLocationName} بالتكلفة المعيارية`);
    } catch (err) { if (err instanceof ApiError) setErrors(err.fieldErrors); setError(err); } finally { setBusy(false); }
  }
  return (
    <Dialog open wide onClose={onClose} busy={busy} formRef={form} onSubmit={() => void submit()} title={`تسجيل إنتاج MO-${mo.number}`}
      footer={<><Button type="submit" variant="primary" icon={<PackageCheck />} loading={busy} loadingText="جارٍ التسجيل…">تسجيل الإنتاج</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <div className="form-grid">
        <TextField label={`الكمية الجيدة (${mo.unit})`} required numeric value={v.quantity} onChange={(e) => setV({ ...v, quantity: e.target.value })} error={errors.quantity}
          hint={`المتبقي من المخطط ${quantity(left)}. تدخل ${mo.outputLocationName} بـ ${cost(mo.standardUnitCost)} للوحدة.`} />
        <TextField label="هالك غير عادي" optional numeric value={v.scrap} onChange={(e) => setV({ ...v, scrap: e.target.value })} error={errors.scrapQuantity}
          hint="وحدات تالفة فوق المتوقع: تُحمَّل على مصروف الهالك بالتكلفة المعيارية." />
        {num(v.scrap) > 0 && <TextField label="سبب الهالك" required value={v.scrapReason} onChange={(e) => setV({ ...v, scrapReason: e.target.value })} error={errors.scrapReason} />}
        <TextField label="رقم التشغيلة" optional dir="ltr" value={v.batchNo} onChange={(e) => setV({ ...v, batchNo: e.target.value })} hint={`فارغ = MO-${mo.number}-رقم الإنتاج.`} />
        <TextField label="تاريخ الانتهاء" optional type="date" min={isoDay()} value={v.expiry} onChange={(e) => setV({ ...v, expiry: e.target.value })} error={errors.expiryDate}
          hint={mo.trackExpiry ? "الصنف يتتبع الصلاحية: فارغ = مدة صلاحيته، ولا يتجاوز أقرب انتهاء لمكوناته." : "فارغ = مدة صلاحية الصنف إن وُجدت، ولا يتجاوز أقرب انتهاء لمكوناته."} />
      </div>
      {mo.byproducts.length > 0 && q > 0 && (
        <div className="form-grid">
          {mo.byproducts.map((b) => (
            <TextField key={b.itemId} label={`${b.name} (${b.unit})`} optional numeric value={bys[b.itemId] ?? String(Math.round(b.perUnit * q * 1000) / 1000)} onChange={(e) => setBys({ ...bys, [b.itemId]: e.target.value })}
              hint="منتج ثانوي، مقترح بنسبته في القائمة." />
          ))}
        </div>
      )}
      <Checkbox label="صرف المكونات تلقائياً بنسبة هذا الإنتاج (Backflush)" checked={v.backflush} onChange={(e) => setV({ ...v, backflush: e.target.checked })} />
      <p className="field-hint pf-under-check">{nothingIssued ? "لم تُصرف مواد لهذا الأمر بعد: الصرف التلقائي يصرف ما يستهلكه هذا الإنتاج حسب الخطة." : "صُرفت مواد يدوياً: اترك الخيار مغلقاً حتى لا تُصرف مرتين."}</p>
      <FormError error={error} />
    </Dialog>
  );
}
