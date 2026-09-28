import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { useRef, useState } from "react";
import { api, ApiError } from "../../api/client";
import type { Ingredient } from "../../api/types";
import { useInvalidate, useTenant } from "../../app/tenant";
import { day, integer, isoDay, money, percent, RIYAL } from "../../lib/format";
import { Button, IconButton } from "../../ui/Button";
import { DataTable } from "../../ui/DataTable";
import { Dialog } from "../../ui/Dialog";
import { Checkbox, focusFirstInvalid, TextField } from "../../ui/Field";
import { ActionMenu, Badge, PageHeader, StatCard, StatusBadge } from "../../ui/Layout";
import { EmptyState, ErrorState, FormError, TableSkeleton } from "../../ui/States";
import { useToast } from "../../ui/Toast";
import { StatusTabs } from "./Inventory";
import { IngredientPicker } from "./pickers";

const num = (s: string) => Number(s.replace(/,/g, ""));

// ── Customer price lists ────────────────────────────────────────────────────────────────────────
interface ListRow { id: string; name: string; notes: string | null; isActive: boolean; itemsCount: number; customersCount: number }
interface ListDetail { id: string; name: string; notes: string | null; isActive: boolean; items: { itemId: string; name: string; sku: string; unit: string; price: number; salePrice: number | null }[]; customers: { id: string; name: string }[] }

export function PriceListsPage() {
  const { tenantId, can, writable } = useTenant();
  const list = useQuery({ queryKey: ["t", tenantId, "price-lists"], queryFn: () => api<{ items: ListRow[] }>("GET", "/t/price-lists", { tenant: tenantId }) });
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const canCreate = can("price_lists.create") && writable;
  const canEdit = can("price_lists.edit") && writable;
  return (
    <div className="page">
      <PageHeader eyebrow="المبيعات" title="قوائم أسعار العملاء"
        description="أسعار خاصة لفئة من العملاء (جملة، موزعين، عقود). اربط العميل بقائمته من بطاقته، فتُقترح أسعارها في عروض الأسعار قبل سعر البيع العام."
        actions={canCreate && <Button variant="primary" icon={<Plus />} onClick={() => setEditing("new")}>قائمة أسعار جديدة</Button>} />
      <section className="panel" aria-label="قوائم الأسعار">
        <DataTable caption="قوائم الأسعار" query={list} rowKey={(r) => r.id} onRowClick={canEdit ? (r) => setEditing(r.id) : undefined}
          empty={{ title: "لا توجد قوائم أسعار بعد", body: "كل العملاء يأخذون سعر البيع العام للصنف حتى تنشئ لهم قائمة.",
            action: canCreate ? <Button variant="primary" icon={<Plus />} onClick={() => setEditing("new")}>قائمة أسعار جديدة</Button> : undefined }}
          columns={[
            { key: "name", header: "القائمة", cell: (r) => <span className="stack-tight"><strong>{r.name}</strong>{r.notes && <span className="muted acc-small">{r.notes}</span>}</span> },
            { key: "itemsCount", header: "الأصناف", numeric: true, cell: (r) => integer(r.itemsCount) },
            { key: "customersCount", header: "العملاء", numeric: true, cell: (r) => integer(r.customersCount) },
            { key: "isActive", header: "الحالة", cell: (r) => <StatusBadge kind="active" value={r.isActive} /> },
          ]}
          actions={canEdit ? (r) => <ActionMenu label={`إجراءات ${r.name}`} items={[{ label: "تعديل الأسعار", onSelect: () => setEditing(r.id) }]} /> : undefined} />
      </section>
      {editing && <PriceListDialog tenantId={tenantId} id={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function PriceListDialog({ tenantId, id, onClose }: { tenantId: string; id: string | null; onClose: () => void }) {
  const d = useQuery({ enabled: Boolean(id), queryKey: ["t", tenantId, "price-lists", id], queryFn: () => api<ListDetail>("GET", `/t/price-lists/${id}`, { tenant: tenantId }) });
  if (id && d.isPending) return <Dialog open onClose={onClose} title="قائمة الأسعار"><TableSkeleton columns={3} rows={3} label="جارٍ التحميل…" /></Dialog>;
  if (id && d.isError) return <Dialog open onClose={onClose} title="قائمة الأسعار"><ErrorState error={d.error} onRetry={() => d.refetch()} /></Dialog>;
  return <PriceListForm tenantId={tenantId} data={d.data ?? null} onClose={onClose} />;
}

function PriceListForm({ tenantId, data, onClose }: { tenantId: string; data: ListDetail | null; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const form = useRef<HTMLFormElement>(null);
  const [v, setV] = useState({ name: data?.name ?? "", notes: data?.notes ?? "", isActive: data?.isActive ?? true });
  const [items, setItems] = useState(() => (data?.items ?? []).map((i) => ({ ...i, priceText: String(i.price) })));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    const e: Record<string, string> = {};
    if (v.name.trim().length < 2) e.name = "أدخل اسم القائمة";
    items.forEach((i, n) => { if (i.priceText.trim() === "" || !(num(i.priceText) >= 0)) e[`items.${n}.price`] = "أدخل السعر"; });
    setErrors(e);
    if (Object.keys(e).length) return focusFirstInvalid(form.current);
    setBusy(true); setError(null);
    const body = { name: v.name.trim(), notes: v.notes.trim() || null, items: items.map((i) => ({ itemId: i.itemId, price: num(i.priceText) })) };
    try {
      if (data) await api("PUT", `/t/price-lists/${data.id}`, { tenant: tenantId, body: { ...body, isActive: v.isActive } });
      else await api("POST", "/t/price-lists", { tenant: tenantId, body });
      toast.success(data ? `حُفظت «${body.name}»` : `أُنشئت «${body.name}»`);
      await invalidate("price-lists", "customers");
      onClose();
    } catch (err) { if (err instanceof ApiError) setErrors(err.fieldErrors); setError(err); } finally { setBusy(false); }
  }
  return (
    <Dialog open wide onClose={onClose} busy={busy} formRef={form} onSubmit={() => void submit()} title={data ? `تعديل «${data.name}»` : "قائمة أسعار جديدة"}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">حفظ القائمة</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <div className="form-grid">
        <TextField label="الاسم" required value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} error={errors.name} hint="مثل: الموزعون، الجملة، عقد سلسلة أسواق." />
        <TextField label="ملاحظات" optional value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} />
      </div>
      {data && <Checkbox label="القائمة مفعّلة" checked={v.isActive} onChange={(e) => setV({ ...v, isActive: e.target.checked })} />}
      {items.length > 0 && (
        <div className="table-wrap">
          <table className="data-table">
            <caption className="sr-only">أسعار القائمة</caption>
            <thead><tr><th scope="col">الصنف</th><th scope="col" className="end">سعر البيع العام</th><th scope="col" className="end">سعر القائمة ({RIYAL})</th><th scope="col" className="end">الفرق</th><th scope="col"><span className="sr-only">حذف</span></th></tr></thead>
            <tbody>{items.map((i, n) => {
              const diff = i.salePrice ? ((num(i.priceText) - i.salePrice) / i.salePrice) * 100 : null;
              return (
                <tr key={i.itemId}>
                  <td><strong>{i.name}</strong> <span className="muted">/ {i.unit}</span></td>
                  <td className="end num">{money(i.salePrice)}</td>
                  <td className="end"><input className="input input-sm num" inputMode="decimal" aria-label={`سعر ${i.name}`} aria-invalid={errors[`items.${n}.price`] ? true : undefined}
                    value={i.priceText} onChange={(e) => setItems((xs) => xs.map((x, m) => (m === n ? { ...x, priceText: e.target.value } : x)))} style={{ maxWidth: 120 }} /></td>
                  <td className="end num">{diff === null || !Number.isFinite(diff) ? "—" : <Badge tone={diff < 0 ? "info" : "neutral"}>{percent(diff)}</Badge>}</td>
                  <td className="end"><IconButton label={`حذف ${i.name}`} icon={<X />} destructive onClick={() => setItems((xs) => xs.filter((_, m) => m !== n))} /></td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
      <IngredientPicker tenantId={tenantId} label="إضافة صنف" types="finished,semi_finished" exclude={items.map((i) => i.itemId)} placeholder="اسم المنتج"
        onPick={(i: Ingredient) => setItems((xs) => [...xs, { itemId: i.id, name: i.name, sku: i.sku, unit: i.baseUnit, price: 0, salePrice: i.salePrice ?? null, priceText: i.salePrice != null ? String(i.salePrice) : "" }])} />
      {data && data.customers.length > 0 && <p className="muted acc-small">مرتبطة بـ {integer(data.customers.length)} عميل: {data.customers.slice(0, 8).map((c) => c.name).join("، ")}{data.customers.length > 8 ? "…" : ""}. الأوامر المكتوبة تحتفظ بأسعارها.</p>}
      <FormError error={error} />
    </Dialog>
  );
}

// ── Supplier-invoice match ──────────────────────────────────────────────────────────────────────
interface MatchRow {
  id: string; grnNumber: number; poId: string; poNumber: number; supplierName: string; receivedOn: string; supplierInvoice: string | null; invoiceAmount: number | null;
  receiptAmount: number; difference: number | null; priceLines: number; priceVariance: number; shortLines: number; status: "matched" | "no_invoice" | "amount_mismatch" | "price_above_order";
}
interface MatchReport { from: string; to: string; tolerance: number; items: MatchRow[]; summary: { total: number; matched: number; noInvoice: number; amountMismatch: number; priceAboveOrder: number } }
const MATCH: Record<MatchRow["status"], [string, "success" | "warning" | "danger" | "neutral"]> = {
  matched: ["مطابقة", "success"], no_invoice: ["بلا فاتورة", "neutral"], amount_mismatch: ["المبلغ مختلف", "danger"], price_above_order: ["سعر أعلى من الأمر", "warning"],
};

/** Three-way match: purchase order price and quantity, what was received, and the supplier's invoice amount. */
export function PurchaseMatchingReport() {
  const { tenantId } = useTenant();
  const [from, setFrom] = useState(`${isoDay().slice(0, 7)}-01`);
  const [to, setTo] = useState(isoDay());
  const [tolerance, setTolerance] = useState("1");
  const [issues, setIssues] = useState("true");
  const r = useQuery({ queryKey: ["t", tenantId, "reports", "purchase-matching", from, to, tolerance, issues], placeholderData: keepPreviousData,
    queryFn: () => api<MatchReport>("GET", "/t/reports/purchase-matching", { tenant: tenantId, query: { from, to, tolerance, issues } }) });
  const s = r.data?.summary;
  return (
    <div className="page">
      <PageHeader eyebrow="التقارير" title="مطابقة فواتير الموردين"
        description="كل سند استلام مقابل أمر شرائه وفاتورة المورد: فاتورة لم تُدخل، أو مبلغ يختلف عن قيمة الاستلام بأكثر من نسبة التسامح، أو صنف فُوتر بسعر أعلى من المتفق عليه." />
      <div className="toolbar panel sr-filter-bar">
        <TextField label="من" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        <TextField label="إلى" type="date" value={to} max={isoDay()} onChange={(e) => setTo(e.target.value)} />
        <TextField label="نسبة التسامح ٪" numeric value={tolerance} onChange={(e) => setTolerance(e.target.value)} />
        <StatusTabs value={issues} onChange={setIssues} options={[["true", "المختلفة فقط"], ["false", "الكل"]]} />
      </div>
      {s && (
        <div className="stats">
          <StatCard label="مطابقة" value={integer(s.matched)} hue="green" note={`من ${integer(s.total)} سند`} />
          <StatCard label="المبلغ مختلف" value={integer(s.amountMismatch)} hue="red" />
          <StatCard label="سعر أعلى من الأمر" value={integer(s.priceAboveOrder)} hue="amber" />
          <StatCard label="بلا فاتورة" value={integer(s.noInvoice)} hue="sky" />
        </div>
      )}
      <section className="panel" aria-label="السندات">
        {r.isError ? <ErrorState error={r.error} onRetry={() => r.refetch()} /> : !r.data ? <TableSkeleton columns={7} rows={4} label="جارٍ التحميل…" />
          : r.data.items.length === 0 ? <EmptyState title={issues === "true" ? "كل السندات مطابقة" : "لا سندات استلام في الفترة"}>{issues === "true" ? "لا فروقات تحتاج مراجعة في هذه الفترة." : "غيّر الفترة."}</EmptyState> : (
          <div className="table-wrap">
            <table className="data-table">
              <caption className="sr-only">مطابقة سندات الاستلام</caption>
              <thead><tr><th scope="col">السند</th><th scope="col">المورد</th><th scope="col">فاتورة المورد</th><th scope="col" className="end">قيمة الاستلام</th><th scope="col" className="end">مبلغ الفاتورة</th><th scope="col" className="end">الفرق</th><th scope="col" className="end">فرق الأسعار</th><th scope="col">الحالة</th></tr></thead>
              <tbody>{r.data.items.map((x) => (
                <tr key={x.id}>
                  <td><span className="stack-tight"><bdi dir="ltr" className="num">GRN-{x.grnNumber}</bdi><span className="muted acc-small"><bdi dir="ltr">PO-{x.poNumber}</bdi> · {day(x.receivedOn)}</span></span></td>
                  <td>{x.supplierName}</td>
                  <td className="num">{x.supplierInvoice ?? "—"}</td>
                  <td className="end num">{money(x.receiptAmount)}</td>
                  <td className="end num">{money(x.invoiceAmount)}</td>
                  <td className="end num">{x.difference ? money(x.difference) : "—"}</td>
                  <td className="end num">{x.priceVariance ? money(x.priceVariance) : "—"}</td>
                  <td><Badge tone={MATCH[x.status][1]}>{MATCH[x.status][0]}</Badge>{x.shortLines > 0 && <> <Badge tone="neutral">فيه مرفوض</Badge></>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

