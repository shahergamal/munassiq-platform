import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Archive, Award, Clock, Gauge, Hourglass, Package, PackageX, ShieldCheck, Star, Truck } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client";
import { useTenant } from "../../app/tenant";
import { addDays, day, integer, isoDay, money, percent, quantity } from "../../lib/format";
import { DataTable } from "../../ui/DataTable";
import { DateRange } from "../../ui/DateRange";
import { Badge, PageHeader, StatCard } from "../../ui/Layout";
import { StatusTabs, useLocations } from "./Inventory";

function usePeriod(days = 30) {
  const [from, setFrom] = useState(addDays(isoDay(), -(days - 1)));
  const [to, setTo] = useState(isoDay());
  return { from, to, range: <DateRange from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} /> };
}

// ── Menu engineering ─────────────────────────────────────────────────────────────────
type MenuClass = "star" | "plowhorse" | "puzzle" | "dog";
interface MeRow { recipeId: string; name: string; category: string | null; sold: number; sales: number; cost: number; mixPercent: number; avgPrice: number; unitCost: number; contributionMargin: number; totalMargin: number; foodCostPercent: number; class: MenuClass }
const CLASS: Record<MenuClass, { label: string; tone: "success" | "info" | "warning" | "danger"; action: string }> = {
  star: { label: "نجم", tone: "success", action: "احمِه: جودة ثابتة ومكان بارز في المنيو" },
  plowhorse: { label: "حصان عمل", tone: "info", action: "مطلوب لكن ربحه ضعيف: ارفع السعر قليلاً أو خفّض تكلفة الوصفة" },
  puzzle: { label: "لغز", tone: "warning", action: "ربحه عالٍ ومبيعه قليل: روّج له، غيّر اسمه أو موضعه" },
  dog: { label: "عبء", tone: "danger", action: "ضعيف في الاثنين: أعد تصميمه أو احذفه من المنيو" },
};

export function MenuEngineeringReport() {
  const { tenantId } = useTenant();
  const p = usePeriod();
  const [cls, setCls] = useState("");
  const r = useQuery({ queryKey: ["t", tenantId, "reports", "menu-engineering", p.from, p.to], placeholderData: keepPreviousData,
    queryFn: () => api<{ items: MeRow[]; thresholds: { popularityPercent: number; averageMargin: number }; totals: { sold: number; margin: number } }>("GET", "/t/reports/menu-engineering", { tenant: tenantId, query: { from: p.from, to: p.to } }) });
  const items = (r.data?.items ?? []).filter((x) => !cls || x.class === cls);
  const count = (c: MenuClass) => (r.data?.items ?? []).filter((x) => x.class === c).length;
  return (
    <div className="page">
      <PageHeader eyebrow="التقارير" title="هندسة المنيو" description="كل صنف حسب شعبيته (نصيبه من المبيعات) وربحيته (السعر ناقص تكلفة الطعام). يخبرك أي صنف تحميه وأيّها ترفع سعره أو تروّج له أو تحذفه." />
      <div className="toolbar panel sr-filter-bar" role="group" aria-label="الفترة">{p.range}</div>
      {r.data && <div className="stats stats-4">
        <StatCard label="نجوم" value={integer(count("star"))} note="شعبية وربح عاليان" icon={<Star />} hue="green" />
        <StatCard label="أحصنة عمل" value={integer(count("plowhorse"))} note="شعبية عالية، ربح أقل" icon={<Award />} hue="sky" />
        <StatCard label="ألغاز" value={integer(count("puzzle"))} note="ربح عالٍ، مبيع قليل" icon={<Gauge />} hue="amber" />
        <StatCard label="أعباء" value={integer(count("dog"))} note={`متوسط هامش الصنف ${money(r.data.thresholds.averageMargin)}`} icon={<PackageX />} hue="red" />
      </div>}
      <section className="panel">
        <DataTable caption="هندسة المنيو" tableId="menu-engineering" query={{ ...r, data: r.data ? { items } : undefined }} rowKey={(x) => x.recipeId}
          toolbar={<StatusTabs value={cls} onChange={setCls} options={[["", "الكل"], ["star", "نجوم"], ["plowhorse", "أحصنة عمل"], ["puzzle", "ألغاز"], ["dog", "أعباء"]]} />}
          filtered={Boolean(cls)} onClearFilters={() => setCls("")}
          empty={{ title: "لا توجد مبيعات في الفترة", body: "يظهر التحليل بعد البيع من الكاشير." }}
          columns={[
            { key: "name", header: "الصنف", cell: (x) => <Link to={`/w/${tenantId}/recipes/${x.recipeId}`}><strong>{x.name}</strong></Link> },
            { key: "class", header: "التصنيف", sortKey: false, cell: (x) => <span title={CLASS[x.class].action}><Badge tone={CLASS[x.class].tone}>{CLASS[x.class].label}</Badge></span> },
            { key: "sold", header: "المباع", numeric: true, cell: (x) => <>{integer(x.sold)}<div className="muted">{percent(x.mixPercent)} من المزيج</div></> },
            { key: "avgPrice", header: "متوسط السعر", numeric: true, cell: (x) => money(x.avgPrice) },
            { key: "foodCostPercent", header: "تكلفة الطعام", numeric: true, cell: (x) => <>{money(x.unitCost)}<div className="muted">{percent(x.foodCostPercent)}</div></> },
            { key: "contributionMargin", header: "هامش الصنف", numeric: true, cell: (x) => money(x.contributionMargin) },
            { key: "totalMargin", header: "إجمالي الهامش", numeric: true, cell: (x) => money(x.totalMargin) },
            { key: "action", header: "التوصية", sortKey: false, wrap: true, cell: (x) => <span className="muted">{CLASS[x.class].action}</span> },
          ]} />
      </section>
    </div>
  );
}

// ── Stock turnover & dead stock ──────────────────────────────────────────────────────
interface TurnRow { ingredientId: string; name: string; category: string | null; unit: string; onHand: number; stockValue: number; usedQty: number; usedValue: number; turnover: number | null; daysOnHand: number | null; idleDays: number | null; dead: boolean }

export function StockTurnoverReport() {
  const { tenantId } = useTenant();
  const p = usePeriod();
  const locations = useLocations(tenantId);
  const [loc, setLoc] = useState("");
  const [only, setOnly] = useState("");
  const r = useQuery({ queryKey: ["t", tenantId, "reports", "turnover", p.from, p.to, loc], placeholderData: keepPreviousData,
    queryFn: () => api<{ items: TurnRow[]; idleDays: number; totals: { stockValue: number; usedValue: number; turnover: number | null; daysOnHand: number | null; deadValue: number; deadCount: number } }>("GET", "/t/reports/stock-turnover", { tenant: tenantId, query: { from: p.from, to: p.to, locationId: loc || undefined } }) });
  const t = r.data?.totals;
  const items = (r.data?.items ?? []).filter((x) => !only || (only === "dead" ? x.dead : (x.daysOnHand ?? 0) > 30));
  return (
    <div className="page">
      <PageHeader eyebrow="التقارير" title="دوران المخزون والراكد" description="كم يوماً يكفي المخزون الحالي بمعدل الاستهلاك، وما المواد الراكدة التي تجمّد نقدك." />
      <div className="toolbar panel sr-filter-bar">
        <select className="select" aria-label="الموقع" value={loc} onChange={(e) => setLoc(e.target.value)}>
          <option value="">كل المواقع</option>{(locations.data?.items ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <span className="sr-filter-sep" aria-hidden="true" />
        <div role="group" aria-label="الفترة">{p.range}</div>
      </div>
      {t && <div className="stats stats-4">
        <StatCard label="قيمة المخزون الحالية" value={money(t.stockValue)} icon={<Package />} hue="indigo" />
        <StatCard label="الاستهلاك في الفترة" value={money(t.usedValue)} note={t.turnover !== null ? `معدل الدوران ${t.turnover} مرة` : undefined} icon={<Gauge />} hue="sky" />
        <StatCard label="أيام التغطية" value={t.daysOnHand === null ? "—" : `${integer(t.daysOnHand)} يوم`} note="قيمة المخزون ÷ متوسط الاستهلاك اليومي" icon={<Hourglass />} hue="amber" />
        <StatCard label="مخزون راكد" value={money(t.deadValue)} note={`${integer(t.deadCount)} مادة بلا استهلاك ${integer(r.data!.idleDays)} يوماً`} noteTone={t.deadCount ? "warning" : undefined} icon={<Archive />} hue="red" />
      </div>}
      <section className="panel">
        <DataTable caption="دوران المخزون" tableId="stock-turnover" query={{ ...r, data: r.data ? { items } : undefined }} rowKey={(x) => x.ingredientId}
          toolbar={<StatusTabs value={only} onChange={setOnly} options={[["", "الكل"], ["dead", "الراكد"], ["slow", "تغطية أكثر من 30 يوماً"]]} />}
          filtered={Boolean(only)} onClearFilters={() => setOnly("")}
          empty={{ title: "لا يوجد مخزون أو استهلاك", body: "يظهر التقرير بعد الاستلام والبيع." }}
          columns={[
            { key: "name", header: "المادة", cell: (x) => <Link to={`/w/${tenantId}/movements?ingredientId=${x.ingredientId}`}><strong>{x.name}</strong></Link> },
            { key: "category", header: "الفئة", cell: (x) => x.category ?? "—" },
            { key: "stockValue", header: "الرصيد", numeric: true, cell: (x) => <>{quantity(x.onHand)} {x.unit}<div className="muted">{money(x.stockValue)}</div></> },
            { key: "usedValue", header: "الاستهلاك", numeric: true, cell: (x) => <>{quantity(x.usedQty)} {x.unit}<div className="muted">{money(x.usedValue)}</div></> },
            { key: "daysOnHand", header: "أيام التغطية", numeric: true, cell: (x) => (x.daysOnHand === null ? "—" : x.daysOnHand > 30 ? <Badge tone="warning">{integer(x.daysOnHand)}</Badge> : integer(x.daysOnHand)) },
            { key: "idleDays", header: "آخر استهلاك", numeric: true, cell: (x) => (x.dead ? <Badge tone="danger">{x.idleDays === null ? "لم يُستهلك" : `منذ ${integer(x.idleDays)} يوم`}</Badge> : x.idleDays === null ? "—" : `منذ ${integer(x.idleDays)} يوم`) },
          ]} />
      </section>
    </div>
  );
}

// ── Supplier performance ────────────────────────────────────────────────────────────
interface SupRow { supplierId: string; name: string; receipts: number; net: number; vat: number; priceVariance: number; rejectedLines: number; rejectedValue: number; onTimePercent: number | null; qualityPercent: number | null; invoiceMismatches: number; missingInvoices: number; onOrder: number; sharePercent: number }

export function SupplierPerformanceReport() {
  const { tenantId } = useTenant();
  const p = usePeriod(90);
  const r = useQuery({ queryKey: ["t", tenantId, "reports", "suppliers", p.from, p.to], placeholderData: keepPreviousData,
    queryFn: () => api<{ items: SupRow[]; total: number }>("GET", "/t/reports/supplier-performance", { tenant: tenantId, query: { from: p.from, to: p.to } }) });
  const items = r.data?.items ?? [];
  const pv = items.reduce((a, x) => a + x.priceVariance, 0);
  const mism = items.reduce((a, x) => a + x.invoiceMismatches + x.missingInvoices, 0);
  const onOrder = items.reduce((a, x) => a + x.onOrder, 0);
  return (
    <div className="page">
      <PageHeader eyebrow="التقارير" title="تقييم الموردين" description="حجم الشراء من كل مورد، والتزامه بالسعر المتفق عليه وبموعد التوريد، وجودة ما يورّده، ومطابقة فواتيره. أساس التفاوض واختيار الموردين." />
      <div className="toolbar panel sr-filter-bar" role="group" aria-label="الفترة">{p.range}</div>
      {r.data && <div className="stats stats-4">
        <StatCard label="المشتريات في الفترة" value={money(r.data.total)} note="قبل الضريبة" icon={<Truck />} hue="indigo" />
        <StatCard label="فروق الأسعار عن أوامر الشراء" value={money(pv)} note={pv > 0 ? "دُفع أكثر من المتفق عليه" : "ضمن الأسعار المتفق عليها"} noteTone={pv > 0 ? "warning" : undefined} icon={<ShieldCheck />} hue={pv > 0 ? "red" : "green"} />
        <StatCard label="فواتير تحتاج مطابقة" value={integer(mism)} note="بلا فاتورة أو مبلغها لا يطابق الاستلام" noteTone={mism ? "warning" : undefined} icon={<Clock />} hue="amber" />
        <StatCard label="قيد التوريد" value={money(onOrder)} note="المتبقي من أوامر معتمدة" icon={<Package />} hue="sky" />
      </div>}
      <section className="panel">
        <DataTable caption="تقييم الموردين" tableId="supplier-performance" query={{ ...r, data: r.data ? { items } : undefined }} rowKey={(x) => x.supplierId}
          empty={{ title: "لا مشتريات في الفترة", body: "يظهر التقييم بعد استلام شحنات من الموردين." }}
          columns={[
            { key: "name", header: "المورد", cell: (x) => <Link to={`/w/${tenantId}/payables/${x.supplierId}`}><strong>{x.name}</strong></Link> },
            { key: "net", header: "المشتريات", numeric: true, cell: (x) => <>{money(x.net)}<div className="muted">{percent(x.sharePercent)} · {integer(x.receipts)} شحنة</div></> },
            { key: "priceVariance", header: "فرق السعر", numeric: true, cell: (x) => (Math.abs(x.priceVariance) < 0.01 ? "—" : <Badge tone={x.priceVariance > 0 ? "danger" : "success"}>{money(x.priceVariance)}</Badge>) },
            { key: "onTimePercent", header: "الالتزام بالموعد", numeric: true, cell: (x) => (x.onTimePercent === null ? <span className="muted">بلا موعد</span> : <Badge tone={x.onTimePercent >= 90 ? "success" : x.onTimePercent >= 70 ? "warning" : "danger"}>{percent(x.onTimePercent)}</Badge>) },
            { key: "qualityPercent", header: "الجودة", numeric: true, cell: (x) => (x.qualityPercent === null ? "—" : <>{<Badge tone={x.qualityPercent >= 98 ? "success" : x.qualityPercent >= 90 ? "warning" : "danger"}>{percent(x.qualityPercent)}</Badge>}{x.rejectedValue > 0 && <div className="muted">مرفوض {money(x.rejectedValue)}</div>}</>) },
            { key: "invoiceMismatches", header: "المطابقة", numeric: true, cell: (x) => (x.invoiceMismatches + x.missingInvoices === 0 ? <Badge tone="success">مطابقة</Badge> : <Badge tone="warning">{integer(x.invoiceMismatches + x.missingInvoices)} تحتاج مراجعة</Badge>) },
            { key: "onOrder", header: "قيد التوريد", numeric: true, cell: (x) => (x.onOrder ? money(x.onOrder) : "—") },
          ]} />
      </section>
      <p className="muted acc-small">من {day(p.from)} إلى {day(p.to)}. الالتزام بالموعد يُحسب لأوامر الشراء التي لها «تاريخ توريد متوقع».</p>
    </div>
  );
}
