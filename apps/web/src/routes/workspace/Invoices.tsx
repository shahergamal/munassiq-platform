import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowRight, Download, FileMinus, FilePlus, HandCoins, Plus, Printer, Send, X } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, download, type Page } from "../../api/client";
import type { Branch, Customer } from "../../api/types";
import { useIdempotencyKey } from "../../app/session";
import { useInvalidate, useTenant } from "../../app/tenant";
import { RIYAL, day, dayTime, integer, isoDay, money, percent, quantity, text, hijri } from "../../lib/format";
import { Button, IconButton } from "../../ui/Button";
import { DataTable } from "../../ui/DataTable";
import { ConfirmDialog, Dialog } from "../../ui/Dialog";
import { Checkbox, focusFirstInvalid, SearchInput, SelectField, TextAreaField, TextField } from "../../ui/Field";
import { Badge, PageHeader, StatusBadge } from "../../ui/Layout";
import { ErrorState, FormError, Skeleton, TableSkeleton } from "../../ui/States";
import { ID_SCHEME_LABELS, INVOICE_TYPE_LABELS, PAY_METHOD_LABELS, PAYMENT_MEANS_LABELS, RECEIPT_METHOD_LABELS, VAT_CATEGORY_LABELS } from "../../ui/status";
import { PaymentLinksPanel } from "./Payments";
import { useToast } from "../../ui/Toast";
import { StatusTabs } from "./Inventory";
import { CustomerForm } from "./PosSetup";
import { ENV_LABELS, ZatcaBadge } from "./Zatca";
import { CustomerPicker } from "./pickers";

type Kind = "invoice" | "credit_note" | "debit_note";
/** Issued documents also include prepayment invoices (386), which only a sales order issues. */
type DocKind = Kind | "prepayment";
type InvoiceType = "standard" | "simplified";
type VatCategory = "S" | "Z" | "E" | "O";

interface DocRow { id: string; kind: DocKind; invoiceType: InvoiceType; number: string; issueDate: string; dueDate: string | null; total: number; vat: number; paymentMeans: string; customerName: string | null; customerId: string | null; balance: number | null }
interface Party { name?: string; legalName?: string; vatNumber: string | null; crNumber?: string | null; otherIdScheme?: string | null; otherId?: string | null; street: string | null; buildingNo: string | null; additionalNo: string | null; district: string | null; city: string | null; postalCode: string | null; countryCode: string | null; phone?: string | null; email?: string | null }
interface DocLine { lineNo: number; description: string; quantity: number; unitPrice: number; discount: number; net: number; vatCategory: VatCategory; vatRate: number; exemptionCode: string | null; exemptionReason: string | null; vat: number; total: number }
interface RelatedNote { id: string; kind: Kind; number: string; issueDate: string; total: number; reason: string | null }
interface DocDetail {
  id: string; kind: DocKind; kindLabel: string; invoiceType: InvoiceType; number: string; uuid: string; issueDate: string; issuedAt: string; supplyDate: string | null; dueDate: string | null;
  reason: string | null; paymentMeans: string; subtotal: number; discount: number; taxable: number; vat: number; total: number;
  seller: Party; buyer: Party | null; qr: string | null; customerId: string | null; originalId: string | null; originalNumber: string | null; originalDate: string | null;
  lines: DocLine[]; receipts: { id: string; number: number; receivedOn: string; amount: number; method: string }[]; balance: number | null;
  /** Earlier prepayments this invoice deducted (VAT included), and the export flag. */
  prepaidAmount: number; isExport: boolean; salesOrderId: string | null;
  prepayments: { id: string; number: string; issueDate: string; taxable: number; vat: number }[];
  notes: string | null;
  /** Credit and debit notes issued on this invoice. */
  related: RelatedNote[];
  /** Phase 2: the stamped document's state with ZATCA (null when no device was active at issue). */
  zatca: { documentId: string; icv: number; environment: "sandbox" | "simulation" | "production"; outcome: "accepted" | "accepted_with_warnings" | "rejected" | "error" | null; mode: string | null; submittedAt: string | null; clearedQr: string | null; errors: string[]; warnings: string[] } | null;
}

const num = (s: string) => Number(s.replace(/,/g, ""));
const KIND_TITLE: Record<Kind, string> = { invoice: "فاتورة", credit_note: "إشعار دائن", debit_note: "إشعار مدين" };

function useDoc(tenantId: string, id: string | null) {
  return useQuery({ enabled: Boolean(id), queryKey: ["t", tenantId, "accounting", "docs", id], queryFn: () => api<DocDetail>("GET", `/t/sales-documents/${id}`, { tenant: tenantId }) });
}

/** Paid / remaining / owed back, from the server's balance (null on notes). */
function BalanceCell({ d }: { d: Pick<DocRow, "balance" | "dueDate"> }) {
  if (d.balance === null) return <>—</>;
  if (d.balance === 0) return <Badge tone="success">مسددة</Badge>;
  if (d.balance < 0) return <span className="pf-num-cell"><Badge tone="info">للعميل</Badge>{money(-d.balance)}</span>;
  const late = d.dueDate !== null && d.dueDate < isoDay();
  return <span className="pf-num-cell">{late ? <Badge tone="danger">متأخرة</Badge> : <Badge tone="warning">متبقٍ</Badge>}<strong>{money(d.balance)}</strong></span>;
}

// ── Invoices list ───────────────────────────────────────────────────────────────────────────────
export function InvoicesPage() {
  const { tenantId, can, writable } = useTenant();
  const navigate = useNavigate();
  const [kind, setKind] = useState("");
  const [unpaid, setUnpaid] = useState(false);
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(1);
  useEffect(() => { const t = setTimeout(() => { setDebounced(q.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);
  const list = useQuery({ queryKey: ["t", tenantId, "accounting", "docs", { kind, unpaid, q: debounced, page }], placeholderData: keepPreviousData,
    queryFn: () => api<Page<DocRow>>("GET", "/t/sales-documents", { tenant: tenantId, query: { kind, status: unpaid ? "unpaid" : undefined, q: debounced, page, pageSize: 25 } }) });
  const add = can("acc_invoices.create") && writable && <Link to={`/w/${tenantId}/accounting/invoices/new`} className="btn btn-primary"><Plus aria-hidden="true" />فاتورة جديدة</Link>;
  return (
    <div className="page">
      <PageHeader eyebrow="الحسابات" title="الفواتير الضريبية" description="فواتير البيع (لمنشأة أو مبسطة) وإشعاراتها، ومنها فواتير المستخلصات. الفاتورة لا تُعدَّل ولا تُحذف بعد الإصدار؛ التصحيح بإشعار دائن أو مدين." actions={add} />
      <section className="panel">
        <DataTable caption="الفواتير الضريبية" query={list} rowKey={(r) => r.id} onPageChange={setPage}
          filtered={Boolean(kind || unpaid || debounced)} onClearFilters={() => { setKind(""); setUnpaid(false); setQ(""); setPage(1); }}
          toolbar={<>
            <StatusTabs value={kind} onChange={(v) => { setKind(v); setPage(1); }} options={[["", "الكل"], ["invoice", "فواتير"], ["credit_note", "إشعارات دائنة"], ["debit_note", "إشعارات مدينة"]]} />
            <Checkbox label="غير المسددة فقط" checked={unpaid} onChange={(e) => { setUnpaid(e.target.checked); setPage(1); }} />
            <SearchInput placeholder="ابحث برقم الفاتورة أو اسم العميل" value={q} onChange={setQ} />
          </>}
          onRowClick={(r) => navigate({ to: `/w/${tenantId}/accounting/invoices/${r.id}` })}
          empty={{ title: "لا توجد فواتير بعد", body: "أصدر فاتورة ضريبية لعميل منشأة، أو فاتورة مبسطة لفرد.", action: add || undefined }}
          columns={[
            { key: "n", header: "الرقم", cell: (r) => <Link to={`/w/${tenantId}/accounting/invoices/${r.id}`} className="num">{r.number}</Link> },
            { key: "d", header: "التاريخ", cell: (r) => day(r.issueDate) },
            { key: "k", header: "النوع", cell: (r) => <span className="acc-desc"><StatusBadge kind="docKind" value={r.kind} /><span className="muted">{INVOICE_TYPE_LABELS[r.invoiceType]}</span></span> },
            { key: "c", header: "العميل", cell: (r) => (r.customerName ? <strong>{r.customerName}</strong> : <span className="muted">عميل نقدي</span>) },
            { key: "pm", header: "الدفع", cell: (r) => PAYMENT_MEANS_LABELS[r.paymentMeans] ?? r.paymentMeans },
            { key: "vat", header: "الضريبة", numeric: true, cell: (r) => money(r.vat) },
            { key: "t", header: "الإجمالي", numeric: true, cell: (r) => money(r.total) },
            { key: "b", header: "الرصيد", numeric: true, cell: (r) => <BalanceCell d={r} /> },
          ]} />
      </section>
    </div>
  );
}

// ── New invoice / credit note / debit note ──────────────────────────────────────────────────────
interface LineInput { key: string; description: string; quantity: string; unitPrice: string; discount: string; vatCategory: VatCategory; exemptionCode: string; exemptionReason: string }
const emptyLine = (): LineInput => ({ key: crypto.randomUUID(), description: "", quantity: "1", unitPrice: "", discount: "0", vatCategory: "S", exemptionCode: "", exemptionReason: "" });

export function NewInvoicePage() {
  const { tenantId } = useTenant();
  const navigate = useNavigate();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [params] = useState(() => new URLSearchParams(window.location.search));
  const kind: Kind = params.get("kind") === "credit_note" ? "credit_note" : params.get("kind") === "debit_note" ? "debit_note" : "invoice";
  const originalId = kind === "invoice" ? null : params.get("originalId");
  const original = useDoc(tenantId, originalId);
  const reasons = useQuery({ queryKey: ["t", tenantId, "accounting", "exemption-reasons"], staleTime: Infinity,
    queryFn: () => api<{ items: { code: string; category: "Z" | "E" | "O"; label: string }[] }>("GET", "/t/sales/exemption-reasons", { tenant: tenantId }) });
  const branches = useQuery({ queryKey: ["t", tenantId, "branches", "options"], queryFn: () => api<Page<Branch>>("GET", "/t/branches", { tenant: tenantId, query: { isActive: "true", pageSize: 100 } }) });
  const [key, renewKey] = useIdempotencyKey();
  const form = useRef<HTMLFormElement>(null);
  const [invoiceType, setInvoiceType] = useState<InvoiceType>("standard");
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [paymentMeans, setPaymentMeans] = useState("credit");
  const [branchId, setBranchId] = useState("");
  const [supplyDate, setSupplyDate] = useState("");
  const [notes, setNotes] = useState("");
  const [reason, setReason] = useState("");
  const [lines, setLines] = useState<LineInput[]>(() => [emptyLine()]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [buyerIssue, setBuyerIssue] = useState<string | null>(null);
  const [fixing, setFixing] = useState<Customer | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const locked = kind !== "invoice";
  const title = kind === "invoice" ? "فاتورة جديدة" : KIND_TITLE[kind];

  // A note follows its invoice: same type and customer; a credit note starts as a full reversal of its lines.
  const prefilled = useRef(false);
  useEffect(() => {
    const o = original.data;
    if (!o || prefilled.current) return;
    prefilled.current = true;
    setInvoiceType(o.invoiceType);
    setPaymentMeans(o.paymentMeans);
    // Only id, name and phone are needed to show the buyer and to reload the full customer if the buyer needs fixing.
    if (o.customerId) setCustomer({ id: o.customerId, name: o.buyer?.name ?? "", phone: o.buyer?.phone ?? "" } as Customer);
    if (kind === "credit_note") setLines(o.lines.map((l) => ({ key: crypto.randomUUID(), description: l.description, quantity: String(l.quantity), unitPrice: String(l.unitPrice), discount: String(l.discount), vatCategory: l.vatCategory, exemptionCode: l.exemptionCode ?? "", exemptionReason: l.vatCategory === "O" ? l.exemptionReason ?? "" : "" })));
  }, [original.data, kind]);

  const setLine = (i: number, patch: Partial<LineInput>) => setLines((ls) => ls.map((l, n) => (n === i ? { ...l, ...patch } : l)));
  const reasonOptions = (cat: VatCategory) => (reasons.data?.items ?? []).filter((r) => r.category === cat).map((r) => ({ value: r.code, label: `${r.label} (${r.code})` }));
  const notBusiness = invoiceType === "standard" && customer && !locked && customer.customerType !== "business";

  function review() {
    const e: Record<string, string> = {};
    if (locked && !originalId) e.form = "افتح الإشعار من صفحة الفاتورة الأصلية";
    if (invoiceType === "standard" && !customer) e.customer = "الفاتورة الضريبية (بين المنشآت) تحتاج عميلاً";
    if (paymentMeans === "credit" && !customer) e.customer = "البيع الآجل يحتاج عميلاً يُسجَّل عليه المبلغ";
    if (locked && reason.trim().length < 3) e.reason = kind === "credit_note" ? "اكتب سبب الإشعار، مثل: إرجاع بضاعة أو خصم لاحق" : "اكتب سبب الإشعار، مثل: فرق سعر";
    lines.forEach((l, i) => {
      if (!l.description.trim()) e[`lines.${i}.description`] = "اكتب وصف البند";
      if (!(num(l.quantity) > 0)) e[`lines.${i}.quantity`] = "الكمية أكبر من صفر";
      if (l.unitPrice.trim() === "" || !(num(l.unitPrice) >= 0)) e[`lines.${i}.unitPrice`] = "أدخل سعر الوحدة قبل الضريبة";
      if (!(num(l.discount || "0") >= 0)) e[`lines.${i}.discount`] = "صفر أو أكبر";
      if (l.vatCategory !== "S" && !l.exemptionCode) e[`lines.${i}.exemptionCode`] = "اختر سبب الإعفاء أو النسبة الصفرية";
      if (l.vatCategory === "O" && l.exemptionReason.trim().length < 3) e[`lines.${i}.exemptionReason`] = "اكتب لماذا البند خارج نطاق الضريبة";
    });
    setErrors(e);
    if (e.form) return setError(e.form);
    if (Object.keys(e).length) return focusFirstInvalid(form.current);
    setError(null); setBuyerIssue(null); setConfirming(true);
  }

  async function issue() {
    setBusy(true);
    try {
      const r = await api<{ id: string; number: string }>("POST", "/t/sales-documents", { tenant: tenantId, idempotencyKey: key, body: {
        kind, invoiceType, customerId: customer?.id ?? null, branchId: branchId || null, originalId, reason: locked ? reason.trim() : null,
        supplyDate: supplyDate || null, paymentMeans, notes: notes.trim() || null,
        lines: lines.map((l) => ({ description: l.description.trim(), quantity: num(l.quantity), unitPrice: num(l.unitPrice), discount: num(l.discount || "0"), vatCategory: l.vatCategory,
          exemptionCode: l.vatCategory === "S" ? null : l.exemptionCode, exemptionReason: l.vatCategory === "O" ? l.exemptionReason.trim() : null })),
      } });
      renewKey();
      toast.success(`صدر ${KIND_TITLE[kind]} ${r.number}`);
      await invalidate("accounting");
      navigate({ to: `/w/${tenantId}/accounting/invoices/${r.id}` });
    } catch (err) {
      setConfirming(false);
      if (err instanceof ApiError && err.code === "buyer_incomplete") { setBuyerIssue(err.message); setError(null); }
      else { if (err instanceof ApiError) setErrors(err.fieldErrors); setError(err); }
    } finally { setBusy(false); }
  }

  /** Opens the customer's dialog with fresh data (the picked row may be partial or stale). */
  async function openCustomer() {
    if (!customer) return;
    try {
      const r = await api<Page<Customer>>("GET", "/t/customers", { tenant: tenantId, query: { q: customer.phone || customer.name, pageSize: 10 } });
      setFixing(r.items.find((c) => c.id === customer.id) ?? customer);
    } catch { setFixing(customer); }
  }

  if (originalId && original.isError) return <div className="page"><ErrorState error={original.error} onRetry={() => original.refetch()} title="تعذر تحميل الفاتورة الأصلية" /></div>;
  const o = original.data;
  const taxMissing = error instanceof ApiError && error.code === "tax_profile_missing";
  return (
    <form ref={form} className="page" noValidate onSubmit={(e) => { e.preventDefault(); review(); }}>
      <PageHeader eyebrow="الفواتير الضريبية" title={title}
        description={locked ? "الإشعار يصحّح فاتورة صادرة دون تعديلها، ويتبع نوعها وعميلها." : "الأسعار قبل الضريبة. الضريبة والإجماليات يحسبها الخادم عند الإصدار وتظهر في الفاتورة."}
        actions={<Link to={o ? `/w/${tenantId}/accounting/invoices/${o.id}` : `/w/${tenantId}/accounting/invoices`} className="btn btn-ghost"><ArrowRight aria-hidden="true" />{o ? `الفاتورة ${o.number}` : "الفواتير"}</Link>} />

      {locked && (
        <section className="panel panel-pad form-section" aria-labelledby="orig-h">
          <h2 id="orig-h">الفاتورة الأصلية</h2>
          {!o ? <Skeleton height={60} /> : (
            <dl className="dl">
              <dt>الفاتورة</dt><dd><span className="num">{o.number}</span> · {day(o.issueDate)} · {INVOICE_TYPE_LABELS[o.invoiceType]}</dd>
              <dt>العميل</dt><dd>{o.buyer?.name ?? "عميل نقدي"}</dd>
              <dt>إجمالي الفاتورة</dt><dd className="num">{money(o.total)}</dd>
            </dl>
          )}
          <TextAreaField label="سبب الإشعار" required rows={2} value={reason} onChange={(e) => setReason(e.target.value)} error={errors.reason}
            hint={kind === "credit_note" ? "يظهر في الإشعار. عدّل البنود لتطابق المُرجَع أو الخصم؛ لا يتجاوز الإشعار المتبقي من الفاتورة." : "يظهر في الإشعار. أدخل البنود الإضافية فقط."} />
        </section>
      )}

      <section className="panel panel-pad form-section" aria-labelledby="inv-buyer-h">
        <h2 id="inv-buyer-h">{locked ? "الدفع والتوريد" : "نوع الفاتورة والعميل"}</h2>
        {!locked && (
          <fieldset className="acc-choices">
            <legend className="field-label">نوع الفاتورة</legend>
            <label className={`acc-choice${invoiceType === "standard" ? " is-selected" : ""}`}>
              <input type="radio" name="invoiceType" value="standard" checked={invoiceType === "standard"} onChange={() => setInvoiceType("standard")} />
              <span><strong>فاتورة ضريبية</strong><span className="muted">لمنشأة: تحتاج رقمها الضريبي أو سجلها التجاري، وعنوانها الوطني.</span></span>
            </label>
            <label className={`acc-choice${invoiceType === "simplified" ? " is-selected" : ""}`}>
              <input type="radio" name="invoiceType" value="simplified" checked={invoiceType === "simplified"} onChange={() => setInvoiceType("simplified")} />
              <span><strong>فاتورة ضريبية مبسطة</strong><span className="muted">لفرد أو عميل نقدي. العميل اختياري إلا في البيع الآجل.</span></span>
            </label>
          </fieldset>
        )}
        {customer ? (
          <div className="acc-picked">
            <span className="acc-desc"><span className="muted">العميل:</span><strong>{customer.name}</strong>{customer.phone && <span className="muted num" dir="ltr">{customer.phone}</span>}{customer.customerType === "business" && <Badge tone="info">منشأة</Badge>}</span>
            {!locked && <Button size="sm" variant="ghost" onClick={() => setCustomer(null)}>تغيير العميل</Button>}
            {invoiceType === "standard" && <Button size="sm" variant="ghost" onClick={() => void openCustomer()}>البيانات الضريبية للعميل</Button>}
          </div>
        ) : !locked && (
          <CustomerPicker tenantId={tenantId} label="العميل" required={invoiceType === "standard" || paymentMeans === "credit"} error={errors.customer}
            hint={invoiceType === "standard" ? "عميل منشأة مسجل ببياناته الضريبية." : "اتركه فارغاً لعميل نقدي."} onPick={setCustomer} />
        )}
        {notBusiness && <p className="banner banner-warning ca-banner">هذا العميل مسجل كفرد. الفاتورة الضريبية تحتاج بياناته كمنشأة (الرقم الضريبي والعنوان الوطني).&nbsp;<button type="button" className="link-button" onClick={() => void openCustomer()}>إكمال بياناته</button></p>}
        <div className="form-grid">
          <SelectField label="طريقة الدفع" required value={paymentMeans} onChange={(e) => setPaymentMeans(e.target.value)} error={errors.paymentMeans}
            options={Object.entries(PAYMENT_MEANS_LABELS).map(([value, label]) => ({ value, label }))}
            hint={paymentMeans === "credit" ? (customer?.paymentTermsDays ? `تستحق بعد ${integer(customer.paymentTermsDays)} يوماً (مدة سداد العميل).` : "تُسجَّل على العميل حتى يُسجَّل سند قبض.") : "تُسجَّل مدفوعة عند الإصدار."} />
          <TextField label="تاريخ التوريد" optional type="date" value={supplyDate} onChange={(e) => setSupplyDate(e.target.value)} hint="إن اختلف عن تاريخ الإصدار." />
          <SelectField label="الفرع" optional placeholder="بدون فرع" value={branchId} onChange={(e) => setBranchId(e.target.value)} options={(branches.data?.items ?? []).map((b) => ({ value: b.id, label: b.name }))} />
        </div>
        <TextAreaField label="ملاحظات على الفاتورة" optional rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} hint="تظهر في الفاتورة المطبوعة، مثل شروط الدفع أو رقم أمر الشراء." />
      </section>

      <section className="panel panel-pad form-section" aria-labelledby="inv-lines-h">
        <h2 id="inv-lines-h">البنود</h2>
        {reasons.isError && <FormError error="تعذر تحميل أسباب الإعفاء. أعد تحميل الصفحة قبل إدخال بند غير خاضع للنسبة الأساسية." />}
        <ol className="acc-lines">
          {lines.map((l, i) => (
            <li key={l.key} className="acc-line">
              <div className="acc-line-grid acc-inv-grid">
                <TextField label={`وصف البند ${i + 1}`} required value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} error={errors[`lines.${i}.description`]} />
                <TextField label="الكمية" required numeric value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} error={errors[`lines.${i}.quantity`]} />
                <TextField label={`سعر الوحدة قبل الضريبة (${RIYAL})`} required numeric value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} error={errors[`lines.${i}.unitPrice`]} />
                <TextField label={`الخصم (${RIYAL})`} optional numeric value={l.discount} onChange={(e) => setLine(i, { discount: e.target.value })} error={errors[`lines.${i}.discount`]} />
                <SelectField label="الضريبة" required value={l.vatCategory} onChange={(e) => setLine(i, { vatCategory: e.target.value as VatCategory, exemptionCode: "", exemptionReason: "" })}
                  options={Object.entries(VAT_CATEGORY_LABELS).map(([value, label]) => ({ value, label }))} />
                <IconButton label={`حذف البند ${i + 1}`} icon={<X />} destructive className="acc-line-remove" disabled={lines.length <= 1} onClick={() => setLines((ls) => ls.filter((_, n) => n !== i))} />
              </div>
              {l.vatCategory !== "S" && (
                <div className="form-grid">
                  <SelectField label={l.vatCategory === "O" ? "رمز السبب" : "سبب الإعفاء أو النسبة الصفرية"} required placeholder="اختر السبب" value={l.exemptionCode} error={errors[`lines.${i}.exemptionCode`]}
                    onChange={(e) => setLine(i, { exemptionCode: e.target.value })} options={reasonOptions(l.vatCategory)} />
                  {l.vatCategory === "O" && <TextField label="لماذا البند خارج نطاق الضريبة" required value={l.exemptionReason} onChange={(e) => setLine(i, { exemptionReason: e.target.value })} error={errors[`lines.${i}.exemptionReason`]} />}
                </div>
              )}
            </li>
          ))}
        </ol>
        <div className="row"><Button variant="ghost" icon={<Plus />} onClick={() => setLines((ls) => [...ls, emptyLine()])}>إضافة بند</Button></div>
      </section>

      {buyerIssue && (
        <div className="banner banner-warning ca-banner acc-banner-action" role="alert">
          <span className="spacer">{buyerIssue}</span>
          {customer && <Button size="sm" onClick={() => void openCustomer()}>إكمال بيانات العميل</Button>}
        </div>
      )}
      {taxMissing ? (
        <div className="banner banner-warning ca-banner acc-banner-action" role="alert">
          <span className="spacer">{(error as ApiError).message}</span>
          <Link to={`/w/${tenantId}/accounting/settings`} className="btn btn-secondary btn-sm">إعدادات المحاسبة</Link>
        </div>
      ) : <FormError error={error} />}

      <div className="pf-form-foot">
        <Button type="submit" variant="primary">{kind === "invoice" ? "مراجعة وإصدار الفاتورة" : `مراجعة وإصدار ${KIND_TITLE[kind]}`}</Button>
        <Link to={o ? `/w/${tenantId}/accounting/invoices/${o.id}` : `/w/${tenantId}/accounting/invoices`} className="btn btn-ghost">إلغاء</Link>
        <span className="spacer" /><span>عدد البنود: <strong className="num">{integer(lines.length)}</strong></span>
      </div>

      <ConfirmDialog open={confirming} onClose={() => setConfirming(false)} busy={busy} destructive={false} onConfirm={() => void issue()}
        title={`إصدار ${kind === "invoice" ? (invoiceType === "standard" ? "فاتورة ضريبية" : "فاتورة ضريبية مبسطة") : KIND_TITLE[kind]}`}
        confirmLabel={kind === "invoice" ? "إصدار الفاتورة" : `إصدار ${KIND_TITLE[kind]}`}
        message={<>{customer ? <>للعميل <strong>{customer.name}</strong>، </> : "لعميل نقدي، "}{integer(lines.length)} بند، والدفع {PAYMENT_MEANS_LABELS[paymentMeans]}. الفاتورة لا تُعدَّل بعد الإصدار؛ التصحيح بإشعار دائن/مدين. الضريبة والإجماليات يحسبها الخادم وتظهر بعد الإصدار.</>} />

      {fixing && <CustomerForm tenantId={tenantId} customer={fixing} business notice={buyerIssue ?? "الفاتورة الضريبية تحتاج الرقم الضريبي (أو رقم تعريف آخر) والعنوان الوطني للعميل."} onClose={() => setFixing(null)}
        onSaved={async (name) => {
          toast.success(`تم حفظ بيانات ${name}. أعد مراجعة الفاتورة وإصدارها.`);
          setBuyerIssue(null);
          await invalidate("customers");
          try {
            const r = await api<Page<Customer>>("GET", "/t/customers", { tenant: tenantId, query: { q: fixing.phone || name, pageSize: 10 } });
            const fresh = r.items.find((c) => c.id === fixing.id);
            if (fresh) setCustomer(fresh);
          } catch { /* the saved data is on the server; only this page's copy is stale */ }
        }} />}
    </form>
  );
}

// ── Invoice detail (printable tax invoice) ──────────────────────────────────────────────────────
const TITLES: Record<DocKind, Record<InvoiceType, [string, string]>> = {
  prepayment: { standard: ["فاتورة دفعة مقدمة", "Prepayment Invoice"], simplified: ["فاتورة دفعة مقدمة مبسطة", "Simplified Prepayment Invoice"] },
  invoice: { standard: ["فاتورة ضريبية", "Tax Invoice"], simplified: ["فاتورة ضريبية مبسطة", "Simplified Tax Invoice"] },
  credit_note: { standard: ["إشعار دائن", "Credit Note"], simplified: ["إشعار دائن", "Credit Note"] },
  debit_note: { standard: ["إشعار مدين", "Debit Note"], simplified: ["إشعار مدين", "Debit Note"] },
};

function useQrImage(qr: string | null | undefined) {
  const [img, setImg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!qr) return;
    // The QR carries the base64 TLV string itself (seller, VAT number, time, total, VAT), as ZATCA phase 1 requires.
    QRCode.toDataURL(qr, { margin: 1, width: 320, errorCorrectionLevel: "M" }).then(setImg).catch(() => setFailed(true));
  }, [qr]);
  return { img, failed };
}

/** Bilingual label: Arabic first, English secondary. */
const Bi = ({ ar, en }: { ar: string; en: string }) => <>{ar} <span className="inv-en">{en}</span></>;

function address(p: Party) {
  const first = [p.buildingNo, p.street].filter(Boolean).join(" ");
  return [first, p.district, [p.city, p.postalCode].filter(Boolean).join(" "), p.countryCode].filter(Boolean).join("، ");
}

function PartyBlock({ ar, en, party }: { ar: string; en: string; party: Party | null }) {
  return (
    <section className="inv-party" aria-label={ar}>
      <h3><Bi ar={ar} en={en} /></h3>
      {!party ? <p className="muted">عميل نقدي <span className="inv-en">Cash customer</span></p> : (
        <dl className="inv-dl">
          <dt><Bi ar="الاسم" en="Name" /></dt><dd><strong>{party.legalName ?? party.name}</strong></dd>
          {party.vatNumber && <><dt><Bi ar="الرقم الضريبي" en="VAT No." /></dt><dd className="num">{party.vatNumber}</dd></>}
          {party.crNumber && <><dt><Bi ar="السجل التجاري" en="CR No." /></dt><dd className="num">{party.crNumber}</dd></>}
          {party.otherId && <><dt>{ID_SCHEME_LABELS[party.otherIdScheme ?? ""] ?? "رقم التعريف"} <span className="inv-en">{party.otherIdScheme}</span></dt><dd className="num">{party.otherId}</dd></>}
          {address(party) && <><dt><Bi ar="العنوان الوطني" en="Address" /></dt><dd>{address(party)}</dd></>}
          {party.additionalNo && <><dt><Bi ar="الرقم الإضافي" en="Additional No." /></dt><dd className="num">{party.additionalNo}</dd></>}
        </dl>
      )}
    </section>
  );
}

export function InvoiceDetailPage() {
  const { tenantId, can, writable } = useTenant();
  const { docId } = useParams({ strict: false }) as { docId: string };
  const navigate = useNavigate();
  const doc = useDoc(tenantId, docId);
  const qr = useQrImage(doc.data?.zatca?.clearedQr ?? doc.data?.qr);
  const [receipt, setReceipt] = useState(false);
  if (doc.isPending) return <div className="page"><TableSkeleton columns={6} rows={4} label="جارٍ تحميل الفاتورة…" /></div>;
  if (doc.isError) return <div className="page"><ErrorState error={doc.error} onRetry={() => doc.refetch()} /></div>;
  const d = doc.data;
  const [ar, en] = TITLES[d.kind][d.invoiceType];
  const related = d.related;
  const freeNotes = d.notes;
  const canWrite = can("acc_invoices.create") && writable;
  const canCollect = canWrite && d.kind === "invoice" && d.paymentMeans === "credit" && d.customerId !== null && (d.balance ?? 0) > 0;
  const rates = [...new Set(d.lines.filter((l) => l.vatCategory === "S").map((l) => l.vatRate))];
  const noteLink = (k: Kind) => `/w/${tenantId}/accounting/invoices/new?kind=${k}&originalId=${d.id}`;
  return (
    <div className="page">
      <PageHeader eyebrow="الفواتير الضريبية" title={<span className="pf-title">{d.kindLabel} <span className="num">{d.number}</span></span>} description={`${INVOICE_TYPE_LABELS[d.invoiceType]} · صدرت ${dayTime(d.issuedAt)}`}
        actions={<>
          <Link to={`/w/${tenantId}/accounting/invoices`} className="btn btn-ghost"><ArrowRight aria-hidden="true" />الفواتير</Link>
          <Button icon={<Printer />} onClick={() => window.print()}>طباعة</Button>
          {canWrite && d.kind === "invoice" && <>
            <Button variant="ghost" icon={<FileMinus />} onClick={() => navigate({ to: noteLink("credit_note") })}>إشعار دائن</Button>
            <Button variant="ghost" icon={<FilePlus />} onClick={() => navigate({ to: noteLink("debit_note") })}>إشعار مدين</Button>
          </>}
          {canCollect && <Button variant="primary" icon={<HandCoins />} onClick={() => setReceipt(true)}>تسجيل قبض</Button>}
        </>} />
      <div className="inv-layout">
        <article className="panel acc-print inv-doc" aria-label={`${ar} ${d.number}`}>
          <header className="inv-head">
            <div className="inv-head-main">
              <h2 className="inv-title">{ar} <span className="inv-en">{en}</span></h2>
              <dl className="inv-dl inv-meta">
                <dt><Bi ar="رقم الفاتورة" en="Invoice No." /></dt><dd className="num">{d.number}</dd>
                <dt><Bi ar="تاريخ الإصدار" en="Issue date" /></dt><dd>{dayTime(d.issuedAt)} <span className="muted">({hijri(d.issueDate)})</span></dd>
                {d.supplyDate && <><dt><Bi ar="تاريخ التوريد" en="Supply date" /></dt><dd>{day(d.supplyDate)}</dd></>}
                {d.dueDate && <><dt><Bi ar="تاريخ الاستحقاق" en="Due date" /></dt><dd>{day(d.dueDate)}</dd></>}
                <dt><Bi ar="طريقة الدفع" en="Payment" /></dt><dd>{PAYMENT_MEANS_LABELS[d.paymentMeans] ?? d.paymentMeans}</dd>
                {d.originalNumber && <><dt><Bi ar="الفاتورة الأصلية" en="Original invoice" /></dt><dd><Link to={`/w/${tenantId}/accounting/invoices/${d.originalId}`} className="num">{d.originalNumber}</Link> · {day(d.originalDate)}</dd></>}
                {d.reason && <><dt><Bi ar="سبب الإشعار" en="Reason" /></dt><dd>{d.reason}</dd></>}
                {d.isExport && <><dt><Bi ar="نوع التوريد" en="Supply" /></dt><dd><Bi ar="تصدير" en="Export" /></dd></>}
              </dl>
            </div>
            <div className="inv-qr">
              {qr.img ? <img src={qr.img} alt={`رمز QR لـ${ar} رقم ${d.number}`} /> : d.qr && !qr.failed ? <Skeleton width="128px" height={128} /> : <span className="muted acc-small">تعذر إنشاء رمز QR</span>}
            </div>
          </header>
          <div className="inv-parties">
            <PartyBlock ar="البائع" en="Seller" party={d.seller} />
            <PartyBlock ar="المشتري" en="Buyer" party={d.buyer} />
          </div>
          <div className="table-wrap">
            <table className="data-table inv-lines">
              <caption className="sr-only">بنود {ar} {d.number}</caption>
              <thead><tr>
                <th scope="col">#</th><th scope="col"><Bi ar="الوصف" en="Description" /></th>
                <th scope="col" className="end"><Bi ar="الكمية" en="Qty" /></th><th scope="col" className="end"><Bi ar="سعر الوحدة" en="Unit price" /></th>
                <th scope="col" className="end"><Bi ar="الخصم" en="Discount" /></th><th scope="col" className="end"><Bi ar="المبلغ الخاضع للضريبة" en="Taxable amount" /></th>
                <th scope="col" className="end"><Bi ar="نسبة الضريبة" en="VAT rate" /></th><th scope="col" className="end"><Bi ar="مبلغ الضريبة" en="VAT amount" /></th>
                <th scope="col" className="end"><Bi ar="الإجمالي شامل الضريبة" en="Total incl. VAT" /></th>
              </tr></thead>
              <tbody>{d.lines.map((l) => (
                <tr key={l.lineNo}>
                  <td className="num">{l.lineNo}</td>
                  <td className="wrap"><strong>{l.description}</strong>{l.vatCategory !== "S" && <div className="muted acc-small">{VAT_CATEGORY_LABELS[l.vatCategory]}{l.exemptionReason && `: ${l.exemptionReason}`}{l.exemptionCode && <span className="num" dir="ltr"> ({l.exemptionCode})</span>}</div>}</td>
                  <td className="end num">{quantity(l.quantity)}</td>
                  <td className="end num">{money(l.unitPrice)}</td>
                  <td className="end num">{l.discount ? money(l.discount) : "—"}</td>
                  <td className="end num">{money(l.net)}</td>
                  <td className="end num">{percent(l.vatRate)}</td>
                  <td className="end num">{money(l.vat)}</td>
                  <td className="end num">{money(l.total)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <div className="inv-foot">
            <div className="inv-foot-notes">{freeNotes && <p><strong>ملاحظات <span className="inv-en">Notes</span>:</strong> {freeNotes}</p>}</div>
            <table className="inv-totals">
              <caption className="sr-only">إجماليات {ar}</caption>
              <tbody>
                <tr><th scope="row"><Bi ar="الإجمالي غير شامل ضريبة القيمة المضافة" en="Total (excl. VAT)" /></th><td className="num">{money(d.subtotal)}</td></tr>
                <tr><th scope="row"><Bi ar="مجموع الخصومات" en="Discount" /></th><td className="num">{money(d.discount)}</td></tr>
                <tr><th scope="row"><Bi ar="الإجمالي الخاضع للضريبة" en="Taxable amount" /></th><td className="num">{money(d.taxable)}</td></tr>
                <tr><th scope="row"><Bi ar={`مجموع ضريبة القيمة المضافة${rates.length === 1 ? ` ${percent(rates[0])}` : ""}`} en="Total VAT" /></th><td className="num">{money(d.vat)}</td></tr>
                <tr className={d.prepaidAmount ? undefined : "is-total"}><th scope="row"><Bi ar="الإجمالي شامل الضريبة" en="Total incl. VAT" /></th><td className="num">{money(d.total)}</td></tr>
                {d.prepayments.map((p) => (
                  <tr key={p.id}><th scope="row"><Bi ar={`دفعة مقدمة ${p.number} (${day(p.issueDate)})`} en="Prepayment" /></th>
                    <td className="num">−{money(p.taxable + p.vat)} <span className="muted acc-small">(ضريبة {money(p.vat)})</span></td></tr>
                ))}
                {d.prepaidAmount > 0 && <tr className="is-total"><th scope="row"><Bi ar="المبلغ المستحق" en="Amount due" /></th><td className="num">{money(d.total - d.prepaidAmount)}</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="muted acc-small inv-uuid">UUID <span className="num" dir="ltr">{d.uuid}</span></p>
        </article>

        <aside className="stack-lg no-print">
          <ZatcaPanel tenantId={tenantId} d={d} onChange={() => doc.refetch()} />
          <section className="panel" aria-labelledby="inv-pay-h">
            <div className="card-head"><h2 id="inv-pay-h">السداد</h2></div>
            <div className="card-body stack">
              <dl className="dl">
                <dt>الإجمالي</dt><dd className="num">{money(d.total)}</dd>
                {d.kind === "invoice" && <><dt>الرصيد</dt><dd><BalanceCell d={d} /></dd></>}
              </dl>
              {d.kind === "invoice" && d.paymentMeans !== "credit" && <p className="muted acc-small">مدفوعة عند الإصدار ({PAYMENT_MEANS_LABELS[d.paymentMeans]}). الرصيد السالب مبلغ مستحق للعميل بعد إشعار دائن.</p>}
              {d.kind !== "invoice" && <p className="muted acc-small">الإشعار يعدّل رصيد الفاتورة الأصلية.</p>}
            </div>
          </section>
          {d.kind === "invoice" && d.paymentMeans === "credit" && d.customerId && can("acc_receipts.view") && (
            <PaymentLinksPanel tenantId={tenantId} documentId={d.id} balance={d.balance ?? 0} onPaid={() => void doc.refetch()} />
          )}
          {d.kind === "invoice" && <>
            <section className="panel" aria-labelledby="inv-notes-h">
              <div className="card-head"><h2 id="inv-notes-h">الإشعارات</h2></div>
              <div className="card-body">
                {related.length === 0 ? <p className="muted acc-small">لا توجد إشعارات على هذه الفاتورة.</p> : (
                  <ul className="acc-mini-list">{related.map((n) => (
                    <li key={n.id}><Link to={`/w/${tenantId}/accounting/invoices/${n.id}`} className="num">{n.number}</Link><StatusBadge kind="docKind" value={n.kind} /><span className="spacer" /><span className="num">{money(n.total)}</span>
                      {n.reason && <span className="muted acc-small acc-mini-note">{n.reason}</span>}</li>
                  ))}</ul>
                )}
              </div>
            </section>
            <section className="panel" aria-labelledby="inv-rc-h">
              <div className="card-head"><h2 id="inv-rc-h">سندات القبض</h2></div>
              <div className="card-body">
                {d.receipts.length === 0 ? <p className="muted acc-small">{d.paymentMeans === "credit" ? "لم يُسجَّل تحصيل على هذه الفاتورة بعد." : "لا تحتاج سند قبض."}</p> : (
                  <ul className="acc-mini-list">{d.receipts.map((r) => (
                    <li key={r.id}><span className="num">RC-{r.number}</span><span className="muted">{day(r.receivedOn)} · {RECEIPT_METHOD_LABELS[r.method] ?? r.method}</span><span className="spacer" /><span className="num">{money(r.amount)}</span></li>
                  ))}</ul>
                )}
              </div>
            </section>
          </>}
        </aside>
      </div>
      {receipt && d.customerId && <ReceiptDialog tenantId={tenantId} onClose={() => setReceipt(false)}
        initial={{ customer: { id: d.customerId, name: d.buyer?.name ?? "" }, documentId: d.id, documentNumber: d.number, balance: d.balance ?? undefined }} />}
    </div>
  );
}

// ── Customer receipts ───────────────────────────────────────────────────────────────────────────
interface ReceiptRow { id: string; number: number; receivedOn: string; amount: number; method: string; reference: string | null; customerName: string; documentNumber: string | null }

export function ReceiptsPage() {
  const { tenantId, can, writable } = useTenant();
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(() => new URLSearchParams(window.location.search).get("new") === "1");
  const list = useQuery({ queryKey: ["t", tenantId, "accounting", "receipts", { page }], placeholderData: keepPreviousData,
    queryFn: () => api<Page<ReceiptRow>>("GET", "/t/customer-receipts", { tenant: tenantId, query: { page, pageSize: 25 } }) });
  const canWrite = can("acc_receipts.create") && writable;
  const add = canWrite && <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>تسجيل قبض</Button>;
  return (
    <div className="page">
      <PageHeader eyebrow="الحسابات" title="سندات القبض" description="المبالغ المحصّلة من العملاء على الفواتير الآجلة أو كدفعة على الحساب. السند لا يُعدَّل ولا يُحذف." actions={add} />
      <section className="panel">
        <DataTable caption="سندات القبض" query={list} rowKey={(r) => r.id} onPageChange={setPage}
          empty={{ title: "لا توجد سندات قبض بعد", body: "سجّل ما تحصّله من العملاء على فواتيرهم الآجلة ليُخصم من أرصدتهم.", action: add || undefined }}
          columns={[
            { key: "n", header: "رقم السند", cell: (r) => <span className="num">RC-{r.number}</span> },
            { key: "d", header: "التاريخ", cell: (r) => day(r.receivedOn) },
            { key: "c", header: "العميل", cell: (r) => <strong>{r.customerName}</strong> },
            { key: "doc", header: "الفاتورة", cell: (r) => (r.documentNumber ? <span className="num">{r.documentNumber}</span> : <span className="muted">دفعة على الحساب</span>) },
            { key: "m", header: "طريقة القبض", cell: (r) => RECEIPT_METHOD_LABELS[r.method] ?? r.method },
            { key: "ref", header: "المرجع", cell: (r) => <span dir="ltr">{text(r.reference)}</span> },
            { key: "a", header: "المبلغ", numeric: true, cell: (r) => money(r.amount) },
          ]} />
      </section>
      {creating && canWrite && <ReceiptDialog tenantId={tenantId} onClose={() => setCreating(false)} />}
    </div>
  );
}

/** Records money received from a customer, on one credit invoice or on account. Prefilled from an invoice page. */
export function ReceiptDialog({ tenantId, initial, onClose }: {
  tenantId: string; onClose: () => void;
  initial?: { customer: { id: string; name: string }; documentId?: string; documentNumber?: string; balance?: number };
}) {
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [key, renewKey] = useIdempotencyKey();
  const form = useRef<HTMLFormElement>(null);
  const fixedDoc = Boolean(initial?.documentId);
  const [customer, setCustomer] = useState(initial?.customer ?? null);
  const [v, setV] = useState({ documentId: initial?.documentId ?? "", amount: initial?.balance && initial.balance > 0 ? initial.balance.toFixed(2) : "", receivedOn: isoDay(), method: "bank_transfer", reference: "", notes: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const open = useQuery({ enabled: Boolean(customer) && !fixedDoc, queryKey: ["t", tenantId, "accounting", "docs", "unpaid", customer?.id],
    queryFn: () => api<Page<DocRow>>("GET", "/t/sales-documents", { tenant: tenantId, query: { customerId: customer!.id, kind: "invoice", status: "unpaid", pageSize: 100 } }) });
  // Only credit invoices take receipts; a cash or card invoice was paid when it was issued.
  const invoices = (open.data?.items ?? []).filter((x) => x.paymentMeans === "credit" && (x.balance ?? 0) > 0);
  const picked = invoices.find((x) => x.id === v.documentId);
  const balance = fixedDoc ? initial?.balance : picked?.balance ?? undefined;
  async function submit() {
    const e: Record<string, string> = {};
    if (!customer) e.customer = "اختر العميل";
    if (!(num(v.amount) > 0)) e.amount = "أدخل المبلغ المستلم";
    if (!v.receivedOn) e.receivedOn = "اختر تاريخ القبض";
    setErrors(e);
    if (Object.keys(e).length) return focusFirstInvalid(form.current);
    setBusy(true); setError(null);
    try {
      await api("POST", "/t/customer-receipts", { tenant: tenantId, idempotencyKey: key, body: {
        customerId: customer!.id, documentId: v.documentId || null, receivedOn: v.receivedOn, amount: num(v.amount), method: v.method,
        reference: v.reference.trim() || null, notes: v.notes.trim() || null } });
      renewKey();
      toast.success(`تم تسجيل قبض ${money(num(v.amount))} من ${customer!.name}`);
      await invalidate("accounting");
      onClose();
    } catch (err) { if (err instanceof ApiError) setErrors(err.fieldErrors); setError(err); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} formRef={form} title={initial?.documentNumber ? `تسجيل قبض على ${initial.documentNumber}` : "تسجيل قبض من عميل"} onSubmit={() => void submit()}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ التسجيل…">تسجيل سند القبض</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <p className="muted">السند لا يُعدَّل ولا يُحذف بعد تسجيله، ويُرحَّل قيده فوراً. تحقق من المبلغ قبل التسجيل.</p>
      {customer ? (
        <div className="acc-picked">
          <span className="acc-desc"><span className="muted">العميل:</span><strong>{customer.name}</strong></span>
          {!fixedDoc && <Button size="sm" variant="ghost" onClick={() => { setCustomer(null); setV({ ...v, documentId: "" }); }}>تغيير العميل</Button>}
        </div>
      ) : <CustomerPicker tenantId={tenantId} label="العميل" required error={errors.customer} onPick={(c) => setCustomer({ id: c.id, name: c.name })} />}
      {customer && !fixedDoc && (
        <SelectField label="على الفاتورة" optional placeholder={open.isPending ? "جارٍ تحميل الفواتير…" : "دفعة على الحساب (بدون فاتورة)"} value={v.documentId}
          onChange={(e) => { const doc = invoices.find((x) => x.id === e.target.value); setV({ ...v, documentId: e.target.value, amount: doc?.balance ? doc.balance.toFixed(2) : v.amount }); }}
          options={invoices.map((x) => ({ value: x.id, label: `${x.number} · ${day(x.issueDate)} · متبقٍ ${money(x.balance)}` }))}
          hint={open.isError ? "تعذر تحميل فواتير العميل؛ يمكنك تسجيلها دفعة على الحساب." : open.data && invoices.length === 0 ? "لا توجد فواتير آجلة غير مسددة لهذا العميل." : undefined} />
      )}
      <div className="form-grid">
        <TextField label={`المبلغ (${RIYAL})`} required numeric value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} error={errors.amount} hint={balance !== undefined ? `المتبقي على الفاتورة ${money(balance)}` : undefined} />
        <TextField label="تاريخ القبض" type="date" required max={isoDay()} value={v.receivedOn} onChange={(e) => setV({ ...v, receivedOn: e.target.value })} error={errors.receivedOn} />
        <SelectField label="طريقة القبض" required value={v.method} onChange={(e) => setV({ ...v, method: e.target.value })} options={Object.entries(PAY_METHOD_LABELS).map(([value, label]) => ({ value, label }))} />
        <TextField label="رقم المرجع" optional dir="ltr" value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} hint="رقم الحوالة أو الشيك." />
      </div>
      <TextAreaField label="ملاحظات" optional rows={2} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} />
      <FormError error={error} />
    </Dialog>
  );
}

/** Where this document stands with ZATCA, and what to do about it. */
function ZatcaPanel({ tenantId, d, onChange }: { tenantId: string; d: DocDetail; onChange: () => void }) {
  const { can, writable } = useTenant();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const z = d.zatca;
  if (!z) return (
    <section className="panel" aria-labelledby="inv-zt-h">
      <div className="card-head"><h2 id="inv-zt-h">هيئة الزكاة والضريبة</h2></div>
      <div className="card-body"><p className="muted acc-small">صدرت برمز QR المرحلة الأولى (لم يكن جهاز الفوترة مسجلاً). <Link to={`/w/${tenantId}/accounting/zatca`}>الربط مع الهيئة</Link></p></div>
    </section>
  );
  const pending = z.outcome === null || z.outcome === "error";
  return (
    <section className="panel" aria-labelledby="inv-zt-h">
      <div className="card-head"><h2 id="inv-zt-h">هيئة الزكاة والضريبة</h2><span className="spacer" /><ZatcaBadge outcome={z.outcome} /></div>
      <div className="card-body stack">
        {z.environment !== "production" && <p className="muted acc-small">أُرسلت إلى {ENV_LABELS[z.environment]}.</p>}
        {d.invoiceType === "standard" && z.outcome !== "accepted" && z.outcome !== "accepted_with_warnings" && (
          <p className="form-error" role="status">لا تُسلَّم الفاتورة الضريبية للعميل قبل اعتمادها من الهيئة.</p>
        )}
        {[...z.errors, ...z.warnings].length > 0 && <ul className="acc-small">{[...z.errors, ...z.warnings].map((m) => <li key={m}>{m}</li>)}</ul>}
        {z.outcome === "rejected" && <p className="muted acc-small">المستند المرفوض يبقى في السجل ولا يُحذف. صحّح البيانات وأصدر مستنداً جديداً (أو إشعاراً دائناً إن لزم).</p>}
        <div className="row" style={{ gap: "var(--sp-1)" }}>
          {pending && can("acc_receipts.create") && writable && (
            <Button size="sm" icon={<Send />} loading={busy} loadingText="جارٍ الإرسال…" onClick={async () => {
              setBusy(true);
              try {
                const r = await api<{ outcome: string; errors: string[] }>("POST", `/t/zatca/documents/${z.documentId}/submit`, { tenant: tenantId });
                if (r.outcome === "error") toast.error("تعذر الاتصال بالهيئة. أعد المحاولة لاحقاً");
                else if (r.outcome === "rejected") toast.error(`رفضت الهيئة المستند: ${r.errors[0] ?? ""}`);
                else toast.success("أُرسل المستند وقبلته الهيئة");
                onChange();
              } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
            }}>إرسال للهيئة</Button>
          )}
          <Button size="sm" variant="ghost" icon={<Download />} onClick={() => void download(`/t/zatca/documents/${z.documentId}/xml`, tenantId, `${d.number}.xml`).catch((e: Error) => toast.error(e.message))}>تنزيل XML</Button>
        </div>
      </div>
    </section>
  );
}
