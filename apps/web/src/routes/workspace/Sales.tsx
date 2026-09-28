import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { AlertTriangle, ArrowRight, Banknote, Boxes, Receipt, RotateCcw, TrendingUp, Warehouse } from "lucide-react";
import { Fragment, useState } from "react";
import { api, type Page } from "../../api/client";
import { useIdempotencyKey } from "../../app/session";
import { useInvalidate, useTenant } from "../../app/tenant";
import { RIYAL, addDays, day, dayTime, integer, isoDay, money, percent } from "../../lib/format";
import { Button } from "../../ui/Button";
import { DataTable } from "../../ui/DataTable";
import { useTablePrefs } from "../../ui/tablePrefs";
import { Dialog } from "../../ui/Dialog";
import { DateRange } from "../../ui/DateRange";
import { Checkbox, SelectField, TextField } from "../../ui/Field";
import { Badge, PageHeader, StatCard, StatusBadge, type Hue } from "../../ui/Layout";
import { ErrorState, FormError, TableSkeleton } from "../../ui/States";
import { CHANNEL_LABELS, METHOD_LABELS } from "../../ui/status";
import { useToast } from "../../ui/Toast";

/** Same mapping as the dashboard: one solid hue per sales channel, violet for a named delivery app. */
const CHANNEL_HUE: Record<string, Hue> = { dine_in: "indigo", takeaway: "green", delivery: "orange" };
function ChannelTag({ channel, platformName }: { channel: string; platformName?: string | null }) {
  const hue = platformName ? "violet" : CHANNEL_HUE[channel] ?? "indigo";
  return <span className={`tag tag-${hue}`}>{platformName ?? CHANNEL_LABELS[channel] ?? channel}</span>;
}
const initials = (name: string) => name.trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join("");
/** Stable avatar hue per person (same cycle as the dashboard), so a cashier keeps one colour across rows and pages. */
const AVATAR_CYCLE: Hue[] = ["indigo", "sky", "green", "orange", "violet", "amber"];
const avatarHue = (name: string): Hue => AVATAR_CYCLE[[...name].reduce((a, c) => a + (c.codePointAt(0) ?? 0), 0) % AVATAR_CYCLE.length] ?? "indigo";

interface ShiftRow { id: string; status: string; openedAt: string; closedAt: string | null; locationName: string; openedByName: string | null; isMine: boolean; openingFloat: number; expectedCash: number | null; countedCash: number | null; overShort: number | null; ordersCount: number; salesTotal: number }

export function ShiftsPage() {
  const { tenantId } = useTenant();
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const prefs = useTablePrefs("shifts", { server: true, onSortChange: () => setPage(1) });
  const list = useQuery({
    queryKey: ["t", tenantId, "shifts", { status, page, sort: prefs.sortParam }],
    queryFn: () => api<Page<ShiftRow>>("GET", "/t/pos/shifts", { tenant: tenantId, query: { status, page, pageSize: 25, sort: prefs.sortParam } }),
    placeholderData: keepPreviousData,
  });
  return (
    <div className="page sr-shifts">
      <PageHeader eyebrow="المبيعات" title="الشفتات" description="كل شفت بعهدته ومبيعاته. النقد المتوقع والعجز يظهران بعد الإغلاق فقط، حتى يبقى عدّ الكاشير مستقلاً." />
      <section className="panel">
        <DataTable caption="الشفتات" prefs={prefs} query={list} rowKey={(r) => r.id} onPageChange={setPage} filtered={Boolean(status)} onClearFilters={() => setStatus("")}
          toolbar={
            <div role="group" aria-label="تصفية حسب الحالة" className="row sr-filter-group">
              {([["", "الكل"], ["open", "المفتوحة"], ["closed", "المغلقة"]] as const).map(([v, l]) => <button key={v} type="button" className={`btn btn-sm ${status === v ? "btn-secondary" : "btn-ghost"}`} aria-pressed={status === v} onClick={() => { setStatus(v); setPage(1); }}>{l}</button>)}
            </div>
          }
          empty={{ title: "لم يُفتح أي شفت بعد", body: "الشفت يُفتح من شاشة الكاشير قبل أول بيع.", action: <Link to={`/w/${tenantId}/pos`} className="btn btn-primary">فتح شاشة الكاشير</Link> }}
          columns={[
            { key: "who", header: "الكاشير", cell: (r) => <span className="sr-person-cell"><span className={`avatar tone-${avatarHue(r.openedByName ?? "")}`} aria-hidden="true">{initials(r.openedByName ?? "؟")}</span><strong>{r.openedByName ?? "—"}{r.isMine && <span className="muted"> (أنت)</span>}</strong></span> },
            { key: "loc", sortKey: "locationName", header: "الموقع", cell: (r) => r.locationName },
            { key: "open", sortKey: "openedAt", header: "الفتح", cell: (r) => dayTime(r.openedAt) },
            { key: "close", sortKey: "closedAt", header: "الإغلاق", cell: (r) => dayTime(r.closedAt) },
            { key: "orders", sortKey: "ordersCount", header: "الطلبات", numeric: true, cell: (r) => integer(r.ordersCount) },
            { key: "sales", sortKey: "salesTotal", header: "المبيعات", numeric: true, cell: (r) => money(r.salesTotal) },
            { key: "exp", sortKey: "expectedCash", header: "النقد المتوقع", numeric: true, cell: (r) => money(r.expectedCash) },
            { key: "os", sortKey: "overShort", header: "عجز / زيادة", numeric: true, cell: (r) => r.overShort === null ? "—" : r.overShort === 0 ? <Badge tone="success">مطابق</Badge> : <Badge tone={r.overShort < 0 ? "danger" : "warning"}>{r.overShort < 0 ? "عجز" : "زيادة"} {money(Math.abs(r.overShort))}</Badge> },
            { key: "status", sortKey: "status", header: "الحالة", cell: (r) => <StatusBadge kind="shift" value={r.status} /> },
          ]} />
      </section>
    </div>
  );
}

interface OrderRow { id: string; number: number; channel: string; status: string; total: number; vat: number; createdAt: string; locationName: string; platformName?: string | null }

export function OrdersPage() {
  const { tenantId } = useTenant();
  const navigate = useNavigate();
  const [from, setFrom] = useState(addDays(isoDay(), -6));
  const [to, setTo] = useState(isoDay());
  const [page, setPage] = useState(1);
  const prefs = useTablePrefs("pos-orders", { server: true, onSortChange: () => setPage(1) });
  const list = useQuery({
    queryKey: ["t", tenantId, "pos", "orders", { from, to, page, sort: prefs.sortParam }],
    queryFn: () => api<Page<OrderRow>>("GET", "/t/pos/orders", { tenant: tenantId, query: { from, to, page, pageSize: 25, sort: prefs.sortParam } }),
    placeholderData: keepPreviousData,
  });
  return (
    <div className="page">
      <PageHeader eyebrow="المبيعات" title="الطلبات والمرتجعات" description="افتح الطلب لعرض فاتورته أو لتسجيل استرجاع." />
      <section className="panel">
        <DataTable caption="الطلبات" prefs={prefs} query={list} rowKey={(r) => r.id} onPageChange={setPage}
          toolbar={<DateRange from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); setPage(1); }} />}
          onRowClick={(r) => navigate({ to: `/w/${tenantId}/orders/${r.id}` })}
          empty={{ title: "لا توجد طلبات في هذه الفترة", body: "غيّر الفترة أو ابدأ البيع من شاشة الكاشير." }}
          columns={[
            { key: "n", sortKey: "number", header: "رقم الطلب", cell: (r) => <Link to={`/w/${tenantId}/orders/${r.id}`}><strong className="num">{r.number}</strong></Link> },
            { key: "date", sortKey: "createdAt", header: "الوقت", cell: (r) => dayTime(r.createdAt) },
            { key: "ch", sortKey: "channel", header: "النوع", cell: (r) => <ChannelTag channel={r.channel} platformName={r.platformName} /> },
            { key: "loc", sortKey: "locationName", header: "الموقع", cell: (r) => r.locationName },
            { key: "vat", sortKey: "vat", header: "الضريبة", numeric: true, cell: (r) => money(r.vat) },
            { key: "total", sortKey: "total", header: "الإجمالي", numeric: true, cell: (r) => money(r.total) },
            { key: "status", sortKey: "status", header: "الحالة", cell: (r) => <StatusBadge kind="order" value={r.status} /> },
          ]} />
      </section>
    </div>
  );
}

interface OrderDetail {
  id: string; number: number; channel: string; status: string; subtotal: number; discount: number; vat: number; total: number; customerName: string | null; createdAt: string; locationId: string;
  guests: number | null; externalRef: string | null; commission: number; tableName: string | null; customerFullName: string | null; customerPhone: string | null; platformName: string | null;
  items: { name: string; quantity: number; unitPriceNet: number; lineTotal: number; modifiers: string[] }[];
  payments: { method: string; amount: number }[];
  refunds: { amount: number; method: string; reason: string; createdAt: string }[];
  invoices: { kind: string; icv: number; qr: string; issuedAt: string }[];
}

export function OrderDetailPage() {
  const { tenantId, can, writable } = useTenant();
  const { orderId } = useParams({ strict: false }) as { orderId: string };
  const invalidate = useInvalidate(tenantId);
  const [refunding, setRefunding] = useState(false);
  const order = useQuery({ queryKey: ["t", tenantId, "pos", "orders", orderId], queryFn: () => api<OrderDetail>("GET", `/t/pos/orders/${orderId}`, { tenant: tenantId }) });
  if (order.isPending) return <div className="page"><TableSkeleton columns={4} rows={4} /></div>;
  if (order.isError) return <div className="page"><ErrorState error={order.error} onRetry={() => order.refetch()} /></div>;
  const o = order.data;
  const refunded = o.refunds.reduce((a, r) => a + Math.round(r.amount * 100), 0) / 100;
  const remaining = Math.round((o.total - refunded) * 100) / 100;
  const canRefund = can("orders.refund") && writable && o.status !== "refunded";
  return (
    <div className="page sr-order-detail">
      <PageHeader eyebrow="الطلبات" title={<span className="row">طلب رقم <span className="num">{o.number}</span><StatusBadge kind="order" value={o.status} /></span>} description={dayTime(o.createdAt)}
        actions={<>
          <Link to={`/w/${tenantId}/orders`} className="btn btn-ghost"><ArrowRight aria-hidden="true" />الطلبات</Link>
          {canRefund && <Button variant="secondary" onClick={() => setRefunding(true)}>تسجيل استرجاع</Button>}
        </>} />
      <div className="dash-grid">
        <section className="panel" aria-labelledby="order-items-h">
          <div className="toolbar">
            <h2 id="order-items-h">أصناف الطلب</h2>
            <span className="spacer" />
            <span className="muted"><span className="num">{integer(o.items.length)}</span> صنف</span>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <caption className="sr-only">أصناف الطلب</caption>
              <thead><tr><th scope="col">الصنف</th><th scope="col" className="end">الكمية</th><th scope="col" className="end">سعر الوحدة قبل الضريبة</th><th scope="col" className="end">الإجمالي</th></tr></thead>
              <tbody>{o.items.map((i, n) => <tr key={n}><td><strong>{i.name}</strong>{i.modifiers.length > 0 && <div className="muted" style={{ fontSize: "var(--fs-xs)" }}>{i.modifiers.join("، ")}</div>}</td><td className="end num">{integer(i.quantity)}</td><td className="end num">{money(i.unitPriceNet)}</td><td className="end num">{money(i.lineTotal)}</td></tr>)}</tbody>
              <tfoot>
                <tr><td colSpan={3}>قبل الضريبة</td><td className="end num">{money(o.subtotal)}</td></tr>
                {o.discount > 0 && <tr><td colSpan={3}>الخصم</td><td className="end num">− {money(o.discount)}</td></tr>}
                <tr><td colSpan={3}>ضريبة القيمة المضافة</td><td className="end num">{money(o.vat)}</td></tr>
                <tr><td colSpan={3}>الإجمالي</td><td className="end num">{money(o.total)}</td></tr>
              </tfoot>
            </table>
          </div>
        </section>

        <div className="stack-lg">
          <section className="panel" aria-labelledby="order-facts-h">
            <div className="card-head"><h2 id="order-facts-h">بيانات الطلب</h2></div>
            <div className="card-body">
              <dl className="dl">
                <dt>القناة</dt><dd><ChannelTag channel={o.channel} platformName={o.platformName} /></dd>
                {o.externalRef && <><dt>مرجع التطبيق</dt><dd className="num">{o.externalRef}</dd></>}
                <dt>الوقت</dt><dd>{dayTime(o.createdAt)}</dd>
                {o.tableName && <><dt>الطاولة</dt><dd>{o.tableName}{o.guests ? <span className="muted"> · <span className="num">{o.guests}</span> ضيوف</span> : null}</dd></>}
                {o.customerFullName ? <><dt>العميل</dt><dd>{o.customerFullName} <span className="muted num">{o.customerPhone}</span></dd></> : o.customerName ? <><dt>العميل</dt><dd>{o.customerName}</dd></> : null}
                {o.commission ? <><dt>عمولة التطبيق</dt><dd className="num">{money(o.commission)}</dd></> : null}
                <dt>الإجمالي</dt><dd className="num">{money(o.total)}</dd>
                {refunded > 0 && <><dt>المسترجع</dt><dd><span className="num">{money(refunded)}</span> <span className="muted">من {money(o.total)}</span></dd></>}
              </dl>
            </div>
          </section>

          <section className="panel" aria-labelledby="order-pay-h">
            <div className="card-head"><h2 id="order-pay-h">الدفعات</h2></div>
            <div className="card-body">
              {o.payments.length === 0 ? <p className="muted">لا توجد دفعات مسجلة.</p> : (
                <dl className="dl">{o.payments.map((p, i) => <Fragment key={i}><dt>{METHOD_LABELS[p.method] ?? p.method}</dt><dd className="num">{money(p.amount)}</dd></Fragment>)}</dl>
              )}
            </div>
          </section>

          <section className="panel" aria-labelledby="order-inv-h">
            <div className="card-head"><h2 id="order-inv-h">الفواتير</h2></div>
            <div className="card-body">
              {o.invoices.length === 0 ? <p className="muted">لا توجد فواتير لهذا الطلب.</p> : (
                <ul className="people">{o.invoices.map((i) => (
                  <li key={i.icv} className="person">
                    <span className={`dot ${i.kind === "credit_note" ? "on-red" : "on-indigo"}`} aria-hidden="true" />
                    <span className="who"><strong>{i.kind === "credit_note" ? "إشعار دائن" : "فاتورة مبسطة"}</strong><span>رقم تسلسلي <span className="num">{i.icv}</span> · {dayTime(i.issuedAt)}</span></span>
                  </li>
                ))}</ul>
              )}
            </div>
          </section>

          {o.refunds.length > 0 && (
            <section className="panel" aria-labelledby="order-ref-h">
              <div className="card-head"><h2 id="order-ref-h">المرتجعات</h2></div>
              <div className="card-body">
                <ul className="people">{o.refunds.map((r, i) => (
                  <li key={i} className="person">
                    <span className="dot on-red" aria-hidden="true" />
                    <span className="who"><strong>{money(r.amount)} · {METHOD_LABELS[r.method] ?? r.method}</strong><span>{r.reason} · {dayTime(r.createdAt)}</span></span>
                  </li>
                ))}</ul>
              </div>
            </section>
          )}
        </div>
      </div>
      {refunding && <RefundDialog tenantId={tenantId} order={o} remaining={remaining} onClose={() => setRefunding(false)} onDone={async () => { setRefunding(false); await invalidate("pos", "stock", "ingredients", "reports", "shifts"); }} />}
    </div>
  );
}

function RefundDialog({ tenantId, order, remaining, onClose, onDone }: { tenantId: string; order: OrderDetail; remaining: number; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [key, renewKey] = useIdempotencyKey();
  const shifts = useQuery({ queryKey: ["t", tenantId, "shifts", { status: "open", refund: true }], queryFn: () => api<Page<ShiftRow & { locationName: string }>>("GET", "/t/pos/shifts", { tenant: tenantId, query: { status: "open", pageSize: 50 } }) });
  const locShifts = (shifts.data?.items ?? []);
  const [v, setV] = useState({ amount: remaining.toFixed(2), method: order.payments[0]?.method ?? "cash", reason: "", restock: true, shiftId: "" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const full = Math.round(Number(v.amount) * 100) === Math.round(remaining * 100);
  const shiftId = v.shiftId || locShifts.find((s) => s.isMine)?.id || locShifts[0]?.id || "";

  async function submit() {
    const amount = Number(v.amount);
    if (!(amount > 0) || Math.round(amount * 100) > Math.round(remaining * 100)) return setError(`المبلغ من 0.01 إلى ${money(remaining)} (المتبقي غير المسترجع)`);
    if (v.reason.trim().length < 3) return setError("اكتب سبب الاسترجاع؛ يظهر في الإشعار الدائن وسجل التدقيق");
    if (!shiftId) return setError("لا يوجد شفت مفتوح لتسجيل الاسترجاع عليه. افتح شفتاً من شاشة الكاشير أولاً.");
    setBusy(true); setError(null);
    try {
      await api("POST", `/t/pos/orders/${order.id}/refund`, { tenant: tenantId, idempotencyKey: key, body: { shiftId, amount, method: v.method, reason: v.reason.trim(), restock: full && v.restock } });
      renewKey();
      toast.success(`تم استرجاع ${money(amount)} وإصدار إشعار دائن`);
      onDone();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }

  return (
    <Dialog open onClose={onClose} busy={busy} title={`استرجاع من طلب ${order.number}`} onSubmit={() => void submit()}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الاسترجاع…">استرجاع {money(Number(v.amount) || 0)}</Button><Button onClick={onClose} disabled={busy} autoFocus>إلغاء</Button></>}>
      <p>يصدر إشعار دائن مرتبط بالفاتورة، ولا يمكن التراجع عنه.</p>
      <div className="form-grid">
        <TextField label={`المبلغ المسترجع (${RIYAL})`} required numeric value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} hint={`المتبقي القابل للاسترجاع ${money(remaining)}`} />
        <SelectField label="طريقة الرد" required value={v.method} onChange={(e) => setV({ ...v, method: e.target.value })} options={Object.entries(METHOD_LABELS).map(([value, label]) => ({ value, label }))} />
        {locShifts.length > 1 && <SelectField label="على شفت" required value={shiftId} onChange={(e) => setV({ ...v, shiftId: e.target.value })} options={locShifts.map((s) => ({ value: s.id, label: `${s.locationName} · ${s.openedByName ?? ""}` }))} />}
      </div>
      <TextField label="سبب الاسترجاع" required value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} />
      <Checkbox label="إرجاع المكونات للمخزون (للاسترجاع الكامل فقط)" checked={full && v.restock} disabled={!full} onChange={(e) => setV({ ...v, restock: e.target.checked })} />
      {shifts.isSuccess && !locShifts.length && <p className="banner banner-warning sr-note">لا يوجد شفت مفتوح. الاسترجاع يُسجَّل على شفت مفتوح حتى يُطابَق النقد.</p>}
      <FormError error={error} />
    </Dialog>
  );
}


interface DailyRow { day: string; orders: number; netSales: number; vat: number; total: number; cost: number; grossProfit: number; refunds: number }

export function DailySalesReport() {
  const { tenantId } = useTenant();
  const [from, setFrom] = useState(addDays(isoDay(), -29));
  const [to, setTo] = useState(isoDay());
  const r = useQuery({ queryKey: ["t", tenantId, "reports", "daily", from, to], queryFn: () => api<{ items: DailyRow[] }>("GET", "/t/reports/daily-sales", { tenant: tenantId, query: { from, to } }), placeholderData: keepPreviousData });
  const sum = (k: keyof DailyRow) => (r.data?.items ?? []).reduce((a, x) => a + Math.round(Number(x[k]) * 100), 0) / 100;
  return (
    <div className="page">
      <PageHeader eyebrow="التقارير" title="المبيعات اليومية" description={`من ${day(from)} إلى ${day(to)} بتوقيت الرياض. الحد الأقصى للفترة 92 يوماً.`} />
      <div className="toolbar panel sr-filter-bar" role="group" aria-label="الفترة"><DateRange from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} /></div>
      {r.data && r.data.items.length > 0 && (
        <div className="stats stats-4">
          <StatCard label="الإجمالي شامل الضريبة" value={money(sum("total"))} note={`${integer(sum("orders"))} طلب`} icon={<Receipt />} hue="indigo" />
          <StatCard label="صافي المبيعات" value={money(sum("netSales"))} note={`الضريبة ${money(sum("vat"))}`} icon={<Banknote />} hue="sky" />
          <StatCard label="مجمل الربح" value={money(sum("grossProfit"))} note={`تكلفة المكونات ${money(sum("cost"))}`} icon={<TrendingUp />} hue="green" />
          <StatCard label="المرتجعات" value={money(sum("refunds"))} icon={<RotateCcw />} hue="red" />
        </div>
      )}
      <section className="panel">
        <DataTable caption="المبيعات اليومية" query={r} rowKey={(x) => x.day}
          empty={{ title: "لا توجد مبيعات في هذه الفترة", body: "غيّر الفترة، أو ابدأ البيع من شاشة الكاشير." }}
          columns={[
            { key: "day", header: "اليوم", cell: (x) => <strong>{day(x.day)}</strong> },
            { key: "orders", header: "الطلبات", numeric: true, cell: (x) => integer(x.orders) },
            { key: "net", sortKey: "netSales", header: "صافي المبيعات", numeric: true, cell: (x) => money(x.netSales) },
            { key: "vat", header: "الضريبة", numeric: true, cell: (x) => money(x.vat) },
            { key: "total", header: "الإجمالي", numeric: true, cell: (x) => money(x.total) },
            { key: "cost", header: "تكلفة المكونات", numeric: true, cell: (x) => money(x.cost) },
            { key: "gp", sortKey: "grossProfit", header: "مجمل الربح", numeric: true, cell: (x) => money(x.grossProfit) },
            { key: "ref", sortKey: "refunds", header: "المرتجعات", numeric: true, cell: (x) => money(x.refunds) },
          ]} />
      </section>
    </div>
  );
}

interface MenuRow { id: string; code: string; name: string; status: string; priceNet: number; idealCost: number; idealMargin: number; foodCostPercent: number | null; missingCost: number; qtySold: number; revenue: number; actualCost: number }

export function MenuProfitabilityReport() {
  const { tenantId } = useTenant();
  const [from, setFrom] = useState(addDays(isoDay(), -29));
  const [to, setTo] = useState(isoDay());
  const [page, setPage] = useState(1);
  const prefs = useTablePrefs("menu-profitability", { server: true, onSortChange: () => setPage(1) });
  const r = useQuery({ queryKey: ["t", tenantId, "reports", "menu", { from, to, page, sort: prefs.sortParam }], queryFn: () => api<Page<MenuRow>>("GET", "/t/reports/menu-profitability", { tenant: tenantId, query: { from, to, page, pageSize: 50, sort: prefs.sortParam } }), placeholderData: keepPreviousData });
  return (
    <div className="page">
      <PageHeader eyebrow="التقارير" title="ربحية المنيو" description="التكلفة المثالية من الوصفة بمتوسط التكلفة الحالي، والتكلفة الفعلية من المكونات المخصومة وقت كل بيع." />
      <div className="toolbar panel sr-filter-bar" role="group" aria-label="الفترة"><DateRange from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); setPage(1); }} /></div>
      <section className="panel">
        <DataTable caption="ربحية المنيو" prefs={prefs} query={r} rowKey={(x) => x.id} onPageChange={setPage}
          empty={{ title: "لا توجد وصفات بعد", body: "أنشئ وصفات المنيو لتظهر ربحيتها هنا." }}
          columns={[
            { key: "name", sortKey: "name", header: "الصنف", cell: (x) => <strong>{x.name}</strong> },
            { key: "price", sortKey: "priceNet", header: "السعر قبل الضريبة", numeric: true, cell: (x) => money(x.priceNet) },
            { key: "ideal", sortKey: "idealCost", header: "التكلفة المثالية", numeric: true, cell: (x) => <span className="sr-num-cell">{x.missingCost > 0 && <Badge tone="warning">ناقصة</Badge>}{money(x.idealCost)}</span> },
            { key: "fc", sortKey: "foodCostPercent", header: "تكلفة الطعام", numeric: true, cell: (x) => percent(x.foodCostPercent) },
            { key: "qty", sortKey: "qtySold", header: "الكمية المباعة", numeric: true, cell: (x) => integer(x.qtySold) },
            { key: "rev", sortKey: "revenue", header: "الإيراد الصافي", numeric: true, cell: (x) => money(x.revenue) },
            { key: "act", sortKey: "actualCost", header: "التكلفة الفعلية", numeric: true, cell: (x) => money(x.actualCost) },
          ]} />
      </section>
    </div>
  );
}

interface ValuationRow { locationId: string; locationName: string; items: number; value: number; belowMin: number }

export function StockValuationReport() {
  const { tenantId } = useTenant();
  const r = useQuery({ queryKey: ["t", tenantId, "reports", "valuation"], queryFn: () => api<{ items: ValuationRow[]; total: number }>("GET", "/t/reports/stock-valuation", { tenant: tenantId }) });
  return (
    <div className="page">
      <PageHeader eyebrow="التقارير" title="تقييم المخزون" description="قيمة الرصيد الحالي بمتوسط التكلفة المرجح لكل موقع." />
      {r.data && (
        <div className="stats">
          <StatCard label="إجمالي قيمة المخزون" value={money(r.data.total)} note="بمتوسط التكلفة المرجح" icon={<Boxes />} hue="sky" />
          <StatCard label="المواقع" value={integer(r.data.items.length)} note={`${integer(r.data.items.reduce((a, x) => a + x.items, 0))} رصيد مادة في كل المواقع`} icon={<Warehouse />} hue="indigo" />
          <StatCard label="أرصدة تحت الحد الأدنى" value={integer(r.data.items.reduce((a, x) => a + x.belowMin, 0))} note="مجموع كل المواقع" noteTone={r.data.items.some((x) => x.belowMin > 0) ? "warning" : undefined} icon={<AlertTriangle />} hue="amber" />
        </div>
      )}
      <section className="panel">
        <DataTable caption="تقييم المخزون" query={r} rowKey={(x) => x.locationId}
          empty={{ title: "لا توجد مواقع", body: "أضف مطبخاً أو مستودعاً واستلم فيه المشتريات." }}
          columns={[
            { key: "loc", sortKey: "locationName", header: "الموقع", cell: (x) => <strong>{x.locationName}</strong> },
            { key: "items", header: "عدد المواد", numeric: true, cell: (x) => integer(x.items) },
            { key: "below", sortKey: "belowMin", header: "تحت الحد الأدنى", numeric: true, cell: (x) => (x.belowMin ? <Badge tone="warning">{integer(x.belowMin)}</Badge> : "0") },
            { key: "value", header: "القيمة", numeric: true, cell: (x) => money(x.value) },
          ]} />
      </section>
    </div>
  );
}

