import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, ExternalLink, Minus, Plus, Printer, QrCode, UserRound, X } from "lucide-react";
import QRCode from "qrcode";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type Page } from "../../api/client";
import { useIdempotencyKey } from "../../app/session";
import { useTenant } from "../../app/tenant";
import { RIYAL, dayTime, integer, money, percent, time } from "../../lib/format";
import { Button, IconButton } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { TextField } from "../../ui/Field";
import { Badge } from "../../ui/Layout";
import { EmptyState, ErrorState, FormError, Skeleton } from "../../ui/States";
import { CHANNEL_LABELS, METHOD_LABELS } from "../../ui/status";
import { useToast } from "../../ui/Toast";

// ── Shared shapes ─────────────────────────────────────────────────────────────
export interface MenuItem {
  id: string; code: string; name: string; category: string | null; priceNet: number; priceGross: number; available: number;
  modifierGroups: { id: string; name: string; min: number; max: number; options: { id: string; name: string; priceNet: number; priceGross: number }[] }[];
}
export type Channel = "dine_in" | "takeaway" | "delivery";
export type Method = "cash" | "mada" | "visa" | "mastercard" | "platform";
export type GatewayName = "moyasar" | "tap";
export const GATEWAY_AR: Record<GatewayName, string> = { moyasar: "ميسّر", tap: "تاب" };
export interface SaleResult { id: string; orderNumber: number; total: number; vat: number; qr: string | null; ticketClosed?: boolean | null }
export interface Area { id: string; name: string; tables: { id: string; name: string; seats: number; isActive: boolean; busy: boolean; ticketId: string | null }[] }
export interface Platform { id: string; name: string; commissionPercent: number; isActive: boolean }
export interface CustomerRef { id: string; name: string; phone: string }
export interface Line { id: string; recipeId: string; quantity: number; modifiers: string[]; note: string | null; sent: number; name?: string }
export interface Ticket {
  id: string; number: number; label: string | null; channel: Channel; tableId: string | null; tableName: string | null; guests: number | null;
  customerId: string | null; customerName: string | null; customerPhone: string | null; platformId: string | null; platformName: string | null; externalRef: string | null;
  discount: { type: "amount" | "percent"; value: number } | null; discountReason: string | null; notes: string | null; items: Line[];
  status: "open" | "paid" | "void"; version: number; kitchenRounds: number; lastSentAt: string | null; createdAt: string; updatedAt: string;
  count: number; unsent: number; totals: { subtotal: number; discount: number; vat: number; total: number } | null; problem: string | null;
  orders: { id: string; number: number; total: number }[];
}

/** A ticket's name on the till: what the cashier called it, else its table, customer or number. */
export const ticketName = (t: { label: string | null; tableName: string | null; customerName: string | null; number: number | null }) =>
  t.label || (t.tableName ? `طاولة ${t.tableName}` : t.customerName || (t.number ? `طلب ${t.number}` : "طلب جديد"));

const minutesSince = (iso: string | null, now: number) => (iso ? Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000)) : 0);
export const elapsed = (iso: string | null, now: number) => {
  const m = minutesSince(iso, now);
  return m < 60 ? `${integer(m)} د` : `${integer(Math.floor(m / 60))} س ${integer(m % 60)} د`;
};

// ── Options of a product ──────────────────────────────────────────────────────
/** One screen per product with options: radio for "exactly one", checkboxes otherwise; min/max checked here AND on the server. */
export function ModifierDialog({ item, onClose, onAdd }: { item: MenuItem; onClose: () => void; onAdd: (optionIds: string[], note: string | null, quantity: number) => void }) {
  const [chosen, setChosen] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(item.modifierGroups.map((g) => [g.id, g.min === 1 && g.max === 1 && g.options[0] ? [g.options[0].id] : []])));
  const [note, setNote] = useState("");
  const [qty, setQty] = useState(1);
  const problems = item.modifierGroups.filter((g) => (chosen[g.id]?.length ?? 0) < g.min || (chosen[g.id]?.length ?? 0) > g.max);
  const extra = item.modifierGroups.reduce((a, g) => a + g.options.filter((o) => chosen[g.id]?.includes(o.id)).reduce((s, o) => s + o.priceGross, 0), 0);
  function toggle(gId: string, oId: string, single: boolean, max: number) {
    setChosen((c) => {
      const cur = c[gId] ?? [];
      if (single) return { ...c, [gId]: [oId] };
      if (cur.includes(oId)) return { ...c, [gId]: cur.filter((x) => x !== oId) };
      if (cur.length >= max) return c;
      return { ...c, [gId]: [...cur, oId] };
    });
  }
  return (
    <Dialog open onClose={onClose} title={item.name}
      footer={<><Button variant="primary" size="lg" disabled={problems.length > 0} onClick={() => onAdd(item.modifierGroups.flatMap((g) => chosen[g.id] ?? []), note.trim() || null, qty)}>
        {problems.length ? `اختر من «${problems[0]!.name}»` : `إضافة للطلب · ${money((item.priceGross + extra) * qty)}`}</Button><Button size="lg" onClick={onClose}>إلغاء</Button></>}>
      {item.modifierGroups.map((g) => {
        const single = g.max === 1;
        const n = chosen[g.id]?.length ?? 0;
        return (
          <fieldset key={g.id} className="stack pos-fieldset">
            <legend className="field-label pos-legend">
              {g.name} <span className="muted">{g.min === g.max ? `(اختر ${g.min})` : g.min > 0 ? `(من ${g.min} إلى ${g.max})` : `(اختياري، حتى ${g.max})`}</span>
            </legend>
            <div className="pos-choices" role={single ? "radiogroup" : "group"} aria-label={g.name}>
              {g.options.map((o) => {
                const on = chosen[g.id]?.includes(o.id) ?? false;
                return (
                  <button key={o.id} type="button" role={single ? "radio" : "checkbox"} aria-checked={on} aria-label={`${o.name}${o.priceGross ? `، زيادة ${money(o.priceGross)}` : ""}`} className="pos-choice"
                    disabled={!on && !single && n >= g.max} onClick={() => toggle(g.id, o.id, single, g.max)}>
                    <span className="name">{on && <Check aria-hidden="true" />}{o.name}</span>
                    <span className="avail">{o.priceGross ? `+ ${money(o.priceGross)}` : "بدون زيادة"}</span>
                  </button>
                );
              })}
            </div>
          </fieldset>
        );
      })}
      <div className="pos-inline is-end">
        <TextField label="ملاحظة للمطبخ" optional value={note} maxLength={140} onChange={(e) => setNote(e.target.value)} placeholder="بدون بصل، الصوص على جنب…" />
        <div className="qty pos-qty-lg" role="group" aria-label="الكمية">
          <Button aria-label="تقليل الكمية" icon={<Minus />} disabled={qty <= 1} onClick={() => setQty((q) => q - 1)} />
          <output aria-live="polite">{qty}</output>
          <Button aria-label="زيادة الكمية" icon={<Plus />} disabled={qty >= Math.min(99, item.available)} onClick={() => setQty((q) => q + 1)} />
        </div>
      </div>
    </Dialog>
  );
}

// ── Tables ────────────────────────────────────────────────────────────────────
/** A free table is assigned to this order; a table with an open order opens that order instead. */
export function TableDialog({ areas, selected, currentTicketId, onClose, onPick, onOpenTicket }: {
  areas: ReturnType<typeof useQuery<{ items: Area[] }>>; selected: string | null; currentTicketId: string | null;
  onClose: () => void; onPick: (id: string | null) => void; onOpenTicket: (ticketId: string) => void;
}) {
  const list = (areas.data?.items ?? []).filter((a) => a.tables.some((t) => t.isActive));
  return (
    <Dialog open wide onClose={onClose} title="الطاولات" footer={<><Button onClick={() => onPick(null)}>بدون طاولة</Button><Button onClick={onClose}>إغلاق</Button></>}>
      <p className="muted pos-legend-row"><span className="pos-legend-dot is-free" aria-hidden="true" /> متاحة <span className="pos-legend-dot is-busy" aria-hidden="true" /> عليها طلب مفتوح (اضغطها لفتحه)</p>
      {areas.isPending ? <Skeleton width="60%" /> : areas.isError ? <ErrorState error={areas.error} onRetry={() => areas.refetch()} />
        : list.length === 0 ? <EmptyState title="لا توجد طاولات لهذا الموقع">أضف الصالات والطاولات من «البيانات الأساسية ← الصالات والطاولات».</EmptyState>
        : list.map((a) => (
          <section key={a.id} className="stack">
            <h3>{a.name}</h3>
            <div className="pos-choices is-tables">
              {a.tables.filter((t) => t.isActive).map((t) => {
                const other = t.ticketId && t.ticketId !== currentTicketId;
                return (
                  <button key={t.id} type="button" className={["pos-choice", t.busy && "is-busy"].filter(Boolean).join(" ")} aria-pressed={selected === t.id}
                    onClick={() => (other ? onOpenTicket(t.ticketId!) : onPick(t.id))}>
                    <span className="name">{t.name}</span>
                    <span className="avail">{other ? "مشغولة · فتح طلبها" : t.busy ? "مشغولة" : `${integer(t.seats)} مقاعد`}</span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
    </Dialog>
  );
}

// ── Customer ──────────────────────────────────────────────────────────────────
/** Optional customer: search by phone or name, or add in place (phone is the key). */
export function CustomerPicker({ tenantId, value, onChange }: { tenantId: string; value: CustomerRef | null; onChange: (c: CustomerRef | null) => void }) {
  const [open, setOpen] = useState(false);
  if (value) {
    return (
      <div className="pos-customer">
        <span className="pos-customer-icon tone-violet" aria-hidden="true"><UserRound /></span>
        <span className="pos-customer-who"><strong>العميل: {value.name}</strong><span dir="ltr" className="num">{value.phone}</span></span>
        <IconButton label="إزالة العميل من الطلب" icon={<X />} onClick={() => onChange(null)} />
      </div>
    );
  }
  return (
    <>
      <Button variant="ghost" icon={<UserRound />} className="pos-start" onClick={() => setOpen(true)}>ربط عميل</Button>
      {open && <CustomerDialog tenantId={tenantId} onClose={() => setOpen(false)} onPick={(c) => { onChange(c); setOpen(false); }} />}
    </>
  );
}

function CustomerDialog({ tenantId, onClose, onPick }: { tenantId: string; onClose: () => void; onPick: (c: CustomerRef) => void }) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  const found = useQuery({ enabled: debounced.length >= 3, queryKey: ["t", tenantId, "customers", { q: debounced, pos: true }],
    queryFn: () => api<{ items: (CustomerRef & { ordersCount: number })[] }>("GET", "/t/customers", { tenant: tenantId, query: { q: debounced, pageSize: 8 } }) });
  const phoneLike = /^\+?[0-9]{9,15}$/.test(q.trim());
  async function add() {
    if (name.trim().length < 2) return setError("أدخل اسم العميل");
    setBusy(true); setError(null);
    try {
      const r = await api<{ id: string }>("POST", "/t/customers", { tenant: tenantId, body: { name: name.trim(), phone: q.trim() } });
      onPick({ id: r.id, name: name.trim(), phone: q.trim() });
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} title="ربط عميل بالطلب" footer={<Button onClick={onClose}>إلغاء</Button>}>
      <TextField label="جوال العميل أو اسمه" autoFocus dir="auto" inputMode="search" value={q} onChange={(e) => { setQ(e.target.value); setAdding(false); }} hint="3 أحرف أو أرقام على الأقل للبحث." />
      {debounced.length >= 3 && (found.isPending ? <Skeleton width="50%" /> : found.isError ? <ErrorState error={found.error} onRetry={() => found.refetch()} /> : (
        <ul className="pos-found">
          {found.data!.items.map((c) => (
            <li key={c.id}>
              <button type="button" className="pos-found-item" onClick={() => onPick(c)}>
                <span className="dot on-violet" aria-hidden="true" />
                <span className="pos-found-who"><strong>{c.name}</strong><span dir="ltr" className="num">{c.phone}</span></span>
                <span className="pos-found-count">{integer(c.ordersCount)} طلب</span>
              </button>
            </li>
          ))}
          {found.data!.items.length === 0 && <li className="pos-found-none" aria-disabled="true">لا يوجد عميل مطابق</li>}
        </ul>
      ))}
      {phoneLike && found.data && found.data.items.length === 0 && (adding ? (
        <div className="pos-inline is-end">
          <TextField label="اسم العميل الجديد" required autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          <Button variant="primary" loading={busy} loadingText="…" onClick={() => void add()}>إضافة وربط</Button>
        </div>
      ) : <Button icon={<Plus />} onClick={() => setAdding(true)}>إضافة عميل بالجوال <span dir="ltr">{q.trim()}</span></Button>)}
      <FormError error={error} />
    </Dialog>
  );
}

// ── Payment ───────────────────────────────────────────────────────────────────
const CASH_METHODS: Method[] = ["cash", "mada", "visa", "mastercard"];

/** Notes a cashier is likely to be handed for this total: the exact amount, then the next round figures. */
function quickCash(total: number) {
  const out = new Set<number>([Math.round(total * 100) / 100]);
  for (const step of [5, 10, 50, 100, 500]) {
    const v = Math.ceil(total / step) * step;
    if (v > total) out.add(v);
    if (out.size >= 5) break;
  }
  return [...out].sort((a, b) => a - b);
}

export function PaymentDialog({ tenantId, total, title, order, platform, onClose, onPaid }: {
  tenantId: string; total: number; title?: string; order: Record<string, unknown>; platform: Platform | null; onClose: () => void; onPaid: (r: SaleResult, change: number) => void;
}) {
  // One key for this sale: a retry after a timeout replays the same order instead of creating a second one.
  const [key, renewKey] = useIdempotencyKey();
  const [payments, setPayments] = useState<{ method: Method; amount: string }[]>([{ method: "cash", amount: total.toFixed(2) }]);
  const [tendered, setTendered] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [uncertain, setUncertain] = useState(false);
  const cents = (s: string) => Math.round(Number(s || "0") * 100);
  const paid = platform ? Math.round(total * 100) : payments.reduce((a, p) => a + cents(p.amount), 0);
  const due = Math.round(total * 100);
  const remaining = due - paid;
  const cashDue = payments.filter((p) => p.method === "cash").reduce((a, p) => a + cents(p.amount), 0);
  const change = tendered ? cents(tendered) - cashDue : 0;
  // Online payment (QR on screen) is offered only when the owner connected a gateway.
  const gateways = useQuery({ enabled: !platform, queryKey: ["t", tenantId, "pos", "gateways"], staleTime: 60_000,
    queryFn: () => api<{ items: { provider: GatewayName; mode: "test" | "live" }[] }>("GET", "/t/pos/online-payments/providers", { tenant: tenantId }) });
  const [online, setOnline] = useState<{ provider: GatewayName; mode: "test" | "live" } | null>(null);
  const single = payments.length === 1;

  async function pay() {
    if (remaining !== 0) return setError(remaining > 0 ? `متبقٍ ${money(remaining / 100)} لم يُغطَّ` : `المدفوع يزيد ${money(-remaining / 100)} عن الإجمالي. سجّل المبلغ المستحق فقط، والباقي يظهر كفكّة`);
    if (tendered && change < 0) return setError(`المبلغ المستلم نقداً أقل من المستحق نقداً بـ ${money(-change / 100)}`);
    setBusy(true); setError(null); setUncertain(false);
    try {
      const r = await api<SaleResult>("POST", "/t/pos/orders", {
        tenant: tenantId, idempotencyKey: key,
        body: { ...order, payments: platform ? [{ method: "platform", amount: total }] : payments.filter((p) => cents(p.amount) > 0).map((p) => ({ method: p.method, amount: cents(p.amount) / 100 })) },
      });
      renewKey();
      onPaid(r, Math.max(0, change) / 100);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 0 || e.status >= 500)) setUncertain(true);
      setError(e);
    } finally { setBusy(false); }
  }

  if (online) return <OnlinePayDialog tenantId={tenantId} total={total} order={order} gateway={online} onBack={() => setOnline(null)} onPaid={(r) => onPaid(r, 0)} />;

  return (
    <Dialog open onClose={onClose} busy={busy} title={title ?? (platform ? `طلب ${platform.name} · ${money(total)}` : `الدفع · ${money(total)}`)}
      footer={<><Button variant="primary" size="lg" loading={busy} loadingText="جارٍ تسجيل البيع…" onClick={() => void pay()} disabled={remaining !== 0}>{uncertain ? "إعادة المحاولة" : platform ? "تسجيل الطلب وإصدار الفاتورة" : "تأكيد الدفع وإصدار الفاتورة"}</Button><Button size="lg" onClick={onClose} disabled={busy}>رجوع للطلب</Button></>}>
      <p className="pos-pay-due"><span>المستحق</span><strong className="num">{money(total)}</strong></p>
      {platform ? (
        <p>يُسدَّد الطلب عبر <strong>{platform.name}</strong>، ولا يُستلم نقد في الدرج. عمولة التطبيق ({percent(platform.commissionPercent)}) تُحسب في الخادم وتظهر في تقرير المبيعات حسب القناة.</p>
      ) : <>
        {single ? (
          <div className="pos-seg is-methods" role="radiogroup" aria-label="طريقة الدفع">
            {CASH_METHODS.map((m) => <button key={m} type="button" role="radio" aria-checked={payments[0]!.method === m} onClick={() => setPayments([{ method: m, amount: total.toFixed(2) }])}>{METHOD_LABELS[m]}</button>)}
          </div>
        ) : payments.map((p, i) => (
          <div key={i} className="pos-inline is-end">
            <label className="field"><span className="field-label">{`طريقة الدفع ${i + 1}`}</span>
              <select className="select" value={p.method} onChange={(e) => setPayments((ps) => ps.map((x, n) => (n === i ? { ...x, method: e.target.value as Method } : x)))}>
                {CASH_METHODS.map((m) => <option key={m} value={m}>{METHOD_LABELS[m]}</option>)}
              </select>
            </label>
            <TextField label={`المبلغ (${RIYAL})`} numeric value={p.amount} onChange={(e) => setPayments((ps) => ps.map((x, n) => (n === i ? { ...x, amount: e.target.value } : x)))} />
            <IconButton label={`حذف طريقة الدفع ${i + 1}`} destructive icon={<X />} onClick={() => setPayments((ps) => ps.filter((_, n) => n !== i))} />
          </div>
        ))}
        <div className="row">
          {payments.length < 4 && <Button variant="ghost" icon={<Plus />} onClick={() => setPayments((ps) => [...ps, { method: ps[0]?.method === "cash" ? "mada" : "cash", amount: remaining > 0 ? (remaining / 100).toFixed(2) : "0" }])}>تقسيم على أكثر من طريقة</Button>}
          <span className="spacer" />
          {!single && <strong aria-live="polite" className={["pos-cover", remaining === 0 ? "is-ok" : "is-off"].join(" ")}>{remaining === 0 ? "المبلغ مغطى" : remaining > 0 ? `متبقٍ ${money(remaining / 100)}` : `زائد ${money(-remaining / 100)}`}</strong>}
        </div>
        {cashDue > 0 && (
          <div className="pos-change">
            <div className="pos-cash-quick" role="group" aria-label="المبلغ المستلم">
              {quickCash(cashDue / 100).map((v) => <button key={v} type="button" className="pos-chip" aria-pressed={tendered === v.toFixed(2)} onClick={() => setTendered(v.toFixed(2))}><span className="num">{money(v)}</span></button>)}
            </div>
            <div className="pos-inline is-end">
              <TextField label="المبلغ المستلم نقداً" optional numeric value={tendered} onChange={(e) => setTendered(e.target.value)} hint="لحساب الفكّة فقط، ولا يُرسل." />
              {tendered && <strong aria-live="polite" className={["pos-change-value", change < 0 && "is-short"].filter(Boolean).join(" ")}>{change >= 0 ? `الفكّة: ${money(change / 100)}` : `ناقص ${money(-change / 100)}`}</strong>}
            </div>
          </div>
        )}
        {(gateways.data?.items.length ?? 0) > 0 && (
          <div className="pos-online-offer">
            {gateways.data!.items.map((g) => (
              <Button key={g.provider} variant="secondary" icon={<QrCode />} disabled={busy} onClick={() => { setError(null); setOnline(g); }}>
                دفع إلكتروني عبر {GATEWAY_AR[g.provider]}{g.mode === "test" ? " (تجريبي)" : ""}
              </Button>
            ))}
            <span className="muted pos-online-hint">يمسح العميل رمز QR ويدفع بمدى أو Apple Pay من جواله</span>
          </div>
        )}
      </>}
      {uncertain && <p className="banner banner-warning pos-banner">لم نتأكد من تسجيل البيع بسبب انقطاع الاتصال. أعد المحاولة: الطلب لن يُسجَّل مرتين.</p>}
      <FormError error={error} />
    </Dialog>
  );
}

interface Intent { id: string; amount: number; url: string; status: string; mode: "test" | "live"; failure: string | null }
type Settled = { status: string; failure: string | null; sale: SaleResult | null };

/**
 * The customer pays on their phone: a QR of the gateway's page, checked every few seconds. The sale is recorded by the
 * server only once the gateway confirms the payment, so leaving this screen never loses a paid order.
 */
function OnlinePayDialog({ tenantId, total, order, gateway, onBack, onPaid }: {
  tenantId: string; total: number; order: Record<string, unknown>; gateway: { provider: GatewayName; mode: "test" | "live" }; onBack: () => void; onPaid: (r: SaleResult) => void;
}) {
  const [key, renewKey] = useIdempotencyKey();
  const [intent, setIntent] = useState<Intent | null>(null);
  const [img, setImg] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [status, setStatus] = useState<{ state: string; failure: string | null }>({ state: "pending", failure: null });
  const [offline, setOffline] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const inFlight = useRef(false);
  const toast = useToast();

  // One payment page per key: a re-render (or React's double effect in development) reuses the same page.
  useEffect(() => {
    let live = true;
    setError(null); setIntent(null); setImg(null); setStatus({ state: "pending", failure: null });
    api<Intent>("POST", "/t/pos/online-payments", { tenant: tenantId, idempotencyKey: key, body: { ...order, provider: gateway.provider } })
      .then((i) => { if (!live) return; setIntent(i); return QRCode.toDataURL(i.url, { margin: 1, width: 320, errorCorrectionLevel: "M" }).then((d) => { if (live) setImg(d); }); })
      .catch((e) => { if (live) setError(e); });
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const settle = (r: Settled) => {
    if (r.status === "paid" && r.sale) return onPaid(r.sale);
    setStatus({ state: r.status, failure: r.failure });
  };

  useEffect(() => {
    if (!intent || status.state !== "pending") return;
    const t = setInterval(() => {
      if (inFlight.current) return;
      inFlight.current = true;
      api<Settled>("POST", `/t/pos/online-payments/${intent.id}/check`, { tenant: tenantId })
        .then((r) => { setOffline(false); settle(r); })
        .catch(() => setOffline(true))
        .finally(() => { inFlight.current = false; });
    }, 3000);
    return () => clearInterval(t);
  }, [intent, status.state]); // eslint-disable-line react-hooks/exhaustive-deps

  async function cancel() {
    if (!intent || status.state !== "pending") return onBack();
    setCanceling(true);
    try {
      const r = await api<Settled>("POST", `/t/pos/online-payments/${intent.id}/cancel`, { tenant: tenantId });
      if (r.status === "paid" && r.sale) { toast.success("العميل دفع قبل الإلغاء، فسُجّل البيع"); onPaid(r.sale); return; }
      onBack();
    } catch (e) { setError(e); } finally { setCanceling(false); }
  }

  const name = GATEWAY_AR[gateway.provider];
  const ended = status.state === "failed" || status.state === "expired" || status.state === "canceled";
  return (
    <Dialog open onClose={() => void cancel()} busy={canceling} title={`دفع إلكتروني عبر ${name} · ${money(total)}`}
      footer={<>
        {ended && <Button variant="primary" size="lg" icon={<QrCode />} onClick={renewKey}>رمز دفع جديد</Button>}
        <Button size="lg" loading={canceling} loadingText="جارٍ الإلغاء…" onClick={() => void cancel()}>{status.state === "pending" ? "إلغاء والدفع بطريقة أخرى" : "رجوع"}</Button>
      </>}>
      <div className="pos-qr-pay">
        {gateway.mode === "test" && <p className="banner banner-warning pos-banner">البوابة مربوطة بمفتاح تجريبي: استخدم بطاقة اختبار، ولن يُحصَّل مبلغ حقيقي.</p>}
        {error != null ? (
          <>
            <FormError error={error} />
            <Button icon={<QrCode />} onClick={renewKey}>إعادة المحاولة</Button>
          </>
        ) : !intent || !img ? (
          <><Skeleton width="240px" height={240} /><p className="muted" aria-live="polite">جارٍ تجهيز رمز الدفع…</p></>
        ) : status.state === "paid_unfulfilled" ? (
          <p className="form-error" role="alert">{status.failure} أبلغ المدير: المبلغ وصل للبوابة، ويمكن استرجاعه من لوحتها.</p>
        ) : ended ? (
          <p className="form-error" role="alert">{status.state === "expired" ? "انتهت صلاحية صفحة الدفع." : status.state === "canceled" ? "أُلغيت عملية الدفع." : "لم تكتمل عملية الدفع (رُفضت البطاقة أو ألغاها العميل)."} أنشئ رمزاً جديداً أو ادفع بطريقة أخرى.</p>
        ) : (
          <>
            <img src={img} alt={`رمز QR لصفحة الدفع عبر ${name}`} className="pos-qr-img" />
            <p className="pos-qr-amount num">{money(intent.amount)}</p>
            <p aria-live="polite" className="muted">{offline ? "انقطع الاتصال مؤقتاً، نعيد المحاولة… الطلب لن يضيع." : "بانتظار دفع العميل… يُسجَّل البيع تلقائياً عند التأكيد."}</p>
            <a className="btn btn-ghost" href={intent.url} target="_blank" rel="noreferrer"><ExternalLink aria-hidden="true" /> فتح صفحة الدفع على هذا الجهاز</a>
          </>
        )}
      </div>
    </Dialog>
  );
}

// ── Split bill ────────────────────────────────────────────────────────────────
/** Pick what this guest pays (per line and quantity); the rest stays on the order for the next one. */
export function SplitDialog({ tenantId, ticket, names, onClose, onPay }: {
  tenantId: string; ticket: { items: Line[]; discount: Ticket["discount"] }; names: (l: Line) => string; onClose: () => void;
  onPay: (lines: { lineId: string; quantity: number }[], total: number) => void;
}) {
  const [take, setTake] = useState<Record<string, number>>({});
  const [guests, setGuests] = useState("2");
  const chosen = ticket.items.filter((l) => (take[l.id] ?? 0) > 0);
  const body = { items: chosen.map((l) => ({ recipeId: l.recipeId, quantity: take[l.id]!, modifiers: l.modifiers })), discount: ticket.discount?.type === "percent" ? ticket.discount : null };
  const quote = useQuery({ enabled: chosen.length > 0, queryKey: ["t", tenantId, "pos", "quote", "split", JSON.stringify(body)], placeholderData: keepPreviousData, retry: false,
    queryFn: () => api<{ total: number }>("POST", "/t/pos/quote", { tenant: tenantId, body }) });
  const amountDiscount = ticket.discount?.type === "amount";
  const everything = ticket.items.every((l) => (take[l.id] ?? 0) === l.quantity);
  /** Equal shares: one unit of each line per guest where it divides evenly; otherwise pick by hand. */
  function equalShare() {
    const n = Math.max(2, Math.round(Number(guests) || 2));
    setTake(Object.fromEntries(ticket.items.map((l) => [l.id, Math.floor(l.quantity / n)])));
  }
  return (
    <Dialog open wide onClose={onClose} title="تقسيم الفاتورة"
      footer={<><Button variant="primary" size="lg" disabled={!chosen.length || everything || amountDiscount || !quote.isSuccess || quote.isFetching}
        onClick={() => onPay(chosen.map((l) => ({ lineId: l.id, quantity: take[l.id]! })), quote.data!.total)}>
        {everything ? "اخترت الطلب كله: استخدم «الدفع»" : chosen.length ? `دفع المختار ${quote.data ? money(quote.data.total) : "…"}` : "اختر ما يدفعه هذا الضيف"}</Button><Button size="lg" onClick={onClose}>رجوع</Button></>}>
      {amountDiscount && <p className="banner banner-warning pos-banner">على الطلب خصم بمبلغ ثابت، ولا يُقسَّم. حوّله لنسبة مئوية من خانة الخصم ثم قسّم.</p>}
      <p className="muted">اختر أصناف هذا الضيف وكمياتها. ما لا تختاره يبقى على الطلب ليدفعه الضيف التالي.</p>
      <ul className="pos-split">
        {ticket.items.map((l) => {
          const q = take[l.id] ?? 0;
          return (
            <li key={l.id} className={q > 0 ? "is-on" : undefined}>
              <span className="pos-split-name"><strong>{names(l)}</strong>{l.note && <span className="muted"> · {l.note}</span>}<span className="muted num"> من {integer(l.quantity)}</span></span>
              <div className="qty">
                <Button aria-label={`تقليل ${names(l)}`} icon={<Minus />} disabled={q <= 0} onClick={() => setTake((t) => ({ ...t, [l.id]: q - 1 }))} />
                <output aria-live="polite">{q}</output>
                <Button aria-label={`زيادة ${names(l)}`} icon={<Plus />} disabled={q >= l.quantity} onClick={() => setTake((t) => ({ ...t, [l.id]: q + 1 }))} />
              </div>
              <Button size="sm" variant="ghost" onClick={() => setTake((t) => ({ ...t, [l.id]: q === l.quantity ? 0 : l.quantity }))}>{q === l.quantity ? "لا شيء" : "الكل"}</Button>
            </li>
          );
        })}
      </ul>
      <div className="pos-inline is-end">
        <TextField label="عدد الضيوف" numeric value={guests} onChange={(e) => setGuests(e.target.value.replace(/\D/g, ""))} className="pos-guests" />
        <Button onClick={equalShare}>حصة ضيف واحد بالتساوي</Button>
      </div>
      {quote.isError && <FormError error={quote.error} />}
    </Dialog>
  );
}

// ── Receipt ───────────────────────────────────────────────────────────────────
interface OrderDetail {
  id: string; number: number; channel: Channel; subtotal: number; discount: number; vat: number; total: number; createdAt: string; tableName: string | null;
  customerFullName: string | null; customerName: string | null; guests: number | null; platformName: string | null; externalRef: string | null;
  items: { name: string; quantity: number; unitPriceNet: number; lineTotal: number; modifiers: string[]; note: string | null }[];
  payments: { method: string; amount: number }[]; invoices: { kind: string; icv: number; qr: string | null }[];
}

/** An 80 mm simplified tax invoice, as printed for the customer. */
export function ReceiptDialog({ tenantId, orderId, change, onClose, fresh, partial }: { tenantId: string; orderId: string; change?: number; onClose: () => void; fresh?: boolean; partial?: boolean }) {
  const { ctx } = useTenant();
  const o = useQuery({ queryKey: ["t", tenantId, "orders", orderId, "receipt"], queryFn: () => api<OrderDetail>("GET", `/t/pos/orders/${orderId}`, { tenant: tenantId }) });
  const [img, setImg] = useState<string | null>(null);
  const qr = o.data?.invoices.find((i) => i.kind === "simplified_invoice")?.qr ?? null;
  useEffect(() => { if (qr) QRCode.toDataURL(qr, { margin: 1, width: 320, errorCorrectionLevel: "M" }).then(setImg).catch(() => setImg(null)); }, [qr]);
  const d = o.data;
  return (
    <Dialog open onClose={onClose} title={d ? `${fresh ? "تم البيع · " : ""}طلب رقم ${d.number}` : "الفاتورة"}
      footer={<><Button variant="primary" size="lg" onClick={onClose} autoFocus>{partial ? "متابعة الطلب" : fresh ? "طلب جديد" : "إغلاق"}</Button><Button size="lg" icon={<Printer />} disabled={!d} onClick={() => window.print()}>طباعة الفاتورة</Button>
        {d && <Link to={`/w/${tenantId}/orders/${d.id}`} className="btn btn-ghost btn-lg">تفاصيل واسترجاع</Link>}</>}>
      {change ? <p className="pos-change-big" role="status">الفكّة للعميل: <strong className="num">{money(change)}</strong></p> : null}
      {o.isPending ? <Skeleton width="60%" /> : o.isError ? <ErrorState error={o.error} onRetry={() => o.refetch()} /> : d && (
        <div className="receipt print-area">
          <div className="receipt-head">
            <strong>{ctx.tenant.companyName}</strong>
            <span>الرقم الضريبي <span className="num">{ctx.tenant.taxId}</span></span>
            <span>فاتورة ضريبية مبسطة</span>
          </div>
          <div className="receipt-meta">
            <span>طلب <span className="num">{integer(Number(d.number))}</span></span><span className="num">{dayTime(d.createdAt)}</span>
            <span>{CHANNEL_LABELS[d.channel]}{d.tableName ? ` · طاولة ${d.tableName}` : ""}{d.platformName ? ` · ${d.platformName} ${d.externalRef ?? ""}` : ""}</span>
            {(d.customerFullName || d.customerName) && <span>العميل: {d.customerFullName ?? d.customerName}</span>}
          </div>
          <table className="receipt-lines">
            <tbody>
              {d.items.map((i, n) => (
                <tr key={n}>
                  <td className="num">{integer(i.quantity)}×</td>
                  <td>{i.name}{i.modifiers.length > 0 && <div className="receipt-sub">{i.modifiers.join("، ")}</div>}{i.note && <div className="receipt-sub">* {i.note}</div>}</td>
                  <td className="num end">{money(i.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="receipt-totals">
            <dt>الإجمالي قبل الضريبة</dt><dd className="num">{money(d.subtotal)}</dd>
            {d.discount > 0 && <><dt>الخصم</dt><dd className="num">− {money(d.discount)}</dd></>}
            <dt>ضريبة القيمة المضافة</dt><dd className="num">{money(d.vat)}</dd>
            <dt className="is-grand">الإجمالي شامل الضريبة</dt><dd className="num is-grand">{money(d.total)}</dd>
            {d.payments.map((p, n) => <Fragment key={`m${n}`}><dt>{METHOD_LABELS[p.method] ?? p.method}</dt><dd className="num">{money(p.amount)}</dd></Fragment>)}
            {change ? <><dt>الفكّة</dt><dd className="num">{money(change)}</dd></> : null}
          </dl>
          {img ? <img src={img} alt="رمز QR للفاتورة الضريبية المبسطة" /> : qr ? <Skeleton width="160px" /> : null}
          <p className="receipt-foot">شكراً لزيارتكم</p>
        </div>
      )}
    </Dialog>
  );
}

// ── Shift ─────────────────────────────────────────────────────────────────────
interface XReport {
  status: string; openedAt: string; ordersCount: number; salesTotal: number; discounts: number; vat: number; netSales: number; guests: number; discountedOrders: number;
  byMethod: { method: string; amount: number | null; count: number }[]; byChannel: { channel: string; count: number; total: number }[];
  topItems: { name: string; quantity: number; total: number }[]; openTickets: number;
  refunds: { count: number; amount: number; cash: number | null }; openingFloat: number | null; expectedCash: number | null; blind: boolean;
}

/** X report: the shift so far. A cashier's own count stays blind (no cash figures until closing). */
export function XReportDialog({ tenantId, shiftId, onClose }: { tenantId: string; shiftId: string; onClose: () => void }) {
  const r = useQuery({ queryKey: ["t", tenantId, "pos", "x", shiftId], queryFn: () => api<XReport>("GET", `/t/pos/shifts/${shiftId}/summary`, { tenant: tenantId }) });
  const d = r.data;
  return (
    <Dialog open wide onClose={onClose} title="تقرير الشفت حتى الآن (X)"
      footer={<><Button variant="primary" onClick={onClose}>إغلاق</Button><Button icon={<Printer />} disabled={!d} onClick={() => window.print()}>طباعة</Button></>}>
      {r.isPending ? <Skeleton width="60%" /> : r.isError ? <ErrorState error={r.error} onRetry={() => r.refetch()} /> : d && (
        <div className="stack print-area pos-x">
          <div className="pos-x-kpis">
            <div><span>المبيعات</span><strong className="num">{money(d.salesTotal)}</strong></div>
            <div><span>الطلبات</span><strong className="num">{integer(d.ordersCount)}</strong></div>
            <div><span>متوسط الطلب</span><strong className="num">{money(d.ordersCount ? d.salesTotal / d.ordersCount : 0)}</strong></div>
            <div><span>الخصومات</span><strong className="num">{money(d.discounts)}</strong></div>
          </div>
          {d.openTickets > 0 && <p className="banner banner-warning pos-banner">{integer(d.openTickets)} طلب مفتوح لم يُدفع بعد في هذا الموقع.</p>}
          <section className="stack"><h3>طرق الدفع</h3>
            <dl className="dl">{d.byMethod.length === 0 ? <><dt>لا مدفوعات بعد</dt><dd /></> : d.byMethod.map((m) => <Fragment key={`k${m.method}`}><dt>{METHOD_LABELS[m.method] ?? m.method} <span className="muted">({integer(m.count)})</span></dt><dd className="num">{m.amount === null ? "يظهر عند الإغلاق" : money(m.amount)}</dd></Fragment>)}</dl>
          </section>
          <section className="stack"><h3>القنوات</h3>
            <dl className="dl">{d.byChannel.map((c) => <Fragment key={`k${c.channel}`}><dt>{CHANNEL_LABELS[c.channel]} <span className="muted">({integer(c.count)})</span></dt><dd className="num">{money(c.total)}</dd></Fragment>)}</dl>
          </section>
          <section className="stack"><h3>الاسترجاعات</h3>
            <dl className="dl"><dt>العدد</dt><dd className="num">{integer(d.refunds.count)}</dd><dt>المبلغ</dt><dd className="num">{money(d.refunds.amount)}</dd></dl>
          </section>
          {d.topItems.length > 0 && <section className="stack"><h3>الأكثر مبيعاً</h3>
            <dl className="dl">{d.topItems.map((t) => <Fragment key={`k${t.name}`}><dt>{t.name} <span className="muted num">×{integer(t.quantity)}</span></dt><dd className="num">{money(t.total)}</dd></Fragment>)}</dl>
          </section>}
          {d.blind ? <p className="muted">أرقام النقد تظهر بعد إغلاق الشفت، حتى يكون عدّ الدرج مستقلاً.</p>
            : <dl className="dl"><dt>العهدة الافتتاحية</dt><dd className="num">{money(d.openingFloat)}</dd><dt>النقد المتوقع في الدرج</dt><dd className="num"><strong>{money(d.expectedCash)}</strong></dd></dl>}
        </div>
      )}
    </Dialog>
  );
}

interface ShiftOrder { id: string; number: number; channel: Channel; status: string; total: number; createdAt: string; tableName: string | null; itemsCount: number }

/** This shift's sales, newest first: reprint a receipt or open the order to refund it. */
export function ShiftOrdersDialog({ tenantId, shiftId, onClose, onReprint }: { tenantId: string; shiftId: string; onClose: () => void; onReprint: (orderId: string) => void }) {
  const list = useQuery({ queryKey: ["t", tenantId, "orders", { shiftId }], queryFn: () => api<Page<ShiftOrder>>("GET", "/t/pos/orders", { tenant: tenantId, query: { shiftId, pageSize: 50 } }) });
  return (
    <Dialog open wide onClose={onClose} title="طلبات الشفت" footer={<Button onClick={onClose}>إغلاق</Button>}>
      {list.isPending ? <Skeleton width="60%" /> : list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} />
        : list.data.items.length === 0 ? <EmptyState title="لا طلبات بعد في هذا الشفت">أول بيع تسجله يظهر هنا.</EmptyState> : (
          <ul className="pos-orders">
            {list.data.items.map((o) => (
              <li key={o.id}>
                <span className="pos-orders-no num">#{integer(Number(o.number))}</span>
                <span className="pos-orders-who"><strong>{CHANNEL_LABELS[o.channel]}{o.tableName ? ` · طاولة ${o.tableName}` : ""}</strong><span className="muted num">{time(o.createdAt)} · {integer(o.itemsCount)} صنف</span></span>
                {o.status !== "paid" && <Badge tone="warning">{o.status === "refunded" ? "مسترجع" : "مسترجع جزئياً"}</Badge>}
                <strong className="num">{money(o.total)}</strong>
                <Button size="sm" icon={<Printer />} onClick={() => onReprint(o.id)}>إعادة طباعة</Button>
              </li>
            ))}
          </ul>
        )}
    </Dialog>
  );
}

export function CloseShift({ tenantId, shiftId, openTickets, onClose, onClosed }: { tenantId: string; shiftId: string; openTickets: number; onClose: () => void; onClosed: () => void }) {
  const toast = useToast();
  const [counted, setCounted] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<{ expectedCash: number; countedCash: number; overShort: number } | null>(null);
  async function submit() {
    if (counted.trim() === "" || !(Number(counted) >= 0)) return setError("أدخل النقد الذي عددته في الدرج، بالأرقام");
    setBusy(true); setError(null);
    try {
      const r = await api<{ expectedCash: number; countedCash: number; overShort: number }>("POST", `/t/pos/shifts/${shiftId}/close`, { tenant: tenantId, body: { countedCash: Number(counted) } });
      setResult(r);
      toast.success("تم إغلاق الشفت");
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  if (result) {
    return (
      <Dialog open onClose={() => { onClose(); onClosed(); }} title="ملخص إغلاق الشفت" footer={<><Button variant="primary" onClick={() => { onClose(); onClosed(); }} autoFocus>تم</Button><Button icon={<Printer />} onClick={() => window.print()}>طباعة</Button></>}>
        <dl className="dl print-area">
          <dt>النقد المتوقع</dt><dd className="num">{money(result.expectedCash)}</dd>
          <dt>النقد المعدود</dt><dd className="num">{money(result.countedCash)}</dd>
          <dt>{result.overShort === 0 ? "مطابق" : result.overShort > 0 ? "زيادة" : "عجز"}</dt>
          <dd className={["num pos-overshort", result.overShort < 0 && "is-short"].filter(Boolean).join(" ")}>{money(Math.abs(result.overShort))}</dd>
        </dl>
      </Dialog>
    );
  }
  return (
    <Dialog open onClose={onClose} busy={busy} title="إغلاق الشفت" onSubmit={() => void submit()}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الإغلاق…">إغلاق الشفت</Button><Button onClick={onClose} disabled={busy}>متابعة البيع</Button></>}>
      {openTickets > 0 && <p className="banner banner-warning pos-banner">يوجد {integer(openTickets)} طلب مفتوح لم يُدفع. يبقى مفتوحاً للشفت التالي، ويُحسب على من يحصّله.</p>}
      <p>عُدّ النقد في الدرج وأدخله. يُعرض المتوقع والعجز أو الزيادة بعد الإغلاق، حتى يكون العدّ مستقلاً.</p>
      <TextField label={`النقد المعدود في الدرج (${RIYAL})`} required numeric autoFocus value={counted} onChange={(e) => setCounted(e.target.value)} />
      <FormError error={error} />
    </Dialog>
  );
}

// ── Open orders, void, merge, shortcuts ───────────────────────────────────────
/** Every open order of this location, searchable: for when the tabs do not fit (phones, a busy lunch). */
export function OpenTicketsDialog({ tickets, activeId, now, onClose, onOpen, onNew }: {
  tickets: Ticket[]; activeId: string | null; now: number; onClose: () => void; onOpen: (id: string) => void; onNew: () => void;
}) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const s = q.trim();
    return tickets.filter((t) => !s || ticketName(t).includes(s) || String(t.number).includes(s) || (t.customerPhone ?? "").includes(s) || (t.tableName ?? "").includes(s));
  }, [tickets, q]);
  return (
    <Dialog open wide onClose={onClose} title={`الطلبات المفتوحة (${integer(tickets.length)})`} footer={<><Button variant="primary" icon={<Plus />} onClick={onNew}>طلب جديد</Button><Button onClick={onClose}>إغلاق</Button></>}>
      <TextField label="بحث" optional value={q} onChange={(e) => setQ(e.target.value)} placeholder="الاسم، الطاولة، رقم الطلب أو الجوال" autoFocus />
      {shown.length === 0 ? <EmptyState kind={q ? "filtered" : undefined} title={q ? "لا طلب مطابق" : "لا توجد طلبات مفتوحة"}>{q ? "جرّب اسماً أو رقماً آخر." : "ابدأ طلباً جديداً وسيظهر هنا حتى يُدفع."}</EmptyState> : (
        <div className="pos-open-grid">
          {shown.map((t) => (
            <button key={t.id} type="button" className="pos-open-card" data-hue={t.channel === "dine_in" ? "indigo" : t.channel === "delivery" ? "orange" : "green"} aria-pressed={t.id === activeId} onClick={() => onOpen(t.id)}>
              <span className="pos-open-top"><strong>{ticketName(t)}</strong><span className="muted num">T-{t.number}</span></span>
              <span className="muted">{CHANNEL_LABELS[t.channel]} · {integer(t.count)} صنف · منذ {elapsed(t.createdAt, now)}</span>
              <span className="pos-open-foot">
                <strong className="num">{t.totals ? money(t.totals.total) : "—"}</strong>
                {t.unsent > 0 ? <Badge tone="warning">{integer(t.unsent)} لم يُرسل للمطبخ</Badge> : t.kitchenRounds > 0 ? <Badge tone="success">في المطبخ</Badge> : null}
              </span>
            </button>
          ))}
        </div>
      )}
    </Dialog>
  );
}

/** Cancel an order, or reduce what the kitchen already has: a reason, and a manager when the kitchen is involved. */
export function ReasonDialog({ title, message, confirmLabel, needsManager, canManage, reasonRequired, busy, error, onClose, onConfirm }: {
  title: string; message: string; confirmLabel: string; needsManager: boolean; canManage: boolean; reasonRequired: boolean; busy: boolean; error: unknown;
  onClose: () => void; onConfirm: (reason: string | null) => void;
}) {
  const [reason, setReason] = useState("");
  const blocked = needsManager && !canManage;
  return (
    <Dialog open onClose={onClose} busy={busy} title={title}
      footer={<><Button autoFocus onClick={onClose} disabled={busy}>تراجع</Button>
        <Button variant="danger" loading={busy} loadingText="جارٍ التنفيذ…" disabled={blocked || (reasonRequired && reason.trim().length < 3)} onClick={() => onConfirm(reason.trim() || null)}>{confirmLabel}</Button></>}>
      <p>{message}</p>
      {blocked ? <p className="banner banner-warning pos-banner">هذا الإجراء يحتاج مديراً لأن المطبخ استلم الأصناف. اطلب من المدير تنفيذه من حسابه.</p> : (
        <TextField label="السبب" required={reasonRequired} optional={!reasonRequired} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="العميل غيّر رأيه، طلب مكرر…" />
      )}
      <FormError error={error} />
    </Dialog>
  );
}

export function MergeDialog({ tickets, current, onClose, onPick }: { tickets: Ticket[]; current: string; onClose: () => void; onPick: (id: string) => void }) {
  const others = tickets.filter((t) => t.id !== current);
  return (
    <Dialog open onClose={onClose} title="دمج مع طلب آخر" footer={<Button onClick={onClose}>إلغاء</Button>}>
      <p className="muted">تنتقل أصناف هذا الطلب إلى الطلب الذي تختاره، ويُغلق هذا الطلب. ما وصل للمطبخ يبقى كما هو.</p>
      {others.length === 0 ? <EmptyState title="لا يوجد طلب مفتوح آخر" /> : (
        <ul className="pos-found">
          {others.map((t) => (
            <li key={t.id}><button type="button" className="pos-found-item" onClick={() => onPick(t.id)}>
              <span className="pos-found-who"><strong>{ticketName(t)}</strong><span className="muted num">T-{t.number} · {integer(t.count)} صنف</span></span>
              <span className="num">{t.totals ? money(t.totals.total) : "—"}</span>
            </button></li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

export const SHORTCUTS: [string, string][] = [
  ["F2 أو /", "البحث عن صنف (والمسح بالباركود)"],
  ["Enter في البحث", "إضافة الصنف المطابق"],
  ["F4", "طلب جديد"],
  ["Alt + 1…9", "التنقل بين الطلبات المفتوحة"],
  ["F8", "إرسال للمطبخ"],
  ["F9", "الدفع"],
  ["Esc", "إغلاق النافذة"],
];
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog open onClose={onClose} title="اختصارات لوحة المفاتيح" footer={<Button variant="primary" onClick={onClose}>تم</Button>}>
      <dl className="dl pos-keys">{SHORTCUTS.map(([k, v]) => <Fragment key={`k${k}`}><dt><kbd>{k}</kbd></dt><dd>{v}</dd></Fragment>)}</dl>
    </Dialog>
  );
}
