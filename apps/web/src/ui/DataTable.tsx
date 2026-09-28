import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Columns3, ListFilter, Plus, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { Page } from "../api/client";
import { integer } from "../lib/format";
import { Button, IconButton } from "./Button";
import { Dialog } from "./Dialog";
import { EmptyState, ErrorState, TableSkeleton } from "./States";
import { compareValues, MAX_SORT_LEVELS, useTablePrefs, type SortLevel, type TablePrefs } from "./tablePrefs";

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** Numbers, money and quantities align to the end with tabular digits. */
  numeric?: boolean;
  wrap?: boolean;
  /**
   * The row field this column sorts by. On server-paginated lists it must be one of the endpoint's sortable
   * columns; on whole lists it defaults to `key` when the row has a plain value there. `false` disables sorting.
   */
  sortKey?: string | false;
}

interface Props<T> {
  columns: Column<T>[];
  query: { data?: Page<T> | { items: T[] }; isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown; isFetching?: boolean };
  rowKey: (row: T) => string;
  /** Tertiary row actions (menu / ghost buttons). */
  actions?: (row: T) => ReactNode;
  onRowClick?: (row: T) => void;
  empty: { title: string; body?: string; action?: ReactNode };
  /** True when a search/filter is active: shows "no match" + clear instead of the first-use state. */
  filtered?: boolean;
  onClearFilters?: () => void;
  onPageChange?: (page: number) => void;
  caption: string;
  footer?: ReactNode;
  /**
   * Search, filters or the panel title. The sort and column controls join the end of this bar; without one
   * they sit as two icons in the header row, so they never take a row of their own.
   */
  toolbar?: ReactNode;
  /** Sort + columns owned by the page (needed when the server sorts). Otherwise the table keeps its own. */
  prefs?: TablePrefs;
  /** Storage id for the user's layout; defaults to the caption. */
  tableId?: string;
}

/**
 * The one table used by every list: server pagination, loading skeleton, first-use vs filtered empty,
 * error with retry, and "—" for empty values (handled by the formatters). Each user can sort by up to three
 * columns and choose the columns they see; that layout is theirs only.
 */
export function DataTable<T>(props: Props<T>) {
  const narrow = useNarrow();
  const own = useTablePrefs(props.tableId ?? props.caption);
  const prefs = props.prefs ?? own;
  const { columns, query, rowKey, actions, onRowClick, empty, filtered, onClearFilters, onPageChange, caption, footer, toolbar } = props;
  const data = query.data;
  const paginated = Boolean(data && "meta" in data);
  // A server page can only be sorted by the server; whole lists sort here.
  const canSort = !paginated || prefs.server;

  const sortKeyOf = (c: Column<T>): string | null => {
    if (c.sortKey === false || !canSort) return null;
    if (c.sortKey) return c.sortKey;
    if (prefs.server) return null;
    const first = data?.items[0] as Record<string, unknown> | undefined;
    const v = first?.[c.key];
    return first && (v === null || ["string", "number", "boolean"].includes(typeof v)) ? c.key : null;
  };
  const sortable = columns.map((c) => ({ c, key: sortKeyOf(c) })).filter((x): x is { c: Column<T>; key: string } => x.key !== null);
  // The first column names the row, so it is always shown.
  const visible = columns.filter((c, i) => i === 0 || !prefs.hidden.includes(c.key));
  const sort = prefs.sort.filter((s) => sortable.some((x) => x.key === s.key));

  const rows = useMemo(() => {
    const items = data?.items ?? [];
    if (paginated || !sort.length) return items;
    return [...items].sort((a, b) => {
      for (const s of sort) {
        const va = (a as Record<string, unknown>)[s.key], vb = (b as Record<string, unknown>)[s.key];
        const empty = [va, vb].some((v) => v === null || v === undefined || v === "");
        const r = empty ? compareValues(va, vb) : compareValues(va, vb) * (s.dir === "desc" ? -1 : 1);
        if (r) return r;
      }
      return 0;
    });
  }, [data, paginated, sort]);

  const defaultDir = (key: string) => (sortable.find((x) => x.key === key)?.c.numeric ? "desc" : "asc");
  function onHeader(key: string, add: boolean) {
    const i = sort.findIndex((s) => s.key === key);
    if (add) {
      if (i >= 0) prefs.setSort(sort.map((s) => (s.key === key ? { ...s, dir: s.dir === "asc" ? "desc" : "asc" } : s)));
      else if (sort.length < MAX_SORT_LEVELS) prefs.setSort([...sort, { key, dir: defaultDir(key) }]);
      return;
    }
    if (sort.length === 1 && i === 0) {
      const first = defaultDir(key);
      prefs.setSort(sort[0]!.dir === first ? [{ key, dir: first === "asc" ? "desc" : "asc" }] : []);
    } else prefs.setSort([{ key, dir: defaultDir(key) }]);
  }

  const hasTools = columns.length >= 4;
  const controls = (compact: boolean) => (
    <>
      {sortable.length > 0 && <SortMenu compact={compact} sortable={sortable.map((x) => ({ key: x.key, header: x.c.header, numeric: x.c.numeric }))} sort={sort} onChange={prefs.setSort} />}
      <ColumnsMenu compact={compact} columns={columns} hidden={prefs.hidden} onChange={prefs.setHidden} />
    </>
  );
  const bar = toolbar && <div className="toolbar">{toolbar}{hasTools && <><span className="spacer" />{controls(false)}</>}</div>;
  const inHeader = hasTools && !toolbar;
  const colCount = visible.length + (actions || inHeader ? 1 : 0);

  // Phones: search stays in the bar, every other filter + sort + visible fields move to one bottom sheet.
  const mobileBar = narrow && (
    <MobileBar toolbar={toolbar} filtered={Boolean(filtered)} total={data && "meta" in data ? data.meta.total : data?.items.length}
      onClear={() => { onClearFilters?.(); prefs.setSort([]); }}
      sortEditor={sortable.length > 0 ? <SortEditor sortable={sortable.map((x) => ({ key: x.key, header: x.c.header, numeric: x.c.numeric }))} sort={sort} onChange={prefs.setSort} /> : null}
      sortCount={sort.length}
      columnsEditor={columns.length >= 3 ? <ColumnsEditor columns={columns} hidden={prefs.hidden} onChange={prefs.setHidden} label="الحقول الظاهرة في القائمة" /> : null} />
  );
  if (narrow) {
    if (query.isPending) return <>{mobileBar}<TableSkeleton columns={2} /></>;
    if (query.isError) return <>{mobileBar}<ErrorState error={query.error} onRetry={() => query.refetch()} /></>;
  }
  if (query.isPending) return <>{bar}<TableSkeleton columns={colCount} /></>;
  if (query.isError) return <>{bar}<ErrorState error={query.error} onRetry={() => query.refetch()} /></>;
  const meta = data && "meta" in data ? data.meta : null;

  if (rows.length === 0) {
    return <>{narrow ? mobileBar : bar}{filtered ? (
      <EmptyState kind="filtered" title="لا توجد نتائج مطابقة" action={onClearFilters && <button type="button" className="btn btn-secondary btn-sm" onClick={onClearFilters}>مسح البحث والفلاتر</button>}>
        غيّر كلمات البحث أو امسح الفلاتر لعرض كل السجلات.
      </EmptyState>
    ) : (
      <EmptyState title={empty.title} action={empty.action}>{empty.body}</EmptyState>
    )}</>;
  }

  if (narrow) {
    return (
      <>
        {mobileBar}
        <CardList rows={rows} columns={visible} rowKey={rowKey} actions={actions} onRowClick={onRowClick} caption={caption} busy={query.isFetching} />
        {footer && visible.length === columns.length && <div className="table-wrap"><table className="data-table no-stack dt-card-foot"><tfoot>{footer}</tfoot></table></div>}
        {meta && onPageChange && <Pagination meta={meta} onChange={onPageChange} />}
      </>
    );
  }

  return (
    <>
      {bar}
      <div className="table-wrap" aria-busy={query.isFetching || undefined}>
        <table className="data-table">
          <caption className="sr-only">{caption}{sort.length > 1 ? ". اضغط Shift مع عنوان العمود لإضافته للترتيب" : ""}</caption>
          <thead>
            <tr>
              {visible.map((c) => {
                const key = sortable.find((x) => x.c === c)?.key;
                const level = key ? sort.findIndex((s) => s.key === key) : -1;
                const s = level >= 0 ? sort[level] : undefined;
                return (
                  <th key={c.key} scope="col" className={c.numeric ? "end" : undefined}
                    aria-sort={level === 0 && s ? (s.dir === "asc" ? "ascending" : "descending") : undefined}>
                    {key ? (
                      <button type="button" className={`th-sort${s ? " is-sorted" : ""}`} onClick={(e) => onHeader(key, e.shiftKey)}
                        title="اضغط للترتيب، ومع Shift لإضافة العمود كمستوى ترتيب تالٍ">
                        {c.header}
                        <span className="th-sort-icon" aria-hidden="true">
                          {s ? (s.dir === "asc" ? <ArrowUp /> : <ArrowDown />) : <ArrowUpDown />}
                          {s && sort.length > 1 && <span className="th-sort-level">{level + 1}</span>}
                        </span>
                        {s && <span className="sr-only">، مرتب {s.dir === "asc" ? "تصاعدياً" : "تنازلياً"}{sort.length > 1 ? ` (المستوى ${level + 1})` : ""}</span>}
                      </button>
                    ) : c.header}
                  </th>
                );
              })}
              {inHeader
                ? <th scope="col" className="actions table-tools-cell"><div className="row" style={{ justifyContent: "flex-end", flexWrap: "nowrap", gap: 0 }}>{controls(true)}</div></th>
                : actions && <th scope="col" className="actions"><span className="sr-only">إجراءات</span></th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={rowKey(row)}
                className={onRowClick ? "is-clickable" : undefined}
                onClick={onRowClick ? (e) => { if (!(e.target as HTMLElement).closest("button, a, input, select")) onRowClick(row); } : undefined}
              >
                {visible.map((c) => (
                  <td key={c.key} className={[c.numeric && "end num", c.wrap && "wrap"].filter(Boolean).join(" ") || undefined}>{c.cell(row)}</td>
                ))}
                {actions ? <td className="actions"><div className="row" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>{actions(row)}</div></td> : inHeader && <td className="actions" />}
              </tr>
            ))}
          </tbody>
          {footer && visible.length === columns.length && <tfoot>{footer}</tfoot>}
        </table>
      </div>
      {meta && onPageChange && <Pagination meta={meta} onChange={onPageChange} />}
    </>
  );
}

/** Non-modal panel under a toolbar button: closes on Escape (focus returns to the button) or a click outside. */
function Popover({ label, button, compact, children }: { label: string; button: ReactNode; compact?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties>({ visibility: "hidden" });
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  // Anchored under the button's inline-end edge and kept inside the viewport.
  useLayoutEffect(() => {
    if (!open) { setPos({ visibility: "hidden" }); return; }
    const place = () => {
      const t = trigger.current?.getBoundingClientRect(), p = panel.current?.getBoundingClientRect();
      if (!t || !p) return;
      const rtl = getComputedStyle(trigger.current!).direction === "rtl";
      const left = Math.max(8, Math.min(rtl ? t.left : t.right - p.width, window.innerWidth - p.width - 8));
      const below = t.bottom + 4;
      const top = below + p.height > window.innerHeight - 8 && t.top - p.height - 4 > 8 ? t.top - p.height - 4 : below;
      // Physical left/right only: a logical inset here maps onto `left` in RTL and would cancel it.
      setPos({ position: "fixed", top, left, right: "auto" });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>(".popover-panel select, .popover-panel input, .popover-panel button")?.focus();
    const onDoc = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  return (
    <div className="menu" ref={root} onKeyDown={(e) => { if (e.key === "Escape" && open) { e.stopPropagation(); setOpen(false); trigger.current?.focus(); } }}>
      <button ref={trigger} type="button" className={`btn btn-ghost btn-sm${compact ? " btn-icon" : ""}`} aria-label={compact ? label : undefined} title={compact ? label : undefined}
        aria-haspopup="dialog" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>{button}</button>
      {open && <div ref={panel} className="menu-list popover-panel" role="dialog" id={id} aria-label={label} style={pos}>{children}</div>}
    </div>
  );
}

type Sortable = { key: string; header: string; numeric?: boolean };
function SortMenu({ sortable, sort, onChange, compact }: { sortable: Sortable[]; sort: SortLevel[]; onChange: (s: SortLevel[]) => void; compact?: boolean }) {
  return (
    <Popover label="ترتيب الجدول" compact={compact}
      button={<><ListFilter aria-hidden="true" />{!compact && "ترتيب"}{sort.length > 0 && <span className={`badge badge-info num${compact ? " tool-count" : ""}`}>{integer(sort.length)}</span>}</>}>
      <SortEditor sortable={sortable} sort={sort} onChange={onChange} />
    </Popover>
  );
}

function SortEditor({ sortable, sort, onChange }: { sortable: Sortable[]; sort: SortLevel[]; onChange: (s: SortLevel[]) => void }) {
  const unused = sortable.filter((c) => !sort.some((s) => s.key === c.key));
  const set = (i: number, patch: Partial<SortLevel>) => onChange(sort.map((s, n) => (n === i ? { ...s, ...patch } : s)));
  return (
    <>
      <p className="popover-title">ترتيب حسب</p>
      {sort.length === 0 && <p className="muted popover-note">بلا ترتيب مخصص. اختر عموداً، أو اضغط عنوان أي عمود في الجدول.</p>}
      {sort.map((s, i) => (
        <div key={s.key} className="sort-level">
          <span className="muted num" style={{ fontSize: "var(--fs-xs)", minWidth: 40 }}>{i === 0 ? "أولاً" : "ثم"}</span>
          <select className="select" aria-label={`عمود مستوى الترتيب ${i + 1}`} value={s.key}
            onChange={(e) => set(i, { key: e.target.value })}>
            {sortable.filter((c) => c.key === s.key || !sort.some((x) => x.key === c.key)).map((c) => <option key={c.key} value={c.key}>{c.header}</option>)}
          </select>
          <div className="segmented" role="group" aria-label={`اتجاه مستوى الترتيب ${i + 1}`}>
            <button type="button" aria-pressed={s.dir === "asc"} onClick={() => set(i, { dir: "asc" })}><ArrowUp aria-hidden="true" />تصاعدي</button>
            <button type="button" aria-pressed={s.dir === "desc"} onClick={() => set(i, { dir: "desc" })}><ArrowDown aria-hidden="true" />تنازلي</button>
          </div>
          <IconButton size="sm" label={`حذف مستوى الترتيب ${i + 1}`} icon={<X />} onClick={() => onChange(sort.filter((_, n) => n !== i))} />
        </div>
      ))}
      <div className="row" style={{ marginBlockStart: "var(--sp-2)" }}>
        {sort.length < MAX_SORT_LEVELS && unused.length > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange([...sort, { key: unused[0]!.key, dir: unused[0]!.numeric ? "desc" : "asc" }])}>
            <Plus aria-hidden="true" />{sort.length ? "إضافة مستوى" : "ترتيب حسب عمود"}
          </button>
        )}
        <span className="spacer" />
        {sort.length > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange([])}>مسح الترتيب</button>}
      </div>
    </>
  );
}

function ColumnsMenu<T>({ columns, hidden, onChange, compact }: { columns: Column<T>[]; hidden: string[]; onChange: (h: string[]) => void; compact?: boolean }) {
  const shown = columns.filter((c, i) => i === 0 || !hidden.includes(c.key)).length;
  return (
    <Popover label="الأعمدة الظاهرة" compact={compact}
      button={<><Columns3 aria-hidden="true" />{!compact && <>الأعمدة <span className="muted num">{integer(shown)}/{integer(columns.length)}</span></>}{compact && shown < columns.length && <span className="badge badge-info num tool-count">{integer(columns.length - shown)}</span>}</>}>
      <ColumnsEditor columns={columns} hidden={hidden} onChange={onChange} label="الأعمدة الظاهرة" />
    </Popover>
  );
}

function ColumnsEditor<T>({ columns, hidden, onChange, label }: { columns: Column<T>[]; hidden: string[]; onChange: (h: string[]) => void; label: string }) {
  return (
    <>
      <p className="popover-title">{label}</p>
      <p className="muted popover-note">اختيارك محفوظ لك وحدك ولا يغيّر ما يراه غيرك.</p>
      {columns.map((c, i) => (
        <label key={c.key} className="checkbox">
          <input type="checkbox" checked={i === 0 || !hidden.includes(c.key)} disabled={i === 0}
            onChange={(e) => onChange(e.target.checked ? hidden.filter((h) => h !== c.key) : [...hidden, c.key])} />
          {c.header}{i === 0 && <span className="muted" style={{ fontSize: "var(--fs-xs)" }}> (دائماً)</span>}
        </label>
      ))}
      {hidden.length > 0 && <div className="row" style={{ marginBlockStart: "var(--sp-2)" }}><button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange([])}>إظهار الكل</button></div>}
    </>
  );
}

// ── Phones ───────────────────────────────────────────────────────────────────────

const NARROW = "(max-width: 767px)";
/** True on phones. Tests and old browsers without matchMedia get the table. */
export function useNarrow() {
  const mq = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(NARROW) : null;
  const [narrow, setNarrow] = useState(() => mq?.matches ?? false);
  useEffect(() => {
    if (!mq) return;
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return narrow;
}

/** Controls a page puts in its toolbar that belong in the filter sheet on a phone (search stays in the bar). */
const FILTER_CONTROLS = 'select, .field, .checkbox, [role="group"], .segmented, input[type="date"], button[aria-pressed]';

function MobileBar({ toolbar, filtered, total, onClear, sortEditor, sortCount, columnsEditor }: {
  toolbar?: ReactNode; filtered: boolean; total: number | undefined; onClear: () => void; sortEditor: ReactNode; sortCount: number; columnsEditor: ReactNode;
}) {
  const inline = useRef<HTMLDivElement>(null);
  const [hasFilters, setHasFilters] = useState(false);
  const [open, setOpen] = useState(false);
  // The page's toolbar is rendered twice with the same state: here (search, titles) and in the sheet (filters).
  useLayoutEffect(() => { setHasFilters(Boolean(inline.current?.querySelector(FILTER_CONTROLS))); });
  const showButton = hasFilters || sortEditor !== null || columnsEditor !== null;
  const count = sortCount + (filtered ? 1 : 0);
  if (!toolbar && !showButton) return null;
  return (
    <div className="toolbar dt-mbar">
      {toolbar && <div className="tb-inline" ref={inline}>{toolbar}</div>}
      {showButton && (
        <button type="button" className={`btn btn-secondary dt-filter-btn${count ? " is-active" : ""}`} aria-haspopup="dialog" onClick={() => setOpen(true)}>
          <SlidersHorizontal aria-hidden="true" />{hasFilters ? "فلترة وترتيب" : "ترتيب"}
          {count > 0 && <span className="badge badge-info num">{integer(count)}</span>}
        </button>
      )}
      <Dialog open={open} onClose={() => setOpen(false)} sheet title={hasFilters ? "الفلترة والترتيب" : "الترتيب والحقول"}
        footer={<>
          <Button variant="primary" size="lg" onClick={() => setOpen(false)}>{total !== undefined ? `عرض النتائج (${integer(total)})` : "عرض النتائج"}</Button>
          {count > 0 && <Button variant="ghost" size="lg" onClick={onClear}>مسح الكل</Button>}
        </>}>
        {hasFilters && <section className="dt-sheet-section"><p className="popover-title">الفلاتر</p><div className="tb-sheet">{toolbar}</div></section>}
        {sortEditor && <section className="dt-sheet-section">{sortEditor}</section>}
        {columnsEditor && <section className="dt-sheet-section">{columnsEditor}</section>}
      </Dialog>
    </div>
  );
}

/**
 * The list as cards on a phone: the naming column is the title, the status sits under it, the main amount on the
 * opposite side, and the other visible columns as label/value pairs. No sideways scrolling.
 */
function CardList<T>({ rows, columns, rowKey, actions, onRowClick, caption, busy }: {
  rows: T[]; columns: Column<T>[]; rowKey: (r: T) => string; actions?: (r: T) => ReactNode; onRowClick?: (r: T) => void; caption: string; busy?: boolean;
}) {
  const [title, ...others] = columns;
  const status = others.find((c) => c.header.includes("الحالة"));
  // The amount people scan for: a total/amount/balance column first, otherwise the last numeric one.
  const numeric = others.filter((c) => c.numeric && c !== status);
  const lead = numeric.find((c) => /إجمالي|الإجمالي|المبلغ|القيمة|الرصيد|المبيعات|الصافي|المستحق/.test(c.header)) ?? numeric[numeric.length - 1];
  const fields = others.filter((c) => c !== status && c !== lead);
  return (
    <ul className="dt-cards" aria-label={caption} aria-busy={busy || undefined}>
      {rows.map((row) => (
        <li key={rowKey(row)} className={`dt-card${onRowClick ? " is-clickable" : ""}`}
          onClick={onRowClick ? (e) => { if (!(e.target as HTMLElement).closest("button, a, input, select, label")) onRowClick(row); } : undefined}>
          <div className="dt-card-head">
            <div className="dt-card-title">
              {title && <div className="dt-card-name">{title.cell(row)}</div>}
              {status && <div className="dt-card-status">{status.cell(row)}</div>}
            </div>
            {lead && <div className="dt-card-lead num"><span className="dt-label">{lead.header}</span>{lead.cell(row)}</div>}
          </div>
          {fields.length > 0 && (
            <dl className="dt-card-fields">
              {fields.map((c) => (
                <div key={c.key} className={c.header ? undefined : "is-wide"}>
                  {c.header && <dt>{c.header}</dt>}
                  <dd className={c.numeric ? "num" : undefined}>{c.cell(row)}</dd>
                </div>
              ))}
            </dl>
          )}
          {actions && <div className="dt-card-actions">{actions(row)}</div>}
        </li>
      ))}
    </ul>
  );
}

export function Pagination({ meta, onChange }: { meta: Page<unknown>["meta"]; onChange: (p: number) => void }) {
  const from = meta.total === 0 ? 0 : (meta.page - 1) * meta.pageSize + 1;
  const to = Math.min(meta.total, meta.page * meta.pageSize);
  return (
    <nav className="pagination" aria-label="التنقل بين الصفحات">
      <span role="status">النتائج <span className="num">{integer(from)}–{integer(to)}</span> من <span className="num">{integer(meta.total)}</span></span>
      <span className="spacer" />
      <IconButton size="sm" label="الصفحة السابقة" icon={<ChevronRight />} disabled={meta.page <= 1} onClick={() => onChange(meta.page - 1)} />
      <span>صفحة {integer(meta.page)} من {integer(meta.totalPages)}</span>
      <IconButton size="sm" label="الصفحة التالية" icon={<ChevronLeft />} disabled={meta.page >= meta.totalPages} onClick={() => onChange(meta.page + 1)} />
    </nav>
  );
}
