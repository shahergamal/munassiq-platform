import { useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

interface FieldShell {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  /** Shows "(اختياري)" after the label; most fields are required, so the exceptions are marked. */
  optional?: boolean;
}

/** Hides a field's error once the user edits the field; the next submit re-validates and may show a new one. */
function useLiveError<E extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(error?: string | null) {
  const ref = useRef<E>(null);
  const [edited, setEdited] = useState(false);
  useEffect(() => setEdited(false), [error]);
  // Every submit of the surrounding form re-validates, so the error (even an identical one) must show again.
  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;
    const reset = () => setEdited(false);
    form.addEventListener("submit", reset, true);
    return () => form.removeEventListener("submit", reset, true);
  }, []);
  return { ref, shown: edited ? null : error, markEdited: () => setEdited(true) };
}

function useFieldIds(error?: string | null, hint?: ReactNode) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  return { id, hintId, errId, describedBy: [hintId, errId].filter(Boolean).join(" ") || undefined };
}

function Shell({ id, label, hint, hintId, error, errId, required, optional, children }: FieldShell & { id: string; hintId?: string; errId?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
        {required && <span className="req" aria-hidden="true">*</span>}
        {required && <span className="sr-only"> (مطلوب)</span>}
        {optional && <span className="muted" style={{ fontWeight: 400 }}> (اختياري)</span>}
      </label>
      {children}
      {hint && <span className="field-hint" id={hintId}>{hint}</span>}
      {error && <span className="field-error" id={errId} role="alert">{error}</span>}
    </div>
  );
}

export type TextFieldProps = FieldShell & Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & { numeric?: boolean };

/** Label above, hint below, error under the field and linked with aria-describedby. */
export function TextField({ label, hint, error, required, optional, numeric, className, ...rest }: TextFieldProps) {
  const live = useLiveError<HTMLInputElement>(error);
  error = live.shown;
  const ids = useFieldIds(error, hint);
  return (
    <Shell {...ids} label={label} hint={hint} error={error} required={required} optional={optional}>
      <input
        {...rest}
        ref={live.ref}
        id={ids.id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={ids.describedBy}
        inputMode={numeric ? "decimal" : rest.inputMode}
        className={["input", numeric && "num", className].filter(Boolean).join(" ")}
        onChange={(e) => { live.markEdited(); rest.onChange?.(e); }}
      />
    </Shell>
  );
}

export type SelectFieldProps = FieldShell & Omit<SelectHTMLAttributes<HTMLSelectElement>, "id"> & {
  options: { value: string; label: string; disabled?: boolean }[];
  placeholder?: string;
};

export function SelectField({ label, hint, error, required, optional, options, placeholder, className, ...rest }: SelectFieldProps) {
  const live = useLiveError<HTMLSelectElement>(error);
  error = live.shown;
  const ids = useFieldIds(error, hint);
  return (
    <Shell {...ids} label={label} hint={hint} error={error} required={required} optional={optional}>
      <select {...rest} ref={live.ref} onChange={(e) => { live.markEdited(); rest.onChange?.(e); }} id={ids.id} required={required} aria-invalid={error ? true : undefined} aria-describedby={ids.describedBy} className={["select", className].filter(Boolean).join(" ")}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
      </select>
    </Shell>
  );
}

export type TextAreaFieldProps = FieldShell & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id">;

export function TextAreaField({ label, hint, error, required, optional, className, ...rest }: TextAreaFieldProps) {
  const live = useLiveError<HTMLTextAreaElement>(error);
  error = live.shown;
  const ids = useFieldIds(error, hint);
  return (
    <Shell {...ids} label={label} hint={hint} error={error} required={required} optional={optional}>
      <textarea {...rest} ref={live.ref} onChange={(e) => { live.markEdited(); rest.onChange?.(e); }} id={ids.id} required={required} aria-invalid={error ? true : undefined} aria-describedby={ids.describedBy} className={["textarea", className].filter(Boolean).join(" ")} />
    </Shell>
  );
}

export function Checkbox({ label, ...rest }: { label: string } & Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  return (
    <label className="checkbox">
      <input type="checkbox" {...rest} />
      {label}
    </label>
  );
}

/** Focuses the first invalid field after a failed submit (DESIGN.md §7 Field). */
export function focusFirstInvalid(form: HTMLFormElement | null): void {
  requestAnimationFrame(() => form?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
}

/** Toolbar search box: visible icon, hidden label, native clear button (type=search). */
export function SearchInput({ label = "بحث", value, onChange, placeholder }: { label?: string; value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="search" style={{ position: "relative", display: "flex" }}>
      <span className="sr-only">{label}</span>
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ position: "absolute", insetInlineStart: "var(--sp-3)", insetBlockStart: "50%", transform: "translateY(-50%)", width: 16, height: 16, color: "var(--text-muted)" }}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      <input className="input" type="search" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} style={{ paddingInlineStart: "var(--sp-8)" }} />
    </label>
  );
}
