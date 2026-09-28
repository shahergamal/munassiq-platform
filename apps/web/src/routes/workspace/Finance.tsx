import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowRight, ChartPie, CircleCheck, Clock, History, Plus, Receipt, Settings2, ShoppingCart, TrendingDown, Users, Wallet } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { api, ApiError, type Page } from "../../api/client";
import type { Branch, Supplier } from "../../api/types";
import { useIdempotencyKey } from "../../app/session";
import { useInvalidate, useTenant } from "../../app/tenant";
import { RIYAL, addDays, day, dayTime, integer, isoDay, money, percent, text } from "../../lib/format";
import { Button } from "../../ui/Button";
import { DataTable } from "../../ui/DataTable";
import { useTablePrefs } from "../../ui/tablePrefs";
import { DateRange } from "../../ui/DateRange";
import { ConfirmDialog, Dialog } from "../../ui/Dialog";
import { focusFirstInvalid, SelectField, TextAreaField, TextField } from "../../ui/Field";
import { ActionMenu, Badge, PageHeader, StatCard, StatusBadge } from "../../ui/Layout";
import { EmptyState, ErrorState, FormError, TableSkeleton } from "../../ui/States";
import { LEDGER_KIND_LABELS, PAY_METHOD_LABELS } from "../../ui/status";
import { useToast } from "../../ui/Toast";
import { baseQty, StatusTabs, StockLines, useLocations, validateLines, type Line } from "./Inventory";
import { useCostCenters } from "./Accounting";

const num = (s: string) => Number(s.replace(/,/g, ""));

function useSuppliers(tenantId: string) {
  return useQuery({ queryKey: ["t", tenantId, "suppliers", "options"], queryFn: () => api<Page<Supplier>>("GET", "/t/suppliers", { tenant: tenantId, query: { isActive: "true", pageSize: 100 } }) });
}

// ── Purchase returns ────────────────────────────────────────────────────────────────────────────
interface ReturnRow { id: string; number: number; reason: string; totalValue: number; vatAmount: number; createdAt: string; supplierName: string; locationName: string; poNumber: number | null; summary: string | null }

export function PurchaseReturnsPage() {
  const { tenantId, can, writable } = useTenant();
  const [page, setPage] = useState(1);
  const prefs = useTablePrefs("purchase-returns", { server: true, onSortChange: () => setPage(1) });
  const list = useQuery({ queryKey: ["t", tenantId, "returns", { page, sort: prefs.sortParam }], queryFn: () => api<Page<ReturnRow>>("GET", "/t/purchase-returns", { tenant: tenantId, query: { page, pageSize: 25, sort: prefs.sortParam } }), placeholderData: keepPreviousData });
  const add = can("purchase_returns.create") && writable && <Link to={`/w/${tenantId}/purchase-returns/new`} className="btn btn-primary"><Plus aria-hidden="true" />مرتجع جديد</Link>;
  return (
    <div className="page">
      <PageHeader eyebrow="المشتريات" title="مرتجعات المشتريات" description="بضاعة تُعاد للمورد: تخرج من المخزون بمتوسط تكلفتها، وتُخصم قيمتها من المستحق للمورد. السجل لا يُعدَّل." actions={add} />
      <section className="panel">
        <DataTable caption="مرتجعات المشتريات" prefs={prefs} query={list} rowKey={(r) => r.id} onPageChange={setPage}
          empty={{ title: "لا توجد مرتجعات", body: "سجّل المرتجع عند إعادة بضاعة تالفة أو مخالفة للمورد.", action: add || undefined }}
          columns={[
            { key: "n", sortKey: "number", header: "الرقم", cell: (r) => <span className="num">RT-{r.number}</span> },
            { key: "d", sortKey: "createdAt", header: "الوقت", cell: (r) => dayTime(r.createdAt) },
            { key: "s", sortKey: "supplierName", header: "المورد", cell: (r) => <strong>{r.supplierName}</strong> },
            { key: "po", sortKey: "poNumber", header: "أمر الشراء", cell: (r) => (r.poNumber ? <span className="num">PO-{r.poNumber}</span> : "—") },
            { key: "i", sortKey: "summary", header: "المواد", wrap: true, cell: (r) => text(r.summary) },
            { key: "r", sortKey: "reason", header: "السبب", wrap: true, cell: (r) => r.reason },
            { key: "v", sortKey: "totalValue", header: "القيمة", numeric: true, cell: (r) => money(r.totalValue) },
            { key: "vat", sortKey: "vatAmount", header: "الضريبة", numeric: true, cell: (r) => money(r.vatAmount) },
          ]} />
      </section>
    </div>
  );
}

export function NewPurchaseReturnPage() {
  const { tenantId } = useTenant();
  const navigate = useNavigate();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const suppliers = useSuppliers(tenantId);
  const locations = useLocations(tenantId);
  const params = new URLSearchParams(window.location.search);
  const [key, renewKey] = useIdempotencyKey();
  const form = useRef<HTMLFormElement>(null);
  const [supplierId, setSupplierId] = useState(params.get("supplierId") ?? "");
  const [loc, setLoc] = useState(params.get("locationId") ?? "");
  const [poId, setPoId] = useState(params.get("poId") ?? "");
  const [reason, setReason] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const pos = useQuery({ enabled: Boolean(supplierId), queryKey: ["t", tenantId, "purchases", "received-for", supplierId],
    queryFn: () => api<Page<{ id: string; number: number; supplierName: string; createdAt: string }>>("GET", "/t/purchases", { tenant: tenantId, query: { status: "received", pageSize: 100 } }) });
  const supplierName = suppliers.data?.items.find((s) => s.id === supplierId)?.name;
  const supplierPos = (pos.data?.items ?? []).filter((p) => p.supplierName === supplierName);
  const estimate = lines.reduce((a, l) => a + baseQty(l) * l.ingredient.avgCost, 0);
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } setLines([]); }, [loc]);

  function review() {
    const e: Record<string, string> = {};
    if (!supplierId) e.supplier = "اختر المورد";
    if (!loc) e.loc = "اختر الموقع الذي تخرج منه البضاعة";
    if (reason.trim().length < 3) e.reason = "اكتب سبب الإرجاع، مثل: تالف عند الاستلام";
    validateLines(lines, e);
    setErrors(e);
    if (Object.keys(e).length) return focusFirstInvalid(form.current);
    setError(null); setConfirming(true);
  }
  async function post() {
    setBusy(true);
    try {
      const r = await api<{ totalValue: number; vatAmount: number }>("POST", "/t/purchase-returns", { tenant: tenantId, idempotencyKey: key,
        body: { supplierId, locationId: loc, purchaseOrderId: poId || null, reason: reason.trim(), items: lines.map((l) => ({ ingredientId: l.ingredient.id, quantity: baseQty(l) })) } });
      renewKey();
      toast.success(`تم تسجيل المرتجع وخصم ${money(r.totalValue + r.vatAmount)} من مستحق ${supplierName}${r.vatAmount > 0 ? ` (منها ضريبة ${money(r.vatAmount)})` : ""}`);
      await invalidate("returns", "stock", "ingredients", "payables", "reports");
      navigate({ to: `/w/${tenantId}/purchase-returns` });
    } catch (e) { setError(e); setConfirming(false); } finally { setBusy(false); }
  }
  return (
    <form ref={form} className="page" noValidate onSubmit={(e) => { e.preventDefault(); review(); }}>
      <PageHeader eyebrow="مرتجعات المشتريات" title="مرتجع جديد" actions={<Link to={`/w/${tenantId}/purchase-returns`} className="btn btn-ghost"><ArrowRight aria-hidden="true" />المرتجعات</Link>} />
      <section className="panel panel-pad form-section" aria-labelledby="rt-head">
        <h2 id="rt-head">المورد وسبب الإرجاع</h2>
        <div className="form-grid">
          <SelectField label="المورد" required placeholder="اختر المورد" value={supplierId} onChange={(e) => { setSupplierId(e.target.value); setPoId(""); }} error={errors.supplier} options={(suppliers.data?.items ?? []).map((s) => ({ value: s.id, label: s.name }))} />
          <SelectField label="يخرج من موقع" required placeholder="اختر الموقع" value={loc} onChange={(e) => setLoc(e.target.value)} error={errors.loc} options={(locations.data?.items ?? []).map((l) => ({ value: l.id, label: l.name }))} />
          <SelectField label="أمر الشراء" optional placeholder="بدون ربط" value={poId} onChange={(e) => setPoId(e.target.value)} disabled={!supplierId} options={supplierPos.map((p) => ({ value: p.id, label: `PO-${p.number} · ${day(p.createdAt)}` }))} hint="للمرجعية فقط." />
        </div>
        <TextAreaField label="سبب الإرجاع" required rows={2} value={reason} onChange={(e) => setReason(e.target.value)} error={errors.reason} />
      </section>
      <StockLines tenantId={tenantId} locationId={loc} lines={lines} setLines={(f) => setLines(f)} errors={errors} />
      <FormError error={error} />
      <div className="pf-form-foot">
        <Button type="submit" variant="primary">مراجعة وتسجيل المرتجع</Button>
        <Link to={`/w/${tenantId}/purchase-returns`} className="btn btn-ghost">إلغاء</Link>
        <span className="spacer" /><span>القيمة التقديرية: <strong className="num">{money(estimate)}</strong></span>
      </div>
      <ConfirmDialog open={confirming} onClose={() => setConfirming(false)} busy={busy} destructive={false} onConfirm={() => void post()}
        title="تأكيد المرتجع" confirmLabel="تسجيل المرتجع وخصم المخزون"
        message={<>ستخرج {integer(lines.length)} مادة من المخزون وتُخصم قيمتها (تقديرياً {money(estimate)}) من مستحق <strong>{supplierName}</strong>. لا يمكن التراجع.</>} />
    </form>
  );
}

// ── Payables ────────────────────────────────────────────────────────────────────────────────────
interface PayableRow { supplierId: string; name: string; paymentTermsDays: number; purchases: number; returns: number; payments: number; balance: number; lastPaymentOn: string | null }

export function PayablesPage() {
  const { tenantId, can, writable } = useTenant();
  const navigate = useNavigate();
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [page, setPage] = useState(1);
  const prefs = useTablePrefs("payables", { server: true, onSortChange: () => setPage(1) });
  const [paying, setPaying] = useState<{ supplierId: string; balance: number } | null>(null);
  const list = useQuery({ queryKey: ["t", tenantId, "payables", { onlyOpen, page, sort: prefs.sortParam }], queryFn: () => api<Page<PayableRow> & { totalOwed: number }>("GET", "/t/payables", { tenant: tenantId, query: { onlyOpen, page, pageSize: 25, sort: prefs.sortParam } }), placeholderData: keepPreviousData });
  const canPay = can("payables.pay") && writable;
  return (
    <div className="page">
      <PageHeader eyebrow="المالية" title="مستحقات الموردين" description="المستلم من أوامر الشراء ناقص المرتجعات والدفعات. المبالغ كما في أوامر الشراء (قبل الضريبة في هذا الإصدار)."
        actions={canPay && <Button variant="primary" icon={<Plus />} onClick={() => setPaying({ supplierId: "", balance: 0 })}>تسجيل دفعة</Button>} />
      {list.data && <div className="stats">
        <StatCard label="إجمالي المستحق للموردين" value={money(list.data.totalOwed)} note="المستلم ناقص المرتجعات والدفعات" icon={<Wallet />} hue="violet" />
        <StatCard label={onlyOpen ? "موردون لهم رصيد" : "الموردون"} value={integer(list.data.meta.total)} note="اضغط المورد لعرض كشف حسابه" icon={<Users />} hue="sky" />
      </div>}
      <section className="panel">
        <DataTable caption="مستحقات الموردين" prefs={prefs} query={list} rowKey={(r) => r.supplierId} onPageChange={setPage} filtered={onlyOpen} onClearFilters={() => { setOnlyOpen(false); setPage(1); }}
          toolbar={<label className="checkbox"><input type="checkbox" checked={onlyOpen} onChange={(e) => { setOnlyOpen(e.target.checked); setPage(1); }} />الموردون الذين لهم رصيد فقط</label>}
          onRowClick={(r) => navigate({ to: `/w/${tenantId}/payables/${r.supplierId}` })}
          empty={{ title: "لا توجد مستحقات", body: "تظهر المستحقات بعد استلام أول أمر شراء." }}
          columns={[
            { key: "n", sortKey: "name", header: "المورد", cell: (r) => <Link to={`/w/${tenantId}/payables/${r.supplierId}`}><strong>{r.name}</strong></Link> },
            { key: "t", sortKey: "paymentTermsDays", header: "مدة السداد", cell: (r) => (r.paymentTermsDays ? `${integer(r.paymentTermsDays)} يوم` : "نقدي") },
            { key: "p", sortKey: "purchases", header: "المشتريات", numeric: true, cell: (r) => money(r.purchases) },
            { key: "r", sortKey: "returns", header: "المرتجعات", numeric: true, cell: (r) => money(r.returns) },
            { key: "pay", sortKey: "payments", header: "المدفوع", numeric: true, cell: (r) => money(r.payments) },
            { key: "b", sortKey: "balance", header: "الرصيد المستحق", numeric: true, cell: (r) => <span className="pf-num-cell">{r.balance < 0 && <Badge tone="warning">دفعة زائدة</Badge>}<strong>{money(r.balance)}</strong></span> },
            { key: "l", sortKey: "lastPaymentOn", header: "آخر دفعة", cell: (r) => day(r.lastPaymentOn) },
          ]}
          actions={canPay ? (r) => <ActionMenu label={`إجراءات ${r.name}`} items={[
            { label: "تسجيل دفعة", onSelect: () => setPaying({ supplierId: r.supplierId, balance: r.balance }) },
            { label: "كشف الحساب", onSelect: () => navigate({ to: `/w/${tenantId}/payables/${r.supplierId}` }) },
          ]} /> : undefined} />
      </section>
      {paying && <PaymentDialog tenantId={tenantId} initial={paying} onClose={() => setPaying(null)} />}
    </div>
  );
}

function PaymentDialog({ tenantId, initial, onClose }: { tenantId: string; initial: { supplierId: string; balance: number }; onClose: () => void }) {
  const suppliers = useSuppliers(tenantId);
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [key, renewKey] = useIdempotencyKey();
  const [v, setV] = useState({ supplierId: initial.supplierId, paidOn: isoDay(), amount: initial.balance > 0 ? initial.balance.toFixed(2) : "", method: "bank_transfer", reference: "", notes: "", withholdingCode: "" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const foreign = suppliers.data?.items.find((s) => s.id === v.supplierId)?.residency === "non_resident";
  const rates = useQuery({ enabled: foreign, queryKey: ["t", tenantId, "withholding-rates"], queryFn: () => api<{ items: { code: string; name: string; rate: number }[] }>("GET", "/t/withholding-rates", { tenant: tenantId }), staleTime: 3_600_000 });
  const rate = rates.data?.items.find((r) => r.code === v.withholdingCode)?.rate ?? 0;
  // Display only: the server computes the tax from the rate in force on the payment date.
  const wht = Math.round(num(v.amount || "0") * rate) / 100;
  async function submit() {
    if (!v.supplierId) return setError("اختر المورد");
    if (!(num(v.amount) > 0)) return setError("أدخل مبلغ الدفعة");
    if (foreign && !v.withholdingCode) return setError("المورد غير مقيم: اختر نوع الدفعة لاستقطاع الضريبة");
    setBusy(true); setError(null);
    try {
      await api("POST", "/t/supplier-payments", { tenant: tenantId, idempotencyKey: key, body: { ...v, amount: num(v.amount), reference: v.reference.trim() || null, notes: v.notes.trim() || null,
        withholdingCode: foreign ? v.withholdingCode : undefined } });
      renewKey();
      toast.success(`تم تسجيل دفعة ${money(num(v.amount))}`);
      await invalidate("payables");
      onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} title="تسجيل دفعة لمورد" onSubmit={() => void submit()}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ التسجيل…">تسجيل الدفعة</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <p className="muted">الدفعة المسجلة لا تُعدَّل ولا تُحذف. تحقق من المبلغ قبل التسجيل.</p>
      <div className="form-grid">
        <SelectField label="المورد" required placeholder="اختر المورد" value={v.supplierId} onChange={(e) => setV({ ...v, supplierId: e.target.value })} options={(suppliers.data?.items ?? []).map((s) => ({ value: s.id, label: s.name }))} />
        <TextField label={`المبلغ (${RIYAL})`} required numeric value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} hint={initial.balance > 0 ? `المستحق الحالي ${money(initial.balance)}` : undefined} />
        <TextField label="تاريخ الدفع" type="date" required value={v.paidOn} max={isoDay()} onChange={(e) => setV({ ...v, paidOn: e.target.value })} />
        <SelectField label="طريقة الدفع" required value={v.method} onChange={(e) => setV({ ...v, method: e.target.value })} options={Object.entries(PAY_METHOD_LABELS).map(([value, label]) => ({ value, label }))} />
        <TextField label="رقم المرجع" optional dir="ltr" value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} hint="رقم الحوالة أو الشيك." />
        {foreign && (
          <SelectField label="نوع الدفعة (ضريبة الاستقطاع)" required placeholder="اختر" value={v.withholdingCode} onChange={(e) => setV({ ...v, withholdingCode: e.target.value })}
            options={[...(rates.data?.items ?? []).map((r) => ({ value: r.code, label: `${r.name} (${r.rate}٪)` })), { value: "none", label: "غير خاضعة (شراء سلع)" }]}
            hint="المورد غير مقيم: تُستقطع الضريبة من الدفعة وتُسدَّد للهيئة قبل يوم 10 من الشهر التالي." />
        )}
      </div>
      {foreign && wht > 0 && <p role="status">يُستقطع <strong>{money(wht)}</strong> ويُحوَّل للمورد <strong>{money(num(v.amount) - wht)}</strong>، ويُخصم من رصيده المبلغ كاملاً.</p>}
      <FormError error={error} />
    </Dialog>
  );
}

interface Statement { supplier: { id: string; name: string }; from: string; to: string; openingBalance: number; closingBalance: number; lines: { d: string; kind: string; refId: string; refNumber: number; debit: number; credit: number; note: string | null; balance: number }[] }

export function SupplierStatementPage() {
  const { tenantId, can, writable } = useTenant();
  const { supplierId } = useParams({ strict: false }) as { supplierId: string };
  const [from, setFrom] = useState(addDays(isoDay(), -89));
  const [to, setTo] = useState(isoDay());
  const [paying, setPaying] = useState(false);
  const s = useQuery({ queryKey: ["t", tenantId, "payables", "statement", supplierId, from, to], placeholderData: keepPreviousData,
    queryFn: () => api<Statement>("GET", `/t/suppliers/${supplierId}/statement`, { tenant: tenantId, query: { from, to } }) });
  if (s.isError) return <div className="page"><ErrorState error={s.error} onRetry={() => s.refetch()} /></div>;
  const d = s.data;
  const prefix: Record<string, string> = { purchase: "GRN-", return: "RT-", payment: "PY-" };
  return (
    <div className="page">
      <PageHeader eyebrow="كشف حساب مورد" title={d?.supplier.name ?? "…"} description={`من ${day(from)} إلى ${day(to)}`}
        actions={<>
          <Link to={`/w/${tenantId}/payables`} className="btn btn-ghost"><ArrowRight aria-hidden="true" />المستحقات</Link>
          <Button onClick={() => window.print()}>طباعة الكشف</Button>
          {can("payables.pay") && writable && <Button variant="primary" onClick={() => setPaying(true)}>تسجيل دفعة</Button>}
        </>} />
      <div className="toolbar panel"><DateRange from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} /></div>
      {d && <div className="stats stats-4">
        <StatCard label="الرصيد الافتتاحي" value={money(d.openingBalance)} note={`في ${day(d.from)}`} icon={<History />} hue="sky" />
        <StatCard label="مدين في الفترة (مستحق)" value={money(d.lines.reduce((a, l) => a + l.debit, 0))} note="أوامر شراء مستلمة" icon={<ShoppingCart />} hue="indigo" />
        <StatCard label="دائن في الفترة (مسدد)" value={money(d.lines.reduce((a, l) => a + l.credit, 0))} note="دفعات ومرتجعات" icon={<CircleCheck />} hue="green" />
        <StatCard label="الرصيد الختامي المستحق" value={money(d.closingBalance)} note={`في ${day(d.to)}`} icon={<Wallet />} hue="violet" />
      </div>}
      <section className="panel print-area" aria-labelledby="stmt-h">
        <div className="toolbar"><h2 id="stmt-h">الحركات</h2>{d && <span className="badge badge-neutral"><span className="num">{integer(d.lines.length)}</span>&nbsp;حركة</span>}</div>
        {!d ? <TableSkeleton columns={6} rows={5} label="جارٍ تحميل الكشف…" /> : d.lines.length === 0 ? <EmptyState title="لا توجد حركات في هذه الفترة" /> : (
          <div className="table-wrap">
            <table className="data-table">
              <caption className="sr-only">كشف حساب {d.supplier.name}</caption>
              <thead><tr><th scope="col">التاريخ</th><th scope="col">البيان</th><th scope="col">المرجع</th><th scope="col" className="end">مدين (مستحق)</th><th scope="col" className="end">دائن (مسدد)</th><th scope="col" className="end">الرصيد</th></tr></thead>
              <tbody>
                <tr><td>{day(d.from)}</td><td colSpan={4}>رصيد افتتاحي</td><td className="end num">{money(d.openingBalance)}</td></tr>
                {d.lines.map((l) => (
                  <Fragment key={`${l.kind}-${l.refId}`}>
                    <tr>
                      <td>{day(l.d)}</td>
                      <td>{LEDGER_KIND_LABELS[l.kind]}{l.note && <span className="muted"> · {l.note}</span>}</td>
                      <td>{l.kind === "purchase" ? <Link to={`/w/${tenantId}/goods-receipts/${l.refId}`} className="num">{prefix[l.kind]}{l.refNumber}</Link> : <span className="num">{prefix[l.kind]}{l.refNumber}</span>}</td>
                      <td className="end num">{l.debit ? money(l.debit) : "—"}</td>
                      <td className="end num">{l.credit ? money(l.credit) : "—"}</td>
                      <td className="end num">{money(l.balance)}</td>
                    </tr>
                  </Fragment>
                ))}
              </tbody>
              <tfoot><tr><td colSpan={5}>الرصيد الختامي</td><td className="end num">{money(d.closingBalance)}</td></tr></tfoot>
            </table>
          </div>
        )}
      </section>
      {paying && d && <PaymentDialog tenantId={tenantId} initial={{ supplierId, balance: d.closingBalance }} onClose={() => setPaying(false)} />}
    </div>
  );
}

// ── Expenses ────────────────────────────────────────────────────────────────────────────────────
interface ExpenseRow { id: string; number: number; expenseDate: string; description: string; amountNet: number; vatAmount: number; total: number; status: string; paymentMethod: string | null; reference: string | null; cancelReason: string | null; categoryName: string; branchName: string | null; isMine: boolean }
interface Category { id: string; name: string; isActive: boolean }

function useCategories(tenantId: string) {
  return useQuery({ queryKey: ["t", tenantId, "expenses", "categories"], queryFn: () => api<{ items: Category[] }>("GET", "/t/expense-categories", { tenant: tenantId }) });
}

export function ExpensesPage() {
  const { tenantId, ctx, can, writable } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const categories = useCategories(tenantId);
  const [from, setFrom] = useState(addDays(isoDay(), -29));
  const [to, setTo] = useState(isoDay());
  const [status, setStatus] = useState("");
  const [cat, setCat] = useState("");
  const [page, setPage] = useState(1);
  const prefs = useTablePrefs("expenses", { server: true, onSortChange: () => setPage(1) });
  const [creating, setCreating] = useState(false);
  const [managing, setManaging] = useState(false);
  const [paying, setPaying] = useState<ExpenseRow | null>(null);
  const [cancelling, setCancelling] = useState<ExpenseRow | null>(null);
  const list = useQuery({ queryKey: ["t", tenantId, "expenses", { from, to, status, cat, page, sort: prefs.sortParam }], placeholderData: keepPreviousData,
    queryFn: () => api<Page<ExpenseRow> & { summary: { total: number; pending: number } }>("GET", "/t/expenses", { tenant: tenantId, query: { from, to, status, categoryId: cat, page, pageSize: 25, sort: prefs.sortParam } }) });
  const canWrite = can("expenses.create") && writable;
  const canCancel = can("expenses.cancel") && writable;
  const canCategories = can("expenses.categories") && writable;
  const canApprove = can("expenses.approve") && writable;
  const canPay = can("expenses.pay") && writable;

  async function approve(e: ExpenseRow) {
    try { await api("POST", `/t/expenses/${e.id}/approve`, { tenant: tenantId }); toast.success(`تم اعتماد المصروف EX-${e.number}`); await invalidate("expenses", "reports"); }
    catch (err) { toast.error((err as Error).message); }
  }
  const add = canWrite && <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>تسجيل مصروف</Button>;
  return (
    <div className="page">
      <PageHeader eyebrow="المالية" title="المصروفات" description="مصروفات التشغيل: تُسجَّل ثم يعتمدها شخص آخر ثم تُسدَّد. من يسجل المصروف لا يعتمده، إلا المالك."
        actions={<>{canCategories && <Button icon={<Settings2 />} onClick={() => setManaging(true)}>الفئات</Button>}{add}</>} />
      {list.data && <div className="stats">
        <StatCard label="مصروفات الفترة" value={money(list.data.summary.total)} note="شامل الضريبة، دون الملغى" icon={<Receipt />} hue="red" />
        <StatCard label="بانتظار الاعتماد" value={money(list.data.summary.pending)} noteTone={list.data.summary.pending ? "warning" : undefined} note={list.data.summary.pending ? "تحتاج مراجعة" : "لا شيء معلّق"} icon={<Clock />} hue="amber" />
      </div>}
      <section className="panel">
        <DataTable caption="المصروفات" prefs={prefs} query={list} rowKey={(r) => r.id} onPageChange={setPage} filtered={Boolean(status || cat)} onClearFilters={() => { setStatus(""); setCat(""); setPage(1); }}
          toolbar={<>
          <DateRange from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); setPage(1); }} />
          <StatusTabs value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={[["", "الكل"], ["pending", "بانتظار الاعتماد"], ["approved", "معتمدة"], ["paid", "مدفوعة"], ["cancelled", "ملغاة"]]} />
          <select className="select" aria-label="الفئة" value={cat} onChange={(e) => { setCat(e.target.value); setPage(1); }}>
            <option value="">كل الفئات</option>{(categories.data?.items ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          </>}
          empty={{ title: "لا توجد مصروفات في هذه الفترة", body: "سجّل الإيجار والرواتب والفواتير لتظهر في تقرير المصروفات.", action: add || undefined }}
          columns={[
            { key: "n", sortKey: "number", header: "الرقم", cell: (r) => <span className="num">EX-{r.number}</span> },
            { key: "d", sortKey: "expenseDate", header: "التاريخ", cell: (r) => day(r.expenseDate) },
            { key: "c", sortKey: "categoryName", header: "الفئة", cell: (r) => r.categoryName },
            { key: "desc", sortKey: "description", header: "البيان", wrap: true, cell: (r) => <><strong>{r.description}</strong>{r.branchName && <span className="muted"> · {r.branchName}</span>}{r.cancelReason && <div className="muted" style={{ fontSize: "var(--fs-xs)" }}>أُلغي: {r.cancelReason}</div>}</> },
            { key: "net", sortKey: "amountNet", header: "قبل الضريبة", numeric: true, cell: (r) => money(r.amountNet) },
            { key: "vat", sortKey: "vatAmount", header: "الضريبة", numeric: true, cell: (r) => money(r.vatAmount) },
            { key: "t", sortKey: "total", header: "الإجمالي", numeric: true, cell: (r) => money(r.total) },
            { key: "s", sortKey: "status", header: "الحالة", cell: (r) => <span className="row pf-status-cell"><StatusBadge kind="expense" value={r.status} />{r.paymentMethod && <span className="muted" style={{ fontSize: "var(--fs-xs)" }}>{PAY_METHOD_LABELS[r.paymentMethod]}</span>}</span> },
          ]}
          actions={(r) => {
            const items = [
              ...(r.status === "pending" && canApprove && (!r.isMine || ctx.role === "owner") ? [{ label: "اعتماد", onSelect: () => void approve(r) }] : []),
              ...(r.status === "approved" && canPay ? [{ label: "تسجيل السداد", onSelect: () => setPaying(r) }] : []),
              ...(r.status === "pending" && canCancel ? [{ label: "إلغاء المصروف", danger: true, separated: true, onSelect: () => setCancelling(r) }] : []),
            ];
            if (r.status === "pending" && r.isMine && ctx.role !== "owner" && canApprove) return <Badge tone="neutral">يعتمده غيرك</Badge>;
            return items.length ? <ActionMenu label={`إجراءات المصروف EX-${r.number}`} items={items} /> : null;
          }} />
      </section>
      {creating && <ExpenseDialog tenantId={tenantId} categories={(categories.data?.items ?? []).filter((c) => c.isActive)} onClose={() => setCreating(false)} />}
      {managing && <CategoriesDialog tenantId={tenantId} categories={categories.data?.items ?? []} onClose={() => setManaging(false)} />}
      {paying && <PayExpenseDialog tenantId={tenantId} expense={paying} onClose={() => setPaying(null)} />}
      {cancelling && <CancelExpenseDialog tenantId={tenantId} expense={cancelling} onClose={() => setCancelling(null)} />}
    </div>
  );
}

function ExpenseDialog({ tenantId, categories, onClose }: { tenantId: string; categories: Category[]; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [key, renewKey] = useIdempotencyKey();
  const form = useRef<HTMLFormElement>(null);
  const branches = useQuery({ queryKey: ["t", tenantId, "branches", "options"], queryFn: () => api<Page<Branch>>("GET", "/t/branches", { tenant: tenantId, query: { isActive: "true", pageSize: 100 } }) });
  const centers = useCostCenters(tenantId);
  const activeCenters = (centers.data?.items ?? []).filter((c) => c.isActive);
  const [v, setV] = useState({ categoryId: "", branchId: "", costCenterId: "", expenseDate: isoDay(), description: "", amountNet: "", vatAmount: "0", reference: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const total = (num(v.amountNet) || 0) + (num(v.vatAmount) || 0);
  async function submit() {
    const e: Record<string, string> = {};
    if (!v.categoryId) e.categoryId = "اختر فئة المصروف";
    if (v.description.trim().length < 3) e.description = "صف المصروف في كلمات، مثل: إيجار شهر سبتمبر";
    if (!(num(v.amountNet) > 0)) e.amountNet = "أدخل المبلغ قبل الضريبة";
    if (!(num(v.vatAmount) >= 0)) e.vatAmount = "صفر أو أكبر";
    else if (num(v.vatAmount) > num(v.amountNet)) e.vatAmount = "الضريبة أكبر من المبلغ. تأكد من فاتورة المورد";
    setErrors(e);
    if (Object.keys(e).length) return focusFirstInvalid(form.current);
    setBusy(true); setError(null);
    try {
      await api("POST", "/t/expenses", { tenant: tenantId, idempotencyKey: key, body: {
        categoryId: v.categoryId, branchId: v.branchId || null, costCenterId: v.costCenterId || null, expenseDate: v.expenseDate, description: v.description.trim(),
        amountNet: num(v.amountNet), vatAmount: num(v.vatAmount) || 0, reference: v.reference.trim() || null } });
      renewKey();
      toast.success("تم تسجيل المصروف، وهو بانتظار الاعتماد");
      await invalidate("expenses");
      onClose();
    } catch (err) { if (err instanceof ApiError) setErrors(err.fieldErrors); setError(err); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} formRef={form} title="تسجيل مصروف" onSubmit={() => void submit()}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ التسجيل…">تسجيل المصروف</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <div className="form-grid">
        <SelectField label="الفئة" required placeholder="اختر الفئة" value={v.categoryId} onChange={(e) => setV({ ...v, categoryId: e.target.value })} error={errors.categoryId} options={categories.map((c) => ({ value: c.id, label: c.name }))} />
        <TextField label="التاريخ" type="date" required max={isoDay()} value={v.expenseDate} onChange={(e) => setV({ ...v, expenseDate: e.target.value })} />
      </div>
      <TextField label="البيان" required value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} error={errors.description} />
      <div className="form-grid">
        <TextField label={`المبلغ قبل الضريبة (${RIYAL})`} required numeric value={v.amountNet} onChange={(e) => setV({ ...v, amountNet: e.target.value })} error={errors.amountNet} />
        <TextField label={`ضريبة القيمة المضافة (${RIYAL})`} numeric value={v.vatAmount} onChange={(e) => setV({ ...v, vatAmount: e.target.value })} error={errors.vatAmount} hint="كما في الفاتورة. صفر إن لم تكن خاضعة." />
        <SelectField label="الفرع" optional placeholder="عام (كل الفروع)" value={v.branchId} onChange={(e) => setV({ ...v, branchId: e.target.value })} options={(branches.data?.items ?? []).map((b) => ({ value: b.id, label: b.name }))} />
        {activeCenters.length > 0 && (
          <SelectField label="مركز التكلفة" optional placeholder="بدون مركز تكلفة" value={v.costCenterId} onChange={(e) => setV({ ...v, costCenterId: e.target.value })}
            error={errors.costCenterId} options={activeCenters.map((c) => ({ value: c.id, label: `${c.code} · ${c.name}` }))} />
        )}
        <TextField label="رقم الفاتورة أو المرجع" optional dir="ltr" value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} />
      </div>
      <p className="pf-total">الإجمالي: <strong className="num">{money(total)}</strong></p>
      <FormError error={error} />
    </Dialog>
  );
}

function PayExpenseDialog({ tenantId, expense, onClose }: { tenantId: string; expense: ExpenseRow; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [method, setMethod] = useState("bank_transfer");
  const [reference, setReference] = useState(expense.reference ?? "");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true); setError(null);
    try {
      await api("POST", `/t/expenses/${expense.id}/pay`, { tenant: tenantId, body: { method, reference: reference.trim() || null } });
      toast.success(`تم تسجيل سداد EX-${expense.number}`);
      await invalidate("expenses", "reports");
      onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} title={`سداد EX-${expense.number}: ${money(expense.total)}`} onSubmit={() => void submit()}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ التسجيل…">تسجيل السداد</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <p>{expense.description} · {expense.categoryName}</p>
      <div className="form-grid">
        <SelectField label="طريقة الدفع" required value={method} onChange={(e) => setMethod(e.target.value)} options={Object.entries(PAY_METHOD_LABELS).map(([value, label]) => ({ value, label }))} />
        <TextField label="رقم المرجع" optional dir="ltr" value={reference} onChange={(e) => setReference(e.target.value)} />
      </div>
      <FormError error={error} />
    </Dialog>
  );
}

function CancelExpenseDialog({ tenantId, expense, onClose }: { tenantId: string; expense: ExpenseRow; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <ConfirmDialog open onClose={onClose} busy={busy} error={error} title={`إلغاء EX-${expense.number}`} confirmLabel="إلغاء المصروف"
      message={<>سيبقى المصروف «{expense.description}» ({money(expense.total)}) في السجل ملغى ولن يدخل في التقارير.</>}
      onConfirm={async () => {
        if (reason.trim().length < 3) return setError("اكتب سبب الإلغاء");
        setBusy(true); setError(null);
        try { await api("POST", `/t/expenses/${expense.id}/cancel`, { tenant: tenantId, body: { reason: reason.trim() } }); toast.success("تم إلغاء المصروف"); await invalidate("expenses"); onClose(); }
        catch (e) { setError((e as Error).message); } finally { setBusy(false); }
      }}>
      <TextAreaField label="سبب الإلغاء" required value={reason} onChange={(e) => setReason(e.target.value)} />
    </ConfirmDialog>
  );
}

function CategoriesDialog({ tenantId, categories, onClose }: { tenantId: string; categories: Category[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["t", tenantId, "expenses", "categories"] });
  async function add() {
    if (name.trim().length < 2) return setError("أدخل اسم الفئة");
    setBusy(true); setError(null);
    try { await api("POST", "/t/expense-categories", { tenant: tenantId, body: { name: name.trim() } }); setName(""); await refresh(); }
    catch (e) { setError(e instanceof ApiError && e.code === "duplicate" ? "هذه الفئة موجودة" : e); } finally { setBusy(false); }
  }
  async function toggle(c: Category) {
    try { await api("PATCH", `/t/expense-categories/${c.id}`, { tenant: tenantId, body: { isActive: !c.isActive } }); await refresh(); } catch (e) { setError(e); }
  }
  return (
    <Dialog open onClose={onClose} title="فئات المصروفات" onSubmit={() => void add()}
      footer={<Button onClick={onClose}>تم</Button>}>
      <div className="row" style={{ alignItems: "flex-end", flexWrap: "nowrap" }}>
        <TextField label="فئة جديدة" value={name} onChange={(e) => setName(e.target.value)} />
        <Button type="submit" loading={busy} loadingText="…">إضافة</Button>
      </div>
      <FormError error={error} />
      <ul className="pf-cat-list">
        {categories.map((c) => (
          <li key={c.id} className={c.isActive ? undefined : "is-off"}>
            <span className="pf-cat-name">{c.name}</span>
            {!c.isActive && <Badge tone="neutral">موقوفة</Badge>}
            <Button size="sm" variant="ghost" onClick={() => void toggle(c)}>{c.isActive ? "إيقاف" : "تفعيل"}</Button>
          </li>
        ))}
      </ul>
      <p className="muted" style={{ fontSize: "var(--fs-xs)" }}>الفئة الموقوفة لا تظهر عند التسجيل، وتبقى في التقارير السابقة.</p>
    </Dialog>
  );
}

export function ExpensesReport() {
  const { tenantId } = useTenant();
  const [from, setFrom] = useState(addDays(isoDay(), -29));
  const [to, setTo] = useState(isoDay());
  const r = useQuery({ queryKey: ["t", tenantId, "reports", "expenses", from, to], placeholderData: keepPreviousData,
    queryFn: () => api<{ byCategory: { name: string; count: number; net: number; vat: number; total: number }[]; totalNet: number; netSales: number; expenseRatio: number | null }>("GET", "/t/reports/expenses", { tenant: tenantId, query: { from, to } }) });
  return (
    <div className="page">
      <PageHeader eyebrow="التقارير" title="تقرير المصروفات" description="المصروفات المعتمدة والمدفوعة حسب الفئة، ونسبتها من صافي المبيعات في الفترة نفسها." />
      <div className="toolbar panel"><DateRange from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} /></div>
      {r.data && <div className="stats">
        <StatCard label="المصروفات قبل الضريبة" value={money(r.data.totalNet)} note="المعتمدة والمدفوعة" icon={<TrendingDown />} hue="red" />
        <StatCard label="صافي المبيعات" value={money(r.data.netSales)} note="في الفترة نفسها" icon={<Receipt />} hue="indigo" />
        <StatCard label="نسبة المصروفات من المبيعات" value={percent(r.data.expenseRatio)} note={r.data.expenseRatio === null ? "لا توجد مبيعات في الفترة" : undefined} icon={<ChartPie />} hue="violet" />
      </div>}
      <section className="panel">
        <DataTable caption="المصروفات حسب الفئة" query={{ ...r, data: r.data ? { items: r.data.byCategory } : undefined }} rowKey={(x) => x.name}
          empty={{ title: "لا توجد مصروفات معتمدة في الفترة", body: "المصروفات بانتظار الاعتماد لا تظهر هنا." }}
          columns={[
            { key: "n", sortKey: "name", header: "الفئة", cell: (x) => <strong>{x.name}</strong> },
            { key: "c", sortKey: "count", header: "العدد", numeric: true, cell: (x) => integer(x.count) },
            { key: "net", header: "قبل الضريبة", numeric: true, cell: (x) => money(x.net) },
            { key: "vat", header: "الضريبة", numeric: true, cell: (x) => money(x.vat) },
            { key: "t", sortKey: "total", header: "الإجمالي", numeric: true, cell: (x) => money(x.total) },
          ]} />
      </section>
    </div>
  );
}

interface WhtReport {
  month: string; from: string; to: string; dueDate: string; total: number; payableBalance: number;
  rows: { code: string; name: string; rate: number; payments: number; gross: number; tax: number }[];
  payments: { id: string; number: number; paidOn: string; supplierName: string; code: string; rate: number; gross: number; tax: number }[];
}

/** Monthly withholding return: what was withheld from non-resident suppliers, by payment type, and when it is due. */
export function WithholdingReport() {
  const { tenantId } = useTenant();
  const [month, setMonth] = useState(isoDay().slice(0, 7));
  const r = useQuery({ queryKey: ["t", tenantId, "reports", "withholding", month], placeholderData: keepPreviousData,
    queryFn: () => api<WhtReport>("GET", "/t/reports/withholding", { tenant: tenantId, query: { month } }) });
  const d = r.data;
  return (
    <div className="page">
      <PageHeader eyebrow="التقارير" title="ضريبة الاستقطاع"
        description="ما استُقطع من دفعات الموردين غير المقيمين خلال الشهر حسب نوع الدفعة. يُقدَّم الإقرار ويُسدَّد للهيئة قبل يوم 10 من الشهر التالي." />
      <div className="toolbar panel sr-filter-bar"><TextField label="الشهر" type="month" value={month} max={isoDay().slice(0, 7)} onChange={(e) => setMonth(e.target.value || isoDay().slice(0, 7))} /></div>
      {r.isError ? <ErrorState error={r.error} onRetry={() => r.refetch()} /> : !d ? <TableSkeleton columns={5} rows={3} label="جارٍ تحميل التقرير…" /> : <>
        <div className="stats">
          <StatCard label="المستقطع في الشهر" value={money(d.total)} icon={<Receipt />} hue="indigo" note={`موعد السداد ${day(d.dueDate)}`} />
          <StatCard label="رصيد ضريبة الاستقطاع المستحقة" value={money(d.payableBalance)} icon={<Wallet />} hue="amber" note="من دفتر الأستاذ، لكل الفترات" />
        </div>
        <section className="panel" aria-label="حسب نوع الدفعة">
          {d.rows.length === 0 ? <EmptyState title="لا استقطاع في هذا الشهر">لم تُسجَّل دفعات لموردين غير مقيمين خاضعة للاستقطاع.</EmptyState> : (
            <div className="table-wrap">
              <table className="data-table">
                <caption className="sr-only">ضريبة الاستقطاع حسب نوع الدفعة</caption>
                <thead><tr><th scope="col">نوع الدفعة</th><th scope="col" className="end">النسبة</th><th scope="col" className="end">عدد الدفعات</th><th scope="col" className="end">المبالغ المدفوعة</th><th scope="col" className="end">الضريبة</th></tr></thead>
                <tbody>{d.rows.map((x) => <tr key={`${x.code}-${x.rate}`}><td>{x.name}</td><td className="end num">{percent(x.rate)}</td><td className="end num">{integer(x.payments)}</td><td className="end num">{money(x.gross)}</td><td className="end num">{money(x.tax)}</td></tr>)}</tbody>
                <tfoot><tr><td colSpan={4}>الإجمالي</td><td className="end num">{money(d.total)}</td></tr></tfoot>
              </table>
            </div>
          )}
        </section>
        {d.payments.length > 0 && (
          <section className="panel" aria-label="الدفعات">
            <div className="table-wrap">
              <table className="data-table">
                <caption className="sr-only">الدفعات الخاضعة للاستقطاع</caption>
                <thead><tr><th scope="col">الدفعة</th><th scope="col">التاريخ</th><th scope="col">المورد</th><th scope="col" className="end">المبلغ</th><th scope="col" className="end">الضريبة</th></tr></thead>
                <tbody>{d.payments.map((p) => <tr key={p.id}><td className="num">PY-{p.number}</td><td>{day(p.paidOn)}</td><td>{p.supplierName}</td><td className="end num">{money(p.gross)}</td><td className="end num">{money(p.tax)} <span className="muted">({percent(p.rate)})</span></td></tr>)}</tbody>
              </table>
            </div>
          </section>
        )}
      </>}
    </div>
  );
}
