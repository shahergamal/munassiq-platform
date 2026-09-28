import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CircleAlert, CircleCheck, Clock, Download, RefreshCw, Send, ShieldCheck, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";
import { api, download, type Page } from "../../api/client";
import { useTenant } from "../../app/tenant";
import { dayTime, integer } from "../../lib/format";
import type { Branch } from "../../api/types";
import { Button } from "../../ui/Button";
import { DataTable } from "../../ui/DataTable";
import { ConfirmDialog } from "../../ui/Dialog";
import { focusFirstInvalid, SelectField, TextField } from "../../ui/Field";
import { Badge, PageHeader, StatCard } from "../../ui/Layout";
import { ErrorState, FormError, TableSkeleton } from "../../ui/States";
import { useToast } from "../../ui/Toast";
import { StatusTabs } from "./Inventory";

/**
 * ZATCA Phase 2: the workspace links its own e-invoicing device with an OTP from the Fatoora portal, then every
 * invoice, credit note and POS receipt is stamped and sent automatically. This page shows the link and what failed.
 */

type Env = "sandbox" | "simulation" | "production";
interface Device {
  id: string; environment: Env; status: "onboarding" | "active" | "failed"; commonName: string; invoiceTypes: string; organizationUnit: string; location: string; industry: string;
  lastIcv: number; certificateExpiresAt: string | null; onboardedAt: string | null; complianceResults: Result[] | null; failure: string | null; createdAt: string;
  branchId: string | null; branchName: string | null;
}
interface Status {
  readiness: { ready: boolean; problems: string[]; sellerName: string; vatNumber: string };
  device: Device | null;
  /** The latest device of each branch, and the workspace-wide one (branchId null). */
  devices: Device[];
  counts: { pending: number; rejected: number; accepted: number; warnings: number; overdue: number };
  oldestPendingAt: string | null;
  worker: { at: string; attempted: number; accepted: number; rejected: number; errors: number } | null;
}
interface Result { document: string; ok: boolean; status: number; errors: string[]; warnings: string[] }
interface Doc { id: string; number: string; kind: "invoice" | "credit_note" | "debit_note" | "prepayment"; invoiceType: "standard" | "simplified"; sourceType: string; sourceId: string; icv: number; createdAt: string; outcome: Outcome | null; mode: string | null; submittedAt: string | null; errors: string[]; warnings: string[] }
type Outcome = "accepted" | "accepted_with_warnings" | "rejected" | "error";

export const ENV_LABELS: Record<Env, string> = { production: "الإنتاج (فواتير نظامية)", simulation: "المحاكاة (للتجربة)", sandbox: "بيئة المطورين (تجربة تقنية)" };
const TYPES: Record<string, string> = { "1100": "الفواتير الضريبية والمبسطة", "0100": "الفواتير المبسطة فقط", "1000": "الفواتير الضريبية فقط" };
const KIND: Record<Doc["kind"], string> = { invoice: "فاتورة", credit_note: "إشعار دائن", debit_note: "إشعار مدين", prepayment: "دفعة مقدمة" };
const branchLabel = (d: Pick<Device, "branchName">) => d.branchName ?? "كل الفروع (بلا جهاز خاص)";

/** The document's state with ZATCA, as one badge. */
export function ZatcaBadge({ outcome }: { outcome: Outcome | null }) {
  if (outcome === "accepted") return <Badge tone="success">معتمدة من الهيئة</Badge>;
  if (outcome === "accepted_with_warnings") return <Badge tone="warning">مقبولة مع ملاحظات</Badge>;
  if (outcome === "rejected") return <Badge tone="danger">مرفوضة</Badge>;
  return <Badge tone="info">بانتظار الإرسال</Badge>;
}

export function ZatcaPage() {
  const { tenantId, can, writable } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const status = useQuery({ queryKey: ["t", tenantId, "zatca", "status"], queryFn: () => api<Status>("GET", "/t/zatca/status", { tenant: tenantId }) });
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(1);
  const docs = useQuery({ queryKey: ["t", tenantId, "zatca", "docs", filter, page], placeholderData: keepPreviousData,
    queryFn: () => api<Page<Doc>>("GET", "/t/zatca/documents", { tenant: tenantId, query: { status: filter || undefined, page, pageSize: 25 } }) });
  const [sending, setSending] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["t", tenantId, "zatca"] });

  async function sendPending() {
    setSending(true);
    try {
      const r = await api<{ attempted: number; accepted: number; accepted_with_warnings: number; rejected: number; error: number }>("POST", "/t/zatca/submit-pending", { tenant: tenantId });
      if (!r.attempted) toast.success("لا توجد مستندات معلّقة");
      else if (r.error) toast.error(`أُرسل ${integer(r.attempted - r.error)} من ${integer(r.attempted)}، وتعذر الاتصال بالهيئة للباقي. أعد المحاولة لاحقاً`);
      else toast.success(`أُرسل ${integer(r.attempted)} مستنداً: ${integer(r.accepted + r.accepted_with_warnings)} مقبول${r.rejected ? `، و${integer(r.rejected)} مرفوض` : ""}`);
      await refresh();
    } catch (e) { toast.error((e as Error).message); } finally { setSending(false); }
  }

  if (status.isPending) return <div className="page"><TableSkeleton columns={4} rows={4} label="جارٍ تحميل حالة الربط…" /></div>;
  if (status.isError) return <div className="page"><ErrorState error={status.error} title="تعذر تحميل حالة الربط مع الهيئة" onRetry={() => status.refetch()} /></div>;
  const s = status.data;
  const activeDevices = s.devices.filter((x) => x.status === "active");
  const active = activeDevices.length > 0;
  const testing = activeDevices.filter((x) => x.environment !== "production");
  const canOnboard = can("zatca.onboard") && writable;

  return (
    <div className="page">
      <PageHeader eyebrow="الحسابات" title="الربط مع هيئة الزكاة والضريبة (فاتورة)"
        description="المرحلة الثانية من الفوترة الإلكترونية: تُختم كل فاتورة وإشعار وإيصال نقاط بيع بختم جهازك، وتُرسل للهيئة تلقائياً. الفواتير الضريبية تُعتمد قبل تسليمها، والمبسطة تُبلَّغ خلال 24 ساعة."
        actions={active && can("zatca.submit") && writable && s.counts.pending > 0
          ? <Button variant="primary" icon={<Send />} loading={sending} loadingText="جارٍ الإرسال…" onClick={() => void sendPending()}>إرسال المعلّق الآن ({integer(s.counts.pending)})</Button> : undefined} />

      {testing.length > 0 && (
        <p className="banner banner-warning" role="status"><TriangleAlert aria-hidden="true" />{testing.map(branchLabel).join("، ")}: الجهاز مسجَّل في {ENV_LABELS[testing[0]!.environment]}، والمستندات تُرسل لبيئة تجريبية وليست فواتير نظامية. سجّله في بيئة الإنتاج عند الجاهزية.</p>
      )}
      {active && s.counts.overdue > 0 && (
        <p className="banner banner-danger" role="alert"><CircleAlert aria-hidden="true" />{integer(s.counts.overdue)} مستند مبسط لم يُبلَّغ منذ أكثر من 20 ساعة. المهلة النظامية 24 ساعة: أرسلها الآن.</p>
      )}

      {active && (
        <div className="stats-4">
          <StatCard label="معتمدة من الهيئة" value={integer(s.counts.accepted)} icon={<CircleCheck />} hue="green" />
          <StatCard label="مقبولة مع ملاحظات" value={integer(s.counts.warnings)} icon={<TriangleAlert />} hue="amber" />
          <StatCard label="بانتظار الإرسال" value={integer(s.counts.pending)} icon={<Clock />} hue="sky"
            note={s.oldestPendingAt ? `أقدمها منذ ${dayTime(s.oldestPendingAt)}، ويُعاد إرسالها تلقائياً` : undefined} />
          <StatCard label="مرفوضة" value={integer(s.counts.rejected)} icon={<CircleAlert />} hue="red" note={s.counts.rejected ? "صحّحها بمستند جديد، ولا تُحذف" : undefined} noteTone={s.counts.rejected ? "warning" : undefined} />
        </div>
      )}

      <section className="panel" aria-labelledby="zt-device">
        <div className="card-head"><span className="ca-head-icon tone-indigo" aria-hidden="true"><ShieldCheck /></span><h2 id="zt-device">أجهزة الفوترة</h2></div>
        <div className="card-body stack">
          <p className="muted acc-small">لكل فرع جهازه وسلسلته إن سُجّل له جهاز؛ وإلا يختم مستنداته جهاز «كل الفروع». {s.readiness.sellerName} · <span className="num">{s.readiness.vatNumber}</span></p>
          {s.devices.length === 0 && <p className="muted">لا يوجد جهاز مسجَّل. المستندات تصدر الآن برمز QR المرحلة الأولى فقط.</p>}
          {s.devices.map((d) => d.status === "active" ? (
            <dl key={d.id} className="dl" aria-label={branchLabel(d)}>
              <dt>{branchLabel(d)}</dt><dd><Badge tone="success">مفعّل</Badge> {ENV_LABELS[d.environment]} · {TYPES[d.invoiceTypes]}</dd>
              <dt>الموقع</dt><dd>{d.organizationUnit} · {d.location}</dd>
              <dt>آخر رقم تسلسلي</dt><dd className="num">{integer(d.lastIcv)}</dd>
              <dt>انتهاء الشهادة</dt><dd>{d.certificateExpiresAt ? dayTime(d.certificateExpiresAt) : "—"}</dd>
            </dl>
          ) : (
            <div key={d.id} className="stack">
              <p className="form-error" role="alert">{branchLabel(d)}: فشلت آخر محاولة تسجيل: {d.failure}</p>
              {d.complianceResults && <ComplianceResults results={d.complianceResults} />}
            </div>
          ))}
          {s.worker && <p className="muted acc-small">آخر إرسال تلقائي {dayTime(s.worker.at)}: {integer(s.worker.attempted)} مستند، {integer(s.worker.accepted)} مقبول{s.worker.errors ? `، وتعذر الاتصال في ${integer(s.worker.errors)}` : ""}.</p>}
        </div>
      </section>

      {!s.readiness.ready ? (
        <section className="panel panel-pad" aria-labelledby="zt-ready">
          <h2 id="zt-ready">قبل التسجيل</h2>
          <ul className="stack">{s.readiness.problems.map((p) => <li key={p}><CircleAlert aria-hidden="true" className="acc-icon-inline" /> {p}</li>)}</ul>
          <Link to={`/w/${tenantId}/accounting/settings`} className="btn btn-secondary">فتح بيانات المنشأة الضريبية</Link>
        </section>
      ) : canOnboard ? (
        <Onboarding tenantId={tenantId} devices={activeDevices} onDone={refresh} />
      ) : !active ? <p className="muted">تسجيل الجهاز لدى الهيئة من صلاحية مالك المنشأة (إعدادات المنشأة).</p> : null}

      {(active || (docs.data?.items.length ?? 0) > 0) && (
        <section className="panel" aria-labelledby="zt-docs">
          <div className="card-head"><h2 id="zt-docs">المستندات المرسلة للهيئة</h2></div>
          <DataTable caption="المستندات المرسلة للهيئة" tableId="zatca-docs" query={docs} rowKey={(r) => r.id} onPageChange={setPage}
            toolbar={<StatusTabs value={filter} onChange={(v) => { setFilter(v); setPage(1); }} options={[["", "الكل"], ["pending", "بانتظار الإرسال"], ["rejected", "مرفوضة"], ["warnings", "مع ملاحظات"], ["accepted", "معتمدة"]]} />}
            filtered={Boolean(filter)} onClearFilters={() => setFilter("")}
            empty={{ title: "لا توجد مستندات بعد", body: "كل فاتورة أو إشعار أو إيصال نقاط بيع يصدر بعد التسجيل يظهر هنا مع حالته لدى الهيئة." }}
            columns={[
              { key: "n", header: "المستند", cell: (r) => <span><strong className="num">{r.number}</strong> <span className="muted">{KIND[r.kind]} {r.invoiceType === "standard" ? "ضريبية" : "مبسطة"}</span></span> },
              { key: "icv", header: "التسلسل", numeric: true, cell: (r) => integer(r.icv) },
              { key: "d", header: "الإصدار", cell: (r) => dayTime(r.createdAt) },
              { key: "o", header: "الحالة", cell: (r) => <ZatcaBadge outcome={r.outcome} /> },
              { key: "m", header: "رسائل الهيئة", wrap: true, cell: (r) => r.errors.length || r.warnings.length ? <span className="acc-small">{[...r.errors, ...r.warnings].slice(0, 3).join(" · ")}</span> : r.outcome === "error" ? <span className="muted">تعذر الاتصال بالهيئة</span> : "—" },
            ]}
            actions={(r) => <DocActions tenantId={tenantId} doc={r} onDone={refresh} />} />
        </section>
      )}
    </div>
  );
}

function DocActions({ tenantId, doc, onDone }: { tenantId: string; doc: Doc; onDone: () => void }) {
  const { can, writable } = useTenant();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const resend = doc.outcome === null || doc.outcome === "error";
  return (
    <span className="row" style={{ gap: "var(--sp-1)" }}>
      {resend && can("zatca.submit") && writable && (
        <Button size="sm" variant="ghost" icon={<RefreshCw />} loading={busy} loadingText="جارٍ الإرسال…" onClick={async () => {
          setBusy(true);
          try {
            const r = await api<{ outcome: Outcome; errors: string[] }>("POST", `/t/zatca/documents/${doc.id}/submit`, { tenant: tenantId });
            if (r.outcome === "error") toast.error("تعذر الاتصال بالهيئة. أعد المحاولة لاحقاً");
            else if (r.outcome === "rejected") toast.error(`رفضت الهيئة المستند: ${r.errors[0] ?? ""}`);
            else toast.success(`أُرسل ${doc.number} وقبلته الهيئة`);
            onDone();
          } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
        }}>إرسال</Button>
      )}
      <Button size="sm" variant="ghost" icon={<Download />} aria-label={`تنزيل ملف XML للمستند ${doc.number}`} onClick={() => void download(`/t/zatca/documents/${doc.id}/xml`, tenantId, `${doc.number}.xml`).catch((e: Error) => toast.error(e.message))}>XML</Button>
    </span>
  );
}

function ComplianceResults({ results }: { results: Result[] }) {
  return (
    <div className="stack">
      <h3 className="acc-small">نتائج اختبارات الامتثال لدى الهيئة</h3>
      <ul className="stack">
        {results.map((r) => (
          <li key={r.document}>
            {r.ok ? <Badge tone="success">اجتاز</Badge> : <Badge tone="danger">لم يجتز</Badge>} {r.document}
            {!r.ok && r.errors.length > 0 && <ul className="acc-small">{r.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The owner links the workspace's device: environment, document types, branch details, and the OTP. */
function Onboarding({ tenantId, devices, onDone }: { tenantId: string; devices: Device[]; onDone: () => void }) {
  const toast = useToast();
  const form = useRef<HTMLFormElement>(null);
  const branches = useQuery({ queryKey: ["t", tenantId, "branches", "options"], queryFn: () => api<Page<Branch>>("GET", "/t/branches", { tenant: tenantId, query: { pageSize: 100, isActive: "true" } }) });
  const [branchId, setBranchId] = useState("");
  const replacing = devices.some((x) => (x.branchId ?? "") === branchId);
  const [env, setEnv] = useState<Env>("simulation");
  const [types, setTypes] = useState("0100");
  const [unit, setUnit] = useState("الفرع الرئيسي");
  const [location, setLocation] = useState("");
  const [industry, setIndustry] = useState("مطاعم");
  const [otp, setOtp] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [results, setResults] = useState<Result[] | null>(null);
  const bad = /[!@#$%&*_<=]/;

  function review() {
    const e: Record<string, string> = {};
    if (unit.trim().length < 2 || bad.test(unit)) e.unit = "اكتب اسم الفرع، بدون الرموز ! @ # $ % & * _ < =";
    if (location.trim().length < 2 || bad.test(location)) e.location = "اكتب العنوان المختصر للفرع من العنوان الوطني، مثل RRRD2929";
    if (industry.trim().length < 2 || bad.test(industry)) e.industry = "اكتب نشاط المنشأة، مثل: مطاعم";
    if (!/^\d{6}$/.test(otp)) e.otp = "رمز التحقق 6 أرقام من بوابة فاتورة، وصالح لساعة واحدة";
    setErrors(e);
    if (Object.keys(e).length) return focusFirstInvalid(form.current);
    setError(null);
    setConfirming(true);
  }

  async function submit() {
    setBusy(true);
    setResults(null);
    try {
      const r = await api<{ results: Result[] }>("POST", "/t/zatca/onboard", { tenant: tenantId, body: { environment: env, otp, invoiceTypes: types, organizationUnit: unit.trim(), location: location.trim(), industry: industry.trim(), branchId: branchId || null } });
      setResults(r.results);
      setOtp("");
      toast.success("تم تسجيل جهاز الفوترة لدى الهيئة واجتاز اختبارات الامتثال");
      onDone();
    } catch (e) {
      setError(e);
      const details = (e as { details?: { results?: Result[] } }).details;
      if (details?.results?.length) setResults(details.results);
    } finally { setBusy(false); setConfirming(false); }
  }

  const choice = <T extends string>(name: string, value: T, current: T, set: (v: T) => void, title: string, hint: string) => (
    <label key={value} className={`acc-choice${current === value ? " is-selected" : ""}`}>
      <input type="radio" name={name} value={value} checked={current === value} onChange={() => set(value)} />
      <span><strong>{title}</strong><span className="muted">{hint}</span></span>
    </label>
  );

  return (
    <form ref={form} className="panel panel-pad form-section" noValidate onSubmit={(e) => { e.preventDefault(); review(); }} aria-labelledby="zt-onb">
      <h2 id="zt-onb">{replacing ? "تسجيل جهاز جديد (يستبدل الحالي)" : "تسجيل جهاز الفوترة لدى الهيئة"}</h2>
      <ol className="stack acc-small">
        <li>ادخل بوابة فاتورة <a href="https://fatoora.zatca.gov.sa" target="_blank" rel="noreferrer">fatoora.zatca.gov.sa</a> بحساب المنشأة (أو بوابة المحاكاة للتجربة).</li>
        <li>من «إضافة جهاز / حلول الفوترة» أنشئ رمز التحقق (OTP). الرمز صالح لساعة واحدة ولجهاز واحد.</li>
        <li>أدخل الرمز هنا: نُنشئ مفتاح الجهاز على خادمنا (لا يغادره)، ونسجّله، ونجري اختبارات الامتثال، ثم نفعّله.</li>
      </ol>
      <fieldset className="acc-choices">
        <legend>البيئة</legend>
        {choice("env", "simulation", env, setEnv, "المحاكاة", "للتجربة قبل الإنتاج. الرمز من بوابة المحاكاة")}
        {choice("env", "production", env, setEnv, "الإنتاج", "فواتير نظامية تُرسل للهيئة فعلياً")}
        {choice("env", "sandbox", env, setEnv, "بيئة المطورين", "تجربة تقنية برمز ثابت، بلا أثر نظامي")}
      </fieldset>
      <fieldset className="acc-choices">
        <legend>المستندات التي يصدرها الجهاز</legend>
        {choice("types", "0100", types, setTypes, "المبسطة فقط", "إيصالات نقاط البيع وفواتير الأفراد")}
        {choice("types", "1100", types, setTypes, "الضريبية والمبسطة", "إن كنت تصدر فواتير لمنشآت (تموين، عقود)")}
        {choice("types", "1000", types, setTypes, "الضريبية فقط", "فواتير بين المنشآت فقط")}
      </fieldset>
      <div className="form-grid">
        {(branches.data?.items.length ?? 0) > 1 && (
          <SelectField label="الجهاز لـ" value={branchId} onChange={(e) => { setBranchId(e.target.value); const b = branches.data?.items.find((x) => x.id === e.target.value); if (b) setUnit(b.name); }}
            options={[{ value: "", label: "كل الفروع التي بلا جهاز خاص" }, ...(branches.data?.items ?? []).map((b) => ({ value: b.id, label: `فرع ${b.name}` }))]}
            hint="جهاز لكل فرع يعطيه سلسلة مستندات مستقلة" />
        )}
        <TextField label="اسم الفرع" required value={unit} onChange={(e) => setUnit(e.target.value)} error={errors.unit} />
        <TextField label="العنوان المختصر للفرع" required value={location} onChange={(e) => setLocation(e.target.value.toUpperCase())} error={errors.location} hint="من العنوان الوطني (سبل)، مثل RRRD2929" dir="ltr" />
        <TextField label="نشاط المنشأة" required value={industry} onChange={(e) => setIndustry(e.target.value)} error={errors.industry} />
        <TextField label="رمز التحقق (OTP)" required numeric inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))} error={errors.otp} dir="ltr" />
      </div>
      <FormError error={error} />
      {results && <ComplianceResults results={results} />}
      <div className="row">
        <Button type="submit" variant="primary" icon={<ShieldCheck />} loading={busy} loadingText="جارٍ التسجيل لدى الهيئة…">تسجيل الجهاز</Button>
        <span className="muted acc-small">يستغرق عادة بين 10 و30 ثانية.</span>
      </div>
      <ConfirmDialog open={confirming} onClose={() => setConfirming(false)} busy={busy} destructive={false} onConfirm={() => void submit()}
        title="تسجيل جهاز الفوترة" confirmLabel="تسجيل الجهاز لدى الهيئة"
        message={<>سيُسجَّل جهاز جديد في {ENV_LABELS[env]} لإصدار {TYPES[types]}.{replacing ? " الجهاز الحالي لهذا الاختيار سيتوقف، وتبدأ سلسلته من جديد مع الجهاز الجديد. أجهزة الفروع الأخرى لا تتأثر." : ""} بعد التفعيل تُختم كل المستندات بختم هذا الجهاز.</>} />
    </form>
  );
}
