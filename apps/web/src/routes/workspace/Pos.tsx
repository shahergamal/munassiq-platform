import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ChefHat, ClipboardList, Keyboard, LayoutGrid, Minus, MoreHorizontal, Plus, ReceiptText, ShoppingBag, SplitSquareHorizontal, Store,
  Trash2, UtensilsCrossed, Wallet, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type Page } from "../../api/client";
import type { Location } from "../../api/types";
import { useIdempotencyKey } from "../../app/session";
import { useInvalidate, useTenant } from "../../app/tenant";
import { RIYAL, dayTime, integer, money, percent } from "../../lib/format";
import { Button, IconButton } from "../../ui/Button";
import { SearchInput, TextField } from "../../ui/Field";
import { ActionMenu } from "../../ui/Layout";
import { EmptyState, ErrorState, FormError, Skeleton } from "../../ui/States";
import { CHANNEL_LABELS } from "../../ui/status";
import { useToast } from "../../ui/Toast";
import { beep } from "../../ui/Scanner";
import {
  type Area, type Channel, CloseShift, type CustomerRef, CustomerPicker, elapsed, type Line, MergeDialog, type MenuItem, ModifierDialog, OpenTicketsDialog,
  PaymentDialog, type Platform, ReasonDialog, ReceiptDialog, type SaleResult, ShiftOrdersDialog, ShortcutsDialog, SplitDialog, TableDialog, type Ticket,
  ticketName, XReportDialog,
} from "./PosDialogs";

interface Shift { id: string; openedAt: string; openingFloat: number; ordersCount: number }
interface Quote { subtotal: number; discount: number; taxable: number; vat: number; total: number; vatRatePercent: number; lines: { recipeId: string; total: number; modifiers: string[] }[] }

type Hue = "indigo" | "sky" | "green" | "amber" | "red" | "violet" | "orange";
/** Same channel colours as the dashboard; category tints only identify the kind, never a status. */
const CHANNEL_HUE: Record<Channel, Hue> = { dine_in: "indigo", takeaway: "green", delivery: "orange" };
const CAT_CYCLE: Hue[] = ["indigo", "sky", "green", "orange", "violet"];

const LOC_KEY = (t: string) => `mn.pos.location.${t}`;
const readLoc = (t: string) => { try { return localStorage.getItem(LOC_KEY(t)) ?? ""; } catch { return ""; } };
const saveLoc = (t: string, v: string) => { try { localStorage.setItem(LOC_KEY(t), v); } catch { /* private mode */ } };

export function PosPage() {
  const { tenantId, writable } = useTenant();
  const locations = useQuery({ queryKey: ["t", tenantId, "locations", "options", "active"], queryFn: () => api<Page<Location>>("GET", "/t/locations", { tenant: tenantId, query: { isActive: "true", pageSize: 100 } }) });
  const [locationId, setLocationId] = useState(() => readLoc(tenantId));

  useEffect(() => {
    const items = locations.data?.items;
    if (!items) return;
    // Sales happen in a kitchen, not a warehouse: prefer a kitchen when nothing valid is remembered.
    if (!items.some((l) => l.id === locationId)) setLocationId((items.find((l) => l.locationType === "kitchen") ?? items[0])?.id ?? "");
  }, [locations.data, locationId]);

  if (locations.isPending) return <div className="page"><Skeleton width="40%" /></div>;
  if (locations.isError) return <div className="page"><ErrorState error={locations.error} onRetry={() => locations.refetch()} /></div>;
  if (!locations.data.items.length) {
    return <div className="page"><EmptyState title="لا يوجد موقع بيع" action={<Link to={`/w/${tenantId}/locations`} className="btn btn-primary">إضافة مطبخ أو موقع</Link>}>الكاشير يبيع من مطبخ أو موقع له رصيد مخزون. أضف موقعاً أولاً.</EmptyState></div>;
  }
  if (!writable) return <div className="page"><EmptyState kind="permission" title="البيع متوقف">المنشأة غير مفعّلة أو أنت في جلسة دعم للقراءة فقط، لذا لا يمكن تسجيل مبيعات.</EmptyState></div>;
  if (!locations.data.items.some((l) => l.id === locationId)) return <div className="page"><Skeleton width="40%" /></div>;
  return <Terminal key={locationId} tenantId={tenantId} locations={locations.data.items} locationId={locationId} onLocation={(id) => { saveLoc(tenantId, id); setLocationId(id); }} />;
}

function Terminal({ tenantId, locations, locationId, onLocation }: { tenantId: string; locations: Location[]; locationId: string; onLocation: (id: string) => void }) {
  const invalidate = useInvalidate(tenantId);
  const shift = useQuery({ queryKey: ["t", tenantId, "pos", "shift", locationId], queryFn: () => api<{ shift: Shift | null }>("GET", "/t/pos/shift", { tenant: tenantId, query: { locationId } }) });
  const menu = useQuery({ enabled: Boolean(shift.data?.shift), queryKey: ["t", tenantId, "pos", "menu", locationId], refetchInterval: 60_000,
    queryFn: () => api<{ items: MenuItem[] }>("GET", "/t/pos/menu", { tenant: tenantId, query: { locationId } }) });
  const [panel, setPanel] = useState<"close" | "x" | "orders" | "keys" | null>(null);
  const [reprint, setReprint] = useState<string | null>(null);
  const [openCount, setOpenCount] = useState(0);
  const locName = locations.find((l) => l.id === locationId)?.name ?? "";
  const s = shift.data?.shift;

  const header = (
    <div className="pos-bar panel">
      <span className="pos-bar-icon tone-indigo" aria-hidden="true"><Store /></span>
      {locations.length > 1
        ? <label className="pos-bar-loc"><span className="pos-bar-label">الموقع</span><select className="select" value={locationId} onChange={(e) => onLocation(e.target.value)}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
        : <div className="pos-bar-loc"><span className="pos-bar-label">الموقع</span><strong>{locName}</strong></div>}
      <span className="spacer" />
      {s && <>
        <span className="pos-shift"><span className="pos-shift-dot" aria-hidden="true" />شفت منذ {dayTime(s.openedAt)} · {integer(s.ordersCount)} طلب</span>
        <span className="pos-bar-actions">
          <Button icon={<ReceiptText />} onClick={() => setPanel("orders")}>طلبات الشفت</Button>
          <Button icon={<ClipboardList />} onClick={() => setPanel("x")}>تقرير X</Button>
          <IconButton label="اختصارات لوحة المفاتيح" icon={<Keyboard />} onClick={() => setPanel("keys")} className="only-wide" />
          <Button onClick={() => setPanel("close")}>إغلاق الشفت</Button>
        </span>
        <span className="pos-bar-menu">
          <ActionMenu label="إجراءات الشفت" trigger={<MoreHorizontal />} items={[
            { label: "طلبات الشفت وإعادة الطباعة", onSelect: () => setPanel("orders") },
            { label: "تقرير الشفت (X)", onSelect: () => setPanel("x") },
            { label: "إغلاق الشفت", onSelect: () => setPanel("close"), separated: true },
          ]} />
        </span>
      </>}
    </div>
  );

  const title = <h1 className="sr-only">نقطة البيع · {locName}</h1>;

  if (shift.isPending) return <div className="pos-wrap">{title}{header}<div className="panel pos-state"><Skeleton width="30%" /></div></div>;
  if (shift.isError) return <div className="pos-wrap">{title}{header}<div className="panel pos-state"><ErrorState error={shift.error} onRetry={() => shift.refetch()} /></div></div>;
  if (!s) return <div className="pos-wrap">{header}<OpenShift tenantId={tenantId} locationId={locationId} locName={locName} onOpened={() => invalidate("pos")} /></div>;

  return (
    <div className="pos-wrap">
      {title}
      {header}
      <Sale tenantId={tenantId} locationId={locationId} shiftId={s.id} menu={menu} onOpenCount={setOpenCount} onShortcuts={() => setPanel("keys")}
        onSold={() => invalidate("pos", "ingredients", "stock", "reports", "orders")} />
      {panel === "close" && <CloseShift tenantId={tenantId} shiftId={s.id} openTickets={openCount} onClose={() => setPanel(null)} onClosed={() => invalidate("pos", "shifts")} />}
      {panel === "x" && <XReportDialog tenantId={tenantId} shiftId={s.id} onClose={() => setPanel(null)} />}
      {panel === "keys" && <ShortcutsDialog onClose={() => setPanel(null)} />}
      {panel === "orders" && <ShiftOrdersDialog tenantId={tenantId} shiftId={s.id} onClose={() => setPanel(null)} onReprint={(id) => { setPanel(null); setReprint(id); }} />}
      {reprint && <ReceiptDialog tenantId={tenantId} orderId={reprint} onClose={() => setReprint(null)} />}
    </div>
  );
}

function OpenShift({ tenantId, locationId, locName, onOpened }: { tenantId: string; locationId: string; locName: string; onOpened: () => void }) {
  const [float, setFloat] = useState("");
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [key] = useIdempotencyKey();
  async function open() {
    const n = Number(float || "0");
    if (!(n >= 0)) return setErr("أدخل مبلغ العهدة النقدية بالأرقام (صفر إن لم توجد)");
    setBusy(true); setErr(null);
    try { await api("POST", "/t/pos/shifts/open", { tenant: tenantId, idempotencyKey: key, body: { locationId, openingFloat: n } }); onOpened(); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <div className="pos-open">
      <form className="panel panel-pad form-section" noValidate onSubmit={(e) => { e.preventDefault(); void open(); }}>
        <span className="pos-open-icon tone-green" aria-hidden="true"><Wallet /></span>
        <div className="stack"><h1 className="pos-open-title">فتح شفت في {locName}</h1><p className="muted">عُدّ النقد الموجود في الدرج قبل البدء. عند الإغلاق ستعدّ النقد مرة أخرى.</p></div>
        <TextField label={`العهدة النقدية في الدرج (${RIYAL})`} numeric autoFocus value={float} onChange={(e) => setFloat(e.target.value)} placeholder="0" />
        <FormError error={err} />
        <Button type="submit" variant="primary" size="lg" loading={busy} loadingText="جارٍ فتح الشفت…">فتح الشفت والبدء بالبيع</Button>
      </form>
    </div>
  );
}

// ── The order being edited ────────────────────────────────────────────────────
interface Draft {
  id: string | null; version: number; number: number | null; createdAt: string | null; clientKey: string;
  label: string; channel: Channel; tableId: string | null; tableName: string | null; guests: string;
  customer: CustomerRef | null; platformId: string; externalRef: string;
  discountOn: boolean; discount: { type: "percent" | "amount"; value: string; reason: string };
  notes: string; items: Line[];
}
const emptyDraft = (): Draft => ({
  id: null, version: 0, number: null, createdAt: null, clientKey: crypto.randomUUID(), label: "", channel: "takeaway", tableId: null, tableName: null, guests: "",
  customer: null, platformId: "", externalRef: "", discountOn: false, discount: { type: "percent", value: "", reason: "" }, notes: "", items: [],
});
const fromTicket = (t: Ticket): Draft => ({
  id: t.id, version: t.version, number: t.number, createdAt: t.createdAt, clientKey: t.id, label: t.label ?? "", channel: t.channel, tableId: t.tableId, tableName: t.tableName,
  guests: t.guests ? String(t.guests) : "", customer: t.customerId ? { id: t.customerId, name: t.customerName ?? "", phone: t.customerPhone ?? "" } : null,
  platformId: t.platformId ?? "", externalRef: t.externalRef ?? "", discountOn: Boolean(t.discount),
  discount: t.discount ? { type: t.discount.type, value: String(t.discount.value), reason: t.discountReason ?? "" } : { type: "percent", value: "", reason: "" },
  notes: t.notes ?? "", items: t.items.map(({ id, recipeId, quantity, modifiers, note, sent }) => ({ id, recipeId, quantity, modifiers, note, sent })),
});
/** What the server stores: ids and quantities only; every price is decided there. */
const payload = (d: Draft) => {
  const v = Number(d.discount.value);
  return {
    label: d.label.trim() || null, channel: d.channel, tableId: d.channel === "dine_in" ? d.tableId : null, guests: d.channel === "dine_in" && d.guests ? Number(d.guests) : null,
    customerId: d.customer?.id ?? null, platformId: d.channel === "delivery" && d.platformId ? d.platformId : null,
    externalRef: d.channel === "delivery" && d.platformId ? d.externalRef.trim() || null : null,
    discount: d.discountOn && v > 0 ? { type: d.discount.type, value: v } : null, discountReason: d.discountOn && v > 0 ? d.discount.reason.trim() || null : null,
    notes: d.notes.trim() || null, items: d.items.map(({ id, recipeId, quantity, modifiers, note }) => ({ id, recipeId, quantity, modifiers, note })),
  };
};
const sameLine = (a: { recipeId: string; modifiers: string[]; note: string | null }, b: typeof a) =>
  a.recipeId === b.recipeId && (a.note ?? "") === (b.note ?? "") && [...a.modifiers].sort().join() === [...b.modifiers].sort().join();

type SaveState = "idle" | "saving" | "saved" | "error";

function Sale({ tenantId, locationId, shiftId, menu, onSold, onOpenCount, onShortcuts }: {
  tenantId: string; locationId: string; shiftId: string; menu: ReturnType<typeof useQuery<{ items: MenuItem[] }>>;
  onSold: () => void; onOpenCount: (n: number) => void; onShortcuts: () => void;
}) {
  const { can } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const ticketsKey = useMemo(() => ["t", tenantId, "pos", "tickets", locationId], [tenantId, locationId]);
  const tickets = useQuery({ queryKey: ticketsKey, refetchInterval: 15_000, queryFn: () => api<{ items: Ticket[]; serverTime: string }>("GET", "/t/pos/tickets", { tenant: tenantId, query: { locationId } }) });
  const open = tickets.data?.items ?? [];
  useEffect(() => onOpenCount(open.length), [open.length, onOpenCount]);

  const [draft, setDraftState] = useState<Draft>(emptyDraft);
  const draftRef = useRef(draft);
  const baseRef = useRef(JSON.stringify(payload(draft)));
  const inFlight = useRef<Promise<void> | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<unknown>(null);
  const setDraft = useCallback((fn: (d: Draft) => Draft) => { setDraftState((d) => { const n = fn(d); draftRef.current = n; return n; }); }, []);
  const load = useCallback((d: Draft) => { draftRef.current = d; baseRef.current = JSON.stringify(payload(d)); setDraftState(d); setSaveState("idle"); setSaveError(null); }, []);
  const dirty = JSON.stringify(payload(draft)) !== baseRef.current;

  const [cat, setCat] = useState("");
  const [q, setQ] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const [choosing, setChoosing] = useState<MenuItem | null>(null);
  const [dialog, setDialog] = useState<"tables" | "pay" | "split" | "all" | "merge" | "void" | null>(null);
  const [splitPay, setSplitPay] = useState<{ lines: { lineId: string; quantity: number }[]; total: number } | null>(null);
  const [lineVoid, setLineVoid] = useState<{ line: Line; to: number } | null>(null);
  const [receipt, setReceipt] = useState<{ orderId: string; change: number; partial: boolean } | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<"send" | "void" | "merge" | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [chit, setChit] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  // Kitchen chit: rendered only while printing it, so other printouts (receipt, X report) never include it.
  useEffect(() => {
    if (!chit) return;
    const r = requestAnimationFrame(() => { window.print(); setChit(false); });
    return () => cancelAnimationFrame(r);
  }, [chit]);

  const items = menu.data?.items ?? [];
  const byId = useMemo(() => new Map(items.map((m) => [m.id, m])), [items]);
  const optName = useMemo(() => new Map(items.flatMap((m) => m.modifierGroups.flatMap((g) => g.options.map((o) => [o.id, o.name] as const)))), [items]);
  const optGross = useMemo(() => new Map(items.flatMap((m) => m.modifierGroups.flatMap((g) => g.options.map((o) => [o.id, o.priceGross] as const)))), [items]);
  const cats = useMemo(() => [...new Set(items.map((m) => m.category ?? "أخرى"))], [items]);
  const term = q.trim();
  const shown = items.filter((m) => (!cat || (m.category ?? "أخرى") === cat) && (!term || m.name.includes(term) || m.code.toLowerCase().includes(term.toLowerCase())));
  const areas = useQuery({ enabled: draft.channel === "dine_in" || dialog === "tables", queryKey: ["t", tenantId, "pos", "areas", locationId], queryFn: () => api<{ items: Area[] }>("GET", "/t/dining-areas", { tenant: tenantId, query: { locationId } }), refetchInterval: 20_000 });
  const platforms = useQuery({ enabled: draft.channel === "delivery", queryKey: ["t", tenantId, "pos", "platforms"], queryFn: () => api<{ items: Platform[] }>("GET", "/t/delivery-platforms", { tenant: tenantId }) });
  const platform = platforms.data?.items.find((p) => p.id === draft.platformId);
  const nameOf = (l: Line) => byId.get(l.recipeId)?.name ?? l.name ?? "صنف";

  // ── Server copy: save, adopt, reload ──
  const adopt = useCallback((t: Ticket, sentJSON: string) => {
    const cur = draftRef.current;
    const stillSame = JSON.stringify(payload(cur)) === sentJSON;
    const merged: Draft = stillSame ? fromTicket(t) : {
      ...cur, id: t.id, version: t.version, number: t.number, createdAt: t.createdAt, clientKey: t.id,
      items: cur.items.map((l) => ({ ...l, sent: t.items.find((x) => x.id === l.id)?.sent ?? l.sent })),
    };
    draftRef.current = merged;
    baseRef.current = sentJSON;
    setDraftState(merged);
    qc.setQueryData<{ items: Ticket[]; serverTime: string }>(ticketsKey, (old) => old && ({ ...old, items: [...old.items.filter((x) => x.id !== t.id), t].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) }));
  }, [qc, ticketsKey]);

  const saveNow = useCallback(async (): Promise<void> => {
    if (inFlight.current) { await inFlight.current; }
    const d = draftRef.current;
    const body = payload(d);
    const sentJSON = JSON.stringify(body);
    if (sentJSON === baseRef.current || (!d.id && !d.items.length)) return;
    setSaveState("saving");
    const run = (async () => {
      try {
        const t = d.id
          ? await api<Ticket>("PUT", `/t/pos/tickets/${d.id}`, { tenant: tenantId, body: { ...body, version: d.version } })
          : await api<Ticket>("POST", "/t/pos/tickets", { tenant: tenantId, idempotencyKey: d.clientKey, body: { ...body, locationId } });
        if (draftRef.current.clientKey !== d.clientKey && draftRef.current.id !== d.id) return; // switched away meanwhile
        adopt(t, sentJSON);
        setSaveState("saved"); setSaveError(null);
      } catch (e) {
        if (e instanceof ApiError && e.code === "ticket_stale") {
          toast.error("عُدّل هذا الطلب من جهاز آخر، فعرضنا آخر نسخة منه");
          const fresh = await api<Ticket>("GET", `/t/pos/tickets/${d.id}`, { tenant: tenantId }).catch(() => null);
          if (fresh && draftRef.current.id === d.id) load(fromTicket(fresh));
          void tickets.refetch();
        } else if (e instanceof ApiError && e.code === "ticket_closed") {
          toast.error("هذا الطلب أُغلق من جهاز آخر");
          load(emptyDraft());
          void tickets.refetch();
        } else if (e instanceof ApiError && e.code === "table_busy") {
          setSaveState("error"); setSaveError(e);
          setDraft((x) => ({ ...x, tableId: null, tableName: null }));
          return;
        } else { setSaveState("error"); setSaveError(e); }
      }
    })();
    inFlight.current = run;
    await run.finally(() => { if (inFlight.current === run) inFlight.current = null; });
  }, [adopt, load, locationId, setDraft, tenantId, tickets, toast]);

  // Autosave: shortly after the cashier stops tapping.
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => void saveNow(), 700);
    return () => clearTimeout(t);
  }, [draft, dirty, saveNow]);

  // Another till changed the order on screen and nothing is pending here: show theirs.
  useEffect(() => {
    if (!draft.id || dirty || saveState === "saving") return;
    const server = open.find((t) => t.id === draft.id);
    if (server && server.version > draft.version) load(fromTicket(server));
    if (!server && tickets.isSuccess && !tickets.isFetching) {
      api<Ticket>("GET", `/t/pos/tickets/${draft.id}`, { tenant: tenantId }).then((t) => { if (t.status !== "open" && draftRef.current.id === t.id) load(emptyDraft()); }).catch(() => undefined);
    }
  }, [open, draft.id, draft.version, dirty, saveState, load, tickets.isSuccess, tickets.isFetching, tenantId]);

  // Leaving with an unsaved change: ask first.
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (JSON.stringify(payload(draftRef.current)) !== baseRef.current || inFlight.current) e.preventDefault(); };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, []);

  async function switchTo(id: string | null) {
    await saveNow();
    setActionError(null); setEditing(null);
    // An order emptied before the kitchen saw anything is just an abandoned tab: close it instead of leaving it open.
    const left = draftRef.current;
    if (left.id && left.id !== id && left.items.length === 0 && !open.find((t) => t.id === left.id)?.kitchenRounds) {
      await api("POST", `/t/pos/tickets/${left.id}/void`, { tenant: tenantId, body: { version: left.version, reason: "طلب فارغ" } }).catch(() => undefined);
      void tickets.refetch();
    }
    if (!id) { if (draftRef.current.id || draftRef.current.items.length) load(emptyDraft()); return; }
    const t = open.find((x) => x.id === id) ?? await api<Ticket>("GET", `/t/pos/tickets/${id}`, { tenant: tenantId }).catch(() => null);
    if (t) load(fromTicket(t));
  }

  // ── Editing ──
  function addLine(recipeId: string, modifiers: string[], note: string | null = null, qty = 1) {
    setDraft((d) => {
      const i = d.items.findIndex((x) => sameLine(x, { recipeId, modifiers, note }) && x.sent === 0);
      if (i >= 0) return { ...d, items: d.items.map((x, n) => (n === i ? { ...x, quantity: x.quantity + qty } : x)) };
      return { ...d, items: [...d.items, { id: crypto.randomUUID(), recipeId, quantity: qty, modifiers, note, sent: 0 }] };
    });
  }
  function pick(m: MenuItem) {
    if (m.modifierGroups.length) setChoosing(m);
    else { addLine(m.id, []); beep(true); }
  }
  function setQty(line: Line, qty: number) {
    if (qty < line.sent) { setLineVoid({ line, to: Math.max(0, qty) }); return; }
    setDraft((d) => ({ ...d, items: qty <= 0 ? d.items.filter((x) => x.id !== line.id) : d.items.map((x) => (x.id === line.id ? { ...x, quantity: qty } : x)) }));
  }
  const qtyOf = (recipeId: string) => draft.items.filter((c) => c.recipeId === recipeId).reduce((a, c) => a + c.quantity, 0);
  const catHue = (c: string): Hue => CAT_CYCLE[Math.max(0, cats.indexOf(c)) % CAT_CYCLE.length]!;
  const count = draft.items.reduce((a, c) => a + c.quantity, 0);
  const unsent = draft.items.reduce((a, c) => a + Math.max(0, c.quantity - c.sent), 0);

  // ── Price (server) ──
  const discountValue = Number(draft.discount.value);
  const cartBody = { items: draft.items.map(({ recipeId, quantity, modifiers }) => ({ recipeId, quantity, modifiers })), discount: draft.discountOn && discountValue > 0 ? { type: draft.discount.type, value: discountValue } : null };
  const cartKey = JSON.stringify(cartBody);
  const [debouncedKey, setDebouncedKey] = useState(cartKey);
  useEffect(() => { const t = setTimeout(() => setDebouncedKey(cartKey), 200); return () => clearTimeout(t); }, [cartKey]);
  const quote = useQuery({
    // The debounced cart can still be the empty one for a moment after the first tap.
    enabled: draft.items.length > 0 && (JSON.parse(debouncedKey) as typeof cartBody).items.length > 0,
    queryKey: ["t", tenantId, "pos", "quote", debouncedKey],
    queryFn: ({ signal }) => api<Quote>("POST", "/t/pos/quote", { tenant: tenantId, body: JSON.parse(debouncedKey), signal }),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const quoteFresh = debouncedKey === cartKey && !quote.isFetching && quote.isSuccess;
  const needReason = draft.discountOn && discountValue > 0 && draft.discount.reason.trim().length < 3;
  const blocker = !draft.items.length ? "أضف أصنافاً للدفع" : needReason ? "اكتب سبب الخصم" : draft.channel === "delivery" && draft.platformId && !draft.externalRef.trim() ? "أدخل رقم طلب التطبيق"
    : !quoteFresh ? "جارٍ حساب الإجمالي…" : saveState === "error" ? "تعذّر الحفظ" : null;

  // ── Actions on the server copy ──
  async function send() {
    await saveNow();
    const d = draftRef.current;
    if (!d.id) return;
    setBusy("send"); setActionError(null);
    try {
      const t = await api<Ticket>("POST", `/t/pos/tickets/${d.id}/send`, { tenant: tenantId, body: { version: d.version } });
      adopt(t, JSON.stringify(payload(fromTicket(t))));
      toast.success(`أُرسل للمطبخ (الدفعة ${integer(t.kitchenRounds)})`);
    } catch (e) { setActionError(e); } finally { setBusy(null); }
  }
  async function startPay(split: boolean) {
    await saveNow();
    if (saveState === "error" || !draftRef.current.id) return;
    setDialog(split ? "split" : "pay");
  }
  async function voidTicket(reason: string | null) {
    const d = draftRef.current;
    if (!d.id) { load(emptyDraft()); setDialog(null); return; }
    setBusy("void"); setActionError(null);
    try {
      await api("POST", `/t/pos/tickets/${d.id}/void`, { tenant: tenantId, body: { version: d.version, reason } });
      toast.success("أُلغي الطلب");
      setDialog(null);
      load(emptyDraft());
      await tickets.refetch();
    } catch (e) { setActionError(e); } finally { setBusy(null); }
  }
  async function voidLine(reason: string | null) {
    if (!lineVoid) return;
    const d = draftRef.current;
    const items = lineVoid.to <= 0 ? d.items.filter((x) => x.id !== lineVoid.line.id) : d.items.map((x) => (x.id === lineVoid.line.id ? { ...x, quantity: lineVoid.to } : x));
    const next = { ...d, items };
    setBusy("void"); setActionError(null);
    try {
      const t = await api<Ticket>("PUT", `/t/pos/tickets/${d.id}`, { tenant: tenantId, body: { ...payload(next), version: d.version, voidReason: reason } });
      load(fromTicket(t));
      toast.success("أُلغي الصنف وأُبلغ المطبخ");
      setLineVoid(null);
    } catch (e) { setActionError(e); } finally { setBusy(null); }
  }
  async function merge(intoId: string) {
    await saveNow();
    const d = draftRef.current;
    const into = open.find((t) => t.id === intoId);
    if (!d.id || !into) return;
    setBusy("merge"); setActionError(null);
    try {
      const t = await api<Ticket>("POST", `/t/pos/tickets/${d.id}/merge`, { tenant: tenantId, body: { version: d.version, intoId, intoVersion: into.version } });
      setDialog(null);
      load(fromTicket(t));
      await tickets.refetch();
      toast.success(`دُمج في ${ticketName(t)}`);
    } catch (e) { setActionError(e); } finally { setBusy(null); }
  }
  async function paid(r: SaleResult, change: number) {
    setDialog(null); setSplitPay(null);
    setReceipt({ orderId: r.id, change, partial: r.ticketClosed === false });
    onSold();
    const d = draftRef.current;
    if (r.ticketClosed !== false) {
      load(emptyDraft());
      setCartOpen(false);
    } else if (d.id) {
      const t = await api<Ticket>("GET", `/t/pos/tickets/${d.id}`, { tenant: tenantId }).catch(() => null);
      if (t) load(fromTicket(t));
    }
    void tickets.refetch();
  }

  // ── Keyboard: search, new, switch, kitchen, pay ──
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyRef.current = (e: KeyboardEvent) => {
    if (document.querySelector("dialog[open]")) return;
    const typing = (e.target as HTMLElement)?.closest?.("input, textarea, select");
    if (e.key === "F2" || (e.key === "/" && !typing)) { e.preventDefault(); searchRef.current?.querySelector("input")?.focus(); }
    else if (e.key === "F4") { e.preventDefault(); void switchTo(null); }
    else if (e.key === "F8") { e.preventDefault(); if (unsent > 0 && draft.id) void send(); }
    else if (e.key === "F9") { e.preventDefault(); if (!blocker) void startPay(false); }
    else if (e.altKey && /^[1-9]$/.test(e.key)) { const t = open[Number(e.key) - 1]; if (t) { e.preventDefault(); void switchTo(t.id); } }
  };
  useEffect(() => { const h = (e: KeyboardEvent) => keyRef.current(e); window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, []);

  /** Enter in the search box (or a barcode scanner typing a code + Enter) adds the one matching item. */
  function onSearchKey(e: React.KeyboardEvent) {
    if (e.key !== "Enter" || !term) return;
    e.preventDefault();
    const exact = items.find((m) => m.code.toLowerCase() === term.toLowerCase());
    const hit = exact ?? (shown.length === 1 ? shown[0] : null);
    if (hit && hit.available - qtyOf(hit.id) > 0) { pick(hit); setQ(""); } else beep(false);
  }

  const tabs: { id: string | null; name: string; count: number; total: number | null; channel: Channel; since: string | null; unsent: number }[] = [
    ...open.map((t) => (t.id === draft.id
      ? { id: t.id, name: ticketName({ ...t, label: draft.label || null, tableName: draft.tableName, customerName: draft.customer?.name ?? null }), count, total: quote.data && draft.items.length ? quote.data.total : t.totals?.total ?? null, channel: draft.channel, since: t.createdAt, unsent }
      : { id: t.id, name: ticketName(t), count: t.count, total: t.totals?.total ?? null, channel: t.channel, since: t.createdAt, unsent: t.unsent })),
    ...(!draft.id ? [{ id: null, name: draft.label || (draft.tableName ? `طاولة ${draft.tableName}` : draft.customer?.name || "طلب جديد"), count, total: draft.items.length && quote.data ? quote.data.total : null, channel: draft.channel, since: null, unsent }] : []),
  ];
  const grand = draft.items.length ? (quote.data ? money(quote.data.total) : "…") : money(0);
  const sentAny = draft.items.some((l) => l.sent > 0);
  const saveHint = saveState === "saving" ? "جارٍ الحفظ…" : saveState === "error" ? "لم يُحفظ" : draft.id ? (dirty ? "تعديلات لم تُحفظ" : "محفوظ") : draft.items.length ? "جارٍ الإنشاء…" : null;

  return (
    <>
      <div className="pos-tabs" role="tablist" aria-label="الطلبات المفتوحة">
        {tabs.map((t, i) => (
          <button key={t.id ?? "new"} type="button" role="tab" aria-selected={t.id === draft.id} className="pos-tab" data-hue={CHANNEL_HUE[t.channel]} onClick={() => void switchTo(t.id)}
            title={i < 9 && t.id ? `Alt+${i + 1}` : undefined}>
            <span className="pos-tab-top"><span className="pos-cat-dot" aria-hidden="true" /><strong>{t.name}</strong>{t.unsent > 0 && t.id && <span className="pos-tab-flag" aria-label={`${t.unsent} لم يُرسل للمطبخ`} />}</span>
            <span className="pos-tab-meta num">{integer(t.count)} صنف · {t.total === null ? "—" : money(t.total)}{t.since ? ` · ${elapsed(t.since, now)}` : ""}</span>
          </button>
        ))}
        <button type="button" className="pos-tab is-add" onClick={() => void switchTo(null)} aria-label="طلب جديد (F4)"><Plus aria-hidden="true" /><span>طلب جديد</span></button>
        {open.length > 3 && <button type="button" className="pos-tab is-add" onClick={() => setDialog("all")}><LayoutGrid aria-hidden="true" /><span>الكل ({integer(open.length)})</span></button>}
        {tickets.isError && <span className="form-error pos-tabs-error">تعذّر تحديث الطلبات المفتوحة <Button size="sm" variant="ghost" onClick={() => void tickets.refetch()}>إعادة المحاولة</Button></span>}
      </div>

      <div className={["pos", cartOpen && "is-cart-open"].filter(Boolean).join(" ")}>
        <section className="pos-menu" aria-label="قائمة الأصناف">
          <div className="pos-search" ref={searchRef} onKeyDown={onSearchKey}><SearchInput placeholder="ابحث باسم الصنف أو رمزه، أو امسح الباركود (F2)" value={q} onChange={setQ} /></div>
          {cats.length > 1 && (
            <div className="pos-cats" role="group" aria-label="الفئات">
              <button type="button" className="pos-cat" aria-pressed={cat === ""} onClick={() => setCat("")}>الكل</button>
              {cats.map((c) => <button key={c} type="button" className="pos-cat" data-hue={catHue(c)} aria-pressed={cat === c} onClick={() => setCat(c)}><span className="pos-cat-dot" aria-hidden="true" />{c}</button>)}
            </div>
          )}
          {menu.isPending ? <div className="pos-grid">{Array.from({ length: 8 }, (_, i) => <div key={i} className="pos-item is-skeleton"><Skeleton width="70%" /><Skeleton width="40%" /></div>)}</div>
            : menu.isError ? <ErrorState error={menu.error} onRetry={() => menu.refetch()} />
            : items.length === 0 ? <EmptyState title="لا توجد أصناف معتمدة للبيع" action={<Link to={`/w/${tenantId}/recipes`} className="btn btn-secondary">فتح الوصفات</Link>}>اعتمد وصفة واحدة على الأقل لتظهر هنا.</EmptyState>
            : shown.length === 0 ? <EmptyState kind="filtered" title="لا توجد أصناف مطابقة" action={<Button size="sm" onClick={() => { setQ(""); setCat(""); }}>مسح البحث</Button>} />
            : (
              <div className="pos-grid">
                {shown.map((m) => {
                  const inCart = qtyOf(m.id);
                  const left = m.available - inCart;
                  const category = m.category ?? "أخرى";
                  return (
                    <button key={m.id} type="button" className="pos-item" data-hue={catHue(category)} disabled={left <= 0} onClick={() => pick(m)} aria-label={`${m.name}، ${money(m.priceGross)}${m.modifierGroups.length ? "، له خيارات" : ""}${inCart > 0 ? `، في الطلب ${integer(inCart)}` : ""}${left <= 0 ? "، نفد" : ""}`}>
                      <span className="pos-item-top">
                        <span className="cat">{category}</span>
                        {inCart > 0 && <span className="pos-item-qty num" aria-hidden="true">{integer(inCart)}</span>}
                      </span>
                      <span className="name">{m.name}</span>
                      <span className="pos-item-foot">
                        <span className="price num">{money(m.priceGross)}</span>
                        <span className={["avail", left > 0 && left <= 5 && "is-low"].filter(Boolean).join(" ")}>
                          {left <= 0 ? "نفد المخزون" : m.modifierGroups.length ? "له خيارات" : left >= 9999 ? "" : `متاح ${integer(left)}`}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
        </section>

        <aside className="pos-cart panel" aria-label="الطلب الحالي">
          <div className="pos-cart-head">
            <IconButton label="رجوع للقائمة" icon={<X />} className="pos-cart-close" onClick={() => setCartOpen(false)} />
            <div className="pos-cart-title">
              <input className="pos-label-input" aria-label="اسم الطلب" placeholder={draft.tableName ? `طاولة ${draft.tableName}` : draft.customer?.name || (draft.number ? `طلب ${draft.number}` : "اسم الطلب (اختياري)")}
                value={draft.label} maxLength={60} onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))} />
              <span className="pos-cart-sub">
                {draft.number && <span className="num">T-{draft.number}</span>}
                {saveHint && <span className={["pos-save", saveState === "error" && "is-error"].filter(Boolean).join(" ")} aria-live="polite">{saveHint}</span>}
                {saveState === "error" && <Button size="sm" variant="ghost" onClick={() => void saveNow()}>إعادة الحفظ</Button>}
              </span>
            </div>
            <ActionMenu label="إجراءات الطلب" trigger={<MoreHorizontal />} items={[
              { label: draft.notes || draft.channel ? "ملاحظة للطلب" : "ملاحظة", onSelect: () => setEditing("__notes") },
              { label: "دمج مع طلب آخر", onSelect: () => setDialog("merge"), disabled: !draft.id || open.length < 2 },
              { label: "طباعة للمطبخ", onSelect: () => setChit(true), disabled: !draft.items.length },
              { label: "إلغاء الطلب", onSelect: () => setDialog("void"), danger: true, separated: true, disabled: !draft.id && !draft.items.length },
            ]} />
          </div>
          {saveState === "error" && saveError != null && <div className="pos-cart-err"><FormError error={saveError} /></div>}
          <div className="pos-cart-body">
          <div className="pos-cart-opts">
            <div className="pos-seg" role="group" aria-label="نوع الطلب">
              {(["takeaway", "dine_in", "delivery"] as const).map((c) => <button key={c} type="button" data-hue={CHANNEL_HUE[c]} aria-pressed={draft.channel === c} onClick={() => setDraft((d) => ({ ...d, channel: c, tableId: c === "dine_in" ? d.tableId : null, tableName: c === "dine_in" ? d.tableName : null, platformId: c === "delivery" ? d.platformId : "" }))}><span className="pos-cat-dot" aria-hidden="true" />{CHANNEL_LABELS[c]}</button>)}
            </div>
            {draft.channel === "dine_in" && (
              <div className="pos-inline">
                <Button className="pos-grow" icon={<UtensilsCrossed />} onClick={() => setDialog("tables")}>{draft.tableName ? `طاولة ${draft.tableName}` : "اختيار طاولة"}</Button>
                <input className="input num pos-guests" inputMode="numeric" aria-label="عدد الضيوف" placeholder="ضيوف" value={draft.guests} onChange={(e) => setDraft((d) => ({ ...d, guests: e.target.value.replace(/\D/g, "").slice(0, 3) }))} />
              </div>
            )}
            {draft.channel === "delivery" && (
              <div className="pos-inline">
                <select className="select" aria-label="تطبيق التوصيل" value={draft.platformId} onChange={(e) => setDraft((d) => ({ ...d, platformId: e.target.value }))}>
                  <option value="">توصيل المطعم</option>
                  {(platforms.data?.items ?? []).filter((p) => p.isActive).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                {draft.platformId && <input className="input" dir="ltr" aria-label="رقم طلب التطبيق" placeholder="رقم الطلب في التطبيق" value={draft.externalRef} onChange={(e) => setDraft((d) => ({ ...d, externalRef: e.target.value }))} />}
              </div>
            )}
            <CustomerPicker tenantId={tenantId} value={draft.customer} onChange={(c) => setDraft((d) => ({ ...d, customer: c }))} />
            {(editing === "__notes" || draft.notes) && (
              <textarea className="input pos-notes" aria-label="ملاحظة للطلب" placeholder="ملاحظة للطلب كله (تظهر للمطبخ)" rows={2} maxLength={500} value={draft.notes}
                onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))} autoFocus={editing === "__notes"} />
            )}
          </div>
          {draft.items.length === 0 ? <div className="state pos-cart-empty"><ShoppingBag aria-hidden="true" /><p>اضغط على صنف لإضافته للطلب.</p><p className="muted">كل طلب يُحفظ تلقائياً، ويمكنك فتح أكثر من طلب والتنقل بينها من الشريط العلوي.</p></div> : (
            <>
            <div className="pos-lines-head" aria-hidden="true"><span>الصنف <span className="num">({integer(count)})</span></span><span>الإجمالي</span></div>
            <ul className="pos-lines" aria-label={`أصناف الطلب: ${integer(count)}`}>
              {draft.items.map((l, idx) => {
                const m = byId.get(l.recipeId);
                const qLine = quote.data?.lines[idx];
                const open = editing === l.id;
                return (
                  <li key={l.id} className={["pos-line", l.sent > 0 && "is-sent"].filter(Boolean).join(" ")} data-hue={catHue(m?.category ?? "أخرى")}>
                    <button type="button" className="pos-line-name" onClick={() => setEditing(open ? null : l.id)} aria-expanded={open}>
                      <strong>{nameOf(l)}</strong>
                      {m && <span className="pos-line-unit num">{money(m.priceGross + l.modifiers.reduce((a, id) => a + (optGross.get(id) ?? 0), 0))} للوحدة</span>}
                      {l.modifiers.length > 0 && <span className="pos-line-mods">{l.modifiers.map((id) => optName.get(id)).join("، ")}</span>}
                      {l.note && <span className="pos-line-note">* {l.note}</span>}
                      {l.sent > 0 && <span className="pos-line-sent"><ChefHat aria-hidden="true" /> في المطبخ {l.sent < l.quantity ? `${integer(l.sent)} من ${integer(l.quantity)}` : ""}</span>}
                    </button>
                    <span className="pos-line-total num">{qLine && quoteFresh ? money(qLine.total) : "…"}</span>
                    <div className="qty">
                      <Button aria-label={`تقليل ${nameOf(l)}`} icon={<Minus />} onClick={() => setQty(l, l.quantity - 1)} />
                      <input className="pos-qty-input num" inputMode="numeric" aria-label={`كمية ${nameOf(l)}`} value={l.quantity}
                        onChange={(e) => { const n = Number(e.target.value.replace(/\D/g, "")); if (n >= 1 && n <= 999 && n >= l.sent) setDraft((d) => ({ ...d, items: d.items.map((x) => (x.id === l.id ? { ...x, quantity: n } : x)) })); }} />
                      <Button aria-label={`زيادة ${nameOf(l)}`} icon={<Plus />} onClick={() => setQty(l, l.quantity + 1)} disabled={Boolean(m && qtyOf(l.recipeId) >= m.available)} />
                    </div>
                    <IconButton label={`حذف ${nameOf(l)} من الطلب`} destructive icon={<Trash2 />} onClick={() => setQty(l, 0)} />
                    {open && (
                      <div className="pos-line-edit">
                        {l.sent > 0 ? <p className="muted">وصل هذا الصنف للمطبخ، فلا تُعدَّل ملاحظته. لتغييره أضفه سطراً جديداً، ويلغي المدير القديم.</p> : (
                          <input className="input" aria-label={`ملاحظة ${nameOf(l)}`} placeholder="ملاحظة للمطبخ: بدون بصل، زيادة صوص…" maxLength={140} autoFocus value={l.note ?? ""}
                            onChange={(e) => setDraft((d) => ({ ...d, items: d.items.map((x) => (x.id === l.id ? { ...x, note: e.target.value || null } : x)) }))} />
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            </>
          )}
          {draft.items.length > 0 && (!draft.discountOn ? (
            <Button variant="ghost" size="sm" icon={<Plus />} className="pos-disc-add" onClick={() => setDraft((d) => ({ ...d, discountOn: true }))}>إضافة خصم على الطلب</Button>
          ) : (
              <fieldset className="stack pos-fieldset pos-disc">
                <legend className="field-label">الخصم</legend>
                <div className="pos-inline">
                  <select className="select pos-disc-type" aria-label="نوع الخصم" value={draft.discount.type} onChange={(e) => setDraft((d) => ({ ...d, discount: { ...d.discount, type: e.target.value as "percent" | "amount" } }))}><option value="percent">نسبة ٪</option><option value="amount">{`مبلغ ${RIYAL}`}</option></select>
                  <input className="input num" inputMode="decimal" aria-label="قيمة الخصم" value={draft.discount.value} onChange={(e) => setDraft((d) => ({ ...d, discount: { ...d.discount, value: e.target.value } }))} />
                  <IconButton label="إلغاء الخصم" icon={<X />} onClick={() => setDraft((d) => ({ ...d, discountOn: false, discount: { type: "percent", value: "", reason: "" } }))} />
                </div>
                <input className="input" aria-label="سبب الخصم" placeholder="سبب الخصم (إلزامي)" value={draft.discount.reason} onChange={(e) => setDraft((d) => ({ ...d, discount: { ...d.discount, reason: e.target.value } }))} aria-invalid={needReason || undefined} />
              </fieldset>
          ))}
          </div>
          <div className="pos-totals">
            {quote.isError && draft.items.length > 0 && <FormError error={quote.error} />}
            {actionError != null && <FormError error={actionError} />}
            {quote.data && draft.items.length > 0 && (
              <dl className="pos-sums" aria-busy={!quoteFresh || undefined}>
                <div><dt>قبل الضريبة</dt><dd className="num">{money(quote.data.subtotal)}</dd></div>
                {quote.data.discount > 0 && <div className="is-disc"><dt>الخصم</dt><dd className="num">− {money(quote.data.discount)}</dd></div>}
                <div><dt>الضريبة {percent(quote.data.vatRatePercent)}</dt><dd className="num">{money(quote.data.vat)}</dd></div>
              </dl>
            )}
            <div className="pos-grand"><span>الإجمالي</span><span className="spacer" /><span className="grand num">{grand}</span></div>
            <div className="pos-actions">
              <Button icon={<ChefHat />} disabled={!unsent || !draft.items.length || busy !== null} loading={busy === "send"} loadingText="جارٍ الإرسال…" onClick={() => void send()}>
                {unsent ? `للمطبخ (${integer(unsent)})` : sentAny ? "في المطبخ" : "للمطبخ"}
              </Button>
              <Button icon={<SplitSquareHorizontal />} disabled={Boolean(blocker) || count < 2 || Boolean(platform)} onClick={() => void startPay(true)}>تقسيم</Button>
            </div>
            <Button variant="primary" size="lg" className="pos-pay" disabled={Boolean(blocker)} onClick={() => void startPay(false)}>
              {blocker ?? (platform ? `تسجيل طلب ${platform.name} ${money(quote.data!.total)}` : `الدفع ${money(quote.data!.total)}`)}
            </Button>
          </div>
        </aside>

        {/* Phones: the order is a sheet over the menu; this bar opens it and pays. */}
        <div className="pos-mbar" aria-hidden={cartOpen || undefined}>
          <button type="button" className="pos-mbar-cart" onClick={() => setCartOpen(true)}>
            <ShoppingBag aria-hidden="true" />
            <span><strong>{tabs.find((t) => t.id === draft.id)?.name ?? "طلب جديد"}</strong><span className="num">{integer(count)} صنف{unsent && draft.id ? ` · ${integer(unsent)} للمطبخ` : ""}</span></span>
          </button>
          <Button variant="primary" size="lg" disabled={!draft.items.length} onClick={() => setCartOpen(true)}><span className="num">{grand}</span></Button>
        </div>
      </div>

      {/* Kitchen chit, for kitchens printing on paper. */}
      {chit && draft.items.length > 0 && (
        <div className="print-area pos-chit" aria-hidden="true">
          <strong>{tabs.find((t) => t.id === draft.id)?.name}</strong>
          <span>{CHANNEL_LABELS[draft.channel]}{draft.number ? ` · T-${draft.number}` : ""} · {dayTime(new Date(now).toISOString())}</span>
          <ul>{draft.items.map((l) => <li key={l.id}><strong className="num">{integer(l.quantity)}×</strong> {nameOf(l)}{l.modifiers.length > 0 && ` (${l.modifiers.map((id) => optName.get(id)).join("، ")})`}{l.note && <div>* {l.note}</div>}</li>)}</ul>
          {draft.notes && <p>{draft.notes}</p>}
        </div>
      )}

      {choosing && <ModifierDialog item={choosing} onClose={() => setChoosing(null)} onAdd={(mods, note, n) => { addLine(choosing.id, mods, note, n); setChoosing(null); beep(true); }} />}
      {dialog === "tables" && <TableDialog areas={areas} selected={draft.tableId} currentTicketId={draft.id} onClose={() => setDialog(null)}
        onPick={(id) => { const name = areas.data?.items.flatMap((a) => a.tables).find((t) => t.id === id)?.name ?? null; setDraft((d) => ({ ...d, tableId: id, tableName: name, channel: "dine_in" })); setDialog(null); }}
        onOpenTicket={(id) => { setDialog(null); void switchTo(id); }} />}
      {dialog === "all" && <OpenTicketsDialog tickets={open} activeId={draft.id} now={now} onClose={() => setDialog(null)} onOpen={(id) => { setDialog(null); void switchTo(id); }} onNew={() => { setDialog(null); void switchTo(null); }} />}
      {dialog === "merge" && draft.id && <MergeDialog tickets={open} current={draft.id} onClose={() => setDialog(null)} onPick={(id) => void merge(id)} />}
      {dialog === "void" && <ReasonDialog title="إلغاء الطلب" confirmLabel="إلغاء الطلب" busy={busy === "void"} error={actionError}
        message={sentAny ? "وصلت أصناف من هذا الطلب للمطبخ، وسيُبلَّغ المطبخ بالإلغاء." : "سيُلغى هذا الطلب ولن يظهر في الطلبات المفتوحة."}
        needsManager={sentAny} canManage={can("pos.void")} reasonRequired={sentAny} onClose={() => { setDialog(null); setActionError(null); }} onConfirm={(r) => void voidTicket(r)} />}
      {lineVoid && <ReasonDialog title={`إلغاء من «${nameOf(lineVoid.line)}»`} confirmLabel="إلغاء وإبلاغ المطبخ" busy={busy === "void"} error={actionError}
        message={`وصل ${integer(lineVoid.line.sent)} من هذا الصنف للمطبخ. سيُلغى ${integer(lineVoid.line.sent - lineVoid.to)} ويظهر الإلغاء في شاشة المطبخ.`}
        needsManager canManage={can("pos.void")} reasonRequired onClose={() => { setLineVoid(null); setActionError(null); }} onConfirm={(r) => void voidLine(r)} />}
      {dialog === "split" && draft.id && <SplitDialog tenantId={tenantId} ticket={{ items: draft.items, discount: payload(draft).discount }} names={nameOf} onClose={() => setDialog(null)}
        onPay={(lines, total) => { setSplitPay({ lines, total }); setDialog("pay"); }} />}
      {dialog === "pay" && quote.data && draft.id && (
        <PaymentDialog tenantId={tenantId} total={splitPay ? splitPay.total : quote.data.total} platform={platform ?? null}
          title={splitPay ? `دفع جزء من الطلب · ${money(splitPay.total)}` : undefined}
          order={{
            locationId, shiftId, ...payload(draft), customerName: draft.customer?.name ?? null,
            items: (splitPay ? draft.items.filter((l) => splitPay.lines.some((s) => s.lineId === l.id)) : draft.items).map(({ recipeId, quantity, modifiers, note }) => ({ recipeId, quantity, modifiers, note })),
            ticket: { id: draft.id, version: draft.version, ...(splitPay ? { lines: splitPay.lines } : {}) },
          }}
          onClose={() => { setDialog(null); setSplitPay(null); }}
          onPaid={(r, change) => void paid(r, change)} />
      )}
      {receipt && <ReceiptDialog tenantId={tenantId} orderId={receipt.orderId} change={receipt.change} fresh partial={receipt.partial} onClose={() => setReceipt(null)} />}
      <button type="button" className="sr-only" onClick={onShortcuts}>اختصارات لوحة المفاتيح</button>
    </>
  );
}
