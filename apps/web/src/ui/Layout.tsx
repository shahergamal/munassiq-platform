import { MoreVertical } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { status, type StatusKind, type Tone } from "./status";

/** `eyebrow` is kept for callers but no longer drawn: the top bar path already names the section. */
export function PageHeader({ title, description, actions }: { eyebrow?: string; title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div className="stack" style={{ gap: 0 }}>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </header>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function StatusBadge({ kind, value }: { kind: StatusKind; value: string | boolean | null | undefined }) {
  const s = status(kind, value);
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export type Hue = "indigo" | "sky" | "green" | "amber" | "red" | "violet" | "orange";

export function StatCard({ label, value, note, noteTone, icon, hue = "indigo" }: { label: string; value: ReactNode; note?: ReactNode; noteTone?: "warning"; icon?: ReactNode; hue?: Hue }) {
  return (
    <div className="stat">
      {icon && <span className={`stat-icon tone-${hue}`} aria-hidden="true">{icon}</span>}
      <span className="label">{label}</span>
      <span className="value num" style={{ direction: "rtl" }}>{value}</span>
      {note && <span className={["note", noteTone === "warning" && "is-warning"].filter(Boolean).join(" ")}>{note}</span>}
    </div>
  );
}

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Draws a separator before this item (destructive items go last, after a separator). */
  separated?: boolean;
}

/** Row "more actions" menu: one quiet trigger instead of equal-weight buttons in every row. Keyboard: arrows, Home/End, Escape. */
/**
 * Row / account actions. The list renders in a portal with fixed positioning, so a table's scroll container or a
 * card's overflow never clips it; it opens below the trigger (above when there is no room) and stays on screen.
 */
export function ActionMenu({ label, items, trigger }: { label: string; items: MenuItem[]; /** Replaces the three-dots icon, e.g. an avatar. */ trigger?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const id = useId();

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const place = () => {
      const t = triggerRef.current;
      const m = menu.current;
      if (!t || !m) return;
      const r = t.getBoundingClientRect();
      const w = m.offsetWidth;
      const h = m.offsetHeight;
      const gap = 4;
      const edge = 8;
      // Aligned to the trigger's inline-end edge: its left edge in Arabic, its right edge otherwise.
      const rtl = getComputedStyle(t).direction === "rtl";
      const left = Math.min(Math.max(edge, rtl ? r.left : r.right - w), window.innerWidth - w - edge);
      const below = r.bottom + gap;
      const top = below + h > window.innerHeight - edge && r.top - gap - h >= edge ? r.top - gap - h : Math.min(below, window.innerHeight - h - edge);
      setPos({ top, left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!root.current?.contains(target) && !menu.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  function onKey(e: React.KeyboardEvent) {
    const list = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") { setOpen(false); triggerRef.current?.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); list[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); list[list.length - 1]?.focus(); }
    else if (e.key === "Tab") setOpen(false);
  }

  // Inside a modal <dialog> the list must stay in the dialog's top layer; elsewhere it goes to <body>.
  const host = open ? (triggerRef.current?.closest("dialog") ?? document.body) : null;
  return (
    <div className="menu" ref={root} onKeyDown={onKey}>
      <button ref={triggerRef} type="button" className={trigger ? "menu-trigger" : "btn btn-ghost btn-sm btn-icon"} aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        {trigger ?? <MoreVertical aria-hidden="true" />}
      </button>
      {open && host && createPortal(
        <div ref={menu} className="menu-list is-floating" role="menu" id={id} aria-label={label}
          style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? "visible" : "hidden" }}>
          {items.map((it) => (
            <div key={it.label} role="none" style={{ display: "contents" }}>
              {it.separated && <div className="menu-sep" role="separator" />}
              <button type="button" role="menuitem" disabled={it.disabled} className={["menu-item", it.danger && "is-danger"].filter(Boolean).join(" ")} onClick={() => { setOpen(false); it.onSelect(); }}>
                {it.label}
              </button>
            </div>
          ))}
        </div>,
        host,
      )}
    </div>
  );
}
