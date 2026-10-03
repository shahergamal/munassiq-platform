import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileSpreadsheet, Plus, Trash2, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, download, type Page } from "../../api/client";
import type { Ingredient, Unit } from "../../api/types";
import { useInvalidate, useTenant } from "../../app/tenant";
import { cost, integer, percent, quantity, text } from "../../lib/format";
import { Button } from "../../ui/Button";
import { DataTable } from "../../ui/DataTable";
import { useTablePrefs } from "../../ui/tablePrefs";
import { ConfirmDialog, Dialog } from "../../ui/Dialog";
import { Checkbox, focusFirstInvalid, SelectField, TextField, SearchInput } from "../../ui/Field";
import { ActionMenu, Badge, PageHeader, StatusBadge } from "../../ui/Layout";
import { FormError } from "../../ui/States";
import { DIMENSION_LABELS, ITEM_TYPE_LABELS } from "../../ui/status";
import { useToast } from "../../ui/Toast";
import { beep, ScanField } from "../../ui/Scanner";

export function useUnits(tenantId: string) {
  return useQuery({ queryKey: ["t", tenantId, "units"], queryFn: () => api<{ items: Unit[] }>("GET", "/t/units", { tenant: tenantId }), staleTime: 10 * 60_000 });
}

/** A factory calls them items (raw materials, semi-finished, finished products…); a restaurant, ingredients. */
function useWords() {
  const { factory, contracting } = useTenant();
  return factory
    ? { title: "الأصناف", one: "الصنف", a: "صنف", add: "إضافة صنف", intro: "الخامات ونصف المصنّع والمنتج التام ومواد التعبئة وقطع الغيار. كل نوع يُقيَّم في حساب مخزونه." }
    : contracting
      ? { title: "المواد والأصناف", one: "المادة", a: "مادة", add: "إضافة مادة", intro: "مواد البناء والمستهلكات وقطع غيار المعدات، تُستلم في المستودع أو مخزن الموقع وتُصرف على المشاريع." }
      : { title: "المواد الخام", one: "المادة", a: "مادة", add: "إضافة مادة", intro: "" };
}

export function IngredientsPage() {
  const { tenantId, can, writable, factory, contracting, restaurant } = useTenant();
  const w = useWords();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [category, setCategory] = useState("");
  const [stock, setStock] = useState<"" | "low" | "zero">("");
  const [active, setActive] = useState<"" | "true" | "false">("true");
  const [type, setType] = useState("");
  const [page, setPage] = useState(1);
  const prefs = useTablePrefs("ingredients", { server: true, onSortChange: () => setPage(1) });
  const [editing, setEditing] = useState<Ingredient | "new" | null>(null);
  const [barcodesOf, setBarcodesOf] = useState<Ingredient | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [deleting, setDeleting] = useState<Ingredient | null>(null);
  const [delBusy, setDelBusy] = useState(false);
  const [delError, setDelError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => { const t = setTimeout(() => { setDebounced(q.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);

  const list = useQuery({
    queryKey: ["t", tenantId, "ingredients", { q: debounced, category, stock, active, type, page, sort: prefs.sortParam }],
    queryFn: ({ signal }) => api<Page<Ingredient>>("GET", "/t/ingredients", { tenant: tenantId, signal, query: { q: debounced, category, stock, isActive: active, type, page, pageSize: 25, sort: prefs.sortParam } }),
    placeholderData: keepPreviousData,
  });
  const categories = useQuery({ queryKey: ["t", tenantId, "ingredients", "categories"], queryFn: () => api<{ items: string[] }>("GET", "/t/ingredients/categories", { tenant: tenantId }) });
  const canCreate = can("ingredients.create") && writable;
  const canEdit = can("ingredients.edit") && writable;
  const canDelete = can("ingredients.delete") && writable;
  const canImport = can("ingredients.import") && writable;
  const filtered = Boolean(debounced || category || stock || type || active !== "true");

  async function doExport() {
    setExporting(true);
    try { await download("/t/ingredients/export", tenantId, "ingredients.xlsx"); }
    catch (err) { toast.error((err as Error).message); }
    finally { setExporting(false); }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setDelBusy(true); setDelError(null);
    try {
      await api("DELETE", `/t/ingredients/${deleting.id}`, { tenant: tenantId });
      toast.success(`تم حذف ${w.one} «${deleting.name}»`);
      setDeleting(null);
      await invalidate("ingredients");
    } catch (err) {
      setDelError(err instanceof ApiError && err.code === "reference_conflict"
        ? (factory || contracting ? "الصنف مستخدم في مشتريات أو حركات مخزون، لذا لا يمكن حذفه. أوقفه بدلاً من ذلك ليختفي من الاختيارات."
          : "المادة مستخدمة في وصفات أو مشتريات أو حركات مخزون، لذا لا يمكن حذفها. أوقفها بدلاً من ذلك لتختفي من الاختيارات.")
        : (err as Error).message);
    } finally { setDelBusy(false); }
  }

  async function setActiveFlag(i: Ingredient, value: boolean) {
    try {
      await api("PATCH", `/t/ingredients/${i.id}`, { tenant: tenantId, body: { isActive: value } });
      toast.success(value ? `تم تفعيل «${i.name}»` : `تم إيقاف «${i.name}»`);
      await invalidate("ingredients");
    } catch (err) { toast.error((err as Error).message); }
  }

  return (
    <div className="page">
      <PageHeader eyebrow="البيانات الأساسية" title={w.title}
        description={factory || contracting ? `${w.intro} الرصيد ومتوسط التكلفة المرجح يُحسبان في الخادم ولا يُعدَّلان يدوياً.` : "الرصيد ومتوسط التكلفة المرجح يُحسبان في الخادم من الاستلامات والمبيعات، ولا يُعدَّلان يدوياً."}
        actions={<>
          {can("ingredients.export") && <Button icon={<Download />} onClick={() => void doExport()} loading={exporting} loadingText="جارٍ التجهيز…">تصدير Excel</Button>}
          {canImport && <Button icon={<Upload />} onClick={() => setImportOpen(true)}>استيراد من Excel</Button>}
          {canCreate && <Button variant="primary" icon={<Plus />} onClick={() => setEditing("new")}>{w.add}</Button>}
        </>} />
      <section className="panel" aria-label={`قائمة ${w.title}`}>
        <DataTable
          caption={w.title}
          prefs={prefs}
          toolbar={<>
          <SearchInput placeholder="ابحث بالاسم أو الرمز أو الباركود" value={q} onChange={setQ} />
          {factory && (
            <select className="select" aria-label="نوع الصنف" value={type} onChange={(e) => { setType(e.target.value); setPage(1); }}>
              <option value="">كل الأنواع</option>
              {Object.entries(ITEM_TYPE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          )}
          <select className="select" aria-label="الفئة" value={category} onChange={(e) => { setCategory(e.target.value); setPage(1); }}>
            <option value="">كل الفئات</option>
            {(categories.data?.items ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select className="select" aria-label="مستوى الرصيد" value={stock} onChange={(e) => { setStock(e.target.value as typeof stock); setPage(1); }}>
            <option value="">كل مستويات الرصيد</option><option value="low">تحت الحد الأدنى</option><option value="zero">رصيد صفر</option>
          </select>
          <select className="select" aria-label="الحالة" value={active} onChange={(e) => { setActive(e.target.value as typeof active); setPage(1); }}>
            <option value="true">النشطة</option><option value="false">الموقوفة</option><option value="">الكل</option>
          </select>
          </>}
          query={list}
          rowKey={(r) => r.id}
          filtered={filtered}
          onClearFilters={() => { setQ(""); setCategory(""); setStock(""); setType(""); setActive("true"); }}
          onPageChange={setPage}
          onRowClick={canEdit ? (r) => setEditing(r) : undefined}
          empty={{ title: factory ? "لا توجد أصناف بعد" : contracting ? "لا توجد مواد بعد" : "لا توجد مواد خام بعد",
            body: factory ? "ابدأ بالخامات التي تشتريها، ثم المنتجات التي تصنعها. يمكنك استيراد القائمة كاملة من Excel." : contracting ? "أضف مواد البناء التي تشتريها (أسمنت، حديد، بلوك…)، أو استورد القائمة من Excel." : "أضف موادك واحدة واحدة، أو نزّل قالب Excel واستورد القائمة كاملة مرة واحدة.",
            action: canCreate ? <Button variant="primary" icon={<Plus />} onClick={() => setEditing("new")}>{w.add}</Button> : undefined }}
          columns={[
            { key: "name", sortKey: "name", header: factory ? "الصنف" : "المادة", cell: (r) => (
              <span className="stack-tight"><strong>{r.name}</strong>{r.nameEn && <bdi dir="ltr" className="muted acc-small">{r.nameEn}</bdi>}</span>
            ) },
            { key: "sku", sortKey: "sku", header: "الرمز", cell: (r) => <span className="num">{r.sku}</span> },
            ...(factory ? [{ key: "type", sortKey: "itemType", header: "النوع", cell: (r: Ingredient) => <Badge tone="neutral">{ITEM_TYPE_LABELS[r.itemType ?? "raw"]}</Badge> }] : []),
            { key: "category", sortKey: "category", header: "الفئة", cell: (r) => text(r.category) },
            { key: "unit", sortKey: "baseUnitName", header: "وحدة الأساس", cell: (r) => r.baseUnitName },
            { key: "stock", sortKey: "stockQty", header: "الرصيد", numeric: true, cell: (r) => (
              <span className="row" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
                {r.stockQty === 0 ? <Badge tone="danger">نفد</Badge> : r.stockQty < r.minStock ? <Badge tone="warning">تحت الحد</Badge> : null}
                {quantity(r.stockQty)} {r.baseUnit}
              </span>
            ) },
            { key: "avg", sortKey: "avgCost", header: "متوسط التكلفة المرجح", numeric: true, cell: (r) => (r.avgCost ? <>{cost(r.avgCost)} / {r.baseUnit}</> : <span className="muted">لم تُشترَ بعد</span>) },
            ...(!restaurant ? [] : [{ key: "yield", sortKey: "yieldPercentage", header: "نسبة الاستفادة", numeric: true, cell: (r: Ingredient) => percent(r.yieldPercentage) }]),
            { key: "status", sortKey: "isActive", header: "الحالة", cell: (r) => <StatusBadge kind="active" value={r.isActive} /> },
          ]}
          actions={canEdit || canDelete ? (r) => (
            <ActionMenu label={`إجراءات ${w.one} ${r.name}`} items={[
              ...(canEdit ? [{ label: "تعديل", onSelect: () => setEditing(r) },
                { label: "باركودات العبوات", onSelect: () => setBarcodesOf(r) },
                { label: r.isActive ? "إيقاف" : "تفعيل", onSelect: () => void setActiveFlag(r, !r.isActive) }] : []),
              ...(canDelete ? [{ label: "حذف", danger: true, separated: canEdit, onSelect: () => { setDelError(null); setDeleting(r); } }] : []),
            ]} />
          ) : undefined}
        />
      </section>

      {editing && <IngredientForm tenantId={tenantId} ingredient={editing === "new" ? null : editing} categories={categories.data?.items ?? []}
        onClose={() => setEditing(null)} onSaved={async (msg) => { setEditing(null); toast.success(msg); await invalidate("ingredients"); }} />}
      {barcodesOf && <BarcodesDialog tenantId={tenantId} ingredient={barcodesOf} onClose={() => setBarcodesOf(null)} />}
      {importOpen && <ImportDialog tenantId={tenantId} onClose={() => setImportOpen(false)} onDone={async (n) => { setImportOpen(false); toast.success(`تم استيراد ${integer(n)} ${w.a}`); await invalidate("ingredients"); }} />}
      <ConfirmDialog open={Boolean(deleting)} onClose={() => setDeleting(null)} onConfirm={() => void confirmDelete()} busy={delBusy} error={delError}
        title={`حذف ${w.one}`} confirmLabel={`حذف ${w.one} نهائياً`}
        message={factory || contracting
          ? <>سيُحذف الصنف <strong>«{deleting?.name}»</strong> ({deleting?.sku}) نهائياً. الأصناف التي لها حركات مخزون لا تُحذف، بل توقف.</>
          : <>ستُحذف المادة <strong>«{deleting?.name}»</strong> ({deleting?.sku}) نهائياً. المواد التي لها وصفات أو حركات مخزون لا تُحذف، بل توقف.</>} />
    </div>
  );
}

function IngredientForm({ tenantId, ingredient, categories, onClose, onSaved }: { tenantId: string; ingredient: Ingredient | null; categories: string[]; onClose: () => void; onSaved: (m: string) => void }) {
  const { factory, restaurant, contracting } = useTenant();
  const w = useWords();
  const units = useUnits(tenantId);
  const form = useRef<HTMLFormElement>(null);
  const [v, setV] = useState({
    name: ingredient?.name ?? "", category: ingredient?.category ?? "", barcode: ingredient?.barcode ?? "",
    baseUnitId: ingredient?.baseUnitId ?? "", purchaseUnitId: ingredient?.purchaseUnitId ?? "", purchaseToBase: ingredient ? String(ingredient.purchaseToBase) : "",
    yieldPercentage: String(ingredient?.yieldPercentage ?? 100), minStock: String(ingredient?.minStock ?? 0), parStock: String(ingredient?.parStock ?? 0),
    trackExpiry: ingredient?.trackExpiry ?? false, shelfLife: ingredient?.shelfLifeDays ? String(ingredient.shelfLifeDays) : "",
    itemType: ingredient?.itemType ?? "raw", nameEn: ingredient?.nameEn ?? "", salePrice: ingredient?.salePrice != null ? String(ingredient.salePrice) : "", leadTime: String(ingredient?.leadTimeDays ?? 0),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const byId = useMemo(() => new Map((units.data?.items ?? []).map((u) => [u.id, u])), [units.data]);
  const base = byId.get(v.baseUnitId);
  const purchase = byId.get(v.purchaseUnitId);
  const sameDimension = Boolean(base && purchase && base.dimension === purchase.dimension);
  // Count units (carton, pack, box…) are all "1": a carton of 24 pieces cannot be derived, so it must be stated.
  const countPair = Boolean(base && purchase && base.dimension === "count" && purchase.dimension === "count" && base.id !== purchase.id);
  const derived = sameDimension && !countPair ? purchase!.toBase / base!.toBase : null;
  const needsFactor = Boolean(base && purchase && (!sameDimension || countPair));
  const unitLocked = Boolean(ingredient && ingredient.stockQty > 0);
  const factor = needsFactor ? Number(v.purchaseToBase) || null : derived;

  const unitOptions = (units.data?.items ?? []).map((u) => ({ value: u.id, label: `${u.name} (${DIMENSION_LABELS[u.dimension]})` }));

  async function submit() {
    const e: Record<string, string> = {};
    if (v.name.trim().length < 2) e.name = `أدخل اسم ${w.one} (حرفان على الأقل)`;
    if (v.nameEn.trim() && v.nameEn.trim().length < 2) e.nameEn = "حرفان على الأقل، أو اتركه فارغاً";
    if (v.salePrice.trim() && !(Number(v.salePrice.replace(/,/g, "")) >= 0)) e.salePrice = "سعر صفر أو أكثر، أو اتركه فارغاً";
    if (!/^\d{1,3}$/.test(v.leadTime.trim() || "0") || Number(v.leadTime) > 365) e.leadTime = "عدد أيام من 0 إلى 365";
    if (!v.baseUnitId) e.baseUnitId = "اختر الوحدة التي يُحسب بها الرصيد والتكلفة";
    if (!v.purchaseUnitId) e.purchaseUnitId = "اختر الوحدة التي تشتري بها من المورد";
    if (needsFactor && !(Number(v.purchaseToBase) > 0)) e.purchaseToBase = `كم ${base?.name} في ${purchase?.name} واحد؟ أدخل رقماً أكبر من صفر`;
    const y = Number(v.yieldPercentage);
    if (!(y > 0 && y <= 100)) e.yieldPercentage = "نسبة بين 1 و100. مثال: 85 إذا كان 15٪ يُفقد في التنظيف";
    if (!(Number(v.minStock) >= 0)) e.minStock = "رقم صفر أو أكبر";
    if (!(Number(v.parStock) >= 0)) e.parStock = "رقم صفر أو أكبر";
    else if (Number(v.parStock) > 0 && Number(v.parStock) < Number(v.minStock)) e.parStock = "المستوى المستهدف لا يقل عن الحد الأدنى";
    const shelf = v.shelfLife.trim() === "" ? null : Number(v.shelfLife);
    if (shelf !== null && !(Number.isInteger(shelf) && shelf >= 1 && shelf <= 3650)) e.shelfLife = "عدد أيام صحيح من 1 إلى 3650، أو اتركه فارغاً";
    setErrors(e);
    if (Object.keys(e).length) return focusFirstInvalid(form.current);
    setBusy(true); setError(null);
    const body = {
      name: v.name.trim(), category: v.category.trim() || null, barcode: v.barcode.trim() || null,
      baseUnitId: v.baseUnitId, purchaseUnitId: v.purchaseUnitId,
      ...(needsFactor ? { purchaseToBase: Number(v.purchaseToBase) } : {}),
      yieldPercentage: y, minStock: Number(v.minStock), parStock: Number(v.parStock),
      trackExpiry: v.trackExpiry, shelfLifeDays: shelf,
      ...(factory ? { itemType: v.itemType, nameEn: v.nameEn.trim() || null, salePrice: v.salePrice.trim() ? Number(v.salePrice.replace(/,/g, "")) : null, leadTimeDays: Number(v.leadTime || 0) } : {}),
    };
    try {
      if (ingredient) await api("PATCH", `/t/ingredients/${ingredient.id}`, { tenant: tenantId, body });
      else await api("POST", "/t/ingredients", { tenant: tenantId, body });
      onSaved(ingredient ? `تم حفظ «${body.name}»` : `تمت إضافة «${body.name}»`);
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fieldErrors);
      setError(err);
    } finally { setBusy(false); }
  }

  return (
    <Dialog open wide onClose={onClose} busy={busy} formRef={form} onSubmit={() => void submit()} title={ingredient ? `تعديل «${ingredient.name}»` : factory ? "إضافة صنف" : "إضافة مادة خام"}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">{ingredient ? "حفظ التعديلات" : `حفظ ${w.one}`}</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <div className="form-section">
        <h3>التعريف</h3>
        <div className="form-grid">
          <TextField label={`اسم ${w.one}`} required value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} error={errors.name} />
          {factory && <>
            <TextField label="الاسم بالإنجليزية" optional dir="ltr" value={v.nameEn} onChange={(e) => setV({ ...v, nameEn: e.target.value })} error={errors.nameEn} hint="يظهر بجانب الاسم العربي في المستندات ثنائية اللغة." />
            <SelectField label="نوع الصنف" required value={v.itemType} onChange={(e) => setV({ ...v, itemType: e.target.value as typeof v.itemType })} error={errors.itemType}
              options={Object.entries(ITEM_TYPE_LABELS).map(([value, label]) => ({ value, label }))}
              hint={ingredient ? "يحدد حساب المخزون الذي يُقيَّم فيه، ولا يتغير بعد أول حركة مخزون." : "يحدد حساب المخزون الذي يُقيَّم فيه الصنف (خامات، إنتاج تام…)."} />
            {(v.itemType === "finished" || v.itemType === "semi_finished") && (
              <TextField label="سعر البيع (قبل الضريبة)" optional numeric value={v.salePrice} onChange={(e) => setV({ ...v, salePrice: e.target.value })} error={errors.salePrice}
                hint="لكل وحدة أساس. يُقترح في عروض الأسعار وأوامر البيع." />
            )}
          </>}
          <TextField label="الفئة" optional list="ingredient-categories" value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })} hint="اختر فئة موجودة أو اكتب جديدة." />
          <datalist id="ingredient-categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
          <TextField label="الباركود" optional dir="ltr" inputMode="numeric" value={v.barcode} onChange={(e) => setV({ ...v, barcode: e.target.value })} />
        </div>
      </div>
      <div className="form-section">
        <h3>الوحدات</h3>
        <div className="form-grid">
          <SelectField label="وحدة الأساس (الرصيد والتكلفة)" required placeholder="اختر الوحدة" options={unitOptions} value={v.baseUnitId} disabled={unitLocked}
            onChange={(e) => setV({ ...v, baseUnitId: e.target.value })} error={errors.baseUnitId} hint={unitLocked ? "لا يمكن تغييرها لأن للمادة رصيداً في المخزون." : "الوحدة الأصغر التي تُحسب بها الكمية والتكلفة، مثل جرام أو كيلو أو حبة."} />
          <SelectField label="وحدة الشراء" required placeholder="اختر الوحدة" options={unitOptions} value={v.purchaseUnitId}
            onChange={(e) => setV({ ...v, purchaseUnitId: e.target.value })} error={errors.purchaseUnitId} />
          {needsFactor && (
            <TextField label={`عدد ${base?.name ?? ""} في ${purchase?.name ?? ""} واحد`} required numeric value={v.purchaseToBase}
              onChange={(e) => setV({ ...v, purchaseToBase: e.target.value })} error={errors.purchaseToBase} hint="مثال: كرتون فيه 24 حبة ← 24." />
          )}
        </div>
        {base && purchase && factor ? <p className="muted" role="status">1 {purchase.name} = <span className="num">{quantity(factor)}</span> {base.name}</p> : null}
      </div>
      <div className="form-section">
        <h3>التكلفة والمخزون</h3>
        <div className="form-grid">
          {restaurant && <TextField label="نسبة الاستفادة ٪" required numeric value={v.yieldPercentage} onChange={(e) => setV({ ...v, yieldPercentage: e.target.value })} error={errors.yieldPercentage} hint="ما يبقى صالحاً بعد التنظيف والتقطيع. تُرفع تكلفة الوصفة بقدر الفاقد." />}
          <TextField label={`الحد الأدنى للرصيد${base ? ` (${base.name})` : ""}`} required numeric value={v.minStock} onChange={(e) => setV({ ...v, minStock: e.target.value })} error={errors.minStock} hint={`عند النزول تحته يظهر ${w.one} في «تحت الحد».`} />
          {factory && <TextField label="مدة التوريد أو الإنتاج (أيام)" optional numeric value={v.leadTime} onChange={(e) => setV({ ...v, leadTime: e.target.value.replace(/\D/g, "") })} error={errors.leadTime}
            hint="تخطيط الاحتياجات يطلبه قبل موعد الحاجة بهذه المدة." />}
          <TextField label={`المستوى المستهدف (Par)${base ? ` (${base.name})` : ""}`} optional numeric value={v.parStock} onChange={(e) => setV({ ...v, parStock: e.target.value })} error={errors.parStock} hint="اقتراح الشراء يطلب ما يرفع الرصيد إليه. صفر = يستخدم ضعف الحد الأدنى." />
        </div>
      </div>
      {!contracting && <div className="form-section">
        <h3>الصلاحية والتشغيلات</h3>
        <Checkbox label={factory ? "تتبع رقم التشغيلة وتاريخ الصلاحية (كيماويات، أغذية، أدوية…)" : "تتبع تاريخ الصلاحية ورقم التشغيلة (لحوم، دواجن، ألبان، صوصات…)"} checked={v.trackExpiry} onChange={(e) => setV({ ...v, trackExpiry: e.target.checked })} />
        <div className="form-grid">
          <TextField label="مدة الصلاحية (أيام)" optional numeric value={v.shelfLife} onChange={(e) => setV({ ...v, shelfLife: e.target.value.replace(/\D/g, "") })} error={errors.shelfLife}
            hint={v.trackExpiry ? "تاريخ الانتهاء الافتراضي عند الاستلام، وصلاحية ما يُحضَّر منها. الاستلام يطلب تاريخ الانتهاء إن تركته فارغاً." : "اختياري: يُقترح تاريخ انتهاء عند الاستلام."} />
        </div>
        {v.trackExpiry && <p className="muted acc-small">يُصرف الأقرب انتهاءً أولاً تلقائياً في البيع والتحويل والهدر، وتظهر الدفعات القريبة من الانتهاء في «الصلاحية والدفعات».</p>}
      </div>}
      <FormError error={error} />
    </Dialog>
  );
}

interface PackBarcode { id: string; barcode: string; baseQuantity: number; label: string | null }

/** Extra codes for the same item (piece, pack, carton): each scan counts its quantity in the base unit. */
function BarcodesDialog({ tenantId, ingredient, onClose }: { tenantId: string; ingredient: Ingredient; onClose: () => void }) {
  const { can, writable } = useTenant();
  const qc = useQueryClient();
  const canWrite = can("ingredients.edit") && writable;
  const key = ["t", tenantId, "ingredients", ingredient.id, "barcodes"];
  const list = useQuery({ queryKey: key, queryFn: () => api<{ items: PackBarcode[] }>("GET", `/t/ingredients/${ingredient.id}/barcodes`, { tenant: tenantId }) });
  const [code, setCode] = useState("");
  const [qty, setQty] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [removing, setRemoving] = useState<PackBarcode | null>(null);
  const unit = ingredient.baseUnitName;

  async function add() {
    setError(null);
    if (!code.trim() || !(Number(qty) > 0)) { setError(new Error("امسح الباركود وأدخل كم وحدة أساس تساوي المسحة الواحدة")); return; }
    setBusy(true);
    try {
      await api("POST", `/t/ingredients/${ingredient.id}/barcodes`, { tenant: tenantId, body: { barcode: code.trim(), baseQuantity: Number(qty), label: label.trim() || null } });
      beep(true);
      setCode(""); setQty(""); setLabel("");
      await qc.invalidateQueries({ queryKey: key });
    } catch (e) { beep(false); setError(e); } finally { setBusy(false); }
  }
  async function remove() {
    if (!removing) return;
    setBusy(true);
    try { await api("DELETE", `/t/ingredient-barcodes/${removing.id}`, { tenant: tenantId }); setRemoving(null); await qc.invalidateQueries({ queryKey: key }); }
    catch (e) { setError(e); setRemoving(null); } finally { setBusy(false); }
  }

  return (
    <Dialog open onClose={onClose} busy={busy} title={`باركودات «${ingredient.name}»`} footer={<Button onClick={onClose} disabled={busy}>تم</Button>}>
      <p className="muted">باركود المادة الأساسي{ingredient.barcode ? <> (<bdi dir="ltr" className="num">{ingredient.barcode}</bdi>)</> : null} يساوي وحدة شراء واحدة. أضف هنا باركود القطعة أو العلبة أو الكرتونة ليُحسب تلقائياً عند الجرد والاستلام بجهاز الباركود.</p>
      {list.isPending ? <p className="muted">جارٍ التحميل…</p> : list.isError ? (
        <div className="row"><span className="form-error">تعذّر تحميل الباركودات.</span><Button size="sm" onClick={() => void list.refetch()}>إعادة المحاولة</Button></div>
      ) : list.data.items.length === 0 ? <p className="muted">لا توجد باركودات إضافية بعد.</p> : (
        <table className="table">
          <thead><tr><th>الباركود</th><th>الوصف</th><th className="num">لكل مسحة</th>{canWrite && <th><span className="sr-only">إجراءات</span></th>}</tr></thead>
          <tbody>{list.data.items.map((b) => (
            <tr key={b.id}>
              <td><bdi dir="ltr" className="num">{b.barcode}</bdi></td>
              <td>{text(b.label)}</td>
              <td className="num">{quantity(b.baseQuantity)} {unit}</td>
              {canWrite && <td><Button size="sm" variant="ghost" icon={<Trash2 />} aria-label={`حذف الباركود ${b.barcode}`} onClick={() => setRemoving(b)} /></td>}
            </tr>
          ))}</tbody>
        </table>
      )}
      {canWrite && (
        <div className="form-section">
          <h3>إضافة باركود</h3>
          <ScanField label="الباركود" onCode={(c) => setCode(c)} hint={code ? `تم التقاط: ${code}` : "امسح العبوة بالجهاز أو اكتب الرقم ثم Enter."} disabled={busy} />
          <div className="form-grid">
            <TextField label={`كم ${unit || "وحدة أساس"} في المسحة الواحدة`} required numeric value={qty} onChange={(e) => setQty(e.target.value)} hint="مثال: كرتونة 12 علبة × 400 جرام ← 4800" />
            <TextField label="الوصف" optional value={label} onChange={(e) => setLabel(e.target.value)} placeholder="كرتونة، علبة…" />
          </div>
          <Button variant="primary" icon={<Plus />} loading={busy} loadingText="جارٍ الإضافة…" onClick={() => void add()}>إضافة الباركود</Button>
        </div>
      )}
      <FormError error={error} />
      <ConfirmDialog open={Boolean(removing)} onClose={() => setRemoving(null)} onConfirm={() => void remove()} busy={busy}
        title="حذف باركود" confirmLabel="حذف الباركود" message={<>سيتوقف التعرف على <bdi dir="ltr">{removing?.barcode}</bdi> عند المسح. المادة نفسها لا تتأثر.</>} />
    </Dialog>
  );
}

interface ImportError { row: number; message: string }

function ImportDialog({ tenantId, onClose, onDone }: { tenantId: string; onClose: () => void; onDone: (n: number) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [rowErrors, setRowErrors] = useState<ImportError[]>([]);
  const [templating, setTemplating] = useState(false);

  async function upload() {
    if (!file) return setError("اختر ملف Excel بصيغة ‎.xlsx");
    if (file.size > 2 * 1024 * 1024) return setError("حجم الملف أكبر من 2 ميجابايت. قسّمه إلى ملفين.");
    setBusy(true); setError(null); setRowErrors([]);
    const fd = new FormData();
    fd.append("file", file);
    try {
      const r = await api<{ imported: number }>("POST", "/t/ingredients/import", { tenant: tenantId, body: fd });
      onDone(r.imported);
    } catch (err) {
      if (err instanceof ApiError && err.code === "import_invalid") setRowErrors(((err.details as { errors?: ImportError[] })?.errors) ?? []);
      setError(err);
    } finally { setBusy(false); }
  }

  return (
    <Dialog open onClose={onClose} busy={busy} title="استيراد المواد الخام من Excel"
      footer={<><Button variant="primary" icon={<Upload />} onClick={() => void upload()} loading={busy} loadingText="جارٍ الفحص والاستيراد…">استيراد الملف</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <ol style={{ margin: 0, paddingInlineStart: "var(--sp-4)" }} className="stack">
        <li>نزّل القالب، وفيه ورقة برموز الوحدات المتاحة. <Button size="sm" variant="ghost" icon={<FileSpreadsheet />} loading={templating}
          onClick={async () => { setTemplating(true); await download("/t/ingredients/import-template", tenantId, "ingredients-template.xlsx").catch((e) => setError(e)); setTemplating(false); }}>تنزيل القالب</Button></li>
        <li>املأ صفاً لكل مادة (حتى 1000 صف).</li>
        <li>ارفع الملف. يُفحص في الخادم، وإذا وُجد صف خاطئ لا يُحفظ أي صف حتى تصححه.</li>
      </ol>
      <div className="field">
        <label className="field-label" htmlFor="import-file">ملف Excel ‎(.xlsx)</label>
        <input id="import-file" className="input" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setRowErrors([]); setError(null); }} style={{ paddingBlock: "var(--sp-1)" }} />
        {file && <span className="field-hint">{file.name}</span>}
      </div>
      <FormError error={error} />
      {rowErrors.length > 0 && (
        <div className="table-wrap panel">
          <table className="data-table">
            <caption className="sr-only">الصفوف غير الصالحة</caption>
            <thead><tr><th scope="col">الصف</th><th scope="col">المشكلة</th></tr></thead>
            <tbody>{rowErrors.map((r) => <tr key={r.row}><td className="num">{r.row}</td><td className="wrap">{r.message}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </Dialog>
  );
}

export function UnitsPage() {
  const { tenantId } = useTenant();
  const units = useUnits(tenantId);
  return (
    <div className="page">
      <PageHeader eyebrow="البيانات الأساسية" title="وحدات القياس" description="مكتبة الوحدات القياسية لمنشأتك. التحويل بين وحدات النوع نفسه تلقائي، وبين نوعين مختلفين (مثل كرتون وحبة) يُحدَّد لكل مادة." />
      <section className="panel">
        <DataTable caption="وحدات القياس" query={units} rowKey={(u) => u.id} empty={{ title: "لا توجد وحدات", body: "تُنشأ الوحدات القياسية تلقائياً مع المنشأة." }}
          columns={[
            { key: "name", sortKey: "name", header: "الوحدة", cell: (u) => <strong>{u.name}</strong> },
            { key: "code", sortKey: "code", header: "الرمز في Excel", cell: (u) => <span className="num">{u.code}</span> },
            { key: "dim", sortKey: "dimension", header: "النوع", cell: (u) => DIMENSION_LABELS[u.dimension] },
            { key: "base", sortKey: "toBase", header: "تساوي", numeric: true, cell: (u) => `${quantity(u.toBase)} ${u.dimension === "mass" ? "جرام" : u.dimension === "volume" ? "مل" : "حبة"}` },
          ]} />
      </section>
    </div>
  );
}
