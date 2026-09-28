import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, CalendarRange, Factory, Play, ShoppingCart } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { api, errorMessage, type Page } from "../../api/client";
import type { Supplier } from "../../api/types";
import { useInvalidate, useTenant } from "../../app/tenant";
import { day, dayTime, integer, quantity } from "../../lib/format";
import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/Dialog";
import { Checkbox, SelectField } from "../../ui/Field";
import { Badge, PageHeader, StatCard } from "../../ui/Layout";
import { EmptyState, ErrorState, TableSkeleton } from "../../ui/States";
import { useToast } from "../../ui/Toast";
import { useLocations } from "./Inventory";

// MRP and the production schedule for factories. The server computes both; this page runs, reads and converts.

interface Suggestion {
  id: string; itemId: string; itemName: string; sku: string; unit: string; purchaseToBase: number; purchaseUnit: string; kind: "make" | "buy"; level: number;
  quantity: number; needDate: string; orderDate: string; supplierId: string | null; supplierName: string | null; status: "open" | "converted" | "dismissed"; convertedTo: string | null; bomId: string | null;
  explanation: { onHand: number; minStock: number; target: number; projectedBefore: number; late: boolean;
    demand: { date: string; quantity: number; source: { type: string; ref?: string; label?: string } }[]; receipts: { date: string; quantity: number; source: { type: string; ref?: string } }[] };
}
interface Latest { run: { id: string; number: number; createdAt: string; params: { horizonDays: number; safetyStock: boolean }; summary: { make: number; buy: number; late: number } } | null; suggestions: Suggestion[] }
const SOURCE: Record<string, string> = { sales_order: "أمر بيع", mo_component: "أمر تشغيل قائم", planned_order: "إنتاج مقترح", mo_output: "إنتاج قائم", purchase_order: "أمر شراء" };

export function MrpPage() {
  const { tenantId, can, writable } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const latest = useQuery({ queryKey: ["t", tenantId, "manufacturing", "mrp"], queryFn: () => api<Latest>("GET", "/t/mrp/runs/latest", { tenant: tenantId }) });
  const locations = useLocations(tenantId);
  const suppliers = useQuery({ queryKey: ["t", tenantId, "suppliers", "options"], queryFn: () => api<Page<Supplier>>("GET", "/t/suppliers", { tenant: tenantId, query: { isActive: "true", pageSize: 100 } }) });
  const [opts, setOpts] = useState({ horizonDays: "90", safetyStock: true });
  const [running, setRunning] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [supplierOf, setSupplierOf] = useState<Record<string, string>>({});
  const [locs, setLocs] = useState({ production: "", output: "", receiving: "" });
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const d = latest.data;
  const openRows = (d?.suggestions ?? []).filter((s) => s.status === "open");
  const chosen = openRows.filter((s) => picked.has(s.id));
  async function run() {
    setRunning(true);
    try {
      const r = await api<{ number: number; summary: { make: number; buy: number; late: number } }>("POST", "/t/mrp/runs", { tenant: tenantId, body: { horizonDays: Number(opts.horizonDays), safetyStock: opts.safetyStock } });
      toast.success(`اكتمل التخطيط رقم ${r.number}: ${integer(r.summary.make)} إنتاج و${integer(r.summary.buy)} شراء${r.summary.late ? `، منها ${integer(r.summary.late)} متأخرة` : ""}`);
      setPicked(new Set());
      await invalidate("manufacturing");
    } catch (e) { toast.error(errorMessage(e)); } finally { setRunning(false); }
  }
  async function convert() {
    const missing = chosen.find((s) => s.kind === "buy" && !(supplierOf[s.id] ?? s.supplierId));
    if (missing) return setErr(`اختر مورد «${missing.itemName}»`);
    if (chosen.some((s) => s.kind === "make") && !locs.production) return setErr("اختر موقع الإنتاج");
    if (chosen.some((s) => s.kind === "buy") && !locs.receiving) return setErr("اختر موقع استلام المشتريات");
    setBusy(true); setErr(null);
    try {
      const r = await api<{ created: { kind: string; number: string }[] }>("POST", "/t/mrp/suggestions/convert", { tenant: tenantId, body: {
        ids: chosen.map((s) => s.id), productionLocationId: locs.production || undefined, outputLocationId: locs.output || undefined, receivingLocationId: locs.receiving || undefined,
        suppliers: Object.fromEntries(chosen.filter((s) => supplierOf[s.id]).map((s) => [s.id, supplierOf[s.id]!])) } });
      toast.success(`أُنشئت مسودات: ${r.created.map((c) => c.number).join("، ")}. راجعها وأكّدها من صفحاتها.`);
      setConfirm(false); setPicked(new Set());
      await invalidate("manufacturing", "purchases");
    } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  }
  async function dismiss(s: Suggestion) {
    try { await api("POST", `/t/mrp/suggestions/${s.id}/dismiss`, { tenant: tenantId }); await invalidate("manufacturing"); }
    catch (e) { toast.error(errorMessage(e)); }
  }
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const canConvert = can("mrp.convert") && writable;
  const table = (kind: "make" | "buy") => {
    const rows = (d?.suggestions ?? []).filter((s) => s.kind === kind);
    if (!rows.length) return <EmptyState title={kind === "make" ? "لا حاجة لإنتاج" : "لا حاجة لشراء"}>{kind === "make" ? "الطلب مغطى بالمخزون وأوامر التشغيل القائمة." : "الخامات مغطاة بالمخزون وأوامر الشراء القائمة."}</EmptyState>;
    return (
      <div className="table-wrap">
        <table className="data-table">
          <caption className="sr-only">{kind === "make" ? "مقترحات الإنتاج" : "مقترحات الشراء"}</caption>
          <thead><tr>{canConvert && <th scope="col"><span className="sr-only">اختيار</span></th>}<th scope="col">الصنف</th><th scope="col" className="end">الكمية</th><th scope="col">مطلوب في</th><th scope="col">يُطلب في</th>
            {kind === "buy" && <th scope="col">المورد</th>}<th scope="col">الحالة</th><th scope="col"><span className="sr-only">إجراءات</span></th></tr></thead>
          <tbody>{rows.map((s) => (
            <Fragment key={s.id}>
              <tr>
                {canConvert && <td>{s.status === "open" && <input type="checkbox" aria-label={`اختيار ${s.itemName}`} checked={picked.has(s.id)} onChange={() => toggle(s.id)} />}</td>}
                <td><strong>{s.itemName}</strong> <span className="muted num">{s.sku}</span>{s.level > 0 && <span className="muted acc-small"> · المستوى {integer(s.level)}</span>}</td>
                <td className="end num">{quantity(s.quantity)} {s.unit}{kind === "buy" && s.purchaseToBase !== 1 && <span className="muted acc-small"> ({quantity(s.quantity / s.purchaseToBase)} {s.purchaseUnit})</span>}</td>
                <td>{day(s.needDate)}</td>
                <td>{day(s.orderDate)}{s.explanation.late && <> <Badge tone="danger">متأخر</Badge></>}</td>
                {kind === "buy" && <td>{s.status === "open" && canConvert
                  ? <select className="select input-sm" aria-label={`مورد ${s.itemName}`} value={supplierOf[s.id] ?? s.supplierId ?? ""} onChange={(e) => setSupplierOf({ ...supplierOf, [s.id]: e.target.value })}>
                      <option value="">اختر المورد</option>{(suppliers.data?.items ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
                  : s.supplierName ?? "—"}</td>}
                <td>{s.status === "open" ? <Badge tone="info">مفتوح</Badge> : s.status === "converted" ? <Badge tone="success">حُوّل</Badge> : <Badge tone="neutral">مستبعد</Badge>}</td>
                <td className="end">
                  <Button size="sm" variant="ghost" aria-expanded={open === s.id} onClick={() => setOpen(open === s.id ? null : s.id)}>لماذا؟</Button>
                  {s.status === "open" && canConvert && <Button size="sm" variant="ghost" onClick={() => void dismiss(s)}>استبعاد</Button>}
                </td>
              </tr>
              {open === s.id && (
                <tr><td colSpan={kind === "buy" ? 8 : 7} className="wrap">
                  <p className="acc-small">الرصيد اليوم {quantity(s.explanation.onHand)}، الحد الأدنى {quantity(s.explanation.minStock)}، الهدف {quantity(s.explanation.target)}. الرصيد المتوقع قبل الطلب في {day(s.needDate)}: <strong className="num">{quantity(s.explanation.projectedBefore)}</strong>.</p>
                  <ul className="acc-small">
                    {s.explanation.demand.map((x, i) => <li key={`d${i}`}>− {quantity(x.quantity)} في {day(x.date)}: {SOURCE[x.source.type] ?? x.source.type} {x.source.ref ?? x.source.label ?? ""}</li>)}
                    {s.explanation.receipts.map((x, i) => <li key={`r${i}`}>+ {quantity(x.quantity)} في {day(x.date)}: {SOURCE[x.source.type] ?? x.source.type} {x.source.ref ?? ""}</li>)}
                  </ul>
                </td></tr>
              )}
            </Fragment>
          ))}</tbody>
        </table>
      </div>
    );
  };
  const locOptions = (locations.data?.items ?? []).map((l) => ({ value: l.id, label: l.name }));
  return (
    <div className="page">
      <PageHeader eyebrow="التصنيع" title="تخطيط الاحتياجات"
        description="يقرأ أوامر البيع المؤكدة وأوامر التشغيل والشراء القائمة والرصيد والحد الأدنى، ثم يقترح ما يُصنع وما يُشترى وموعد طلبه حسب مدة التوريد والإنتاج، مستوى بعد مستوى في قوائم المواد."
        actions={can("mrp.run") && writable && <Button variant="primary" icon={<Play />} loading={running} loadingText="جارٍ التخطيط…" onClick={() => void run()}>تشغيل التخطيط</Button>} />
      {can("mrp.run") && writable && (
        <div className="toolbar panel sr-filter-bar">
          <SelectField label="أفق التخطيط" value={opts.horizonDays} onChange={(e) => setOpts({ ...opts, horizonDays: e.target.value })}
            options={[["30", "30 يوماً"], ["60", "60 يوماً"], ["90", "90 يوماً"], ["180", "6 أشهر"]].map(([value, label]) => ({ value: value!, label: label! }))} />
          <Checkbox label="تعويض ما تحت الحد الأدنى" checked={opts.safetyStock} onChange={(e) => setOpts({ ...opts, safetyStock: e.target.checked })} />
        </div>
      )}
      {latest.isError ? <ErrorState error={latest.error} onRetry={() => latest.refetch()} /> : latest.isPending ? <TableSkeleton columns={6} rows={4} label="جارٍ التحميل…" /> : !d?.run ? (
        <section className="panel"><EmptyState title="لم يُشغَّل التخطيط بعد" action={can("mrp.run") && writable ? <Button variant="primary" icon={<Play />} loading={running} onClick={() => void run()}>تشغيل التخطيط</Button> : undefined}>
          شغّله بعد تأكيد أوامر البيع لترى ما يلزم صنعه وشراؤه ومتى.</EmptyState></section>
      ) : <>
        <p className="muted acc-small">آخر تشغيل رقم <span className="num">{d.run.number}</span> في {dayTime(d.run.createdAt)} · أفق {integer(d.run.params.horizonDays)} يوماً{d.run.params.safetyStock ? " · مع الحد الأدنى" : ""}. أعد التشغيل بعد أي تغيير في الأوامر أو المخزون.</p>
        <div className="stats">
          <StatCard label="اقتراحات إنتاج" value={integer(d.run.summary.make)} icon={<Factory />} hue="indigo" />
          <StatCard label="اقتراحات شراء" value={integer(d.run.summary.buy)} icon={<ShoppingCart />} hue="sky" />
          <StatCard label="موعد طلبها فات" value={integer(d.run.summary.late)} icon={<AlertTriangle />} hue={d.run.summary.late ? "red" : "green"} note="اطلبها اليوم؛ التسليم قد يتأخر" />
        </div>
        <section className="panel" aria-labelledby="mk-h"><div className="toolbar"><h2 id="mk-h">ما يُصنع</h2></div>{table("make")}</section>
        <section className="panel" aria-labelledby="by-h"><div className="toolbar"><h2 id="by-h">ما يُشترى</h2></div>{table("buy")}</section>
        {canConvert && chosen.length > 0 && (
          <div className="pf-form-foot">
            <span>محدد <strong className="num">{integer(chosen.length)}</strong></span>
            <Button variant="primary" onClick={() => { setErr(null); setConfirm(true); }}>تحويل المحدد إلى مسودات</Button>
            <Button variant="ghost" onClick={() => setPicked(new Set())}>إلغاء التحديد</Button>
          </div>
        )}
      </>}
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} busy={busy} error={err} destructive={false} onConfirm={() => void convert()}
        title="تحويل المقترحات" confirmLabel="إنشاء المسودات"
        message={<>يُنشأ أمر تشغيل مسودة لكل مقترح إنتاج، وأمر شراء مسودة لكل مورد. لا يُؤكَّد ولا يُعتمد شيء؛ راجعها من صفحاتها.</>}>
        {chosen.some((s) => s.kind === "make") && <>
          <SelectField label="موقع الإنتاج" required placeholder="اختر" value={locs.production} onChange={(e) => setLocs({ ...locs, production: e.target.value })} options={locOptions} />
          <SelectField label="يُستلم الإنتاج في" optional placeholder="نفس موقع الإنتاج" value={locs.output} onChange={(e) => setLocs({ ...locs, output: e.target.value })} options={locOptions} />
        </>}
        {chosen.some((s) => s.kind === "buy") && <SelectField label="استلام المشتريات في" required placeholder="اختر" value={locs.receiving} onChange={(e) => setLocs({ ...locs, receiving: e.target.value })} options={locOptions} />}
      </ConfirmDialog>
    </div>
  );
}

// ── Schedule (Gantt) ────────────────────────────────────────────────────────────────────────────
interface Sched {
  today: string; horizonDays: number; workCenters: { id: string; name: string; minutesPerDay: number }[];
  operations: { moId: string; seq: number; name: string; workCenterId: string; start: number; end: number; startDate: string; endDate: string }[];
  orders: { moId: string; kind: "mo" | "maintenance"; number: number; label: string; dueDate: string | null; start: number; end: number; finishDate: string; late: boolean; status: string }[];
  load: Record<string, number[]>;
}
const HUES = ["indigo", "sky", "green", "amber", "violet", "orange"] as const;

export function ProductionSchedulePage() {
  const { tenantId } = useTenant();
  const s = useQuery({ queryKey: ["t", tenantId, "manufacturing", "schedule"], queryFn: () => api<Sched>("GET", "/t/production/schedule", { tenant: tenantId }) });
  const d = s.data;
  const days = Math.min(d?.horizonDays ?? 14, 60);
  // Maintenance is a neutral bar: it takes the center's time but is not a product.
  const hue = useMemo(() => new Map((d?.orders ?? []).map((o, i) => [o.moId, o.kind === "maintenance" ? "neutral" : HUES[i % HUES.length]!])), [d]);
  const href = (o: { kind: string; moId: string }) => o.kind === "maintenance" ? `/w/${tenantId}/manufacturing/maintenance` : `/w/${tenantId}/manufacturing/orders/${o.moId}`;
  const ref = (o: { kind: string; number: number }) => `${o.kind === "maintenance" ? "WO" : "MO"}-${o.number}`;
  const dayLabel = (i: number) => d ? new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-latn", { day: "numeric", month: "numeric", timeZone: "UTC" }).format(new Date(Date.parse(`${d.today}T00:00:00Z`) + i * 86_400_000)) : "";
  return (
    <div className="page">
      <PageHeader eyebrow="التصنيع" title="جدولة الإنتاج"
        description="أوامر التشغيل المفتوحة على مراكز العمل بطاقتها اليومية: كل أمر يأخذ دوره حسب تاريخ تسليمه، وكل عملية تبدأ حين يفرغ مركزها وتنتهي العملية التي قبلها." />
      {s.isError ? <ErrorState error={s.error} onRetry={() => s.refetch()} /> : !d ? <TableSkeleton columns={6} rows={4} label="جارٍ حساب الجدول…" /> : !d.orders.length ? (
        <section className="panel"><EmptyState title="لا أوامر تشغيل مفتوحة" action={<Link to={`/w/${tenantId}/manufacturing/orders`} className="btn btn-primary">أوامر التشغيل</Link>}>أنشئ أمراً أو حوّل مقترحات التخطيط لتظهر هنا.</EmptyState></section>
      ) : <>
        <div className="stats">
          <StatCard label="أوامر تشغيل مجدولة" value={integer(d.orders.filter((o) => o.kind !== "maintenance").length)} icon={<CalendarRange />} hue="indigo" />
          <StatCard label="تنتهي بعد موعد تسليمها" value={integer(d.orders.filter((o) => o.late).length)} icon={<AlertTriangle />} hue={d.orders.some((o) => o.late) ? "red" : "green"} />
        </div>
        <section className="panel" aria-label="مخطط جانت">
          <div className="gantt" style={{ ["--days" as string]: days }}>
            <div className="gantt-row gantt-head"><div className="gantt-label">مركز العمل</div>
              <div className="gantt-track">{Array.from({ length: days }, (_, i) => <span key={i} className="gantt-day">{dayLabel(i)}</span>)}</div></div>
            {d.workCenters.map((w) => (
              <div key={w.id} className="gantt-row">
                <div className="gantt-label"><strong>{w.name}</strong><span className="muted acc-small">{integer(w.minutesPerDay / 60)} ساعة/يوم</span></div>
                <div className="gantt-track">
                  {Array.from({ length: days }, (_, i) => {
                    const used = (d.load[w.id]?.[i] ?? 0) / w.minutesPerDay;
                    return <span key={i} className="gantt-cell" data-full={used >= 0.99 || undefined} title={`${Math.round(used * 100)}٪`} />;
                  })}
                  {d.operations.filter((o) => o.workCenterId === w.id && o.start < days).map((o) => {
                    const order = d.orders.find((x) => x.moId === o.moId)!;
                    return (
                      <Link key={`${o.moId}-${o.seq}`} to={href(order)} className={`gantt-bar tag-${hue.get(o.moId)}`} data-late={order.late || undefined}
                        style={{ insetInlineStart: `${(o.start / days) * 100}%`, width: `${(Math.max(0.15, Math.min(o.end, days) - o.start) / days) * 100}%` }}
                        title={`${ref(order)} · ${o.name} · ${day(o.startDate)} → ${day(o.endDate)}`}>
                        <bdi dir="ltr">{ref(order)}</bdi> {o.name}
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </section>
        <section className="panel" aria-labelledby="so-h">
          <div className="toolbar"><h2 id="so-h">الأوامر حسب ترتيب التنفيذ</h2></div>
          <div className="table-wrap">
            <table className="data-table">
              <caption className="sr-only">ترتيب الأوامر</caption>
              <thead><tr><th scope="col">الأمر</th><th scope="col">الحالة</th><th scope="col">يبدأ</th><th scope="col">ينتهي</th><th scope="col">التسليم</th></tr></thead>
              <tbody>{d.orders.map((o) => (
                <tr key={o.moId}>
                  <td><Link to={href(o)}><bdi dir="ltr" className="num">{ref(o)}</bdi></Link> · {o.label}</td>
                  <td>{o.kind === "maintenance" ? <Badge tone="neutral">صيانة</Badge> : o.status === "draft" ? <Badge tone="neutral">مسودة</Badge> : o.status === "confirmed" ? <Badge tone="info">مؤكد</Badge> : <Badge tone="warning">قيد التنفيذ</Badge>}</td>
                  <td>{day(new Date(Date.parse(`${d.today}T00:00:00Z`) + Math.floor(o.start) * 86_400_000).toISOString().slice(0, 10))}</td>
                  <td>{day(o.finishDate)}</td>
                  <td>{o.dueDate ? <>{day(o.dueDate)} {o.late && <Badge tone="danger">متأخر</Badge>}</> : "—"}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      </>}
    </div>
  );
}
