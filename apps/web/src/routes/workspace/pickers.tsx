import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { api, type Page } from "../../api/client";
import type { Customer, Ingredient } from "../../api/types";
import { cost, quantity } from "../../lib/format";

/**
 * Searchable ingredient picker (combobox). Searches on the server, so it works with thousands of
 * ingredients (the old UI loaded up to 500 into a dropdown and silently dropped the rest).
 */
export function IngredientPicker({ tenantId, label, onPick, exclude = [], error, locationId, types, placeholder = "اكتب اسم المادة أو رمزها", required }: {
  tenantId: string; label: string; onPick: (i: Ingredient) => void; exclude?: string[]; error?: string | null;
  /** Only these item types ("finished,semi_finished"): a factory's products, or what a BOM may consume. */
  types?: string; placeholder?: string; required?: boolean;
  /** Show (and return) the balance at this location instead of the total across locations. */
  locationId?: string;
}) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  const res = useQuery({
    enabled: open,
    queryKey: ["t", tenantId, "ingredients", { picker: debounced, locationId, types }],
    queryFn: ({ signal }) => api<Page<Ingredient>>("GET", "/t/ingredients", { tenant: tenantId, signal, query: { q: debounced, isActive: "true", pageSize: 12, locationId, type: types } }),
  });
  const items = (res.data?.items ?? []).filter((i) => !exclude.includes(i.id));

  function pick(i: Ingredient) { onPick(i); setQ(""); setOpen(false); setActive(0); }

  return (
    <div className="field" ref={box} style={{ position: "relative" }}>
      <label className="field-label" htmlFor={id}>{label}{required && <span className="req" aria-hidden="true">*</span>}</label>
      <input
        id={id} className="input" role="combobox" aria-expanded={open} aria-controls={`${id}-list`} aria-autocomplete="list"
        aria-activedescendant={open && items[active] ? `${id}-${items[active]!.id}` : undefined} aria-invalid={error ? true : undefined}
        placeholder={placeholder} value={q} aria-required={required || undefined}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }} onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, items.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          else if (e.key === "Enter" && open && items[active]) { e.preventDefault(); pick(items[active]!); }
          else if (e.key === "Escape") setOpen(false);
        }} />
      {error && <span className="field-error" role="alert">{error}</span>}
      {open && (
        <ul id={`${id}-list`} role="listbox" className="menu-list" style={{ insetInlineStart: 0, insetInlineEnd: "auto", width: "100%", maxHeight: 320, overflowY: "auto", margin: 0, listStyle: "none" }}>
          {res.isPending && <li className="menu-item" aria-disabled="true">جارٍ البحث…</li>}
          {res.isError && <li className="menu-item" aria-disabled="true">تعذر البحث. أعد المحاولة.</li>}
          {!res.isPending && !res.isError && items.length === 0 && <li className="menu-item" aria-disabled="true">لا توجد مواد مطابقة{debounced ? ` لـ «${debounced}»` : ""}</li>}
          {items.map((i, n) => (
            <li key={i.id} id={`${id}-${i.id}`} role="option" aria-selected={n === active} className="menu-item"
              style={{ background: n === active ? "var(--muted)" : undefined, justifyContent: "space-between" }}
              onMouseDown={(e) => { e.preventDefault(); pick(i); }} onMouseEnter={() => setActive(n)}>
              <span><strong>{i.name}</strong> <span className="muted num">{i.sku}</span></span>
              <span className="muted" style={{ fontSize: "var(--fs-xs)" }}>{quantity(i.stockQty)} {i.baseUnit} · {i.avgCost ? cost(i.avgCost) : "بلا تكلفة"}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Searchable customer picker (name or phone), searched on the server like the ingredient picker. */
export function CustomerPicker({ tenantId, label, onPick, error, hint, required }: {
  tenantId: string; label: string; onPick: (c: Customer) => void; error?: string | null; hint?: string; required?: boolean;
}) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  const res = useQuery({
    enabled: open,
    queryKey: ["t", tenantId, "customers", { picker: debounced }],
    queryFn: ({ signal }) => api<Page<Customer>>("GET", "/t/customers", { tenant: tenantId, signal, query: { q: debounced, pageSize: 12 } }),
  });
  const items = res.data?.items ?? [];
  function pick(c: Customer) { onPick(c); setQ(""); setOpen(false); setActive(0); }
  return (
    <div className="field" ref={box} style={{ position: "relative" }}>
      <label className="field-label" htmlFor={id}>{label}{required && <span className="req" aria-hidden="true">*</span>}</label>
      <input
        id={id} className="input" role="combobox" aria-expanded={open} aria-controls={`${id}-list`} aria-autocomplete="list" aria-required={required || undefined}
        aria-activedescendant={open && items[active] ? `${id}-${items[active]!.id}` : undefined} aria-invalid={error ? true : undefined}
        aria-describedby={hint ? `${id}-hint` : undefined}
        placeholder="اكتب اسم العميل أو جواله" value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }} onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, items.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          else if (e.key === "Enter" && open && items[active]) { e.preventDefault(); pick(items[active]!); }
          else if (e.key === "Escape") setOpen(false);
        }} />
      {hint && <span className="field-hint" id={`${id}-hint`}>{hint}</span>}
      {error && <span className="field-error" role="alert">{error}</span>}
      {open && (
        <ul id={`${id}-list`} role="listbox" className="menu-list" style={{ insetInlineStart: 0, insetInlineEnd: "auto", width: "100%", maxHeight: 320, overflowY: "auto", margin: 0, listStyle: "none" }}>
          {res.isPending && <li className="menu-item" aria-disabled="true">جارٍ البحث…</li>}
          {res.isError && <li className="menu-item" aria-disabled="true">تعذر البحث. أعد المحاولة.</li>}
          {!res.isPending && !res.isError && items.length === 0 && <li className="menu-item" aria-disabled="true">لا يوجد عملاء مطابقون{debounced ? ` لـ «${debounced}»` : ""}. أضف العميل من صفحة العملاء.</li>}
          {items.map((c, n) => (
            <li key={c.id} id={`${id}-${c.id}`} role="option" aria-selected={n === active} className="menu-item"
              style={{ background: n === active ? "var(--muted)" : undefined, justifyContent: "space-between" }}
              onMouseDown={(e) => { e.preventDefault(); pick(c); }} onMouseEnter={() => setActive(n)}>
              <span><strong>{c.name}</strong> <span className="muted num" dir="ltr">{c.phone}</span></span>
              <span className="muted" style={{ fontSize: "var(--fs-xs)" }}>{c.customerType === "business" ? (c.vatNumber ? `منشأة · ${c.vatNumber}` : "منشأة") : "فرد"}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
