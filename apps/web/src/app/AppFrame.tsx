import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronDown, CornerDownLeft, LayoutGrid, Menu, Search, UserRound, X, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMe } from "./session";
import { ActionMenu, type MenuItem } from "../ui/Layout";
import { Logo } from "../ui/Logo";

export interface FrameItem { label: string; href: string; icon: LucideIcon; current: boolean }
export interface FrameGroup { label: string; items: FrameItem[] }

interface FrameProps {
  /** Where the logo leads, and what the sidebar calls this area ("مطعم بيت الشاورما" or "إدارة المنصة"). */
  home: string;
  context: ReactNode;
  /** Sections of the sidebar; a section with one item and no label renders as a plain link at the top. */
  groups: FrameGroup[];
  /** Pinned above the user card, like "Settings" in the reference. */
  pinned?: FrameItem[];
  crumbs: string[];
  /** Status chip shown in the top bar before the search (subscription, support session…). */
  status?: ReactNode;
  /** Top-bar tools next to the quick search (the workspace assistant). */
  tools?: ReactNode;
  account: MenuItem[];
  roleLabel?: string;
  banners?: ReactNode;
  storageKey: string;
  /**
   * Phones (< 768px): a blue header replaces the top bar. `mobileHero` fills it on the home page (quick actions, today's
   * figure); elsewhere it shows the page title. `tabbar` is the bottom navigation (absent on full-screen tools).
   */
  mobile?: { pill?: ReactNode; hero?: (a: FrameActions) => ReactNode; tabbar?: (a: FrameActions) => ReactNode };
  children: ReactNode;
}

export interface FrameActions { openMenu: () => void; openSearch: () => void }

/**
 * The one application frame: sidebar on the inline-start side (right in Arabic), a light top bar with the
 * path and quick search, and the page below. The workspace and the platform admin both use it.
 */
export function AppFrame({ home, context, groups, pinned = [], crumbs, status, tools, account, roleLabel, banners, storageKey, mobile, children }: FrameProps) {
  const me = useMe();
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const everything = useMemo(() => [...groups.flatMap((g) => g.items.map((i) => ({ ...i, group: g.label }))), ...pinned.map((i) => ({ ...i, group: "" }))], [groups, pinned]);
  const currentHref = everything.find((i) => i.current)?.href;

  useEffect(() => { setDrawer(false); }, [currentHref]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const name = me.data?.user.fullName ?? "";
  const actions: FrameActions = { openMenu: () => setDrawer(true), openSearch: () => setPalette(true) };
  const tabbar = mobile?.tabbar?.(actions);
  const sidebar = <Sidebar home={home} context={context} groups={groups} pinned={pinned} name={name} roleLabel={roleLabel} storageKey={storageKey} />;

  return (
    <div className={["app-frame", mobile && "has-mhero", tabbar && "has-tabbar"].filter(Boolean).join(" ")}>
      <a href="#main" className="btn btn-primary skip-link">تخطَّ إلى المحتوى</a>
      <aside className="sidebar only-wide" aria-label="التنقل الرئيسي">{sidebar}</aside>
      <Drawer open={drawer} onClose={() => setDrawer(false)}>{sidebar}</Drawer>

      <div className="app-main">
        <header className="topbar">
          <button type="button" className="btn btn-ghost btn-icon only-narrow" aria-label="قائمة الصفحات" onClick={() => setDrawer(true)}><Menu aria-hidden="true" /></button>
          <nav className="crumbs" aria-label="المسار">
            <LayoutGrid aria-hidden="true" />
            {crumbs.map((c, i) => (
              <span key={`${i}-${c}`} className="crumb">
                {i > 0 && <span className="crumb-sep" aria-hidden="true">/</span>}
                {i === crumbs.length - 1 ? <strong aria-current="page">{c}</strong> : <span>{c}</span>}
              </span>
            ))}
          </nav>
          <span className="spacer" />
          {status}
          {tools}
          <button type="button" className="quick-search" onClick={() => setPalette(true)} aria-keyshortcuts="Control+K Meta+K">
            <Search aria-hidden="true" />
            <span className="quick-search-label">ابحث عن صفحة…</span>
            <kbd className="only-wide">Ctrl K</kbd>
          </button>
          <ActionMenu label="قائمة الحساب" items={account} trigger={<span className="avatar" aria-hidden="true">{initials(name) || <UserRound />}</span>} />
        </header>
        {mobile && (
          <header className="m-hero">
            <div className="m-hero-row">
              {!tabbar && <button type="button" className="m-hero-btn" aria-label="قائمة الصفحات" onClick={() => setDrawer(true)}><Menu aria-hidden="true" /></button>}
              <Link to={home} className="m-hero-brand" aria-label="مُنَسِّق: الصفحة الرئيسية"><Logo white height={30} /></Link>
              <span className="spacer" />
              {mobile.pill}
              <button type="button" className="m-hero-btn" aria-label="ابحث عن صفحة" onClick={() => setPalette(true)}><Search aria-hidden="true" /></button>
              <ActionMenu label="قائمة الحساب" items={account} trigger={<span className="m-hero-avatar" aria-hidden="true">{initials(name) || <UserRound />}</span>} />
            </div>
            {mobile.hero ? mobile.hero(actions) : crumbs.length > 2 && <p className="m-hero-title">{crumbs[1]}</p>}
            <span className="m-hero-handle" aria-hidden="true" />
          </header>
        )}
        {banners}
        <main id="main" tabIndex={-1}>{children}</main>
      </div>
      {tabbar}

      <CommandPalette open={palette} onClose={() => setPalette(false)} items={everything} />
    </div>
  );
}

const initials = (name: string) => name.trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join("");

function Sidebar({ home, context, groups, pinned, name, roleLabel, storageKey }: { home: string; context: ReactNode; groups: FrameGroup[]; pinned: FrameItem[]; name: string; roleLabel?: string; storageKey: string }) {
  // Only the section of the current page starts open; the user opens or closes others and that sticks.
  const currentGroup = groups.find((g) => g.label && g.items.some((i) => i.current))?.label;
  const [openGroups, setOpenGroups] = useState<string[]>(() => {
    try { const saved = localStorage.getItem(storageKey); if (saved) return JSON.parse(saved) as string[]; } catch { /* storage blocked */ }
    return currentGroup ? [currentGroup] : [];
  });
  const save = (next: string[]) => { try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* keep in memory */ } return next; };
  useEffect(() => { if (currentGroup) setOpenGroups((o) => (o.includes(currentGroup) ? o : save([...o, currentGroup]))); }, [currentGroup]);
  const toggle = (label: string) => setOpenGroups((o) => save(o.includes(label) ? o.filter((x) => x !== label) : [...o, label]));
  return (
    <div className="sidebar-inner">
      <Link to={home} className="brand" aria-label="مُنَسِّق: الصفحة الرئيسية"><Logo height={40} /></Link>
      <div className="sidebar-context">{context}</div>
      <nav className="side-nav" aria-label="صفحات النظام">
        {groups.map((g) => {
          if (!g.label) return <div key="top" className="side-top">{g.items.map((it) => <SideLink key={it.href} item={it} />)}</div>;
          const open = openGroups.includes(g.label);
          const id = `side-${g.label}`;
          return (
            <section key={g.label} className="side-group">
              <button type="button" className={`side-label${g.items.some((i) => i.current) ? " has-current" : ""}`} aria-expanded={open} aria-controls={id} onClick={() => toggle(g.label)}>
                <span>{g.label}</span><ChevronDown aria-hidden="true" />
              </button>
              {open && <div id={id} className="side-items">{g.items.map((it) => <SideLink key={it.href} item={it} />)}</div>}
            </section>
          );
        })}
      </nav>
      <div className="sidebar-foot">
        {pinned.map((it) => <SideLink key={it.href} item={it} />)}
        <Link to="/account" className="user-card">
          <span className="avatar avatar-lg" aria-hidden="true">{initials(name) || <UserRound />}</span>
          <span className="who"><strong>{name}</strong>{roleLabel && <span>{roleLabel}</span>}</span>
        </Link>
      </div>
    </div>
  );
}

function SideLink({ item }: { item: FrameItem }) {
  return (
    <Link to={item.href} className="side-link" aria-current={item.current ? "page" : undefined}>
      <item.icon aria-hidden="true" />{item.label}
    </Link>
  );
}

/** Narrow screens: the same sidebar slides in from the inline-start edge inside a modal <dialog>. */
function Drawer({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="drawer" aria-label="قائمة الصفحات" onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      {open && <>
        <button type="button" className="btn btn-ghost btn-icon drawer-close" aria-label="إغلاق القائمة" onClick={onClose}><X aria-hidden="true" /></button>
        {children}
      </>}
    </dialog>
  );
}

/** Arabic-insensitive match: alef forms, ta marbuta and alef maqsura compare equal; diacritics ignored. */
const fold = (s: string) => s.replace(/[ً-ْـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").toLowerCase().trim();

function CommandPalette({ open, onClose, items }: { open: boolean; onClose: () => void; items: (FrameItem & { group: string })[] }) {
  const ref = useRef<HTMLDialogElement>(null);
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const results = useMemo(() => {
    const f = fold(q);
    return f ? items.filter((i) => fold(`${i.label} ${i.group}`).includes(f)) : items;
  }, [q, items]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) { setQ(""); setActive(0); d.showModal(); }
    else if (!open && d.open) d.close();
  }, [open]);
  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => { ref.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [active]);

  const go = (i: number) => { const r = results[i]; if (r) { onClose(); navigate({ to: r.href }); } };
  return (
    <dialog ref={ref} className="palette" aria-label="الانتقال السريع" onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      {open && <>
        <div className="palette-input">
          <Search aria-hidden="true" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="اكتب اسم الصفحة، مثل: أوامر الشراء"
            role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={results[active] ? `pal-${active}` : undefined}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
              else if (e.key === "Enter") { e.preventDefault(); go(active); }
            }} />
          <kbd>Esc</kbd>
        </div>
        <ul id="palette-list" role="listbox" className="palette-list" aria-label="الصفحات">
          {results.length === 0 && <li className="palette-empty">لا توجد صفحة بهذا الاسم. جرّب كلمة أخرى.</li>}
          {results.map((r, i) => (
            <li key={r.href} id={`pal-${i}`} data-i={i} role="option" aria-selected={i === active} className="palette-item"
              onMouseEnter={() => setActive(i)} onClick={() => go(i)}>
              <span className="palette-icon"><r.icon aria-hidden="true" /></span>
              <span className="palette-text"><strong>{r.label}</strong>{r.group && <span>{r.group}</span>}</span>
              {i === active && <CornerDownLeft aria-hidden="true" className="palette-enter" />}
            </li>
          ))}
        </ul>
      </>}
    </dialog>
  );
}
