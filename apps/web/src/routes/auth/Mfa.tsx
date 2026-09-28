import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import QRCode from "qrcode";
import { useState } from "react";
import { api } from "../../api/client";
import { useLogout } from "../../app/session";
import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/Dialog";
import { TextField } from "../../ui/Field";
import { Badge } from "../../ui/Layout";
import { FormError, TableSkeleton } from "../../ui/States";
import { AuthLayout } from "./AuthPages";
import { useToast } from "../../ui/Toast";

// Two-step sign-in: the code screen after the password, and the account section that turns it on or off.

export const mfaKey = ["mfa"] as const;
export interface MfaStatus { enabled: boolean; enabledAt: string | null; pending: boolean; recoveryCodesLeft: number }
export const fetchMfa = () => api<MfaStatus>("GET", "/auth/mfa");
const safeNext = (n: string | undefined) => (n && n.startsWith("/") && !n.startsWith("//") ? n : "/app");

/** After the password: the 6-digit code from the authenticator app, or one recovery code. */
export function MfaVerifyPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const logout = useLogout();
  const search = useSearch({ strict: false }) as { next?: string };
  const [recovery, setRecovery] = useState(false);
  const [value, setValue] = useState("");
  const [fieldErr, setFieldErr] = useState<string | undefined>();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    const v = value.trim();
    if (!recovery && !/^\d{6}$/.test(v)) return setFieldErr("الرمز 6 أرقام من تطبيق المصادقة");
    if (recovery && v.length < 8) return setFieldErr("رمز الاسترداد مثل abcde-fghij");
    setFieldErr(undefined); setBusy(true); setError(null);
    try {
      await api("POST", "/auth/mfa/verify", { body: recovery ? { recoveryCode: v } : { code: v } });
      qc.setQueryData(mfaKey, (m: MfaStatus | undefined) => (m ? { ...m, pending: false } : m));
      await qc.invalidateQueries({ queryKey: mfaKey });
      navigate({ to: safeNext(search.next) });
    } catch (e) { setError(e); setValue(""); } finally { setBusy(false); }
  }
  return (
    <AuthLayout title="التحقق بخطوتين" subtitle={recovery ? "أدخل أحد رموز الاسترداد التي حفظتها عند التفعيل. كل رمز يعمل مرة واحدة." : "افتح تطبيق المصادقة وأدخل الرمز المكوّن من 6 أرقام."}>
      <form className="stack-lg" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }} aria-label="رمز التحقق">
        <TextField key={recovery ? "r" : "c"} autoFocus label={recovery ? "رمز الاسترداد" : "رمز التحقق"} required dir="ltr" autoComplete="one-time-code" inputMode={recovery ? "text" : "numeric"}
          maxLength={recovery ? 20 : 6} value={value} onChange={(e) => setValue(recovery ? e.target.value : e.target.value.replace(/\D/g, ""))} error={fieldErr} />
        <FormError error={error} />
        <Button type="submit" variant="primary" loading={busy} loadingText="جارٍ التحقق…">متابعة</Button>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <Button variant="ghost" onClick={() => { setRecovery(!recovery); setValue(""); setFieldErr(undefined); setError(null); }}>{recovery ? "استخدم رمز التطبيق" : "لا أستطيع الوصول للتطبيق"}</Button>
          <Button variant="ghost" onClick={() => void logout()}>تسجيل الخروج</Button>
        </div>
      </form>
    </AuthLayout>
  );
}

/** Account section: turn two-step sign-in on (QR, first code, recovery codes shown once) or off. */
export function MfaSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const status = useQuery({ queryKey: mfaKey, queryFn: fetchMfa });
  const [setup, setSetup] = useState<{ secret: string; uri: string; qr: string | null } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState("");
  const [dialog, setDialog] = useState<"disable" | "regenerate" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: mfaKey });
  async function start() {
    setBusy(true); setError(null);
    try {
      const s = await api<{ secret: string; uri: string }>("POST", "/auth/mfa/setup");
      const qr = await QRCode.toDataURL(s.uri, { margin: 1, width: 220 }).catch(() => null);
      setSetup({ ...s, qr });
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  async function enable() {
    if (!/^\d{6}$/.test(code)) return setError(new Error("أدخل الرمز المكوّن من 6 أرقام من التطبيق"));
    setBusy(true); setError(null);
    try {
      const r = await api<{ recoveryCodes: string[] }>("POST", "/auth/mfa/enable", { body: { code } });
      setCodes(r.recoveryCodes); setSetup(null); setCode("");
      toast.success("فُعّل التحقق بخطوتين");
      await refresh();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  async function withCode(kind: "disable" | "regenerate") {
    if (!/^\d{6}$/.test(code)) return setError(new Error("أدخل الرمز الحالي من التطبيق"));
    setBusy(true); setError(null);
    try {
      if (kind === "disable") { await api("POST", "/auth/mfa/disable", { body: { code } }); toast.success("أُوقف التحقق بخطوتين"); }
      else { const r = await api<{ recoveryCodes: string[] }>("POST", "/auth/mfa/recovery-codes", { body: { code } }); setCodes(r.recoveryCodes); }
      setDialog(null); setCode("");
      await refresh();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  const s = status.data;
  return (
    <section className="panel" aria-labelledby="mfa-set">
      <div className="card-head"><span className="ca-head-icon tone-indigo" aria-hidden="true"><ShieldCheck /></span><h2 id="mfa-set">التحقق بخطوتين</h2>
        {s && (s.enabled ? <Badge tone="success">مفعّل</Badge> : <Badge tone="warning">غير مفعّل</Badge>)}</div>
      <div className="card-body stack-lg">
        {status.isPending ? <TableSkeleton columns={2} rows={2} /> : codes ? (
          <div className="stack">
            <p><strong>احفظ رموز الاسترداد الآن</strong>؛ لن تظهر مرة أخرى. كل رمز يدخلك مرة واحدة إن فقدت هاتفك.</p>
            <ul className="mfa-codes" dir="ltr">{codes.map((c) => <li key={c} className="num">{c}</li>)}</ul>
            <div className="row" style={{ gap: "var(--sp-2)" }}>
              <Button onClick={() => void navigator.clipboard?.writeText(codes.join("\n")).then(() => toast.success("نُسخت الرموز"))}>نسخ الرموز</Button>
              <Button variant="primary" onClick={() => setCodes(null)}>حفظتها</Button>
            </div>
          </div>
        ) : setup ? (
          <div className="stack">
            <p>امسح الرمز بتطبيق المصادقة (Google Authenticator أو Microsoft Authenticator أو غيرهما)، ثم أدخل الرمز الذي يظهر.</p>
            {setup.qr && <img src={setup.qr} alt="رمز QR لإضافة الحساب في تطبيق المصادقة" width={220} height={220} />}
            <p className="acc-small">أو أدخل المفتاح يدوياً: <code dir="ltr" className="num">{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</code></p>
            <TextField label="الرمز من التطبيق" required dir="ltr" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
            <FormError error={error} />
            <div className="row" style={{ gap: "var(--sp-2)" }}>
              <Button variant="primary" loading={busy} loadingText="جارٍ التفعيل…" onClick={() => void enable()}>تفعيل</Button>
              <Button onClick={() => { setSetup(null); setCode(""); setError(null); }}>إلغاء</Button>
            </div>
          </div>
        ) : s?.enabled ? (
          <div className="stack">
            <p className="muted">يُطلب رمز التطبيق عند كل تسجيل دخول جديد. رموز الاسترداد المتبقية: <span className="num">{s.recoveryCodesLeft}</span>.</p>
            <div className="row" style={{ gap: "var(--sp-2)" }}>
              <Button onClick={() => { setError(null); setCode(""); setDialog("regenerate"); }}>رموز استرداد جديدة</Button>
              <Button variant="ghost" onClick={() => { setError(null); setCode(""); setDialog("disable"); }}>إيقاف التحقق بخطوتين</Button>
            </div>
          </div>
        ) : (
          <div className="stack">
            <p className="muted">أضف طبقة حماية لحسابك: بعد كلمة المرور يُطلب رمز من تطبيق على هاتفك. ننصح به لمالك المنشأة ولمن يرى الرواتب.</p>
            <FormError error={error} />
            <div><Button variant="primary" loading={busy} loadingText="جارٍ الإعداد…" onClick={() => void start()}>تفعيل التحقق بخطوتين</Button></div>
          </div>
        )}
      </div>
      <ConfirmDialog open={dialog !== null} onClose={() => setDialog(null)} busy={busy} destructive={dialog === "disable"} onConfirm={() => void withCode(dialog!)}
        title={dialog === "disable" ? "إيقاف التحقق بخطوتين؟" : "إصدار رموز استرداد جديدة؟"} confirmLabel={dialog === "disable" ? "إيقاف" : "إصدار"}
        message={dialog === "disable" ? "يصبح تسجيل الدخول بكلمة المرور وحدها." : "تتوقف الرموز القديمة كلها."}>
        <TextField label="الرمز الحالي من التطبيق" required dir="ltr" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
        <FormError error={error} />
      </ConfirmDialog>
    </section>
  );
}
