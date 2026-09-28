import { Eye, EyeOff } from "lucide-react";
import { useId, useState, type InputHTMLAttributes } from "react";
import { IconButton } from "./Button";

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "id"> {
  label: string;
  error?: string | null;
  /** New-password fields show the rules before any error. */
  rules?: { text: string; ok: boolean }[];
}

/** Show/hide toggle, paste and password managers allowed, rules shown up front for new passwords. */
export function PasswordField({ label, error, rules, required, ...rest }: Props) {
  const [show, setShow] = useState(false);
  const id = useId();
  const errId = error ? `${id}-err` : undefined;
  const rulesId = rules ? `${id}-rules` : undefined;
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
        {required && <span className="req" aria-hidden="true">*</span>}
      </label>
      <div style={{ position: "relative" }}>
        <input
          {...rest}
          id={id}
          type={show ? "text" : "password"}
          required={required}
          className="input"
          style={{ paddingInlineEnd: "var(--sp-10)" }}
          aria-invalid={error ? true : undefined}
          aria-describedby={[rulesId, errId].filter(Boolean).join(" ") || undefined}
        />
        <span style={{ position: "absolute", insetInlineEnd: "var(--sp-1)", insetBlockStart: "50%", transform: "translateY(-50%)" }}>
          <IconButton size="sm" label={show ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"} icon={show ? <EyeOff /> : <Eye />} onClick={() => setShow((s) => !s)} aria-pressed={show} />
        </span>
      </div>
      {rules && (
        <ul id={rulesId} className="field-hint" style={{ margin: 0, paddingInlineStart: "var(--sp-4)" }}>
          {rules.map((r) => <li key={r.text} style={{ color: r.ok ? "var(--success)" : undefined }}>{r.ok ? "✓ " : ""}{r.text}</li>)}
        </ul>
      )}
      {error && <span className="field-error" id={errId} role="alert">{error}</span>}
    </div>
  );
}

/** Mirrors the server rules (apps/api/src/lib/security.ts passwordProblem) so users see them before submitting. */
export function passwordRules(password: string, email: string) {
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  return [
    { text: "10 أحرف على الأقل", ok: password.length >= 10 },
    { text: "لا تحتوي على جزء من بريدك", ok: password.length > 0 && !(local.length >= 4 && password.toLowerCase().includes(local)) },
  ];
}
