import { fetchMfa, mfaKey } from "./Mfa";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { MailCheck } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError, setCsrfToken } from "../../api/client";
import type { Me } from "../../api/types";
import { meKey } from "../../app/session";
import { Button } from "../../ui/Button";
import { focusFirstInvalid, TextField } from "../../ui/Field";
import { passwordRules, PasswordField } from "../../ui/PasswordField";
import { FormError } from "../../ui/States";
import { Logo } from "../../ui/Logo";

/** Only same-site absolute paths. Rejects "//evil.com" and "/\evil.com" (browsers treat both as off-site). */
export function safeNext(next: unknown): string {
  return typeof next === "string" && /^\/(?![/\\])/.test(next) && !next.includes("\\") ? next : "/app";
}

/**
 * Every sign-in page: a soft indigo/cyan light behind one centered glass card, the logo above it. The owner's
 * reference; the indigo here is scoped to these pages (.auth2), the app keeps its own blue.
 */
export function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="auth2">
      <div className="auth2-bg" aria-hidden="true" />
      <header className="auth2-top"><Link to="/" className="auth2-logo" aria-label="مُنَسِّق: الرئيسية"><Logo height={40} /></Link></header>
      <main className="auth2-main">
        <div className="auth2-card">
          <header className="auth2-head">
            <h1>{title}</h1>
            {subtitle && <p>{subtitle}</p>}
          </header>
          {children}
          {footer}
        </div>
      </main>
    </div>
  );
}

/** The legal line under the forms. */
export const AuthTerms = () => (
  <p className="auth2-terms">باستخدام مُنَسِّق، أنت توافق على <Link to="/terms">شروط الخدمة</Link> و<Link to="/privacy">سياسة الخصوصية</Link> الخاصة به.</p>
);

const emailOk = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

export function LoginPage() {
  const search = useSearch({ strict: false }) as { next?: string; verified?: string; reset?: string };
  const navigate = useNavigate();
  const qc = useQueryClient();
  const form = useRef<HTMLFormElement>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [unverified, setUnverified] = useState(false);

  async function submit() {
    const e: typeof errors = {};
    if (!emailOk(email)) e.email = "أدخل بريداً إلكترونياً صحيحاً، مثل name@company.com";
    if (!password) e.password = "أدخل كلمة المرور";
    setErrors(e);
    if (Object.keys(e).length) return focusFirstInvalid(form.current);
    setBusy(true); setError(null); setUnverified(false);
    try {
      const me = await api<Me>("POST", "/auth/login", { body: { email: email.trim(), password } });
      setCsrfToken(me.csrfToken);
      qc.setQueryData(meKey, me);
      // Two-step sign-in on: the code comes next, then the page they were going to.
      const mfa = await fetchMfa();
      qc.setQueryData(mfaKey, mfa);
      if (mfa.pending) navigate({ to: "/mfa", search: { next: safeNext(search.next) } as never });
      else navigate({ to: safeNext(search.next) });
    } catch (err) {
      setError(err);
      if (err instanceof ApiError && err.code === "email_not_verified") setUnverified(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="أهلاً بك!" subtitle="سجّل الدخول للمتابعة إلى حسابك في مُنَسِّق" footer={<>
      <p className="auth2-alt">ليس لديك حساب في مُنَسِّق؟ <Link to="/register" className="auth2-underline">إنشاء حساب</Link></p>
      <AuthTerms />
    </>}>
      {search.verified && <div className="banner banner-info ca-banner" role="status">تم تفعيل بريدك. سجّل الدخول الآن.</div>}
      {search.reset && <div className="banner banner-info ca-banner" role="status">تم تغيير كلمة المرور وإنهاء الجلسات الأخرى. سجّل الدخول بكلمة المرور الجديدة.</div>}
      <form ref={form} noValidate className="auth2-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <TextField label="البريد الإلكتروني" type="email" autoComplete="email" inputMode="email" dir="ltr" required placeholder="مطلوب" value={email} onChange={(e) => setEmail(e.target.value)} onBlur={() => email && !emailOk(email) && setErrors((x) => ({ ...x, email: "صيغة البريد غير صحيحة. تأكد من وجود @ والنطاق" }))} error={errors.email} />
        <PasswordField label="كلمة المرور" autoComplete="current-password" required placeholder="مطلوب" value={password} onChange={(e) => setPassword(e.target.value)} error={errors.password} />
        <FormError error={error} />
        {unverified && <ResendVerification email={email} />}
        <Button type="submit" variant="primary" size="lg" className="auth2-submit" loading={busy} loadingText="جارٍ الدخول…">تسجيل الدخول</Button>
      </form>
      <Link to="/forgot-password" className="auth2-forgot">نسيت كلمة المرور؟</Link>
    </AuthLayout>
  );
}

function ResendVerification({ email }: { email: string }) {
  const [state, setState] = useState<"idle" | "busy" | "sent">("idle");
  if (state === "sent") return <p className="muted" role="status">إذا كان الحساب غير مفعّل فسيصلك رابط جديد خلال دقائق.</p>;
  return (
    <Button size="sm" loading={state === "busy"} onClick={async () => {
      setState("busy");
      await api("POST", "/auth/resend-verification", { body: { email: email.trim() } }).catch(() => undefined);
      setState("sent");
    }}>إعادة إرسال رابط التفعيل</Button>
  );
}

export function RegisterPage() {
  const form = useRef<HTMLFormElement>(null);
  const [v, setV] = useState({ fullName: "", email: "", password: "", phone: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const rules = passwordRules(v.password, v.email);

  async function submit() {
    const e: Record<string, string> = {};
    if (v.fullName.trim().length < 2) e.fullName = "أدخل اسمك الكامل (حرفان على الأقل)";
    if (!emailOk(v.email)) e.email = "أدخل بريداً صحيحاً؛ سنرسل إليه رابط التفعيل";
    if (!rules.every((r) => r.ok)) e.password = "كلمة المرور لا تستوفي الشروط أعلاه";
    if (v.phone && !/^\+?[0-9]{9,15}$/.test(v.phone.trim())) e.phone = "أدخل رقم الجوال بالأرقام فقط، مثل 0501234567";
    setErrors(e);
    if (Object.keys(e).length) return focusFirstInvalid(form.current);
    setBusy(true); setError(null);
    try {
      await api("POST", "/auth/register", { body: { fullName: v.fullName.trim(), email: v.email.trim(), password: v.password, ...(v.phone.trim() ? { phone: v.phone.trim() } : {}) } });
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fieldErrors);
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <AuthLayout title="تحقق من بريدك" subtitle={<>أرسلنا رابط التفعيل إلى <strong dir="ltr">{v.email.trim()}</strong>. الرابط صالح 24 ساعة.</>}>
        <div className="state"><MailCheck aria-hidden="true" /><p>بعد التفعيل سجّل الدخول وأنشئ منشأتك. لم يصلك البريد؟ تحقق من الرسائل غير المرغوبة.</p></div>
        <Link to="/login" className="btn btn-secondary">الذهاب لتسجيل الدخول</Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="إنشاء حساب" subtitle="تجربة مجانية 14 يوماً بعد تفعيل البريد. لا تحتاج بطاقة.">
      <form ref={form} noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <TextField label="الاسم الكامل" autoComplete="name" required value={v.fullName} onChange={(e) => setV({ ...v, fullName: e.target.value })} error={errors.fullName} />
        <TextField label="البريد الإلكتروني" type="email" autoComplete="email" inputMode="email" dir="ltr" required value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} error={errors.email} hint="سيكون بريد المالك لأي منشأة تنشئها." />
        <PasswordField label="كلمة المرور" autoComplete="new-password" required value={v.password} onChange={(e) => setV({ ...v, password: e.target.value })} rules={rules} error={errors.password} />
        <TextField label="رقم الجوال" optional type="tel" autoComplete="tel" inputMode="tel" dir="ltr" value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} error={errors.phone} />
        <FormError error={error} />
        <Button type="submit" variant="primary" size="lg" loading={busy} loadingText="جارٍ إنشاء الحساب…">إنشاء الحساب</Button>
      </form>
      <p className="ca-auth-links">لديك حساب؟ <Link to="/login">سجّل الدخول</Link></p>
    </AuthLayout>
  );
}

export function VerifyEmailPage() {
  const { token } = useSearch({ strict: false }) as { token?: string };
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!token) { setError(new ApiError(400, "invalid_token", "الرابط ناقص. افتح الرابط كما وصلك في البريد.")); return; }
    api("POST", "/auth/verify-email", { body: { token } })
      .then(() => navigate({ to: "/login", search: { verified: "1" } as never }))
      .catch(setError);
  }, [token, navigate]);
  return (
    <AuthLayout title="تفعيل البريد">
      {error ? (
        <>
          <FormError error={error} />
          <p className="muted">إذا انتهت صلاحية الرابط، سجّل الدخول وستظهر لك إعادة إرسال رابط التفعيل.</p>
          <Link to="/login" className="btn btn-secondary">تسجيل الدخول</Link>
        </>
      ) : <p role="status" aria-busy="true">جارٍ تفعيل بريدك…</p>}
    </AuthLayout>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  async function submit() {
    if (!emailOk(email)) return setErr("أدخل بريداً إلكترونياً صحيحاً");
    setBusy(true); setErr(null);
    await api("POST", "/auth/forgot-password", { body: { email: email.trim() } }).catch(() => undefined);
    setBusy(false); setSent(true);
  }
  return (
    <AuthLayout title="استعادة كلمة المرور" subtitle="أدخل بريد حسابك وسنرسل رابطاً لتعيين كلمة مرور جديدة.">
      {sent ? (
        <div className="state"><MailCheck aria-hidden="true" /><p role="status">إذا كان البريد مسجلاً لدينا فستصلك رسالة خلال دقائق. الرابط صالح ساعة واحدة.</p></div>
      ) : (
        <form noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <TextField label="البريد الإلكتروني" type="email" autoComplete="email" dir="ltr" required value={email} onChange={(e) => setEmail(e.target.value)} error={err} />
          <Button type="submit" variant="primary" size="lg" loading={busy} loadingText="جارٍ الإرسال…">إرسال رابط الاستعادة</Button>
        </form>
      )}
      <Link to="/login">العودة لتسجيل الدخول</Link>
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const { token } = useSearch({ strict: false }) as { token?: string };
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const rules = passwordRules(password, "");
  async function submit() {
    if (!rules.every((r) => r.ok)) return setError("كلمة المرور لا تستوفي الشروط");
    setBusy(true); setError(null);
    try {
      await api("POST", "/auth/reset-password", { body: { token: token ?? "", password } });
      navigate({ to: "/login", search: { reset: "1" } as never });
    } catch (err) { setError(err); } finally { setBusy(false); }
  }
  return (
    <AuthLayout title="كلمة مرور جديدة" subtitle="سيتم تسجيل خروجك من كل الأجهزة الأخرى بعد التغيير.">
      <form noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <PasswordField label="كلمة المرور الجديدة" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} rules={rules} />
        <FormError error={error} />
        <Button type="submit" variant="primary" size="lg" loading={busy} loadingText="جارٍ الحفظ…">حفظ كلمة المرور</Button>
      </form>
    </AuthLayout>
  );
}
