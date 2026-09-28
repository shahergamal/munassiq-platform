import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { AlarmClock, ArrowRight, CalendarX2, PackageOpen, Printer, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, type Page } from "../../api/client";
import { useIdempotencyKey } from "../../app/session";
import { useInvalidate, useTenant } from "../../app/tenant";
import { day, dayTime, integer, isoDay, money, quantity } from "../../lib/format";
import { Button } from "../../ui/Button";
import { DataTable } from "../../ui/DataTable";
import { Dialog } from "../../ui/Dialog";
import { SearchInput, SelectField, TextField } from "../../ui/Field";
import { Badge, PageHeader, StatCard } from "../../ui/Layout";
import { EmptyState, ErrorState, FormError, TableSkeleton } from "../../ui/States";
import { useToast } from "../../ui/Toast";
import { StatusTabs, useLocations } from "./Inventory";

interface BatchRow {
  id: string; batchNo: string; expiryDate: string | null; productionDate: string | null; daysLeft: number | null; quantity: number; remaining: number; value: number;
  sourceType: "goods_receipt" | "transfer" | "production" | "opening"; sourceId: string | null; receivedAt: string;
  ingredientId: string; ingredientName: string; sku: string; unit: string; locationId: string; locationName: string; supplierName: string | null;
}
interface Summary {
  today: string; days: number; expired: { count: number; value: number }; expiring: { count: number; value: number };
  unbatched: { ingredientId: string; name: string; unit: string; locationId: string; locationName: string; quantity: number }[];
}

const SOURCE_LABEL: Record<BatchRow["sourceType"], string> = { goods_receipt: "استلام", transfer: "تحويل", production: "تحضير", opening: "رصيد مسجّل" };

/** Arabic counting: يوم واحد، يومان، 3–10 أيام، 11+ يوماً. */
const daysAr = (n: number) => (n === 1 ? "يوم واحد" : n === 2 ? "يومان" : n <= 10 ? `${integer(n)} أيام` : `${integer(n)} يوماً`);

/** How soon a batch expires, as a colour the eye finds first. */
export function ExpiryBadge({ daysLeft, expiryDate }: { daysLeft: number | null; expiryDate: string | null }) {
  if (expiryDate === null || daysLeft === null) return <span className="muted">بلا تاريخ</span>;
  if (daysLeft < 0) return <Badge tone="danger">منتهية منذ {daysAr(-daysLeft)}</Badge>;
  if (daysLeft === 0) return <Badge tone="danger">تنتهي اليوم</Badge>;
  if (daysLeft <= 3) return <Badge tone="warning">باقٍ {daysAr(daysLeft)}</Badge>;
  if (daysLeft <= 7) return <Badge tone="info">باقٍ {daysAr(daysLeft)}</Badge>;
  return <span className="muted num">باقٍ {daysAr(daysLeft)}</span>;
}

function sourceLink(tenantId: string, r: { sourceType: BatchRow["sourceType"]; sourceId: string | null }, label: string) {
  if (r.sourceType === "goods_receipt" && r.sourceId) return <Link to={`/w/${tenantId}/goods-receipts/${r.sourceId}`}>{label}</Link>;
  if (r.sourceType === "transfer" && r.sourceId) return <Link to={`/w/${tenantId}/transfers/${r.sourceId}`}>{label}</Link>;
  return <span>{label}</span>;
}

/**
 * Expiry and batches: what has expired (dispose of it, it is costing a write-off either way), what expires soon
 * (use it first, run it as a special), and tracked items holding stock with no date yet (register it).
 */
export function BatchesPage() {
  const { tenantId, can, writable } = useTenant();
  const navigate = useNavigate();
  const locations = useLocations(tenantId);
  const [status, setStatus] = useState("expiring");
  const [days, setDays] = useState("7");
  const [loc, setLoc] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [disposing, setDisposing] = useState<BatchRow | null>(null);
  const [registering, setRegistering] = useState<Summary["unbatched"][number] | null>(null);
  const summary = useQuery({ queryKey: ["t", tenantId, "stock", "batches", "summary", { days, loc }],
    queryFn: () => api<Summary>("GET", "/t/stock/batches/summary", { tenant: tenantId, query: { days, locationId: loc || undefined } }) });
  const list = useQuery({ queryKey: ["t", tenantId, "stock", "batches", { status, days, loc, q, page }], placeholderData: keepPreviousData,
    queryFn: () => api<Page<BatchRow>>("GET", "/t/stock/batches", { tenant: tenantId, query: { status, days, locationId: loc || undefined, q: q || undefined, page, pageSize: 25 } }) });
  const canDispose = can("waste.create") && writable;
  const canRegister = can("batches.create") && writable;
  const s = summary.data;

  return (
    <div className="page">
      <PageHeader eyebrow="المخزون" title="الصلاحية والدفعات" description="كل كمية دخلت بتاريخ انتهاء ورقم تشغيلة. البيع والتحويل والهدر تصرف الأقرب انتهاءً أولاً (FEFO) تلقائياً."
        actions={<Button icon={<Printer />} onClick={() => window.print()}>طباعة القائمة</Button>} />
      {summary.isError ? <section className="panel"><ErrorState error={summary.error} onRetry={() => summary.refetch()} title="تعذّر تحميل ملخص الصلاحية" /></section> : (
        <div className="stats" aria-label="ملخص الصلاحية">
          <StatCard label="منتهية الصلاحية" value={s ? money(s.expired.value) : "…"} icon={<CalendarX2 />} hue="red"
            note={s ? (s.expired.count ? `${integer(s.expired.count)} دفعة: أتلفها وسجّلها هدراً` : "لا شيء منتهٍ") : undefined} noteTone={s?.expired.count ? "warning" : undefined} />
          <StatCard label={`تنتهي خلال ${daysAr(Number(days))}`} value={s ? money(s.expiring.value) : "…"} icon={<AlarmClock />} hue="amber"
            note={s ? (s.expiring.count ? `${integer(s.expiring.count)} دفعة: اصرفها أولاً أو اعرضها عرضاً خاصاً` : "لا شيء قريب") : undefined} />
          <StatCard label="رصيد بلا تاريخ لمواد متتبَّعة" value={s ? integer(s.unbatched.length) : "…"} icon={<PackageOpen />} hue="violet"
            note={s?.unbatched.length ? "سجّل تاريخ انتهائه من القائمة أدناه" : "كل المواد المتتبَّعة مؤرّخة"} />
        </div>
      )}
      <section className="panel">
        <DataTable caption="الدفعات" tableId="stock-batches" query={list} rowKey={(r) => r.id} onPageChange={setPage}
          onRowClick={(r) => navigate({ to: `/w/${tenantId}/batches/${r.id}` })}
          filtered={Boolean(q || loc)} onClearFilters={() => { setQ(""); setLoc(""); setPage(1); }}
          toolbar={<>
            <StatusTabs value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={[["expired", "منتهية"], ["expiring", "تنتهي قريباً"], ["ok", "سليمة"], ["all", "الكل"], ["empty", "مستهلكة"]]} />
            <label className="row"><span className="field-label">خلال</span>
              <select className="select" aria-label="نافذة «تنتهي قريباً»" value={days} onChange={(e) => { setDays(e.target.value); setPage(1); }}>
                {["3", "7", "14", "30"].map((d) => <option key={d} value={d}>{d} أيام</option>)}
              </select></label>
            {(locations.data?.items.length ?? 0) > 1 && <select className="select" aria-label="الموقع" value={loc} onChange={(e) => { setLoc(e.target.value); setPage(1); }}>
              <option value="">كل المواقع</option>{locations.data!.items.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>}
            <SearchInput placeholder="المادة أو رقم التشغيلة" value={q} onChange={(v) => { setQ(v); setPage(1); }} />
          </>}
          empty={{ title: status === "expired" ? "لا يوجد مخزون منتهي الصلاحية" : status === "expiring" ? `لا شيء ينتهي خلال ${daysAr(Number(days))}` : status === "empty" ? "لا دفعات مستهلكة بالكامل" : "لا توجد دفعات بعد",
            body: status === "expired" || status === "expiring" ? "جيد. راجع «الكل» لترى كل الدفعات وتواريخها." : "تُنشأ الدفعات عند استلام مادة مفعّل لها «تتبع الصلاحية» في بطاقة المادة، أو عند تسجيل تاريخ لرصيد موجود." }}
          actions={canDispose ? (r) => r.remaining > 0 && (r.daysLeft ?? 99) <= 7 ? <Button size="sm" variant="ghost" destructive icon={<Trash2 />} onClick={() => setDisposing(r)} aria-label={`إتلاف دفعة ${r.batchNo} من ${r.ingredientName}`}>إتلاف</Button> : null : undefined}
          columns={[
            { key: "i", header: "المادة", sortKey: "ingredientName", cell: (r) => <div><strong>{r.ingredientName}</strong><div className="muted acc-small">تشغيلة <bdi dir="ltr">{r.batchNo}</bdi></div></div> },
            { key: "l", header: "الموقع", sortKey: "locationName", cell: (r) => r.locationName },
            { key: "e", header: "تاريخ الانتهاء", sortKey: "expiryDate", cell: (r) => <div>{r.expiryDate ? day(r.expiryDate) : "—"}<div><ExpiryBadge daysLeft={r.daysLeft} expiryDate={r.expiryDate} /></div></div> },
            { key: "r", header: "المتبقي", numeric: true, sortKey: "remaining", cell: (r) => <>{quantity(r.remaining)} <span className="muted">{r.unit}</span></> },
            { key: "v", header: "القيمة", numeric: true, sortKey: "value", cell: (r) => money(r.value) },
            { key: "s", header: "المصدر", sortKey: false, cell: (r) => <div>{sourceLink(tenantId, r, SOURCE_LABEL[r.sourceType])}{r.supplierName && <div className="muted acc-small">{r.supplierName}</div>}</div> },
          ]} />
      </section>
      {s && s.unbatched.length > 0 && (
        <section className="panel" aria-labelledby="unbatched-h">
          <div className="card-head"><h2 id="unbatched-h">رصيد بلا تاريخ انتهاء</h2><span className="muted acc-small">مواد متتبَّعة عندها كمية دخلت قبل التتبع أو بزيادة جرد</span></div>
          <ul className="batch-unbatched">
            {s.unbatched.map((u) => (
              <li key={`${u.ingredientId}-${u.locationId}`}>
                <span><strong>{u.name}</strong> <span className="muted">· {u.locationName}</span></span>
                <span className="num">{quantity(u.quantity)} {u.unit}</span>
                {canRegister && <Button size="sm" onClick={() => setRegistering(u)}>تسجيل تاريخ الانتهاء</Button>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {disposing && <DisposeDialog tenantId={tenantId} batch={disposing} onClose={() => setDisposing(null)} />}
      {registering && <RegisterDialog tenantId={tenantId} item={registering} onClose={() => setRegistering(null)} />}
    </div>
  );
}

/** An expired or damaged lot leaves stock as waste (priced at average cost, posted to the ledger), naming the lot. */
function DisposeDialog({ tenantId, batch, onClose }: { tenantId: string; batch: Pick<BatchRow, "id" | "batchNo" | "ingredientId" | "ingredientName" | "locationId" | "remaining" | "unit" | "daysLeft">; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [key] = useIdempotencyKey();
  const [qty, setQty] = useState(String(batch.remaining));
  const [reason, setReason] = useState((batch.daysLeft ?? 0) < 0 ? "expired" : "spoiled");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit() {
    const n = Number(qty);
    if (!(n > 0 && n <= batch.remaining)) return setError(`الكمية بين 0 و${quantity(batch.remaining)}`);
    setBusy(true); setError(null);
    try {
      const r = await api<{ totalCost: number }>("POST", "/t/waste", { tenant: tenantId, idempotencyKey: key, body: {
        locationId: batch.locationId, reason, notes: notes.trim() || `إتلاف التشغيلة ${batch.batchNo}`, items: [{ ingredientId: batch.ingredientId, quantity: n, batchId: batch.id }] } });
      toast.success(`سُجّل الإتلاف هدراً بقيمة ${money(r.totalCost)}`);
      await invalidate("stock", "waste", "ingredients", "reports");
      onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} title={`إتلاف تشغيلة ${batch.batchNo}`} onSubmit={() => void submit()}
      footer={<><Button onClick={onClose} disabled={busy} autoFocus>إلغاء</Button><Button type="submit" variant="danger" loading={busy} loadingText="جارٍ التسجيل…">تسجيل الإتلاف</Button></>}>
      <p>تخرج الكمية من المخزون وتُسجَّل هدراً بمتوسط التكلفة، ويُرحَّل القيد المحاسبي. لا يمكن التراجع إلا بتسوية جرد.</p>
      <div className="form-grid">
        <TextField label={`الكمية (${batch.unit})`} required numeric value={qty} onChange={(e) => setQty(e.target.value)} hint={`المتبقي في التشغيلة ${quantity(batch.remaining)} ${batch.unit}`} />
        <SelectField label="السبب" value={reason} onChange={(e) => setReason(e.target.value)} options={[{ value: "expired", label: "منتهي الصلاحية" }, { value: "spoiled", label: "تالف / فاسد" }, { value: "damaged", label: "عبوة تالفة" }, { value: "other", label: "أخرى" }]} />
      </div>
      <TextField label="ملاحظة" optional={reason !== "other"} required={reason === "other"} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={`إتلاف التشغيلة ${batch.batchNo}`} />
      <FormError error={error} />
    </Dialog>
  );
}

function RegisterDialog({ tenantId, item, onClose }: { tenantId: string; item: Summary["unbatched"][number]; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [v, setV] = useState({ batchNo: "", expiry: "", production: "", qty: String(item.quantity) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit() {
    if (!v.batchNo.trim()) return setError("أدخل رقم التشغيلة (من الملصق، أو أي رمز تعرفه به)");
    if (!v.expiry) return setError("أدخل تاريخ الانتهاء");
    setBusy(true); setError(null);
    try {
      await api("POST", "/t/stock/batches", { tenant: tenantId, body: { locationId: item.locationId, ingredientId: item.ingredientId, batchNo: v.batchNo.trim(), expiryDate: v.expiry, productionDate: v.production || null, quantity: Number(v.qty) } });
      toast.success(`سُجّلت التشغيلة ${v.batchNo.trim()}`);
      await invalidate("stock");
      onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} title={`تاريخ انتهاء ${item.name} · ${item.locationName}`} onSubmit={() => void submit()}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">تسجيل الدفعة</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <p className="muted">إن كان الرصيد من أكثر من تاريخ، سجّل كل تاريخ بكميته على حدة.</p>
      <div className="form-grid">
        <TextField label="رقم التشغيلة" required dir="ltr" value={v.batchNo} onChange={(e) => setV({ ...v, batchNo: e.target.value })} autoFocus />
        <TextField label="تاريخ الانتهاء" required type="date" min={isoDay()} value={v.expiry} onChange={(e) => setV({ ...v, expiry: e.target.value })} />
        <TextField label="تاريخ الإنتاج" optional type="date" max={isoDay()} value={v.production} onChange={(e) => setV({ ...v, production: e.target.value })} />
        <TextField label={`الكمية (${item.unit})`} required numeric value={v.qty} onChange={(e) => setV({ ...v, qty: e.target.value })} hint={`الرصيد بلا تاريخ ${quantity(item.quantity)} ${item.unit}`} />
      </div>
      <FormError error={error} />
    </Dialog>
  );
}

interface BatchDetail extends BatchRow {
  unitCost: number; parentBatchId: string | null; parentLocationName: string | null; sourceRef: string | null;
  consumptions: { quantity: number; reason: "fefo" | "targeted"; createdAt: string }[];
  children: { id: string; quantity: number; remaining: number; locationName: string; receivedAt: string }[];
}

/** One batch, traced for a recall: where it came from, where it went, how it was used. */
export function BatchDetailPage() {
  const { tenantId, can, writable } = useTenant();
  const { batchId } = useParams({ strict: false }) as { batchId: string };
  const b = useQuery({ queryKey: ["t", tenantId, "stock", "batches", batchId], queryFn: () => api<BatchDetail>("GET", `/t/stock/batches/${batchId}`, { tenant: tenantId }) });
  const [disposing, setDisposing] = useState(false);
  if (b.isPending) return <div className="page"><TableSkeleton columns={3} rows={5} /></div>;
  if (b.isError) return <div className="page"><ErrorState error={b.error} onRetry={() => b.refetch()} /></div>;
  const d = b.data;
  const used = d.quantity - d.remaining;
  return (
    <div className="page">
      <PageHeader eyebrow="الصلاحية والدفعات" title={<span className="row"><span>{d.ingredientName} · <bdi dir="ltr">{d.batchNo}</bdi></span><ExpiryBadge daysLeft={d.daysLeft} expiryDate={d.expiryDate} /></span>}
        description={`${d.locationName} · دخلت ${dayTime(d.receivedAt)}`}
        actions={<>
          <Link to={`/w/${tenantId}/batches`} className="btn btn-ghost"><ArrowRight aria-hidden="true" />كل الدفعات</Link>
          <Button icon={<Printer />} onClick={() => window.print()}>طباعة</Button>
          {can("waste.create") && writable && d.remaining > 0 && <Button variant="ghost" destructive icon={<Trash2 />} onClick={() => setDisposing(true)}>إتلاف</Button>}
        </>} />
      <div className="stats">
        <StatCard label="الكمية الأصلية" value={<>{quantity(d.quantity)} <span className="muted">{d.unit}</span></>} icon={<PackageOpen />} hue="indigo" />
        <StatCard label="المتبقي" value={<>{quantity(d.remaining)} <span className="muted">{d.unit}</span></>} note={money(d.value)} icon={<AlarmClock />} hue="amber" />
        <StatCard label="تاريخ الانتهاء" value={d.expiryDate ? day(d.expiryDate) : "—"} note={d.productionDate ? `الإنتاج ${day(d.productionDate)}` : undefined} icon={<CalendarX2 />} hue="red" />
      </div>
      <section className="panel print-area" aria-labelledby="trace-h">
        <div className="card-head"><h2 id="trace-h">التتبع</h2></div>
        <div className="card-body stack-lg">
          <dl className="dl">
            <dt>المصدر</dt><dd>{sourceLink(tenantId, d, `${SOURCE_LABEL[d.sourceType]}${d.sourceRef ? ` ${d.sourceRef}` : ""}`)}</dd>
            {d.supplierName && <><dt>المورد</dt><dd>{d.supplierName}</dd></>}
            {d.parentBatchId && <><dt>منقولة من</dt><dd><Link to={`/w/${tenantId}/batches/${d.parentBatchId}`}>{d.parentLocationName ?? "الدفعة الأصل"}</Link></dd></>}
            <dt>المستهلك</dt><dd className="num">{quantity(used)} {d.unit}</dd>
          </dl>
          {d.children.length > 0 && (
            <div className="stack"><h3>انتقلت إلى</h3>
              <ul className="batch-unbatched">{d.children.map((c) => <li key={c.id}><Link to={`/w/${tenantId}/batches/${c.id}`}>{c.locationName}</Link><span className="num">{quantity(c.quantity)} {d.unit}</span><span className="muted">{dayTime(c.receivedAt)}</span></li>)}</ul>
            </div>
          )}
          {d.consumptions.length === 0 ? <EmptyState title="لم يُصرف شيء من هذه الدفعة بعد" /> : (
            <div className="stack"><h3>الصرف</h3>
              <ul className="batch-unbatched">{d.consumptions.map((c, i) => <li key={i}><span className="num">{dayTime(c.createdAt)}</span><span className="num">{quantity(c.quantity)} {d.unit}</span><span className="muted">{c.reason === "targeted" ? "إتلاف لهذه الدفعة" : "صرف تلقائي (الأقرب انتهاءً)"}</span></li>)}</ul>
            </div>
          )}
        </div>
      </section>
      {disposing && <DisposeDialog tenantId={tenantId} batch={d} onClose={() => { setDisposing(false); void b.refetch(); }} />}
    </div>
  );
}
