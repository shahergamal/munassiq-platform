import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowRight, Boxes, ClipboardCheck, ClipboardList, Hourglass, ListChecks, Package, Plus, Printer, Scale, ScanBarcode, Trash2, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type Page } from "../../api/client";
import type { Ingredient, Location } from "../../api/types";
import { useIdempotencyKey } from "../../app/session";
import { useInvalidate, useTenant } from "../../app/tenant";
import { addDays, cost, day, dayTime, integer, isoDay, money, quantity, text } from "../../lib/format";
import { Button, IconButton } from "../../ui/Button";
import { DataTable } from "../../ui/DataTable";
import { useTablePrefs } from "../../ui/tablePrefs";
import { DateRange } from "../../ui/DateRange";
import { ConfirmDialog, Dialog } from "../../ui/Dialog";
import { focusFirstInvalid, SearchInput, SelectField, TextAreaField, TextField } from "../../ui/Field";
import { beep, ScanField } from "../../ui/Scanner";
import { Badge, PageHeader, StatCard, StatusBadge } from "../../ui/Layout";
import { EmptyState, ErrorState, FormError, TableSkeleton } from "../../ui/States";
import { MOVEMENT_LABELS, WASTE_REASON_LABELS } from "../../ui/status";
import { useToast } from "../../ui/Toast";
import { IngredientPicker } from "./pickers";

export function useLocations(tenantId: string) {
  return useQuery({ queryKey: ["t", tenantId, "locations", "options", "active"], queryFn: () => api<Page<Location>>("GET", "/t/locations", { tenant: tenantId, query: { isActive: "true", pageSize: 100 } }) });
}

export interface Line { ingredient: Ingredient; quantity: string; inPurchaseUnit: boolean }
const num = (s: string) => Number(s.replace(/,/g, ""));
/** Quantity in BASE units (what the server stores). Entering "2 كيلوجرام" is safer than "2000 جرام". */
export const baseQty = (l: Line) => (num(l.quantity) || 0) * (l.inPurchaseUnit ? l.ingredient.purchaseToBase : 1);
const hasPurchaseUnit = (i: Ingredient) => i.purchaseUnitId !== i.baseUnitId && i.purchaseToBase !== 1;

/** Lines of ingredients in BASE units, with the balance at the source location beside each one. */
export function StockLines({ tenantId, locationId, lines, setLines, errors }: { tenantId: string; locationId: string; lines: Line[]; setLines: (f: (l: Line[]) => Line[]) => void; errors: Record<string, string> }) {
  return (
    <section className="panel" aria-labelledby="lines-h">
      <div className="card-head"><h2 id="lines-h">المواد</h2>{lines.length > 0 && <span className="badge badge-neutral num">{integer(lines.length)}</span>}</div>
      <div className="card-body inv-lines-picker">
        {locationId
          ? <IngredientPicker tenantId={tenantId} locationId={locationId} label="إضافة مادة" exclude={lines.map((l) => l.ingredient.id)} error={errors.lines}
              onPick={(i) => setLines((ls) => [...ls, { ingredient: i, quantity: "", inPurchaseUnit: hasPurchaseUnit(i) }])} />
          : <p className="muted">اختر الموقع أولاً لتظهر أرصدة المواد فيه.</p>}
      </div>
      {lines.length > 0 && (
        <div className="table-wrap">
          <table className="data-table">
            <caption className="sr-only">المواد</caption>
            <thead><tr><th scope="col">المادة</th><th scope="col">الكمية</th><th scope="col" className="end">المتاح في الموقع</th><th scope="col" className="end">التكلفة التقديرية</th><th scope="col"><span className="sr-only">إزالة</span></th></tr></thead>
            <tbody>
              {lines.map((l, i) => {
                const q = baseQty(l);
                const over = q > l.ingredient.stockQty;
                return (
                  <tr key={l.ingredient.id}>
                    <td><strong>{l.ingredient.name}</strong></td>
                    <td style={{ minWidth: 220 }}>
                      <div className="row" style={{ flexWrap: "nowrap" }}>
                        <input className="input num" inputMode="decimal" aria-label={`كمية ${l.ingredient.name}`} aria-invalid={errors[`q${i}`] || over ? true : undefined} value={l.quantity}
                          onChange={(e) => setLines((ls) => ls.map((x, n) => (n === i ? { ...x, quantity: e.target.value } : x)))} />
                        {hasPurchaseUnit(l.ingredient) ? (
                          <select className="select" style={{ width: "auto" }} aria-label={`وحدة ${l.ingredient.name}`} value={l.inPurchaseUnit ? "p" : "b"}
                            onChange={(e) => setLines((ls) => ls.map((x, n) => (n === i ? { ...x, inPurchaseUnit: e.target.value === "p" } : x)))}>
                            <option value="p">{l.ingredient.purchaseUnitName}</option><option value="b">{l.ingredient.baseUnitName}</option>
                          </select>
                        ) : <span className="muted">{l.ingredient.baseUnitName}</span>}
                      </div>
                      {l.inPurchaseUnit && q > 0 && <span className="field-hint">= {quantity(q)} {l.ingredient.baseUnitName}</span>}
                      {errors[`q${i}`] && <span className="field-error">{errors[`q${i}`]}</span>}
                      {!errors[`q${i}`] && over && <span className="field-error">أكبر من المتاح</span>}
                    </td>
                    <td className="end num">{quantity(l.ingredient.stockQty)} {l.ingredient.baseUnitName}</td>
                    <td className="end num muted">{money(q * l.ingredient.avgCost)}</td>
                    <td className="actions"><IconButton size="sm" destructive label={`إزالة ${l.ingredient.name}`} icon={<Trash2 />} onClick={() => setLines((ls) => ls.filter((_, n) => n !== i))} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function validateLines(lines: Line[], e: Record<string, string>) {
  if (!lines.length) e.lines = "أضف مادة واحدة على الأقل";
  lines.forEach((l, i) => { if (!(num(l.quantity) > 0)) e[`q${i}`] = "كمية أكبر من صفر"; });
}

// ── Transfers ───────────────────────────────────────────────────────────────────────────────────
interface TransferRow { id: string; number: number; status: string; notes: string | null; createdAt: string; completedAt: string | null; fromName: string; toName: string; itemsCount: number; value: number | null }

export function TransfersPage() {
  const { tenantId, can, writable } = useTenant();
  const navigate = useNavigate();
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const prefs = useTablePrefs("transfers", { server: true, onSortChange: () => setPage(1) });
  const list = useQuery({ queryKey: ["t", tenantId, "transfers", { status, page, sort: prefs.sortParam }], queryFn: () => api<Page<TransferRow>>("GET", "/t/transfers", { tenant: tenantId, query: { status, page, pageSize: 25, sort: prefs.sortParam } }), placeholderData: keepPreviousData });
  const canWrite = can("transfers.create") && writable;
  const add = canWrite && <Link to={`/w/${tenantId}/transfers/new`} className="btn btn-primary"><Plus aria-hidden="true" />تحويل جديد</Link>;
  return (
    <div className="page">
      <PageHeader eyebrow="المخزون" title="التحويلات بين المواقع" description="نقل المواد من المستودع إلى المطبخ أو بين الفروع. تخرج بتكلفة المصدر وتدخل الوجهة بمتوسطها المرجح." actions={add} />
      <section className="panel">
        <DataTable caption="التحويلات" prefs={prefs} query={list} rowKey={(r) => r.id} onPageChange={setPage} filtered={Boolean(status)} onClearFilters={() => setStatus("")}
          toolbar={<StatusTabs value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={[["", "الكل"], ["draft", "مسودات"], ["in_transit", "في الطريق"], ["completed", "مستلمة"], ["cancelled", "ملغاة"]]} />}
          onRowClick={(r) => navigate({ to: `/w/${tenantId}/transfers/${r.id}` })}
          empty={{ title: "لا توجد تحويلات بعد", body: "أنشئ تحويلاً عندما تنقل مواد من المستودع إلى المطبخ.", action: add || undefined }}
          columns={[
            { key: "n", sortKey: "number", header: "الرقم", cell: (r) => <Link to={`/w/${tenantId}/transfers/${r.id}`}><strong className="num">TR-{r.number}</strong></Link> },
            { key: "from", sortKey: "fromName", header: "من", cell: (r) => r.fromName },
            { key: "to", sortKey: "toName", header: "إلى", cell: (r) => r.toName },
            { key: "items", sortKey: "itemsCount", header: "المواد", numeric: true, cell: (r) => integer(r.itemsCount) },
            { key: "value", sortKey: "value", header: "القيمة", numeric: true, cell: (r) => (r.value === null ? "—" : money(r.value)) },
            { key: "date", header: "التاريخ", cell: (r) => dayTime(r.completedAt ?? r.createdAt) },
            { key: "s", sortKey: "status", header: "الحالة", cell: (r) => <StatusBadge kind="transfer" value={r.status} /> },
          ]} />
      </section>
    </div>
  );
}

export function StatusTabs({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <div role="group" aria-label="تصفية حسب الحالة" className="row" style={{ gap: "var(--sp-1)" }}>
      {options.map(([v, l]) => <button key={v} type="button" className={`btn btn-sm ${value === v ? "btn-secondary" : "btn-ghost"}`} aria-pressed={value === v} onClick={() => onChange(v)}>{l}</button>)}
    </div>
  );
}

export function NewTransferPage() {
  const { tenantId } = useTenant();
  const navigate = useNavigate();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const locations = useLocations(tenantId);
  const [key, renewKey] = useIdempotencyKey();
  const form = useRef<HTMLFormElement>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLinesState] = useState<Line[]>([]);
  const setLines = (f: (l: Line[]) => Line[]) => setLinesState(f);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<"now" | "draft" | null>(null);
  const locs = locations.data?.items ?? [];

  useEffect(() => { setLinesState([]); }, [from]); // balances belong to the source location

  async function submit(completeNow: boolean) {
    const e: Record<string, string> = {};
    if (!from) e.from = "اختر موقع المصدر";
    if (!to) e.to = "اختر موقع الوجهة";
    if (from && to && from === to) e.to = "الوجهة يجب أن تختلف عن المصدر";
    validateLines(lines, e);
    setErrors(e);
    if (Object.keys(e).length) return focusFirstInvalid(form.current);
    setBusy(completeNow ? "now" : "draft"); setError(null);
    try {
      const r = await api<{ id: string }>("POST", "/t/transfers", { tenant: tenantId, idempotencyKey: key,
        body: { fromLocationId: from, toLocationId: to, notes: notes.trim() || null, completeNow, items: lines.map((l) => ({ ingredientId: l.ingredient.id, quantity: baseQty(l) })) } });
      renewKey();
      toast.success(completeNow ? "تم تنفيذ التحويل ونقل المواد" : "تم حفظ التحويل كمسودة");
      await invalidate("transfers", "stock", "ingredients", "reports");
      navigate({ to: `/w/${tenantId}/transfers/${r.id}` });
    } catch (err) {
      if (err instanceof ApiError) { setErrors(err.fieldErrors); if (err.code === "insufficient_stock") renewKey(); }
      setError(err);
    } finally { setBusy(null); }
  }

  if (locations.isError) return <div className="page"><ErrorState error={locations.error} onRetry={() => locations.refetch()} /></div>;
  if (locations.data && locs.length < 2) return <div className="page"><EmptyState title="تحتاج موقعين على الأقل" action={<Link to={`/w/${tenantId}/locations`} className="btn btn-primary">إضافة موقع</Link>}>التحويل ينقل المواد من موقع إلى آخر، مثل المستودع المركزي والمطبخ.</EmptyState></div>;
  const opts = locs.map((l) => ({ value: l.id, label: l.name }));
  return (
    <form ref={form} className="page" noValidate onSubmit={(e) => { e.preventDefault(); void submit((e.nativeEvent as SubmitEvent).submitter?.getAttribute("name") !== "draft"); }}>
      <PageHeader eyebrow="التحويلات" title="تحويل جديد" actions={<Link to={`/w/${tenantId}/transfers`} className="btn btn-ghost"><ArrowRight aria-hidden="true" />التحويلات</Link>} />
      <section className="panel panel-pad form-section" aria-labelledby="transfer-h">
        <h2 id="transfer-h">بيانات التحويل</h2>
        <div className="form-grid">
          <SelectField label="من موقع" required placeholder="اختر المصدر" options={opts} value={from} onChange={(e) => setFrom(e.target.value)} error={errors.from} />
          <SelectField label="إلى موقع" required placeholder="اختر الوجهة" options={opts.filter((o) => o.value !== from)} value={to} onChange={(e) => setTo(e.target.value)} error={errors.to} />
        </div>
        <TextAreaField label="ملاحظات" optional rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </section>
      <StockLines tenantId={tenantId} locationId={from} lines={lines} setLines={setLines} errors={errors} />
      <FormError error={error} />
      <div className="row inv-form-bar">
        <Button type="submit" name="now" variant="primary" loading={busy === "now"} disabled={busy === "draft"} loadingText="جارٍ النقل…">تنفيذ التحويل الآن</Button>
        <Button type="submit" name="draft" loading={busy === "draft"} disabled={busy === "now"} loadingText="جارٍ الحفظ…">حفظ كمسودة</Button>
        <Link to={`/w/${tenantId}/transfers`} className="btn btn-ghost">إلغاء</Link>
      </div>
    </form>
  );
}

interface TransferDetail {
  id: string; number: number; status: string; notes: string | null; createdAt: string; completedAt: string | null; dispatchedAt: string | null; shortageValue: number; fromName: string; toName: string;
  items: { ingredientId: string; name: string; unit: string; quantity: number; unitCost: number | null; available: number | null; receivedQuantity: number | null; shortageReason: string | null;
    batches?: { batchId: string; batchNo: string; expiryDate: string | null; quantity: number }[] }[];
}

/**
 * The transfer document cycle: draft → dispatched (stock leaves the source, "in transit") → received at the
 * destination, where a shortage is recorded with its reason and written off. A draft can also be moved at once.
 */
export function TransferDetailPage() {
  const { tenantId, can, writable } = useTenant();
  const { transferId } = useParams({ strict: false }) as { transferId: string };
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [confirm, setConfirm] = useState<"complete" | "dispatch" | "cancel" | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [got, setGot] = useState<Record<string, { q: string; reason: string }>>({});
  const t = useQuery({ queryKey: ["t", tenantId, "transfers", transferId], queryFn: () => api<TransferDetail>("GET", `/t/transfers/${transferId}`, { tenant: tenantId }) });
  async function act(a: "complete" | "dispatch" | "cancel") {
    setBusy(true); setErr(null);
    try {
      await api("POST", `/t/transfers/${transferId}/${a}`, { tenant: tenantId });
      setConfirm(null);
      toast.success(a === "complete" ? "تم تنفيذ التحويل" : a === "dispatch" ? "أُرسلت المواد وهي الآن في الطريق" : "تم إلغاء التحويل");
      await invalidate("transfers", "stock", "ingredients", "reports");
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function receive() {
    const d = t.data!;
    const items = d.items.map((i) => {
      const g = got[i.ingredientId];
      return { ingredientId: i.ingredientId, receivedQuantity: g && g.q.trim() !== "" ? num(g.q) : i.quantity, shortageReason: g?.reason.trim() || null };
    });
    const bad = items.find((x, n) => !(x.receivedQuantity >= 0) || x.receivedQuantity > d.items[n]!.quantity);
    if (bad) return setErr("الكمية المستلمة رقم من صفر حتى الكمية المُرسلة");
    const noReason = items.find((x, n) => x.receivedQuantity < d.items[n]!.quantity && (x.shortageReason ?? "").length < 3);
    if (noReason) return setErr(`اكتب سبب نقص «${d.items.find((i) => i.ingredientId === noReason.ingredientId)!.name}»`);
    setBusy(true); setErr(null);
    try {
      const r = await api<{ shortageValue: number }>("POST", `/t/transfers/${transferId}/receive`, { tenant: tenantId, body: { items } });
      toast.success(r.shortageValue > 0 ? `تم الاستلام. عجز بقيمة ${money(r.shortageValue)} سُجّل تسوية مخزون` : "تم الاستلام كاملاً");
      await invalidate("transfers", "stock", "ingredients", "reports");
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  if (t.isPending) return <div className="page"><TableSkeleton columns={4} rows={3} /></div>;
  if (t.isError) return <div className="page"><ErrorState error={t.error} onRetry={() => t.refetch()} /></div>;
  const d = t.data;
  const mine = writable;
  const draft = d.status === "draft" && mine && (can("transfers.dispatch") || can("transfers.cancel"));
  const receiving = d.status === "in_transit" && mine && can("transfers.receive");
  const value = d.items.reduce((a, i) => a + i.quantity * (i.unitCost ?? 0), 0);
  const showReceived = d.status === "completed" && d.items.some((i) => i.receivedQuantity !== null);
  return (
    <div className="page">
      <PageHeader eyebrow="تحويل" title={<span className="row inv-title"><span>{`TR-${d.number}: ${d.fromName} ← ${d.toName}`}</span><StatusBadge kind="transfer" value={d.status} /></span>}
        actions={<>
          <Link to={`/w/${tenantId}/transfers`} className="btn btn-ghost no-print"><ArrowRight aria-hidden="true" />التحويلات</Link>
          <Button variant="ghost" className="no-print" icon={<Printer />} onClick={() => window.print()}>طباعة إذن التحويل</Button>
          {draft && can("transfers.cancel") && <Button variant="ghost" destructive className="no-print" onClick={() => { setErr(null); setConfirm("cancel"); }}>إلغاء التحويل</Button>}
          {draft && can("transfers.dispatch") && can("transfers.receive") && <Button className="no-print" onClick={() => { setErr(null); setConfirm("complete"); }}>نقل فوري</Button>}
          {draft && can("transfers.dispatch") && <Button variant="primary" className="no-print" onClick={() => { setErr(null); setConfirm("dispatch"); }}>إرسال المواد</Button>}
          {receiving && <Button variant="primary" className="no-print" loading={busy} loadingText="جارٍ الاستلام…" onClick={() => void receive()}>تأكيد الاستلام</Button>}
        </>} />
      {d.status === "in_transit" && <p className="banner banner-info inv-banner no-print">المواد في الطريق منذ {dayTime(d.dispatchedAt)}. عند وصولها عُدّها وسجّل المستلم فعلاً؛ الناقص يُسجَّل عجزاً بسببه.</p>}
      <section className="panel acc-print" aria-labelledby="tr-facts-h">
        <div className="card-head"><h2 id="tr-facts-h">إذن تحويل مخزني TR-{d.number}</h2></div>
        <div className="card-body">
          <dl className="dl">
            <dt>من موقع</dt><dd>{d.fromName}</dd>
            <dt>إلى موقع</dt><dd>{d.toName}</dd>
            <dt>أُنشئ</dt><dd>{dayTime(d.createdAt)}</dd>
            {d.dispatchedAt && <><dt>أُرسل</dt><dd>{dayTime(d.dispatchedAt)}</dd></>}
            {d.completedAt && <><dt>استُلم</dt><dd>{dayTime(d.completedAt)}</dd></>}
            {d.status !== "draft" && d.status !== "cancelled" && <><dt>القيمة المُرسلة</dt><dd><span className="num">{money(value)}</span></dd></>}
            {d.shortageValue > 0 && <><dt>عجز الطريق</dt><dd><Badge tone="danger">{money(d.shortageValue)}</Badge></dd></>}
            {d.notes && <><dt>ملاحظات</dt><dd>{d.notes}</dd></>}
          </dl>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <caption className="sr-only">مواد التحويل</caption>
            <thead><tr>
              <th scope="col">المادة</th><th scope="col" className="end">المُرسل</th>
              {d.status === "draft" && <th scope="col" className="end">المتاح الآن في المصدر</th>}
              {receiving && <><th scope="col">المستلم فعلاً</th><th scope="col">سبب النقص</th></>}
              {showReceived && <><th scope="col" className="end">المستلم</th><th scope="col">سبب النقص</th></>}
              <th scope="col" className="end">تكلفة الوحدة</th><th scope="col" className="end">القيمة</th>
            </tr></thead>
            <tbody>{d.items.map((i) => {
              const g = got[i.ingredientId] ?? { q: "", reason: "" };
              const short = g.q.trim() !== "" && num(g.q) < i.quantity;
              return (
                <tr key={i.ingredientId}>
                  <td><strong>{i.name}</strong>{(i.batches?.length ?? 0) > 0 && <div className="muted acc-small">{i.batches!.map((b) => `${b.batchNo}${b.expiryDate ? ` (ينتهي ${day(b.expiryDate)})` : ""}: ${quantity(b.quantity)}`).join("، ")}</div>}</td>
                  <td className="end num">{quantity(i.quantity)} {i.unit}</td>
                  {d.status === "draft" && <td className="end num">{(i.available ?? 0) < i.quantity ? <Badge tone="danger">{quantity(i.available ?? 0)} {i.unit}</Badge> : `${quantity(i.available)} ${i.unit}`}</td>}
                  {receiving && <>
                    <td style={{ minWidth: 150 }}><input className="input num" inputMode="decimal" placeholder={quantity(i.quantity)} aria-label={`المستلم من ${i.name} بالـ${i.unit}`} value={g.q}
                      onChange={(e) => setGot((x) => ({ ...x, [i.ingredientId]: { ...g, q: e.target.value } }))} /></td>
                    <td style={{ minWidth: 180 }}>{short ? <input className="input" aria-label={`سبب نقص ${i.name}`} placeholder="تالف، سقط، لم يُحمَّل…" value={g.reason}
                      onChange={(e) => setGot((x) => ({ ...x, [i.ingredientId]: { ...g, reason: e.target.value } }))} /> : <span className="muted">—</span>}</td>
                  </>}
                  {showReceived && <>
                    <td className="end num">{i.receivedQuantity !== null && i.receivedQuantity < i.quantity ? <Badge tone="danger">{quantity(i.receivedQuantity)} {i.unit}</Badge> : `${quantity(i.receivedQuantity ?? i.quantity)} ${i.unit}`}</td>
                    <td>{text(i.shortageReason)}</td>
                  </>}
                  <td className="end num">{i.unitCost === null ? <span className="muted">عند الإرسال</span> : cost(i.unitCost)}</td>
                  <td className="end num">{i.unitCost === null ? "—" : money(i.quantity * i.unitCost)}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
        <div className="doc-signatures acc-print-only"><span>المُرسِل: ____________</span><span>السائق: ____________</span><span>المستلِم: ____________</span></div>
      </section>
      {err && !confirm && <FormError error={err} />}
      <ConfirmDialog open={confirm === "dispatch"} onClose={() => setConfirm(null)} destructive={false} busy={busy} error={err} onConfirm={() => void act("dispatch")}
        title={`إرسال TR-${d.number}`} confirmLabel="إرسال المواد" message={<>ستُخصم {integer(d.items.length)} مادة من <strong>{d.fromName}</strong> وتبقى «في الطريق» حتى يؤكد <strong>{d.toName}</strong> استلامها.</>} />
      <ConfirmDialog open={confirm === "complete"} onClose={() => setConfirm(null)} destructive={false} busy={busy} error={err} onConfirm={() => void act("complete")}
        title={`نقل فوري TR-${d.number}`} confirmLabel="نقل المواد الآن" message={<>ستُخصم {integer(d.items.length)} مادة من <strong>{d.fromName}</strong> وتضاف إلى <strong>{d.toName}</strong> كاملة في خطوة واحدة (للنقل داخل نفس المبنى).</>} />
      <ConfirmDialog open={confirm === "cancel"} onClose={() => setConfirm(null)} busy={busy} error={err} onConfirm={() => void act("cancel")}
        title={`إلغاء TR-${d.number}`} confirmLabel="إلغاء التحويل" message="لن تُنقل أي مواد، ويبقى التحويل ملغى في السجل." />
    </div>
  );
}

// ── Waste ───────────────────────────────────────────────────────────────────────────────────────
interface WasteRow { id: string; number: number; reason: string; notes: string | null; totalCost: number; createdAt: string; locationName: string; summary: string | null }

export function WastePage() {
  const { tenantId, can, writable } = useTenant();
  const [from, setFrom] = useState(addDays(isoDay(), -29));
  const [to, setTo] = useState(isoDay());
  const [reason, setReason] = useState("");
  const [page, setPage] = useState(1);
  const prefs = useTablePrefs("waste", { server: true, onSortChange: () => setPage(1) });
  const list = useQuery({ queryKey: ["t", tenantId, "waste", { from, to, reason, page, sort: prefs.sortParam }], queryFn: () => api<Page<WasteRow>>("GET", "/t/waste", { tenant: tenantId, query: { from, to, reason, page, pageSize: 25, sort: prefs.sortParam } }), placeholderData: keepPreviousData });
  const add = can("waste.create") && writable && <Link to={`/w/${tenantId}/waste/new`} className="btn btn-primary"><Plus aria-hidden="true" />تسجيل هدر</Link>;
  return (
    <div className="page">
      <PageHeader eyebrow="المخزون" title="الهدر والتلف" description="كل ما يُتلف يُخصم من المخزون بمتوسط تكلفته المرجح ويظهر في تحليل الهدر. السجل لا يُعدَّل ولا يُحذف." actions={add} />
      <section className="panel">
        <DataTable caption="سجلات الهدر" prefs={prefs} query={list} rowKey={(r) => r.id} onPageChange={setPage} filtered={Boolean(reason)} onClearFilters={() => setReason("")}
          toolbar={<>
          <DateRange from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); setPage(1); }} />
          <select className="select" aria-label="السبب" value={reason} onChange={(e) => { setReason(e.target.value); setPage(1); }}>
            <option value="">كل الأسباب</option>{Object.entries(WASTE_REASON_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          </>}
          empty={{ title: "لا يوجد هدر مسجل في هذه الفترة", body: "سجّل كل تلف أو انتهاء صلاحية فور حدوثه، ليبقى الرصيد مطابقاً والتكلفة حقيقية.", action: add || undefined }}
          columns={[
            { key: "n", sortKey: "number", header: "الرقم", cell: (r) => <span className="num">WS-{r.number}</span> },
            { key: "date", sortKey: "createdAt", header: "الوقت", cell: (r) => dayTime(r.createdAt) },
            { key: "loc", sortKey: "locationName", header: "الموقع", cell: (r) => r.locationName },
            { key: "reason", sortKey: "reason", header: "السبب", cell: (r) => <>{WASTE_REASON_LABELS[r.reason]}{r.notes && <span className="muted"> · {r.notes}</span>}</> },
            { key: "items", header: "المواد", wrap: true, cell: (r) => text(r.summary) },
            { key: "cost", sortKey: "totalCost", header: "التكلفة", numeric: true, cell: (r) => money(r.totalCost) },
          ]} />
      </section>
    </div>
  );
}

export function NewWastePage() {
  const { tenantId } = useTenant();
  const navigate = useNavigate();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const locations = useLocations(tenantId);
  const [key, renewKey] = useIdempotencyKey();
  const form = useRef<HTMLFormElement>(null);
  const [loc, setLoc] = useState("");
  const [reason, setReason] = useState("expired");
  const [notes, setNotes] = useState("");
  const [lines, setLinesState] = useState<Line[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { const only = locations.data?.items; if (only?.length === 1 && !loc) setLoc(only[0]!.id); }, [locations.data, loc]);
  useEffect(() => { setLinesState([]); }, [loc]);
  const estimate = lines.reduce((a, l) => a + baseQty(l) * l.ingredient.avgCost, 0);

  function review() {
    const e: Record<string, string> = {};
    if (!loc) e.loc = "اختر الموقع الذي حدث فيه الهدر";
    if (reason === "other" && notes.trim().length < 3) e.notes = "اشرح السبب عند اختيار «أخرى»";
    validateLines(lines, e);
    setErrors(e);
    if (Object.keys(e).length) return focusFirstInvalid(form.current);
    setError(null); setConfirming(true);
  }
  async function post() {
    setBusy(true); setError(null);
    try {
      const r = await api<{ id: string; totalCost: number }>("POST", "/t/waste", { tenant: tenantId, idempotencyKey: key,
        body: { locationId: loc, reason, notes: notes.trim() || null, items: lines.map((l) => ({ ingredientId: l.ingredient.id, quantity: baseQty(l) })) } });
      renewKey();
      toast.success(`تم تسجيل الهدر وخصم ${money(r.totalCost)} من قيمة المخزون`);
      await invalidate("waste", "stock", "ingredients", "reports");
      navigate({ to: `/w/${tenantId}/waste` });
    } catch (err) { setError(err); setConfirming(false); } finally { setBusy(false); }
  }
  const locName = locations.data?.items.find((l) => l.id === loc)?.name;
  return (
    <form ref={form} className="page" noValidate onSubmit={(e) => { e.preventDefault(); review(); }}>
      <PageHeader eyebrow="الهدر والتلف" title="تسجيل هدر" description="يُخصم فوراً من رصيد الموقع ولا يمكن تعديله بعد التسجيل." actions={<Link to={`/w/${tenantId}/waste`} className="btn btn-ghost"><ArrowRight aria-hidden="true" />السجل</Link>} />
      <section className="panel panel-pad form-section" aria-labelledby="waste-h">
        <h2 id="waste-h">بيانات الهدر</h2>
        <div className="form-grid">
          <SelectField label="الموقع" required placeholder="اختر الموقع" value={loc} onChange={(e) => setLoc(e.target.value)} error={errors.loc} options={(locations.data?.items ?? []).map((l) => ({ value: l.id, label: l.name }))} />
          <SelectField label="السبب" required value={reason} onChange={(e) => setReason(e.target.value)} options={Object.entries(WASTE_REASON_LABELS).map(([value, label]) => ({ value, label }))} />
        </div>
        <TextAreaField label="ملاحظات" required={reason === "other"} optional={reason !== "other"} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} error={errors.notes} />
      </section>
      <StockLines tenantId={tenantId} locationId={loc} lines={lines} setLines={(f) => setLinesState(f)} errors={errors} />
      <FormError error={error} />
      <div className="row inv-form-bar">
        <Button type="submit" variant="primary">مراجعة وتسجيل الهدر</Button>
        <Link to={`/w/${tenantId}/waste`} className="btn btn-ghost">إلغاء</Link>
        <span className="spacer" />
        <span className="muted">التكلفة التقديرية: <strong className="num inv-strong">{money(estimate)}</strong></span>
      </div>
      <ConfirmDialog open={confirming} onClose={() => setConfirming(false)} busy={busy} error={null} onConfirm={() => void post()}
        title="تأكيد تسجيل الهدر" confirmLabel="تسجيل الهدر وخصم المخزون"
        message={<>سيُخصم {integer(lines.length)} مادة من <strong>{locName}</strong> بسبب «{WASTE_REASON_LABELS[reason]}» بتكلفة تقديرية {money(estimate)}. لا يمكن التراجع.</>} />
    </form>
  );
}

// ── Stocktakes ──────────────────────────────────────────────────────────────────────────────────
interface CountRow { id: string; number: number; status: string; locationName: string; createdAt: string; postedAt: string | null; itemsCount: number; countedCount: number; varianceValue: number | null }

export function StocktakesPage() {
  const { tenantId, can, writable } = useTenant();
  const navigate = useNavigate();
  const invalidate = useInvalidate(tenantId);
  const locations = useLocations(tenantId);
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [starting, setStarting] = useState(false);
  const [loc, setLoc] = useState("");
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const categories = useQuery({ enabled: starting, queryKey: ["t", tenantId, "ingredients", "categories"], queryFn: () => api<{ items: string[] }>("GET", "/t/ingredients/categories", { tenant: tenantId }) });
  const prefs = useTablePrefs("stocktakes", { server: true, onSortChange: () => setPage(1) });
  const list = useQuery({ queryKey: ["t", tenantId, "stocktakes", { status, page, sort: prefs.sortParam }], queryFn: () => api<Page<CountRow>>("GET", "/t/stocktakes", { tenant: tenantId, query: { status, page, pageSize: 25, sort: prefs.sortParam } }), placeholderData: keepPreviousData });
  const canStart = can("stocktakes.count") && writable;
  async function start() {
    if (!loc) return setErr("اختر الموقع الذي ستجرده");
    setBusy(true); setErr(null);
    try {
      const r = await api<{ id: string }>("POST", "/t/stocktakes", { tenant: tenantId, body: { locationId: loc, category: category || null } });
      await invalidate("stocktakes");
      navigate({ to: `/w/${tenantId}/stocktakes/${r.id}` });
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  const startBtn = canStart && <Button variant="primary" icon={<Plus />} onClick={() => { setErr(null); setStarting(true); }}>بدء جرد</Button>;
  return (
    <div className="page">
      <PageHeader eyebrow="المخزون" title="الجرد الفعلي" description="عُدّ ما في الموقع فعلاً. العد أعمى (لا يظهر رصيد النظام)، والفرق يُسوّى عند الترحيل من المالك أو المدير أو المحاسب." actions={startBtn} />
      <section className="panel">
        <DataTable caption="عمليات الجرد" prefs={prefs} query={list} rowKey={(r) => r.id} onPageChange={setPage} filtered={Boolean(status)} onClearFilters={() => setStatus("")}
          toolbar={<StatusTabs value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={[["", "الكل"], ["counting", "قيد العد"], ["posted", "مُرحَّلة"], ["cancelled", "ملغاة"]]} />}
          onRowClick={(r) => navigate({ to: `/w/${tenantId}/stocktakes/${r.id}` })}
          empty={{ title: "لم يُنفّذ أي جرد بعد", body: "الجرد الدوري يكشف الفاقد غير المسجل ويصحح الرصيد.", action: startBtn || undefined }}
          columns={[
            { key: "n", sortKey: "number", header: "الرقم", cell: (r) => <Link to={`/w/${tenantId}/stocktakes/${r.id}`}><strong className="num">ST-{r.number}</strong></Link> },
            { key: "loc", sortKey: "locationName", header: "الموقع", cell: (r) => r.locationName },
            { key: "progress", header: "المعدود", numeric: true, cell: (r) => `${integer(r.countedCount)} / ${integer(r.itemsCount)}` },
            { key: "date", header: "التاريخ", cell: (r) => dayTime(r.postedAt ?? r.createdAt) },
            { key: "var", sortKey: "varianceValue", header: "قيمة الفرق", numeric: true, cell: (r) => r.varianceValue === null ? "—" : <span className={r.varianceValue < 0 ? "inv-neg" : undefined}>{money(r.varianceValue)}</span> },
            { key: "s", sortKey: "status", header: "الحالة", cell: (r) => <StatusBadge kind="stocktake" value={r.status} /> },
          ]} />
      </section>
      <Dialog open={starting} onClose={() => setStarting(false)} busy={busy} title="بدء جرد" onSubmit={() => void start()}
        footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ تجهيز ورقة العد…">بدء الجرد</Button><Button onClick={() => setStarting(false)} disabled={busy}>إلغاء</Button></>}>
        <p className="muted">تُنشأ ورقة عد بالمواد النشطة. ما لا تعدّه يبقى رصيده كما هو. يمكنك العد بجهاز الباركود أو كاميرا الجوال.</p>
        <SelectField label="الموقع" required placeholder="اختر الموقع" value={loc} onChange={(e) => setLoc(e.target.value)} options={(locations.data?.items ?? []).map((l) => ({ value: l.id, label: l.name }))} />
        <SelectField label="النطاق" value={category} onChange={(e) => setCategory(e.target.value)} hint="الجرد الدوري: فئة واحدة كل مرة (خضار اليوم، لحوم غداً…) بدل إغلاق المستودع لجرد شامل"
          options={[{ value: "", label: "كل المواد (جرد شامل)" }, ...(categories.data?.items ?? []).map((c) => ({ value: c, label: `فئة: ${c}` }))]} />
        <FormError error={err} />
      </Dialog>
    </div>
  );
}

interface CountDetail {
  id: string; number: number; status: string; notes: string | null; varianceValue: number | null; createdAt: string; postedAt: string | null; locationName: string;
  category: string | null; scanned: boolean; barcodes: { code: string; ingredientId: string; baseQuantity: number; label: string | null }[];
  items: { ingredientId: string; name: string; category: string | null; unit: string; countedQty: number | null; systemQty: number | null; unitCost?: number; variance?: number; varianceValue?: number }[];
}

export function StocktakeSheetPage() {
  const { tenantId, can, writable } = useTenant();
  const { stocktakeId } = useParams({ strict: false }) as { stocktakeId: string };
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const s = useQuery({ queryKey: ["t", tenantId, "stocktakes", stocktakeId], queryFn: () => api<CountDetail>("GET", `/t/stocktakes/${stocktakeId}`, { tenant: tenantId }) });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [q, setQ] = useState("");
  const [onlyPending, setOnlyPending] = useState(false);
  const [busy, setBusy] = useState<"save" | "post" | "cancel" | null>(null);
  const [confirm, setConfirm] = useState<"post" | "cancel" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [scanMode, setScanMode] = useState(false);
  const [times, setTimes] = useState("1");
  const [scans, setScans] = useState<{ id: number; ingredientId: string; name: string; unit: string; added: number; total: number; prev: string }[]>([]);
  const [unknown, setUnknown] = useState<{ code: string; name?: string } | null>(null);
  const scanned = useRef(false);

  const d = s.data;
  const dirty = Object.keys(draft).length > 0;
  const value = (i: CountDetail["items"][number]) => (i.ingredientId in draft ? draft[i.ingredientId]! : i.countedQty === null ? "" : String(i.countedQty));
  const rows = useMemo(() => (d?.items ?? []).filter((i) => (!q.trim() || i.name.includes(q.trim())) && (!onlyPending || value(i) === "")), [d, q, onlyPending, draft]); // eslint-disable-line

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function save(): Promise<boolean> {
    const bad = Object.entries(draft).find(([, v]) => v.trim() !== "" && !(num(v) >= 0));
    if (bad) { setErr("كل كمية معدودة رقم صفر أو أكبر، أو اتركها فارغة إن لم تعدّها"); return false; }
    setBusy("save"); setErr(null);
    try {
      await api("PUT", `/t/stocktakes/${stocktakeId}/counts`, { tenant: tenantId, body: { scanned: scanned.current, items: Object.entries(draft).map(([ingredientId, v]) => ({ ingredientId, countedQty: v.trim() === "" ? null : num(v) })) } });
      setDraft({});
      await s.refetch();
      return true;
    } catch (e) { setErr((e as Error).message); return false; } finally { setBusy(null); }
  }
  async function post() {
    if (dirty && !(await save())) return;
    setBusy("post"); setErr(null);
    try {
      const r = await api<{ varianceValue: number; countedItems: number }>("POST", `/t/stocktakes/${stocktakeId}/post`, { tenant: tenantId });
      setConfirm(null);
      toast.success(`تم ترحيل الجرد. قيمة الفرق ${money(r.varianceValue)}`);
      await invalidate("stocktakes", "stock", "ingredients", "reports");
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }
  async function cancel() {
    setBusy("cancel"); setErr(null);
    try { await api("POST", `/t/stocktakes/${stocktakeId}/cancel`, { tenant: tenantId }); setConfirm(null); await invalidate("stocktakes"); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }

  /** One scan adds the code's quantity (× the multiplier) to what is already counted for that item. */
  function onScan(code: string) {
    const b = d?.barcodes.find((x) => x.code === code);
    const item = b && d?.items.find((i) => i.ingredientId === b.ingredientId);
    if (!b || !item) {
      beep(false);
      setUnknown({ code });
      // Known elsewhere? Then it is an item outside this sheet's scope, not an unregistered code.
      api<{ name: string }>("GET", `/t/barcodes/${encodeURIComponent(code)}`, { tenant: tenantId })
        .then((r) => setUnknown((u) => (u?.code === code ? { code, name: r.name } : u)))
        .catch(() => undefined);
      return;
    }
    const k = Math.max(1, Math.round(num(times) || 1));
    const add = b.baseQuantity * k;
    const cur = num(value(item) || "0") || 0;
    const total = Math.round((cur + add) * 10000) / 10000;
    scanned.current = true;
    setUnknown(null);
    setDraft((x) => ({ ...x, [item.ingredientId]: String(total) }));
    setScans((l) => [{ id: performance.now(), ingredientId: item.ingredientId, name: item.name, unit: item.unit, added: add, total, prev: value(item) }, ...l].slice(0, 30));
    setTimes("1");
    beep(true);
  }
  function undoScan() {
    const [lastScan, ...rest] = scans;
    if (!lastScan) return;
    // Back to exactly what was there: an item never counted must stay "not counted", not become a zero count.
    setDraft((x) => ({ ...x, [lastScan.ingredientId]: lastScan.prev }));
    setScans(rest);
  }

  if (s.isPending) return <div className="page"><TableSkeleton columns={3} rows={8} /></div>;
  if (s.isError) return <div className="page"><ErrorState error={s.error} onRetry={() => s.refetch()} /></div>;
  const c = d!;
  const counting = c.status === "counting";
  const canCount = counting && can("stocktakes.count") && writable;
  const canPost = counting && can("stocktakes.post") && writable;
  const countedCount = c.items.filter((i) => value(i) !== "").length;

  return (
    <div className="page">
      <PageHeader eyebrow="الجرد الفعلي" title={<span className="row inv-title"><span>{`ST-${c.number} · ${c.locationName}`}</span><StatusBadge kind="stocktake" value={c.status} />{c.category && <Badge tone="info">فئة: {c.category}</Badge>}{c.scanned && <Badge tone="neutral">بالباركود</Badge>}</span>}
        description={counting ? `قيد العد: ${integer(countedCount)} من ${integer(c.items.length)} مادة. اترك ما لم تعدّه فارغاً.` : c.postedAt ? `رُحّل ${dayTime(c.postedAt)}` : `أُنشئ ${dayTime(c.createdAt)}`}
        actions={<>
          <Link to={`/w/${tenantId}/stocktakes`} className="btn btn-ghost"><ArrowRight aria-hidden="true" />الجرد</Link>
          {canCount && <Button variant="ghost" destructive onClick={() => setConfirm("cancel")}>إلغاء الجرد</Button>}
          {canCount && <Button variant={scanMode ? "secondary" : "ghost"} icon={<ScanBarcode />} aria-pressed={scanMode} onClick={() => setScanMode((m) => !m)}>{scanMode ? "إيقاف الماسح" : "العد بالباركود"}</Button>}
          {canCount && <Button onClick={() => void save()} disabled={!dirty} loading={busy === "save"} loadingText="جارٍ الحفظ…">{dirty ? "حفظ العد" : "العد محفوظ"}</Button>}
          {canPost && <Button variant="primary" onClick={() => { setErr(null); setConfirm("post"); }} disabled={countedCount === 0}>ترحيل الجرد</Button>}
        </>} />
      {counting && !canPost && can("stocktakes.count") && <p className="banner banner-info inv-banner">بعد الانتهاء من العد والحفظ، يرحّله المالك أو المدير أو المحاسب (فصل المهام).</p>}
      <div className="stats">
        <StatCard label="مواد ورقة العد" value={integer(c.items.length)} icon={<Boxes />} hue="sky" />
        <StatCard label="المعدود" value={integer(countedCount)} icon={<ClipboardCheck />} hue="green" />
        {counting
          ? <StatCard label="لم يُعد بعد" value={integer(c.items.length - countedCount)} note="يبقى رصيده كما هو عند الترحيل" icon={<Hourglass />} hue="amber" />
          : c.varianceValue !== null && <StatCard label="قيمة فرق الجرد" value={money(c.varianceValue)} note={c.varianceValue < 0 ? "عجز: مخزون مفقود" : c.varianceValue > 0 ? "زيادة عن النظام" : "مطابق"} noteTone={c.varianceValue < 0 ? "warning" : undefined} icon={<Scale />} hue={c.varianceValue < 0 ? "red" : c.varianceValue > 0 ? "amber" : "indigo"} />}
      </div>
      {err && !confirm && <FormError error={err} />}
      {canCount && scanMode && (
        <section className="panel scan-panel" aria-labelledby="scan-h">
          <div className="card-head"><h2 id="scan-h">العد بالباركود</h2><span className="spacer" /><span className="muted acc-small">{integer(c.barcodes.length)} باركود معروف في هذه الورقة</span></div>
          <div className="card-body stack">
            <div className="scan-row">
              <ScanField onCode={onScan} hint="كل مسحة تضيف كمية الباركود (قطعة أو كرتونة) إلى المعدود. للكرتونات المتعددة اكتب العدد أولاً." />
              <TextField label="العدد × " numeric value={times} onChange={(e) => setTimes(e.target.value)} className="scan-times" />
            </div>
            {unknown && <p className="form-error" role="alert">{unknown.name
              ? <>الباركود <bdi dir="ltr">{unknown.code}</bdi> للمادة «{unknown.name}»، وهي ليست في هذه الورقة{c.category ? ` (نطاقها فئة ${c.category} فقط)` : ""}. اعزلها وعدّها في جرد فئتها.</>
              : <>الباركود <bdi dir="ltr">{unknown.code}</bdi> غير مسجّل لأي مادة. أضفه للمادة من «المواد الخام» ← «باركودات العبوات» ثم أعد المسح، أو أدخل الكمية يدوياً.</>}</p>}
            {scans.length > 0 && (
              <div className="scan-log" aria-live="polite">
                <div className="row"><strong>آخر المسحات</strong><span className="spacer" /><Button size="sm" variant="ghost" onClick={undoScan}>تراجع عن آخر مسحة</Button></div>
                <ul>{scans.slice(0, 6).map((x, n) => <li key={x.id} className={n === 0 ? "is-last" : undefined}><span>{x.name}</span><span className="num">+{quantity(x.added)} {x.unit}</span><span className="muted num">= {quantity(x.total)}</span></li>)}</ul>
              </div>
            )}
            {dirty && <p className="muted acc-small">لا تنسَ «حفظ العد». العد غير المحفوظ يضيع إن أغلقت الصفحة.</p>}
          </div>
        </section>
      )}
      <section className="panel">
        <div className="toolbar">
          <SearchInput placeholder="ابحث بالمادة" value={q} onChange={setQ} />
          {counting && <label className="checkbox"><input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} />غير المعدود فقط</label>}
        </div>
        {rows.length === 0 ? <EmptyState kind="filtered" title="لا توجد مواد مطابقة" /> : (
          <div className="table-wrap">
            <table className="data-table">
              <caption className="sr-only">ورقة العد</caption>
              <thead><tr><th scope="col">المادة</th><th scope="col">الفئة</th><th scope="col">الكمية المعدودة</th>
                {!counting && <><th scope="col" className="end">رصيد النظام</th><th scope="col" className="end">الفرق</th><th scope="col" className="end">قيمة الفرق</th></>}</tr></thead>
              <tbody>
                {rows.map((i) => (
                  <tr key={i.ingredientId}>
                    <td><strong>{i.name}</strong></td>
                    <td>{text(i.category)}</td>
                    <td style={{ minWidth: 170 }}>
                      {canCount ? (
                        <div className="row" style={{ flexWrap: "nowrap" }}>
                          <input className="input num" inputMode="decimal" aria-label={`الكمية المعدودة من ${i.name} بالـ${i.unit}`} value={value(i)} placeholder="لم يُعد"
                            onChange={(e) => setDraft((x) => ({ ...x, [i.ingredientId]: e.target.value }))} />
                          <span className="muted">{i.unit}</span>
                        </div>
                      ) : i.countedQty === null ? <span className="muted">لم يُعد</span> : <span className="num">{quantity(i.countedQty)} {i.unit}</span>}
                    </td>
                    {!counting && <>
                      <td className="end num">{i.countedQty === null ? "—" : `${quantity(i.systemQty)} ${i.unit}`}</td>
                      <td className="end num">{i.variance === undefined || i.countedQty === null ? "—" : i.variance === 0 ? <Badge tone="success">مطابق</Badge> : <Badge tone={i.variance < 0 ? "danger" : "warning"}>{i.variance > 0 ? "+" : ""}{quantity(i.variance)} {i.unit}</Badge>}</td>
                      <td className="end num">{i.countedQty === null ? "—" : money(i.varianceValue)}</td>
                    </>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <ConfirmDialog open={confirm === "post"} onClose={() => setConfirm(null)} destructive={false} busy={busy === "post" || busy === "save"} error={err} onConfirm={() => void post()}
        title={`ترحيل ST-${c.number}`} confirmLabel="ترحيل وتسوية المخزون"
        message={<>سيصبح رصيد {integer(countedCount)} مادة في <strong>{c.locationName}</strong> مساوياً للمعدود، ويُسجَّل الفرق كتسوية جرد بمتوسط التكلفة. المواد غير المعدودة لا تتغير. لا يمكن التراجع.</>} />
      <ConfirmDialog open={confirm === "cancel"} onClose={() => setConfirm(null)} busy={busy === "cancel"} error={err} onConfirm={() => void cancel()}
        title={`إلغاء ST-${c.number}`} confirmLabel="إلغاء الجرد" message="سيُتجاهل العد المُدخل ولن يتغير أي رصيد." />
    </div>
  );
}

// ── Movement ledger ─────────────────────────────────────────────────────────────────────────────
interface MovementRow { id: string; createdAt: string; type: string; quantity: number; unitCost: number; value: number; ingredientId: string; ingredientName: string; unit: string; locationName: string }

export function MovementsPage() {
  const { tenantId } = useTenant();
  const initial = new URLSearchParams(window.location.search).get("ingredientId") ?? "";
  const [ingredient, setIngredient] = useState<{ id: string; name: string } | null>(initial ? { id: initial, name: "" } : null);
  const [loc, setLoc] = useState("");
  const [type, setType] = useState("");
  const [from, setFrom] = useState(addDays(isoDay(), -29));
  const [to, setTo] = useState(isoDay());
  const [page, setPage] = useState(1);
  const prefs = useTablePrefs("stock-movements", { server: true, onSortChange: () => setPage(1) });
  const locations = useLocations(tenantId);
  const list = useQuery({
    queryKey: ["t", tenantId, "stock", "movements", { i: ingredient?.id, loc, type, from, to, page, sort: prefs.sortParam }],
    queryFn: () => api<Page<MovementRow>>("GET", "/t/stock/movements", { tenant: tenantId, query: { ingredientId: ingredient?.id, locationId: loc, type, from, to, page, pageSize: 50, sort: prefs.sortParam } }),
    placeholderData: keepPreviousData,
  });
  const name = ingredient?.name || list.data?.items[0]?.ingredientName || "";
  return (
    <div className="page">
      <PageHeader eyebrow="المخزون" title="حركة المواد" description="كل زيادة أو نقص في المخزون بسببه وتكلفته. السجل للإضافة فقط ولا يُعدَّل." />
      <section className="panel">
        <DataTable caption="حركة المواد" prefs={prefs} query={list} rowKey={(r) => r.id} onPageChange={setPage} filtered={Boolean(ingredient || loc || type)} onClearFilters={() => { setIngredient(null); setLoc(""); setType(""); }}
          toolbar={<>
          <div className="row inv-filters">
            {ingredient ? (
              <span className="badge badge-info inv-filter-chip">المادة: {name}<IconButton size="sm" label="إزالة تصفية المادة" icon={<X />} onClick={() => { setIngredient(null); setPage(1); }} /></span>
            ) : <div className="inv-filter-picker"><IngredientPicker tenantId={tenantId} label="تصفية بمادة" onPick={(i) => { setIngredient({ id: i.id, name: i.name }); setPage(1); }} /></div>}
            <select className="select" aria-label="الموقع" value={loc} onChange={(e) => { setLoc(e.target.value); setPage(1); }}>
              <option value="">كل المواقع</option>{(locations.data?.items ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            <select className="select" aria-label="نوع الحركة" value={type} onChange={(e) => { setType(e.target.value); setPage(1); }}>
              <option value="">كل الأنواع</option>{Object.entries(MOVEMENT_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <DateRange from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); setPage(1); }} />
          </>}
          empty={{ title: "لا توجد حركات في هذه الفترة", body: "الحركات تنشأ من الاستلام والبيع والتحويل والهدر والجرد." }}
          columns={[
            { key: "date", sortKey: "createdAt", header: "الوقت", cell: (r) => dayTime(r.createdAt) },
            { key: "ing", sortKey: "ingredientName", header: "المادة", cell: (r) => <strong>{r.ingredientName}</strong> },
            { key: "loc", sortKey: "locationName", header: "الموقع", cell: (r) => r.locationName },
            { key: "type", sortKey: "type", header: "الحركة", cell: (r) => <Badge tone={r.quantity > 0 ? "success" : "neutral"}>{MOVEMENT_LABELS[r.type] ?? r.type}</Badge> },
            { key: "qty", sortKey: "quantity", header: "الكمية", numeric: true, cell: (r) => <span className={r.quantity < 0 ? "inv-neg" : "inv-pos"}>{r.quantity > 0 ? "+" : ""}{quantity(r.quantity)} {r.unit}</span> },
            { key: "cost", sortKey: "unitCost", header: "تكلفة الوحدة", numeric: true, cell: (r) => cost(r.unitCost) },
            { key: "value", sortKey: "value", header: "القيمة", numeric: true, cell: (r) => money(r.value) },
          ]} />
      </section>
    </div>
  );
}

// ── Reports ─────────────────────────────────────────────────────────────────────────────────────
export function WasteAnalysisReport() {
  const { tenantId } = useTenant();
  const [from, setFrom] = useState(addDays(isoDay(), -29));
  const [to, setTo] = useState(isoDay());
  const r = useQuery({ queryKey: ["t", tenantId, "reports", "waste", from, to], placeholderData: keepPreviousData,
    queryFn: () => api<{ total: number; byReason: { reason: string; records: number; value: number }[]; byIngredient: { ingredientId: string; name: string; unit: string; quantity: number; value: number }[] }>("GET", "/t/reports/waste-analysis", { tenant: tenantId, query: { from, to } }) });
  return (
    <div className="page">
      <PageHeader eyebrow="التقارير" title="تحليل الهدر" description={`أين يذهب المال المهدر، من ${day(from)} إلى ${day(to)}.`} />
      <div className="toolbar panel"><DateRange from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} /></div>
      {r.data && <div className="stats">
        <StatCard label="إجمالي تكلفة الهدر" value={money(r.data.total)} note={r.data.byReason[0] ? `أكبر سبب: ${WASTE_REASON_LABELS[r.data.byReason[0].reason]}` : "لا يوجد هدر مسجل"} icon={<Trash2 />} hue="red" />
        <StatCard label="سجلات الهدر" value={integer(r.data.byReason.reduce((a, x) => a + x.records, 0))} icon={<ClipboardList />} hue="amber" />
        <StatCard label="أعلى مادة هدراً" value={r.data.byIngredient[0] ? money(r.data.byIngredient[0].value) : "—"} note={r.data.byIngredient[0]?.name ?? "لا يوجد هدر مسجل"} icon={<Package />} hue="sky" />
      </div>}
      <div className="inv-split">
        <section className="panel">
          <DataTable caption="الهدر حسب السبب" toolbar={<h2>حسب السبب</h2>} query={{ ...r, data: r.data ? { items: r.data.byReason } : undefined }} rowKey={(x) => x.reason} empty={{ title: "لا يوجد هدر في الفترة", body: "" }}
            columns={[{ key: "r", sortKey: "reason", header: "السبب", cell: (x) => <strong>{WASTE_REASON_LABELS[x.reason]}</strong> }, { key: "n", sortKey: "records", header: "السجلات", numeric: true, cell: (x) => integer(x.records) }, { key: "v", sortKey: "value", header: "التكلفة", numeric: true, cell: (x) => money(x.value) }]} />
        </section>
        <section className="panel">
          <DataTable caption="الهدر حسب المادة" toolbar={<h2>أعلى المواد هدراً</h2>} query={{ ...r, data: r.data ? { items: r.data.byIngredient } : undefined }} rowKey={(x) => x.ingredientId} empty={{ title: "لا يوجد هدر في الفترة", body: "" }}
            columns={[{ key: "n", sortKey: "name", header: "المادة", cell: (x) => <Link to={`/w/${tenantId}/movements?ingredientId=${x.ingredientId}`}><strong>{x.name}</strong></Link> }, { key: "q", sortKey: "quantity", header: "الكمية", numeric: true, cell: (x) => `${quantity(x.quantity)} ${x.unit}` }, { key: "v", sortKey: "value", header: "التكلفة", numeric: true, cell: (x) => money(x.value) }]} />
        </section>
      </div>
    </div>
  );
}

export function StockVarianceReport() {
  const { tenantId } = useTenant();
  const [from, setFrom] = useState(addDays(isoDay(), -89));
  const [to, setTo] = useState(isoDay());
  const r = useQuery({ queryKey: ["t", tenantId, "reports", "variance", from, to], placeholderData: keepPreviousData,
    queryFn: () => api<{ total: number; items: { ingredientId: string; name: string; unit: string; counts: number; variance: number; varianceValue: number }[] }>("GET", "/t/reports/stock-variance", { tenant: tenantId, query: { from, to } }) });
  return (
    <div className="page">
      <PageHeader eyebrow="التقارير" title="انحرافات الجرد" description="الفرق بين المعدود ورصيد النظام في الجرد المُرحَّل. العجز المتكرر في مادة يعني فاقداً غير مسجل." />
      <div className="toolbar panel"><DateRange from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} /></div>
      {r.data && <div className="stats">
        <StatCard label="صافي قيمة الانحراف" value={money(r.data.total)} note={r.data.total < 0 ? "عجز إجمالي" : r.data.total > 0 ? "زيادة إجمالية" : "لا انحرافات"} noteTone={r.data.total < 0 ? "warning" : undefined} icon={<Scale />} hue={r.data.total < 0 ? "red" : "green"} />
        <StatCard label="مواد بها انحراف" value={integer(r.data.items.length)} note={r.data.items.length >= 100 ? "أعلى 100 مادة انحرافاً فقط" : undefined} icon={<ListChecks />} hue="sky" />
        <StatCard label="مواد بها عجز" value={integer(r.data.items.filter((x) => x.varianceValue < 0).length)} icon={<TriangleAlert />} hue="amber" />
      </div>}
      <section className="panel">
        <DataTable caption="انحرافات الجرد" query={{ ...r, data: r.data ? { items: r.data.items } : undefined }} rowKey={(x) => x.ingredientId}
          empty={{ title: "لا توجد انحرافات", body: "إما أن كل الجرد مطابق، أو لم يُرحَّل جرد في هذه الفترة." }}
          columns={[
            { key: "n", sortKey: "name", header: "المادة", cell: (x) => <Link to={`/w/${tenantId}/movements?ingredientId=${x.ingredientId}`}><strong>{x.name}</strong></Link> },
            { key: "c", sortKey: "counts", header: "مرات الجرد", numeric: true, cell: (x) => integer(x.counts) },
            { key: "q", sortKey: "variance", header: "الفرق", numeric: true, cell: (x) => `${x.variance > 0 ? "+" : ""}${quantity(x.variance)} ${x.unit}` },
            { key: "v", sortKey: "varianceValue", header: "القيمة", numeric: true, cell: (x) => <span className={x.varianceValue < 0 ? "inv-neg" : undefined}>{money(x.varianceValue)}</span> },
          ]} />
      </section>
    </div>
  );
}
