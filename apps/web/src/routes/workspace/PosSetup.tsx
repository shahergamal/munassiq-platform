import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Armchair, BellRing, Bike, CheckCircle2, ChefHat, ChevronLeft, Clock, Plus, Receipt, RotateCcw, ShoppingBag, Trash2, TrendingUp, Users } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError, type Page } from "../../api/client";
import type { Customer } from "../../api/types";
import { useInvalidate, useTenant } from "../../app/tenant";
import { RIYAL, addDays, day, dayTime, integer, isoDay, money, percent } from "../../lib/format";
import { Button, IconButton } from "../../ui/Button";
import { DataTable } from "../../ui/DataTable";
import { DateRange } from "../../ui/DateRange";
import { Dialog } from "../../ui/Dialog";
import { focusFirstInvalid, SearchInput, SelectField, TextAreaField, TextField } from "../../ui/Field";
import { ActionMenu, Badge, PageHeader, StatCard, StatusBadge, type Hue } from "../../ui/Layout";
import { EmptyState, ErrorState, FormError, Skeleton } from "../../ui/States";
import { CHANNEL_LABELS, ID_SCHEME_LABELS } from "../../ui/status";
import { useTablePrefs } from "../../ui/tablePrefs";
import { useToast } from "../../ui/Toast";
import { useLocations } from "./Inventory";
import { IngredientPicker } from "./pickers";

// ── Dining areas & tables ───────────────────────────────────────────────────────────────────────
const AREA_HUES: Hue[] = ["indigo", "sky", "green", "violet", "orange", "amber"];
/** Same channel colours as the dashboard: a platform order is always violet. */
const CHANNEL_HUE: Record<string, Hue> = { dine_in: "indigo", takeaway: "green", delivery: "orange" };
const channelHue = (channel: string, platformName?: string | null): Hue => (platformName ? "violet" : CHANNEL_HUE[channel] ?? "indigo");
const initials = (name: string) => name.trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join("");
/** Stable avatar colour per name, so a customer keeps the same colour across pages. */
const hueOf = (name: string): Hue => AREA_HUES[[...name].reduce((a, ch) => (a + ch.charCodeAt(0)) % 997, 0) % AREA_HUES.length]!;

interface Area { id: string; name: string; locationId: string; locationName: string; isActive: boolean; tables: { id: string; name: string; seats: number; isActive: boolean; busy: boolean }[] }

export function DiningPage() {
  const { tenantId, can, writable } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const locations = useLocations(tenantId);
  const areas = useQuery({ queryKey: ["t", tenantId, "pos", "areas", "all"], queryFn: () => api<{ items: Area[] }>("GET", "/t/dining-areas", { tenant: tenantId }) });
  const [dialog, setDialog] = useState<{ kind: "area" } | { kind: "table"; area: Area } | null>(null);
  const canCreate = can("dining.create") && writable;
  const canWrite = can("dining.edit") && writable;
  const refresh = () => invalidate("pos");
  async function toggleTable(t: Area["tables"][number]) {
    try { await api("PATCH", `/t/dining-tables/${t.id}`, { tenant: tenantId, body: { isActive: !t.isActive } }); await refresh(); }
    catch (e) { toast.error((e as Error).message); }
  }
  async function toggleArea(a: Area) {
    try { await api("PATCH", `/t/dining-areas/${a.id}`, { tenant: tenantId, body: { isActive: !a.isActive } }); await refresh(); }
    catch (e) { toast.error((e as Error).message); }
  }
  const add = canCreate && <Button variant="primary" icon={<Plus />} onClick={() => setDialog({ kind: "area" })}>إضافة صالة</Button>;
  return (
    <div className="page">
      <PageHeader eyebrow="البيانات الأساسية" title="الصالات والطاولات" description="الطاولات تُختار في الكاشير للطلبات المحلية، وتظهر «مشغولة» حتى يسلّم المطبخ الطلب." actions={add} />
      {areas.isPending ? (
        <section className="panel" aria-busy="true"><div className="card-head"><Skeleton width="30%" height={20} /></div><div className="card-body rs-dining-tables">{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={96} />)}</div></section>
      ) : areas.isError ? <section className="panel"><ErrorState error={areas.error} onRetry={() => areas.refetch()} /></section>
        : areas.data.items.length === 0 ? <section className="panel"><EmptyState title="لا توجد صالات بعد" action={add || undefined}>أضف صالة لكل موقع (مثل: الصالة الرئيسية، العائلات، الجلسات الخارجية) ثم طاولاتها.</EmptyState></section>
        : areas.data.items.map((a, ai) => (
          <section key={a.id} className="panel" aria-label={a.name}>
            <div className="card-head">
              <span className={`stat-icon rs-dining-area-icon tone-${AREA_HUES[ai % AREA_HUES.length]}`} aria-hidden="true"><Armchair /></span>
              <div className="rs-dining-area-title">
                <h2 className="row">{a.name}{!a.isActive && <Badge>موقوفة</Badge>}</h2>
                <span className="muted">{a.locationName} · {integer(a.tables.length)} طاولة</span>
              </div>
              <span className="spacer" />
              {canCreate && <Button size="sm" icon={<Plus />} onClick={() => setDialog({ kind: "table", area: a })}>إضافة طاولة</Button>}
              {canWrite && <ActionMenu label={`إجراءات ${a.name}`} items={[{ label: a.isActive ? "إيقاف الصالة" : "تفعيل الصالة", onSelect: () => void toggleArea(a) }]} />}
            </div>
            <div className="card-body">
              {a.tables.length === 0 ? <p className="muted">لا توجد طاولات في هذه الصالة.</p> : (
                <ul className="rs-dining-tables" aria-label={`طاولات ${a.name}`}>
                  {a.tables.map((t) => (
                    <li key={t.id} className={["rs-dining-table", !t.isActive && "is-off", t.isActive && t.busy && "is-busy"].filter(Boolean).join(" ")}>
                      <span className="rs-dining-table-head">
                        <strong>{t.name}</strong>
                        <Badge tone={!t.isActive ? "neutral" : t.busy ? "warning" : "success"}>{!t.isActive ? "موقوفة" : t.busy ? "مشغولة" : "متاحة"}</Badge>
                      </span>
                      <span className="muted rs-dining-seats"><Users aria-hidden="true" /><span className="num">{integer(t.seats)}</span> مقاعد</span>
                      {canWrite && <Button size="sm" variant="ghost" onClick={() => void toggleTable(t)} aria-label={`${t.isActive ? "إيقاف" : "تفعيل"} الطاولة ${t.name}`}>{t.isActive ? "إيقاف" : "تفعيل"}</Button>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        ))}
      {dialog?.kind === "area" && <SimpleForm title="إضافة صالة" submitLabel="حفظ الصالة" onClose={() => setDialog(null)}
        fields={[{ name: "name", label: "اسم الصالة", required: true }, { name: "locationId", label: "الموقع", required: true, options: (locations.data?.items ?? []).map((l) => ({ value: l.id, label: l.name })) }]}
        submit={async (v) => { await api("POST", "/t/dining-areas", { tenant: tenantId, body: { name: v.name, locationId: v.locationId } }); await refresh(); toast.success(`تمت إضافة «${v.name}»`); }} />}
      {dialog?.kind === "table" && <SimpleForm title={`طاولة في ${dialog.area.name}`} submitLabel="حفظ الطاولة" onClose={() => setDialog(null)} initial={{ seats: "4" }}
        fields={[{ name: "name", label: "اسم أو رقم الطاولة", required: true }, { name: "seats", label: "عدد المقاعد", required: true, numeric: true }]}
        submit={async (v) => { await api("POST", "/t/dining-tables", { tenant: tenantId, body: { areaId: dialog.area.id, name: v.name, seats: Number(v.seats) || 4 } }); await refresh(); toast.success(`تمت إضافة الطاولة ${v.name}`); }} />}
    </div>
  );
}

interface SimpleField { name: string; label: string; required?: boolean; numeric?: boolean; options?: { value: string; label: string }[]; hint?: string; ltr?: boolean }

/** Small create/edit dialog for 2–4 plain fields. Keeps inputs on server error and maps field errors. */
function SimpleForm({ title, submitLabel, fields, initial = {}, submit, onClose }: { title: string; submitLabel: string; fields: SimpleField[]; initial?: Record<string, string>; submit: (v: Record<string, string>) => Promise<void>; onClose: () => void }) {
  const form = useRef<HTMLFormElement>(null);
  const [v, setV] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.name, initial[f.name] ?? ""])));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function go() {
    const e: Record<string, string> = {};
    for (const f of fields) if (f.required && !v[f.name]?.trim()) e[f.name] = `أدخل ${f.label}`;
    setErrors(e);
    if (Object.keys(e).length) return focusFirstInvalid(form.current);
    setBusy(true); setError(null);
    try { await submit(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x.trim()]))); onClose(); }
    catch (err) { if (err instanceof ApiError) setErrors(err.fieldErrors); setError(err instanceof ApiError && err.code === "duplicate" ? "الاسم مستخدم مسبقاً. اختر اسماً مختلفاً" : err); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} title={title} formRef={form} onSubmit={() => void go()}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">{submitLabel}</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      {fields.map((f) => f.options
        ? <SelectField key={f.name} label={f.label} required={f.required} placeholder="اختر" value={v[f.name]} onChange={(e) => setV({ ...v, [f.name]: e.target.value })} options={f.options} error={errors[f.name]} hint={f.hint} />
        : <TextField key={f.name} label={f.label} required={f.required} optional={!f.required} numeric={f.numeric} dir={f.ltr ? "ltr" : undefined} value={v[f.name]} onChange={(e) => setV({ ...v, [f.name]: e.target.value })} error={errors[f.name]} hint={f.hint} />)}
      <FormError error={error} />
    </Dialog>
  );
}

// ── Modifier groups ─────────────────────────────────────────────────────────────────────────────
interface ModOption { id?: string; name: string; priceNet: number; ingredientId: string | null; ingredientName?: string | null; unit?: string | null; ingredientQty: number | null; isActive: boolean }
interface ModGroup { id: string; name: string; minSelect: number; maxSelect: number; isActive: boolean; recipesCount: number; options: ModOption[] }

export function ModifiersPage() {
  const { tenantId, can, writable } = useTenant();
  const groups = useQuery({ queryKey: ["t", tenantId, "modifiers"], queryFn: () => api<{ items: ModGroup[] }>("GET", "/t/modifier-groups", { tenant: tenantId }) });
  const [editing, setEditing] = useState<ModGroup | "new" | null>(null);
  const canWrite = can("modifiers.edit") && writable;
  const add = can("modifiers.create") && writable && <Button variant="primary" icon={<Plus />} onClick={() => setEditing("new")}>مجموعة إضافات جديدة</Button>;
  return (
    <div className="page">
      <PageHeader eyebrow="الوصفات" title="الإضافات والخيارات" description="مثل: الحجم (اختيار واحد إلزامي)، إضافات (حتى 3). السعر يضاف لسعر الصنف، والمادة المرتبطة تُخصم من المخزون عند البيع. اربط المجموعة بالأصناف من محرر الوصفة." actions={add} />
      <section className="panel">
        <DataTable caption="مجموعات الإضافات" query={groups} rowKey={(g) => g.id} onRowClick={canWrite ? (g) => setEditing(g) : undefined}
          empty={{ title: "لا توجد مجموعات إضافات", body: "أنشئ مجموعة مثل «الحجم» أو «إضافات» ثم اربطها بالأصناف.", action: add || undefined }}
          columns={[
            { key: "n", sortKey: "name", header: "المجموعة", cell: (g) => <strong>{g.name}</strong> },
            { key: "r", sortKey: false, header: "القاعدة", cell: (g) => (g.minSelect === g.maxSelect ? `اختيار ${integer(g.minSelect)} إلزامي` : g.minSelect > 0 ? `من ${integer(g.minSelect)} إلى ${integer(g.maxSelect)}` : `اختياري حتى ${integer(g.maxSelect)}`) },
            { key: "o", sortKey: false, header: "الخيارات", wrap: true, cell: (g) => g.options.filter((o) => o.isActive).map((o) => (o.priceNet ? `${o.name} (+${money(o.priceNet)})` : o.name)).join("، ") },
            { key: "c", sortKey: "recipesCount", header: "أصناف مرتبطة", numeric: true, cell: (g) => integer(g.recipesCount) },
            { key: "s", sortKey: "isActive", header: "الحالة", cell: (g) => <StatusBadge kind="active" value={g.isActive} /> },
          ]} />
      </section>
      {editing && <ModifierGroupDialog tenantId={tenantId} group={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function ModifierGroupDialog({ tenantId, group, onClose }: { tenantId: string; group: ModGroup | null; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const form = useRef<HTMLFormElement>(null);
  const [v, setV] = useState({ name: group?.name ?? "", minSelect: String(group?.minSelect ?? 0), maxSelect: String(group?.maxSelect ?? 1), isActive: group?.isActive ?? true });
  const [options, setOptions] = useState<(ModOption & { price: string; qty: string })[]>(
    (group?.options ?? [{ name: "", priceNet: 0, ingredientId: null, ingredientQty: null, isActive: true }]).map((o) => ({ ...o, price: String(o.priceNet), qty: o.ingredientQty === null ? "" : String(o.ingredientQty) })));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const patch = (i: number, p: Partial<(typeof options)[number]>) => setOptions((os) => os.map((o, n) => (n === i ? { ...o, ...p } : o)));
  async function save() {
    const e: Record<string, string> = {};
    if (v.name.trim().length < 2) e.name = "أدخل اسم المجموعة، مثل: الحجم";
    const min = Number(v.minSelect); const max = Number(v.maxSelect);
    if (!(Number.isInteger(min) && min >= 0)) e.minSelect = "رقم صحيح من 0";
    if (!(Number.isInteger(max) && max >= 1)) e.maxSelect = "رقم صحيح من 1";
    else if (min > max) e.minSelect = "الحد الأدنى أكبر من الأقصى";
    const active = options.filter((o) => o.isActive);
    if (!active.length) e.options = "أضف خياراً نشطاً واحداً على الأقل";
    else if (max > active.length) e.maxSelect = `لا يمكن أن يتجاوز عدد الخيارات النشطة (${active.length})`;
    options.forEach((o, i) => {
      if (!o.name.trim()) e[`n${i}`] = "اسم الخيار";
      if (!(Number(o.price) >= 0)) e[`p${i}`] = "0 أو أكثر";
      if (o.ingredientId && !(Number(o.qty) > 0)) e[`q${i}`] = "كمية المادة";
    });
    setErrors(e);
    if (Object.keys(e).length) return focusFirstInvalid(form.current);
    setBusy(true); setError(null);
    const body = { name: v.name.trim(), minSelect: min, maxSelect: max, isActive: v.isActive,
      options: options.map((o) => ({ ...(o.id ? { id: o.id } : {}), name: o.name.trim(), priceNet: Number(o.price), ingredientId: o.ingredientId, ingredientQty: o.ingredientId ? Number(o.qty) : null, isActive: o.isActive })) };
    try {
      if (group) await api("PUT", `/t/modifier-groups/${group.id}`, { tenant: tenantId, body });
      else await api("POST", "/t/modifier-groups", { tenant: tenantId, body });
      toast.success(`تم حفظ «${body.name}»`);
      await invalidate("modifiers", "pos");
      onClose();
    } catch (err) { if (err instanceof ApiError) setErrors(err.fieldErrors); setError(err instanceof ApiError && err.code === "duplicate" ? "يوجد مجموعة بهذا الاسم" : err); } finally { setBusy(false); }
  }
  return (
    <Dialog open wide onClose={onClose} busy={busy} formRef={form} onSubmit={() => void save()} title={group ? `تعديل «${group.name}»` : "مجموعة إضافات جديدة"}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">حفظ المجموعة</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <div className="form-grid">
        <TextField label="اسم المجموعة" required value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} error={errors.name} />
        <TextField label="أقل عدد اختيارات" required numeric value={v.minSelect} onChange={(e) => setV({ ...v, minSelect: e.target.value })} error={errors.minSelect} hint="0 = اختيارية" />
        <TextField label="أقصى عدد اختيارات" required numeric value={v.maxSelect} onChange={(e) => setV({ ...v, maxSelect: e.target.value })} error={errors.maxSelect} hint="1 = اختيار واحد" />
      </div>
      <label className="checkbox"><input type="checkbox" checked={v.isActive} onChange={(e) => setV({ ...v, isActive: e.target.checked })} />نشطة في الكاشير</label>
      <div className="stack">
        <h3>الخيارات</h3>
        {errors.options && <span className="field-error" role="alert">{errors.options}</span>}
        {options.map((o, i) => (
          <div key={o.id ?? `new-${i}`} className={["rs-mod-option", !o.isActive && "is-off"].filter(Boolean).join(" ")}>
            <div className="form-grid">
              <TextField label="الخيار" required value={o.name} onChange={(e) => patch(i, { name: e.target.value })} error={errors[`n${i}`]} />
              <TextField label={`السعر الإضافي قبل الضريبة (${RIYAL})`} numeric value={o.price} onChange={(e) => patch(i, { price: e.target.value })} error={errors[`p${i}`]} />
            </div>
            {o.ingredientId ? (
              <div className="row rs-mod-option-stock">
                <span className="badge badge-info">يخصم: {o.ingredientName}</span>
                <TextField label={`الكمية${o.unit ? ` (${o.unit})` : ""}`} required numeric value={o.qty} onChange={(e) => patch(i, { qty: e.target.value })} error={errors[`q${i}`]} />
                <Button size="sm" variant="ghost" onClick={() => patch(i, { ingredientId: null, ingredientName: null, qty: "" })}>بدون خصم مخزون</Button>
              </div>
            ) : (
              <div className="rs-mod-option-picker"><IngredientPicker tenantId={tenantId} label="يخصم من المخزون (اختياري)" onPick={(ing) => patch(i, { ingredientId: ing.id, ingredientName: ing.name, unit: ing.baseUnit })} /></div>
            )}
            <div className="row">
              {o.id
                ? <label className="checkbox"><input type="checkbox" checked={o.isActive} onChange={(e) => patch(i, { isActive: e.target.checked })} />نشط</label>
                : <IconButton size="sm" destructive label={`حذف الخيار ${o.name}`} icon={<Trash2 />} onClick={() => setOptions((os) => os.filter((_, n) => n !== i))} />}
            </div>
          </div>
        ))}
        <div><Button icon={<Plus />} onClick={() => setOptions((os) => [...os, { name: "", priceNet: 0, price: "0", ingredientId: null, ingredientQty: null, qty: "", isActive: true }])}>إضافة خيار</Button></div>
        <p className="muted" style={{ fontSize: "var(--fs-xs)" }}>الخيار المحفوظ لا يُحذف لأن الطلبات السابقة تشير إليه. أوقفه بدلاً من ذلك.</p>
      </div>
      <FormError error={error} />
    </Dialog>
  );
}

/** Used in the recipe editor: which modifier groups this menu item offers. */
export function RecipeModifiers({ tenantId, recipeId, canWrite }: { tenantId: string; recipeId: string; canWrite: boolean }) {
  const toast = useToast();
  const groups = useQuery({ queryKey: ["t", tenantId, "modifiers"], queryFn: () => api<{ items: ModGroup[] }>("GET", "/t/modifier-groups", { tenant: tenantId }) });
  const linked = useQuery({ queryKey: ["t", tenantId, "modifiers", "recipe", recipeId], queryFn: () => api<{ groupIds: string[] }>("GET", `/t/recipes/${recipeId}/modifier-groups`, { tenant: tenantId }) });
  const invalidate = useInvalidate(tenantId);
  const [sel, setSel] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (linked.data && sel === null) setSel(linked.data.groupIds); }, [linked.data, sel]);
  const dirty = sel !== null && linked.data && JSON.stringify(sel) !== JSON.stringify(linked.data.groupIds);
  async function save() {
    setBusy(true);
    try { await api("PUT", `/t/recipes/${recipeId}/modifier-groups`, { tenant: tenantId, body: { groupIds: sel } }); toast.success("تم حفظ إضافات الصنف"); await invalidate("modifiers", "pos"); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  const active = (groups.data?.items ?? []).filter((g) => g.isActive);
  return (
    <section className="panel" aria-labelledby="rm-h">
      <div className="card-head"><h2 id="rm-h">الإضافات في الكاشير</h2><span className="spacer" /><Link to={`/w/${tenantId}/modifiers`} className="btn btn-ghost btn-sm">إدارة المجموعات<ChevronLeft aria-hidden="true" /></Link></div>
      <div className="card-body stack">
        {groups.isPending || linked.isPending ? <div className="stack">{[0, 1].map((i) => <Skeleton key={i} height={38} />)}</div>
          : groups.isError ? <ErrorState error={groups.error} onRetry={() => groups.refetch()} />
          : linked.isError ? <ErrorState error={linked.error} onRetry={() => linked.refetch()} />
          : active.length === 0 ? <p className="muted">لا توجد مجموعات إضافات. أنشئها من «الإضافات والخيارات».</p>
          : <>
            {active.map((g) => (
              <label key={g.id} className="checkbox rs-mod-link">
                <input type="checkbox" disabled={!canWrite} checked={sel?.includes(g.id) ?? false} onChange={(e) => setSel((s) => (e.target.checked ? [...(s ?? []), g.id] : (s ?? []).filter((x) => x !== g.id)))} />
                <span className="rs-mod-link-text"><strong>{g.name}</strong><span className="muted">{g.options.filter((o) => o.isActive).map((o) => o.name).join("، ")}</span></span>
              </label>
            ))}
            {canWrite && <div><Button onClick={() => void save()} disabled={!dirty} loading={busy} loadingText="جارٍ الحفظ…">{dirty ? "حفظ الإضافات" : "محفوظة"}</Button></div>}
          </>}
      </div>
    </section>
  );
}

// ── Delivery platforms ──────────────────────────────────────────────────────────────────────────
interface Platform { id: string; name: string; commissionPercent: number; isActive: boolean; ordersCount: number }

export function PlatformsPage() {
  const { tenantId, can, writable } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const list = useQuery({ queryKey: ["t", tenantId, "pos", "platforms"], queryFn: () => api<{ items: Platform[] }>("GET", "/t/delivery-platforms", { tenant: tenantId }) });
  const [editing, setEditing] = useState<Platform | "new" | null>(null);
  const canWrite = can("platforms.edit") && writable;
  const add = can("platforms.create") && writable && <Button variant="primary" icon={<Plus />} onClick={() => setEditing("new")}>إضافة تطبيق</Button>;
  async function toggle(p: Platform) {
    try { await api("PATCH", `/t/delivery-platforms/${p.id}`, { tenant: tenantId, body: { isActive: !p.isActive } }); await invalidate("pos"); }
    catch (e) { toast.error((e as Error).message); }
  }
  return (
    <div className="page">
      <PageHeader eyebrow="البيانات الأساسية" title="تطبيقات التوصيل" description="هنقرستيشن وجاهز ومرسول وغيرها. العمولة تُحسب من صافي كل طلب في الخادم، وتظهر في «المبيعات حسب القناة»." actions={add} />
      <section className="panel">
        <DataTable caption="تطبيقات التوصيل" query={list} rowKey={(p) => p.id} onRowClick={canWrite ? (p) => setEditing(p) : undefined}
          empty={{ title: "لا توجد تطبيقات توصيل", body: "أضف التطبيقات التي تستقبل منها الطلبات مع نسبة عمولتها.", action: add || undefined }}
          columns={[
            { key: "n", sortKey: "name", header: "التطبيق", cell: (p) => <span className="tag tag-violet">{p.name}</span> },
            { key: "c", sortKey: "commissionPercent", header: "العمولة", numeric: true, cell: (p) => percent(p.commissionPercent) },
            { key: "o", sortKey: "ordersCount", header: "الطلبات", numeric: true, cell: (p) => integer(p.ordersCount) },
            { key: "s", sortKey: "isActive", header: "الحالة", cell: (p) => <StatusBadge kind="active" value={p.isActive} /> },
          ]}
          actions={canWrite ? (p) => <ActionMenu label={`إجراءات ${p.name}`} items={[{ label: "تعديل", onSelect: () => setEditing(p) }, { label: p.isActive ? "إيقاف" : "تفعيل", onSelect: () => void toggle(p) }]} /> : undefined} />
      </section>
      {editing && <SimpleForm title={editing === "new" ? "إضافة تطبيق توصيل" : `تعديل ${editing.name}`} submitLabel="حفظ" onClose={() => setEditing(null)}
        initial={editing === "new" ? {} : { name: editing.name, commission: String(editing.commissionPercent) }}
        fields={[{ name: "name", label: "اسم التطبيق", required: true }, { name: "commission", label: "نسبة العمولة ٪", required: true, numeric: true, hint: "من صافي الطلب قبل الضريبة." }]}
        submit={async (v) => {
          const body = { name: v.name, commissionPercent: Number(v.commission) };
          if (editing === "new") await api("POST", "/t/delivery-platforms", { tenant: tenantId, body });
          else await api("PATCH", `/t/delivery-platforms/${editing.id}`, { tenant: tenantId, body });
          await invalidate("pos"); toast.success(`تم حفظ ${v.name}`);
        }} />}
    </div>
  );
}

// ── Customers ───────────────────────────────────────────────────────────────────────────────────

export function CustomersPage() {
  const { tenantId, can, writable, factory } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(1);
  const prefs = useTablePrefs("customers", { server: true, onSortChange: () => setPage(1) });
  const [editing, setEditing] = useState<Customer | "new" | null>(null);
  const [history, setHistory] = useState<Customer | null>(null);
  useEffect(() => { const t = setTimeout(() => { setDebounced(q.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);
  const list = useQuery({ queryKey: ["t", tenantId, "customers", { q: debounced, page, sort: prefs.sortParam }], queryFn: () => api<Page<Customer>>("GET", "/t/customers", { tenant: tenantId, query: { q: debounced, page, pageSize: 25, sort: prefs.sortParam } }), placeholderData: keepPreviousData });
  const canWrite = can("customers.edit") && writable;
  const add = can("customers.create") && writable && <Button variant="primary" icon={<Plus />} onClick={() => setEditing("new")}>إضافة عميل</Button>;
  return (
    <div className="page">
      <PageHeader eyebrow="المبيعات" title="العملاء" description="العميل يُعرَّف بجواله، ويُربط بالطلب من الكاشير. يظهر هنا عدد طلباته وإنفاقه." actions={add} />
      <section className="panel">
        <DataTable caption="العملاء" prefs={prefs} toolbar={<SearchInput placeholder="ابحث بالاسم أو الجوال" value={q} onChange={setQ} />}
          query={list} rowKey={(c) => c.id} onPageChange={setPage} filtered={Boolean(debounced)} onClearFilters={() => setQ("")}
          onRowClick={(c) => setHistory(c)}
          empty={{ title: "لا يوجد عملاء بعد", body: "يُضاف العميل من الكاشير عند ربطه بطلب، أو من هنا.", action: add || undefined }}
          columns={[
            { key: "n", sortKey: "name", header: "العميل", cell: (c) => <span className="rs-customer-cell"><span className={`avatar tone-${hueOf(c.name)}`} aria-hidden="true">{initials(c.name)}</span><strong>{c.name}</strong></span> },
            { key: "p", sortKey: "phone", header: "الجوال", cell: (c) => <span dir="ltr">{c.phone}</span> },
            { key: "o", sortKey: "ordersCount", header: "الطلبات", numeric: true, cell: (c) => integer(c.ordersCount) },
            { key: "t", sortKey: "totalSpent", header: "إجمالي الإنفاق", numeric: true, cell: (c) => money(c.totalSpent) },
            { key: "l", sortKey: "lastOrderAt", header: "آخر طلب", cell: (c) => dayTime(c.lastOrderAt) },
          ]}
          actions={canWrite ? (c) => <ActionMenu label={`إجراءات ${c.name}`} items={[{ label: "الطلبات", onSelect: () => setHistory(c) }, { label: "تعديل", onSelect: () => setEditing(c) }]} /> : undefined} />
      </section>
      {editing && <CustomerForm tenantId={tenantId} factory={factory} customer={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={async (n) => { toast.success(`تم حفظ ${n}`); await invalidate("customers"); }} />}
      {history && <CustomerHistory tenantId={tenantId} customer={history} onClose={() => setHistory(null)} />}
    </div>
  );
}

/** Business fields kept as strings for the inputs; "" is sent as null (clears the field). */
const B2B_KEYS = ["vatNumber", "otherIdScheme", "otherId", "street", "buildingNo", "additionalNo", "district", "city", "postalCode"] as const;

/**
 * Add / edit a customer. The tax block (buyer of a standard B2B invoice) appears only for a business customer.
 * Exported for the invoice page, which opens it when the server says the buyer data is incomplete.
 */
export function CustomerForm({ tenantId, customer, onClose, onSaved, notice, business, factory = false }: {
  tenantId: string; customer: Customer | null; onClose: () => void; onSaved: (name: string) => void;
  /** Why the dialog was opened (e.g. the fields a tax invoice still needs). */
  notice?: ReactNode;
  /** Open with "منشأة" selected. */
  business?: boolean;
  /** A factory sells on account: the customer's credit limit is edited here. */
  factory?: boolean;
}) {
  const form = useRef<HTMLFormElement>(null);
  const [v, setV] = useState(() => ({
    creditLimit: customer?.creditLimit != null ? String(customer.creditLimit) : "", priceListId: customer?.priceListId ?? "",
    name: customer?.name ?? "", phone: customer?.phone ?? "", email: customer?.email ?? "", address: customer?.address ?? "", notes: customer?.notes ?? "",
    customerType: business ? "business" : customer?.customerType ?? "individual",
    ...(Object.fromEntries(B2B_KEYS.map((k) => [k, customer?.[k] ?? ""])) as Record<(typeof B2B_KEYS)[number], string>),
    countryCode: customer?.countryCode ?? "SA", paymentTermsDays: String(customer?.paymentTermsDays ?? 0),
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const isBusiness = v.customerType === "business";
  const set = (patch: Partial<typeof v>) => setV({ ...v, ...patch });
  async function save() {
    const e: Record<string, string> = {};
    if (v.name.trim().length < 2) e.name = "أدخل اسم العميل";
    if (!/^\+?[0-9]{9,15}$/.test(v.phone.trim())) e.phone = "الجوال أرقام فقط، مثل 0501234567";
    if (isBusiness) {
      if (v.vatNumber.trim() && !/^3[0-9]{13}3$/.test(v.vatNumber.trim())) e.vatNumber = "الرقم الضريبي 15 رقماً يبدأ وينتهي بـ 3";
      if (v.otherId.trim() && !v.otherIdScheme) e.otherIdScheme = "اختر نوع رقم التعريف";
      if (v.buildingNo.trim() && !/^[0-9]{4}$/.test(v.buildingNo.trim())) e.buildingNo = "رقم المبنى 4 أرقام";
      if (v.additionalNo.trim() && !/^[0-9]{4}$/.test(v.additionalNo.trim())) e.additionalNo = "الرقم الإضافي 4 أرقام";
      if (v.postalCode.trim() && !/^[0-9]{5}$/.test(v.postalCode.trim())) e.postalCode = "الرمز البريدي 5 أرقام";
      if (!/^[A-Za-z]{2}$/.test(v.countryCode.trim())) e.countryCode = "رمز الدولة حرفان، مثل SA";
      if (!/^[0-9]{1,3}$/.test(v.paymentTermsDays.trim()) || Number(v.paymentTermsDays) > 365) e.paymentTermsDays = "عدد أيام من 0 إلى 365";
    }
    if (v.creditLimit.trim() && !(Number(v.creditLimit.replace(/,/g, "")) >= 0)) e.creditLimit = "مبلغ صفر أو أكثر، أو اتركه فارغاً";
    setErrors(e);
    if (Object.keys(e).length) return focusFirstInvalid(form.current);
    setBusy(true); setError(null);
    // Switching back to "فرد" keeps the business data saved before; only the type changes.
    const b2b = isBusiness ? {
      ...Object.fromEntries(B2B_KEYS.map((k) => [k, v[k].trim() || null])),
      countryCode: v.countryCode.trim().toUpperCase(), paymentTermsDays: Number(v.paymentTermsDays),
    } : {};
    const body = { name: v.name.trim(), phone: v.phone.trim(), email: v.email.trim() || null, address: v.address.trim() || null, notes: v.notes.trim() || null, customerType: v.customerType, ...b2b,
      ...(factory ? { creditLimit: v.creditLimit.trim() ? Number(v.creditLimit.replace(/,/g, "")) : null, priceListId: v.priceListId || null } : {}) };
    try {
      if (customer) await api("PATCH", `/t/customers/${customer.id}`, { tenant: tenantId, body });
      else await api("POST", "/t/customers", { tenant: tenantId, body });
      onSaved(body.name); onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === "customer_exists") setErrors({ phone: err.message });
      else if (err instanceof ApiError) setErrors(err.fieldErrors);
      setError(err);
    } finally { setBusy(false); }
  }
  return (
    <Dialog open wide={isBusiness} onClose={onClose} busy={busy} formRef={form} onSubmit={() => void save()} title={customer ? `تعديل ${customer.name}` : "إضافة عميل"}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">حفظ العميل</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      {notice && <p className="banner banner-warning rs-banner">{notice}</p>}
      <div className="form-grid">
        <TextField label="الاسم" required value={v.name} onChange={(e) => set({ name: e.target.value })} error={errors.name} hint={isBusiness ? "الاسم النظامي كما في السجل التجاري؛ يظهر في الفاتورة." : undefined} />
        <TextField label="الجوال" required type="tel" dir="ltr" inputMode="tel" value={v.phone} onChange={(e) => set({ phone: e.target.value })} error={errors.phone} />
        <TextField label="البريد" optional type="email" dir="ltr" value={v.email} onChange={(e) => set({ email: e.target.value })} error={errors.email} />
      </div>
      <fieldset className="rs-type-choice">
        <legend className="field-label">نوع العميل</legend>
        <div className="segmented rs-segmented" role="group" aria-label="نوع العميل">
          <button type="button" aria-pressed={!isBusiness} onClick={() => set({ customerType: "individual" })}>فرد</button>
          <button type="button" aria-pressed={isBusiness} onClick={() => set({ customerType: "business" })}>منشأة</button>
        </div>
        <span className="field-hint">المنشأة تحتاج رقماً ضريبياً وعنواناً وطنياً لتصدر لها فاتورة ضريبية (بين المنشآت).</span>
      </fieldset>
      {isBusiness && (
        <section className="form-section rs-b2b" aria-labelledby="cust-b2b">
          <h3 id="cust-b2b">البيانات الضريبية للعميل (للفواتير بين المنشآت)</h3>
          <div className="form-grid">
            <TextField label="الرقم الضريبي" optional dir="ltr" inputMode="numeric" maxLength={15} value={v.vatNumber} onChange={(e) => set({ vatNumber: e.target.value })} error={errors.vatNumber} hint="15 رقماً يبدأ وينتهي بـ 3. إن لم يكن مسجلاً فأدخل رقم تعريف آخر." />
            <SelectField label="نوع رقم التعريف الآخر" optional placeholder="بدون" value={v.otherIdScheme} onChange={(e) => set({ otherIdScheme: e.target.value })} error={errors.otherIdScheme}
              options={Object.entries(ID_SCHEME_LABELS).map(([value, label]) => ({ value, label }))} />
            <TextField label="رقم التعريف" optional dir="ltr" value={v.otherId} onChange={(e) => set({ otherId: e.target.value })} error={errors.otherId} hint="مثل رقم السجل التجاري." />
          </div>
          <h4 className="rs-b2b-sub">العنوان الوطني</h4>
          <div className="form-grid">
            <TextField label="الشارع" optional value={v.street} onChange={(e) => set({ street: e.target.value })} error={errors.street} />
            <TextField label="رقم المبنى" optional dir="ltr" inputMode="numeric" maxLength={4} value={v.buildingNo} onChange={(e) => set({ buildingNo: e.target.value })} error={errors.buildingNo} hint="4 أرقام" />
            <TextField label="الرقم الإضافي" optional dir="ltr" inputMode="numeric" maxLength={4} value={v.additionalNo} onChange={(e) => set({ additionalNo: e.target.value })} error={errors.additionalNo} hint="4 أرقام" />
            <TextField label="الحي" optional value={v.district} onChange={(e) => set({ district: e.target.value })} error={errors.district} />
            <TextField label="المدينة" optional value={v.city} onChange={(e) => set({ city: e.target.value })} error={errors.city} />
            <TextField label="الرمز البريدي" optional dir="ltr" inputMode="numeric" maxLength={5} value={v.postalCode} onChange={(e) => set({ postalCode: e.target.value })} error={errors.postalCode} hint="5 أرقام" />
            <TextField label="رمز الدولة" required dir="ltr" maxLength={2} value={v.countryCode} onChange={(e) => set({ countryCode: e.target.value })} error={errors.countryCode} hint="SA للسعودية. العميل خارج المملكة لا يحتاج عنواناً وطنياً." />
            <TextField label="مدة السداد (يوم)" required numeric inputMode="numeric" value={v.paymentTermsDays} onChange={(e) => set({ paymentTermsDays: e.target.value })} error={errors.paymentTermsDays} hint="تحدد تاريخ استحقاق الفواتير الآجلة. 0 = مستحقة فوراً." />
          </div>
          <p className="muted rs-b2b-note">الفاتورة الضريبية تحتاج: الرقم الضريبي أو رقم تعريف آخر، والشارع ورقم المبنى والحي والمدينة والرمز البريدي (للعميل داخل المملكة).</p>
        </section>
      )}
      {factory && (
        <TextField label={`حد الائتمان (${RIYAL})`} optional numeric value={v.creditLimit} onChange={(e) => set({ creditLimit: e.target.value })} error={errors.creditLimit}
          hint="لا يُؤكَّد أمر بيع يجعل المستحق عليه مع أوامره المفتوحة أكبر من هذا. فارغ = بلا حد." />
      )}
      {factory && <PriceListField tenantId={tenantId} value={v.priceListId} onChange={(priceListId) => set({ priceListId })} />}
      <TextField label="العنوان" optional value={v.address} onChange={(e) => set({ address: e.target.value })} hint={factory ? "عنوان التسليم." : "لطلبات التوصيل الخاص."} />
      <TextAreaField label="ملاحظات" optional rows={2} value={v.notes} onChange={(e) => set({ notes: e.target.value })} hint="مثل: حساسية من المكسرات." />
      <FormError error={error} />
    </Dialog>
  );
}

function CustomerHistory({ tenantId, customer, onClose }: { tenantId: string; customer: Customer; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const prefs = useTablePrefs("customer-orders", { server: true, onSortChange: () => setPage(1) });
  const orders = useQuery({ queryKey: ["t", tenantId, "customers", customer.id, "orders", { page, sort: prefs.sortParam }], placeholderData: keepPreviousData,
    queryFn: () => api<Page<{ id: string; number: number; channel: string; status: string; total: number; createdAt: string }>>("GET", `/t/customers/${customer.id}/orders`, { tenant: tenantId, query: { page, pageSize: 50, sort: prefs.sortParam } }) });
  return (
    <Dialog open wide onClose={onClose} title={`${customer.name} · ${customer.phone}`} footer={<Button onClick={onClose}>إغلاق</Button>}>
      {customer.notes && <p className="banner banner-warning rs-banner">{customer.notes}</p>}
      <DataTable caption="طلبات العميل" prefs={prefs} query={orders} rowKey={(o) => o.id} onPageChange={setPage} empty={{ title: "لا توجد طلبات", body: "" }}
        columns={[
          { key: "n", sortKey: "number", header: "رقم الطلب", cell: (o) => <Link to={`/w/${tenantId}/orders/${o.id}`} className="num">{o.number}</Link> },
          { key: "d", sortKey: "createdAt", header: "الوقت", cell: (o) => dayTime(o.createdAt) },
          { key: "c", sortKey: "channel", header: "النوع", cell: (o) => <span className={`tag tag-${channelHue(o.channel)}`}>{CHANNEL_LABELS[o.channel] ?? o.channel}</span> },
          { key: "t", sortKey: "total", header: "الإجمالي", numeric: true, cell: (o) => money(o.total) },
          { key: "s", sortKey: "status", header: "الحالة", cell: (o) => <StatusBadge kind="order" value={o.status} /> },
        ]} />
    </Dialog>
  );
}

// ── Kitchen display ─────────────────────────────────────────────────────────────────────────────
/** A kitchen ticket: a paid order, or one round of an open order sent before payment (additions and cancellations are rounds too). */
interface Ticket {
  id: string; status: "new" | "preparing" | "ready" | "served"; createdAt: string; orderNumber: number | null; ticketNumber: number | null; ticketLabel: string | null; round: number;
  channel: string; notes: string | null; customerName: string | null; tableName: string | null; platformName: string | null; externalRef: string | null;
  items: { name: string; quantity: number; modifiers: string[]; note?: string | null }[];
}
const kdsRef = (t: Ticket) => (t.orderNumber ? `#${t.orderNumber}` : `T-${t.ticketNumber}`);
const KDS_LOC = (t: string) => `mn.kds.location.${t}`;

export function KitchenPage() {
  const { tenantId } = useTenant();
  const locations = useLocations(tenantId);
  const toast = useToast();
  const [loc, setLoc] = useState(() => { try { return localStorage.getItem(KDS_LOC(tenantId)) ?? ""; } catch { return ""; } });
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { const l = locations.data?.items; if (l?.length && !l.some((x) => x.id === loc)) setLoc((l.find((x) => x.locationType === "kitchen") ?? l[0]!).id); }, [locations.data, loc]);
  useEffect(() => { try { if (loc) localStorage.setItem(KDS_LOC(tenantId), loc); } catch { /* ignore */ } }, [loc, tenantId]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t); }, []);
  const board = useQuery({ enabled: Boolean(loc), queryKey: ["t", tenantId, "pos", "kds", loc], queryFn: () => api<{ items: Ticket[] }>("GET", "/t/kds", { tenant: tenantId, query: { locationId: loc } }), refetchInterval: 8_000 });
  async function move(t: Ticket, status: string) {
    setBusy(t.id);
    try { await api("POST", `/t/kds/${t.id}/status`, { tenant: tenantId, body: { status } }); await board.refetch(); }
    catch (e) { toast.error((e as Error).message); await board.refetch(); } finally { setBusy(null); }
  }
  const cols: { key: Ticket["status"]; title: string; next: string; action: string; hue: Hue; icon: ReactNode }[] = [
    { key: "new", title: "جديدة", next: "preparing", action: "بدء التحضير", hue: "sky", icon: <BellRing /> },
    { key: "preparing", title: "قيد التحضير", next: "ready", action: "جاهز", hue: "amber", icon: <ChefHat /> },
    { key: "ready", title: "جاهزة للتسليم", next: "served", action: "تم التسليم", hue: "green", icon: <CheckCircle2 /> },
  ];
  const tickets = board.data?.items ?? [];
  const served = tickets.filter((t) => t.status === "served");
  return (
    <div className="page rs-kds-page">
      <PageHeader eyebrow="المبيعات" title="شاشة المطبخ" description="تتحدث تلقائياً كل بضع ثوانٍ. الطلب يتقدم خطوة واحدة في كل ضغطة."
        actions={(locations.data?.items.length ?? 0) > 1 && <label className="row"><span className="field-label">المطبخ</span><select className="select rs-kds-select" value={loc} onChange={(e) => setLoc(e.target.value)}>{locations.data!.items.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>} />
      {board.isError && <section className="panel"><ErrorState error={board.error} onRetry={() => board.refetch()} title="تعذر تحديث شاشة المطبخ" /></section>}
      <div className="rs-kds-board">
        {cols.map((c) => {
          const list = tickets.filter((t) => t.status === c.key);
          return (
            <section key={c.key} className="rs-kds-lane" aria-label={c.title}>
              <div className="rs-kds-lane-head">
                <span className={`stat-icon tone-${c.hue}`} aria-hidden="true">{c.icon}</span>
                <h2>{c.title}</h2>
                <span className="spacer" />
                <span className={`count-dot tag-${c.hue}`} title={`${integer(list.length)} طلب`}><span className="num">{integer(list.length)}</span><span className="sr-only"> طلب</span></span>
              </div>
              <div className="rs-kds-lane-body">
                {board.isPending ? [0, 1].map((i) => <Skeleton key={i} height={140} />) : list.length === 0 ? <p className="muted rs-kds-empty">لا توجد طلبات.</p> : list.map((t) => {
                  const mins = Math.floor((now - Date.parse(t.createdAt)) / 60_000);
                  const late = mins >= 20 ? "danger" : mins >= 10 ? "warning" : null;
                  const hue = channelHue(t.channel, t.platformName);
                  return (
                    <article key={t.id} className={["panel", "rs-kds-ticket", `rs-kds-edge-${hue}`, late && `is-${late}`].filter(Boolean).join(" ")} aria-label={`طلب ${kdsRef(t)}`}>
                      <div className="rs-kds-ticket-head">
                        <strong className="num rs-kds-number">{kdsRef(t)}</strong>
                        {t.round > 1 && <span className={t.items.every((i) => i.quantity < 0) ? "badge badge-danger" : "badge badge-info"}>{t.items.every((i) => i.quantity < 0) ? "إلغاء" : `إضافة ${t.round}`}</span>}
                        <span className={`tag tag-${hue}`}>{t.tableName ? `طاولة ${t.tableName}` : t.platformName ? `${t.platformName} ${t.externalRef ?? ""}` : t.ticketLabel || t.customerName || CHANNEL_LABELS[t.channel]}</span>
                        <span className="spacer" />
                        <span className={late ? `badge badge-${late}` : "badge badge-neutral"}><Clock aria-hidden="true" /><span className="num">{integer(mins)}</span> د</span>
                      </div>
                      <ul className="rs-kds-items">
                        {t.items.map((i, n) => (
                          <li key={n} className={i.quantity < 0 ? "is-void" : undefined}>
                            <strong className="num rs-kds-qty">{i.quantity < 0 ? `إلغاء ${-i.quantity}` : `${i.quantity}×`}</strong>
                            <span>{i.name}{i.modifiers.length > 0 && <span className="muted rs-kds-mods">{i.modifiers.join("، ")}</span>}{i.note && <span className="rs-kds-note-line">* {i.note}</span>}</span>
                          </li>
                        ))}
                      </ul>
                      {t.notes && <p className="banner banner-warning rs-banner rs-kds-note">{t.notes}</p>}
                      <div className="rs-kds-ticket-foot">
                        {t.items.every((i) => i.quantity < 0)
                          ? <Button variant="secondary" size="lg" className="rs-kds-advance" loading={busy === t.id} loadingText="…" onClick={() => void move(t, "served")}>تم الاطلاع على الإلغاء</Button>
                          : <Button variant={c.key === "ready" ? "primary" : "secondary"} size="lg" className="rs-kds-advance" loading={busy === t.id} loadingText="…" onClick={() => void move(t, c.next)}>{c.action}</Button>}
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
      {served.length > 0 && (
        <section className="panel" aria-labelledby="rs-kds-served">
          <div className="card-head"><h2 id="rs-kds-served">سُلّمت مؤخراً</h2><span className="muted">آخر 15 دقيقة، للاسترجاع عند الخطأ</span></div>
          <div className="card-body row">
            {served.map((t) => <Button key={t.id} className="rs-kds-recall" icon={<RotateCcw />} loading={busy === t.id} onClick={() => void move(t, "recall")}>إرجاع {kdsRef(t)}</Button>)}
          </div>
        </section>
      )}
    </div>
  );
}

// ── Report: sales by channel ────────────────────────────────────────────────────────────────────
export function SalesByChannelReport() {
  const { tenantId } = useTenant();
  const [from, setFrom] = useState(addDays(isoDay(), -29));
  const [to, setTo] = useState(isoDay());
  const r = useQuery({ queryKey: ["t", tenantId, "reports", "channels", from, to], placeholderData: keepPreviousData,
    queryFn: () => api<{ items: { channel: string; platformName: string | null; orders: number; netSales: number; total: number; commission: number; netAfterCommission: number }[] }>("GET", "/t/reports/sales-by-channel", { tenant: tenantId, query: { from, to } }) });
  // Display totals of the server's rows, summed in halalas to avoid float drift (the per-row figures come from the server).
  const sum = (f: (x: NonNullable<typeof r.data>["items"][number]) => number) => (r.data?.items ?? []).reduce((a, x) => a + Math.round(f(x) * 100), 0) / 100;
  const commission = sum((x) => x.commission);
  const orders = (r.data?.items ?? []).reduce((a, x) => a + x.orders, 0);
  return (
    <div className="page">
      <PageHeader eyebrow="التقارير" title="المبيعات حسب القناة" description={`محلي وسفري وتوصيل، وكل تطبيق توصيل بعمولته، من ${day(from)} إلى ${day(to)}.`} />
      <div className="toolbar panel"><DateRange from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} /></div>
      {r.data && (
        <div className="stats stats-4">
          <StatCard label="صافي المبيعات" value={money(sum((x) => x.netSales))} note="قبل الضريبة" icon={<Receipt />} hue="indigo" />
          <StatCard label="عدد الطلبات" value={integer(orders)} note={`في ${integer(r.data.items.length)} قناة`} icon={<ShoppingBag />} hue="sky" />
          <StatCard label="عمولات التطبيقات في الفترة" value={money(commission)} icon={<Bike />} hue="violet" />
          <StatCard label="الربح بعد العمولة والتكلفة" value={money(sum((x) => x.netAfterCommission))} icon={<TrendingUp />} hue="green" />
        </div>
      )}
      <section className="panel">
        <DataTable caption="المبيعات حسب القناة" query={{ ...r, data: r.data ? { items: r.data.items } : undefined }} rowKey={(x) => `${x.channel}-${x.platformName ?? ""}`}
          empty={{ title: "لا توجد مبيعات في الفترة", body: "" }}
          columns={[
            { key: "c", sortKey: false, header: "القناة", cell: (x) => <span className={`tag tag-${channelHue(x.channel, x.platformName)}`}>{x.platformName ?? CHANNEL_LABELS[x.channel] ?? x.channel}</span> },
            { key: "o", sortKey: "orders", header: "الطلبات", numeric: true, cell: (x) => integer(x.orders) },
            { key: "n", sortKey: "netSales", header: "صافي المبيعات", numeric: true, cell: (x) => money(x.netSales) },
            { key: "t", sortKey: "total", header: "شامل الضريبة", numeric: true, cell: (x) => money(x.total) },
            { key: "cm", sortKey: "commission", header: "العمولة", numeric: true, cell: (x) => (x.commission ? money(x.commission) : "—") },
            { key: "g", sortKey: "netAfterCommission", header: "الربح بعد العمولة والتكلفة", numeric: true, cell: (x) => money(x.netAfterCommission) },
          ]} />
      </section>
    </div>
  );
}

/** A factory customer's price list: its own prices on quotations, before the item's sale price. */
function PriceListField({ tenantId, value, onChange }: { tenantId: string; value: string; onChange: (id: string) => void }) {
  const lists = useQuery({ queryKey: ["t", tenantId, "price-lists"], queryFn: () => api<{ items: { id: string; name: string; isActive: boolean }[] }>("GET", "/t/price-lists", { tenant: tenantId }) });
  if (!lists.data?.items.length) return null;
  return (
    <SelectField label="قائمة الأسعار" optional placeholder="سعر البيع العام" value={value} onChange={(e) => onChange(e.target.value)}
      options={lists.data.items.filter((l) => l.isActive || l.id === value).map((l) => ({ value: l.id, label: l.name }))} hint="تُقترح أسعارها في عروض الأسعار لهذا العميل." />
  );
}
