import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowRight, Banknote, CircleCheck, FileText, Handshake, Plus, Printer, Truck, Undo2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage, type Page } from "../../api/client";
import type { Customer, Ingredient } from "../../api/types";
import { useIdempotencyKey } from "../../app/session";
import { useInvalidate, useTenant } from "../../app/tenant";
import { day, dayTime, integer, isoDay, money, percent, quantity, RIYAL } from "../../lib/format";
import { Button, IconButton } from "../../ui/Button";
import { DataTable } from "../../ui/DataTable";
import { ConfirmDialog, Dialog } from "../../ui/Dialog";
import { Checkbox, focusFirstInvalid, SearchInput, SelectField, TextAreaField, TextField } from "../../ui/Field";
import { ActionMenu, Badge, PageHeader, StatCard } from "../../ui/Layout";
import { EmptyState, ErrorState, FormError, TableSkeleton } from "../../ui/States";
import { useToast } from "../../ui/Toast";
import { StatusTabs, useLocations } from "./Inventory";
import { CustomerPicker, IngredientPicker } from "./pickers";

// Order to cash for factories: quotation → order (reserves stock, checks credit) → delivery notes → tax invoices from
// what was delivered → returns. Totals, availability, cost and tax come from the API.

const num = (s: string) => Number(s.replace(/,/g, ""));
type Tone = "neutral" | "info" | "success" | "warning" | "danger";
const STATUS: Record<string, [string, Tone]> = {
  quotation: ["عرض سعر", "neutral"], confirmed: ["أمر مؤكد", "info"], closed: ["مقفل", "success"], cancelled: ["ملغى", "danger"],
};
const DOC_KIND: Record<string, string> = { invoice: "فاتورة", prepayment: "دفعة مقدمة", credit_note: "إشعار دائن", debit_note: "إشعار مدين" };
const VAT_CATS: [string, string][] = [["S", "خاضع 15٪"], ["Z", "نسبة صفرية"], ["E", "معفى"]];
const ZERO_REASONS: [string, string][] = [["VATEX-SA-32", "صادرات السلع"], ["VATEX-SA-34-1", "النقل الدولي للسلع"], ["VATEX-SA-35", "الأدوية والمعدات الطبية"], ["VATEX-SA-36", "المعادن المؤهلة"], ["VATEX-SA-MLTRY", "السلع العسكرية المؤهلة"]];
const EXEMPT_REASONS: [string, string][] = [["VATEX-SA-29", "الخدمات المالية"], ["VATEX-SA-30", "التوريدات العقارية"]];

interface SoRow {
  id: string; number: number; status: string; orderDate: string; validUntil: string | null; deliveryDate: string | null; total: number; customerRef: string | null;
  customerId: string; customerName: string; deliveredRatio: number; invoicedRatio: number; expired: boolean; late: boolean;
}

export function SalesOrdersPage() {
  const { tenantId, can, writable } = useTenant();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [status, setStatus] = useState("open");
  const [page, setPage] = useState(1);
  useEffect(() => { const t = setTimeout(() => { setDebounced(q.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);
  const list = useQuery({ queryKey: ["t", tenantId, "sales-orders", { debounced, status, page }], placeholderData: keepPreviousData,
    queryFn: () => api<Page<SoRow> & { counts: Record<string, number> }>("GET", "/t/sales-orders", { tenant: tenantId, query: { q: debounced, status, page, pageSize: 25 } }) });
  const counts = list.data?.counts ?? {};
  const canCreate = can("sales_orders.create") && writable;
  const newLink = canCreate ? <Link to={`/w/${tenantId}/sales/orders/new`} className="btn btn-primary"><Plus aria-hidden="true" />عرض سعر جديد</Link> : undefined;
  return (
    <div className="page">
      <PageHeader eyebrow="المبيعات" title="عروض الأسعار وأوامر البيع"
        description="العرض يصبح أمراً يحجز المخزون ويتحقق من حد ائتمان العميل، ثم تُسلَّم البضاعة بإذن تسليم يقيد تكلفة المبيعات، وتصدر الفاتورة الضريبية بما سُلّم."
        actions={newLink} />
      <div className="stats">
        <StatCard label="أوامر مؤكدة مفتوحة" value={integer(counts.confirmed ?? 0)} icon={<Handshake />} hue="sky" />
        <StatCard label="عروض أسعار" value={integer(counts.quotation ?? 0)} icon={<FileText />} hue="indigo" />
        <StatCard label="مقفلة" value={integer(counts.closed ?? 0)} icon={<CircleCheck />} hue="green" />
      </div>
      <section className="panel" aria-label="أوامر البيع">
        <DataTable caption="عروض الأسعار وأوامر البيع" query={list} rowKey={(r) => r.id} onPageChange={setPage} onRowClick={(r) => navigate({ to: `/w/${tenantId}/sales/orders/${r.id}` })}
          filtered={Boolean(debounced) || status !== "open"} onClearFilters={() => { setQ(""); setStatus("open"); }}
          toolbar={<><SearchInput placeholder="ابحث برقم الأمر أو العميل أو مرجعه" value={q} onChange={setQ} />
            <StatusTabs value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={[["open", "المفتوحة"], ["quotation", "عروض الأسعار"], ["confirmed", "المؤكدة"], ["closed", "المقفلة"], ["", "الكل"]]} /></>}
          empty={{ title: "لا توجد عروض أو أوامر مفتوحة", body: "ابدأ بعرض سعر لعميل: الأسعار تُقترح من سعر بيع الصنف، والضريبة تُحسب في الخادم.", action: newLink }}
          columns={[
            { key: "number", sortKey: false, header: "الرقم", cell: (r) => <strong><bdi dir="ltr" className="num">SO-{r.number}</bdi></strong> },
            { key: "customerName", sortKey: false, header: "العميل", cell: (r) => <span className="stack-tight"><strong>{r.customerName}</strong>{r.customerRef && <span className="muted acc-small">مرجع العميل {r.customerRef}</span>}</span> },
            { key: "status", sortKey: false, header: "الحالة", cell: (r) => <span className="row" style={{ gap: "var(--sp-1)" }}><Badge tone={STATUS[r.status]![1]}>{STATUS[r.status]![0]}</Badge>{r.expired && <Badge tone="warning">انتهت صلاحيته</Badge>}{r.late && <Badge tone="danger">تسليم متأخر</Badge>}</span> },
            { key: "progress", sortKey: false, header: "سُلّم / فُوتر", numeric: true, cell: (r) => (r.status === "quotation" ? "—" : <>{percent(r.deliveredRatio * 100)} / {percent(r.invoicedRatio * 100)}</>) },
            { key: "deliveryDate", sortKey: false, header: "التسليم", cell: (r) => (r.deliveryDate ? day(r.deliveryDate) : "—") },
            { key: "total", sortKey: false, header: "الإجمالي", numeric: true, cell: (r) => money(r.total) },
          ]} />
      </section>
    </div>
  );
}

interface SoLine {
  id: string; lineNo: number; itemId: string; description: string; unit: string; quantity: number; unitPrice: number; discount: number; vatCategory: string; exemptionCode: string | null;
  deliveredQty: number; invoicedQty: number; toDeliver: number; toInvoice: number; overInvoiced: number; onHand: number; reserved: number; available: number;
}
interface SoDetail {
  id: string; number: number; status: string; orderDate: string; validUntil: string | null; deliveryDate: string | null; customerRef: string | null; notes: string | null;
  subtotal: number; discount: number; taxable: number; vat: number; total: number; createdAt: string; confirmedAt: string | null; closedAt: string | null; cancelledAt: string | null; cancelReason: string | null;
  locationId: string; locationName: string; customerId: string; customerName: string; customerPhone: string; customerType: string; customerVat: string | null; customerOtherId: string | null;
  customerCountry: string;
  creditLimit: number | null; paymentTermsDays: number | null;
  lines: SoLine[];
  deliveries: { id: string; kind: "delivery" | "return"; number: number; date: string; lines: { lineId: string; quantity: number; value: number; batches: { batchNo: string; expiryDate: string | null; quantity: number }[] }[]; value: number; reason: string | null; driver: string | null; createdAt: string }[];
  invoices: { id: string; kind: "invoice" | "prepayment" | "credit_note" | "debit_note"; number: string; invoiceType: string; date: string; total: number; prepaid: number; isExport: boolean }[];
  /** Advances received and not yet deducted by an invoice nor refunded. */
  unappliedPrepayments: { id: string; number: string; remaining: number }[];
  credit: { receivable: number; openOrders: number; limit: number; available: number } | null;
}

// ── Editor (new quotation, or editing one) ──────────────────────────────────────────────────────
interface ELine { key: string; itemId: string; name: string; unit: string; quantity: string; unitPrice: string; discount: string; vatCategory: string; exemptionCode: string }

export function SalesOrderEditorPage() {
  const { tenantId } = useTenant();
  const { orderId } = useParams({ strict: false }) as { orderId?: string };
  const existing = useQuery({ enabled: Boolean(orderId), queryKey: ["t", tenantId, "sales-orders", orderId], queryFn: () => api<SoDetail>("GET", `/t/sales-orders/${orderId}`, { tenant: tenantId }) });
  if (orderId && existing.isPending) return <div className="page"><TableSkeleton columns={5} rows={4} label="جارٍ تحميل العرض…" /></div>;
  if (orderId && existing.isError) return <div className="page"><ErrorState error={existing.error} onRetry={() => existing.refetch()} /></div>;
  return <SalesOrderForm key={orderId ?? "new"} tenantId={tenantId} order={existing.data ?? null} />;
}

function SalesOrderForm({ tenantId, order }: { tenantId: string; order: SoDetail | null }) {
  const navigate = useNavigate();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const locations = useLocations(tenantId);
  const [key, renewKey] = useIdempotencyKey();
  const form = useRef<HTMLFormElement>(null);
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(order ? { id: order.customerId, name: order.customerName } : null);
  const [v, setV] = useState({
    locationId: order?.locationId ?? "", validUntil: order?.validUntil ?? "", deliveryDate: order?.deliveryDate ?? "", customerRef: order?.customerRef ?? "", notes: order?.notes ?? "",
  });
  const [lines, setLines] = useState<ELine[]>(() => (order?.lines ?? []).map((l) => ({
    key: crypto.randomUUID(), itemId: l.itemId, name: l.description, unit: l.unit, quantity: String(l.quantity), unitPrice: String(l.unitPrice),
    discount: l.discount ? String(l.discount) : "", vatCategory: l.vatCategory, exemptionCode: l.exemptionCode ?? "" })));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const setLine = (i: number, p: Partial<ELine>) => setLines((ls) => ls.map((l, n) => (n === i ? { ...l, ...p } : l)));
  useEffect(() => { if (!v.locationId && locations.data?.items.length === 1) setV((x) => ({ ...x, locationId: locations.data!.items[0]!.id })); }, [locations.data, v.locationId]);
  const avail = useQuery({ enabled: Boolean(v.locationId && lines.length), placeholderData: keepPreviousData,
    queryKey: ["t", tenantId, "sales-orders", "availability", v.locationId, lines.map((l) => l.itemId).join(",")],
    queryFn: () => api<{ items: { itemId: string; available: number; onHand: number; reserved: number; salePrice: number | null }[] }>("GET", "/t/sales-orders/availability", { tenant: tenantId, query: { locationId: v.locationId, itemIds: lines.map((l) => l.itemId).join(","), customerId: customer?.id } }) });
  // The customer's list price replaces an empty price as soon as it is known.
  useEffect(() => {
    if (!avail.data) return;
    setLines((ls) => ls.map((l) => {
      const p = avail.data!.items.find((x) => x.itemId === l.itemId)?.salePrice;
      return l.unitPrice === "" && p != null ? { ...l, unitPrice: String(p) } : l;
    }));
  }, [avail.data]);
  const availOf = (id: string) => avail.data?.items.find((x) => x.itemId === id);

  async function submit() {
    const e: Record<string, string> = {};
    if (!customer) e.customerId = "اختر العميل";
    if (!v.locationId) e.locationId = "اختر موقع التسليم";
    if (!lines.length) e.lines = "أضف صنفاً واحداً على الأقل";
    lines.forEach((l, i) => {
      if (!(num(l.quantity) > 0)) e[`lines.${i}.quantity`] = "كمية أكبر من صفر";
      if (l.unitPrice.trim() === "" || !(num(l.unitPrice) >= 0)) e[`lines.${i}.unitPrice`] = "أدخل السعر";
      if (l.discount && !(num(l.discount) >= 0)) e[`lines.${i}.discount`] = "صفر أو أكثر";
      if (l.vatCategory !== "S" && !l.exemptionCode) e[`lines.${i}.exemptionCode`] = "اختر السبب";
    });
    if (v.validUntil && v.validUntil < isoDay()) e.validUntil = "تاريخ اليوم أو بعده";
    setErrors(e);
    if (Object.keys(e).length) return focusFirstInvalid(form.current);
    setBusy(true); setError(null);
    const body = {
      customerId: customer!.id, locationId: v.locationId, validUntil: v.validUntil || null, deliveryDate: v.deliveryDate || null,
      customerRef: v.customerRef.trim() || null, notes: v.notes.trim() || null,
      lines: lines.map((l) => ({ itemId: l.itemId, quantity: num(l.quantity), unitPrice: num(l.unitPrice), discount: num(l.discount || "0"), vatCategory: l.vatCategory, exemptionCode: l.exemptionCode || null })),
    };
    try {
      let id = order?.id;
      if (id) await api("PUT", `/t/sales-orders/${id}`, { tenant: tenantId, body });
      else { id = (await api<{ id: string }>("POST", "/t/sales-orders", { tenant: tenantId, idempotencyKey: key, body })).id; renewKey(); }
      toast.success(order ? "حُفظ عرض السعر" : "أُنشئ عرض السعر، والإجماليات محسوبة في الخادم");
      await invalidate("sales-orders");
      navigate({ to: `/w/${tenantId}/sales/orders/${id}` });
    } catch (err) { if (err instanceof ApiError) setErrors(err.fieldErrors); setError(err); } finally { setBusy(false); }
  }

  return (
    <form ref={form} className="page" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <PageHeader eyebrow="عروض الأسعار وأوامر البيع" title={order ? <>تعديل عرض السعر <bdi dir="ltr" className="num">SO-{order.number}</bdi></> : "عرض سعر جديد"}
        description="الأسعار قبل الضريبة لكل وحدة أساس. يُقترح سعر بيع الصنف، وتُحسب الضريبة والإجمالي في الخادم عند الحفظ."
        actions={<Link to={`/w/${tenantId}/sales/orders`} className="btn btn-ghost"><ArrowRight aria-hidden="true" />الأوامر</Link>} />
      <section className="panel panel-pad form-section" aria-labelledby="so-h">
        <h2 id="so-h">العميل والتسليم</h2>
        <div className="form-grid">
          {customer ? <div className="field"><span className="field-label">العميل</span><p className="acc-partner"><strong>{customer.name}</strong> <Button size="sm" variant="ghost" onClick={() => setCustomer(null)}>تغيير</Button></p></div>
            : <CustomerPicker tenantId={tenantId} label="العميل" required error={errors.customerId} onPick={(c: Customer) => setCustomer({ id: c.id, name: c.name })} hint="المنشأة تحتاج رقمها الضريبي وعنوانها الوطني لتصدر لها فاتورة ضريبية." />}
          <SelectField label="التسليم من" required placeholder="اختر الموقع" value={v.locationId} onChange={(e) => setV({ ...v, locationId: e.target.value })} error={errors.locationId}
            options={(locations.data?.items ?? []).map((l) => ({ value: l.id, label: l.name }))} hint="يُحجز المخزون منه عند تأكيد الأمر." />
          <TextField label="صالح حتى" optional type="date" min={isoDay()} value={v.validUntil} onChange={(e) => setV({ ...v, validUntil: e.target.value })} error={errors.validUntil} />
          <TextField label="تاريخ التسليم المطلوب" optional type="date" min={isoDay()} value={v.deliveryDate} onChange={(e) => setV({ ...v, deliveryDate: e.target.value })} />
          <TextField label="رقم أمر الشراء لدى العميل" optional dir="ltr" value={v.customerRef} onChange={(e) => setV({ ...v, customerRef: e.target.value })} />
        </div>
      </section>
      <section className="panel panel-pad form-section" aria-labelledby="sl-h">
        <h2 id="sl-h">الأصناف</h2>
        {lines.length > 0 && (
          <ol className="acc-lines">
            {lines.map((l, i) => {
              const a = availOf(l.itemId);
              const short = a && num(l.quantity) > a.available;
              return (
                <li key={l.key} className="acc-line">
                  <div className="acc-line-grid so-line-grid">
                    <div className="field"><span className="field-label">الصنف {i + 1}</span><strong>{l.name}</strong>
                      {a && <span className={short ? "field-error" : "muted acc-small"}>متاح {quantity(a.available)} {l.unit}{a.reserved ? ` (محجوز ${quantity(a.reserved)})` : ""}</span>}</div>
                    <TextField label={`الكمية (${l.unit})`} required numeric value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} error={errors[`lines.${i}.quantity`]} />
                    <TextField label={`السعر (${RIYAL})`} required numeric value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} error={errors[`lines.${i}.unitPrice`]} />
                    <TextField label="خصم البند" optional numeric value={l.discount} onChange={(e) => setLine(i, { discount: e.target.value })} error={errors[`lines.${i}.discount`]} />
                    <SelectField label="الضريبة" required value={l.vatCategory} onChange={(e) => setLine(i, { vatCategory: e.target.value, exemptionCode: "" })} options={VAT_CATS.map(([value, label]) => ({ value, label }))} />
                    <IconButton label={`حذف ${l.name}`} icon={<X />} destructive className="acc-line-remove" onClick={() => setLines((ls) => ls.filter((_, n) => n !== i))} />
                  </div>
                  {l.vatCategory !== "S" && (
                    <SelectField label="سبب النسبة الصفرية أو الإعفاء" required placeholder="اختر" value={l.exemptionCode} onChange={(e) => setLine(i, { exemptionCode: e.target.value })} error={errors[`lines.${i}.exemptionCode`]}
                      options={(l.vatCategory === "Z" ? ZERO_REASONS : EXEMPT_REASONS).map(([value, label]) => ({ value, label }))} />
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {errors.lines && <span className="field-error" role="alert">{errors.lines}</span>}
        <IngredientPicker tenantId={tenantId} label="إضافة صنف" types="finished,semi_finished,raw,packaging" exclude={lines.map((l) => l.itemId)} placeholder="اسم المنتج أو رمزه"
          onPick={(i: Ingredient) => setLines((ls) => [...ls, { key: crypto.randomUUID(), itemId: i.id, name: i.name, unit: i.baseUnit, quantity: "", unitPrice: v.locationId ? "" : i.salePrice != null ? String(i.salePrice) : "", discount: "", vatCategory: "S", exemptionCode: "" }])} />
      </section>
      <section className="panel panel-pad form-section"><TextAreaField label="ملاحظات وشروط العرض" optional rows={3} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></section>
      <FormError error={error} />
      <div className="pf-form-foot">
        <Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">{order ? "حفظ عرض السعر" : "حفظ عرض السعر"}</Button>
        <Link to={order ? `/w/${tenantId}/sales/orders/${order.id}` : `/w/${tenantId}/sales/orders`} className="btn btn-ghost">إلغاء</Link>
      </div>
    </form>
  );
}

// ── The order ───────────────────────────────────────────────────────────────────────────────────
export function SalesOrderPage() {
  const { tenantId, can, writable } = useTenant();
  const { orderId } = useParams({ strict: false }) as { orderId: string };
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [dialog, setDialog] = useState<"confirm" | "deliver" | "return" | "invoice" | "cancel" | "close" | "prepay" | null>(null);
  const [refunding, setRefunding] = useState<SoDetail["unappliedPrepayments"][number] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [short, setShort] = useState<{ name: string; required: number; available: number }[] | null>(null);
  const [reason, setReason] = useState("");
  const [printing, setPrinting] = useState<string | null>(null);
  // The delivery note prints on its own (A4), then the page comes back.
  useEffect(() => {
    if (!printing) return;
    const done = () => setPrinting(null);
    window.addEventListener("afterprint", done);
    const t = setTimeout(() => window.print(), 50);
    return () => { clearTimeout(t); window.removeEventListener("afterprint", done); };
  }, [printing]);
  const o = useQuery({ queryKey: ["t", tenantId, "sales-orders", orderId], queryFn: () => api<SoDetail>("GET", `/t/sales-orders/${orderId}`, { tenant: tenantId }) });
  if (o.isPending) return <div className="page"><TableSkeleton columns={6} rows={5} label="جارٍ تحميل أمر البيع…" /></div>;
  if (o.isError) return <div className="page"><ErrorState error={o.error} onRetry={() => o.refetch()} /></div>;
  const d = o.data;
  const refresh = () => invalidate("sales-orders", "stock", "ingredients", "accounting", "batches");
  const done = async (msg: string) => { toast.success(msg); setDialog(null); setShort(null); await refresh(); };
  async function confirm(backorder: boolean) {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ backorder: unknown[] }>("POST", `/t/sales-orders/${d.id}/confirm`, { tenant: tenantId, body: { backorder } });
      await done(r.backorder.length ? "تأكد الأمر، وبعض الكميات بانتظار الإنتاج أو الشراء" : "تأكد الأمر وحُجزت الكميات");
    } catch (e) {
      if (e instanceof ApiError && e.code === "insufficient_availability") setShort((e.details as { short: { name: string; required: number; available: number }[] }).short);
      else setErr(errorMessage(e));
    } finally { setBusy(false); }
  }
  async function end(kind: "cancel" | "close") {
    if (reason.trim().length < 3) return setErr("اذكر السبب");
    setBusy(true); setErr(null);
    try {
      await api("POST", `/t/sales-orders/${d.id}/${kind}`, { tenant: tenantId, body: { reason: reason.trim() } });
      await done(kind === "cancel" ? "أُلغي الأمر" : "أُقفل الأمر وأُفرج عن الكميات غير المسلّمة");
    } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  }
  const toDeliver = d.lines.some((l) => l.toDeliver > 0);
  const toInvoice = d.lines.some((l) => l.toInvoice > 0);
  const delivered = d.lines.some((l) => l.deliveredQty > 0);
  const w = writable;
  // Item, quantity, price, discount (+ delivered, invoiced once confirmed) (+ available while open).
  const cols = 4 + (d.status !== "quotation" ? 2 : 0) + (d.status !== "closed" && d.status !== "cancelled" ? 1 : 0);
  const primary = d.status === "quotation" && can("sales_orders.confirm") ? <Button variant="primary" icon={<CircleCheck />} onClick={() => { setErr(null); setShort(null); setDialog("confirm"); }}>تأكيد الأمر</Button>
    // Delivered and not yet billed comes first; then the rest of the delivery.
    : d.status === "confirmed" && toInvoice && can("sales_orders.invoice") ? <Button variant="primary" icon={<FileText />} onClick={() => setDialog("invoice")}>إصدار الفاتورة</Button>
    : d.status === "confirmed" && toDeliver && can("sales_orders.deliver") ? <Button variant="primary" icon={<Truck />} onClick={() => setDialog("deliver")}>تسليم</Button> : null;
  const advance = d.unappliedPrepayments.reduce((a, p) => a + p.remaining, 0);
  const more = [
    ...(d.status === "confirmed" && toDeliver && toInvoice && can("sales_orders.deliver") ? [{ label: "تسليم الباقي", onSelect: () => setDialog("deliver") }] : []),
    ...(d.status === "confirmed" && can("sales_orders.invoice") ? [{ label: "تسجيل دفعة مقدمة", onSelect: () => setDialog("prepay") }] : []),
    ...((d.status === "confirmed" || d.status === "closed") && delivered && can("sales_orders.deliver") ? [{ label: "مرتجع من العميل", onSelect: () => setDialog("return") }] : []),
    ...(d.status === "confirmed" && delivered && can("sales_orders.cancel") ? [{ label: "إقفال الأمر (تسليم ناقص)", separated: true, onSelect: () => { setErr(null); setReason(""); setDialog("close"); } }] : []),
    ...((d.status === "quotation" || (d.status === "confirmed" && !delivered)) && can("sales_orders.cancel") ? [{ label: "إلغاء", danger: true, separated: true, onSelect: () => { setErr(null); setReason(""); setDialog("cancel"); } }] : []),
  ];
  const note = printing ? d.deliveries.find((x) => x.id === printing) : undefined;
  return (
    <div className="page">
      {note && <DeliveryNote order={d} delivery={note} />}
      <div className={note ? "no-print stack-lg" : "stack-lg"}>
      <PageHeader eyebrow="عروض الأسعار وأوامر البيع"
        title={<span className="pf-title"><bdi dir="ltr" className="num">SO-{d.number}</bdi> · {d.customerName}<Badge tone={STATUS[d.status]![1]}>{STATUS[d.status]![0]}</Badge></span>}
        description={<>بتاريخ {day(d.orderDate)} · التسليم من {d.locationName}{d.deliveryDate ? ` · مطلوب ${day(d.deliveryDate)}` : ""}{d.validUntil && d.status === "quotation" ? ` · العرض صالح حتى ${day(d.validUntil)}` : ""}{d.customerRef ? ` · مرجع العميل ${d.customerRef}` : ""}</>}
        actions={<><Link to={`/w/${tenantId}/sales/orders`} className="btn btn-ghost"><ArrowRight aria-hidden="true" />الأوامر</Link>
          {d.status === "quotation" && can("sales_orders.create") && w && <Link to={`/w/${tenantId}/sales/orders/${d.id}/edit`} className="btn btn-secondary">تعديل العرض</Link>}
          {w && primary}{w && more.length > 0 && <ActionMenu label="إجراءات أخرى للأمر" items={more} />}</>} />
      {d.status === "cancelled" && <p className="banner banner-warning ca-banner">أُلغي في {dayTime(d.cancelledAt)}: {d.cancelReason}</p>}
      {d.lines.some((l) => l.overInvoiced > 0) && <p className="banner banner-warning ca-banner">أُرجعت كميات سبق فوترتها: أصدر إشعاراً دائناً على فاتورتها من «الفواتير الضريبية».</p>}

      <div className="stats">
        <StatCard label="الإجمالي شامل الضريبة" value={money(d.total)} icon={<Handshake />} hue="indigo" note={`قبل الضريبة ${money(d.taxable)} · الضريبة ${money(d.vat)}`} />
        {d.status !== "quotation" && <StatCard label="المسلّم" value={percent((d.lines.reduce((a, l) => a + l.deliveredQty, 0) / Math.max(1, d.lines.reduce((a, l) => a + l.quantity, 0))) * 100)} icon={<Truck />} hue="sky" note={`${integer(d.deliveries.filter((x) => x.kind === "delivery").length)} إذن تسليم`} />}
        {d.status !== "quotation" && <StatCard label="الفواتير" value={integer(d.invoices.filter((x) => x.kind === "invoice").length)} icon={<FileText />} hue="green"
          note={money(d.invoices.filter((x) => x.kind === "invoice").reduce((a, x) => a + x.total, 0))} />}
        {advance > 0 && <StatCard label="دفعات مقدمة لم تُخصم" value={money(advance)} icon={<Banknote />} hue="violet" note="تُخصم تلقائياً من الفاتورة التالية" />}
        {d.credit && <StatCard label="المتاح من حد الائتمان" value={money(d.credit.available)} icon={<CircleCheck />} hue={d.credit.available < 0 ? "red" : "amber"}
          note={`الحد ${money(d.credit.limit)} · المستحق ${money(d.credit.receivable)} · أوامر أخرى ${money(d.credit.openOrders)}`} />}
      </div>

      <section className="panel" aria-labelledby="sol-h">
        <div className="toolbar"><h2 id="sol-h">الأصناف</h2></div>
        <div className="table-wrap">
          <table className="data-table">
            <caption className="sr-only">أصناف الأمر</caption>
            <thead><tr><th scope="col">الصنف</th><th scope="col" className="end">الكمية</th><th scope="col" className="end">السعر</th><th scope="col" className="end">الخصم</th>
              {d.status !== "quotation" && <><th scope="col" className="end">المسلّم</th><th scope="col" className="end">المفوتر</th></>}
              {d.status !== "closed" && d.status !== "cancelled" && <th scope="col" className="end">المتاح للتسليم</th>}</tr></thead>
            <tbody>{d.lines.map((l) => (
              <tr key={l.id}>
                <td><strong>{l.description}</strong>{l.vatCategory !== "S" && <> <Badge tone="info">{l.vatCategory === "Z" ? "صفرية" : "معفى"}</Badge></>}</td>
                <td className="end num">{quantity(l.quantity)} {l.unit}</td>
                <td className="end num">{money(l.unitPrice)}</td>
                <td className="end num">{l.discount ? money(l.discount) : "—"}</td>
                {d.status !== "quotation" && <><td className="end num">{quantity(l.deliveredQty)}</td><td className="end num">{quantity(l.invoicedQty)}{l.overInvoiced > 0 && <> <Badge tone="warning">يحتاج إشعاراً</Badge></>}</td></>}
                {d.status !== "closed" && d.status !== "cancelled" && <td className="end num">{l.toDeliver > 0 && l.onHand < l.toDeliver ? <Badge tone="warning">{quantity(l.onHand)}</Badge> : quantity(d.status === "quotation" ? l.available : l.onHand)}</td>}
              </tr>
            ))}</tbody>
            <tfoot>
              <tr><td colSpan={cols - 1}>قبل الضريبة</td><td className="end num">{money(d.taxable)}</td></tr>
              <tr><td colSpan={cols - 1}>ضريبة القيمة المضافة</td><td className="end num">{money(d.vat)}</td></tr>
              <tr><td colSpan={cols - 1}><strong>الإجمالي</strong></td><td className="end num"><strong>{money(d.total)}</strong></td></tr>
            </tfoot>
          </table>
        </div>
      </section>

      {d.status !== "quotation" && (
        <section className="panel" aria-labelledby="sod-h">
          <div className="toolbar"><h2 id="sod-h">التسليمات والمرتجعات</h2></div>
          {d.deliveries.length === 0 ? <EmptyState title="لم يُسلَّم شيء بعد">إذن التسليم يُخرج البضاعة من {d.locationName} بتكلفتها ويقيد تكلفة المبيعات.</EmptyState> : (
            <div className="table-wrap">
              <table className="data-table">
                <caption className="sr-only">التسليمات</caption>
                <thead><tr><th scope="col">الرقم</th><th scope="col">التاريخ</th><th scope="col">الأصناف</th><th scope="col" className="end">التكلفة</th><th scope="col"><span className="sr-only">طباعة</span></th></tr></thead>
                <tbody>{d.deliveries.map((x) => (
                  <tr key={x.id}>
                    <td><Badge tone={x.kind === "return" ? "warning" : "neutral"}>{x.kind === "return" ? "مرتجع" : "تسليم"}</Badge> <span className="num">{x.number}</span></td>
                    <td>{day(x.date)}</td>
                    <td className="wrap">{x.lines.map((y) => { const l = d.lines.find((z) => z.id === y.lineId); return `${l?.description ?? ""} ${quantity(y.quantity)}${y.batches.length ? ` (${y.batches.map((b) => b.batchNo).join("، ")})` : ""}`; }).join(" · ")}
                      {x.driver && <span className="muted"> · السائق {x.driver}</span>}{x.reason && <span className="muted"> · {x.reason}</span>}</td>
                    <td className="end num">{money(x.value)}</td>
                    <td className="end">{x.kind === "delivery" && <IconButton label={`طباعة إذن التسليم ${x.number}`} icon={<Printer />} onClick={() => setPrinting(x.id)} />}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </section>
      )}
      {d.invoices.length > 0 && (
        <section className="panel" aria-labelledby="soi-h">
          <div className="toolbar"><h2 id="soi-h">الفواتير</h2></div>
          <div className="table-wrap">
            <table className="data-table">
              <caption className="sr-only">فواتير الأمر</caption>
              <thead><tr><th scope="col">المستند</th><th scope="col">النوع</th><th scope="col">التاريخ</th><th scope="col" className="end">الإجمالي</th><th scope="col" className="end">المخصوم من دفعات</th></tr></thead>
              <tbody>{d.invoices.map((x) => (
                <tr key={x.id}>
                  <td><Link to={`/w/${tenantId}/accounting/invoices/${x.id}`}><bdi dir="ltr" className="num">{x.number}</bdi></Link></td>
                  <td>{DOC_KIND[x.kind] ?? x.kind} {x.invoiceType === "standard" ? "ضريبية" : "مبسطة"}{x.isExport && <> <Badge tone="info">تصدير</Badge></>}</td>
                  <td>{day(x.date)}</td><td className="end num">{money(x.total)}</td><td className="end num">{x.prepaid ? money(x.prepaid) : "—"}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      )}
      {d.unappliedPrepayments.length > 0 && (
        <section className="panel" aria-labelledby="sop-h">
          <div className="toolbar"><h2 id="sop-h">الدفعات المقدمة المتبقية</h2></div>
          <p className="muted acc-small panel-pad">الفاتورة التالية على الأمر تخصمها تلقائياً. ما لن يُفوتر يُسترد بإشعار دائن على الدفعة.</p>
          <div className="table-wrap">
            <table className="data-table">
              <caption className="sr-only">الدفعات المقدمة غير المخصومة</caption>
              <thead><tr><th scope="col">الدفعة</th><th scope="col" className="end">المتبقي</th><th scope="col"><span className="sr-only">إجراءات</span></th></tr></thead>
              <tbody>{d.unappliedPrepayments.map((p) => (
                <tr key={p.id}>
                  <td><Link to={`/w/${tenantId}/accounting/invoices/${p.id}`}><bdi dir="ltr" className="num">{p.number}</bdi></Link></td>
                  <td className="end num">{money(p.remaining)}</td>
                  <td className="end">{w && can("sales_orders.invoice") && <Button size="sm" variant="ghost" onClick={() => setRefunding(p)}>استرداد</Button>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      )}
      {d.notes && <section className="panel panel-pad"><h2>ملاحظات</h2><p className="wrap">{d.notes}</p></section>}

      <ConfirmDialog open={dialog === "confirm"} onClose={() => setDialog(null)} busy={busy} error={err} destructive={false}
        onConfirm={() => void confirm(Boolean(short))} title={`تأكيد SO-${d.number}`} confirmLabel={short ? "تأكيد مع الانتظار" : "تأكيد الأمر"}
        message={short ? <>الكمية المتاحة لا تكفي:<ul>{short.map((s) => <li key={s.name}>{s.name}: متاح {quantity(s.available)} من {quantity(s.required)}</li>)}</ul>يمكن تأكيد الأمر وانتظار إنتاج الباقي أو شرائه؛ يُسلَّم المتاح الآن.</>
          : <>يصبح العرض أمراً يحجز الكميات في {d.locationName}{d.creditLimit !== null ? " بعد التحقق من حد ائتمان العميل" : ""}. لا يُعدَّل بعد التأكيد.</>} />
      {dialog === "deliver" && <QtyDialog tenantId={tenantId} order={d} mode="deliver" onClose={() => setDialog(null)} onDone={done} />}
      {dialog === "return" && <QtyDialog tenantId={tenantId} order={d} mode="return" onClose={() => setDialog(null)} onDone={done} />}
      {dialog === "invoice" && <InvoiceDialog tenantId={tenantId} order={d} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === "prepay" && <PrepaymentDialog tenantId={tenantId} order={d} onClose={() => setDialog(null)} onDone={done} />}
      {refunding && <RefundDialog tenantId={tenantId} order={d} prepayment={refunding} onClose={() => setRefunding(null)} onDone={async (m) => { setRefunding(null); await done(m); }} />}
      <ConfirmDialog open={dialog === "cancel" || dialog === "close"} onClose={() => setDialog(null)} busy={busy} error={err} onConfirm={() => void end(dialog === "close" ? "close" : "cancel")}
        title={dialog === "close" ? `إقفال SO-${d.number}` : `إلغاء SO-${d.number}`} confirmLabel={dialog === "close" ? "إقفال الأمر" : "إلغاء الأمر"}
        message={dialog === "close" ? "يُقفل الأمر على ما سُلّم، ويُفرج عن الكميات المحجوزة غير المسلّمة. ما سُلّم يجب أن يكون مفوتراً." : "يُلغى العرض أو الأمر ويُفرج عن الحجز. لا أثر على المخزون أو الحسابات."}>
        <TextField label="السبب" required value={reason} onChange={(e) => setReason(e.target.value)} />
      </ConfirmDialog>
      </div>
    </div>
  );
}

/** A4 delivery note: what left, in which batches, signed by the driver and the receiver. No prices. */
function DeliveryNote({ order, delivery }: { order: SoDetail; delivery: SoDetail["deliveries"][number] }) {
  const { ctx } = useTenant();
  return (
    <section className="acc-print acc-print-only panel panel-pad" aria-label="إذن التسليم">
      <div className="acc-print-head">
        <h2>إذن تسليم <bdi dir="ltr" className="num">DN-{delivery.number}</bdi> <span className="muted">/ Delivery note</span></h2>
        <span>{ctx?.tenant.companyName} · الرقم الضريبي <span className="num">{ctx?.tenant.taxId}</span></span>
        <span>التاريخ {day(delivery.date)} · أمر البيع <bdi dir="ltr" className="num">SO-{order.number}</bdi>{order.customerRef ? ` · أمر شراء العميل ${order.customerRef}` : ""} · من {order.locationName}</span>
        <span>العميل: <strong>{order.customerName}</strong>{order.customerPhone ? <> · <span className="num">{order.customerPhone}</span></> : null}</span>
      </div>
      <table className="data-table">
        <caption className="sr-only">الأصناف المسلّمة</caption>
        <thead><tr><th scope="col">#</th><th scope="col">الصنف</th><th scope="col">التشغيلة / الانتهاء</th><th scope="col" className="end">الكمية</th></tr></thead>
        <tbody>{delivery.lines.map((y, i) => {
          const l = order.lines.find((z) => z.id === y.lineId);
          return (
            <tr key={y.lineId}>
              <td className="num">{i + 1}</td>
              <td>{l?.description}</td>
              <td>{y.batches.length ? y.batches.map((b) => `${b.batchNo}${b.expiryDate ? ` (${day(b.expiryDate)})` : ""}`).join("، ") : "—"}</td>
              <td className="end num">{quantity(y.quantity)} {l?.unit}</td>
            </tr>
          );
        })}</tbody>
      </table>
      {delivery.driver && <p>السائق / الناقل: {delivery.driver}</p>}
      <div className="doc-signatures"><span>المسلِّم: ................................</span><span>السائق: ................................</span><span>المستلم (الاسم والتوقيع والختم): ................................</span></div>
    </section>
  );
}

function QtyDialog({ tenantId, order, mode, onClose, onDone }: { tenantId: string; order: SoDetail; mode: "deliver" | "return"; onClose: () => void; onDone: (m: string) => Promise<void> }) {
  const [key, renewKey] = useIdempotencyKey();
  const rows = mode === "deliver" ? order.lines.filter((l) => l.toDeliver > 0) : order.lines.filter((l) => l.deliveredQty > 0);
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries(rows.map((l) => [l.id, mode === "deliver" ? String(Math.max(0, Math.min(l.toDeliver, l.onHand))) : ""])));
  const [extra, setExtra] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    const lines = rows.map((l) => ({ lineId: l.id, quantity: num(qty[l.id] ?? "") || 0 })).filter((x) => x.quantity > 0);
    if (!lines.length) return setError(new Error(mode === "deliver" ? "أدخل كمية للتسليم" : "أدخل كمية المرتجع"));
    const bad = rows.find((l) => (num(qty[l.id] ?? "") || 0) > (mode === "deliver" ? l.toDeliver : l.deliveredQty));
    if (bad) return setError(new Error(mode === "deliver" ? `لا يُسلَّم من «${bad.description}» أكثر من المتبقي` : `لا يُرجع من «${bad.description}» أكثر مما سُلّم`));
    if (mode === "return" && extra.trim().length < 3) return setError(new Error("اذكر سبب المرتجع"));
    setBusy(true); setError(null);
    try {
      await api("POST", `/t/sales-orders/${order.id}/${mode === "deliver" ? "deliver" : "returns"}`, { tenant: tenantId, idempotencyKey: key,
        body: mode === "deliver" ? { lines, driver: extra.trim() || null } : { lines, reason: extra.trim() } });
      renewKey();
      await onDone(mode === "deliver" ? "سُلّمت البضاعة وقُيدت تكلفة المبيعات" : "أُرجعت البضاعة إلى المخزون بتكلفتها");
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open wide onClose={onClose} busy={busy} onSubmit={() => void submit()} title={mode === "deliver" ? `إذن تسليم لـ SO-${order.number}` : `مرتجع من العميل على SO-${order.number}`}
      footer={<><Button type="submit" variant="primary" icon={mode === "deliver" ? <Truck /> : <Undo2 />} loading={busy} loadingText="جارٍ التسجيل…">{mode === "deliver" ? "تسليم" : "تسجيل المرتجع"}</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <p className="muted acc-small">{mode === "deliver" ? `تخرج من ${order.locationName} بمتوسط التكلفة والأقرب انتهاءً أولاً. التشغيلة المنتهية لا تُسلَّم.` : "تعود إلى المخزون بالتكلفة التي سُلّمت بها. إن كانت مفوترة فأصدر إشعاراً دائناً بعدها."}</p>
      <div className="table-wrap">
        <table className="data-table">
          <caption className="sr-only">الكميات</caption>
          <thead><tr><th scope="col">الصنف</th><th scope="col" className="end">{mode === "deliver" ? "المتبقي" : "المسلّم"}</th>{mode === "deliver" && <th scope="col" className="end">الرصيد</th>}<th scope="col" className="end">الكمية</th></tr></thead>
          <tbody>{rows.map((l) => (
            <tr key={l.id}>
              <td>{l.description}</td>
              <td className="end num">{quantity(mode === "deliver" ? l.toDeliver : l.deliveredQty)} {l.unit}</td>
              {mode === "deliver" && <td className="end num">{quantity(l.onHand)}</td>}
              <td className="end"><input className="input input-sm num" inputMode="decimal" aria-label={`كمية ${l.description}`} value={qty[l.id] ?? ""} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} style={{ maxWidth: 120 }} /></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <TextField label={mode === "deliver" ? "السائق أو شركة الشحن" : "سبب المرتجع"} optional={mode === "deliver"} required={mode === "return"} value={extra} onChange={(e) => setExtra(e.target.value)} />
      <FormError error={error} />
    </Dialog>
  );
}

function InvoiceDialog({ tenantId, order, onClose, onDone }: { tenantId: string; order: SoDetail; onClose: () => void; onDone: (m: string) => Promise<void> }) {
  const [key, renewKey] = useIdempotencyKey();
  const business = order.customerType === "business" || Boolean(order.customerVat || order.customerOtherId);
  const foreign = order.customerCountry !== "SA";
  const zeroRated = order.lines.filter((l) => l.toInvoice > 0).every((l) => l.vatCategory === "Z");
  const [v, setV] = useState({ invoiceType: business ? "standard" : "simplified", paymentMeans: "credit", isExport: foreign && zeroRated });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const rows = order.lines.filter((l) => l.toInvoice > 0);
  const advance = order.unappliedPrepayments.reduce((a, p) => a + p.remaining, 0);
  async function submit() {
    setBusy(true); setError(null);
    try {
      const r = await api<{ number: string; prepaid: number; zatca: { status?: string } | null }>("POST", `/t/sales-orders/${order.id}/invoice`, { tenant: tenantId, idempotencyKey: key,
        body: { ...v, isExport: v.invoiceType === "standard" && v.isExport } });
      renewKey();
      await onDone(`صدرت الفاتورة ${r.number}${r.prepaid ? ` وخُصم منها ${money(r.prepaid)} دفعات مقدمة` : ""}${r.zatca?.status ? ` (الهيئة: ${r.zatca.status})` : ""}`);
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title={`فاتورة SO-${order.number}`}
      footer={<><Button type="submit" variant="primary" icon={<FileText />} loading={busy} loadingText="جارٍ الإصدار…">إصدار الفاتورة</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <p>تُفوتر الكميات المسلّمة غير المفوترة: {rows.map((l) => `${l.description} ${quantity(l.toInvoice)}`).join("، ")}. الأسعار والخصومات من الأمر، والضريبة تُحسب في الخادم.</p>
      <SelectField label="نوع الفاتورة" required value={v.invoiceType} onChange={(e) => setV({ ...v, invoiceType: e.target.value })}
        options={[{ value: "standard", label: "ضريبية (بين المنشآت)" }, { value: "simplified", label: "مبسطة (لفرد)" }]}
        hint={v.invoiceType === "standard" ? "تُعتمد من الهيئة قبل تسليمها للعميل، وتحتاج رقمه الضريبي وعنوانه الوطني." : "تُبلَّغ للهيئة خلال 24 ساعة."} />
      <SelectField label="طريقة السداد" required value={v.paymentMeans} onChange={(e) => setV({ ...v, paymentMeans: e.target.value })}
        options={[{ value: "credit", label: `آجل${order.paymentTermsDays ? ` (${integer(order.paymentTermsDays)} يوم)` : ""}` }, { value: "bank_transfer", label: "تحويل بنكي" }, { value: "cash", label: "نقدي" }, { value: "card", label: "بطاقة" }]} />
      {foreign && v.invoiceType === "standard" && (
        <Checkbox label="فاتورة تصدير (علامة التصدير لدى الهيئة)" checked={v.isExport} onChange={(e) => setV({ ...v, isExport: e.target.checked })} />
      )}
      {foreign && v.isExport && !zeroRated && <p className="field-error" role="alert">بنود التصدير بنسبة صفرية (صادرات السلع). عدّلها في الأمر قبل التأكيد.</p>}
      {advance > 0 && <p className="acc-small">تُخصم الدفعات المقدمة ({money(advance)}) من هذه الفاتورة حتى إجماليها، ويظهر الخصم في الفاتورة الإلكترونية.</p>}
      <FormError error={error} />
    </Dialog>
  );
}

/** An advance on the order: a prepayment invoice (386) for the amount received, VAT included. */
function PrepaymentDialog({ tenantId, order, onClose, onDone }: { tenantId: string; order: SoDetail; onClose: () => void; onDone: (m: string) => Promise<void> }) {
  const [key, renewKey] = useIdempotencyKey();
  const [v, setV] = useState({ amount: "", paymentMeans: "bank_transfer" });
  const [fieldErr, setFieldErr] = useState<string | undefined>();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!(num(v.amount) > 0)) return setFieldErr("أدخل المبلغ المستلم");
    setFieldErr(undefined); setBusy(true); setError(null);
    try {
      const r = await api<{ number: string }>("POST", `/t/sales-orders/${order.id}/prepayments`, { tenant: tenantId, idempotencyKey: key, body: { amount: num(v.amount), paymentMeans: v.paymentMeans } });
      renewKey();
      await onDone(`صدرت فاتورة الدفعة المقدمة ${r.number}`);
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title={`دفعة مقدمة على SO-${order.number}`}
      footer={<><Button type="submit" variant="primary" icon={<Banknote />} loading={busy} loadingText="جارٍ الإصدار…">إصدار فاتورة الدفعة</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <p className="acc-small">تصدر فاتورة دفعة مقدمة وتُرسل للهيئة، والضريبة مستحقة عند الاستلام. المبلغ يبقى دفعة مقدمة من العميل حتى تخصمه فاتورة الأمر.</p>
      <TextField label={`المبلغ المستلم شامل الضريبة (${RIYAL})`} required numeric inputMode="decimal" dir="ltr" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} error={fieldErr}
        hint={`إجمالي الأمر ${money(order.total)}`} />
      <SelectField label="طريقة الاستلام" required value={v.paymentMeans} onChange={(e) => setV({ ...v, paymentMeans: e.target.value })}
        options={[{ value: "bank_transfer", label: "تحويل بنكي" }, { value: "cash", label: "نقدي" }, { value: "card", label: "بطاقة" }]} />
      <FormError error={error} />
    </Dialog>
  );
}

/** Returning (part of) an advance nothing deducted: a credit note on the prepayment. */
function RefundDialog({ tenantId, order, prepayment, onClose, onDone }: { tenantId: string; order: SoDetail; prepayment: SoDetail["unappliedPrepayments"][number]; onClose: () => void; onDone: (m: string) => Promise<void> }) {
  const [key, renewKey] = useIdempotencyKey();
  const [v, setV] = useState({ amount: String(prepayment.remaining), paymentMeans: "bank_transfer", reason: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    const e: Record<string, string> = {};
    if (!(num(v.amount) > 0 && num(v.amount) <= prepayment.remaining)) e.amount = `من صفر إلى ${money(prepayment.remaining)}`;
    if (v.reason.trim().length < 3) e.reason = "اذكر سبب الاسترداد";
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true); setError(null);
    try {
      const r = await api<{ number: string }>("POST", `/t/sales-orders/${order.id}/prepayments/${prepayment.id}/refund`, { tenant: tenantId, idempotencyKey: key,
        body: { amount: num(v.amount), paymentMeans: v.paymentMeans, reason: v.reason.trim() } });
      renewKey();
      await onDone(`صدر الإشعار الدائن ${r.number} باسترداد ${money(num(v.amount))}`);
    } catch (err) { setError(err); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title={`استرداد من ${prepayment.number}`}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الإصدار…">إصدار الإشعار الدائن</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <p className="acc-small">يصدر إشعار دائن على فاتورة الدفعة ويُرسل للهيئة، ويُرد المبلغ للعميل بالطريقة المختارة.</p>
      <TextField label={`المبلغ المسترد (${RIYAL})`} required numeric inputMode="decimal" dir="ltr" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} error={errors.amount} />
      <SelectField label="طريقة الرد" required value={v.paymentMeans} onChange={(e) => setV({ ...v, paymentMeans: e.target.value })}
        options={[{ value: "bank_transfer", label: "تحويل بنكي" }, { value: "cash", label: "نقدي" }, { value: "card", label: "بطاقة" }]} />
      <TextField label="السبب" required value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} error={errors.reason} />
      <FormError error={error} />
    </Dialog>
  );
}
