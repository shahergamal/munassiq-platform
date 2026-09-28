import { MfaSettings } from "./auth/Mfa";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, useNavigate } from "@tanstack/react-router";
import { Building2, ChevronLeft, KeyRound, Plus } from "lucide-react";
import { useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import { meKey, useLogout, useMe } from "../app/session";
import { day } from "../lib/format";
import { Button } from "../ui/Button";
import { focusFirstInvalid, SelectField, TextField } from "../ui/Field";
import { Badge, PageHeader, StatusBadge, type Hue } from "../ui/Layout";
import { passwordRules, PasswordField } from "../ui/PasswordField";
import { ErrorState, FormError } from "../ui/States";
import { ROLE_LABELS } from "../ui/status";
import { useToast } from "../ui/Toast";
import { AuthLayout } from "./auth/AuthPages";
import { Logo } from "../ui/Logo";

const TILE_HUES: Hue[] = ["indigo", "sky", "green", "orange", "violet", "amber"];

function PlainTop() {
  const logout = useLogout();
  const me = useMe();
  return (
    <header className="topbar">
      <div className="topbar-id">
        <Link to="/app" className="wordmark" aria-label="مُنَسِّق: منشآتي"><Logo height={36} /></Link>
        <span className="spacer" />
        {me.data?.user.isPlatformAdmin && <Link to="/admin" className="btn btn-ghost btn-sm">إدارة المنصة</Link>}
        <Link to="/account" className="btn btn-ghost btn-sm">حسابي</Link>
        <Button size="sm" variant="ghost" onClick={logout}>تسجيل الخروج</Button>
      </div>
    </header>
  );
}

/** Lands a logged-in user: one workspace → open it; none → create; several → choose (the old UI silently took the first). */
export function AppEntryPage() {
  const me = useMe();
  if (me.isPending) return <p className="page" role="status" aria-busy="true">جارٍ تحميل منشآتك…</p>;
  if (me.isError) return <div className="page"><ErrorState error={me.error} onRetry={() => me.refetch()} /></div>;
  const tenants = me.data?.tenants ?? [];
  if (tenants.length === 1) return <Navigate to={`/w/${tenants[0]!.id}`} replace />;
  if (tenants.length === 0 && !me.data?.user.isPlatformAdmin) return <Navigate to="/onboarding" replace />;
  return (
    <>
      <PlainTop />
      <div className="page ca-page-entry">
        <PageHeader title="منشآتي" description="اختر المنشأة التي تريد العمل عليها." actions={<Link to="/onboarding" className="btn btn-secondary"><Plus aria-hidden="true" />منشأة جديدة</Link>} />
        {tenants.length === 0 ? (
          <div className="panel"><div className="card-head"><h2>لا توجد منشآت</h2></div><div className="card-body"><p>لست عضواً في أي منشأة. بصفتك مدير المنصة يمكنك <Link to="/admin">فتح إدارة المنصة</Link>.</p></div></div>
        ) : (
          <ul className="panel ca-entry-list" aria-label="منشآتي">
            {tenants.map((t, i) => (
              <li key={t.id}>
                <Link to={`/w/${t.id}`} className="list-link">
                  <span className={`ca-tile tone-${TILE_HUES[i % TILE_HUES.length]}`} aria-hidden="true"><Building2 /></span>
                  <span className="who">
                    <strong>{t.companyName}</strong>
                    <span>{t.role === "custom" ? t.roleName : ROLE_LABELS[t.role] ?? t.role}{t.endsAt ? ` · حتى ${day(t.endsAt)}` : ""}</span>
                  </span>
                  {t.operational ? <StatusBadge kind="subscription" value={t.subscriptionStatus} /> : <Badge tone="danger">غير مفعّلة</Badge>}
                  <ChevronLeft aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

interface Sector { key: string; nameAr: string; isAvailable: boolean }

export function OnboardingPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useMe();
  const sectors = useQuery({ queryKey: ["sectors"], queryFn: () => api<Sector[]>("GET", "/sectors"), staleTime: Infinity });
  const form = useRef<HTMLFormElement>(null);
  const [v, setV] = useState({ companyName: "", sector: "restaurants", taxId: "", city: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [waitlisted, setWaitlisted] = useState(false);
  const chosen = sectors.data?.find((s) => s.key === v.sector);
  const unavailable = chosen && !chosen.isAvailable;

  async function submit() {
    const e: Record<string, string> = {};
    if (v.companyName.trim().length < 2) e.companyName = "أدخل اسم المنشأة كما سيظهر في الفواتير";
    if (!unavailable && !/^[0-9]{10,15}$/.test(v.taxId.trim())) e.taxId = "أدخل الرقم الضريبي أو السجل التجاري: من 10 إلى 15 رقماً دون مسافات";
    setErrors(e);
    if (Object.keys(e).length) return focusFirstInvalid(form.current);
    setBusy(true); setError(null);
    try {
      if (unavailable) {
        await api("POST", "/waitlist", { body: { email: me.data?.user.email, companyName: v.companyName.trim(), sector: v.sector } });
        setWaitlisted(true);
      } else {
        const r = await api<{ id: string }>("POST", "/tenants", { body: { companyName: v.companyName.trim(), sector: v.sector, taxId: v.taxId.trim(), ...(v.city.trim() ? { city: v.city.trim() } : {}) } });
        await qc.invalidateQueries({ queryKey: meKey });
        navigate({ to: `/w/${r.id}` });
      }
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fieldErrors);
      setError(err);
    } finally { setBusy(false); }
  }

  if (me.data && !me.data.user.emailVerified) {
    return <AuthLayout title="فعّل بريدك أولاً" subtitle="أرسلنا رابط التفعيل عند التسجيل. بعد التفعيل يمكنك إنشاء منشأتك."><Link to="/login" className="btn btn-secondary">العودة</Link></AuthLayout>;
  }

  return (
    <AuthLayout title="إنشاء منشأة" subtitle="تبدأ التجربة المجانية 14 يوماً فور الإنشاء، وتكون أنت المالك.">
      {waitlisted ? (
        <div className="stack" role="status">
          <p>سجلنا اهتمامك بقطاع <strong>{chosen?.nameAr}</strong>. سنبلغك على <span dir="ltr">{me.data?.user.email}</span> فور إطلاقه.</p>
          <Button onClick={() => { setWaitlisted(false); setV({ ...v, sector: "restaurants" }); }}>إنشاء منشأة مطاعم الآن</Button>
        </div>
      ) : (
        <form ref={form} noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <TextField label="اسم المنشأة" required autoComplete="organization" value={v.companyName} onChange={(e) => setV({ ...v, companyName: e.target.value })} error={errors.companyName} hint="يظهر في الفواتير ورمز QR." />
          <SelectField label="القطاع" required value={v.sector} onChange={(e) => setV({ ...v, sector: e.target.value })} disabled={sectors.isPending}
            options={(sectors.data ?? [{ key: "restaurants", nameAr: "المطاعم", isAvailable: true }]).map((s) => ({ value: s.key, label: s.isAvailable ? s.nameAr : `${s.nameAr} (قريباً)` }))} />
          {unavailable ? (
            <p className="banner banner-warning ca-banner">هذا القطاع غير متاح بعد. سجّل اهتمامك وسنبلغك فور إطلاقه.</p>
          ) : (
            <>
              <TextField label="الرقم الضريبي أو السجل التجاري" required inputMode="numeric" dir="ltr" value={v.taxId} onChange={(e) => setV({ ...v, taxId: e.target.value.replace(/\D/g, "") })} error={errors.taxId} hint="يوثّقه فريق المنصة لاحقاً، ولن يمنع أحداً غيرك من التسجيل قبل التوثيق." />
              <TextField label="المدينة" optional autoComplete="address-level2" value={v.city} onChange={(e) => setV({ ...v, city: e.target.value })} />
            </>
          )}
          <FormError error={error} />
          <Button type="submit" variant="primary" size="lg" loading={busy} loadingText="جارٍ الإنشاء…">{unavailable ? "سجّل اهتمامي" : "إنشاء المنشأة وبدء التجربة"}</Button>
        </form>
      )}
      <Link to="/app">إلغاء والعودة</Link>
    </AuthLayout>
  );
}

export function AccountPage() {
  const me = useMe();
  const toast = useToast();
  const [v, setV] = useState({ current: "", next: "" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const rules = passwordRules(v.next, me.data?.user.email ?? "");
  async function submit() {
    if (!v.current) return setError("أدخل كلمة المرور الحالية");
    if (!rules.every((r) => r.ok)) return setError("كلمة المرور الجديدة لا تستوفي الشروط");
    setBusy(true); setError(null);
    try {
      await api("POST", "/auth/change-password", { body: { currentPassword: v.current, newPassword: v.next } });
      setV({ current: "", next: "" });
      toast.success("تم تغيير كلمة المرور وإنهاء جلساتك على الأجهزة الأخرى");
    } catch (err) { setError(err); } finally { setBusy(false); }
  }
  return (
    <>
      <PlainTop />
      <div className="page ca-page-account">
        <PageHeader title="حسابي" description={me.data ? <>{me.data.user.fullName} · <span dir="ltr">{me.data.user.email}</span></> : undefined} />
        <form className="panel" noValidate aria-labelledby="pw-title" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div className="card-head"><span className="ca-head-icon tone-indigo" aria-hidden="true"><KeyRound /></span><h2 id="pw-title">تغيير كلمة المرور</h2></div>
          <div className="card-body stack-lg">
            <PasswordField label="كلمة المرور الحالية" autoComplete="current-password" required value={v.current} onChange={(e) => setV({ ...v, current: e.target.value })} />
            <PasswordField label="كلمة المرور الجديدة" autoComplete="new-password" required value={v.next} onChange={(e) => setV({ ...v, next: e.target.value })} rules={rules} />
            <FormError error={error} />
            <div><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">تغيير كلمة المرور</Button></div>
          </div>
        </form>
        <MfaSettings />
      </div>
    </>
  );
}

export function LandingPage() {
  const me = useMe();
  if (me.data) return <Navigate to="/app" replace />;
  return (
    <AuthLayout title="مُنَسِّق لتكاليف المطاعم" subtitle="من فاتورة المورد إلى تكلفة الطبق وربحية المنيو، في مكان واحد وبالعربية.">
      <div className="stack">
        <Link to="/register" className="btn btn-primary btn-lg">ابدأ التجربة المجانية</Link>
        <Link to="/login" className="btn btn-secondary btn-lg">تسجيل الدخول</Link>
      </div>
      <p className="muted ca-auth-note">
        الفواتير المبسطة تحمل رمز QR وفق المرحلة الأولى من الفوترة الإلكترونية (هيئة الزكاة والضريبة والجمارك). الربط بمنصة فاتورة (المرحلة الثانية) غير مشمول حالياً.
      </p>
    </AuthLayout>
  );
}
