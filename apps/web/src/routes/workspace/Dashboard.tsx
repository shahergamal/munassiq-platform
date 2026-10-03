import { keepPreviousData, useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Boxes, ChevronLeft, Receipt, TrendingUp } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api, type Page } from "../../api/client";
import type { Ingredient, Location } from "../../api/types";
import { useMe } from "../../app/session";
import { useTenant } from "../../app/tenant";
import { SearchInput } from "../../ui/Field";
import { cost, dayLong, greeting, integer, isoDay, money, quantity, time } from "../../lib/format";
import { DataTable } from "../../ui/DataTable";
import { useTablePrefs } from "../../ui/tablePrefs";
import { Badge, PageHeader, StatCard, StatusBadge, type Hue } from "../../ui/Layout";
import { ErrorState, Skeleton } from "../../ui/States";
import { CHANNEL_LABELS } from "../../ui/status";
import { ContractingDashboard } from "./ContractingDashboard";

interface DailyRow { day: string; orders: number; netSales: number; vat: number; total: number; cost: number; grossProfit: number; refunds: number }
interface Valuation { items: { locationId: string; locationName: string; items: number; value: number; belowMin: number }[]; total: number }
interface OrderRow { id: string; number: number; channel: string; status: string; total: number; createdAt: string; locationName: string; tableName: string | null; platformName: string | null; itemsCount: number }
interface ShiftRow { id: string; openedAt: string; locationName: string; openedByName: string | null; ordersCount: number; salesTotal: number }
interface PoRow { id: string; number: number; supplierName: string; locationName: string; grandTotal: number; createdAt: string }

type Q<T> = { data?: T; isPending: boolean; isError: boolean; refetch: () => unknown };

/** A KPI that owns its own request: one failing source never blanks the dashboard. */
function Kpi<T>({ q, label, icon, hue, render }: { q: Q<T>; label: string; icon: ReactNode; hue: Hue; render: (d: T) => { value: string; note?: string; warn?: boolean } }) {
  if (q.isPending) return <div className="stat" aria-busy="true"><span className={`stat-icon tone-${hue}`} aria-hidden="true">{icon}</span><span className="label">{label}</span><Skeleton width="45%" height={28} /><Skeleton width="60%" /></div>;
  if (q.isError) return <div className="stat"><span className={`stat-icon tone-${hue}`} aria-hidden="true">{icon}</span><span className="label">{label}</span><span className="note">تعذر التحميل. <button type="button" className="btn btn-ghost btn-sm" onClick={() => q.refetch()}>إعادة المحاولة</button></span></div>;
  const r = render(q.data as T);
  return <StatCard label={label} value={r.value} note={r.note} noteTone={r.warn ? "warning" : undefined} icon={icon} hue={hue} />;
}

/** One card with a title, an optional link and its own loading / empty / error states. */
function Card<T>({ title, id, link, q, children }: { title: string; id: string; link?: { to: string; label: string }; q: Q<T> & { error?: unknown }; children: (d: T) => ReactNode }) {
  return (
    <section className="panel" aria-labelledby={id}>
      <div className="card-head">
        <h2 id={id}>{title}</h2>
        <span className="spacer" />
        {link && <Link to={link.to} className="btn btn-ghost btn-sm">{link.label}<ChevronLeft aria-hidden="true" /></Link>}
      </div>
      <div className="card-body">
        {q.isPending ? <div className="stack">{[0, 1, 2].map((i) => <Skeleton key={i} height={44} />)}</div>
          : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} />
          : children(q.data as T)}
      </div>
    </section>
  );
}

const CHANNEL_HUE: Record<string, Hue> = { dine_in: "indigo", takeaway: "green", delivery: "orange" };
const CYCLE: Hue[] = ["indigo", "sky", "green", "orange", "violet", "amber"];
const initials = (name: string) => name.trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join("");

/** Each sector has its own home: a contractor's is its contracts and IPCs, not stock and cashier sales. */
export function DashboardPage() {
  const { contracting, can } = useTenant();
  // The storekeeper of a contracting workspace, without projects, sees the stock home instead.
  return contracting && can("projects.view") ? <ContractingDashboard /> : <OperationsDashboard />;
}

function OperationsDashboard() {
  const { tenantId, can } = useTenant();
  const me = useMe();
  const today = isoDay();
  const reports = can("rep_daily_sales.view");
  const valuationOk = can("rep_stock_valuation.view");
  const ingredientsOk = can("ingredients.view");
  const pos = can("orders.view");
  const purchases = can("purchases.view");
  const sales = useQuery({ enabled: reports, queryKey: ["t", tenantId, "reports", "daily", today], queryFn: () => api<{ items: DailyRow[] }>("GET", "/t/reports/daily-sales", { tenant: tenantId, query: { from: today, to: today } }) });
  const valuation = useQuery({ enabled: valuationOk, queryKey: ["t", tenantId, "reports", "valuation"], queryFn: () => api<Valuation>("GET", "/t/reports/stock-valuation", { tenant: tenantId }) });
  const low = useQuery({ enabled: ingredientsOk, queryKey: ["t", tenantId, "ingredients", { stock: "low", dash: true }], queryFn: () => api<Page<Ingredient>>("GET", "/t/ingredients", { tenant: tenantId, query: { stock: "low", isActive: "true", pageSize: 8 } }) });
  const out = useQuery({ enabled: ingredientsOk, queryKey: ["t", tenantId, "ingredients", { stock: "zero", dash: true }], queryFn: () => api<Page<Ingredient>>("GET", "/t/ingredients", { tenant: tenantId, query: { stock: "zero", isActive: "true", pageSize: 1 } }) });
  const orders = useQuery({ enabled: pos, queryKey: ["t", tenantId, "orders", { dash: true, today }], queryFn: () => api<Page<OrderRow>>("GET", "/t/pos/orders", { tenant: tenantId, query: { from: today, to: today, pageSize: 6 } }) });
  const shifts = useQuery({ enabled: pos, queryKey: ["t", tenantId, "shifts", { dash: true }], queryFn: () => api<Page<ShiftRow>>("GET", "/t/pos/shifts", { tenant: tenantId, query: { status: "open", pageSize: 6 } }) });
  const expiry = useQuery({ enabled: can("batches.view"), queryKey: ["t", tenantId, "stock", "batches", "summary", { days: "3", loc: "" }],
    queryFn: () => api<{ expired: { count: number; value: number }; expiring: { count: number; value: number } }>("GET", "/t/stock/batches/summary", { tenant: tenantId, query: { days: 3 } }) });
  const incoming = useQuery({ enabled: purchases, queryKey: ["t", tenantId, "purchases", { status: "approved", dash: true }], queryFn: () => api<Page<PoRow>>("GET", "/t/purchases", { tenant: tenantId, query: { status: "approved", pageSize: 6 } }) });

  const t = sales.data?.items[0];
  const firstName = (me.data?.user.fullName ?? "").trim().split(/\s+/)[0] ?? "";
  const side = pos || purchases;
  return (
    <div className="page">
      <PageHeader title={`${greeting()}${firstName ? `، ${firstName}` : ""}`} description={dayLong()} />

      <div className="stats stats-4">
        {reports && <Kpi q={sales} label="مبيعات اليوم" icon={<Receipt />} hue="indigo"
          render={() => ({ value: money(t?.total ?? 0), note: t ? `${integer(t.orders)} طلب · شامل الضريبة` : "لا توجد مبيعات اليوم بعد" })} />}
        {reports && <Kpi q={sales} label="مجمل ربح اليوم" icon={<TrendingUp />} hue="green"
          render={() => ({ value: money(t?.grossProfit ?? 0), note: t ? `بعد تكلفة المكونات ${money(t.cost)}` : "من تكلفة المكونات وقت البيع" })} />}
        {valuationOk && <Kpi q={valuation} label="قيمة المخزون" icon={<Boxes />} hue="sky"
          render={(d) => ({ value: money(d.total), note: `في ${integer(d.items.length)} موقع بمتوسط التكلفة` })} />}
        {ingredientsOk && <Kpi q={low} label="مواد تحت الحد الأدنى" icon={<AlertTriangle />} hue="amber"
          render={(d) => ({ value: integer(d.meta.total), note: out.data ? `${integer(out.data.meta.total)} مادة رصيدها صفر` : "تحتاج إعادة طلب", warn: d.meta.total > 0 })} />}
      </div>

      {expiry.data && (expiry.data.expired.count > 0 || expiry.data.expiring.count > 0) && (
        <Link to={`/w/${tenantId}/batches`} className={`banner ${expiry.data.expired.count ? "banner-danger" : "banner-warning"} dash-expiry`}>
          <AlertTriangle aria-hidden="true" />
          <span>
            {expiry.data.expired.count > 0 && <>{integer(expiry.data.expired.count)} دفعة منتهية الصلاحية بقيمة {money(expiry.data.expired.value)}. </>}
            {expiry.data.expiring.count > 0 && <>{integer(expiry.data.expiring.count)} دفعة تنتهي خلال 3 أيام بقيمة {money(expiry.data.expiring.value)}: اصرفها أولاً. </>}
          </span>
          <strong>مراجعة الصلاحية</strong>
        </Link>
      )}

      {can("ingredients.create") && <GettingStarted tenantId={tenantId} />}

      <div className={side && pos ? "dash-grid" : "stack-lg"}>
        {pos && (
          <Card title="طلبات اليوم" id="orders-h" q={orders} link={{ to: `/w/${tenantId}/orders`, label: "كل الطلبات" }}>
            {(d) => d.items.length === 0 ? (
              <div className="state" style={{ padding: "var(--sp-8) var(--sp-4)" }}>
                <h2>لا توجد طلبات اليوم بعد</h2>
                <p>تظهر هنا طلبات اليوم لحظة تسجيلها من شاشة الكاشير، بلونٍ لكل قناة بيع.</p>
                {can("pos.sell") && <Link to={`/w/${tenantId}/pos`} className="btn btn-secondary btn-sm">فتح شاشة الكاشير</Link>}
              </div>
            ) : (
              <div className="accent-list">
                {d.items.map((o) => {
                  const hue = o.platformName ? "violet" : CHANNEL_HUE[o.channel] ?? "indigo";
                  const where = [o.locationName, o.tableName].filter(Boolean).join(" · ");
                  return (
                    <Link key={o.id} to={`/w/${tenantId}/orders/${o.id}`} className={`accent-item tone-${hue}`}>
                      <span className="accent-body">
                        <span className="accent-title">طلب <span className="num">#{o.number}</span><StatusBadge kind="order" value={o.status} /></span>
                        <span className="accent-meta"><span className="num">{time(o.createdAt)}</span> · {where} · {integer(o.itemsCount)} صنف · {money(o.total)}</span>
                      </span>
                      <span className={`tag tag-${hue}`}>{o.platformName ?? CHANNEL_LABELS[o.channel] ?? o.channel}</span>
                    </Link>
                  );
                })}
              </div>
            )}
          </Card>
        )}

        {side && (
          <div className="stack-lg">
            {pos && (
              <Card title="الشفتات المفتوحة" id="shifts-h" q={shifts} link={{ to: `/w/${tenantId}/shifts`, label: "الشفتات" }} >
                {(d) => d.items.length === 0 ? <p className="muted">لا توجد شفتات مفتوحة الآن.</p> : (
                  <ul className="people" aria-label="الشفتات المفتوحة" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                    {d.items.map((s, i) => (
                      <li key={s.id} className="person">
                        <span className={`avatar tone-${CYCLE[i % CYCLE.length]}`} aria-hidden="true">{initials(s.openedByName ?? "؟")}</span>
                        <span className="who"><strong>{s.openedByName ?? "كاشير"}</strong><span>{s.locationName} · منذ <span className="num">{time(s.openedAt)}</span></span></span>
                        <span className={`count-dot tag-${CYCLE[i % CYCLE.length]}`} title={`${integer(s.ordersCount)} طلب`}><span className="num">{integer(s.ordersCount)}</span><span className="sr-only"> طلب</span></span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            )}
            {purchases && (
              <Card title="استلامات قادمة" id="incoming-h" q={incoming} link={{ to: `/w/${tenantId}/purchases`, label: "أوامر الشراء" }} >
                {(d) => d.items.length === 0 ? <p className="muted">لا توجد أوامر معتمدة بانتظار الاستلام.</p> : (
                  <ul className="people" aria-label="أوامر شراء بانتظار الاستلام" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                    {d.items.map((p, i) => (
                      <li key={p.id}>
                        <Link to={`/w/${tenantId}/purchases/${p.id}`} className="person upcoming">
                          <span className={`dot on-${CYCLE[i % CYCLE.length]}`} aria-hidden="true" />
                          <span className="who"><strong>{p.supplierName}</strong><span><span className="num">PO-{p.number}</span> · {p.locationName} · {money(p.grandTotal)}</span></span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            )}
          </div>
        )}
      </div>

      {ingredientsOk && (
      <section className="panel" aria-labelledby="low-title">
        <DataTable caption="مواد تحت الحد الأدنى" query={{ ...low, data: low.data ? { items: low.data.items } : undefined }} rowKey={(r) => r.id}
          toolbar={<><h2 id="low-title">مواد تحتاج إعادة طلب</h2>{low.data && low.data.meta.total > 0 && <Badge tone="warning">{integer(low.data.meta.total)}</Badge>}<Link to={`/w/${tenantId}/ingredients`} className="btn btn-ghost btn-sm">كل المواد<ChevronLeft aria-hidden="true" /></Link></>}
          empty={{ title: "لا توجد مواد تحت الحد الأدنى", body: "كل المواد النشطة فوق حدها الأدنى." }}
          columns={[
            { key: "name", header: "المادة", cell: (r) => <strong>{r.name}</strong> },
            { key: "stock", sortKey: "stockQty", header: "الرصيد", numeric: true, cell: (r) => `${quantity(r.stockQty)} ${r.baseUnit}` },
            { key: "min", sortKey: "minStock", header: "الحد الأدنى", numeric: true, cell: (r) => `${quantity(r.minStock)} ${r.baseUnit}` },
            { key: "cost", sortKey: "avgCost", header: "متوسط التكلفة", numeric: true, cell: (r) => cost(r.avgCost) },
          ]} />
      </section>
      )}
    </div>
  );
}

/** First-use state: the steps that make the numbers above meaningful. Hidden once every step is done. */
function GettingStarted({ tenantId }: { tenantId: string }) {
  const { factory } = useTenant();
  // `api` is the list asked; `to` the page that completes the step.
  const defs = factory ? [
    { key: "locations", query: {}, label: "أضف مستودع الخامات وصالة الإنتاج" },
    { key: "suppliers", query: {}, label: "أضف مورداً" },
    { key: "ingredients", query: {}, label: "أضف الأصناف: الخامات والمنتجات (أو استوردها من Excel)" },
    { key: "purchases", query: { status: "received" }, label: "استلم أول أمر شراء ليصبح للخامات رصيد وتكلفة" },
    { key: "boms", query: { status: "active" }, to: "manufacturing/boms", label: "اعتمد أول قائمة مواد لمنتج" },
    { key: "manufacturing-orders", query: {}, to: "manufacturing/orders", label: "أنشئ أول أمر تشغيل" },
  ] : [
    { key: "locations", query: {}, label: "أضف المطبخ أو المستودع" },
    { key: "suppliers", query: {}, label: "أضف مورداً" },
    { key: "ingredients", query: {}, label: "أضف المواد الخام (أو استوردها من Excel)" },
    { key: "purchases", query: { status: "received" }, label: "استلم أول أمر شراء ليصبح للمواد رصيد وتكلفة" },
    { key: "recipes", query: { status: "approved" }, label: "اعتمد أول وصفة لتظهر في الكاشير" },
  ];
  const results = useQueries({
    queries: defs.map((d) => ({
      queryKey: ["t", tenantId, d.key, { setup: true, ...d.query }],
      queryFn: () => api<Page<unknown>>("GET", `/t/${d.key}`, { tenant: tenantId, query: { ...d.query, pageSize: 1 } }),
      staleTime: 60_000,
    })),
  });
  const steps = defs.map((d, i) => ({ q: results[i]!, label: d.label, to: ("to" in d && d.to) || d.key }));
  if (steps.some((x) => x.q.isPending || x.q.isError)) return null;
  const done = steps.filter((x) => (x.q.data?.meta.total ?? 0) > 0).length;
  if (done === steps.length) return null;
  return (
    <section className="panel panel-pad stack" aria-labelledby="setup-title">
      <div className="row"><h2 id="setup-title">ابدأ من هنا</h2><span className="muted">{integer(done)} من {integer(steps.length)} خطوات</span></div>
      <ol style={{ margin: 0, paddingInlineStart: "var(--sp-6)" }} className="stack">
        {steps.map((x) => {
          const ok = (x.q.data?.meta.total ?? 0) > 0;
          return <li key={x.to}>{ok ? <span className="muted" style={{ textDecoration: "line-through" }}>{x.label}</span> : <Link to={`/w/${tenantId}/${x.to}`}>{x.label}</Link>} {ok && <Badge tone="success">تم</Badge>}</li>;
        })}
      </ol>
    </section>
  );
}

interface StockRow { locationId: string; locationName: string; ingredientId: string; sku: string; name: string; baseUnit: string; quantity: number; avgCost: number; value: number; belowMin: boolean }

export function StockPage() {
  const { tenantId } = useTenant();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [loc, setLoc] = useState("");
  const [page, setPage] = useState(1);
  const prefs = useTablePrefs("stock", { server: true, onSortChange: () => setPage(1) });
  useEffect(() => { const t = setTimeout(() => { setDebounced(q.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);
  const locations = useQuery({ queryKey: ["t", tenantId, "locations", "options"], queryFn: () => api<Page<Location>>("GET", "/t/locations", { tenant: tenantId, query: { pageSize: 100 } }) });
  const list = useQuery({
    queryKey: ["t", tenantId, "stock", { q: debounced, loc, page, sort: prefs.sortParam }],
    queryFn: ({ signal }) => api<Page<StockRow>>("GET", "/t/stock", { tenant: tenantId, signal, query: { q: debounced, locationId: loc, page, pageSize: 50, sort: prefs.sortParam } }),
    placeholderData: keepPreviousData,
  });
  if (locations.isError) return <div className="page"><ErrorState error={locations.error} onRetry={() => locations.refetch()} /></div>;
  return (
    <div className="page">
      <PageHeader eyebrow="المخزون" title="رصيد المخزون" description="الرصيد لكل موقع. يزيد بالاستلام وينقص بالبيع فقط، ولكل حركة سجل لا يُعدَّل." />
      <section className="panel">
        <DataTable caption="رصيد المخزون" prefs={prefs} query={list} rowKey={(r) => `${r.locationId}:${r.ingredientId}`} onPageChange={setPage}
          toolbar={<>
          <SearchInput placeholder="ابحث بالمادة أو الرمز" value={q} onChange={setQ} />
          <select className="select" aria-label="الموقع" value={loc} onChange={(e) => { setLoc(e.target.value); setPage(1); }}>
            <option value="">كل المواقع</option>
            {(locations.data?.items ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          </>}
          filtered={Boolean(debounced || loc)} onClearFilters={() => { setQ(""); setLoc(""); }}
          empty={{ title: "لا يوجد رصيد بعد", body: "يظهر الرصيد بعد استلام أول أمر شراء. أنشئ أمر شراء واعتمده ثم استلمه." }}
          columns={[
            { key: "name", sortKey: "name", header: "المادة", cell: (r) => <strong>{r.name}</strong> },
            { key: "sku", sortKey: "sku", header: "الرمز", cell: (r) => <span className="num">{r.sku}</span> },
            { key: "loc", sortKey: "locationName", header: "الموقع", cell: (r) => r.locationName },
            { key: "qty", sortKey: "quantity", header: "الكمية", numeric: true, cell: (r) => <span className="row" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>{r.belowMin && <Badge tone="warning">تحت الحد</Badge>}{quantity(r.quantity)} {r.baseUnit}</span> },
            { key: "avg", sortKey: "avgCost", header: "متوسط التكلفة", numeric: true, cell: (r) => `${cost(r.avgCost)} / ${r.baseUnit}` },
            { key: "value", sortKey: "value", header: "القيمة", numeric: true, cell: (r) => money(r.value) },
          ]} />
      </section>
    </div>
  );
}
