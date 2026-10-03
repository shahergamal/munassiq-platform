import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowRight, Package, PackageCheck, Plus, Printer, Receipt, Trash2, Truck, Wallet } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Page } from "../../api/client";
import type { Ingredient, Location, Supplier } from "../../api/types";
import { useIdempotencyKey, useMe } from "../../app/session";
import { useInvalidate, useTenant } from "../../app/tenant";
import { RIYAL, cost, day, dayTime, integer, isoDay, money, percent, quantity, text } from "../../lib/format";
import { Button, IconButton } from "../../ui/Button";
import { DataTable } from "../../ui/DataTable";
import { useTablePrefs } from "../../ui/tablePrefs";
import { ConfirmDialog, Dialog } from "../../ui/Dialog";
import { Checkbox, focusFirstInvalid, SearchInput, SelectField, TextAreaField, TextField } from "../../ui/Field";
import { Badge, PageHeader, StatCard, StatusBadge } from "../../ui/Layout";
import { EmptyState, ErrorState, FormError, TableSkeleton } from "../../ui/States";
import { useToast } from "../../ui/Toast";
import { IngredientPicker } from "./pickers";

interface PoRow { id: string; number: number; status: string; supplierInvoice: string | null; total: number; vatAmount: number; grandTotal: number; createdAt: string; supplierName: string; locationName: string }

export function PurchasesPage() {
  const { tenantId, can, writable } = useTenant();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const prefs = useTablePrefs("purchases", { server: true, onSortChange: () => setPage(1) });
  useEffect(() => { const t = setTimeout(() => { setDebounced(q.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);
  const list = useQuery({
    queryKey: ["t", tenantId, "purchases", { q: debounced, status, page, sort: prefs.sortParam }],
    queryFn: ({ signal }) => api<Page<PoRow>>("GET", "/t/purchases", { tenant: tenantId, signal, query: { q: debounced, status, page, pageSize: 25, sort: prefs.sortParam } }),
    placeholderData: keepPreviousData,
  });
  const canCreate = can("purchases.create") && writable;
  const tabs = [["", "الكل"], ["draft", "مسودات"], ["approved", "بانتظار الاستلام"], ["partially_received", "مستلمة جزئياً"], ["received", "مستلمة"], ["closed", "مغلقة"], ["cancelled", "ملغاة"]] as const;
  return (
    <div className="page">
      <PageHeader eyebrow="المشتريات" title="أوامر الشراء" description="طلب شراء ← أمر شراء ← اعتماد ← استلام على شحنات ← مطابقة فاتورة المورد. الاستلام وحده يضيف المخزون ويحدّث متوسط التكلفة المرجح."
        actions={canCreate && <Link to={`/w/${tenantId}/purchases/new`} className="btn btn-primary"><Plus aria-hidden="true" />أمر شراء جديد</Link>} />
      <section className="panel">
        <DataTable caption="أوامر الشراء" query={list} rowKey={(r) => r.id} onPageChange={setPage} prefs={prefs}
          toolbar={<>
            <SearchInput placeholder="ابحث بالمورد أو رقم الأمر أو فاتورة المورد" value={q} onChange={setQ} />
            <div role="group" aria-label="تصفية حسب الحالة" className="row" style={{ gap: "var(--sp-1)" }}>
              {tabs.map(([v, label]) => (
                <button key={v} type="button" className={`btn btn-sm ${status === v ? "btn-secondary" : "btn-ghost"}`} aria-pressed={status === v} onClick={() => { setStatus(v); setPage(1); }}>{label}</button>
              ))}
            </div>
          </>}
          filtered={Boolean(debounced || status)} onClearFilters={() => { setQ(""); setStatus(""); }}
          onRowClick={(r) => navigate({ to: `/w/${tenantId}/purchases/${r.id}` })}
          empty={{ title: "لا توجد أوامر شراء بعد", body: "أنشئ أول أمر شراء لمورد، ثم اعتمده واستلمه ليدخل المخزون بتكلفته الفعلية.",
            action: canCreate ? <Link to={`/w/${tenantId}/purchases/new`} className="btn btn-primary"><Plus aria-hidden="true" />أمر شراء جديد</Link> : undefined }}
          columns={[
            { key: "number", sortKey: "number", header: "رقم الأمر", cell: (r) => <Link to={`/w/${tenantId}/purchases/${r.id}`}><strong className="num">PO-{r.number}</strong></Link> },
            { key: "supplier", sortKey: "supplierName", header: "المورد", cell: (r) => r.supplierName },
            { key: "loc", sortKey: "locationName", header: "موقع الاستلام", cell: (r) => r.locationName },
            { key: "inv", sortKey: "supplierInvoice", header: "فاتورة المورد", cell: (r) => <span className="num">{text(r.supplierInvoice)}</span> },
            { key: "date", sortKey: "createdAt", header: "التاريخ", cell: (r) => dayTime(r.createdAt) },
            { key: "total", sortKey: "grandTotal", header: "الإجمالي شامل الضريبة", numeric: true, cell: (r) => money(r.grandTotal) },
            { key: "status", sortKey: "status", header: "الحالة", cell: (r) => <StatusBadge kind="purchase" value={r.status} /> },
          ]} />
      </section>
    </div>
  );
}

interface Line { ingredient: Ingredient; quantity: string; unitPrice: string }

export function NewPurchasePage() {
  const { tenantId, ctx } = useTenant();
  const navigate = useNavigate();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [key, renewKey] = useIdempotencyKey();
  const form = useRef<HTMLFormElement>(null);
  const suppliers = useQuery({ queryKey: ["t", tenantId, "suppliers", "options"], queryFn: () => api<Page<Supplier>>("GET", "/t/suppliers", { tenant: tenantId, query: { isActive: "true", pageSize: 100 } }) });
  const locations = useQuery({ queryKey: ["t", tenantId, "locations", "options", "active"], queryFn: () => api<Page<Location>>("GET", "/t/locations", { tenant: tenantId, query: { isActive: "true", pageSize: 100 } }) });
  const [v, setV] = useState({ supplierId: "", locationId: "", supplierInvoice: "", discount: "0", shipping: "0", fees: "0", expectedDate: "", notes: "", costAllocation: "value" });
  const [lines, setLines] = useState<Line[]>([]);
  // null follows the supplier: VAT when it has a VAT number. The rate is the workspace's, applied on the server.
  const [vatOverride, setVatOverride] = useState<boolean | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { const only = locations.data?.items; if (only?.length === 1 && !v.locationId) setV((x) => ({ ...x, locationId: only[0]!.id })); }, [locations.data, v.locationId]);

  const num = (s: string) => Number(s.replace(/,/g, ""));
  // Display-only estimate from what the user typed; the server recomputes every amount in halalas on save.
  const estimate = Math.max(0, lines.reduce((a, l) => a + (num(l.quantity) || 0) * (num(l.unitPrice) || 0), 0) - (num(v.discount) || 0) + (num(v.shipping) || 0) + (num(v.fees) || 0));
  const supplier = suppliers.data?.items.find((s) => s.id === v.supplierId);
  const vatRate = ctx?.settings.vatRatePercent ?? 15;
  const vatOn = vatOverride ?? !!supplier?.taxId;
  const vatEstimate = vatOn ? Math.round(estimate * vatRate) / 100 : 0;

  async function submit() {
    const e: Record<string, string> = {};
    if (!v.supplierId) e.supplierId = "اختر المورد";
    if (!v.locationId) e.locationId = "اختر الموقع الذي ستُستلم فيه البضاعة";
    if (!lines.length) e.lines = "أضف صنفاً واحداً على الأقل من خانة «إضافة صنف»";
    lines.forEach((l, i) => {
      if (!(num(l.quantity) > 0)) e[`q${i}`] = "كمية أكبر من صفر";
      if (!(num(l.unitPrice) >= 0) || l.unitPrice.trim() === "") e[`p${i}`] = "أدخل السعر (صفر للعينات المجانية)";
    });
    for (const k of ["discount", "shipping", "fees"] as const) if (!(num(v[k]) >= 0)) e[k] = "رقم صفر أو أكبر";
    setErrors(e);
    if (Object.keys(e).length) return focusFirstInvalid(form.current);
    setBusy(true); setError(null);
    try {
      const r = await api<{ id: string }>("POST", "/t/purchases", {
        tenant: tenantId, idempotencyKey: key,
        body: {
          supplierId: v.supplierId, locationId: v.locationId, supplierInvoice: v.supplierInvoice.trim() || null,
          discount: num(v.discount) || 0, shipping: num(v.shipping) || 0, fees: num(v.fees) || 0, vatApplicable: vatOn, costAllocation: v.costAllocation,
          expectedDate: v.expectedDate || null, notes: v.notes.trim() || null,
          items: lines.map((l) => ({ ingredientId: l.ingredient.id, quantity: num(l.quantity), unitPrice: num(l.unitPrice) })),
        },
      });
      renewKey();
      toast.success("تم حفظ أمر الشراء كمسودة");
      await invalidate("purchases");
      navigate({ to: `/w/${tenantId}/purchases/${r.id}` });
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fieldErrors);
      setError(err);
    } finally { setBusy(false); }
  }

  if (suppliers.isError || locations.isError) return <div className="page"><ErrorState error={suppliers.error ?? locations.error} onRetry={() => { void suppliers.refetch(); void locations.refetch(); }} /></div>;
  const noSuppliers = suppliers.data && suppliers.data.items.length === 0;
  const noLocations = locations.data && locations.data.items.length === 0;

  return (
    <form ref={form} className="page" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <PageHeader eyebrow="أوامر الشراء" title="أمر شراء جديد" description="يُحفظ كمسودة. يعتمده صاحب الصلاحية، ثم يُستلم فيدخل المخزون."
        actions={<Link to={`/w/${tenantId}/purchases`} className="btn btn-ghost"><ArrowRight aria-hidden="true" />رجوع للقائمة</Link>} />
      {(noSuppliers || noLocations) && (
        <EmptyState title="تحتاج مورداً وموقعاً أولاً" action={<div className="row">{noSuppliers && <Link className="btn btn-secondary" to={`/w/${tenantId}/suppliers`}>إضافة مورد</Link>}{noLocations && <Link className="btn btn-secondary" to={`/w/${tenantId}/locations`}>إضافة موقع</Link>}</div>}>
          أمر الشراء يُصدر لمورد ويُستلم في أحد مستودعاتك أو مواقعك.
        </EmptyState>
      )}
      <section className="panel panel-pad form-section" aria-labelledby="po-head">
        <h2 id="po-head">المورد والاستلام</h2>
        <div className="form-grid">
          <SelectField label="المورد" required placeholder={suppliers.isPending ? "جارٍ التحميل…" : "اختر المورد"} value={v.supplierId} onChange={(e) => { setV({ ...v, supplierId: e.target.value }); setVatOverride(null); }} error={errors.supplierId}
            options={(suppliers.data?.items ?? []).map((s) => ({ value: s.id, label: s.name }))} />
          <SelectField label="موقع الاستلام" required placeholder={locations.isPending ? "جارٍ التحميل…" : "اختر الموقع"} value={v.locationId} onChange={(e) => setV({ ...v, locationId: e.target.value })} error={errors.locationId}
            options={(locations.data?.items ?? []).map((l) => ({ value: l.id, label: l.name }))} />
          <TextField label="تاريخ التوريد المتوقع" optional type="date" min={isoDay()} value={v.expectedDate} onChange={(e) => setV({ ...v, expectedDate: e.target.value })} hint="يُقاس عليه التزام المورد بالمواعيد" />
        </div>
        <TextAreaField label="ملاحظات للمورد" optional rows={2} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} />
      </section>

      <section className="panel" aria-labelledby="po-lines">
        <div className="card-head"><h2 id="po-lines">الأصناف</h2>{lines.length > 0 && <span className="badge badge-neutral"><span className="num">{integer(lines.length)}</span>&nbsp;صنف</span>}<span className="spacer" /><span className="muted" style={{ fontSize: "var(--fs-xs)" }}>الأسعار قبل الضريبة وبوحدة الشراء</span></div>
        <div className="card-body pf-picker">
          <IngredientPicker tenantId={tenantId} label="إضافة صنف" exclude={lines.map((l) => l.ingredient.id)} error={errors.lines}
            onPick={(i) => setLines((ls) => [...ls, { ingredient: i, quantity: "1", unitPrice: "" }])} />
        </div>
        {lines.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <caption className="sr-only">أصناف أمر الشراء</caption>
              <thead><tr><th scope="col">المادة</th><th scope="col">الكمية</th><th scope="col">سعر الوحدة ({RIYAL})</th><th scope="col" className="end">يعادل</th><th scope="col"><span className="sr-only">حذف</span></th></tr></thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={l.ingredient.id}>
                    <td><strong>{l.ingredient.name}</strong><div className="muted" style={{ fontSize: "var(--fs-xs)" }}>بالـ{l.ingredient.purchaseUnitName}</div></td>
                    <td style={{ minWidth: 120 }}><input className="input num" inputMode="decimal" aria-label={`كمية ${l.ingredient.name}`} aria-invalid={errors[`q${i}`] ? true : undefined} value={l.quantity} onChange={(e) => setLines((ls) => ls.map((x, n) => (n === i ? { ...x, quantity: e.target.value } : x)))} />{errors[`q${i}`] && <span className="field-error">{errors[`q${i}`]}</span>}</td>
                    <td style={{ minWidth: 140 }}><input className="input num" inputMode="decimal" aria-label={`سعر ${l.ingredient.name}`} aria-invalid={errors[`p${i}`] ? true : undefined} value={l.unitPrice} onChange={(e) => setLines((ls) => ls.map((x, n) => (n === i ? { ...x, unitPrice: e.target.value } : x)))} />{errors[`p${i}`] && <span className="field-error">{errors[`p${i}`]}</span>}</td>
                    <td className="end muted">{quantity((num(l.quantity) || 0) * l.ingredient.purchaseToBase)} {l.ingredient.baseUnit}</td>
                    <td className="actions"><IconButton size="sm" destructive label={`إزالة ${l.ingredient.name} من الأمر`} icon={<Trash2 />} onClick={() => setLines((ls) => ls.filter((_, n) => n !== i))} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel panel-pad form-section" aria-labelledby="po-landed">
        <h2 id="po-landed">التكلفة الواصلة والضريبة</h2>
        <p className="muted" style={{ fontSize: "var(--fs-sm)" }}>الخصم يُطرح والشحن والرسوم تُضاف، وتوزَّع على الأصناف بنسبة قيمتها عند الاستلام. الضريبة تُستردّ فلا تدخل تكلفة المخزون، لكنها تُضاف لمستحق المورد.</p>
        <div className="form-grid">
          <TextField label={`خصم المورد (${RIYAL})`} numeric value={v.discount} onChange={(e) => setV({ ...v, discount: e.target.value })} error={errors.discount} />
          <TextField label={`الشحن (${RIYAL})`} numeric value={v.shipping} onChange={(e) => setV({ ...v, shipping: e.target.value })} error={errors.shipping} />
          <TextField label={`جمارك ورسوم أخرى (${RIYAL})`} numeric value={v.fees} onChange={(e) => setV({ ...v, fees: e.target.value })} error={errors.fees} hint="تأمين، جمارك، تخليص." />
          {(num(v.shipping) > 0 || num(v.fees) > 0) && (
            <SelectField label="توزيع الشحن والرسوم على الأصناف" required value={v.costAllocation} onChange={(e) => setV({ ...v, costAllocation: e.target.value })}
              options={[{ value: "value", label: "حسب القيمة" }, { value: "weight", label: "حسب الوزن" }, { value: "quantity", label: "حسب الكمية" }]}
              hint="يدخل في تكلفة كل صنف عند الاستلام. الوزن للأصناف المقاسة بالوزن فقط." />
          )}
        </div>
        <Checkbox label={`فاتورة المورد تشمل ضريبة القيمة المضافة ${percent(vatRate)}`} checked={vatOn} onChange={(e) => setVatOverride(e.target.checked)} />
        {supplier && <p className="muted pf-under-check" style={{ fontSize: "var(--fs-xs)" }}>
          {supplier.taxId ? <>المورد مسجل ضريبياً (<span className="num">{supplier.taxId}</span>)</> : "المورد بلا رقم ضريبي في بياناته"}{vatOverride !== null ? " · غيّرتَ الاختيار يدوياً" : ""}
        </p>}
      </section>

      <FormError error={error} />
      <div className="pf-form-foot">
        <Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">حفظ كمسودة</Button>
        <Link to={`/w/${tenantId}/purchases`} className="btn btn-ghost">إلغاء</Link>
        <span className="spacer" />
        <span>
          <span className="muted">قبل الضريبة <span className="num">{money(estimate)}</span> · الضريبة <span className="num">{money(vatEstimate)}</span> · </span>
          الإجمالي التقديري: <strong className="num">{money(estimate + vatEstimate)}</strong> <span className="muted" style={{ fontSize: "var(--fs-xs)" }}>(يُحسب نهائياً في الخادم)</span>
        </span>
      </div>
    </form>
  );
}

interface PoDetail {
  id: string; number: number; status: string; supplierInvoice: string | null; subtotal: number; discount: number; shipping: number; fees: number; total: number; vatRate: number; vatAmount: number; grandTotal: number;
  createdBy: string; createdAt: string; approvedAt: string | null; receivedAt: string | null; supplierName: string; locationName: string; supplierId: string; locationId: string;
  items: { ingredientId: string; name: string; sku: string; purchaseUnit: string; quantity: number; unitPrice: number; lineTotal: number; receivedUnitCost: number | null; receivedQuantity: number }[];
  expectedDate: string | null; notes: string | null; closedReason: string | null; requisitionId: string | null; requisitionNumber: number | null;
  supplierTaxId: string | null; supplierPhone: string | null; paymentTermsDays: number;
  receipts: { id: string; number: number; receivedOn: string; supplierInvoice: string | null; grandTotal: number; invoiceAmount: number | null; invoiceVariance: number | null; rejectedLines: number }[];
}

export function PurchaseDetailPage() {
  const { tenantId, ctx, can, writable } = useTenant();
  const { poId } = useParams({ strict: false }) as { poId: string };
  const me = useMe();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [confirm, setConfirm] = useState<"receive" | "cancel" | "close" | null>(null);
  const [closeReason, setCloseReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const po = useQuery({ queryKey: ["t", tenantId, "purchases", poId], queryFn: () => api<PoDetail>("GET", `/t/purchases/${poId}`, { tenant: tenantId }) });

  async function act(action: "approve" | "receive" | "cancel" | "close", success: string) {
    if (action === "close" && closeReason.trim().length < 3) return setActionError("اكتب سبب إغلاق الأمر");
    setBusy(action); setActionError(null);
    try {
      await api("POST", `/t/purchases/${poId}/${action}`, { tenant: tenantId, body: action === "close" ? { reason: closeReason.trim() } : {} });
      setConfirm(null);
      toast.success(success);
      await invalidate("purchases", "ingredients", "stock", "reports");
    } catch (err) { setActionError((err as Error).message); }
    finally { setBusy(null); }
  }

  if (po.isPending) return <div className="page"><TableSkeleton columns={5} rows={4} /></div>;
  if (po.isError) return <div className="page"><ErrorState error={po.error} onRetry={() => po.refetch()} /></div>;
  const p = po.data;
  const ownDraft = p.createdBy === me.data?.user.id && ctx?.role !== "owner";
  const canApprove = p.status === "draft" && can("purchases.approve") && writable;
  const canReceive = (p.status === "approved" || p.status === "partially_received") && can("goods_receipts.create") && writable;
  const canClose = p.status === "partially_received" && can("purchases.close") && writable;
  const anyReceived = ["partially_received", "received", "closed"].includes(p.status);
  const canCancel = (p.status === "draft" || p.status === "approved") && can("purchases.cancel") && writable;

  return (
    <div className="page">
      <PageHeader eyebrow="أمر شراء"
        title={<span className="pf-title"><span><span className="num">PO-{p.number}</span> · {p.supplierName}</span><StatusBadge kind="purchase" value={p.status} /></span>}
        description={<>الاستلام في {p.locationName} · أُنشئ {dayTime(p.createdAt)}</>}
        actions={<>
          <Link to={`/w/${tenantId}/purchases`} className="btn btn-ghost no-print"><ArrowRight aria-hidden="true" />القائمة</Link>
          <Button variant="ghost" className="no-print" icon={<Printer />} onClick={() => window.print()}>طباعة الأمر</Button>
          {canClose && <Button variant="ghost" className="no-print" onClick={() => { setActionError(null); setCloseReason(""); setConfirm("close"); }}>إغلاق المتبقي</Button>}
          {canCancel && <Button variant="ghost" destructive onClick={() => { setActionError(null); setConfirm("cancel"); }}>إلغاء الأمر</Button>}
          {canApprove && (ownDraft
            ? <span className="muted" style={{ fontSize: "var(--fs-sm)" }}>لا يمكنك اعتماد أمر أنشأته. يعتمده مستخدم آخر (فصل المهام).</span>
            : <Button variant="primary" loading={busy === "approve"} loadingText="جارٍ الاعتماد…" onClick={() => void act("approve", `تم اعتماد PO-${p.number}`)}>اعتماد الأمر</Button>)}
          {canReceive && <Button className="no-print" onClick={() => { setActionError(null); setConfirm("receive"); }}>استلام كل المتبقي</Button>}
          {canReceive && <Link to={`/w/${tenantId}/purchases/${p.id}/receive`} className="btn btn-primary no-print"><PackageCheck aria-hidden="true" />استلام شحنة</Link>}
          {anyReceived && can("purchase_returns.create") && writable && <Link to={`/w/${tenantId}/purchase-returns/new?supplierId=${p.supplierId}&locationId=${p.locationId}&poId=${p.id}`} className="btn btn-secondary">إرجاع للمورد</Link>}
        </>} />
      {actionError && !confirm && <FormError error={actionError} />}
      {p.status === "closed" && p.closedReason && <p className="banner banner-info ca-banner">أُغلق المتبقي من الأمر: {p.closedReason}</p>}
      {p.requisitionNumber && <p className="muted no-print">من طلب الشراء <Link to={`/w/${tenantId}/requisitions/${p.requisitionId}`} className="num">PR-{p.requisitionNumber}</Link></p>}

      <div className="stats stats-4 no-print">
        <StatCard label="الأصناف" value={integer(p.items.length)} note={`تُستلم في ${p.locationName}`} icon={<Package />} hue="sky" />
        <StatCard label="الإجمالي قبل الضريبة" value={money(p.total)} note="أساس تكلفة المخزون" icon={<Receipt />} hue="indigo" />
        <StatCard label="شحن ورسوم" value={money(p.shipping + p.fees)} note={p.discount > 0 ? `خصم المورد ${money(p.discount)}` : "تُوزَّع على الأصناف عند الاستلام"} icon={<Truck />} hue="orange" />
        <StatCard label="المستحق للمورد" value={money(p.grandTotal)} note={p.vatAmount > 0 ? `منها ضريبة ${money(p.vatAmount)}` : "بلا ضريبة قيمة مضافة"} icon={<Wallet />} hue="violet" />
      </div>

      <div className="dash-grid">
        <section className="panel acc-print" aria-labelledby="po-items-h">
          <div className="acc-print-only acc-print-head"><h2>أمر شراء PO-{p.number}</h2><span>المورد: {p.supplierName}{p.supplierTaxId ? ` · الرقم الضريبي ${p.supplierTaxId}` : ""}</span><span>التسليم في: {p.locationName}{p.expectedDate ? ` · قبل ${day(p.expectedDate)}` : ""} · شروط السداد {integer(p.paymentTermsDays)} يوماً</span>{p.notes && <span>ملاحظات: {p.notes}</span>}</div>
          <div className="toolbar"><h2 id="po-items-h">أصناف الأمر</h2><span className="badge badge-neutral"><span className="num">{integer(p.items.length)}</span>&nbsp;صنف</span></div>
          <div className="table-wrap">
            <table className="data-table">
              <caption className="sr-only">أصناف الأمر</caption>
              <thead><tr><th scope="col">المادة</th><th scope="col" className="end">الكمية</th><th scope="col" className="end">المستلم</th><th scope="col" className="end">سعر الوحدة</th><th scope="col" className="end">الإجمالي</th><th scope="col" className="end">التكلفة الواصلة لوحدة الأساس</th></tr></thead>
              <tbody>
                {p.items.map((i) => (
                  <tr key={i.ingredientId}>
                    <td><strong>{i.name}</strong> <span className="muted num">{i.sku}</span></td>
                    <td className="end num">{quantity(i.quantity)} {i.purchaseUnit}</td>
                    <td className="end num">{i.receivedQuantity >= i.quantity ? <Badge tone="success">{quantity(i.receivedQuantity)}</Badge> : i.receivedQuantity > 0 ? <Badge tone="warning">{quantity(i.receivedQuantity)}</Badge> : <span className="muted">—</span>}</td>
                    <td className="end num">{money(i.unitPrice)}</td>
                    <td className="end num">{money(i.lineTotal)}</td>
                    <td className="end num">{i.receivedUnitCost !== null ? cost(i.receivedUnitCost) : <span className="muted">عند الاستلام</span>}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr><td colSpan={4}>المجموع</td><td className="end num">{money(p.subtotal)}</td><td /></tr>
                {p.discount > 0 && <tr><td colSpan={4}>خصم المورد</td><td className="end num">− {money(p.discount)}</td><td /></tr>}
                {p.shipping + p.fees > 0 && <tr><td colSpan={4}>شحن ورسوم</td><td className="end num">{money(p.shipping + p.fees)}</td><td /></tr>}
                <tr><td colSpan={4}>الإجمالي قبل الضريبة</td><td className="end num">{money(p.total)}</td><td className="end muted" style={{ fontSize: "var(--fs-xs)" }}>أساس تكلفة المخزون</td></tr>
                <tr><td colSpan={4}>{p.vatAmount > 0 ? <>ضريبة القيمة المضافة <span className="num">{percent(p.vatRate)}</span></> : "بلا ضريبة قيمة مضافة"}</td><td className="end num">{money(p.vatAmount)}</td><td /></tr>
                <tr><td colSpan={4}><strong>المستحق للمورد</strong></td><td className="end num"><strong>{money(p.grandTotal)}</strong></td><td /></tr>
              </tfoot>
            </table>
          </div>
          <div className="doc-signatures acc-print-only"><span>أعدّه: ____________</span><span>اعتمده: ____________</span><span>المورد (استلام الأمر): ____________</span></div>
        </section>

        <section className="panel" aria-labelledby="po-facts-h">
          <div className="card-head"><h2 id="po-facts-h">بيانات الأمر</h2></div>
          <div className="card-body">
            <dl className="dl">
              <dt>المورد</dt><dd>{p.supplierName}</dd>
              <dt>موقع الاستلام</dt><dd>{p.locationName}</dd>
              <dt>فاتورة المورد</dt><dd><span className="num">{text(p.supplierInvoice)}</span></dd>
              <dt>أُنشئ</dt><dd>{dayTime(p.createdAt)}</dd>
              <dt>اعتُمد</dt><dd>{p.approvedAt ? dayTime(p.approvedAt) : <span className="muted">—</span>}</dd>
              <dt>استُلم</dt><dd>{p.receivedAt ? dayTime(p.receivedAt) : <span className="muted">—</span>}</dd>
              <dt>التوريد المتوقع</dt><dd>{day(p.expectedDate)}</dd>
              <dt>شروط السداد</dt><dd>{integer(p.paymentTermsDays)} يوماً</dd>
              {p.notes && <><dt>ملاحظات</dt><dd>{p.notes}</dd></>}
            </dl>
          </div>
        </section>
      </div>

      {p.receipts.length > 0 && (
        <section className="panel no-print" aria-labelledby="po-grn-h">
          <div className="card-head"><h2 id="po-grn-h">سندات الاستلام</h2><span className="badge badge-neutral"><span className="num">{integer(p.receipts.length)}</span>&nbsp;شحنة</span></div>
          <div className="table-wrap">
            <table className="data-table">
              <caption className="sr-only">سندات الاستلام</caption>
              <thead><tr><th scope="col">السند</th><th scope="col">التاريخ</th><th scope="col">فاتورة المورد</th><th scope="col" className="end">الإجمالي شامل الضريبة</th><th scope="col">المطابقة</th><th scope="col">الجودة</th></tr></thead>
              <tbody>{p.receipts.map((g) => (
                <tr key={g.id}>
                  <td><Link to={`/w/${tenantId}/goods-receipts/${g.id}`} className="num"><strong>GRN-{g.number}</strong></Link></td>
                  <td>{day(g.receivedOn)}</td>
                  <td>{g.supplierInvoice ? <span className="num">{g.supplierInvoice}</span> : <Badge tone="warning">غير مسجلة</Badge>}</td>
                  <td className="end num">{money(g.grandTotal)}</td>
                  <td>{g.invoiceAmount === null ? <span className="muted">—</span> : Math.abs(g.invoiceVariance ?? 0) < 0.01 ? <Badge tone="success">مطابقة</Badge> : <Badge tone="danger">فرق {money(g.invoiceVariance)}</Badge>}</td>
                  <td>{g.rejectedLines ? <Badge tone="warning">{integer(g.rejectedLines)} مرفوض</Badge> : <Badge tone="success">مقبول</Badge>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      )}

      <ConfirmDialog open={confirm === "receive"} onClose={() => setConfirm(null)} destructive={false}
        onConfirm={() => void act("receive", `تم استلام PO-${p.number} وإضافة ${integer(p.items.length)} صنف للمخزون`)} busy={busy === "receive"} error={actionError}
        title={`استلام كل المتبقي من PO-${p.number}`} confirmLabel="تأكيد الاستلام وإضافة المخزون"
        message={<>ستُسجَّل شحنة واحدة بكل الكميات المتبقية بأسعار الأمر إلى <strong>{p.locationName}</strong> ويُحدَّث متوسط التكلفة المرجح. لتسجيل رفض أو سعر مختلف أو فاتورة المورد استخدم «استلام شحنة». لا يمكن التراجع.</>} />
      <Dialog open={confirm === "close"} onClose={() => setConfirm(null)} busy={busy === "close"} title={`إغلاق المتبقي من PO-${p.number}`} onSubmit={() => void act("close", `أُغلق المتبقي من PO-${p.number}`)}
        footer={<><Button type="submit" variant="primary" loading={busy === "close"} loadingText="جارٍ الإغلاق…">إغلاق الأمر</Button><Button onClick={() => setConfirm(null)} autoFocus>إلغاء</Button></>}>
        <p>المستلم يبقى كما هو، ولن يُنتظر باقي الكميات من المورد. يظهر الأمر «مغلقاً» مع السبب.</p>
        <TextAreaField label="السبب" required rows={2} value={closeReason} onChange={(e) => setCloseReason(e.target.value)} />
        {actionError && <FormError error={actionError} />}
      </Dialog>
      <ConfirmDialog open={confirm === "cancel"} onClose={() => setConfirm(null)} onConfirm={() => void act("cancel", `تم إلغاء PO-${p.number}`)} busy={busy === "cancel"} error={actionError}
        title={`إلغاء PO-${p.number}`} confirmLabel="إلغاء أمر الشراء" message={<>سيُلغى أمر الشراء للمورد <strong>{p.supplierName}</strong> ولن يمكن اعتماده أو استلامه بعد ذلك.</>} />
    </div>
  );
}
