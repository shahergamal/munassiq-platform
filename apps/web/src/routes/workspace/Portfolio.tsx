import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Banknote, Briefcase, Download, TrendingDown, TrendingUp } from "lucide-react";
import { useState } from "react";
import { api, download, errorMessage } from "../../api/client";
import { useTenant } from "../../app/tenant";
import { money, percent } from "../../lib/format";
import { Button } from "../../ui/Button";
import { DataTable } from "../../ui/DataTable";
import { Badge, PageHeader, StatCard } from "../../ui/Layout";
import { useToast } from "../../ui/Toast";
import { StatusTabs } from "./Inventory";

// Contracting C13: the director's view. Every open project's value, progress, estimate at completion and margin
// with the flags to act on (loss, behind, over cost, lost-time injury, no estimate), and the cash forecast of all
// projects together. An unknown estimate is shown as unknown, never as a zero margin.

interface Item { id: string; code: string; name: string; status: string; client: string | null; contractValue: number; certified: number; progressPct: number | null; billed: number;
  receivable: number; retentionReceivable: number; costToDate: number; committed: number; budget: number; eac: number | null; eacBasis: "evm" | "budget" | "estimate" | null;
  margin: number | null; marginPct: number | null; backlog: number; spi: number | null; cpi: number | null; openNcrs: number; lostTimeInjuries: number; flags: string[] }
interface Portfolio { asOf: string; items: Item[]; totals: { contractValue: number; certified: number; billed: number; receivable: number; retentionReceivable: number; costToDate: number;
  committed: number; backlog: number; margin: number; marginOf: number; unknownMargin: number } }
interface Forecast { basis: string; items: { period: string; inflow: number; outflow: number; net: number; cumulative: number }[]; projects: { id: string; code: string; name: string; hasSchedule: boolean; net: number; lowest: number }[] }

const FLAG: Record<string, [string, "danger" | "warning"]> = { loss: ["خسارة متوقعة", "danger"], behind: ["متأخر عن البرنامج", "warning"], over_cost: ["تجاوز التكلفة", "danger"],
  lti: ["إصابة مضيعة للوقت", "danger"], no_estimate: ["بلا تقدير للتكلفة", "warning"] };
const BASIS: Record<string, string> = { evm: "القيمة المكتسبة", budget: "الموازنة والالتزامات", estimate: "تقدير العقد" };
const Ref = ({ children }: { children: string }) => <bdi dir="ltr" className="num">{children}</bdi>;
const ratio = (v: number | null) => (v === null ? "—" : v.toFixed(2));

export function PortfolioPage() {
  const { tenantId, can } = useTenant();
  const toast = useToast();
  const [tab, setTab] = useState("projects");
  const [months, setMonths] = useState(12);
  const q = useQuery({ queryKey: ["t", tenantId, "contracting", "portfolio"], queryFn: () => api<Portfolio>("GET", "/t/contracting/portfolio", { tenant: tenantId }) });
  const f = useQuery({ enabled: tab === "cash", queryKey: ["t", tenantId, "contracting", "cash-forecast", months],
    queryFn: () => api<Forecast>("GET", "/t/contracting/cash-forecast", { tenant: tenantId, query: { months } }) });
  const [exporting, setExporting] = useState(false);
  async function exportXlsx() {
    setExporting(true);
    try { await download("/t/contracting/portfolio.xlsx", tenantId, "portfolio.xlsx"); } catch (e) { toast.error(errorMessage(e)); } finally { setExporting(false); }
  }
  const t = q.data?.totals;
  const flagged = (q.data?.items ?? []).filter((x) => x.flags.length);
  const marginPct = t && t.marginOf ? (t.margin / t.marginOf) * 100 : null;
  return (
    <div className="page">
      <PageHeader eyebrow="المقاولات" title="محفظة المشاريع"
        description="قيمة كل مشروع وإنجازه وتكلفته المتوقعة عند الإنجاز وهامشه، وما يحتاج قراراً، والتدفق النقدي المتوقع للمشاريع مجتمعة."
        actions={can("con_reports.export") ? <Button icon={<Download />} loading={exporting} loadingText="جارٍ التصدير…" onClick={() => void exportXlsx()} disabled={!q.data?.items.length}>تصدير Excel</Button> : undefined} />
      <div className="stats">
        <StatCard label="قيمة العقود" value={t ? money(t.contractValue) : "—"} icon={<Briefcase />} hue="indigo" note={t ? `المتبقي ${money(t.backlog)}` : undefined} />
        <StatCard label="المعتمد حتى تاريخه" value={t ? money(t.certified) : "—"} icon={<TrendingUp />} hue="sky" note={t ? `المفوتر ${money(t.billed)}` : undefined} />
        <StatCard label="الهامش المتوقع" value={t ? money(t.margin) : "—"} icon={t && t.margin < 0 ? <TrendingDown /> : <TrendingUp />} hue={t && t.margin < 0 ? "red" : "green"}
          note={t ? `${marginPct === null ? "—" : percent(marginPct)} من المقدّر${t.unknownMargin ? ` · ${t.unknownMargin} بلا تقدير` : ""}` : undefined} noteTone={t?.unknownMargin ? "warning" : undefined} />
        <StatCard label="ذمم ومحتجزات العملاء" value={t ? money(t.receivable + t.retentionReceivable) : "—"} icon={<Banknote />} hue="violet"
          note={t ? `ذمم ${money(t.receivable)} · محتجز ${money(t.retentionReceivable)}` : undefined} />
      </div>
      {flagged.length > 0 && <section className="panel panel-pad" aria-label="يحتاج قراراً">
        <h2 className="panel-title">يحتاج قراراً</h2>
        <ul className="stack-tight">{flagged.map((x) => <li key={x.id}>
          <Link to="/w/$tenantId/contracting/projects/$projectId/control" params={{ tenantId, projectId: x.id }}><Ref>{x.code}</Ref> {x.name}</Link>{" "}
          {x.flags.map((fl) => <Badge key={fl} tone={FLAG[fl]?.[1] ?? "warning"}>{FLAG[fl]?.[0] ?? fl}</Badge>)}
          {x.margin !== null && x.margin < 0 && <span className="muted acc-small"> خسارة متوقعة {money(-x.margin)}</span>}
        </li>)}</ul>
      </section>}
      <section className="panel" aria-label="المحفظة">
        <div className="toolbar"><StatusTabs value={tab} onChange={setTab} options={[["projects", "المشاريع"], ["cash", "التدفق النقدي المجمع"]]} /></div>
        {tab === "projects" && <DataTable caption="محفظة المشاريع" query={q.data ? { ...q, data: { items: q.data.items } } : q} rowKey={(r) => r.id}
          empty={{ title: "لا مشاريع مفتوحة", body: "تظهر هنا المشاريع غير المغلقة بعقودها الرئيسية المفعّلة والمكتملة." }}
          columns={[
            { key: "code", header: "المشروع", cell: (r) => <span className="stack-tight"><Link to="/w/$tenantId/contracting/projects/$projectId" params={{ tenantId, projectId: r.id }}><Ref>{r.code}</Ref></Link>
              <span className="muted acc-small">{r.name}{r.client ? ` · ${r.client}` : ""}</span></span> },
            { key: "contractValue", header: "القيمة", numeric: true, cell: (r) => money(r.contractValue) },
            { key: "progressPct", header: "الإنجاز", numeric: true, cell: (r) => r.progressPct === null ? "—" : percent(r.progressPct) },
            { key: "costToDate", header: "التكلفة حتى تاريخه", numeric: true, cell: (r) => money(r.costToDate) },
            { key: "eac", header: "التكلفة المتوقعة", numeric: true, cell: (r) => r.eac === null ? <span className="muted">غير مقدَّرة</span>
              : <span className="stack-tight">{money(r.eac)}<span className="muted acc-small">{BASIS[r.eacBasis ?? ""]}</span></span> },
            { key: "margin", header: "الهامش المتوقع", numeric: true, cell: (r) => r.margin === null ? "—"
              : <span className={r.margin < 0 ? "field-error" : undefined}>{money(r.margin)} <span className="acc-small">({percent(r.marginPct)})</span></span> },
            { key: "spi", header: "SPI / CPI", numeric: true, sortKey: false, cell: (r) => r.spi === null && r.cpi === null ? "—" : `${ratio(r.spi)} / ${ratio(r.cpi)}` },
            { key: "receivable", header: "ذمم + محتجز", numeric: true, cell: (r) => money(r.receivable + r.retentionReceivable) },
            { key: "flags", header: "تنبيهات", sortKey: false, cell: (r) => r.flags.length ? <span className="stack-tight">{r.flags.map((fl) => <Badge key={fl} tone={FLAG[fl]?.[1] ?? "warning"}>{FLAG[fl]?.[0] ?? fl}</Badge>)}</span> : "—" },
          ]} />}
        {tab === "cash" && <>
          <div className="toolbar row" style={{ justifyContent: "end" }}>
            <StatusTabs value={String(months)} onChange={(v) => setMonths(Number(v))} options={[["6", "6 أشهر"], ["12", "12 شهراً"], ["24", "24 شهراً"]]} />
          </div>
          {f.data && f.data.items.length > 1 && <CashChart items={f.data.items} />}
          <DataTable caption="التدفق النقدي المجمع" query={f.data ? { ...f, data: { items: f.data.items } } : f} rowKey={(r) => r.period}
            empty={{ title: "لا تدفقات متوقعة", body: "يُحسب من العقود الرئيسية المفعّلة: المتبقي من قيمتها والمتبقي من تكلفة كل مشروع على برنامجه." }}
            columns={[
              { key: "period", header: "الشهر", cell: (r) => <Ref>{r.period}</Ref> },
              { key: "inflow", header: "المقبوضات", numeric: true, cell: (r) => money(r.inflow) },
              { key: "outflow", header: "المدفوعات", numeric: true, cell: (r) => money(r.outflow) },
              { key: "net", header: "الصافي", numeric: true, cell: (r) => r.net < 0 ? <span className="field-error">{money(r.net)}</span> : money(r.net) },
              { key: "cumulative", header: "التراكمي", numeric: true, cell: (r) => r.cumulative < 0 ? <span className="field-error">{money(r.cumulative)}</span> : money(r.cumulative) },
            ]} />
          {f.data && <p className="muted acc-small">{f.data.basis}. {f.data.projects.filter((p) => !p.hasSchedule).length > 0 && `مشاريع بلا برنامج زمني يُفترض متبقيها في الشهر الحالي: ${f.data.projects.filter((p) => !p.hasSchedule).map((p) => p.code).join("، ")}.`}</p>}
        </>}
      </section>
    </div>
  );
}

/** Monthly net as bars (in above the axis, out below) and the cumulative position as a line; right-to-left in time. */
function CashChart({ items }: { items: Forecast["items"] }) {
  const W = 640, H = 220, P = 30;
  const max = Math.max(1, ...items.flatMap((m) => [Math.abs(m.net), Math.abs(m.cumulative)]));
  const zero = H / 2;
  const step = (W - 2 * P) / items.length;
  const x = (i: number) => W - P - (i + 0.5) * step;
  const y = (v: number) => zero - (v / max) * (H / 2 - P);
  const every = Math.ceil(items.length / 8);
  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="الصافي الشهري والمركز التراكمي" style={{ width: "100%", height: "auto" }}>
        <line x1={P} x2={W - P} y1={zero} y2={zero} stroke="var(--divider)" />
        {items.map((m, i) => <rect key={m.period} x={x(i) - step * 0.3} width={step * 0.6} y={Math.min(y(m.net), zero)} height={Math.abs(y(m.net) - zero)}
          fill={m.net < 0 ? "var(--on-red)" : "var(--on-green)"} opacity={0.75} />)}
        <polyline points={items.map((m, i) => `${x(i)},${y(m.cumulative)}`).join(" ")} fill="none" stroke="var(--on-indigo)" strokeWidth={2} />
        {items.map((m, i) => i % every === 0 && <text key={`t${m.period}`} x={x(i)} y={H - 8} fontSize="11" textAnchor="middle" fill="var(--text-muted)">{m.period}</text>)}
      </svg>
      <figcaption className="row acc-small" style={{ gap: "var(--sp-3)" }}>
        <span><span aria-hidden style={{ color: "var(--on-green)" }}>■</span> صافٍ موجب</span><span><span aria-hidden style={{ color: "var(--on-red)" }}>■</span> صافٍ سالب</span>
        <span><span aria-hidden style={{ color: "var(--on-indigo)" }}>━</span> التراكمي</span>
      </figcaption>
    </figure>
  );
}
