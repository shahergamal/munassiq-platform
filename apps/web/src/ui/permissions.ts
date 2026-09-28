import type { Permission } from "../api/types";

/** The permission tree as the server sends it (GET /t/roles, GET /admin/roles): module → page → action. */
export interface CatalogAction { key: string; label: string; hint?: string; sensitive?: boolean }
export interface CatalogPage { key: string; label: string; actions: CatalogAction[] }
export interface CatalogModule { key: string; label: string; pages: CatalogPage[] }
export type Implies = Partial<Record<Permission, Permission[]>>;

/** The four actions most pages share get their own columns; anything else (approve, post, receive…) is listed per page. */
export const STANDARD_ACTIONS = ["view", "create", "edit", "delete"] as const;
export const STANDARD_LABELS: Record<(typeof STANDARD_ACTIONS)[number], string> = { view: "عرض", create: "إضافة", edit: "تعديل", delete: "حذف" };
export const isStandard = (a: string): a is (typeof STANDARD_ACTIONS)[number] => (STANDARD_ACTIONS as readonly string[]).includes(a);

export const permKey = (page: string, action: string) => `${page}.${action}` as Permission;
export const pagePerms = (p: CatalogPage) => p.actions.map((a) => permKey(p.key, a.key));
export const modulePerms = (m: CatalogModule) => m.pages.flatMap(pagePerms);

/** "المواد الخام · حذف" for every permission, for lists and messages outside the editor. */
export function permissionLabels(catalog: readonly CatalogModule[]): Record<string, string> {
  return Object.fromEntries(catalog.flatMap((m) => m.pages.flatMap((p) => p.actions.map((a) => [permKey(p.key, a.key), `${p.label} · ${a.label}`]))));
}

/** Mirror of the server's closure: what is picked, plus what each pick needs to work. */
export function closeUnder(picked: Iterable<Permission>, implies: Implies): Set<Permission> {
  const out = new Set<Permission>();
  const add = (p: Permission) => { if (out.has(p)) return; out.add(p); for (const q of implies[p] ?? []) add(q); };
  for (const p of picked) add(p);
  return out;
}

/** Per module: how many of its permissions a set holds. */
export function moduleCoverage(catalog: readonly CatalogModule[], perms: ReadonlySet<string> | readonly string[]) {
  const has = (p: string) => (Array.isArray(perms) ? perms.includes(p) : (perms as ReadonlySet<string>).has(p));
  return catalog.map((m) => {
    const all = modulePerms(m);
    return { key: m.key, label: m.label, count: all.filter(has).length, total: all.length };
  });
}

export function sensitiveIn(catalog: readonly CatalogModule[], perms: ReadonlySet<string>) {
  return catalog.flatMap((m) => m.pages.flatMap((p) => p.actions.filter((a) => a.sensitive && perms.has(permKey(p.key, a.key))).map((a) => `${p.label} · ${a.label}`)));
}
