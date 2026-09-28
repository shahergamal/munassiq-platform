import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "sm" | "md" | "lg";
  /** Shows a spinner, keeps the width, blocks repeat submits. */
  loading?: boolean;
  /** Label announced while loading, e.g. "جارٍ الحفظ…". */
  loadingText?: string;
  icon?: ReactNode;
  /** Quiet destructive action (row delete): ghost + danger text. Never a filled red button in a row. */
  destructive?: boolean;
}

export function Button({ variant = "secondary", size = "md", loading, loadingText, icon, destructive, className, children, disabled, type, ...rest }: ButtonProps) {
  const cls = ["btn", `btn-${variant}`, size !== "md" && `btn-${size}`, destructive && "is-danger", className].filter(Boolean).join(" ");
  return (
    <button {...rest} type={type ?? "button"} className={cls} disabled={disabled || loading} aria-busy={loading || undefined}>
      {loading ? <span className="spinner" aria-hidden="true" /> : icon}
      {loading && loadingText ? loadingText : children}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonProps, "children" | "icon"> {
  label: string;
  icon: ReactNode;
}

/** Icon-only button: aria-label is required, and the hit area is 44px even when it looks 32–36px. */
export function IconButton({ label, icon, variant = "ghost", className, ...rest }: IconButtonProps) {
  return <Button {...rest} variant={variant} className={["btn-icon", className].filter(Boolean).join(" ")} aria-label={label} title={label} icon={icon} />;
}
