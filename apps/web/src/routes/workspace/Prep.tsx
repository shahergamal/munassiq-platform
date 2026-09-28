import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { AlertTriangle, ArrowRight, Factory, Plus, Scale, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Page } from "../../api/client";
import { useIdempotencyKey } from "../../app/session";
import { useInvalidate, useTenant } from "../../app/tenant";
import { cost, dayTime, integer, money, quantity } from "../../lib/format";
import { Button, IconButton } from "../../ui/Button";
import { DataTable } from "../../ui/DataTable";
import { useTablePrefs } from "../../ui/tablePrefs";
import { Dialog } from "../../ui/Dialog";
import { focusFirstInvalid, SearchInput, SelectField, TextAreaField, TextField } from "../../ui/Field";
import { ActionMenu, Badge, PageHeader, StatusBadge } from "../../ui/Layout";
import { ErrorState, FormError, TableSkeleton } from "../../ui/States";
import { useToast } from "../../ui/Toast";
import { useUnits } from "./Ingredients";
import { useLocations } from "./Inventory";
import { IngredientPicker } from "./pickers";

interface PrepRow { id: string; ingredientId: string; name: string; category: string | null; sku: string; unit: string; batchYield: number; isActive: boolean; itemsCount: number; missingCost: number; batchCost: number; estimatedUnitCost: number; stockQty: number }

export function PrepRecipesPage() {
  const { tenantId, can, writable } = useTenant();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(1);
  const prefs = useTablePrefs("prep-recipes", { server: true, onSortChange: () => setPage(1) });
  const [producing, setProducing] = useState<PrepRow | null>(null);
  useEffect(() => { const t = setTimeout(() => { setDebounced(q.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);
  const list = useQuery({ queryKey: ["t", tenantId, "prep", { q: debounced, page, sort: prefs.sortParam }], queryFn: () => api<Page<PrepRow>>("GET", "/t/prep-recipes", { tenant: tenantId, query: { q: debounced, page, pageSize: 25, sort: prefs.sortParam } }), placeholderData: keepPreviousData });
  const canProduce = can("prep_recipes.produce") && writable;
  const add = can("prep_recipes.create") && writable && <Link to={`/w/${tenantId}/prep-recipes/new`} className="btn btn-primary"><Plus aria-hidden="true" />وصفة تحضيرية جديدة</Link>;
  return (
    <div className="page">
      <PageHeader eyebrow="الوصفات" title="الوصفات التحضيرية" description="صلصات وتتبيلات وعجائن تُحضَّر مسبقاً. الإنتاج يخصم الخامات ويضيف الصنف المحضّر للمخزون بتكلفته الفعلية، ثم تستخدمه وصفات المنيو كأي مادة." actions={add} />
      <section className="panel">
        <DataTable caption="الوصفات التحضيرية" prefs={prefs} query={list} rowKey={(r) => r.id} onPageChange={setPage} filtered={Boolean(debounced)} onClearFilters={() => setQ("")}
          toolbar={<SearchInput placeholder="ابحث باسم الصنف المحضّر" value={q} onChange={setQ} />}
          onRowClick={(r) => navigate({ to: `/w/${tenantId}/prep-recipes/${r.id}` })}
          empty={{ title: "لا توجد وصفات تحضيرية بعد", body: "أنشئ وصفة لكل صنف تحضّره مسبقاً (مثل صلصة الثوم) لتعرف تكلفته الحقيقية.", action: add || undefined }}
          columns={[
            { key: "n", sortKey: "name", header: "الصنف المحضّر", cell: (r) => <Link to={`/w/${tenantId}/prep-recipes/${r.id}`}><strong>{r.name}</strong></Link> },
            { key: "y", sortKey: "batchYield", header: "ناتج الدفعة", numeric: true, cell: (r) => `${quantity(r.batchYield)} ${r.unit}` },
            { key: "c", sortKey: "estimatedUnitCost", header: "تكلفة الوحدة التقديرية", numeric: true, cell: (r) => <span className="rs-num-cell">{r.missingCost > 0 && <Badge tone="warning">ناقصة</Badge>}{cost(r.estimatedUnitCost)} / {r.unit}</span> },
            { key: "s", sortKey: "stockQty", header: "الرصيد", numeric: true, cell: (r) => `${quantity(r.stockQty)} ${r.unit}` },
            { key: "a", sortKey: "isActive", header: "الحالة", cell: (r) => <StatusBadge kind="active" value={r.isActive} /> },
          ]}
          actions={canProduce ? (r) => (
            <ActionMenu label={`إجراءات ${r.name}`} items={[
              { label: "إنتاج دفعة", onSelect: () => setProducing(r), disabled: !r.isActive },
              { label: "فتح وتعديل", onSelect: () => navigate({ to: `/w/${tenantId}/prep-recipes/${r.id}` }) },
            ]} />
          ) : undefined} />
      </section>
      <ProductionRuns tenantId={tenantId} />
      {producing && <ProduceDialog tenantId={tenantId} prep={producing} onClose={() => setProducing(null)} />}
    </div>
  );
}

interface RunRow { id: string; number: number; createdAt: string; batches: number; outputQuantity: number; totalCost: number; unitCost: number; name: string; unit: string; locationName: string }

function ProductionRuns({ tenantId, prepRecipeId }: { tenantId: string; prepRecipeId?: string }) {
  const [page, setPage] = useState(1);
  const prefs = useTablePrefs("production-runs", { server: true, onSortChange: () => setPage(1) });
  const runs = useQuery({ queryKey: ["t", tenantId, "prep", "runs", prepRecipeId ?? "", { page, sort: prefs.sortParam }], queryFn: () => api<Page<RunRow>>("GET", "/t/production-runs", { tenant: tenantId, query: { prepRecipeId, page, pageSize: 10, sort: prefs.sortParam } }), placeholderData: keepPreviousData });
  return (
    <section className="panel" aria-labelledby="runs-h">
      <DataTable caption="سجل الإنتاج" prefs={prefs} query={runs} rowKey={(r) => r.id} onPageChange={setPage} empty={{ title: "لم يُنتَج شيء بعد", body: "اختر «إنتاج دفعة» من قائمة الوصفة." }}
        toolbar={<h2 id="runs-h">سجل الإنتاج</h2>}
        columns={[
          { key: "d", sortKey: "createdAt", header: "الوقت", cell: (r) => dayTime(r.createdAt) },
          { key: "n", sortKey: "name", header: "الصنف", cell: (r) => <strong>{r.name}</strong> },
          { key: "l", sortKey: "locationName", header: "الموقع", cell: (r) => r.locationName },
          { key: "b", sortKey: "batches", header: "الدفعات", numeric: true, cell: (r) => quantity(r.batches) },
          { key: "o", sortKey: "outputQuantity", header: "الناتج", numeric: true, cell: (r) => `${quantity(r.outputQuantity)} ${r.unit}` },
          { key: "u", sortKey: "unitCost", header: "تكلفة الوحدة", numeric: true, cell: (r) => cost(r.unitCost) },
          { key: "t", sortKey: "totalCost", header: "التكلفة", numeric: true, cell: (r) => money(r.totalCost) },
        ]} />
    </section>
  );
}

function ProduceDialog({ tenantId, prep, onClose }: { tenantId: string; prep: { id: string; name: string; unit: string; batchYield: number; estimatedUnitCost: number }; onClose: () => void }) {
  const locations = useLocations(tenantId);
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [key, renewKey] = useIdempotencyKey();
  const [loc, setLoc] = useState("");
  const [batches, setBatches] = useState("1");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { const l = locations.data?.items; if (l?.length && !loc) setLoc((l.find((x) => x.locationType === "kitchen") ?? l[0]!).id); }, [locations.data, loc]);
  const b = Number(batches);
  async function submit() {
    if (!loc) return setError("اختر موقع الإنتاج");
    if (!(b > 0)) return setError("عدد الدفعات أكبر من صفر (يمكن كسر مثل 0.5)");
    setBusy(true); setError(null);
    try {
      const r = await api<{ outputQuantity: number; unitCost: number }>("POST", `/t/prep-recipes/${prep.id}/produce`, { tenant: tenantId, idempotencyKey: key, body: { locationId: loc, batches: b } });
      renewKey();
      toast.success(`تم إنتاج ${quantity(r.outputQuantity)} ${prep.unit} من ${prep.name} بتكلفة ${cost(r.unitCost)} للوحدة`);
      await invalidate("prep", "stock", "ingredients", "recipes", "reports");
      onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} title={`إنتاج: ${prep.name}`} onSubmit={() => void submit()}
      footer={<><Button type="submit" variant="primary" icon={<Factory />} loading={busy} loadingText="جارٍ الإنتاج…">إنتاج وخصم الخامات</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <p className="muted">تُخصم الخامات من الموقع ويُضاف الناتج إليه. لا يمكن التراجع.</p>
      <div className="form-grid">
        <SelectField label="موقع الإنتاج" required value={loc} onChange={(e) => setLoc(e.target.value)} options={(locations.data?.items ?? []).map((l) => ({ value: l.id, label: l.name }))} />
        <TextField label="عدد الدفعات" required numeric value={batches} onChange={(e) => setBatches(e.target.value)} hint={b > 0 ? `الناتج المتوقع ${quantity(b * prep.batchYield)} ${prep.unit}` : undefined} />
      </div>
      <FormError error={error} />
    </Dialog>
  );
}

interface PrepDetail { id: string; ingredientId: string; name: string; category: string | null; unitId: string; unit: string; batchYield: number; notes: string | null; isActive: boolean; minStock: number; batchCost: number; estimatedUnitCost: number; missingCost: number; items: { ingredientId: string; name: string; unit: string; quantity: number; unitCost: number; cost: number }[] }
interface EditLine { ingredientId: string; name: string; unit: string; quantity: string }

export function PrepRecipeEditorPage() {
  const { tenantId, can, writable } = useTenant();
  const { prepId } = useParams({ strict: false }) as { prepId?: string };
  const isNew = !prepId || prepId === "new";
  const d = useQuery({ enabled: !isNew, queryKey: ["t", tenantId, "prep", prepId], queryFn: () => api<PrepDetail>("GET", `/t/prep-recipes/${prepId}`, { tenant: tenantId }) });
  if (!isNew && d.isPending) return <div className="page"><TableSkeleton columns={4} rows={4} /></div>;
  if (!isNew && d.isError) return <div className="page"><ErrorState error={d.error} onRetry={() => d.refetch()} /></div>;
  return <PrepEditor key={prepId ?? "new"} tenantId={tenantId} prep={isNew ? null : d.data!} canWrite={can(isNew ? "prep_recipes.create" : "prep_recipes.edit") && writable} canProduce={can("prep_recipes.produce") && writable} />;
}

function PrepEditor({ tenantId, prep, canWrite, canProduce }: { tenantId: string; prep: PrepDetail | null; canWrite: boolean; canProduce: boolean }) {
  const navigate = useNavigate();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const units = useUnits(tenantId);
  const form = useRef<HTMLFormElement>(null);
  const [v, setV] = useState({ name: prep?.name ?? "", category: prep?.category ?? "", unitId: prep?.unitId ?? "", batchYield: prep ? String(prep.batchYield) : "", notes: prep?.notes ?? "", isActive: prep?.isActive ?? true });
  const [lines, setLines] = useState<EditLine[]>(prep?.items.map((i) => ({ ingredientId: i.ingredientId, name: i.name, unit: i.unit, quantity: String(i.quantity) })) ?? []);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [producing, setProducing] = useState(false);
  const unit = units.data?.items.find((u) => u.id === v.unitId)?.name ?? prep?.unit ?? "";
  const dirty = !prep || JSON.stringify(lines.map((l) => [l.ingredientId, Number(l.quantity)])) !== JSON.stringify(prep.items.map((i) => [i.ingredientId, i.quantity])) || Number(v.batchYield) !== prep.batchYield;

  async function save() {
    const e: Record<string, string> = {};
    if (!prep && v.name.trim().length < 2) e.name = "أدخل اسم الصنف المحضّر";
    if (!prep && !v.unitId) e.unitId = "اختر وحدة قياس الناتج";
    if (!(Number(v.batchYield) > 0)) e.batchYield = "كمية الناتج من دفعة واحدة، أكبر من صفر";
    if (!lines.length) e.lines = "أضف مكوناً واحداً على الأقل";
    lines.forEach((l, i) => { if (!(Number(l.quantity) > 0)) e[`q${i}`] = "كمية أكبر من صفر"; });
    setErrors(e);
    if (Object.keys(e).length) return focusFirstInvalid(form.current);
    setBusy(true); setError(null);
    const items = lines.map((l) => ({ ingredientId: l.ingredientId, quantity: Number(l.quantity) }));
    try {
      if (prep) {
        await api("PUT", `/t/prep-recipes/${prep.id}`, { tenant: tenantId, body: { batchYield: Number(v.batchYield), notes: v.notes.trim() || null, isActive: v.isActive, items } });
        toast.success("تم حفظ الوصفة التحضيرية");
        await invalidate("prep");
      } else {
        const r = await api<{ id: string }>("POST", "/t/prep-recipes", { tenant: tenantId, body: { name: v.name.trim(), category: v.category.trim() || null, unitId: v.unitId, batchYield: Number(v.batchYield), notes: v.notes.trim() || null, items } });
        toast.success(`تم إنشاء «${v.name.trim()}». أنتج دفعة ليصبح له رصيد وتكلفة.`);
        await invalidate("prep", "ingredients");
        navigate({ to: `/w/${tenantId}/prep-recipes/${r.id}` });
      }
    } catch (err) { if (err instanceof ApiError) setErrors(err.fieldErrors); setError(err); } finally { setBusy(false); }
  }

  return (
    <div className="page">
    <form ref={form} className="stack-lg" noValidate onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <PageHeader eyebrow="الوصفات التحضيرية" title={prep ? <span className="rs-title">{prep.name}<StatusBadge kind="active" value={prep.isActive} /></span> : "وصفة تحضيرية جديدة"}
        description={prep ? "الاسم والفئة يُعدَّلان من دليل المواد الخام، لأن الصنف المحضّر مادة فيه." : "يُنشأ الصنف المحضّر في دليل المواد تلقائياً، ثم تستخدمه وصفات المنيو."}
        actions={<>
          <Link to={`/w/${tenantId}/prep-recipes`} className="btn btn-ghost"><ArrowRight aria-hidden="true" />القائمة</Link>
          {prep && canProduce && <Button icon={<Factory />} onClick={() => setProducing(true)} disabled={!prep.isActive || dirty} title={dirty ? "احفظ التعديلات قبل الإنتاج" : undefined}>إنتاج دفعة</Button>}
        </>} />
      <div className="rs-recipe-layout">
        <div className="stack-lg">
          <fieldset className="panel panel-pad form-section" disabled={!canWrite}>
            <legend className="sr-only">الصنف</legend>
            <h2>الصنف المحضّر</h2>
            <div className="form-grid">
              {!prep && <TextField label="الاسم" required value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} error={errors.name} hint="مثل: صلصة ثوم، دجاج متبّل" />}
              {!prep && <TextField label="الفئة" optional value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })} />}
              {!prep && <SelectField label="وحدة الناتج" required placeholder="اختر الوحدة" value={v.unitId} onChange={(e) => setV({ ...v, unitId: e.target.value })} error={errors.unitId}
                options={(units.data?.items ?? []).filter((u) => u.toBase === 1).map((u) => ({ value: u.id, label: u.name }))} />}
              <TextField label={`ناتج الدفعة الواحدة${unit ? ` (${unit})` : ""}`} required numeric value={v.batchYield} onChange={(e) => setV({ ...v, batchYield: e.target.value })} error={errors.batchYield} hint="ما يخرج فعلاً بعد التحضير، لا مجموع الخامات." />
            </div>
            <TextAreaField label="طريقة التحضير أو ملاحظات" optional rows={2} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} />
            {prep && <label className="checkbox"><input type="checkbox" checked={v.isActive} onChange={(e) => setV({ ...v, isActive: e.target.checked })} />نشطة (تظهر للإنتاج)</label>}
          </fieldset>
          <section className="panel" aria-labelledby="pl">
            <div className="card-head rs-recipe-card-head">
              <div><h2 id="pl">الخامات لدفعة واحدة</h2><p className="muted" style={{ fontSize: "var(--fs-xs)" }}>كميات خام كما تُصرف من المخزون</p></div>
              <span className="spacer" />
              {lines.length > 0 && <span className="count-dot tag-sky" title={`${integer(lines.length)} خامة`}><span className="num">{integer(lines.length)}</span><span className="sr-only"> خامة</span></span>}
            </div>
            {(canWrite || lines.length === 0) && (
              <div className="card-body">
                {canWrite && <div className="rs-recipe-picker"><IngredientPicker tenantId={tenantId} label="إضافة خامة" exclude={[...lines.map((l) => l.ingredientId), ...(prep ? [prep.ingredientId] : [])]} error={errors.lines}
                  onPick={(i) => setLines((ls) => [...ls, { ingredientId: i.id, name: i.name, unit: i.baseUnit, quantity: "" }])} /></div>}
                {!canWrite && lines.length === 0 && <p className="muted">لا توجد خامات في هذه الوصفة.</p>}
              </div>
            )}
            {lines.length > 0 && (
              <div className="table-wrap">
                <table className="data-table">
                  <caption className="sr-only">خامات الدفعة</caption>
                  <thead><tr><th scope="col">الخامة</th><th scope="col">الكمية</th>{prep && <th scope="col" className="end">التكلفة التقديرية</th>}{canWrite && <th scope="col"><span className="sr-only">إزالة</span></th>}</tr></thead>
                  <tbody>{lines.map((l, i) => {
                    const saved = prep?.items.find((x) => x.ingredientId === l.ingredientId);
                    return (
                      <tr key={l.ingredientId}>
                        <td><strong>{l.name}</strong></td>
                        <td className="rs-recipe-qty"><div className="row">
                          <input className="input num" inputMode="decimal" disabled={!canWrite} aria-label={`كمية ${l.name}`} aria-invalid={errors[`q${i}`] ? true : undefined} value={l.quantity}
                            onChange={(e) => setLines((ls) => ls.map((x, n) => (n === i ? { ...x, quantity: e.target.value } : x)))} /><span className="muted">{l.unit}</span></div>
                          {errors[`q${i}`] && <span className="field-error">{errors[`q${i}`]}</span>}</td>
                        {prep && <td className="end num">{saved && Number(l.quantity) === saved.quantity ? (saved.unitCost ? money(saved.cost) : <Badge tone="warning">بلا تكلفة</Badge>) : <span className="muted">بعد الحفظ</span>}</td>}
                        {canWrite && <td className="actions"><IconButton size="sm" destructive label={`إزالة ${l.name}`} icon={<Trash2 />} onClick={() => setLines((ls) => ls.filter((_, n) => n !== i))} /></td>}
                      </tr>
                    );
                  })}</tbody>
                </table>
              </div>
            )}
          </section>
        </div>
        <aside className="panel rs-recipe-aside" aria-labelledby="pc">
          <div className="card-head"><h2 id="pc">التكلفة التقديرية</h2></div>
          <div className="card-body stack">
            {prep ? (
              <>
                <div className={["stack", dirty && "rs-recipe-stale"].filter(Boolean).join(" ")}>
                  <div className="rs-recipe-hero">
                    <span className="stat-icon tone-sky" aria-hidden="true"><Scale /></span>
                    <span className="label">تكلفة الوحدة</span>
                    <span className="value"><span className="num">{cost(prep.estimatedUnitCost)}</span> <span className="rs-recipe-hero-unit">/ {prep.unit}</span></span>
                  </div>
                  <dl className="dl rs-recipe-dl">
                    <dt>تكلفة الدفعة</dt><dd className="num">{money(prep.batchCost)}</dd>
                    <dt>الناتج</dt><dd className="num">{quantity(prep.batchYield)} {prep.unit}</dd>
                  </dl>
                </div>
                {dirty && <p className="muted" role="status">احفظ لإعادة الحساب.</p>}
                {prep.missingCost > 0 && <p className="banner banner-warning rs-banner"><AlertTriangle aria-hidden="true" />{integer(prep.missingCost)} خامة بلا تكلفة بعد، فالتقدير أقل من الحقيقة.</p>}
                <p className="muted" style={{ fontSize: "var(--fs-xs)" }}>تقدير من متوسط تكلفة الخامات الآن. التكلفة الفعلية تُحسب عند كل إنتاج من الخامات المصروفة.</p>
              </>
            ) : <p className="muted">تُحسب في الخادم بعد الحفظ من متوسط تكلفة كل خامة.</p>}
          </div>
        </aside>
      </div>
      <FormError error={error} />
      {canWrite && (
        <div className="row rs-recipe-actions">
          <Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">{prep ? "حفظ التعديلات" : "إنشاء الوصفة التحضيرية"}</Button>
          <Link to={`/w/${tenantId}/prep-recipes`} className="btn btn-ghost">إلغاء</Link>
        </div>
      )}
    </form>
      {prep && <ProductionRuns tenantId={tenantId} prepRecipeId={prep.id} />}
      {producing && prep && <ProduceDialog tenantId={tenantId} prep={prep} onClose={() => setProducing(false)} />}
    </div>
  );
}
