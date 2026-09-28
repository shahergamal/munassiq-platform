import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Coins, FileText, Landmark, Percent, Receipt, Scale, ShoppingCart, Tag, Target, TrendingDown, Wallet } from "lucide-react";
import { useState } from "react";
import { api, type Page } from "../../api/client";
import { useTenant } from "../../app/tenant";
import { addDays, cost, day, integer, isoDay, money, percent, quantity } from "../../lib/format";
import { DataTable } from "../../ui/DataTable";
import { DateRange } from "../../ui/DateRange";
import { Badge, PageHeader, StatCard } from "../../ui/Layout";
import { EmptyState, ErrorState, Skeleton } from "../../ui/States";
import { useLocations } from "./Inventory";

function usePeriod(days = 30) {
  const [from, setFrom] = useState(addDays(isoDay(), -(days - 1)));
  const [to, setTo] = useState(isoDay());
  const range = <DateRange from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} />;
  return { from, to, range, bar: <div className="toolbar panel sr-filter-bar" role="group" aria-label="الفترة">{range}</div> };
}

const signedMoney = (v: number) => <span className={v > 0 ? "sr-neg" : undefined}>{money(v)}</span>;

// ── Ideal vs actual ─────────────────────────────────────────────────────────────────────────────
interface IvaRow { ingredientId: string; name: string; unit: string; idealQty: number; idealValue: number; wasteQty: number; wasteValue: number; countQty: number; countValue: number; actualQty: number; actualValue: number; varianceValue: number; variancePercent: number | null }

export function IdealVsActualReport() {
  const { tenantId } = useTenant();
  const p = usePeriod();
  const locations = useLocations(tenantId);
  const [loc, setLoc] = useState("");
  const r = useQuery({ queryKey: ["t", tenantId, "reports", "iva", p.from, p.to, loc], placeholderData: keepPreviousData,
    queryFn: () => api<{ items: IvaRow[]; totals: { idealValue: number; actualValue: number; wasteValue: number; countValue: number; netSales: number; idealFoodCostPercent: number | null; actualFoodCostPercent: number | null } }>("GET", "/t/reports/ideal-vs-actual", { tenant: tenantId, query: { from: p.from, to: p.to, locationId: loc } }) });
  const t = r.data?.totals;
  return (
    <div className="page">
      <PageHeader eyebrow="التقارير" title="المثالي مقابل الفعلي" description="ما كان يجب استهلاكه حسب الوصفات لما بِيع، مقابل ما خرج فعلاً (بإضافة الهدر المسجل وعجز الجرد). الفرق الكبير في مادة يعني فاقداً يحتاج متابعة." />
      <div className="toolbar panel sr-filter-bar">
        <select className="select" aria-label="الموقع" value={loc} onChange={(e) => setLoc(e.target.value)}>
          <option value="">كل المواقع</option>{(locations.data?.items ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <span className="sr-filter-sep" aria-hidden="true" />
        <div role="group" aria-label="الفترة">{p.range}</div>
      </div>
      {t && <div className="stats">
        <StatCard label="تكلفة الطعام المثالية" value={percent(t.idealFoodCostPercent)} note={`${money(t.idealValue)} من صافي مبيعات ${money(t.netSales)}`} icon={<Target />} hue="indigo" />
        <StatCard label="تكلفة الطعام الفعلية" value={percent(t.actualFoodCostPercent)} note={money(t.actualValue)} noteTone={t.actualValue > t.idealValue ? "warning" : undefined} icon={<Scale />} hue="sky" />
        <StatCard label="الفرق (هدر + عجز جرد)" value={money(t.actualValue - t.idealValue)} note={`هدر ${money(t.wasteValue)} · جرد ${money(t.countValue)}`} noteTone={t.actualValue > t.idealValue ? "warning" : undefined} icon={<TrendingDown />} hue="red" />
      </div>}
      <section className="panel">
        <DataTable caption="المثالي مقابل الفعلي" query={{ ...r, data: r.data ? { items: r.data.items } : undefined }} rowKey={(x) => x.ingredientId}
          empty={{ title: "لا توجد حركات بيع أو هدر أو جرد في الفترة", body: "يظهر التقرير بعد البيع من الكاشير، ويصبح أدق مع تسجيل الهدر والجرد الدوري." }}
          columns={[
            { key: "n", sortKey: "name", header: "المادة", cell: (x) => <Link to={`/w/${tenantId}/movements?ingredientId=${x.ingredientId}`}><strong>{x.name}</strong></Link> },
            { key: "i", sortKey: "idealValue", header: "المثالي", numeric: true, cell: (x) => <>{quantity(x.idealQty)} {x.unit}<div className="muted">{money(x.idealValue)}</div></> },
            { key: "w", sortKey: "wasteValue", header: "الهدر", numeric: true, cell: (x) => (x.wasteQty ? <>{quantity(x.wasteQty)} {x.unit}<div className="muted">{money(x.wasteValue)}</div></> : "—") },
            { key: "c", sortKey: "countValue", header: "عجز الجرد", numeric: true, cell: (x) => (x.countQty ? <>{quantity(x.countQty)} {x.unit}<div className="muted">{money(x.countValue)}</div></> : "—") },
            { key: "a", sortKey: "actualValue", header: "الفعلي", numeric: true, cell: (x) => <>{quantity(x.actualQty)} {x.unit}<div className="muted">{money(x.actualValue)}</div></> },
            { key: "v", sortKey: "varianceValue", header: "الفرق", numeric: true, cell: (x) => <span className="sr-num-cell">{x.variancePercent !== null && Math.abs(x.variancePercent) >= 5 && <Badge tone={x.varianceValue > 0 ? "danger" : "success"}>{percent(x.variancePercent)}</Badge>}{signedMoney(x.varianceValue)}</span> },
          ]} />
      </section>
    </div>
  );
}

// ── Recipe explosion ────────────────────────────────────────────────────────────────────────────
interface Explosion { recipe: { id: string; name: string; priceNet: number; packagingCost: number; ingredientCost: number; totalCost: number; foodCostPercent: number | null } | null; lines: { ingredientId: string; name: string; unit: string; rawQty: number; unitCost: number; cost: number; viaPrep: string | null; missing: boolean; sharePercent: number }[] }

export function RecipeExplosionReport() {
  const { tenantId } = useTenant();
  const recipes = useQuery({ queryKey: ["t", tenantId, "recipes", "options"], queryFn: () => api<Page<{ id: string; name: string; status: string }>>("GET", "/t/recipes", { tenant: tenantId, query: { pageSize: 100 } }) });
  const [recipeId, setRecipeId] = useState("");
  const r = useQuery({ enabled: Boolean(recipeId), queryKey: ["t", tenantId, "reports", "explosion", recipeId], queryFn: () => api<Explosion>("GET", "/t/reports/recipe-explosion", { tenant: tenantId, query: { recipeId } }) });
  const rec = r.data?.recipe;
  return (
    <div className="page">
      <PageHeader eyebrow="التقارير" title="تفجير تكلفة الوصفة" description="من أين تأتي تكلفة الطبق؟ كل مادة ونصيبها من التكلفة. الأصناف المحضّرة تُفكّك إلى خاماتها." />
      <div className="toolbar panel sr-filter-bar">
        <label className="row"><span className="field-label">الوصفة</span>
          <select className="select" value={recipeId} onChange={(e) => setRecipeId(e.target.value)}>
            <option value="">اختر وصفة</option>{(recipes.data?.items ?? []).filter((x) => x.status !== "archived").map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </label>
      </div>
      {!recipeId ? <EmptyState title="اختر وصفة لعرض تفصيل تكلفتها" /> : r.isPending ? <Skeleton width="50%" /> : r.isError ? <ErrorState error={r.error} onRetry={() => r.refetch()} /> : rec && <>
        <div className="stats">
          <StatCard label="سعر البيع قبل الضريبة" value={money(rec.priceNet)} icon={<Tag />} hue="indigo" />
          <StatCard label="التكلفة" value={money(rec.totalCost)} note={rec.packagingCost ? `منها تغليف ${money(rec.packagingCost)}` : undefined} icon={<Coins />} hue="sky" />
          <StatCard label="نسبة تكلفة الطعام" value={percent(rec.foodCostPercent)} icon={<Percent />} hue="amber" />
        </div>
        <section className="panel" aria-labelledby="explosion-h">
          <div className="toolbar">
            <h2 id="explosion-h">تفصيل تكلفة {rec.name}</h2>
            <span className="spacer" />
            <span className="muted"><span className="num">{integer(r.data!.lines.length)}</span> مادة</span>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <caption className="sr-only">تفصيل تكلفة {rec.name}</caption>
              <thead><tr><th scope="col">المادة</th><th scope="col" className="end">الكمية الخام</th><th scope="col" className="end">تكلفة الوحدة</th><th scope="col" className="end">التكلفة</th><th scope="col">النصيب من التكلفة</th></tr></thead>
              <tbody>{r.data!.lines.map((l, i) => (
                <tr key={`${l.ingredientId}-${i}`}>
                  <td><strong>{l.name}</strong>{l.viaPrep && <div className="muted" style={{ fontSize: "var(--fs-xs)" }}>عبر {l.viaPrep}</div>}</td>
                  <td className="end num">{quantity(l.rawQty)} {l.unit}</td>
                  <td className="end num">{l.missing ? <Badge tone="warning">بلا تكلفة</Badge> : cost(l.unitCost)}</td>
                  <td className="end num">{money(l.cost)}</td>
                  <td className="sr-share-cell">
                    <div className="sr-share">
                      <div className="sr-share-track" aria-hidden="true"><div className="sr-share-fill" style={{ width: `${Math.min(100, l.sharePercent)}%` }} /></div>
                      <span className="num">{percent(l.sharePercent)}</span>
                    </div>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      </>}
    </div>
  );
}

// ── Purchase prices ─────────────────────────────────────────────────────────────────────────────
interface PriceRow { ingredientId: string; name: string; unit: string; receipts: number; minCost: number; maxCost: number; weightedAvg: number; firstCost: number; lastCost: number; lastSupplier: string; currentAvg: number; changePercent: number | null }

export function PurchasePricesReport() {
  const { tenantId } = useTenant();
  const p = usePeriod(90);
  const r = useQuery({ queryKey: ["t", tenantId, "reports", "prices", p.from, p.to], placeholderData: keepPreviousData, queryFn: () => api<{ items: PriceRow[] }>("GET", "/t/reports/purchase-prices", { tenant: tenantId, query: { from: p.from, to: p.to } }) });
  return (
    <div className="page">
      <PageHeader eyebrow="التقارير" title="أسعار الشراء وتغيّرها" description="التكلفة الواصلة لوحدة الأساس في كل استلام خلال الفترة، والتغير بين أول وآخر سعر. الارتفاع الكبير يستدعي مراجعة سعر البيع." />
      {p.bar}
      <section className="panel">
        <DataTable caption="أسعار الشراء" query={{ ...r, data: r.data ? { items: r.data.items } : undefined }} rowKey={(x) => x.ingredientId}
          empty={{ title: "لا توجد استلامات في الفترة", body: "" }}
          columns={[
            { key: "n", sortKey: "name", header: "المادة", cell: (x) => <><strong>{x.name}</strong><div className="muted" style={{ fontSize: "var(--fs-xs)" }}>آخر مورد: {x.lastSupplier}</div></> },
            { key: "r", sortKey: "receipts", header: "الاستلامات", numeric: true, cell: (x) => integer(x.receipts) },
            { key: "min", sortKey: "minCost", header: "الأدنى", numeric: true, cell: (x) => cost(x.minCost) },
            { key: "max", sortKey: "maxCost", header: "الأعلى", numeric: true, cell: (x) => cost(x.maxCost) },
            { key: "avg", sortKey: "weightedAvg", header: "المتوسط المرجح", numeric: true, cell: (x) => cost(x.weightedAvg) },
            { key: "last", sortKey: "lastCost", header: "آخر سعر", numeric: true, cell: (x) => <>{cost(x.lastCost)} / {x.unit}</> },
            { key: "ch", sortKey: "changePercent", header: "التغير", numeric: true, cell: (x) => (x.changePercent === null || x.changePercent === 0 ? "—" : <Badge tone={x.changePercent > 0 ? "danger" : "success"}>{x.changePercent > 0 ? "+" : ""}{percent(x.changePercent)}</Badge>) },
          ]} />
      </section>
    </div>
  );
}

// ── Cashier reconciliation ──────────────────────────────────────────────────────────────────────
export function CashierReconciliationReport() {
  const { tenantId } = useTenant();
  const p = usePeriod();
  const r = useQuery({ queryKey: ["t", tenantId, "reports", "cashiers", p.from, p.to], placeholderData: keepPreviousData,
    queryFn: () => api<{ items: { cashier: string; shifts: number; sales: number; expected: number; counted: number; overShort: number; worst: number; lastClosed: string }[] }>("GET", "/t/reports/cashier-reconciliation", { tenant: tenantId, query: { from: p.from, to: p.to } }) });
  return (
    <div className="page">
      <PageHeader eyebrow="التقارير" title="تسوية الكاشير" description="الشفتات المغلقة لكل كاشير: النقد المتوقع مقابل المعدود (العد أعمى). العجز المتكرر عند كاشير واحد يحتاج مراجعة." />
      {p.bar}
      <section className="panel">
        <DataTable caption="تسوية الكاشير" query={{ ...r, data: r.data ? { items: r.data.items.map((x) => ({ ...x, shortfall: x.worst < 0 ? -x.worst : null })) } : undefined }} rowKey={(x) => x.cashier}
          empty={{ title: "لا توجد شفتات مغلقة في الفترة", body: "" }}
          columns={[
            { key: "c", sortKey: "cashier", header: "الكاشير", cell: (x) => <strong>{x.cashier}</strong> },
            { key: "s", sortKey: "shifts", header: "الشفتات", numeric: true, cell: (x) => integer(x.shifts) },
            { key: "sales", header: "المبيعات", numeric: true, cell: (x) => money(x.sales) },
            { key: "e", sortKey: "expected", header: "النقد المتوقع", numeric: true, cell: (x) => money(x.expected) },
            { key: "n", sortKey: "counted", header: "المعدود", numeric: true, cell: (x) => money(x.counted) },
            { key: "o", sortKey: "overShort", header: "صافي العجز/الزيادة", numeric: true, cell: (x) => (x.overShort === 0 ? <Badge tone="success">مطابق</Badge> : <Badge tone={x.overShort < 0 ? "danger" : "warning"}>{x.overShort < 0 ? "عجز" : "زيادة"} {money(Math.abs(x.overShort))}</Badge>) },
            { key: "w", sortKey: "shortfall", header: "أكبر عجز في شفت", numeric: true, cell: (x) => money(x.shortfall) },
            { key: "l", sortKey: "lastClosed", header: "آخر إغلاق", cell: (x) => day(x.lastClosed) },
          ]} />
      </section>
    </div>
  );
}

// ── VAT ─────────────────────────────────────────────────────────────────────────────────────────
export function VatReport() {
  const { tenantId } = useTenant();
  const p = usePeriod();
  const r = useQuery({ queryKey: ["t", tenantId, "reports", "vat", p.from, p.to], placeholderData: keepPreviousData,
    queryFn: () => api<{ days: { day: string; invoices: number; creditNotes: number; salesTotal: number; salesVat: number; creditTotal: number; creditVat: number }[]; summary: { taxableSales: number; outputVat: number; inputVatPurchases: number; purchasesWithVat: number; returnsVat: number; inputVatExpenses: number; expensesWithVat: number; netVat: number }; notes: string[] }>("GET", "/t/reports/vat", { tenant: tenantId, query: { from: p.from, to: p.to } }) });
  const s = r.data?.summary;
  return (
    <div className="page">
      <PageHeader eyebrow="التقارير" title="ملخص ضريبة القيمة المضافة" description="ضريبة المخرجات من الفواتير المبسطة المصدرة ناقص الإشعارات الدائنة، وضريبة المدخلات من المشتريات المستلمة (ناقص المرتجعات) والمصروفات المعتمدة." />
      {p.bar}
      {r.data && r.data.notes.length > 0 && <p className="banner banner-warning sr-note">{r.data.notes.join(" ")}</p>}
      {s && <div className="stats">
        <StatCard label="المبيعات الخاضعة" value={money(s.taxableSales)} icon={<Receipt />} hue="indigo" />
        <StatCard label="ضريبة المخرجات" value={money(s.outputVat)} icon={<FileText />} hue="sky" />
        <StatCard label="ضريبة المدخلات (المشتريات)" value={money(s.inputVatPurchases)} note={`${integer(s.purchasesWithVat)} أمر شراء${s.returnsVat > 0 ? ` · مرتجعات −${money(s.returnsVat)}` : ""}`} icon={<ShoppingCart />} hue="orange" />
        <StatCard label="ضريبة المدخلات (المصروفات)" value={money(s.inputVatExpenses)} note={`${integer(s.expensesWithVat)} مصروف`} icon={<Wallet />} hue="green" />
        <StatCard label="الصافي" value={money(s.netVat)} note={s.netVat >= 0 ? "مستحق للهيئة (تقديري)" : "رصيد لصالحك (تقديري)"} icon={<Landmark />} hue="violet" />
      </div>}
      <section className="panel">
        <DataTable caption="الفواتير حسب اليوم" query={{ ...r, data: r.data ? { items: r.data.days.map((x) => ({ ...x, netVat: Math.round((x.salesVat - x.creditVat) * 100) / 100 })) } : undefined }} rowKey={(x) => x.day}
          empty={{ title: "لا توجد فواتير في الفترة", body: "" }}
          columns={[
            { key: "d", sortKey: "day", header: "اليوم", cell: (x) => <strong>{day(x.day)}</strong> },
            { key: "i", sortKey: "invoices", header: "فواتير", numeric: true, cell: (x) => integer(x.invoices) },
            { key: "st", sortKey: "salesTotal", header: "المبيعات شامل الضريبة", numeric: true, cell: (x) => money(x.salesTotal) },
            { key: "sv", sortKey: "salesVat", header: "ضريبة المبيعات", numeric: true, cell: (x) => money(x.salesVat) },
            { key: "c", sortKey: "creditTotal", header: "إشعارات دائنة", numeric: true, cell: (x) => (x.creditNotes ? `${integer(x.creditNotes)} · ${money(x.creditTotal)}` : "—") },
            { key: "cv", sortKey: "creditVat", header: "ضريبة المرتجعات", numeric: true, cell: (x) => (x.creditVat ? money(x.creditVat) : "—") },
            { key: "n", sortKey: "netVat", header: "صافي الضريبة", numeric: true, cell: (x) => money(x.netVat) },
          ]} />
      </section>
    </div>
  );
}
