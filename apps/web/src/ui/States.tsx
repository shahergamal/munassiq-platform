import { AlertTriangle, Inbox, Lock, SearchX } from "lucide-react";
import type { ReactNode } from "react";
import { ApiError, errorMessage } from "../api/client";
import { Button } from "./Button";

export function Skeleton({ width = "100%", height }: { width?: string; height?: number }) {
  return <div className="skeleton" style={{ width, height }} aria-hidden="true" />;
}

/** Table-shaped skeleton that matches the real row height, so nothing jumps when data arrives. */
export function TableSkeleton({ columns, rows = 6, label = "جارٍ تحميل البيانات…" }: { columns: number; rows?: number; label?: string }) {
  return (
    <div className="table-wrap" aria-busy="true">
      <span className="sr-only" role="status">{label}</span>
      <table className="data-table" aria-hidden="true">
        <thead><tr>{Array.from({ length: columns }, (_, i) => <th key={i}><Skeleton width="60%" /></th>)}</tr></thead>
        <tbody>{Array.from({ length: rows }, (_, r) => <tr key={r}>{Array.from({ length: columns }, (_, c) => <td key={c}><Skeleton width={c === 0 ? "70%" : "50%"} /></td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

type EmptyKind = "first-use" | "filtered" | "permission" | "done";

/** Distinguishes first use (explain + act), no filter match (clear filters), no permission, and "all clear". */
export function EmptyState({ kind = "first-use", title, children, action }: { kind?: EmptyKind; title: string; children?: ReactNode; action?: ReactNode }) {
  const Icon = kind === "filtered" ? SearchX : kind === "permission" ? Lock : Inbox;
  return (
    <div className="state">
      <Icon aria-hidden="true" />
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

/** Section-level error: what failed, and a retry when retrying can help. Never raw technical text. */
export function ErrorState({ error, onRetry, title = "تعذر تحميل البيانات" }: { error: unknown; onRetry?: () => void; title?: string }) {
  return (
    <div className="state is-error" role="alert">
      <AlertTriangle aria-hidden="true" />
      <h2>{title}</h2>
      <p>{errorMessage(error)}</p>
      {error instanceof ApiError && error.code === "mfa_enrollment_required"
        ? <a href="/account" className="btn btn-primary btn-sm">تفعيل التحقق بخطوتين</a>
        : onRetry && <Button size="sm" onClick={onRetry}>إعادة المحاولة</Button>}
    </div>
  );
}

export function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="form-error" role="alert">{typeof error === "string" ? error : errorMessage(error)}</div>;
}
