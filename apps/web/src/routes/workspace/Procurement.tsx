import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowRight, ClipboardList, PackageCheck, Plus, Printer, Sparkles, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { api, ApiError, type Page } from "../../api/client";
import type { Ingredient, Location, Supplier } from "../../api/types";
import { useIdempotencyKey, useMe } from "../../app/session";
import { useInvalidate, useTenant } from "../../app/tenant";
import { RIYAL, day, dayTime, integer, isoDay, money, quantity, text } from "../../lib/format";
import { Button, IconButton } from "../../ui/Button";
import { DataTable } from "../../ui/DataTable";
import { ConfirmDialog, Dialog } from "../../ui/Dialog";
import { focusFirstInvalid, SelectField, TextAreaField, TextField } from "../../ui/Field";
import { Badge, PageHeader, StatCard, StatusBadge } from "../../ui/Layout";
import { beep, ScanField } from "../../ui/Scanner";
import { EmptyState, ErrorState, FormError, TableSkeleton } from "../../ui/States";
import { useToast } from "../../ui/Toast";
import { StatusTabs } from "./Inventory";
import { IngredientPicker } from "./pickers";

/**
 * The front of the purchasing cycle (requisitions) and its back office (goods receipt notes):
 *   requisition → approval → purchase orders per supplier → receiving, delivery by delivery, with quality
 *   rejections, the invoiced price and the supplier invoice for the three-way match.
 */

const num = (s: string) => Number(s.replace(/,/g, ""));
const useOptions = (tenantId: string) => ({
  suppliers: useQuery({ queryKey: ["t", tenantId, "suppliers", "options"], queryFn: () => api<Page<Supplier>>("GET", "/t/suppliers", { tenant: tenantId, query: { isActive: "true", pageSize: 100 } }) }),
  locations: useQuery({ queryKey: ["t", tenantId, "locations", "options", "active"], queryFn: () => api<Page<Location>>("GET", "/t/locations", { tenant: tenantId, query: { isActive: "true", pageSize: 100 } }) }),
});

// ── Requisitions ─────────────────────────────────────────────────────────────────────
interface ReqRow { id: string; number: number; status: string; neededBy: string | null; notes: string | null; createdAt: string; locationName: string; itemsCount: number; summary: string | null }

export function RequisitionsPage() {
  const { tenantId, can, writable } = useTenant();
  const navigate = useNavigate();
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const list = useQuery({ queryKey: ["t", tenantId, "requisitions", { status, page }], placeholderData: keepPreviousData,
    queryFn: () => api<Page<ReqRow>>("GET", "/t/requisitions", { tenant: tenantId, query: { status: status || undefined, page, pageSize: 25 } }) });
  const create = can("requisitions.create") && writable && <Link to={`/w/${tenantId}/requisitions/new`} className="btn btn-primary"><Plus aria-hidden="true" />طلب شراء جديد</Link>;
  return (
    <div className="page">
      <PageHeader eyebrow="المشتريات" title="طلبات الشراء" description="المطبخ أو المستودع يطلب، والمدير يعتمد، والمشتري يحوّل الطلب إلى أوامر شراء لكل مورد. لا يُشترى شيء بلا طلب معتمد." actions={create} />
      <section className="panel">
        <DataTable caption="طلبات الشراء" tableId="requisitions" query={list} rowKey={(r) => r.id} onPageChange={setPage}
          toolbar={<StatusTabs value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={[["", "الكل"], ["submitted", "بانتظار الاعتماد"], ["approved", "معتمدة"], ["converted", "محوّلة"], ["rejected", "مرفوضة"]]} />}
          filtered={Boolean(status)} onClearFilters={() => setStatus("")}
          onRowClick={(r) => navigate({ to: `/w/${tenantId}/requisitions/${r.id}` })}
          empty={{ title: "لا توجد طلبات شراء", body: "ابدأ بطلب شراء من الموقع المحتاج، أو من «اقتراحات إعادة الطلب» للمواد التي نزلت تحت حدها الأدنى.", action: create || undefined }}
          columns={[
            { key: "n", header: "رقم الطلب", sortKey: false, cell: (r) => <Link to={`/w/${tenantId}/requisitions/${r.id}`}><strong className="num">PR-{r.number}</strong></Link> },
            { key: "loc", header: "الموقع الطالب", sortKey: false, cell: (r) => r.locationName },
            { key: "sum", header: "المواد", sortKey: false, wrap: true, cell: (r) => <span>{r.summary}<span className="muted"> ({integer(r.itemsCount)})</span></span> },
            { key: "need", header: "مطلوب قبل", sortKey: false, cell: (r) => day(r.neededBy) },
            { key: "date", header: "التاريخ", sortKey: false, cell: (r) => dayTime(r.createdAt) },
            { key: "s", header: "الحالة", sortKey: false, cell: (r) => <StatusBadge kind="requisition" value={r.status} /> },
          ]} />
      </section>
    </div>
  );
}

interface ReqLine { ingredient: Pick<Ingredient, "id" | "name" | "purchaseUnitName">; quantity: string; note: string }
interface Suggestion { ingredientId: string; name: string; purchaseUnit: string; onHand: number; onOrder: number; minStock: number; target: number; baseUnit: string; suggestedQuantity: number; lastPrice: number | null; lastSupplierName: string | null }

export function NewRequisitionPage() {
  const { tenantId } = useTenant();
  const navigate = useNavigate();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const { locations } = useOptions(tenantId);
  const [key, renewKey] = useIdempotencyKey();
  const form = useRef<HTMLFormElement>(null);
  const [v, setV] = useState({ locationId: "", neededBy: "", notes: "" });
  const [lines, setLines] = useState<ReqLine[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [loadingSug, setLoadingSug] = useState(false);

  async function fromSuggestions() {
    if (!v.locationId) return setErrors({ locationId: "اختر الموقع أولاً لنحسب ما ينقصه" });
    setLoadingSug(true); setError(null);
    try {
      const r = await api<{ items: Suggestion[] }>("GET", "/t/purchasing/suggestions", { tenant: tenantId, query: { locationId: v.locationId } });
      const fresh = r.items.filter((s) => !lines.some((l) => l.ingredient.id === s.ingredientId));
      setLines((ls) => [...ls, ...fresh.map((s) => ({ ingredient: { id: s.ingredientId, name: s.name, purchaseUnitName: s.purchaseUnit }, quantity: String(s.suggestedQuantity), note: `الرصيد ${quantity(s.onHand)} ${s.baseUnit} تحت الحد الأدنى` }))]);
      toast.success(fresh.length ? `أُضيفت ${integer(fresh.length)} مادة تحت حدها الأدنى` : "لا توجد مواد تحت الحد الأدنى في هذا الموقع");
    } catch (e) { setError(e); } finally { setLoadingSug(false); }
  }

  async function submit() {
    const e: Record<string, string> = {};
    if (!v.locationId) e.locationId = "اختر الموقع الذي يحتاج المواد";
    if (!lines.length) e.lines = "أضف مادة واحدة على الأقل";
    lines.forEach((l, i) => { if (!(num(l.quantity) > 0)) e[`q${i}`] = "كمية أكبر من صفر"; });
    setErrors(e);
    if (Object.keys(e).length) return focusFirstInvalid(form.current);
    setBusy(true); setError(null);
    try {
      const r = await api<{ id: string }>("POST", "/t/requisitions", { tenant: tenantId, idempotencyKey: key, body: {
        locationId: v.locationId, neededBy: v.neededBy || null, notes: v.notes.trim() || null,
        items: lines.map((l) => ({ ingredientId: l.ingredient.id, quantity: num(l.quantity), note: l.note.trim() || null })) } });
      renewKey();
      toast.success("أُرسل طلب الشراء للاعتماد");
      await invalidate("requisitions");
      navigate({ to: `/w/${tenantId}/requisitions/${r.id}` });
    } catch (err) { if (err instanceof ApiError) setErrors(err.fieldErrors); setError(err); } finally { setBusy(false); }
  }

  return (
    <form ref={form} className="page" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <PageHeader eyebrow="طلبات الشراء" title="طلب شراء جديد" description="يُرسل للاعتماد مباشرة. الأسعار والموردون يحددهم المشتري عند التحويل إلى أوامر شراء."
        actions={<Link to={`/w/${tenantId}/requisitions`} className="btn btn-ghost"><ArrowRight aria-hidden="true" />طلبات الشراء</Link>} />
      <section className="panel panel-pad form-section" aria-labelledby="pr-head">
        <h2 id="pr-head">من يحتاج ومتى</h2>
        <div className="form-grid">
          <SelectField label="الموقع الطالب" required placeholder="اختر الموقع" value={v.locationId} onChange={(e) => setV({ ...v, locationId: e.target.value })} error={errors.locationId}
            options={(locations.data?.items ?? []).map((l) => ({ value: l.id, label: l.name }))} />
          <TextField label="مطلوب قبل" optional type="date" min={isoDay()} value={v.neededBy} onChange={(e) => setV({ ...v, neededBy: e.target.value })} />
        </div>
        <TextAreaField label="ملاحظات" optional rows={2} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} />
      </section>
      <section className="panel" aria-labelledby="pr-lines">
        <div className="card-head"><h2 id="pr-lines">المواد المطلوبة</h2><span className="spacer" />
          <Button type="button" variant="ghost" icon={<Sparkles />} loading={loadingSug} loadingText="جارٍ الحساب…" onClick={() => void fromSuggestions()}>إضافة ما تحت الحد الأدنى</Button>
        </div>
        <div className="card-body pf-picker">
          <IngredientPicker tenantId={tenantId} label="إضافة مادة" exclude={lines.map((l) => l.ingredient.id)} error={errors.lines} locationId={v.locationId || undefined}
            onPick={(i) => setLines((ls) => [...ls, { ingredient: i, quantity: "1", note: "" }])} />
        </div>
        {lines.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <caption className="sr-only">المواد المطلوبة</caption>
              <thead><tr><th scope="col">المادة</th><th scope="col">الكمية بوحدة الشراء</th><th scope="col">ملاحظة</th><th scope="col"><span className="sr-only">حذف</span></th></tr></thead>
              <tbody>{lines.map((l, i) => (
                <tr key={l.ingredient.id}>
                  <td><strong>{l.ingredient.name}</strong></td>
                  <td style={{ minWidth: 140 }}><div className="row" style={{ flexWrap: "nowrap" }}><input className="input num" inputMode="decimal" aria-label={`كمية ${l.ingredient.name}`} aria-invalid={errors[`q${i}`] ? true : undefined} value={l.quantity}
                    onChange={(e) => setLines((ls) => ls.map((x, n) => (n === i ? { ...x, quantity: e.target.value } : x)))} /><span className="muted">{l.ingredient.purchaseUnitName}</span></div>
                    {errors[`q${i}`] && <span className="field-error">{errors[`q${i}`]}</span>}</td>
                  <td style={{ minWidth: 200 }}><input className="input" aria-label={`ملاحظة ${l.ingredient.name}`} value={l.note} maxLength={200} onChange={(e) => setLines((ls) => ls.map((x, n) => (n === i ? { ...x, note: e.target.value } : x)))} /></td>
                  <td className="actions"><IconButton size="sm" destructive label={`إزالة ${l.ingredient.name}`} icon={<Trash2 />} onClick={() => setLines((ls) => ls.filter((_, n) => n !== i))} /></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>
      <FormError error={error} />
      <div className="pf-form-foot">
        <Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الإرسال…">إرسال للاعتماد</Button>
        <Link to={`/w/${tenantId}/requisitions`} className="btn btn-ghost">إلغاء</Link>
      </div>
    </form>
  );
}

interface ReqDetail {
  id: string; number: number; status: string; neededBy: string | null; notes: string | null; decisionNote: string | null; createdAt: string; decidedAt: string | null; requestedBy: string; locationName: string;
  items: { id: string; ingredientId: string; name: string; sku: string; purchaseUnit: string; quantity: number; note: string | null; purchaseOrderId: string | null; poNumber: number | null; onHand: number; lastPrice: number | null; lastSupplierId: string | null; lastSupplierName: string | null }[];
}

export function RequisitionDetailPage() {
  const { tenantId, ctx, can, writable } = useTenant();
  const { requisitionId } = useParams({ strict: false }) as { requisitionId: string };
  const me = useMe();
  const navigate = useNavigate();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const { suppliers } = useOptions(tenantId);
  const [key, renewKey] = useIdempotencyKey();
  const r = useQuery({ queryKey: ["t", tenantId, "requisitions", requisitionId], queryFn: () => api<ReqDetail>("GET", `/t/requisitions/${requisitionId}`, { tenant: tenantId }) });
  const [plan, setPlan] = useState<Record<string, { on: boolean; supplierId: string; price: string }>>({});
  const [confirm, setConfirm] = useState<"reject" | "cancel" | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);

  const open = useMemo(() => (r.data?.items ?? []).filter((i) => !i.purchaseOrderId), [r.data]);
  const lineOf = (i: ReqDetail["items"][number]) => plan[i.id] ?? { on: true, supplierId: i.lastSupplierId ?? "", price: i.lastPrice === null ? "" : String(i.lastPrice) };

  async function act(a: "approve" | "reject" | "cancel") {
    if (a === "reject" && note.trim().length < 3) return setErr("اكتب سبب الرفض");
    setBusy(a); setErr(null);
    try {
      await api("POST", `/t/requisitions/${requisitionId}/${a}`, { tenant: tenantId, body: a === "reject" ? { note: note.trim() } : {} });
      setConfirm(null);
      toast.success(a === "approve" ? "اعتُمد الطلب" : a === "reject" ? "رُفض الطلب" : "أُلغي الطلب");
      await invalidate("requisitions");
    } catch (e) { setErr(e); } finally { setBusy(null); }
  }
  async function convert() {
    const chosen = open.filter((i) => lineOf(i).on);
    if (!chosen.length) return setErr("اختر مادة واحدة على الأقل");
    const missing = chosen.find((i) => !lineOf(i).supplierId || !(num(lineOf(i).price) >= 0) || lineOf(i).price.trim() === "");
    if (missing) return setErr(`حدد المورد والسعر للمادة «${missing.name}»`);
    setBusy("convert"); setErr(null);
    try {
      const out = await api<{ purchaseOrderIds: string[] }>("POST", `/t/requisitions/${requisitionId}/convert`, { tenant: tenantId, idempotencyKey: key,
        body: { lines: chosen.map((i) => ({ itemId: i.id, supplierId: lineOf(i).supplierId, unitPrice: num(lineOf(i).price) })) } });
      renewKey();
      toast.success(`أُنشئ ${integer(out.purchaseOrderIds.length)} أمر شراء كمسودة للاعتماد`);
      await invalidate("requisitions", "purchases");
      if (out.purchaseOrderIds.length === 1) navigate({ to: `/w/${tenantId}/purchases/${out.purchaseOrderIds[0]}` });
    } catch (e) { setErr(e); } finally { setBusy(null); }
  }

  if (r.isPending) return <div className="page"><TableSkeleton columns={5} rows={4} /></div>;
  if (r.isError) return <div className="page"><ErrorState error={r.error} onRetry={() => r.refetch()} /></div>;
  const d = r.data;
  const own = d.requestedBy === me.data?.user.id && ctx?.role !== "owner";
  const canDecide = d.status === "submitted" && can("requisitions.approve") && writable;
  const canConvert = d.status === "approved" && can("requisitions.convert") && writable && open.length > 0;
  const canCancel = (d.status === "submitted" || d.status === "approved") && can("requisitions.cancel") && writable;
  const estimate = open.filter((i) => lineOf(i).on).reduce((a, i) => a + i.quantity * (num(lineOf(i).price) || 0), 0);

  return (
    <div className="page">
      <PageHeader eyebrow="طلب شراء" title={<span className="row inv-title"><span><span className="num">PR-{d.number}</span> · {d.locationName}</span><StatusBadge kind="requisition" value={d.status} /></span>}
        description={<>قُدِّم {dayTime(d.createdAt)}{d.neededBy ? ` · مطلوب قبل ${day(d.neededBy)}` : ""}</>}
        actions={<>
          <Link to={`/w/${tenantId}/requisitions`} className="btn btn-ghost no-print"><ArrowRight aria-hidden="true" />طلبات الشراء</Link>
          <Button variant="ghost" className="no-print" icon={<Printer />} onClick={() => window.print()}>طباعة</Button>
          {canCancel && <Button variant="ghost" destructive className="no-print" onClick={() => { setErr(null); setConfirm("cancel"); }}>إلغاء الطلب</Button>}
          {canDecide && (own ? <span className="muted acc-small">لا يعتمد مقدّم الطلب طلبه (فصل المهام).</span> : <>
            <Button className="no-print" onClick={() => { setErr(null); setNote(""); setConfirm("reject"); }}>رفض</Button>
            <Button variant="primary" className="no-print" loading={busy === "approve"} loadingText="جارٍ الاعتماد…" onClick={() => void act("approve")}>اعتماد الطلب</Button>
          </>)}
        </>} />
      {d.decisionNote && <p className="banner banner-danger inv-banner">سبب الرفض: {d.decisionNote}</p>}
      {d.notes && <p className="banner banner-info inv-banner">{d.notes}</p>}
      <section className="panel acc-print" aria-labelledby="pr-items">
        <div className="card-head"><h2 id="pr-items">{canConvert ? "التحويل إلى أوامر شراء" : `طلب شراء PR-${d.number}`}</h2><span className="spacer" />
          {canConvert && <span className="muted acc-small">سيُنشأ أمر شراء لكل مورد. السعر الافتراضي آخر سعر استلام.</span>}</div>
        <div className="table-wrap">
          <table className="data-table">
            <caption className="sr-only">مواد الطلب</caption>
            <thead><tr>
              {canConvert && <th scope="col"><span className="sr-only">تضمين</span></th>}
              <th scope="col">المادة</th><th scope="col" className="end">الكمية</th><th scope="col" className="end">الرصيد الحالي</th><th scope="col">ملاحظة</th>
              {canConvert ? <><th scope="col">المورد</th><th scope="col">سعر الوحدة ({RIYAL})</th></> : <th scope="col">أمر الشراء</th>}
            </tr></thead>
            <tbody>{d.items.map((i) => {
              const l = lineOf(i);
              const set = (patch: Partial<typeof l>) => setPlan((x) => ({ ...x, [i.id]: { ...l, ...patch } }));
              const convertible = canConvert && !i.purchaseOrderId;
              return (
                <tr key={i.id}>
                  {canConvert && <td>{convertible && <input type="checkbox" aria-label={`تضمين ${i.name}`} checked={l.on} onChange={(e) => set({ on: e.target.checked })} />}</td>}
                  <td><strong>{i.name}</strong> <span className="muted num">{i.sku}</span></td>
                  <td className="end num">{quantity(i.quantity)} {i.purchaseUnit}</td>
                  <td className="end num">{quantity(i.onHand)} {i.purchaseUnit}</td>
                  <td>{text(i.note)}</td>
                  {convertible ? <>
                    <td style={{ minWidth: 180 }}><select className="select" aria-label={`مورد ${i.name}`} value={l.supplierId} onChange={(e) => set({ supplierId: e.target.value })}>
                      <option value="">اختر المورد</option>{(suppliers.data?.items ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></td>
                    <td style={{ minWidth: 120 }}><input className="input num" inputMode="decimal" aria-label={`سعر ${i.name}`} value={l.price} onChange={(e) => set({ price: e.target.value })} /></td>
                  </> : canConvert ? <><td colSpan={2}>{i.poNumber && <Link to={`/w/${tenantId}/purchases/${i.purchaseOrderId}`} className="num">PO-{i.poNumber}</Link>}</td></>
                    : <td>{i.poNumber ? <Link to={`/w/${tenantId}/purchases/${i.purchaseOrderId}`} className="num">PO-{i.poNumber}</Link> : <span className="muted">—</span>}</td>}
                </tr>
              );
            })}</tbody>
          </table>
        </div>
        <div className="doc-signatures acc-print-only"><span>مقدّم الطلب: ____________</span><span>المعتمِد: ____________</span></div>
      </section>
      {err != null && !confirm && <FormError error={err} />}
      {canConvert && (
        <div className="pf-form-foot">
          <Button variant="primary" icon={<ClipboardList />} loading={busy === "convert"} loadingText="جارٍ الإنشاء…" onClick={() => void convert()}>إنشاء أوامر الشراء</Button>
          <span className="spacer" /><span>الإجمالي التقديري قبل الضريبة: <strong className="num">{money(estimate)}</strong></span>
        </div>
      )}
      <Dialog open={confirm === "reject"} onClose={() => setConfirm(null)} busy={busy === "reject"} title={`رفض PR-${d.number}`} onSubmit={() => void act("reject")}
        footer={<><Button type="submit" variant="danger" loading={busy === "reject"} loadingText="جارٍ الرفض…">رفض الطلب</Button><Button onClick={() => setConfirm(null)} autoFocus>إلغاء</Button></>}>
        <p>يُبلَّغ مقدّم الطلب بالسبب، ولا يمكن تحويل الطلب المرفوض إلى أوامر شراء.</p>
        <TextAreaField label="سبب الرفض" required rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        <FormError error={err} />
      </Dialog>
      <ConfirmDialog open={confirm === "cancel"} onClose={() => setConfirm(null)} busy={busy === "cancel"} onConfirm={() => void act("cancel")} error={err ? (err as Error).message : undefined}
        title={`إلغاء PR-${d.number}`} confirmLabel="إلغاء الطلب" message="يبقى الطلب في السجل ملغى، ولا يُحوَّل إلى أوامر شراء." />
    </div>
  );
}

// ── Receiving ────────────────────────────────────────────────────────────────────────
interface PoForReceipt {
  id: string; number: number; status: string; supplierName: string; locationName: string; supplierInvoice: string | null; vatRate: number;
  items: { ingredientId: string; name: string; sku: string; purchaseUnit: string; quantity: number; receivedQuantity: number; unitPrice: number; barcode: string | null; purchaseToBase: number;
    trackExpiry: boolean; shelfLifeDays: number | null }[];
}
const plusDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Receiving at the door: count what arrived (by hand or scanner), set aside what fails inspection with its reason,
 * take the price from the supplier's invoice, and record the invoice so the three-way match can run.
 */
export function ReceiveGoodsPage() {
  const { tenantId } = useTenant();
  const { poId } = useParams({ strict: false }) as { poId: string };
  const navigate = useNavigate();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [key, renewKey] = useIdempotencyKey();
  const form = useRef<HTMLFormElement>(null);
  const po = useQuery({ queryKey: ["t", tenantId, "purchases", poId], queryFn: () => api<PoForReceipt>("GET", `/t/purchases/${poId}`, { tenant: tenantId }) });
  const [head, setHead] = useState({ receivedOn: isoDay(), supplierInvoice: "", supplierInvoiceDate: isoDay(), invoiceAmount: "", notes: "" });
  const [rows, setRows] = useState<Record<string, { q: string; rej: string; reason: string; price: string; batch: string; expiry: string }>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);

  const p = po.data;
  const open = (p?.items ?? []).filter((i) => i.receivedQuantity < i.quantity);
  const rowOf = (i: PoForReceipt["items"][number]) => rows[i.ingredientId] ?? { q: String(Math.round((i.quantity - i.receivedQuantity) * 10000) / 10000), rej: "0", reason: "", price: String(i.unitPrice), batch: "", expiry: "" };
  const anyDated = open.some((i) => i.trackExpiry || i.shelfLifeDays);
  const set = (id: string, cur: ReturnType<typeof rowOf>, patch: Partial<ReturnType<typeof rowOf>>) => setRows((x) => ({ ...x, [id]: { ...cur, ...patch } }));

  // Scanning a code on a delivery adds one of that pack (converted to purchase units) to the accepted quantity.
  async function onScan(code: string) {
    const direct = open.find((i) => i.barcode === code);
    let target = direct, units = 1;
    if (!direct) {
      try {
        const b = await api<{ ingredientId: string; baseQuantity: number }>("GET", `/t/barcodes/${encodeURIComponent(code)}`, { tenant: tenantId });
        target = open.find((i) => i.ingredientId === b.ingredientId);
        if (target) units = b.baseQuantity / target.purchaseToBase;
      } catch { target = undefined; }
    }
    if (!target) { beep(false); setScanMsg(`الباركود ${code} ليس من أصناف هذا الأمر`); return; }
    const cur = rows[target.ingredientId] ? rowOf(target) : { ...rowOf(target), q: "0" };
    const next = Math.round(((num(cur.q) || 0) + units) * 10000) / 10000;
    set(target.ingredientId, cur, { q: String(next) });
    beep(true);
    setScanMsg(`${target.name}: ${quantity(next)} ${target.purchaseUnit}`);
  }

  async function submit() {
    const e: Record<string, string> = {};
    const items = open.map((i, n) => {
      const r = rowOf(i);
      const q = num(r.q) || 0, rej = num(r.rej) || 0;
      if (q < 0 || rej < 0) e[`q${n}`] = "كمية صفر أو أكبر";
      if (q > i.quantity - i.receivedQuantity + 1e-9) e[`q${n}`] = `أكبر من المتبقي (${quantity(i.quantity - i.receivedQuantity)})`;
      if (rej > 0 && r.reason.trim().length < 3) e[`r${n}`] = "اكتب سبب الرفض";
      if (!(num(r.price) >= 0) || r.price.trim() === "") e[`p${n}`] = "أدخل السعر";
      if (q > 0 && i.trackExpiry && !r.expiry && !i.shelfLifeDays) e[`x${n}`] = "أدخل تاريخ الانتهاء من ملصق المورد";
      else if (q > 0 && r.expiry && r.expiry < head.receivedOn) e[`x${n}`] = "منتهي الصلاحية: سجّله مرفوضاً";
      return { ingredientId: i.ingredientId, quantity: q, rejectedQuantity: rej, rejectReason: r.reason.trim() || null, unitPrice: num(r.price),
        batchNo: r.batch.trim() || null, expiryDate: r.expiry || null };
    }).filter((x) => x.quantity > 0 || x.rejectedQuantity > 0);
    if (!items.length) e.lines = "أدخل الكمية المستلمة لصنف واحد على الأقل";
    if (head.invoiceAmount.trim() && !(num(head.invoiceAmount) >= 0)) e.invoiceAmount = "مبلغ صحيح أو اتركه فارغاً";
    setErrors(e);
    if (Object.keys(e).length) return focusFirstInvalid(form.current);
    setBusy(true); setError(null);
    try {
      const r = await api<{ id: string }>("POST", `/t/purchases/${poId}/receipts`, { tenant: tenantId, idempotencyKey: key, body: {
        receivedOn: head.receivedOn, supplierInvoice: head.supplierInvoice.trim() || null, supplierInvoiceDate: head.supplierInvoice.trim() ? head.supplierInvoiceDate || null : null,
        invoiceAmount: head.invoiceAmount.trim() ? num(head.invoiceAmount) : null, notes: head.notes.trim() || null, items } });
      renewKey();
      toast.success("سُجّل سند الاستلام وأُضيفت الكميات للمخزون");
      await invalidate("purchases", "goods-receipts", "stock", "ingredients", "reports", "payables");
      navigate({ to: `/w/${tenantId}/goods-receipts/${r.id}` });
    } catch (err) { if (err instanceof ApiError) setErrors(err.fieldErrors); setError(err); } finally { setBusy(false); }
  }

  if (po.isPending) return <div className="page"><TableSkeleton columns={6} rows={4} /></div>;
  if (po.isError) return <div className="page"><ErrorState error={po.error} onRetry={() => po.refetch()} /></div>;
  if (p!.status !== "approved" && p!.status !== "partially_received") {
    return <div className="page"><EmptyState title="لا يمكن استلام هذا الأمر" action={<Link to={`/w/${tenantId}/purchases/${poId}`} className="btn btn-secondary">فتح الأمر</Link>}>يُستلم أمر الشراء المعتمد أو المستلم جزئياً فقط.</EmptyState></div>;
  }
  const accepted = open.reduce((a, i) => a + (num(rowOf(i).q) || 0) * (num(rowOf(i).price) || 0), 0);
  const variance = open.reduce((a, i) => a + (num(rowOf(i).q) || 0) * ((num(rowOf(i).price) || 0) - i.unitPrice), 0);

  return (
    <form ref={form} className="page" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <PageHeader eyebrow={`استلام PO-${p!.number}`} title={`سند استلام من ${p!.supplierName}`} description={`إلى ${p!.locationName}. سجّل ما وصل فعلاً في هذه الشحنة؛ الباقي يبقى مفتوحاً لشحنة لاحقة.`}
        actions={<Link to={`/w/${tenantId}/purchases/${poId}`} className="btn btn-ghost"><ArrowRight aria-hidden="true" />أمر الشراء</Link>} />
      <section className="panel panel-pad form-section" aria-labelledby="grn-inv">
        <h2 id="grn-inv">فاتورة المورد (للمطابقة الثلاثية)</h2>
        <div className="form-grid">
          <TextField label="تاريخ الاستلام" type="date" max={isoDay()} value={head.receivedOn} onChange={(e) => setHead({ ...head, receivedOn: e.target.value })} />
          <TextField label="رقم فاتورة المورد" optional dir="ltr" value={head.supplierInvoice} onChange={(e) => setHead({ ...head, supplierInvoice: e.target.value })} />
          <TextField label="تاريخ الفاتورة" optional type="date" value={head.supplierInvoiceDate} onChange={(e) => setHead({ ...head, supplierInvoiceDate: e.target.value })} hint="يُحسب منه تاريخ الاستحقاق حسب شروط المورد" />
          <TextField label={`إجمالي الفاتورة شامل الضريبة (${RIYAL})`} optional numeric value={head.invoiceAmount} onChange={(e) => setHead({ ...head, invoiceAmount: e.target.value })} error={errors.invoiceAmount} hint="نقارنه بقيمة الاستلام ونُظهر أي فرق" />
        </div>
      </section>
      <section className="panel" aria-labelledby="grn-lines">
        <div className="card-head"><h2 id="grn-lines">ما وصل في الشحنة</h2></div>
        <div className="card-body">
          <ScanField onCode={(c) => void onScan(c)} label="العد بالباركود (اختياري)" hint="كل مسحة تضيف عبوة واحدة للكمية المقبولة. ابدأ من الصفر: أول مسحة تستبدل الكمية المقترحة." />
          {scanMsg && <p className="muted" aria-live="polite">{scanMsg}</p>}
          {errors.lines && <p className="field-error" role="alert">{errors.lines}</p>}
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <caption className="sr-only">أصناف الاستلام</caption>
            <thead><tr><th scope="col">المادة</th><th scope="col" className="end">المطلوب</th><th scope="col" className="end">استُلم سابقاً</th><th scope="col">المقبول</th><th scope="col">المرفوض وسببه</th><th scope="col">سعر الفاتورة</th>{anyDated && <th scope="col">التشغيلة والصلاحية</th>}</tr></thead>
            <tbody>{open.map((i, n) => {
              const r = rowOf(i);
              const changed = Math.abs((num(r.price) || 0) - i.unitPrice) > 0.0001;
              return (
                <tr key={i.ingredientId}>
                  <td><strong>{i.name}</strong><div className="muted acc-small">بالـ{i.purchaseUnit}</div></td>
                  <td className="end num">{quantity(i.quantity)}</td>
                  <td className="end num">{quantity(i.receivedQuantity)}</td>
                  <td style={{ minWidth: 110 }}><input className="input num" inputMode="decimal" aria-label={`المقبول من ${i.name}`} aria-invalid={errors[`q${n}`] ? true : undefined} value={r.q} onChange={(e) => set(i.ingredientId, r, { q: e.target.value })} />{errors[`q${n}`] && <span className="field-error">{errors[`q${n}`]}</span>}</td>
                  <td style={{ minWidth: 150 }}><div className="stack-tight">
                    <input className="input num" inputMode="decimal" aria-label={`المرفوض من ${i.name}`} value={r.rej} onChange={(e) => set(i.ingredientId, r, { rej: e.target.value })} />
                    {(num(r.rej) || 0) > 0 && <input className="input" aria-label={`سبب رفض ${i.name}`} placeholder="السبب: تالف، منتهي…" aria-invalid={errors[`r${n}`] ? true : undefined} value={r.reason} onChange={(e) => set(i.ingredientId, r, { reason: e.target.value })} />}
                    {errors[`r${n}`] && <span className="field-error">{errors[`r${n}`]}</span>}
                  </div></td>
                  <td style={{ minWidth: 120 }}><input className="input num" inputMode="decimal" aria-label={`سعر ${i.name} في الفاتورة`} aria-invalid={errors[`p${n}`] ? true : undefined} value={r.price} onChange={(e) => set(i.ingredientId, r, { price: e.target.value })} />
                    {changed && <Badge tone="warning">أمر الشراء {money(i.unitPrice)}</Badge>}</td>
                  {anyDated && <>
                    <td style={{ minWidth: 160 }}>{i.trackExpiry || i.shelfLifeDays ? <div className="stack-tight">
                      <input className="input" dir="ltr" aria-label={`رقم تشغيلة ${i.name}`} placeholder="رقم التشغيلة LOT" value={r.batch} maxLength={60} onChange={(e) => set(i.ingredientId, r, { batch: e.target.value })} />
                      <input className="input" type="date" aria-label={`تاريخ انتهاء ${i.name}`} aria-invalid={errors[`x${n}`] ? true : undefined} min={head.receivedOn} value={r.expiry} onChange={(e) => set(i.ingredientId, r, { expiry: e.target.value })} />
                      {errors[`x${n}`] ? <span className="field-error">{errors[`x${n}`]}</span>
                        : !r.expiry && i.shelfLifeDays ? <span className="muted acc-small">تلقائياً {day(plusDays(head.receivedOn, i.shelfLifeDays))}</span>
                        : r.expiry && r.expiry <= plusDays(head.receivedOn, 3) ? <Badge tone="warning">قريب الانتهاء</Badge> : null}
                    </div> : <span className="muted">—</span>}</td>
                  </>}
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      </section>
      <TextAreaField label="ملاحظات الاستلام" optional rows={2} value={head.notes} onChange={(e) => setHead({ ...head, notes: e.target.value })} />
      <FormError error={error} />
      <div className="pf-form-foot">
        <Button type="submit" variant="primary" icon={<PackageCheck />} loading={busy} loadingText="جارٍ التسجيل…">تسجيل سند الاستلام</Button>
        <Link to={`/w/${tenantId}/purchases/${poId}`} className="btn btn-ghost">إلغاء</Link>
        <span className="spacer" />
        <span>قيمة المقبول قبل الضريبة: <strong className="num">{money(accepted)}</strong>{Math.abs(variance) >= 0.01 && <span className="muted"> · فرق سعر عن الأمر {money(variance)}</span>}</span>
      </div>
    </form>
  );
}

// ── Goods receipt notes ──────────────────────────────────────────────────────────────
interface GrnRow { id: string; number: number; receivedOn: string; supplierInvoice: string | null; grandTotal: number; invoiceAmount: number | null; invoiceVariance: number | null; purchaseOrderId: string; poNumber: number; supplierName: string; locationName: string; rejectedLines: number; legacy: boolean }

export function GoodsReceiptsPage() {
  const { tenantId } = useTenant();
  const navigate = useNavigate();
  const [mismatch, setMismatch] = useState("");
  const [page, setPage] = useState(1);
  const list = useQuery({ queryKey: ["t", tenantId, "goods-receipts", { mismatch, page }], placeholderData: keepPreviousData,
    queryFn: () => api<Page<GrnRow>>("GET", "/t/goods-receipts", { tenant: tenantId, query: { mismatch: mismatch || undefined, page, pageSize: 25 } }) });
  return (
    <div className="page">
      <PageHeader eyebrow="المشتريات" title="سندات الاستلام" description="كل شحنة وصلت من المورد بسندها. «تحتاج مطابقة» = بلا فاتورة مورد، أو فاتورة بمبلغ لا يطابق قيمة الاستلام." />
      <section className="panel">
        <DataTable caption="سندات الاستلام" tableId="goods-receipts" query={list} rowKey={(r) => r.id} onPageChange={setPage}
          toolbar={<StatusTabs value={mismatch} onChange={(v) => { setMismatch(v); setPage(1); }} options={[["", "الكل"], ["true", "تحتاج مطابقة"]]} />}
          filtered={Boolean(mismatch)} onClearFilters={() => setMismatch("")}
          onRowClick={(r) => navigate({ to: `/w/${tenantId}/goods-receipts/${r.id}` })}
          empty={{ title: "لا توجد سندات استلام", body: "تُنشأ من أمر الشراء المعتمد عند وصول كل شحنة." }}
          columns={[
            { key: "n", header: "السند", sortKey: false, cell: (r) => <Link to={`/w/${tenantId}/goods-receipts/${r.id}`}><strong className="num">GRN-{r.number}</strong></Link> },
            { key: "po", header: "أمر الشراء", sortKey: false, cell: (r) => <Link to={`/w/${tenantId}/purchases/${r.purchaseOrderId}`} className="num">PO-{r.poNumber}</Link> },
            { key: "s", header: "المورد", sortKey: false, cell: (r) => r.supplierName },
            { key: "d", header: "التاريخ", sortKey: false, cell: (r) => day(r.receivedOn) },
            { key: "inv", header: "فاتورة المورد", sortKey: false, cell: (r) => r.supplierInvoice ? <span className="num">{r.supplierInvoice}</span> : r.legacy ? <span className="muted">—</span> : <Badge tone="warning">غير مسجلة</Badge> },
            { key: "t", header: "الإجمالي شامل الضريبة", numeric: true, sortKey: false, cell: (r) => money(r.grandTotal) },
            { key: "v", header: "المطابقة", sortKey: false, cell: (r) => r.invoiceAmount === null ? <span className="muted">—</span> : Math.abs(r.invoiceVariance ?? 0) < 0.01 ? <Badge tone="success">مطابقة</Badge> : <Badge tone="danger">فرق {money(r.invoiceVariance)}</Badge> },
            { key: "rej", header: "المرفوض", numeric: true, sortKey: false, cell: (r) => r.rejectedLines ? <Badge tone="warning">{integer(r.rejectedLines)} صنف</Badge> : "—" },
          ]} />
      </section>
    </div>
  );
}

interface GrnDetail {
  id: string; number: number; receivedOn: string; supplierInvoice: string | null; supplierInvoiceDate: string | null; invoiceAmount: number | null; subtotal: number; discount: number; shipping: number; fees: number;
  total: number; vatRate: number; vatAmount: number; grandTotal: number; notes: string | null; createdAt: string; purchaseOrderId: string; poNumber: number; supplierName: string; supplierTaxId: string | null; locationName: string;
  items: { ingredientId: string; name: string; sku: string; purchaseUnit: string; quantity: number; rejectedQuantity: number; rejectReason: string | null; orderedPrice: number; unitPrice: number; lineTotal: number;
    batchNo: string | null; expiryDate: string | null; productionDate: string | null }[];
}

export function GoodsReceiptDetailPage() {
  const { tenantId } = useTenant();
  const { grnId } = useParams({ strict: false }) as { grnId: string };
  const g = useQuery({ queryKey: ["t", tenantId, "goods-receipts", grnId], queryFn: () => api<GrnDetail>("GET", `/t/goods-receipts/${grnId}`, { tenant: tenantId }) });
  if (g.isPending) return <div className="page"><TableSkeleton columns={6} rows={4} /></div>;
  if (g.isError) return <div className="page"><ErrorState error={g.error} onRetry={() => g.refetch()} /></div>;
  const d = g.data;
  const variance = d.invoiceAmount === null ? null : Math.round((d.invoiceAmount - d.grandTotal) * 100) / 100;
  return (
    <div className="page">
      <PageHeader eyebrow="سند استلام" title={<span className="row inv-title"><span className="num">GRN-{d.number}</span><span>· {d.supplierName}</span></span>}
        description={<>أمر الشراء <Link to={`/w/${tenantId}/purchases/${d.purchaseOrderId}`} className="num">PO-{d.poNumber}</Link> · استُلم {day(d.receivedOn)} في {d.locationName}</>}
        actions={<>
          <Link to={`/w/${tenantId}/goods-receipts`} className="btn btn-ghost no-print"><ArrowRight aria-hidden="true" />سندات الاستلام</Link>
          <Button variant="ghost" className="no-print" icon={<Printer />} onClick={() => window.print()}>طباعة السند</Button>
        </>} />
      <div className="stats stats-4 no-print">
        <StatCard label="قيمة الاستلام قبل الضريبة" value={money(d.total)} note="تُضاف للمخزون بالتكلفة الواصلة" hue="indigo" />
        <StatCard label="ضريبة المدخلات" value={money(d.vatAmount)} hue="sky" />
        <StatCard label="مستحق المورد" value={money(d.grandTotal)} hue="violet" />
        <StatCard label="المطابقة مع الفاتورة" value={variance === null ? "—" : variance === 0 ? "مطابقة" : money(variance)} note={variance === null ? "لم يُسجَّل مبلغ الفاتورة" : variance === 0 ? "أمر الشراء = الاستلام = الفاتورة" : "فرق بين الفاتورة والاستلام: راجع المورد"} noteTone={variance ? "warning" : undefined} hue={variance ? "red" : "green"} />
      </div>
      <section className="panel acc-print" aria-labelledby="grn-doc">
        <div className="card-head"><h2 id="grn-doc">سند استلام بضاعة GRN-{d.number}</h2></div>
        <div className="card-body">
          <dl className="dl">
            <dt>المورد</dt><dd>{d.supplierName}{d.supplierTaxId && <span className="muted num"> · {d.supplierTaxId}</span>}</dd>
            <dt>أمر الشراء</dt><dd className="num">PO-{d.poNumber}</dd>
            <dt>موقع الاستلام</dt><dd>{d.locationName}</dd>
            <dt>فاتورة المورد</dt><dd>{d.supplierInvoice ? <><span className="num">{d.supplierInvoice}</span>{d.supplierInvoiceDate && <span className="muted"> بتاريخ {day(d.supplierInvoiceDate)}</span>}</> : "—"}</dd>
            {d.notes && <><dt>ملاحظات</dt><dd>{d.notes}</dd></>}
          </dl>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <caption className="sr-only">أصناف السند</caption>
            <thead><tr><th scope="col">المادة</th><th scope="col" className="end">المقبول</th><th scope="col" className="end">المرفوض</th><th scope="col">سبب الرفض</th><th scope="col" className="end">سعر الأمر</th><th scope="col" className="end">سعر الفاتورة</th><th scope="col" className="end">الإجمالي</th></tr></thead>
            <tbody>{d.items.map((i) => (
              <tr key={i.ingredientId}>
                <td><strong>{i.name}</strong> <span className="muted num">{i.sku}</span>
                  {(i.batchNo || i.expiryDate) && <div className="muted acc-small">{i.batchNo && <>تشغيلة <bdi dir="ltr">{i.batchNo}</bdi></>}{i.batchNo && i.expiryDate && " · "}{i.expiryDate && <>ينتهي {day(i.expiryDate)}</>}</div>}</td>
                <td className="end num">{quantity(i.quantity)} {i.purchaseUnit}</td>
                <td className="end num">{i.rejectedQuantity > 0 ? <Badge tone="warning">{quantity(i.rejectedQuantity)}</Badge> : "—"}</td>
                <td>{text(i.rejectReason)}</td>
                <td className="end num">{money(i.orderedPrice)}</td>
                <td className="end num">{i.unitPrice !== i.orderedPrice ? <Badge tone="warning">{money(i.unitPrice)}</Badge> : money(i.unitPrice)}</td>
                <td className="end num">{money(i.lineTotal)}</td>
              </tr>
            ))}</tbody>
            <tfoot>
              <tr><td colSpan={6}>المجموع</td><td className="end num">{money(d.subtotal)}</td></tr>
              {d.discount > 0 && <tr><td colSpan={6}>نصيب الشحنة من خصم المورد</td><td className="end num">− {money(d.discount)}</td></tr>}
              {d.shipping + d.fees > 0 && <tr><td colSpan={6}>نصيب الشحنة من الشحن والرسوم</td><td className="end num">{money(d.shipping + d.fees)}</td></tr>}
              <tr><td colSpan={6}>الإجمالي قبل الضريبة</td><td className="end num">{money(d.total)}</td></tr>
              <tr><td colSpan={6}>ضريبة القيمة المضافة</td><td className="end num">{money(d.vatAmount)}</td></tr>
              <tr><td colSpan={6}><strong>المستحق للمورد</strong></td><td className="end num"><strong>{money(d.grandTotal)}</strong></td></tr>
            </tfoot>
          </table>
        </div>
        <div className="doc-signatures acc-print-only"><span>المستلِم: ____________</span><span>مراقب الجودة: ____________</span><span>مندوب المورد: ____________</span></div>
      </section>
    </div>
  );
}
