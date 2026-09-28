import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { AlarmClock, ArrowRight, Banknote, CalendarCheck, CircleCheck, Download, FileSpreadsheet, IdCard, Plus, Save, ShieldCheck, Trash2, UserMinus, Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, download, errorMessage, type Page } from "../../api/client";
import type { Branch } from "../../api/types";
import { useIdempotencyKey } from "../../app/session";
import { useInvalidate, useTenant } from "../../app/tenant";
import { day, dayTime, integer, isoDay, money, percent, quantity, RIYAL, text } from "../../lib/format";
import { Button, IconButton } from "../../ui/Button";
import { DataTable } from "../../ui/DataTable";
import { ConfirmDialog, Dialog } from "../../ui/Dialog";
import { Checkbox, focusFirstInvalid, SearchInput, SelectField, TextAreaField, TextField } from "../../ui/Field";
import { ActionMenu, Badge, PageHeader, StatCard } from "../../ui/Layout";
import { EmptyState, ErrorState, FormError, TableSkeleton } from "../../ui/States";
import { useToast } from "../../ui/Toast";
import { useCostCenters } from "./Accounting";
import { StatusTabs } from "./Inventory";

// Human resources for every sector: employees (identity, IBAN and pay shown only with the pay permission),
// attendance, leaves, the monthly payroll (GOSI and end of service computed by the server) and the Mudad file.

const num = (s: string) => Number(String(s).replace(/,/g, ""));
const Ref = ({ children }: { children: string }) => <bdi dir="ltr" className="num">{children}</bdi>;
const lastMonth = () => { const d = new Date(`${isoDay().slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };
const ALERT: Record<string, string> = { id: "الهوية / الإقامة", passport: "جواز السفر", contract: "نهاية العقد", medical: "التأمين الطبي" };
const REASON: Record<string, string> = {
  resignation: "استقالة (م85)", termination: "إنهاء من صاحب العمل (م84)", contract_end: "انتهاء العقد المحدد", article_87: "استقالة بحكم المادة 87 (مكافأة كاملة)", article_80: "فصل بموجب المادة 80 (بلا مكافأة)",
};
const SCHEME: Record<string, string> = { old: "تأمينات: النظام القديم", new: "تأمينات: النظام الجديد", non_saudi: "غير سعودي (أخطار فقط)" };

// ── Employees ───────────────────────────────────────────────────────────────────────────────────
interface EmpRow {
  id: string; code: string; name: string; nameEn: string | null; gender: "male" | "female"; nationality: string; isSaudi: boolean; idType: string; idLast4: string; idExpiry: string | null;
  passportExpiry: string | null; jobTitle: string; hireDate: string; contractType: string; contractEnd: string | null; medicalExpiry: string | null; status: string; terminatedOn: string | null;
  branchName: string | null; costCenterName: string | null; workCenterName: string | null; bankCode: string | null; hasIban: boolean;
}
interface Overview { today: string; alerts: { id: string; code: string; name: string; kind: string; date: string; daysLeft: number }[]; saudization: { saudi: number; total: number; ratio: number | null };
  wps: { period: string; deadline: string; daysLeft: number } | null }

export function EmployeesPage() {
  const { tenantId, can, writable } = useTenant();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("active");
  const [adding, setAdding] = useState(false);
  const list = useQuery({ queryKey: ["t", tenantId, "hr", "employees", status, q], queryFn: () => api<{ items: EmpRow[] }>("GET", "/t/employees", { tenant: tenantId, query: { status, q: q || undefined } }) });
  const ov = useQuery({ queryKey: ["t", tenantId, "hr", "overview"], queryFn: () => api<Overview>("GET", "/t/hr/overview", { tenant: tenantId }) });
  const canAdd = can("employees.create") && can("employees.view_pay") && writable;
  const o = ov.data;
  return (
    <div className="page">
      <PageHeader eyebrow="الموارد البشرية" title="الموظفون"
        description="بيانات كل موظف ووثائقه وعقده. الهوية والآيبان والراتب مشفرة ولا تظهر إلا لمن له صلاحية رؤية الرواتب."
        actions={canAdd && <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>إضافة موظف</Button>} />
      <div className="stats">
        <StatCard label="على رأس العمل" value={o ? integer(o.saudization.total) : "—"} icon={<Users />} hue="indigo" />
        <StatCard label="نسبة التوطين (تقديرية)" value={o?.saudization.ratio !== null && o ? percent(o.saudization.ratio) : "—"} icon={<IdCard />} hue="green"
          note={o ? `${integer(o.saudization.saudi)} سعودي. نطاقات تحسبها بحسب النشاط والحجم` : undefined} />
        <StatCard label="وثائق تنتهي خلال 60 يوماً" value={o ? integer(o.alerts.length) : "—"} icon={<AlarmClock />} hue={o?.alerts.some((a) => a.daysLeft < 0) ? "red" : o?.alerts.length ? "amber" : "green"} />
        {o?.wps && <StatCard label={`رفع حماية الأجور ${o.wps.period}`} value={day(o.wps.deadline)} icon={<ShieldCheck />} hue={o.wps.daysLeft < 7 ? "red" : "sky"}
          note={o.wps.daysLeft >= 0 ? `بعد ${integer(o.wps.daysLeft)} يوماً (30 يوماً من نهاية الشهر)` : "فات الموعد"} />}
      </div>
      {o && o.alerts.length > 0 && (
        <section className="panel" aria-labelledby="hr-al">
          <div className="toolbar"><h2 id="hr-al">تنبيهات الانتهاء</h2></div>
          <ul className="stack-tight panel-pad">{o.alerts.map((a) => (
            <li key={`${a.id}-${a.kind}`}><Badge tone={a.daysLeft < 0 ? "danger" : a.daysLeft <= 14 ? "warning" : "info"}>{a.daysLeft < 0 ? "منتهية" : `بعد ${integer(a.daysLeft)} يوماً`}</Badge>{" "}
              <Link to={`/w/${tenantId}/hr/employees/${a.id}`}>{a.name}</Link> · {ALERT[a.kind]} · {day(a.date)}</li>))}</ul>
        </section>
      )}
      <section className="panel" aria-label="الموظفون">
        <DataTable caption="الموظفون" query={list} rowKey={(r) => r.id} onRowClick={(r) => navigate({ to: `/w/${tenantId}/hr/employees/${r.id}` })}
          filtered={Boolean(q) || status !== "active"} onClearFilters={() => { setQ(""); setStatus("active"); }}
          toolbar={<><SearchInput value={q} onChange={setQ} placeholder="الاسم أو الرقم الوظيفي أو آخر 4 من الهوية" />
            <StatusTabs value={status} onChange={setStatus} options={[["active", "على رأس العمل"], ["terminated", "انتهت خدمتهم"], ["all", "الكل"]]} /></>}
          empty={{ title: "لا يوجد موظفون بعد", body: "أضف موظفيك بعقودهم ورواتبهم لتُعدّ مسيرات الرواتب ويُحسب التأمين ونهاية الخدمة.",
            action: canAdd ? <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>إضافة موظف</Button> : undefined }}
          columns={[
            { key: "name", header: "الموظف", cell: (r) => <span className="stack-tight"><strong>{r.name}</strong><span className="muted acc-small"><Ref>{r.code}</Ref> · {r.jobTitle}</span></span> },
            { key: "nationality", header: "الجنسية", cell: (r) => r.isSaudi ? <Badge tone="success">سعودي</Badge> : r.nationality },
            { key: "branchName", header: "الفرع", cell: (r) => text(r.branchName) },
            { key: "hireDate", header: "الالتحاق", cell: (r) => day(r.hireDate) },
            { key: "idExpiry", header: "انتهاء الهوية", cell: (r) => day(r.idExpiry) },
            { key: "hasIban", header: "الحساب البنكي", cell: (r) => r.hasIban ? <span className="num">{r.bankCode}</span> : <Badge tone="warning">بلا آيبان</Badge> },
            { key: "status", header: "الحالة", cell: (r) => r.status === "active" ? <Badge tone="success">على رأس العمل</Badge> : <Badge tone="neutral">انتهت {day(r.terminatedOn)}</Badge> },
          ]} />
      </section>
      {adding && <EmployeeDialog tenantId={tenantId} emp={null} onClose={() => setAdding(false)} />}
    </div>
  );
}

interface EmpDetail extends Omit<EmpRow, "branchName" | "costCenterName" | "workCenterName"> {
  birthDate: string | null; occupationCode: string | null; branchId: string | null; costCenterId: string | null; workCenterId: string | null; gosiFirstRegistered: string | null; gosiNumber: string | null;
  qiwaContractNo: string | null; medicalClass: string | null; medicalDependents: number; gosiScheme: string;
  leave: { annual: { accrued: number; taken: number; pending: number; balance: number }; compensatory: { earned: number; taken: number; balance: number } };
  settlement: { id: string; lastDay: string; reason: string; total: number } | null;
  pay?: { basic: number; housing: number; housingInKind: boolean; transport: number; other: number; gosiRegisteredWage: number | null };
  idNumber?: string; iban?: string | null; wage?: number; dailyWage?: number; gosiBase?: number;
  eos?: { asOf: string; years: number; termination: number; provisioned: number };
}

export function EmployeePage() {
  const { tenantId, can, writable } = useTenant();
  const { employeeId } = useParams({ strict: false }) as { employeeId: string };
  const e = useQuery({ queryKey: ["t", tenantId, "hr", "employee", employeeId], queryFn: () => api<EmpDetail>("GET", `/t/employees/${employeeId}`, { tenant: tenantId }) });
  const [editing, setEditing] = useState(false);
  const [ending, setEnding] = useState(false);
  if (e.isPending) return <div className="page"><TableSkeleton columns={4} rows={5} label="جارٍ تحميل بيانات الموظف…" /></div>;
  if (e.isError) return <div className="page"><ErrorState error={e.error} onRetry={() => e.refetch()} /></div>;
  const d = e.data;
  const active = d.status === "active";
  return (
    <div className="page">
      <PageHeader eyebrow="الموارد البشرية" title={<span className="pf-title">{d.name} <Ref>{d.code}</Ref>{active ? <Badge tone="success">على رأس العمل</Badge> : <Badge tone="neutral">انتهت خدمته {day(d.terminatedOn)}</Badge>}</span>}
        description={`${d.jobTitle} · التحق ${day(d.hireDate)} · ${SCHEME[d.gosiScheme]}`}
        actions={<>
          <Link to={`/w/${tenantId}/hr/employees`} className="btn btn-ghost"><ArrowRight aria-hidden="true" />الموظفون</Link>
          {active && writable && can("employees.edit") && <Button onClick={() => setEditing(true)}>تعديل</Button>}
          {active && writable && can("employees.terminate") && <Button variant="ghost" icon={<UserMinus />} onClick={() => setEnding(true)}>إنهاء الخدمة</Button>}
        </>} />
      <div className="stats">
        <StatCard label="رصيد الإجازة السنوية" value={`${quantity(d.leave.annual.balance)} يوم`} icon={<CalendarCheck />} hue="sky"
          note={`مستحق ${quantity(d.leave.annual.accrued)} · مأخوذ ${integer(d.leave.annual.taken)}${d.leave.annual.pending ? ` · معلّق ${integer(d.leave.annual.pending)}` : ""}`} />
        {d.leave.compensatory.earned > 0 && <StatCard label="رصيد الإجازة التعويضية" value={`${quantity(d.leave.compensatory.balance)} يوم`} icon={<AlarmClock />} hue="violet" note="من العمل الإضافي المعوّض بإجازة" />}
        {d.pay && <StatCard label="الأجر الشهري الثابت" value={money(d.wage!)} icon={<Banknote />} hue="indigo" note={`وعاء التأمينات ${money(d.gosiBase!)} · اليومي ${money(d.dailyWage!)}`} />}
        {d.eos && <StatCard label="مكافأة نهاية الخدمة (لو أُنهيت اليوم)" value={money(d.eos.termination)} icon={<ShieldCheck />} hue="amber"
          note={`${quantity(d.eos.years)} سنة · المخصص المقيد ${money(d.eos.provisioned)}`} />}
      </div>
      {d.settlement && <p className="banner banner-warning ca-banner">مخالصة نهاية الخدمة: {REASON[d.settlement.reason]} · آخر يوم {day(d.settlement.lastDay)} · {money(d.settlement.total)}</p>}
      <section className="panel panel-pad" aria-labelledby="emp-h">
        <h2 id="emp-h">البيانات</h2>
        <dl className="dl">
          <dt>الجنسية</dt><dd>{d.nationality === "SA" ? "سعودي" : d.nationality} · {d.gender === "male" ? "ذكر" : "أنثى"}</dd>
          <dt>الهوية</dt><dd>{d.idNumber ? <Ref>{d.idNumber}</Ref> : <span className="muted">•••• <Ref>{d.idLast4}</Ref></span>} · تنتهي {day(d.idExpiry)}</dd>
          <dt>العقد</dt><dd>{d.contractType === "fixed" ? `محدد المدة حتى ${day(d.contractEnd)}` : "غير محدد المدة"}{d.qiwaContractNo ? <> · قوى <Ref>{d.qiwaContractNo}</Ref></> : null}</dd>
          <dt>التأمينات</dt><dd>{d.gosiNumber ? <Ref>{d.gosiNumber}</Ref> : "—"} · أول تسجيل {day(d.gosiFirstRegistered)}</dd>
          <dt>التأمين الطبي</dt><dd>{text(d.medicalClass)}{d.medicalDependents ? ` · ${integer(d.medicalDependents)} تابع` : ""} · ينتهي {day(d.medicalExpiry)}</dd>
          {d.pay && <><dt>الراتب</dt><dd>أساسي {money(d.pay.basic)} · سكن {d.pay.housingInKind ? "عيني" : money(d.pay.housing)} · نقل {money(d.pay.transport)} · بدلات أخرى {money(d.pay.other)}</dd>
            <dt>الآيبان</dt><dd>{d.iban ? <Ref>{d.iban}</Ref> : <Badge tone="warning">غير مسجل</Badge>}</dd></>}
          {!d.pay && <><dt>الراتب</dt><dd className="muted">يظهر لصاحب صلاحية رؤية الرواتب</dd></>}
        </dl>
      </section>
      {editing && <EmployeeDialog tenantId={tenantId} emp={d} onClose={() => setEditing(false)} />}
      {ending && <TerminateDialog tenantId={tenantId} emp={d} onClose={() => setEnding(false)} />}
    </div>
  );
}

function EmployeeDialog({ tenantId, emp, onClose }: { tenantId: string; emp: EmpDetail | null; onClose: () => void }) {
  const { can } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const form = useRef<HTMLFormElement>(null);
  const seesPay = can("employees.view_pay");
  const branches = useQuery({ queryKey: ["t", tenantId, "branches", "options"], queryFn: () => api<Page<Branch>>("GET", "/t/branches", { tenant: tenantId, query: { pageSize: 100, isActive: "true" } }) });
  const centers = useCostCenters(tenantId);
  const [v, setV] = useState({
    code: emp?.code ?? "", name: emp?.name ?? "", nameEn: emp?.nameEn ?? "", gender: emp?.gender ?? "male", nationality: emp?.nationality ?? "SA",
    idType: emp?.idType ?? "national_id", idNumber: emp?.idNumber ?? "", idExpiry: emp?.idExpiry ?? "", passportExpiry: emp?.passportExpiry ?? "",
    jobTitle: emp?.jobTitle ?? "", branchId: emp?.branchId ?? "", costCenterId: emp?.costCenterId ?? "", hireDate: emp?.hireDate ?? isoDay(),
    gosiFirstRegistered: emp?.gosiFirstRegistered ?? "", gosiNumber: emp?.gosiNumber ?? "", iban: emp?.iban ?? "", qiwaContractNo: emp?.qiwaContractNo ?? "",
    contractType: emp?.contractType ?? "unlimited", contractEnd: emp?.contractEnd ?? "", medicalClass: emp?.medicalClass ?? "", medicalExpiry: emp?.medicalExpiry ?? "",
    basic: String(emp?.pay?.basic ?? ""), housing: String(emp?.pay?.housing ?? "0"), housingInKind: emp?.pay?.housingInKind ?? false, transport: String(emp?.pay?.transport ?? "0"),
    other: String(emp?.pay?.other ?? "0"), gosiRegisteredWage: emp?.pay?.gosiRegisteredWage != null ? String(emp.pay.gosiRegisteredWage) : "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<typeof v>) => setV({ ...v, ...p });
  async function submit() {
    const e: Record<string, string> = {};
    if (!/^[A-Za-z0-9-]{1,20}$/.test(v.code.trim())) e.code = "حروف إنجليزية وأرقام وشرطة، مثل E-101";
    if (v.name.trim().length < 2) e.name = "أدخل الاسم";
    if (!/^[A-Za-z]{2}$/.test(v.nationality.trim())) e.nationality = "رمز الدولة حرفان: SA للسعودي، EG لمصر…";
    if (v.jobTitle.trim().length < 2) e.jobTitle = "أدخل المسمى الوظيفي";
    if (seesPay && !emp && v.idNumber.trim().length < 4) e.idNumber = "أدخل رقم الهوية أو الإقامة";
    if (seesPay && !(num(v.basic) > 0)) e.basic = "أدخل الراتب الأساسي";
    if (v.contractType === "fixed" && !v.contractEnd) e.contractEnd = "حدد نهاية العقد";
    setErrors(e);
    if (Object.keys(e).length) return focusFirstInvalid(form.current);
    setBusy(true); setError(null);
    const nul = (s: string) => s.trim() || null;
    const body: Record<string, unknown> = {
      code: v.code.trim(), name: v.name.trim(), nameEn: nul(v.nameEn), gender: v.gender, nationality: v.nationality.trim().toUpperCase(), idType: v.idType,
      idExpiry: nul(v.idExpiry), passportExpiry: nul(v.passportExpiry), jobTitle: v.jobTitle.trim(), branchId: nul(v.branchId), costCenterId: nul(v.costCenterId),
      hireDate: v.hireDate, gosiFirstRegistered: nul(v.gosiFirstRegistered), gosiNumber: nul(v.gosiNumber), qiwaContractNo: nul(v.qiwaContractNo), contractType: v.contractType,
      contractEnd: v.contractType === "fixed" ? nul(v.contractEnd) : null, medicalClass: nul(v.medicalClass), medicalExpiry: nul(v.medicalExpiry),
    };
    if (seesPay) {
      if (v.idNumber.trim() && v.idNumber !== emp?.idNumber) body.idNumber = v.idNumber.trim();
      if (v.iban !== (emp?.iban ?? "")) body.iban = nul(v.iban);
      body.pay = { basic: num(v.basic), housing: v.housingInKind ? 0 : num(v.housing), housingInKind: v.housingInKind, transport: num(v.transport), other: num(v.other),
        gosiRegisteredWage: v.gosiRegisteredWage ? num(v.gosiRegisteredWage) : null };
    }
    try {
      if (emp) await api("PUT", `/t/employees/${emp.id}`, { tenant: tenantId, body });
      else await api("POST", "/t/employees", { tenant: tenantId, body });
      toast.success(emp ? `حُفظ «${v.name.trim()}»` : `أُضيف «${v.name.trim()}»`);
      await invalidate("hr");
      onClose();
    } catch (err) { if (err instanceof ApiError) setErrors(err.fieldErrors); setError(err); } finally { setBusy(false); }
  }
  return (
    <Dialog open wide onClose={onClose} busy={busy} formRef={form} onSubmit={() => void submit()} title={emp ? `تعديل «${emp.name}»` : "إضافة موظف"}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">{emp ? "حفظ التعديلات" : "حفظ الموظف"}</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <fieldset className="form-grid"><legend>الموظف</legend>
        <TextField label="الرقم الوظيفي" required dir="ltr" value={v.code} onChange={(e) => set({ code: e.target.value.toUpperCase() })} error={errors.code} />
        <TextField label="الاسم" required value={v.name} onChange={(e) => set({ name: e.target.value })} error={errors.name} />
        <TextField label="الاسم بالإنجليزية" optional dir="ltr" value={v.nameEn} onChange={(e) => set({ nameEn: e.target.value })} />
        <SelectField label="الجنس" required value={v.gender} onChange={(e) => set({ gender: e.target.value as "male" | "female" })} options={[{ value: "male", label: "ذكر" }, { value: "female", label: "أنثى" }]} />
        <TextField label="الجنسية (رمز الدولة)" required dir="ltr" maxLength={2} value={v.nationality} onChange={(e) => set({ nationality: e.target.value.toUpperCase() })} error={errors.nationality} hint="SA للسعودي" />
      </fieldset>
      <fieldset className="form-grid"><legend>الوثائق</legend>
        <SelectField label="نوع الهوية" required value={v.idType} onChange={(e) => set({ idType: e.target.value })}
          options={[{ value: "national_id", label: "هوية وطنية" }, { value: "iqama", label: "إقامة" }, { value: "border_number", label: "رقم حدود" }, { value: "passport", label: "جواز" }]} />
        {seesPay && <TextField label="رقم الهوية أو الإقامة" required={!emp} dir="ltr" inputMode="numeric" value={v.idNumber} onChange={(e) => set({ idNumber: e.target.value })} error={errors.idNumber} />}
        <TextField label="انتهاء الهوية أو الإقامة" optional type="date" dir="ltr" value={v.idExpiry} onChange={(e) => set({ idExpiry: e.target.value })} />
        <TextField label="انتهاء الجواز" optional type="date" dir="ltr" value={v.passportExpiry} onChange={(e) => set({ passportExpiry: e.target.value })} />
      </fieldset>
      <fieldset className="form-grid"><legend>العمل والعقد</legend>
        <TextField label="المسمى الوظيفي" required value={v.jobTitle} onChange={(e) => set({ jobTitle: e.target.value })} error={errors.jobTitle} />
        <TextField label="تاريخ الالتحاق" required type="date" dir="ltr" value={v.hireDate} onChange={(e) => set({ hireDate: e.target.value })} />
        <SelectField label="الفرع" optional placeholder="بلا فرع" value={v.branchId} onChange={(e) => set({ branchId: e.target.value })} options={(branches.data?.items ?? []).map((b) => ({ value: b.id, label: b.name }))} />
        <SelectField label="مركز التكلفة" optional placeholder="بلا مركز" value={v.costCenterId} onChange={(e) => set({ costCenterId: e.target.value })}
          options={(centers.data?.items ?? []).filter((c) => c.isActive).map((c) => ({ value: c.id, label: c.name }))} hint="تُحمَّل عليه تكلفة الراتب في القيد" />
        <SelectField label="نوع العقد" required value={v.contractType} onChange={(e) => set({ contractType: e.target.value })} options={[{ value: "unlimited", label: "غير محدد المدة" }, { value: "fixed", label: "محدد المدة" }]} />
        {v.contractType === "fixed" && <TextField label="نهاية العقد" required type="date" dir="ltr" value={v.contractEnd} onChange={(e) => set({ contractEnd: e.target.value })} error={errors.contractEnd} />}
        <TextField label="رقم العقد في قوى" optional dir="ltr" value={v.qiwaContractNo} onChange={(e) => set({ qiwaContractNo: e.target.value })} />
      </fieldset>
      {seesPay && (
        <fieldset className="form-grid"><legend>الراتب الشهري ({RIYAL})</legend>
          <TextField label="الأساسي" required numeric inputMode="decimal" dir="ltr" value={v.basic} onChange={(e) => set({ basic: e.target.value })} error={errors.basic} />
          <TextField label="بدل السكن" numeric inputMode="decimal" dir="ltr" disabled={v.housingInKind} value={v.housing} onChange={(e) => set({ housing: e.target.value })} />
          <Checkbox label="السكن عيني (يُحسب للتأمينات شهرين من الأساسي سنوياً)" checked={v.housingInKind} onChange={(e) => set({ housingInKind: e.target.checked })} />
          <TextField label="بدل النقل" numeric inputMode="decimal" dir="ltr" value={v.transport} onChange={(e) => set({ transport: e.target.value })} />
          <TextField label="بدلات ثابتة أخرى" numeric inputMode="decimal" dir="ltr" value={v.other} onChange={(e) => set({ other: e.target.value })} />
          <TextField label="الأجر المسجل في التأمينات" optional numeric inputMode="decimal" dir="ltr" value={v.gosiRegisteredWage} onChange={(e) => set({ gosiRegisteredWage: e.target.value })}
            hint="يُطابَق مع الأساسي والسكن قبل ملف حماية الأجور" />
        </fieldset>
      )}
      <fieldset className="form-grid"><legend>التأمينات والبنك والتأمين الطبي</legend>
        <TextField label="أول تسجيل في التأمينات" optional type="date" dir="ltr" value={v.gosiFirstRegistered} onChange={(e) => set({ gosiFirstRegistered: e.target.value })}
          hint="من 3 يوليو 2024 فأحدث = النظام الجديد (للسعوديين)" />
        <TextField label="رقم المشترك" optional dir="ltr" value={v.gosiNumber} onChange={(e) => set({ gosiNumber: e.target.value })} />
        {seesPay && <TextField label="الآيبان" optional dir="ltr" value={v.iban} onChange={(e) => set({ iban: e.target.value.toUpperCase() })} error={errors.iban} hint="SA ثم 22 رقماً" />}
        <TextField label="فئة التأمين الطبي" optional value={v.medicalClass} onChange={(e) => set({ medicalClass: e.target.value })} />
        <TextField label="انتهاء التأمين الطبي" optional type="date" dir="ltr" value={v.medicalExpiry} onChange={(e) => set({ medicalExpiry: e.target.value })} />
      </fieldset>
      <FormError error={error} />
    </Dialog>
  );
}

function TerminateDialog({ tenantId, emp, onClose }: { tenantId: string; emp: EmpDetail; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [key] = useIdempotencyKey();
  const [v, setV] = useState({ lastDay: isoDay(), reason: "termination", paymentMethod: "bank_transfer" });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const preview = useQuery({ queryKey: ["t", tenantId, "hr", "settlement", emp.id, v.lastDay, v.reason], enabled: Boolean(v.lastDay),
    queryFn: () => api<{ years: number; fullAward: number; factor: number; award: number; leaveDays: number; leaveEncashment: number; provision: number; total: number; wage: number }>(
      "GET", `/t/employees/${emp.id}/settlement-preview`, { tenant: tenantId, query: { lastDay: v.lastDay, reason: v.reason } }) });
  async function submit() {
    setBusy(true); setError(null);
    try {
      await api("POST", `/t/employees/${emp.id}/terminate`, { tenant: tenantId, idempotencyKey: key, body: v });
      toast.success(`انتهت خدمة «${emp.name}» وقُيدت المخالصة`);
      await invalidate("hr", "accounting");
      onClose();
    } catch (e) { setError(e); setConfirming(false); } finally { setBusy(false); }
  }
  const p = preview.data;
  return (
    <Dialog open wide onClose={onClose} busy={busy} onSubmit={() => setConfirming(true)} title={`إنهاء خدمة «${emp.name}»`}
      footer={<><Button type="submit" variant="primary" disabled={!p}>مراجعة المخالصة</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <div className="form-grid">
        <TextField label="آخر يوم عمل" required type="date" dir="ltr" max={isoDay()} value={v.lastDay} onChange={(e) => setV({ ...v, lastDay: e.target.value })} />
        <SelectField label="سبب انتهاء الخدمة" required value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} options={Object.entries(REASON).map(([value, label]) => ({ value, label }))} />
        <SelectField label="الصرف" required value={v.paymentMethod} onChange={(e) => setV({ ...v, paymentMethod: e.target.value })} options={[{ value: "bank_transfer", label: "تحويل بنكي" }, { value: "cash", label: "نقدي" }]} />
      </div>
      {preview.isError ? <FormError error={preview.error} /> : !p ? <TableSkeleton columns={2} rows={3} /> : (
        <dl className="dl">
          <dt>مدة الخدمة</dt><dd>{quantity(p.years)} سنة · الأجر {money(p.wage)}</dd>
          <dt>المكافأة الكاملة (م84)</dt><dd>{money(p.fullAward)}</dd>
          <dt>المستحق بحسب السبب</dt><dd><strong>{money(p.award)}</strong>{p.factor < 1 && <span className="muted"> ({p.factor === 0 ? "لا شيء" : p.factor < 0.5 ? "الثلث" : "الثلثان"})</span>}</dd>
          <dt>رصيد الإجازات</dt><dd>{quantity(p.leaveDays)} يوم = {money(p.leaveEncashment)}</dd>
          <dt>الإجمالي المصروف</dt><dd><strong>{money(p.total)}</strong> <span className="muted acc-small">(المخصص المقيد {money(p.provision)} يُعكس، والفرق مصروف الفترة)</span></dd>
        </dl>
      )}
      <p className="muted acc-small">راتب الشهر الأخير يُصرف في مسير شهره كالمعتاد (حتى آخر يوم عمل).</p>
      <FormError error={error} />
      <ConfirmDialog open={confirming} onClose={() => setConfirming(false)} busy={busy} onConfirm={() => void submit()} title={`إنهاء خدمة «${emp.name}»؟`} confirmLabel="إنهاء الخدمة وقيد المخالصة"
        message={<>تُقيد مخالصة بقيمة {p ? money(p.total) : "—"} وتُصرف {v.paymentMethod === "cash" ? "نقداً" : "بتحويل بنكي"}. لا يمكن التراجع؛ سجل الموظف يصبح للقراءة.</>} />
    </Dialog>
  );
}

// ── Attendance ──────────────────────────────────────────────────────────────────────────────────
interface AttRow { employeeId: string; code: string; name: string; jobTitle: string; status: string | null; hours: number | null; overtimeHours: number | null; overtimeAsLeave: boolean | null; onLeave: string | null }
type Edit = { status: string; hours: string; overtimeHours: string; overtimeAsLeave: boolean };

export function AttendancePage() {
  const { tenantId, can, writable } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [date, setDate] = useState(isoDay());
  const sheet = useQuery({ queryKey: ["t", tenantId, "hr", "attendance", date], queryFn: () => api<{ date: string; closed: boolean; items: AttRow[] }>("GET", "/t/attendance", { tenant: tenantId, query: { date } }) });
  const summary = useQuery({ queryKey: ["t", tenantId, "hr", "attendance-summary", date.slice(0, 7)],
    queryFn: () => api<{ items: { employeeId: string; code: string; name: string; present: number; absent: number; hours: number; overtimePaid: number; overtimeAsLeave: number }[] }>(
      "GET", "/t/attendance/summary", { tenant: tenantId, query: { period: date.slice(0, 7) } }) });
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { setEdits({}); setError(null); }, [date]);
  const rows = sheet.data?.items ?? [];
  const current = (r: AttRow): Edit => edits[r.employeeId] ?? { status: r.status ?? (r.onLeave ? "leave" : "present"), hours: String(r.hours ?? (r.onLeave ? 0 : 8)), overtimeHours: String(r.overtimeHours ?? 0), overtimeAsLeave: r.overtimeAsLeave ?? false };
  const setRow = (id: string, base: Edit, p: Partial<Edit>) => setEdits({ ...edits, [id]: { ...base, ...p } });
  const editable = can("attendance.record") && writable && !sheet.data?.closed && date <= isoDay();
  async function save() {
    setBusy(true); setError(null);
    try {
      const body = rows.map((r) => { const c = current(r); const present = c.status === "present";
        return { employeeId: r.employeeId, status: c.status, hours: present ? num(c.hours) || 0 : 0, overtimeHours: present ? num(c.overtimeHours) || 0 : 0, overtimeAsLeave: present && c.overtimeAsLeave }; });
      await api("PUT", "/t/attendance", { tenant: tenantId, body: { date, rows: body } });
      toast.success(`حُفظ حضور ${day(date)} لـ ${integer(body.length)} موظف`);
      setEdits({});
      await invalidate("hr");
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <div className="page">
      <PageHeader eyebrow="الموارد البشرية" title="الحضور والعمل الإضافي"
        description="سجل كل يوم: حاضر بساعاته وعمله الإضافي، أو غائب، أو في إجازة. الغياب بلا إجازة معتمدة يُخصم في المسير، والإضافي يُدفع (أجر الساعة + 50% من الأساسي) أو يُعوَّض بإجازة بموافقة الموظف."
        actions={editable && rows.length > 0 && <Button variant="primary" icon={<Save />} loading={busy} loadingText="جارٍ الحفظ…" onClick={() => void save()}>حفظ حضور اليوم</Button>} />
      <div className="toolbar panel sr-filter-bar">
        <TextField label="اليوم" type="date" dir="ltr" max={isoDay()} value={date} onChange={(e) => setDate(e.target.value || isoDay())} />
        {sheet.data?.closed && <Badge tone="neutral">مسير الشهر معتمد: للقراءة</Badge>}
      </div>
      <FormError error={error} />
      <section className="panel" aria-label="حضور اليوم">
        {sheet.isError ? <ErrorState error={sheet.error} onRetry={() => sheet.refetch()} /> : sheet.isPending ? <TableSkeleton columns={5} rows={5} /> : !rows.length
          ? <EmptyState title="لا يوجد موظفون على رأس العمل في هذا اليوم">أضف الموظفين من صفحة الموظفين.</EmptyState> : (
          <div className="table-wrap">
            <table className="data-table">
              <caption className="sr-only">حضور {day(date)}</caption>
              <thead><tr><th scope="col">الموظف</th><th scope="col">الحالة</th><th scope="col" className="end">الساعات</th><th scope="col" className="end">الإضافي</th><th scope="col">تعويض الإضافي بإجازة</th></tr></thead>
              <tbody>{rows.map((r) => { const c = current(r); const present = c.status === "present"; return (
                <tr key={r.employeeId}>
                  <td><strong>{r.name}</strong> <span className="muted acc-small"><Ref>{r.code}</Ref>{r.onLeave ? ` · ${r.onLeave}` : ""}</span>{!r.status && <> <Badge tone="info">لم يُسجَّل</Badge></>}</td>
                  <td><select className="select input-sm" aria-label={`حالة ${r.name}`} disabled={!editable} value={c.status} onChange={(e) => setRow(r.employeeId, c, { status: e.target.value })}>
                    <option value="present">حاضر</option><option value="absent">غائب</option><option value="leave">إجازة</option><option value="weekend">راحة أسبوعية</option><option value="holiday">عطلة رسمية</option></select></td>
                  <td className="end"><input className="input input-sm num" inputMode="decimal" aria-label={`ساعات ${r.name}`} disabled={!editable || !present} value={present ? c.hours : ""} onChange={(e) => setRow(r.employeeId, c, { hours: e.target.value })} style={{ maxWidth: 80 }} /></td>
                  <td className="end"><input className="input input-sm num" inputMode="decimal" aria-label={`إضافي ${r.name}`} disabled={!editable || !present} value={present ? c.overtimeHours : ""} onChange={(e) => setRow(r.employeeId, c, { overtimeHours: e.target.value })} style={{ maxWidth: 80 }} /></td>
                  <td><input type="checkbox" aria-label={`تعويض إضافي ${r.name} بإجازة`} disabled={!editable || !present || !(num(c.overtimeHours) > 0)} checked={c.overtimeAsLeave} onChange={(e) => setRow(r.employeeId, c, { overtimeAsLeave: e.target.checked })} /></td>
                </tr>); })}</tbody>
            </table>
          </div>
        )}
      </section>
      <section className="panel" aria-labelledby="att-sum">
        <div className="toolbar"><h2 id="att-sum">ملخص شهر {date.slice(0, 7)}</h2></div>
        <DataTable caption={`ملخص حضور ${date.slice(0, 7)}`} query={summary} rowKey={(r) => r.employeeId} empty={{ title: "لا حضور مسجل هذا الشهر" }}
          columns={[
            { key: "name", header: "الموظف", cell: (r) => <span><strong>{r.name}</strong> <span className="muted acc-small"><Ref>{r.code}</Ref></span></span> },
            { key: "present", header: "أيام الحضور", numeric: true, cell: (r) => integer(r.present) },
            { key: "absent", header: "الغياب", numeric: true, cell: (r) => r.absent ? <Badge tone="warning">{integer(r.absent)}</Badge> : "—" },
            { key: "hours", header: "الساعات", numeric: true, cell: (r) => quantity(r.hours) },
            { key: "overtimePaid", header: "إضافي مدفوع", numeric: true, cell: (r) => quantity(r.overtimePaid) },
            { key: "overtimeAsLeave", header: "إضافي بإجازة", numeric: true, cell: (r) => quantity(r.overtimeAsLeave) },
          ]} />
      </section>
    </div>
  );
}

// ── Leaves ──────────────────────────────────────────────────────────────────────────────────────
interface LeaveRow { id: string; startDate: string; endDate: string; days: number; status: string; note: string | null; employeeId: string; code: string; name: string; typeName: string; kind: string }
const LEAVE_STATUS: Record<string, [string, "info" | "success" | "danger" | "neutral"]> = { requested: ["بانتظار الاعتماد", "info"], approved: ["معتمدة", "success"], rejected: ["مرفوضة", "danger"], cancelled: ["ملغاة", "neutral"] };

export function LeavesPage() {
  const { tenantId, can, writable } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [status, setStatus] = useState("requested");
  const [adding, setAdding] = useState(false);
  const [cancelling, setCancelling] = useState<LeaveRow | null>(null);
  const [busy, setBusy] = useState(false);
  const list = useQuery({ queryKey: ["t", tenantId, "hr", "leaves", status], queryFn: () => api<{ items: LeaveRow[] }>("GET", "/t/leaves", { tenant: tenantId, query: { status: status === "all" ? undefined : status } }) });
  async function act(r: LeaveRow, action: "approve" | "reject" | "cancel") {
    setBusy(true);
    try {
      await api("POST", `/t/leaves/${r.id}/${action}`, { tenant: tenantId });
      toast.success(`${action === "approve" ? "اعتُمدت" : action === "reject" ? "رُفضت" : "أُلغيت"} إجازة ${r.name}`);
      setCancelling(null);
      await invalidate("hr");
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  }
  const canRequest = can("leaves.request") && writable;
  const canApprove = can("leaves.approve") && writable;
  return (
    <div className="page">
      <PageHeader eyebrow="الموارد البشرية" title="الإجازات"
        description="أنواع نظام العمل بعد تعديلات 2025: السنوية 21 يوماً (30 بعد خمس سنوات)، المرضية بشرائحها، الوضع 12 أسبوعاً، الأبوة 3 أيام. الرصيد يُتحقق منه عند الطلب، والمرضية فوق 30 يوماً تُخصم في المسير."
        actions={canRequest && <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>طلب إجازة</Button>} />
      <section className="panel" aria-label="طلبات الإجازة">
        <DataTable caption="طلبات الإجازة" query={list} rowKey={(r) => r.id} filtered={status !== "all" && status !== "requested"} onClearFilters={() => setStatus("all")}
          toolbar={<StatusTabs value={status} onChange={setStatus} options={[["requested", "بانتظار الاعتماد"], ["approved", "معتمدة"], ["all", "الكل"]]} />}
          empty={status === "requested" ? { title: "لا طلبات بانتظار الاعتماد" } : { title: "لا توجد إجازات" }}
          columns={[
            { key: "name", header: "الموظف", cell: (r) => <span><strong>{r.name}</strong> <span className="muted acc-small"><Ref>{r.code}</Ref></span></span> },
            { key: "typeName", header: "النوع", cell: (r) => r.typeName },
            { key: "startDate", header: "من", cell: (r) => day(r.startDate) },
            { key: "endDate", header: "إلى", cell: (r) => day(r.endDate) },
            { key: "days", header: "الأيام", numeric: true, cell: (r) => integer(r.days) },
            { key: "status", header: "الحالة", cell: (r) => <Badge tone={LEAVE_STATUS[r.status]![1]}>{LEAVE_STATUS[r.status]![0]}</Badge> },
          ]}
          actions={(r) => {
            const items = [...(r.status === "requested" && canApprove ? [{ label: "اعتماد", onSelect: () => void act(r, "approve") }, { label: "رفض", onSelect: () => void act(r, "reject") }] : []),
              ...((r.status === "requested" || r.status === "approved") && canRequest ? [{ label: "إلغاء", danger: true, separated: true, onSelect: () => setCancelling(r) }] : [])];
            return items.length ? <ActionMenu label={`إجراءات إجازة ${r.name}`} items={items} /> : null;
          }} />
      </section>
      {adding && <LeaveDialog tenantId={tenantId} onClose={() => setAdding(false)} />}
      <ConfirmDialog open={Boolean(cancelling)} onClose={() => setCancelling(null)} busy={busy} onConfirm={() => cancelling && void act(cancelling, "cancel")}
        title={`إلغاء إجازة ${cancelling?.name ?? ""}؟`} confirmLabel="إلغاء الإجازة" message={<>{cancelling?.typeName} من {day(cancelling?.startDate)} إلى {day(cancelling?.endDate)}. يعود رصيدها إن كانت سنوية.</>} />
    </div>
  );
}

function LeaveDialog({ tenantId, onClose }: { tenantId: string; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const emps = useQuery({ queryKey: ["t", tenantId, "hr", "employees", "active", ""], queryFn: () => api<{ items: EmpRow[] }>("GET", "/t/employees", { tenant: tenantId, query: { status: "active" } }) });
  const types = useQuery({ queryKey: ["t", tenantId, "hr", "leave-types"], queryFn: () => api<{ items: { id: string; name: string; kind: string; maxDays: number | null; gender: string | null }[] }>("GET", "/t/leave-types", { tenant: tenantId }) });
  const [v, setV] = useState({ employeeId: "", leaveTypeId: "", startDate: isoDay(), endDate: isoDay(), note: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const emp = emps.data?.items.find((e) => e.id === v.employeeId);
  const options = (types.data?.items ?? []).filter((t) => !t.gender || !emp || t.gender === emp.gender);
  const days = useMemo(() => Math.max(0, Math.round((Date.parse(v.endDate) - Date.parse(v.startDate)) / 86_400_000) + 1), [v.startDate, v.endDate]);
  async function submit() {
    const e: Record<string, string> = {};
    if (!v.employeeId) e.employeeId = "اختر الموظف";
    if (!v.leaveTypeId) e.leaveTypeId = "اختر نوع الإجازة";
    if (v.endDate < v.startDate) e.endDate = "النهاية قبل البداية";
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true); setError(null);
    try {
      await api("POST", "/t/leaves", { tenant: tenantId, body: { ...v, note: v.note.trim() || null } });
      toast.success(`قُدّم طلب إجازة ${emp?.name ?? ""} (${integer(days)} يوم)`);
      await invalidate("hr");
      onClose();
    } catch (err) { if (err instanceof ApiError) setErrors(err.fieldErrors); setError(err); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title="طلب إجازة"
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الإرسال…">تقديم الطلب</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <SelectField label="الموظف" required placeholder="اختر" value={v.employeeId} onChange={(e) => setV({ ...v, employeeId: e.target.value })} error={errors.employeeId}
        options={(emps.data?.items ?? []).map((x) => ({ value: x.id, label: `${x.name} (${x.code})` }))} />
      <SelectField label="نوع الإجازة" required placeholder="اختر" value={v.leaveTypeId} onChange={(e) => setV({ ...v, leaveTypeId: e.target.value })} error={errors.leaveTypeId}
        options={options.map((t) => ({ value: t.id, label: t.maxDays && t.kind !== "sick" ? `${t.name} · حتى ${t.maxDays} يوماً` : t.name }))} />
      <div className="form-grid">
        <TextField label="من" required type="date" dir="ltr" value={v.startDate} onChange={(e) => setV({ ...v, startDate: e.target.value })} />
        <TextField label="إلى" required type="date" dir="ltr" value={v.endDate} onChange={(e) => setV({ ...v, endDate: e.target.value })} error={errors.endDate} hint={`${integer(days)} يوم تقويمي`} />
      </div>
      <TextAreaField label="ملاحظة" optional value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} maxLength={500} />
      <FormError error={error} />
    </Dialog>
  );
}

// ── Payroll ─────────────────────────────────────────────────────────────────────────────────────
interface Run { id: string; period: string; status: "draft" | "approved" | "paid"; employees: number; gross: number; deductions: number; net: number; employerGosi: number; eosAccrual: number;
  paymentMethod: string | null; paidOn: string | null; createdAt: string; approvedAt: string | null }
const RUN_STATUS: Record<Run["status"], [string, "neutral" | "info" | "success"]> = { draft: ["مسودة", "neutral"], approved: ["معتمد ومقيد", "info"], paid: ["مصروف", "success"] };

export function PayrollPage() {
  const { tenantId, can, writable } = useTenant();
  const navigate = useNavigate();
  const toast = useToast();
  const invalidate = useInvalidate(tenantId);
  const runs = useQuery({ queryKey: ["t", tenantId, "hr", "payroll"], queryFn: () => api<{ items: Run[] }>("GET", "/t/payroll/runs", { tenant: tenantId }) });
  const [period, setPeriod] = useState(lastMonth());
  const [busy, setBusy] = useState(false);
  async function prepare() {
    setBusy(true);
    try {
      const r = await api<{ id: string }>("POST", "/t/payroll/runs", { tenant: tenantId, body: { period } });
      await invalidate("hr");
      navigate({ to: `/w/${tenantId}/hr/payroll/${r.id}` });
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  }
  const canRun = can("payroll.run") && writable;
  return (
    <div className="page">
      <PageHeader eyebrow="الموارد البشرية" title="مسير الرواتب"
        description="يُحسب من العقود والحضور والإجازات والتعديلات: التأمينات من جدول النسب بتاريخ سريانه (قديم/جديد/غير سعودي، الوعاء أساسي + سكن بسقف 45,000)، ومخصص نهاية الخدمة شهرياً. الاعتماد يقيد المسير ويقفل الشهر."
        actions={canRun && <span className="row" style={{ gap: "var(--sp-2)", alignItems: "end" }}>
          <TextField label="الشهر" type="month" dir="ltr" max={isoDay().slice(0, 7)} value={period} onChange={(e) => setPeriod(e.target.value || lastMonth())} />
          <Button variant="primary" icon={<Plus />} loading={busy} loadingText="جارٍ الحساب…" onClick={() => void prepare()}>إعداد المسير</Button></span>} />
      <section className="panel" aria-label="المسيرات">
        <DataTable caption="مسيرات الرواتب" query={runs} rowKey={(r) => r.id} onRowClick={(r) => navigate({ to: `/w/${tenantId}/hr/payroll/${r.id}` })}
          empty={{ title: "لم يُعدّ مسير بعد", body: "اختر الشهر وأعدّ المسير؛ يُحفظ مسودة تراجعها قبل الاعتماد." }}
          columns={[
            { key: "period", header: "الشهر", cell: (r) => <Ref>{r.period}</Ref> },
            { key: "status", header: "الحالة", cell: (r) => <Badge tone={RUN_STATUS[r.status][1]}>{RUN_STATUS[r.status][0]}</Badge> },
            { key: "employees", header: "الموظفون", numeric: true, cell: (r) => integer(r.employees) },
            { key: "gross", header: "الإجمالي", numeric: true, cell: (r) => money(r.gross) },
            { key: "net", header: "الصافي", numeric: true, cell: (r) => money(r.net) },
            { key: "employerGosi", header: "تأمينات صاحب العمل", numeric: true, cell: (r) => money(r.employerGosi) },
            { key: "paidOn", header: "الصرف", cell: (r) => r.paidOn ? day(r.paidOn) : "—" },
          ]} />
      </section>
      <Adjustments tenantId={tenantId} period={period} />
    </div>
  );
}

function Adjustments({ tenantId, period }: { tenantId: string; period: string }) {
  const { can, writable } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const list = useQuery({ queryKey: ["t", tenantId, "hr", "adjustments", period], queryFn: () => api<{ items: { id: string; kind: string; amount: number; note: string; code: string; name: string }[] }>(
    "GET", "/t/payroll/adjustments", { tenant: tenantId, query: { period } }) });
  const emps = useQuery({ queryKey: ["t", tenantId, "hr", "employees", "active", ""], queryFn: () => api<{ items: EmpRow[] }>("GET", "/t/employees", { tenant: tenantId, query: { status: "active" } }) });
  const [v, setV] = useState({ employeeId: "", kind: "bonus", amount: "", note: "" });
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const KIND: Record<string, string> = { bonus: "مكافأة", advance_recovery: "استرداد سلفة", penalty: "جزاء" };
  const canRun = can("payroll.run") && writable;
  async function add() {
    if (!v.employeeId || !(num(v.amount) > 0) || v.note.trim().length < 2) return setError(new Error("اختر الموظف وأدخل المبلغ والسبب"));
    setBusy(true); setError(null);
    try {
      await api("POST", "/t/payroll/adjustments", { tenant: tenantId, body: { employeeId: v.employeeId, period, kind: v.kind, amount: num(v.amount), note: v.note.trim() } });
      setV({ ...v, amount: "", note: "" });
      toast.success("أُضيف التعديل؛ أعد حساب المسير المسودة ليظهر");
      await invalidate("hr");
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  async function remove(id: string) {
    try { await api("DELETE", `/t/payroll/adjustments/${id}`, { tenant: tenantId }); setRemoving(null); await invalidate("hr"); } catch (e) { toast.error(errorMessage(e)); }
  }
  return (
    <section className="panel" aria-labelledby="adj-h">
      <div className="toolbar"><h2 id="adj-h">تعديلات شهر <Ref>{period}</Ref></h2></div>
      {canRun && (
        <div className="row panel-pad" style={{ gap: "var(--sp-2)", alignItems: "end", flexWrap: "wrap" }}>
          <SelectField label="الموظف" placeholder="اختر" value={v.employeeId} onChange={(e) => setV({ ...v, employeeId: e.target.value })} options={(emps.data?.items ?? []).map((x) => ({ value: x.id, label: x.name }))} />
          <SelectField label="النوع" value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })} options={Object.entries(KIND).map(([value, label]) => ({ value, label }))} />
          <TextField label={`المبلغ (${RIYAL})`} numeric inputMode="decimal" dir="ltr" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} />
          <TextField label="السبب" value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} />
          <Button icon={<Plus />} loading={busy} onClick={() => void add()}>إضافة</Button>
        </div>
      )}
      <FormError error={error} />
      <DataTable caption={`تعديلات ${period}`} query={list} rowKey={(r) => r.id} empty={{ title: "لا تعديلات هذا الشهر", body: "المكافآت واستردادات السلف والجزاءات تُضاف هنا قبل اعتماد المسير." }}
        columns={[
          { key: "name", header: "الموظف", cell: (r) => <span><strong>{r.name}</strong> <span className="muted acc-small"><Ref>{r.code}</Ref></span></span> },
          { key: "kind", header: "النوع", cell: (r) => KIND[r.kind] },
          { key: "amount", header: "المبلغ", numeric: true, cell: (r) => money(r.amount) },
          { key: "note", header: "السبب", wrap: true, cell: (r) => r.note },
        ]}
        actions={canRun ? (r) => <IconButton label={`حذف تعديل ${r.name}`} icon={<Trash2 />} onClick={() => setRemoving(r.id)} /> : undefined} />
      <ConfirmDialog open={Boolean(removing)} onClose={() => setRemoving(null)} onConfirm={() => removing && void remove(removing)} title="حذف التعديل؟" confirmLabel="حذف" message="يُحذف قبل اعتماد المسير ولا يدخل في حسابه." />
    </section>
  );
}

interface RunDetail extends Run {
  journal: { id: string; number: number; sourceType: string }[];
  lines: { employeeId: string; code: string; name: string; scheme: string; days: number; basic: number; housing: number; transport: number; other: number; overtime: number; bonus: number; absence: number;
    unpaidLeave: number; sick: number; gross: number; gosiBase: number; gosiEmployee: number; gosiEmployer: number; advanceRecovery: number; penalty: number; deductions: number; net: number; eosAccrual: number }[];
}

export function PayrollRunPage() {
  const { tenantId, can, writable } = useTenant();
  const { runId } = useParams({ strict: false }) as { runId: string };
  const navigate = useNavigate();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const r = useQuery({ queryKey: ["t", tenantId, "hr", "payroll", runId], queryFn: () => api<RunDetail>("GET", `/t/payroll/runs/${runId}`, { tenant: tenantId }) });
  const [dialog, setDialog] = useState<"approve" | "pay" | "delete" | null>(null);
  const [method, setMethod] = useState("bank_transfer");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const check = useQuery({ queryKey: ["t", tenantId, "hr", "wps", runId], enabled: Boolean(r.data && r.data.status !== "draft" && can("payroll.export")),
    queryFn: () => api<{ deadline: string; issues: { code: string; name: string; problem: string }[] }>("GET", `/t/payroll/runs/${runId}/wps-check`, { tenant: tenantId }) });
  if (r.isPending) return <div className="page"><TableSkeleton columns={8} rows={5} label="جارٍ تحميل المسير…" /></div>;
  if (r.isError) return <div className="page"><ErrorState error={r.error} onRetry={() => r.refetch()} /></div>;
  const d = r.data;
  const go = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true); setErr(null);
    try { await fn(); toast.success(msg); setDialog(null); await invalidate("hr", "accounting"); } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  };
  const recompute = () => go(() => api("POST", "/t/payroll/runs", { tenant: tenantId, body: { period: d.period } }), "أُعيد حساب المسير");
  const primary = d.status === "draft" && can("payroll.approve") ? <Button variant="primary" icon={<CircleCheck />} onClick={() => { setErr(null); setDialog("approve"); }}>اعتماد المسير</Button>
    : d.status === "approved" && can("payroll.pay") ? <Button variant="primary" icon={<Banknote />} onClick={() => { setErr(null); setDialog("pay"); }}>صرف الرواتب</Button> : null;
  const more = [
    ...(d.status === "draft" && can("payroll.run") ? [{ label: "إعادة الحساب", onSelect: () => void recompute() }, { label: "حذف المسودة", danger: true, separated: true, onSelect: () => setDialog("delete") }] : []),
  ];
  const file = (fmt: "mudad" | "bank") => void download(`/t/payroll/runs/${d.id}/file/${fmt}`, tenantId, fmt === "mudad" ? `wps-${d.period}.xlsx` : `salaries-${d.period}.csv`).catch((e: Error) => toast.error(e.message));
  return (
    <div className="page">
      <PageHeader eyebrow="مسير الرواتب" title={<span className="pf-title">مسير <Ref>{d.period}</Ref><Badge tone={RUN_STATUS[d.status][1]}>{RUN_STATUS[d.status][0]}</Badge></span>}
        description={`${integer(d.employees)} موظف${d.approvedAt ? ` · اعتُمد ${dayTime(d.approvedAt)}` : ""}${d.paidOn ? ` · صُرف ${day(d.paidOn)}` : ""}`}
        actions={<><Link to={`/w/${tenantId}/hr/payroll`} className="btn btn-ghost"><ArrowRight aria-hidden="true" />المسيرات</Link>
          {writable && primary}{writable && more.length > 0 && <ActionMenu label="إجراءات أخرى" items={more} />}</>} />
      {err && <p className="form-error" role="alert">{err}</p>}
      <div className="stats">
        <StatCard label="إجمالي الرواتب" value={money(d.gross)} icon={<Users />} hue="indigo" />
        <StatCard label="الصافي المستحق" value={money(d.net)} icon={<Banknote />} hue="green" note={`الاستقطاعات ${money(d.deductions)}`} />
        <StatCard label="تأمينات صاحب العمل" value={money(d.employerGosi)} icon={<ShieldCheck />} hue="sky" />
        <StatCard label="مخصص نهاية الخدمة" value={money(d.eosAccrual)} icon={<AlarmClock />} hue="amber" />
      </div>
      {d.status !== "draft" && can("payroll.export") && (
        <section className="panel panel-pad" aria-labelledby="wps-h">
          <h2 id="wps-h">حماية الأجور (مُدد)</h2>
          {check.isPending ? <TableSkeleton columns={2} rows={2} /> : check.isError ? <ErrorState error={check.error} onRetry={() => check.refetch()} /> : <>
            <p className="acc-small">آخر موعد للرفع: <strong>{day(check.data.deadline)}</strong> (30 يوماً من نهاية الشهر). مُدد تطابق الملف مع أجور التأمينات والتحويل البنكي.</p>
            {check.data.issues.length ? <ul className="stack-tight">{check.data.issues.map((i, n) => <li key={n}><Badge tone="warning">راجع</Badge> {i.name} (<Ref>{i.code}</Ref>): {i.problem}</li>)}</ul>
              : <p><Badge tone="success">جاهز للرفع</Badge> لا ملاحظات على الهويات والآيبانات وأجور التأمينات.</p>}
            <div className="row" style={{ gap: "var(--sp-2)" }}>
              <Button icon={<FileSpreadsheet />} onClick={() => file("mudad")}>ملف حماية الأجور (Excel)</Button>
              <Button variant="ghost" icon={<Download />} onClick={() => file("bank")}>ملف البنك (CSV)</Button>
            </div>
          </>}
        </section>
      )}
      <section className="panel" aria-labelledby="pl-h">
        <div className="toolbar"><h2 id="pl-h">الموظفون</h2></div>
        <div className="table-wrap">
          <table className="data-table">
            <caption className="sr-only">بنود المسير</caption>
            <thead><tr><th scope="col">الموظف</th><th scope="col" className="end">الثابت</th><th scope="col" className="end">الإضافي والمكافآت</th><th scope="col" className="end">الغياب والإجازات</th>
              <th scope="col" className="end">الإجمالي</th><th scope="col" className="end">تأمينات الموظف</th><th scope="col" className="end">استقطاعات أخرى</th><th scope="col" className="end">الصافي</th><th scope="col" className="end">تأمينات صاحب العمل</th></tr></thead>
            <tbody>{d.lines.map((l) => (
              <tr key={l.employeeId}>
                <td><Link to={`/w/${tenantId}/hr/employees/${l.employeeId}`}><strong>{l.name}</strong></Link> <span className="muted acc-small"><Ref>{l.code}</Ref> · {SCHEME[l.scheme]}{l.days < 30 ? ` · ${integer(l.days)} يوماً` : ""}</span></td>
                <td className="end num">{money(l.basic + l.housing + l.transport + l.other)}</td>
                <td className="end num">{l.overtime + l.bonus ? money(l.overtime + l.bonus) : "—"}</td>
                <td className="end num">{l.absence + l.unpaidLeave + l.sick ? `−${money(l.absence + l.unpaidLeave + l.sick)}` : "—"}</td>
                <td className="end num">{money(l.gross)}</td>
                <td className="end num">{money(l.gosiEmployee)}</td>
                <td className="end num">{l.advanceRecovery + l.penalty ? money(l.advanceRecovery + l.penalty) : "—"}</td>
                <td className="end num"><strong>{money(l.net)}</strong></td>
                <td className="end num">{money(l.gosiEmployer)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </section>
      {d.journal.length > 0 && <p className="muted acc-small">القيود: {d.journal.map((j) => <Link key={j.id} to={`/w/${tenantId}/accounting/journal/${j.id}`} className="num">#{j.number} </Link>)}</p>}
      <ConfirmDialog open={dialog === "approve"} onClose={() => setDialog(null)} busy={busy} error={err} destructive={false} title={`اعتماد مسير ${d.period}`} confirmLabel="اعتماد وقيد المسير"
        onConfirm={() => void go(() => api("POST", `/t/payroll/runs/${d.id}/approve`, { tenant: tenantId }), `اعتُمد مسير ${d.period} وقُيد`)}
        message={<>يُعاد الحساب بآخر البيانات ثم يُقيد: الرواتب {money(d.gross)} والتأمينات والمخصص. يُقفل حضور الشهر وإجازاته وتعديلاته.</>} />
      <ConfirmDialog open={dialog === "pay"} onClose={() => setDialog(null)} busy={busy} error={err} destructive={false} title={`صرف رواتب ${d.period}`} confirmLabel="تسجيل الصرف"
        onConfirm={() => void go(() => api("POST", `/t/payroll/runs/${d.id}/pay`, { tenant: tenantId, body: { method } }), "سُجّل صرف الرواتب")}
        message={<>يُقيد صرف الصافي {money(d.net)}. ارفع ملف حماية الأجور على مُدد وحوّل من البنك بنفس المبالغ.</>}>
        <SelectField label="طريقة الصرف" value={method} onChange={(e) => setMethod(e.target.value)} options={[{ value: "bank_transfer", label: "تحويل بنكي" }, { value: "cash", label: "نقدي" }]} />
      </ConfirmDialog>
      <ConfirmDialog open={dialog === "delete"} onClose={() => setDialog(null)} busy={busy} error={err} title={`حذف مسودة ${d.period}؟`} confirmLabel="حذف المسودة"
        onConfirm={() => void go(async () => { await api("DELETE", `/t/payroll/runs/${d.id}`, { tenant: tenantId }); navigate({ to: `/w/${tenantId}/hr/payroll` }); }, "حُذفت المسودة")}
        message="المسودة لم تُقيد؛ يمكن إعدادها من جديد." />
    </div>
  );
}
