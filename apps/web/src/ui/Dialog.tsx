import { X } from "lucide-react";
import { useEffect, useRef, type FormEvent, type ReactNode } from "react";
import { Button, IconButton } from "./Button";

interface DialogProps {
  /** On phones, rises from the bottom and takes only the height it needs (filters, quick choices). */
  sheet?: boolean;
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** When set, the body is a <form>; Enter submits and the footer's submit button belongs to it. */
  onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
  formRef?: React.Ref<HTMLFormElement>;
  /** Block Escape / close while a request is in flight. */
  busy?: boolean;
}

/**
 * Native <dialog> with showModal(): real focus trap, Escape closes, top layer, inert page behind.
 * Focus returns to the element that opened it.
 */
export function Dialog({ open, onClose, title, children, footer, wide, sheet, onSubmit, formRef, busy }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const titleId = useRef(`dlg-${Math.random().toString(36).slice(2)}`).current;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      opener.current = document.activeElement;
      d.showModal();
    } else if (!open && d.open) {
      d.close();
      (opener.current as HTMLElement | null)?.focus?.();
    }
  }, [open]);

  useEffect(() => () => { (opener.current as HTMLElement | null)?.focus?.(); }, []);

  const body = (
    <>
      <div className="dialog-body">{children}</div>
      {footer && <div className="dialog-foot">{footer}</div>}
    </>
  );

  return (
    <dialog
      ref={ref}
      className={["dialog", wide && "is-wide", sheet && "is-sheet"].filter(Boolean).join(" ")}
      aria-labelledby={titleId}
      onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}
    >
      {open && (
        <>
          <div className="dialog-head">
            <h2 id={titleId}>{title}</h2>
            <IconButton label="إغلاق" icon={<X />} size="sm" onClick={onClose} disabled={busy} />
          </div>
          {onSubmit ? (
            <form ref={formRef} noValidate onSubmit={(e) => { e.preventDefault(); onSubmit(e); }} style={{ display: "contents" }}>{body}</form>
          ) : body}
        </>
      )}
    </dialog>
  );
}

interface ConfirmProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  /** What will happen, naming the entity. */
  message: ReactNode;
  /** Verb describing the result, e.g. "حذف المورد نهائياً" (never "نعم"). */
  confirmLabel: string;
  busy?: boolean;
  error?: string | null;
  /** Irreversible/destructive (red confirm). Otherwise primary. */
  destructive?: boolean;
  children?: ReactNode;
}

/** Confirmation: the entity is named, the confirm button says what happens, and focus starts on "إلغاء". */
export function ConfirmDialog({ open, onClose, onConfirm, title, message, confirmLabel, busy, error, destructive = true, children }: ConfirmProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      busy={busy}
      footer={
        <>
          <Button variant={destructive ? "danger" : "primary"} onClick={onConfirm} loading={busy}>{confirmLabel}</Button>
          <Button variant="secondary" onClick={onClose} disabled={busy} autoFocus>إلغاء</Button>
        </>
      }
    >
      <p>{message}</p>
      {children}
      {error && <div className="form-error" role="alert">{error}</div>}
    </Dialog>
  );
}
