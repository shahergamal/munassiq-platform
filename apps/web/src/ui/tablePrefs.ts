import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { useMe } from "../app/session";

export type SortDir = "asc" | "desc";
export interface SortLevel { key: string; dir: SortDir }
export const MAX_SORT_LEVELS = 3;

export interface TablePrefs {
  sort: SortLevel[];
  setSort: (s: SortLevel[]) => void;
  hidden: string[];
  setHidden: (h: string[]) => void;
  /** `a:asc,b:desc` for list endpoints that sort on the server; undefined when unsorted. */
  sortParam: string | undefined;
  /** True when the page sends `sortParam` to the server (paginated lists). */
  server: boolean;
}

interface Stored { sort: SortLevel[]; hidden: string[] }
const EMPTY: Stored = { sort: [], hidden: [] };

export const prefsKey = ["prefs"] as const;
const SAVE_DELAY_MS = 400;

/**
 * One user's sort and visible columns for one table. The server copy (GET/PUT /auth/prefs) is the source of
 * truth, so the layout follows the user to every device; this browser keeps a copy for an instant first paint
 * and for when the server cannot be reached. Nobody else's layout is affected.
 */
export function useTablePrefs(tableId: string, opts: { server?: boolean; onSortChange?: () => void } = {}): TablePrefs {
  const me = useMe();
  const qc = useQueryClient();
  const userId = me.data?.user.id;
  const prefKey = `table.${tableId}`;
  const storageKey = `mn.table.v1.${userId ?? "anon"}.${tableId}`;
  const remote = useQuery({
    queryKey: [...prefsKey, userId],
    queryFn: () => api<{ items: Record<string, unknown> }>("GET", "/auth/prefs").then((r) => r.items),
    enabled: Boolean(userId), staleTime: Infinity, retry: false,
  });
  const [state, setState] = useState<Stored>(() => read(storageKey));
  const loadedKey = useRef(storageKey);
  const synced = useRef<string | null>(null);
  const pending = useRef<{ key: string; value: Stored } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onSortChange = useRef(opts.onSortChange);
  onSortChange.current = opts.onSortChange;

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    const p = pending.current;
    pending.current = null;
    // A failed save keeps this browser's copy; the next change tries again.
    if (p) void api("PUT", `/auth/prefs/${encodeURIComponent(p.key)}`, { body: p.value }).catch(() => undefined);
  }, []);
  const push = useCallback((value: Stored) => {
    pending.current = { key: prefKey, value };
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_DELAY_MS);
  }, [prefKey, flush]);
  useEffect(() => flush, [flush]);

  // The user id arrives after the first render on a cold load: switch to that user's cached layout.
  useEffect(() => {
    if (loadedKey.current === storageKey) return;
    loadedKey.current = storageKey;
    setState(read(storageKey));
  }, [storageKey]);

  // The server copy wins once it arrives. A layout that exists only in this browser (saved before the
  // server kept preferences) is uploaded once, so it is not lost.
  useEffect(() => {
    if (!remote.data || synced.current === storageKey) return;
    synced.current = storageKey;
    const server = remote.data[prefKey];
    if (server !== undefined) {
      const v = parse(server);
      setState(v);
      writeLocal(storageKey, v);
    } else {
      const local = read(storageKey);
      if (local.sort.length || local.hidden.length) push(local);
    }
  }, [remote.data, storageKey, prefKey, push]);

  const save = useCallback((next: Stored) => {
    setState(next);
    writeLocal(storageKey, next);
    qc.setQueryData<Record<string, unknown>>([...prefsKey, userId], (m) => (m ? { ...m, [prefKey]: next } : m));
    if (userId) push(next);
  }, [storageKey, qc, userId, prefKey, push]);

  return {
    sort: state.sort,
    setSort: (sort) => { save({ ...state, sort: sort.slice(0, MAX_SORT_LEVELS) }); onSortChange.current?.(); },
    hidden: state.hidden,
    setHidden: (hidden) => save({ ...state, hidden }),
    sortParam: state.sort.length ? state.sort.map((x) => `${x.key}:${x.dir}`).join(",") : undefined,
    server: Boolean(opts.server),
  };
}

function writeLocal(key: string, value: Stored) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: keep in memory only */ }
}

function read(key: string): Stored {
  try {
    const raw = localStorage.getItem(key);
    return raw ? parse(JSON.parse(raw)) : EMPTY;
  } catch { return EMPTY; }
}

/** Accepts only a well-formed layout, whatever was stored. */
function parse(raw: unknown): Stored {
  const v = (raw && typeof raw === "object" ? raw : {}) as Partial<Stored>;
  const sort = Array.isArray(v.sort) ? v.sort.filter((x): x is SortLevel => typeof x?.key === "string" && (x.dir === "asc" || x.dir === "desc")) : [];
  const hidden = Array.isArray(v.hidden) ? v.hidden.filter((h): h is string => typeof h === "string") : [];
  return { sort: sort.slice(0, MAX_SORT_LEVELS), hidden };
}
/** Client-side comparison for lists that arrive whole: numbers numerically, text in Arabic order, empty last. */
export function compareValues(a: unknown, b: unknown): number {
  const ea = a === null || a === undefined || a === "", eb = b === null || b === undefined || b === "";
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(b) - Number(a);
  return String(a).localeCompare(String(b), "ar", { numeric: true, sensitivity: "base" });
}
