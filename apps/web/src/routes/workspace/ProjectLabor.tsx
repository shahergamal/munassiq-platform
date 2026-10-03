import { useQuery } from "@tanstack/react-query";
import { Clock3, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { api, errorMessage } from "../../api/client";
import { useInvalidate, useTenant } from "../../app/tenant";
import { integer, isoDay, money, quantity } from "../../lib/format";
import { Button } from "../../ui/Button";
import { DataTable } from "../../ui/DataTable";
import { ConfirmDialog } from "../../ui/Dialog";
import { SelectField, TextField } from "../../ui/Field";
import { Badge, PageHeader, StatCard } from "../../ui/Layout";
import { ErrorState, FormError } from "../../ui/States";
import { useToast } from "../../ui/Toast";
import { StatusTabs } from "./Inventory";

// Contracting C8: each employee's hours on a project for a day, and allocating an approved payroll run to the
// projects by those hours. Only per-project totals are shown; individual pay stays sealed on the server.

interface Row { employeeId: string; code: string; name: string; jobTitle: string; hours: number | null; otherHours: number; attendanceHours: number | null }
const lastMonth = () => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };

export function ProjectLaborPage() {
  const { tenantId } = useTenant();
  const [tab, setTab] = useState("hours");
  return (
    <div className="page">
      <PageHeader eyebrow="المقاولات" title="العمالة على المشاريع"
        description="ساعات كل موظف على كل مشروع يومياً، ثم تحميل مسير الرواتب المعتمد على المشاريع بنسبة ساعاتها: التكلفة الكاملة (الراتب والتأمينات ومكافأة نهاية الخدمة) بإجماليات لكل مشروع، ورواتب الأفراد تبقى مختومة." />
      <section className="panel" aria-label="العمالة على المشاريع">
        <div className="toolbar"><StatusTabs value={tab} onChange={setTab} options={[["hours", "ساعات اليوم"], ["month", "تحميل الشهر"]]} /></div>
        {tab === "hours" ? <HoursTab tenantId={tenantId} /> : <MonthTab tenantId={tenantId} />}
      </section>
    </div>
  );
}

function HoursTab({ tenantId }: { tenantId: string }) {
  const { can, writable } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const projects = useQuery({ queryKey: ["t", tenantId, "contracting", "projects"], queryFn: () => api<{ items: { id: string; code: string; name: string; status: string }[] }>("GET", "/t/projects", { tenant: tenantId }) });
  const [projectId, setProjectId] = useState("");
  const [date, setDate] = useState(isoDay());
  const q = useQuery({ enabled: Boolean(projectId), queryKey: ["t", tenantId, "contracting", "labor", projectId, date],
    queryFn: () => api<{ items: Row[]; locked: boolean }>("GET", "/t/labor-timesheets", { tenant: tenantId, query: { projectId, date } }) });
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { setEdits({}); setError(null); }, [projectId, date]);
  const editable = can("labor.record") && writable && !q.data?.locked;
  const value = (r: Row) => edits[r.employeeId] ?? (r.hours === null ? "" : String(r.hours));
  const dirty = Object.keys(edits).length > 0;
  async function save() {
    const rows = Object.entries(edits).map(([employeeId, h]) => ({ employeeId, hours: h === "" ? 0 : Number(h) }));
    const bad = rows.find((r) => !Number.isFinite(r.hours) || r.hours < 0 || r.hours > 24);
    if (bad) return setError(new Error("الساعات بين 0 و24"));
    setBusy(true); setError(null);
    try {
      await api("PUT", "/t/labor-timesheets", { tenant: tenantId, body: { projectId, workDate: date, rows } });
      toast.success("حُفظت ساعات اليوم");
      setEdits({});
      await invalidate("contracting");
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  const total = (q.data?.items ?? []).reduce((a, r) => a + (Number(value(r)) || 0), 0);
  return (
    <>
      <div className="toolbar row" style={{ gap: "var(--sp-2)", flexWrap: "wrap", alignItems: "end" }}>
        <SelectField label="المشروع" placeholder="اختر المشروع" value={projectId} onChange={(e) => setProjectId(e.target.value)}
          options={(projects.data?.items ?? []).filter((p) => p.status !== "closed").map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))} />
        <TextField label="اليوم" type="date" dir="ltr" value={date} max={isoDay()} onChange={(e) => e.target.value && setDate(e.target.value)} />
        {editable && <Button variant="primary" disabled={!dirty} loading={busy} loadingText="جارٍ الحفظ…" onClick={() => void save()}>حفظ الساعات</Button>}
      </div>
      {!projectId && <p className="muted panel-pad">اختر المشروع واليوم، ثم أدخل ساعات من عمل عليه من الموظفين.</p>}
      {q.data?.locked && <p className="banner banner-warning" role="status">حُمّل مسير هذا الشهر على المشاريع: ساعاته لا تتغير.</p>}
      <FormError error={error} />
      {projectId && (q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (
        <DataTable caption={`ساعات ${date}`} query={q} rowKey={(r) => r.employeeId}
          empty={{ title: "لا موظفين نشطين", body: "أضف الموظفين من «الموظفون» في الموارد البشرية." }}
          footer={<span className="muted">مجموع الساعات على المشروع: {quantity(total)}</span>}
          columns={[
            { key: "name", header: "الموظف", cell: (r) => <span className="stack-tight"><strong>{r.name}</strong><span className="muted acc-small"><bdi dir="ltr">{r.code}</bdi> · {r.jobTitle}</span></span> },
            { key: "attendanceHours", header: "الحضور", numeric: true, cell: (r) => r.attendanceHours === null ? <span className="muted">—</span> : `${quantity(r.attendanceHours)} س` },
            { key: "otherHours", header: "على مشاريع أخرى", numeric: true, cell: (r) => r.otherHours ? `${quantity(r.otherHours)} س` : "—" },
            { key: "hours", header: "على هذا المشروع", numeric: true, sortKey: false, cell: (r) => editable
              ? <input className="input input-sm num" dir="ltr" inputMode="decimal" style={{ maxWidth: "6rem" }} aria-label={`ساعات ${r.name}`} value={value(r)}
                  onChange={(e) => setEdits({ ...edits, [r.employeeId]: e.target.value })} />
              : r.hours === null ? "—" : `${quantity(r.hours)} س` },
          ]} />
      ))}
    </>
  );
}

interface Summary { period: string; run: { id: string; status: string } | null; allocation: { allocated: number; unallocated: number } | null;
  projects: { id: string; code: string; name: string; hours: number; employees: number; amount: number | null }[] }
function MonthTab({ tenantId }: { tenantId: string }) {
  const { can, writable } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [period, setPeriod] = useState(lastMonth());
  const q = useQuery({ queryKey: ["t", tenantId, "contracting", "labor-summary", period], queryFn: () => api<Summary>("GET", "/t/labor/summary", { tenant: tenantId, query: { period } }) });
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const d = q.data;
  const canAllocate = can("labor.allocate") && writable && d?.run && d.run.status !== "draft" && !d.allocation && d.projects.length > 0;
  async function allocate() {
    if (!d?.run) return;
    setBusy(true); setErr(null);
    try {
      const r = await api<{ allocated: number; projects: number }>("POST", `/t/payroll/runs/${d.run.id}/allocate-projects`, { tenant: tenantId });
      toast.success(`حُمّل ${money(r.allocated)} على ${integer(r.projects)} مشروع`);
      setConfirm(false);
      await invalidate("contracting");
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <>
      <div className="toolbar row" style={{ gap: "var(--sp-2)", alignItems: "end", flexWrap: "wrap" }}>
        <TextField label="الشهر" type="month" dir="ltr" value={period} max={isoDay().slice(0, 7)} onChange={(e) => e.target.value && setPeriod(e.target.value)} />
        {canAllocate && <Button variant="primary" onClick={() => { setErr(null); setConfirm(true); }}>تحميل المسير على المشاريع</Button>}
      </div>
      {d && <div className="stats">
        <StatCard label="المسير" value={!d.run ? "لم يُعدّ" : d.run.status === "draft" ? "مسودة" : "معتمد"} icon={<Users />} hue={d.run && d.run.status !== "draft" ? "green" : "amber"}
          note={!d.run || d.run.status === "draft" ? "يُحمَّل بعد اعتماد مسير الشهر" : undefined} />
        <StatCard label="المحمّل على المشاريع" value={d.allocation ? money(d.allocation.allocated) : "—"} icon={<Clock3 />} hue="indigo"
          note={d.allocation ? `وبقي على مراكز تكلفة الموظفين ${money(d.allocation.unallocated)}` : undefined} />
      </div>}
      <DataTable caption={`المشاريع في ${period}`} query={{ ...q, data: d ? { items: d.projects } : undefined }} rowKey={(r) => r.id}
        empty={{ title: "لا ساعات على المشاريع في هذا الشهر", body: "سجّل ساعات الموظفين على المشاريع من «ساعات اليوم»." }}
        columns={[
          { key: "code", header: "المشروع", cell: (r) => <span className="stack-tight"><strong>{r.name}</strong><bdi dir="ltr" className="muted num acc-small">{r.code}</bdi></span> },
          { key: "employees", header: "موظفون", numeric: true, cell: (r) => integer(r.employees) },
          { key: "hours", header: "الساعات", numeric: true, cell: (r) => quantity(r.hours) },
          { key: "amount", header: "التكلفة المحمّلة", numeric: true, cell: (r) => r.amount === null ? <Badge tone="neutral">لم يُحمَّل</Badge> : money(r.amount) },
        ]} />
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} busy={busy} error={err ? errorMessage(err) : null} onConfirm={() => void allocate()} destructive={false}
        title={`تحميل مسير ${period} على المشاريع؟`} confirmLabel="تحميل وترحيل القيد"
        message="تُوزَّع التكلفة الكاملة لكل موظف على المشاريع بنسبة ساعاته عليها من ساعات حضوره، ويُرحَّل قيد بإجماليات كل مشروع (رمز التكلفة LAB). يتم مرة واحدة للمسير وتُقفل بعدها ساعات الشهر." />
    </>
  );
}
