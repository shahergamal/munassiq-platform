import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { AlertTriangle, ArrowRight, Percent, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Page } from "../../api/client";
import { useInvalidate, useTenant } from "../../app/tenant";
import { RIYAL, integer, money, percent, quantity } from "../../lib/format";
import { Button, IconButton } from "../../ui/Button";
import { DataTable } from "../../ui/DataTable";
import { useTablePrefs } from "../../ui/tablePrefs";
import { ConfirmDialog } from "../../ui/Dialog";
import { focusFirstInvalid, SearchInput, TextField } from "../../ui/Field";
import { ActionMenu, Badge, PageHeader, StatusBadge } from "../../ui/Layout";
import { ErrorState, FormError, TableSkeleton } from "../../ui/States";
import { useToast } from "../../ui/Toast";
import { IngredientPicker } from "./pickers";
import { RecipeModifiers } from "./PosSetup";

interface RecipeRow { id: string; code: string; name: string; category: string | null; status: string; priceNet: number; packagingCost: number; ingredientCost: number; missingCost: number; totalCost: number; margin: number; foodCostPercent: number | null }

export function RecipesPage() {
  const { tenantId, can, writable } = useTenant();
  const navigate = useNavigate();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const prefs = useTablePrefs("recipes", { server: true, onSortChange: () => setPage(1) });
  const [deleting, setDeleting] = useState<RecipeRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [delError, setDelError] = useState<string | null>(null);
  useEffect(() => { const t = setTimeout(() => { setDebounced(q.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);
  const list = useQuery({
    queryKey: ["t", tenantId, "recipes", { q: debounced, status, page, sort: prefs.sortParam }],
    queryFn: ({ signal }) => api<Page<RecipeRow>>("GET", "/t/recipes", { tenant: tenantId, signal, query: { q: debounced, status, page, pageSize: 25, sort: prefs.sortParam } }),
    placeholderData: keepPreviousData,
  });
  const canCreate = can("recipes.create") && writable;
  const canEdit = can("recipes.edit") && writable;
  const canApprove = can("recipes.approve") && writable;
  const canDelete = can("recipes.delete") && writable;

  async function setRecipeStatus(r: RecipeRow, s: "approved" | "draft" | "archived") {
    try {
      await api("POST", `/t/recipes/${r.id}/status`, { tenant: tenantId, body: { status: s } });
      toast.success(s === "approved" ? `«${r.name}» معتمدة وتظهر في الكاشير` : s === "archived" ? `تمت أرشفة «${r.name}»` : `«${r.name}» عادت مسودة`);
      await invalidate("recipes");
    } catch (err) { toast.error((err as Error).message); }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setBusy(true); setDelError(null);
    try {
      await api("DELETE", `/t/recipes/${deleting.id}`, { tenant: tenantId });
      toast.success(`تم حذف «${deleting.name}»`);
      setDeleting(null);
      await invalidate("recipes");
    } catch (err) {
      setDelError(err instanceof ApiError && err.code === "reference_conflict" ? "الوصفة بيعت من قبل، لذا لا تُحذف حفاظاً على الفواتير. أرشفها بدلاً من ذلك." : (err as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <div className="page">
      <PageHeader eyebrow="الوصفات" title="وصفات المنيو" description="التكلفة من متوسط التكلفة المرجح الحالي لكل مكوّن بعد نسبة الاستفادة. المعتمدة فقط تظهر في الكاشير."
        actions={canCreate && <Link to={`/w/${tenantId}/recipes/new`} className="btn btn-primary"><Plus aria-hidden="true" />وصفة جديدة</Link>} />
      <section className="panel">
        <DataTable caption="وصفات المنيو" prefs={prefs} query={list} rowKey={(r) => r.id} onPageChange={setPage}
          toolbar={<>
            <SearchInput placeholder="ابحث باسم الوصفة أو رمزها" value={q} onChange={setQ} />
            <select className="select" aria-label="الحالة" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              <option value="">كل الحالات</option><option value="approved">المعتمدة</option><option value="draft">المسودات</option><option value="archived">المؤرشفة</option>
            </select>
          </>}
          filtered={Boolean(debounced || status)} onClearFilters={() => { setQ(""); setStatus(""); }}
          onRowClick={(r) => navigate({ to: `/w/${tenantId}/recipes/${r.id}` })}
          empty={{ title: "لا توجد وصفات بعد", body: "أنشئ وصفة لكل صنف في المنيو لتعرف تكلفته الحقيقية وتبيعه من الكاشير.",
            action: canCreate ? <Link to={`/w/${tenantId}/recipes/new`} className="btn btn-primary"><Plus aria-hidden="true" />وصفة جديدة</Link> : undefined }}
          columns={[
            { key: "name", sortKey: "name", header: "الوصفة", cell: (r) => <Link to={`/w/${tenantId}/recipes/${r.id}`}><strong>{r.name}</strong></Link> },
            { key: "code", sortKey: "code", header: "الرمز", cell: (r) => <span className="num">{r.code}</span> },
            { key: "price", sortKey: "priceNet", header: "سعر البيع قبل الضريبة", numeric: true, cell: (r) => money(r.priceNet) },
            { key: "cost", sortKey: "totalCost", header: "التكلفة", numeric: true, cell: (r) => <span className="rs-num-cell">{r.missingCost > 0 && <Badge tone="warning">ناقصة</Badge>}{money(r.totalCost)}</span> },
            { key: "margin", sortKey: "margin", header: "هامش المساهمة", numeric: true, cell: (r) => money(r.margin) },
            { key: "fc", sortKey: "foodCostPercent", header: "تكلفة الطعام", numeric: true, cell: (r) => percent(r.foodCostPercent) },
            { key: "status", sortKey: "status", header: "الحالة", cell: (r) => <StatusBadge kind="recipe" value={r.status} /> },
          ]}
          actions={canEdit || canApprove || canDelete ? (r) => (
            <ActionMenu label={`إجراءات الوصفة ${r.name}`} items={[
              { label: canEdit ? "فتح وتعديل" : "فتح", onSelect: () => navigate({ to: `/w/${tenantId}/recipes/${r.id}` }) },
              ...(canApprove ? [
              ...(r.status !== "approved" ? [{ label: "اعتماد للبيع", onSelect: () => void setRecipeStatus(r, "approved") }] : [{ label: "إرجاع لمسودة (تختفي من الكاشير)", onSelect: () => void setRecipeStatus(r, "draft") }]),
              ...(r.status !== "archived" ? [{ label: "أرشفة", onSelect: () => void setRecipeStatus(r, "archived") }] : []),
              ] : []),
              ...(canDelete ? [{ label: "حذف", danger: true, separated: true, onSelect: () => { setDelError(null); setDeleting(r); } }] : []),
            ]} />
          ) : undefined} />
      </section>
      <ConfirmDialog open={Boolean(deleting)} onClose={() => setDeleting(null)} onConfirm={() => void confirmDelete()} busy={busy} error={delError}
        title="حذف وصفة" confirmLabel="حذف الوصفة نهائياً" message={<>ستُحذف الوصفة <strong>«{deleting?.name}»</strong> ومكوناتها نهائياً. الوصفات المباعة لا تُحذف، بل تؤرشف.</>} />
    </div>
  );
}

interface Preview {
  lines: { ingredientId: string; name: string; unit: string; quantity: number; rawQuantity: number; unitCost: number; cost: number; missingCost: boolean }[];
  ingredientCost: number; totalCost: number; margin: number; foodCostPercent: number | null; missingCost: number;
}
interface RecipeDetail { id: string; code: string; name: string; category: string | null; status: string; priceNet: number; packagingCost: number; items: { ingredientId: string; name: string; baseUnit: string; quantity: number; yieldPercentage: number }[] }
interface EditLine { ingredientId: string; name: string; unit: string; yieldPercentage: number; quantity: string }

export function RecipeEditorPage() {
  const { tenantId, can, writable } = useTenant();
  const { recipeId } = useParams({ strict: false }) as { recipeId?: string };
  const isNew = !recipeId || recipeId === "new";
  const existing = useQuery({ enabled: !isNew, queryKey: ["t", tenantId, "recipes", recipeId], queryFn: () => api<RecipeDetail>("GET", `/t/recipes/${recipeId}`, { tenant: tenantId }) });
  if (!isNew && existing.isPending) return <div className="page"><TableSkeleton columns={4} rows={5} /></div>;
  if (!isNew && existing.isError) return <div className="page"><ErrorState error={existing.error} onRetry={() => existing.refetch()} /></div>;
  return <RecipeEditor key={recipeId ?? "new"} tenantId={tenantId} recipe={isNew ? null : existing.data!} readOnly={!(can(isNew ? "recipes.create" : "recipes.edit") && writable)} />;
}

function RecipeEditor({ tenantId, recipe, readOnly }: { tenantId: string; recipe: RecipeDetail | null; readOnly: boolean }) {
  const navigate = useNavigate();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const form = useRef<HTMLFormElement>(null);
  const [v, setV] = useState({ name: recipe?.name ?? "", code: recipe?.code ?? "", category: recipe?.category ?? "", priceNet: recipe ? String(recipe.priceNet) : "", packagingCost: recipe ? String(recipe.packagingCost) : "0" });
  const [lines, setLines] = useState<EditLine[]>(recipe?.items.map((i) => ({ ingredientId: i.ingredientId, name: i.name, unit: i.baseUnit, yieldPercentage: i.yieldPercentage, quantity: String(i.quantity) })) ?? []);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<"save" | "approve" | null>(null);

  const num = (s: string) => Number(s.replace(/,/g, ""));
  const previewBody = { priceNet: num(v.priceNet) || 0, packagingCost: num(v.packagingCost) || 0, items: lines.filter((l) => num(l.quantity) > 0).map((l) => ({ ingredientId: l.ingredientId, quantity: num(l.quantity) })) };
  const [debouncedBody, setDebouncedBody] = useState(previewBody);
  const bodyKey = JSON.stringify(previewBody);
  useEffect(() => { const t = setTimeout(() => setDebouncedBody(JSON.parse(bodyKey)), 350); return () => clearTimeout(t); }, [bodyKey]);
  const preview = useQuery({
    queryKey: ["t", tenantId, "recipes", "preview", debouncedBody],
    queryFn: ({ signal }) => api<Preview>("POST", "/t/recipes/cost-preview", { tenant: tenantId, body: debouncedBody, signal }),
    placeholderData: keepPreviousData,
  });
  const lineCost = new Map((preview.data?.lines ?? []).map((l) => [l.ingredientId, l]));
  const stale = JSON.stringify(debouncedBody) !== bodyKey || preview.isFetching;

  async function save(approve: boolean) {
    const e: Record<string, string> = {};
    if (v.name.trim().length < 2) e.name = "أدخل اسم الصنف كما يظهر في المنيو";
    if (!/^[A-Za-z0-9_-]{1,30}$/.test(v.code.trim())) e.code = "رمز بالإنجليزية والأرقام، مثل BRG-01";
    if (!(num(v.priceNet) >= 0) || v.priceNet.trim() === "") e.priceNet = "أدخل سعر البيع قبل الضريبة";
    if (!(num(v.packagingCost) >= 0)) e.packagingCost = "رقم صفر أو أكبر";
    if (!lines.length) e.lines = "أضف مكوناً واحداً على الأقل";
    lines.forEach((l, i) => { if (!(num(l.quantity) > 0)) e[`q${i}`] = "كمية أكبر من صفر"; });
    setErrors(e);
    if (Object.keys(e).length) return focusFirstInvalid(form.current);
    setBusy(approve ? "approve" : "save"); setError(null);
    const body = { name: v.name.trim(), code: v.code.trim(), category: v.category.trim() || null, priceNet: num(v.priceNet), packagingCost: num(v.packagingCost) || 0, items: lines.map((l) => ({ ingredientId: l.ingredientId, quantity: num(l.quantity) })) };
    try {
      let id = recipe?.id;
      if (id) await api("PUT", `/t/recipes/${id}`, { tenant: tenantId, body });
      else id = (await api<{ id: string }>("POST", "/t/recipes", { tenant: tenantId, body })).id;
      if (approve) await api("POST", `/t/recipes/${id}/status`, { tenant: tenantId, body: { status: "approved" } });
      toast.success(approve ? `تم حفظ «${body.name}» واعتمادها للبيع` : `تم حفظ «${body.name}»`);
      await invalidate("recipes");
      if (!recipe) navigate({ to: `/w/${tenantId}/recipes/${id}` });
    } catch (err) {
      if (err instanceof ApiError && err.code === "duplicate") setErrors({ code: "هذا الرمز مستخدم لوصفة أخرى" });
      else if (err instanceof ApiError) setErrors(err.fieldErrors);
      setError(err);
    } finally { setBusy(null); }
  }

  const p = preview.data;
  return (
    <form ref={form} className="page" noValidate onSubmit={(e) => { e.preventDefault(); void save((e.nativeEvent as SubmitEvent).submitter?.getAttribute("name") === "approve"); }}>
      <PageHeader eyebrow="وصفات المنيو"
        title={recipe ? <span className="rs-title">{recipe.name}<StatusBadge kind="recipe" value={recipe.status} /></span> : "وصفة جديدة"}
        description="الكميات صافية (بعد التنظيف) بوحدة أساس المادة. نسبة الاستفادة تُضاف تلقائياً."
        actions={<Link to={`/w/${tenantId}/recipes`} className="btn btn-ghost"><ArrowRight aria-hidden="true" />القائمة</Link>} />
      <div className="rs-recipe-layout">
        <div className="stack-lg">
          <fieldset className="panel panel-pad form-section" disabled={readOnly}>
            <legend className="sr-only">بيانات الصنف</legend>
            <h2>الصنف</h2>
            <div className="form-grid">
              <TextField label="اسم الصنف" required value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} error={errors.name} />
              <TextField label="الرمز" required dir="ltr" value={v.code} onChange={(e) => setV({ ...v, code: e.target.value })} error={errors.code} />
              <TextField label="الفئة في المنيو" optional value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })} hint="تُستخدم لتجميع الأصناف في الكاشير." />
              <TextField label={`سعر البيع قبل الضريبة (${RIYAL})`} required numeric value={v.priceNet} onChange={(e) => setV({ ...v, priceNet: e.target.value })} error={errors.priceNet} />
              <TextField label={`تكلفة التغليف (${RIYAL})`} numeric value={v.packagingCost} onChange={(e) => setV({ ...v, packagingCost: e.target.value })} error={errors.packagingCost} />
            </div>
          </fieldset>
          <section className="panel" aria-labelledby="rc-lines">
            <div className="card-head"><h2 id="rc-lines">المكونات</h2><span className="spacer" />{lines.length > 0 && <span className="count-dot tag-sky" title={`${integer(lines.length)} مكوّن`}><span className="num">{integer(lines.length)}</span><span className="sr-only"> مكوّن</span></span>}</div>
            {(!readOnly || lines.length === 0) && (
              <div className="card-body">
                {!readOnly && <div className="rs-recipe-picker"><IngredientPicker tenantId={tenantId} label="إضافة مكوّن" exclude={lines.map((l) => l.ingredientId)} error={errors.lines}
                  onPick={(i) => setLines((ls) => [...ls, { ingredientId: i.id, name: i.name, unit: i.baseUnit, yieldPercentage: i.yieldPercentage, quantity: "" }])} /></div>}
                {readOnly && lines.length === 0 && <p className="muted">لا توجد مكونات في هذه الوصفة.</p>}
              </div>
            )}
            {lines.length > 0 && (
              <div className="table-wrap">
                <table className="data-table">
                  <caption className="sr-only">مكونات الوصفة</caption>
                  <thead><tr><th scope="col">المكوّن</th><th scope="col">الكمية الصافية</th><th scope="col" className="end">الكمية الخام</th><th scope="col" className="end">التكلفة</th>{!readOnly && <th scope="col"><span className="sr-only">إزالة</span></th>}</tr></thead>
                  <tbody>
                    {lines.map((l, i) => {
                      const c = lineCost.get(l.ingredientId);
                      return (
                        <tr key={l.ingredientId}>
                          <td><strong>{l.name}</strong>{l.yieldPercentage < 100 && <div className="muted" style={{ fontSize: "var(--fs-xs)" }}>نسبة الاستفادة {percent(l.yieldPercentage)}</div>}</td>
                          <td className="rs-recipe-qty">
                            <div className="row">
                              <input className="input num" inputMode="decimal" disabled={readOnly} aria-label={`كمية ${l.name} بالـ${l.unit}`} aria-invalid={errors[`q${i}`] ? true : undefined} value={l.quantity} onChange={(e) => setLines((ls) => ls.map((x, n) => (n === i ? { ...x, quantity: e.target.value } : x)))} />
                              <span className="muted">{l.unit}</span>
                            </div>
                            {errors[`q${i}`] && <span className="field-error">{errors[`q${i}`]}</span>}
                          </td>
                          <td className="end num muted">{c ? `${quantity(c.rawQuantity)} ${l.unit}` : "—"}</td>
                          <td className="end num">{c ? (c.missingCost ? <Badge tone="warning">بلا تكلفة</Badge> : money(c.cost)) : "—"}</td>
                          {!readOnly && <td className="actions"><IconButton size="sm" destructive label={`إزالة ${l.name}`} icon={<Trash2 />} onClick={() => setLines((ls) => ls.filter((_, n) => n !== i))} /></td>}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          {recipe && <RecipeModifiers tenantId={tenantId} recipeId={recipe.id} canWrite={!readOnly} />}
        </div>

        <aside className="panel rs-recipe-aside" aria-labelledby="rc-cost" aria-live="polite" aria-busy={stale || undefined}>
          <div className="card-head"><h2 id="rc-cost">التكلفة الحية</h2></div>
          <div className="card-body stack">
            {preview.isError ? <ErrorState error={preview.error} onRetry={() => preview.refetch()} title="تعذر حساب التكلفة" /> : (
              <>
                <div className={["stack", stale && "rs-recipe-stale"].filter(Boolean).join(" ")}>
                  <div className="rs-recipe-hero">
                    <span className="stat-icon tone-green" aria-hidden="true"><Percent /></span>
                    <span className="label">نسبة تكلفة الطعام</span>
                    <span className="value num">{percent(p?.foodCostPercent)}</span>
                  </div>
                  <dl className="dl rs-recipe-dl">
                    <dt>تكلفة المكونات</dt><dd className="num">{money(p?.ingredientCost ?? 0)}</dd>
                    <dt>التغليف</dt><dd className="num">{money(num(v.packagingCost) || 0)}</dd>
                    <dt className="is-total">إجمالي التكلفة</dt><dd className="num is-total">{money(p?.totalCost ?? 0)}</dd>
                    <dt>سعر البيع</dt><dd className="num">{money(num(v.priceNet) || 0)}</dd>
                    <dt>هامش المساهمة</dt><dd className="num">{money(p?.margin ?? 0)}</dd>
                  </dl>
                </div>
                {p && p.missingCost > 0 && (
                  <p className="banner banner-warning rs-banner"><AlertTriangle aria-hidden="true" />
                    {p.missingCost} مكوّن لم يُشترَ بعد فتكلفته صفر، والتكلفة الظاهرة أقل من الحقيقية. استلم أمر شراء لها أولاً.</p>
                )}
                <p className="muted" style={{ fontSize: "var(--fs-xs)" }}>محسوبة في الخادم من متوسط التكلفة المرجح الحالي لكل مكوّن.</p>
              </>
            )}
          </div>
        </aside>
      </div>

      <FormError error={error} />
      {!readOnly && (
        <div className="row rs-recipe-actions">
          {recipe?.status === "approved"
            ? <Button type="submit" variant="primary" loading={busy === "save"} loadingText="جارٍ الحفظ…">حفظ التعديلات</Button>
            : <>
                <Button type="submit" name="approve" variant="primary" loading={busy === "approve"} loadingText="جارٍ الحفظ والاعتماد…" disabled={busy === "save"}>حفظ واعتماد للبيع</Button>
                <Button type="submit" loading={busy === "save"} loadingText="جارٍ الحفظ…" disabled={busy === "approve"}>حفظ كمسودة</Button>
              </>}
          <Link to={`/w/${tenantId}/recipes`} className="btn btn-ghost">إلغاء</Link>
        </div>
      )}
    </form>
  );
}
