import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlarmClock, Building, FileSignature, HandCoins, ShieldAlert, Wallet } from "lucide-react";
import { api } from "../../api/client";
import { useMe } from "../../app/session";
import { useTenant } from "../../app/tenant";
import { day, dayLong, greeting, integer, money } from "../../lib/format";
import { DataTable } from "../../ui/DataTable";
import { Badge, PageHeader, StatCard } from "../../ui/Layout";
import { EmptyState, ErrorState } from "../../ui/States";

// The contracting workspace's home: the money (contracts, certified, billed, owed, retention both ways) and what
// needs doing now (IPCs waiting at each step, invoice deadlines, claim notices, expiring guarantees and documents).

interface Dash { asOf: string; projects: number; contractValue: number; variations: number; certified: number; backlog: number; billedThisMonth: number; receivable: number;
  retentionReceivable: number; retentionPayable: number;
  ipcs: { id: string; number: number; status: string; kind: string; contractId: string; contractNumber: string; role: string; party: string; project: string; periodTo: string;
    netPayable: number; invoiceDeadline: string | null }[];
  deadlines: { kind: string; id: string; contractId: string | null; ref: string; label: string; due: string }[] }
const NEXT: Record<string, string> = { draft: "تقديم", submitted: "اعتماد الاستشاري", certified: "اعتماد العميل", approved: "إصدار الفاتورة" };
const DEADLINE: Record<string, string> = { claim: "إخطار مطالبة", guarantee: "ضمان بنكي", permit: "تصريح", subcontractor: "وثيقة مقاول باطن" };
const Ref = ({ children }: { children: string }) => <bdi dir="ltr" className="num">{children}</bdi>;

export function ContractingDashboard() {
  const { tenantId, can } = useTenant();
  const me = useMe();
  const q = useQuery({ queryKey: ["t", tenantId, "contracting", "dashboard"], queryFn: () => api<Dash>("GET", "/t/contracting/dashboard", { tenant: tenantId }) });
  const d = q.data;
  const firstName = (me.data?.user.fullName ?? "").trim().split(/\s+/)[0] ?? "";
  const daysTo = (iso: string) => Math.round((Date.parse(iso) - Date.parse(d?.asOf ?? iso)) / 86_400_000);
  if (q.isError) return <div className="page"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div>;
  return (
    <div className="page">
      <PageHeader eyebrow={dayLong()} title={`${greeting()}${firstName ? `، ${firstName}` : ""}`} description="العقود والمستخلصات والمحتجزات، وما ينتظر إجراءً منك اليوم." />
      <div className="stats">
        <StatCard label="مشاريع قائمة" value={d ? integer(d.projects) : "—"} icon={<Building />} hue="indigo" note={d ? `قيمة العقود ${money(d.contractValue + d.variations)}` : undefined} />
        <StatCard label="المتبقي من العقود" value={d ? money(d.backlog) : "—"} icon={<FileSignature />} hue="sky" note={d ? `المنفذ المعتمد ${money(d.certified)}` : undefined} />
        <StatCard label="مستحق على العملاء" value={d ? money(d.receivable) : "—"} icon={<HandCoins />} hue="green" note={d ? `فُوتر هذا الشهر ${money(d.billedThisMonth)}` : undefined} />
        <StatCard label="المحتجزات" value={d ? money(d.retentionReceivable) : "—"} icon={<Wallet />} hue="violet" note={d ? `لنا لدى العملاء؛ وعلينا لمقاولي الباطن ${money(d.retentionPayable)}` : undefined} />
      </div>
      {d && d.projects === 0 && d.contractValue === 0 && (
        <section className="panel panel-pad">
          <EmptyState title="ابدأ من العطاء أو المشروع" action={<span className="row" style={{ gap: "var(--sp-2)" }}>
            {can("tenders.create") && <Link to="/w/$tenantId/contracting/tenders" params={{ tenantId }} className="btn btn-secondary">تسعير عطاء</Link>}
            {can("projects.create") && <Link to="/w/$tenantId/contracting/projects" params={{ tenantId }} className="btn btn-primary">مشروع جديد</Link>}
          </span>}>
            سعّر العطاء من موارده وحوّله إلى عقد عند ترسيته، أو أنشئ المشروع وعقده وجدول كمياته مباشرة. بعدها تظهر هنا المستخلصات والمحتجزات والمواعيد.
          </EmptyState>
        </section>
      )}
      <section className="panel" aria-label="مستخلصات تنتظر إجراء">
        <DataTable caption="مستخلصات تنتظر إجراء" query={{ ...q, data: d ? { items: d.ipcs } : undefined }} rowKey={(r) => r.id}
          empty={{ title: "لا مستخلصات معلقة", body: "كل المستخلصات مفوترة أو مسجلة." }}
          columns={[
            { key: "number", header: "المستخلص", cell: (r) => <span className="stack-tight"><Link to="/w/$tenantId/contracting/ipcs/$ipcId" params={{ tenantId, ipcId: r.id }}>رقم {r.number}{r.kind === "final" && " (ختامي)"}</Link>
              <span className="muted acc-small"><Ref>{r.contractNumber}</Ref> · {r.project}{r.role === "SUB" && " · باطن"}</span></span> },
            { key: "party", header: "العميل / المقاول", cell: (r) => r.party },
            { key: "status", header: "الخطوة التالية", cell: (r) => r.role === "SUB" && r.status === "approved" ? <Badge tone="info">تسجيل فاتورة المقاول</Badge> : <Badge tone="info">{NEXT[r.status]}</Badge> },
            { key: "invoiceDeadline", header: "آخر موعد للفاتورة", cell: (r) => r.invoiceDeadline ? <Badge tone={daysTo(r.invoiceDeadline) < 3 ? "danger" : "warning"}>{day(r.invoiceDeadline)}</Badge> : "—" },
            { key: "netPayable", header: "الصافي", numeric: true, cell: (r) => r.status === "approved" ? money(r.netPayable) : "—" },
          ]} />
      </section>
      <section className="panel" aria-label="مواعيد قريبة">
        <DataTable caption="مواعيد وانتهاءات قريبة" query={{ ...q, data: d ? { items: d.deadlines } : undefined }} rowKey={(r) => `${r.kind}:${r.id}`}
          empty={{ title: "لا مواعيد قريبة", body: "لا ضمانات أو تصاريح أو وثائق تنتهي خلال 60 يوماً، ولا مهل إخطار خلال أسبوعين." }}
          columns={[
            { key: "kind", header: "النوع", cell: (r) => <span className="row" style={{ gap: "var(--sp-1)" }}>{r.kind === "claim" ? <AlarmClock aria-hidden="true" /> : <ShieldAlert aria-hidden="true" />}{DEADLINE[r.kind]}</span> },
            { key: "label", header: "البيان", cell: (r) => r.contractId ? <Link to="/w/$tenantId/contracting/contracts/$contractId" params={{ tenantId, contractId: r.contractId }}>{r.label} · <Ref>{r.ref}</Ref></Link>
              : r.kind === "subcontractor" ? <Link to="/w/$tenantId/contracting/subcontractors" params={{ tenantId }}>{r.label} · <Ref>{r.ref}</Ref></Link>
              : <Link to="/w/$tenantId/contracting/projects" params={{ tenantId }}>{r.label} · <Ref>{r.ref}</Ref></Link> },
            { key: "due", header: "الموعد", cell: (r) => { const n = daysTo(r.due); return <Badge tone={n < 0 ? "danger" : n <= 14 ? "warning" : "neutral"}>{day(r.due)} {n < 0 ? "(فات)" : `(بعد ${integer(n)} يوماً)`}</Badge>; } },
          ]} />
      </section>
    </div>
  );
}
