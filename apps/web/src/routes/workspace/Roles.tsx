import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { AlertTriangle, ArrowRight, ChevronDown, Copy, Lock, Search, ShieldCheck } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { api, ApiError } from "../../api/client";
import type { Permission } from "../../api/types";
import { useTenant } from "../../app/tenant";
import { integer } from "../../lib/format";
import { Button } from "../../ui/Button";
import { focusFirstInvalid, SelectField, TextField } from "../../ui/Field";
import { Badge, PageHeader } from "../../ui/Layout";
import {
  type CatalogModule, type CatalogPage, closeUnder, type Implies, isStandard, modulePerms, moduleCoverage, pagePerms, permissionLabels, permKey, sensitiveIn,
  STANDARD_ACTIONS, STANDARD_LABELS,
} from "../../ui/permissions";
import { EmptyState, ErrorState, FormError, TableSkeleton } from "../../ui/States";
import { ROLE_LABELS } from "../../ui/status";
import { useToast } from "../../ui/Toast";

export interface CustomRole { id: string; name: string; description: string | null; permissions: Permission[]; membersCount: number }
export interface RolesData {
  catalog: CatalogModule[]; permissions: Permission[]; implies: Implies;
  builtin: { key: string; permissions: Permission[] }[]; custom: CustomRole[]; canEdit: boolean; grantable: Permission[];
}
export function useRoles(tenantId: string) {
  return useQuery({ queryKey: ["t", tenantId, "roles"], queryFn: () => api<RolesData>("GET", "/t/roles", { tenant: tenantId }) });
}
export const BUILTIN_HINTS: Record<string, string> = {
  owner: "كل الصلاحيات، ولا يمكن تغييره",
  manager: "كل العمليات عدا الأعضاء والأدوار وإعدادات المنشأة والاشتراك",
  accountant: "الحسابات والمصروفات واعتماد المشتريات وترحيل الجرد والتقارير، ولا يعدّل البيانات الأساسية",
  inventory_clerk: "المواد والموردون وإنشاء المشتريات واستلامها والتحويلات والهدر والعدّ",
  cashier: "البيع وشاشة المطبخ والعملاء",
};

/**
 * A role's permissions as a matrix: one section per module, one row per page, a column per common action (view,
 * add, edit, delete) and the page's own actions (approve, post, receive…) beside them. What an action needs is
 * ticked and locked with it; what the editor may not grant is disabled.
 */
function PermissionMatrix({ catalog, effective, picked, implies, grantable, readOnly, query, onlySelected, onChange }: {
  catalog: CatalogModule[]; effective: Set<Permission>; picked: Set<Permission>; implies: Implies; grantable: Set<Permission>; readOnly: boolean;
  query: string; onlySelected: boolean; onChange: (next: Set<Permission>) => void;
}) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const labels = useMemo(() => permissionLabels(catalog), [catalog]);
  const neededBy = (p: Permission) => [...picked].filter((x) => x !== p && (implies[x] ?? []).includes(p));
  const q = query.trim();
  const pageMatches = (m: CatalogModule, p: CatalogPage) =>
    (!q || m.label.includes(q) || p.label.includes(q) || p.actions.some((a) => a.label.includes(q) || (a.hint ?? "").includes(q)))
    && (!onlySelected || pagePerms(p).some((x) => effective.has(x)));

  const set = (perms: Permission[], on: boolean) => {
    const n = new Set(picked);
    for (const p of perms) { if (on) { if (grantable.has(p)) n.add(p); } else n.delete(p); }
    onChange(n);
  };

  function cell(m: CatalogModule, p: CatalogPage, actionKey: string, compact: boolean) {
    const a = p.actions.find((x) => x.key === actionKey);
    if (!a) return <span className="pm-na" aria-hidden="true">—</span>;
    const key = permKey(p.key, a.key);
    const on = effective.has(key);
    const by = !picked.has(key) && on ? neededBy(key) : [];
    const locked = by.length > 0;
    const cannot = !grantable.has(key) && !on;
    const why = locked ? `مطلوبة لـ: ${by.map((x) => labels[x]).join("، ")}` : cannot ? "لا تملك هذه الصلاحية، فلا يمكنك منحها" : a.hint;
    return (
      <label className={["pm-check", compact && "is-chip", on && "is-on", locked && "is-locked", a.sensitive && "is-sensitive"].filter(Boolean).join(" ")} title={why}>
        <input type="checkbox" checked={on} disabled={readOnly || locked || cannot}
          aria-label={`${m.label} · ${p.label} · ${a.label}${a.sensitive ? " (حساسة)" : ""}${locked ? " (مطلوبة لصلاحية أخرى)" : ""}`}
          onChange={(e) => set([key], e.target.checked)} />
        <span className="pm-box" aria-hidden="true">{locked && <Lock />}</span>
        <span className={compact ? "pm-chip-label" : "pm-mlabel"}>{a.label}</span>
        {a.sensitive && (on || compact) && <AlertTriangle className="pm-warn" aria-hidden="true" />}
      </label>
    );
  }

  const shown = catalog.map((m) => ({ m, pages: m.pages.filter((p) => pageMatches(m, p)) })).filter((x) => x.pages.length > 0);
  if (!shown.length) return <EmptyState kind="filtered" title="لا صفحة مطابقة">{onlySelected ? "لا توجد صلاحيات محددة بعد في هذا البحث." : "جرّب كلمة أخرى."}</EmptyState>;

  return (
    <div className="pm">
      {shown.map(({ m, pages }) => {
        const all = modulePerms(m);
        const count = all.filter((p) => effective.has(p)).length;
        const isClosed = closed.has(m.key) && !q;
        const extraCol = m.pages.some((p) => p.actions.some((a) => !isStandard(a.key)));
        return (
          <section key={m.key} className="pm-module" aria-labelledby={`pm-${m.key}`}>
            <div className="pm-module-head">
              <button type="button" className="pm-toggle" aria-expanded={!isClosed} onClick={() => setClosed((s) => { const n = new Set(s); if (n.has(m.key)) n.delete(m.key); else n.add(m.key); return n; })}>
                <ChevronDown aria-hidden="true" />
                <h3 id={`pm-${m.key}`}>{m.label}</h3>
                <span className="pm-count num">{integer(count)} / {integer(all.length)}</span>
                <span className="pm-bar" aria-hidden="true"><span style={{ width: `${(count / all.length) * 100}%` }} /></span>
              </button>
              {!readOnly && (
                <span className="pm-module-actions">
                  <Button size="sm" variant="ghost" onClick={() => set(all.filter((p) => p.endsWith(".view")), true)}>عرض فقط</Button>
                  <Button size="sm" variant="ghost" onClick={() => set(all, true)}>الكل</Button>
                  <Button size="sm" variant="ghost" onClick={() => set(all, false)}>لا شيء</Button>
                </span>
              )}
            </div>
            {!isClosed && (
              <div className="pm-table" role="table" aria-label={`صلاحيات ${m.label}`}>
                <div className={["pm-row pm-head", extraCol && "has-extra"].filter(Boolean).join(" ")} role="row">
                  <span role="columnheader">الصفحة</span>
                  {STANDARD_ACTIONS.map((a) => {
                    const col = m.pages.filter((p) => p.actions.some((x) => x.key === a)).map((p) => permKey(p.key, a));
                    const allOn = col.length > 0 && col.every((p) => effective.has(p));
                    return (
                      <span key={a} role="columnheader" className="pm-colhead">
                        {readOnly || !col.length ? STANDARD_LABELS[a] : (
                          <button type="button" className="link-button" aria-label={`${allOn ? "إلغاء" : "تحديد"} «${STANDARD_LABELS[a]}» لكل صفحات ${m.label}`} onClick={() => set(col, !allOn)}>{STANDARD_LABELS[a]}</button>
                        )}
                      </span>
                    );
                  })}
                  {extraCol && <span role="columnheader">إجراءات أخرى</span>}
                  <span role="columnheader" className="pm-rowhead-end"><span className="sr-only">الصفحة كاملة</span></span>
                </div>
                {pages.map((p) => {
                  const perms = pagePerms(p);
                  const full = perms.every((x) => effective.has(x));
                  const extras = p.actions.filter((a) => !isStandard(a.key));
                  return (
                    <div key={p.key} className={["pm-row", extraCol && "has-extra", perms.some((x) => effective.has(x)) && "is-any"].filter(Boolean).join(" ")} role="row">
                      <span role="rowheader" className="pm-page">{p.label}</span>
                      {STANDARD_ACTIONS.map((a) => <span key={a} role="cell" className="pm-cell">{cell(m, p, a, false)}</span>)}
                      {extraCol && <span role="cell" className="pm-extras">{extras.length ? extras.map((a) => <span key={a.key}>{cell(m, p, a.key, true)}</span>) : <span className="pm-na" aria-hidden="true">—</span>}</span>}
                      <span role="cell" className="pm-rowhead-end">
                        {!readOnly && <Button size="sm" variant="ghost" aria-label={`${full ? "إلغاء" : "تحديد"} كل صلاحيات ${p.label}`} onClick={() => set(perms, !full)}>{full ? "لا شيء" : "كاملة"}</Button>}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** Create, edit, or look at a role (built-in roles are shown read-only and can be copied). */
export function RoleEditorPage() {
  const { tenantId, writable } = useTenant();
  const { roleId } = useParams({ strict: false }) as { roleId: string };
  const search = useSearch({ strict: false }) as { from?: string };
  const roles = useRoles(tenantId);
  if (roles.isPending) return <div className="page"><TableSkeleton columns={6} rows={10} /></div>;
  if (roles.isError) return <div className="page"><ErrorState error={roles.error} onRetry={() => roles.refetch()} /></div>;
  const d = roles.data;
  const builtinKey = roleId.startsWith("builtin-") ? roleId.slice(8) : null;
  const builtin = builtinKey ? d.builtin.find((b) => b.key === builtinKey) : null;
  const custom = roleId !== "new" && !builtinKey ? d.custom.find((r) => r.id === roleId) : null;
  if (roleId !== "new" && !builtin && !custom) {
    return <div className="page"><EmptyState title="الدور غير موجود" action={<Link to={`/w/${tenantId}/members?tab=roles`} className="btn btn-secondary">الأدوار</Link>}>ربما حُذف. ارجع لقائمة الأدوار.</EmptyState></div>;
  }
  const from = search.from ? (d.builtin.find((b) => `builtin-${b.key}` === search.from)?.permissions ?? d.custom.find((c) => c.id === search.from)?.permissions) : undefined;
  return (
    <RoleEditor key={roleId + (search.from ?? "")} tenantId={tenantId} data={d} readOnly={Boolean(builtin) || !d.canEdit || !writable}
      role={custom ?? null} builtinKey={builtinKey} initial={builtin?.permissions ?? custom?.permissions ?? from ?? []} />
  );
}

function RoleEditor({ tenantId, data, role, builtinKey, initial, readOnly }: {
  tenantId: string; data: RolesData; role: CustomRole | null; builtinKey: string | null; initial: Permission[]; readOnly: boolean;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const form = useRef<HTMLFormElement>(null);
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [picked, setPicked] = useState<Set<Permission>>(() => new Set(initial));
  const [q, setQ] = useState("");
  const [onlySelected, setOnlySelected] = useState(Boolean(builtinKey));
  const [nameErr, setNameErr] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const effective = useMemo(() => closeUnder(picked, data.implies), [picked, data.implies]);
  const grantable = useMemo(() => new Set(data.grantable), [data.grantable]);
  const labels = useMemo(() => permissionLabels(data.catalog), [data.catalog]);
  const coverage = moduleCoverage(data.catalog, effective);
  const sensitive = sensitiveIn(data.catalog, effective);
  const dirty = JSON.stringify([...effective].sort()) !== JSON.stringify([...closeUnder(initial, data.implies)].sort()) || name !== (role?.name ?? "") || description !== (role?.description ?? "");
  const title = builtinKey ? `الدور الجاهز: ${ROLE_LABELS[builtinKey] ?? builtinKey}` : role ? `الدور: ${role.name}` : "دور جديد";
  const templates = [
    ...data.builtin.filter((b) => b.key !== "owner").map((b) => ({ value: `builtin-${b.key}`, label: `${ROLE_LABELS[b.key] ?? b.key} (جاهز)` })),
    ...data.custom.filter((c) => c.id !== role?.id).map((c) => ({ value: c.id, label: c.name })),
  ];

  function startFrom(value: string) {
    const perms = data.builtin.find((b) => `builtin-${b.key}` === value)?.permissions ?? data.custom.find((c) => c.id === value)?.permissions;
    if (perms) setPicked(new Set(perms.filter((p) => grantable.has(p))));
  }

  async function save() {
    if (name.trim().length < 2) { setNameErr("اكتب اسم الدور، حرفان على الأقل"); focusFirstInvalid(form.current); return; }
    if (!effective.size) { setError("اختر صلاحية واحدة على الأقل"); return; }
    setBusy(true); setError(null); setNameErr(null); setMissing([]);
    const body = { name: name.trim(), description: description.trim() || null, permissions: [...effective] };
    try {
      if (role) await api("PATCH", `/t/roles/${role.id}`, { tenant: tenantId, body });
      else await api("POST", "/t/roles", { tenant: tenantId, body });
      await Promise.all([qc.invalidateQueries({ queryKey: ["t", tenantId, "roles"] }), qc.invalidateQueries({ queryKey: ["t", tenantId, "members"] })]);
      toast.success(`تم حفظ الدور ${body.name}`);
      navigate({ to: `/w/${tenantId}/members?tab=roles` });
    } catch (e) {
      if (e instanceof ApiError && e.fieldErrors.name) { setNameErr(e.fieldErrors.name); focusFirstInvalid(form.current); }
      else if (e instanceof ApiError && Array.isArray((e.details as { missing?: string[] } | undefined)?.missing)) { setMissing((e.details as { missing: string[] }).missing); setError(e); }
      else setError(e);
    } finally { setBusy(false); }
  }

  return (
    <form ref={form} className="page pm-page" noValidate onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <PageHeader eyebrow="الأعضاء والصلاحيات" title={title}
        description={builtinKey ? BUILTIN_HINTS[builtinKey] : "اختر لكل صفحة ما يُسمح به: عرض، إضافة، تعديل، حذف، والإجراءات الخاصة بها. الخادم يطبّق كل صلاحية على كل طلب، والتعديل يسري فوراً على من يحمل الدور."}
        actions={<>
          <Link to={`/w/${tenantId}/members?tab=roles`} className="btn btn-ghost"><ArrowRight aria-hidden="true" />الأدوار</Link>
          {builtinKey && builtinKey !== "owner" && data.canEdit && <Link to={`/w/${tenantId}/members/roles/new?from=builtin-${builtinKey}`} className="btn btn-secondary"><Copy aria-hidden="true" />نسخ كدور جديد</Link>}
          {role && data.canEdit && <Link to={`/w/${tenantId}/members/roles/new?from=${role.id}`} className="btn btn-ghost"><Copy aria-hidden="true" />نسخ</Link>}
        </>} />

      {!builtinKey && (
        <section className="panel panel-pad form-section">
          <div className="form-grid">
            <TextField label="اسم الدور" required autoFocus={!role} disabled={readOnly} value={name} onChange={(e) => setName(e.target.value)} error={nameErr} hint="مثل: مشرف وردية، مسؤول مشتريات، محاسب فرع" />
            <TextField label="وصف قصير" optional disabled={readOnly} value={description} onChange={(e) => setDescription(e.target.value)} hint="يظهر عند إسناد الدور لعضو" />
            {!readOnly && templates.length > 0 && (
              <SelectField label="ابدأ من دور" optional value="" onChange={(e) => e.target.value && startFrom(e.target.value)} placeholder="اختر دوراً لنسخ صلاحياته…" options={templates}
                hint="يستبدل التحديد الحالي بصلاحيات الدور المختار" />
            )}
          </div>
          {role && role.membersCount > 0 && <p className="banner banner-info ca-banner">يحمل هذا الدور <strong className="num">{integer(role.membersCount)}</strong> عضو، وسيسري التعديل عليهم في طلبهم التالي.</p>}
          {data.grantable.length < data.permissions.length && !readOnly && <p className="muted acc-small">الصلاحيات التي لا تملكها معطّلة: لا يمنحها إلا المالك.</p>}
        </section>
      )}

      <div className="pm-layout">
        <aside className="panel pm-summary" aria-label="ملخص الدور">
          <div className="pm-summary-head"><ShieldCheck aria-hidden="true" /><strong className="num">{integer(effective.size)}</strong><span className="muted">من {integer(data.permissions.length)} صلاحية</span></div>
          <ul className="pm-cov">
            {coverage.map((c) => (
              <li key={c.key} className={c.count ? "is-any" : undefined}>
                <span>{c.label}</span><span className="num">{integer(c.count)}/{integer(c.total)}</span>
                <span className="pm-bar" aria-hidden="true"><span style={{ width: `${(c.count / c.total) * 100}%` }} /></span>
              </li>
            ))}
          </ul>
          {sensitive.length > 0 && (
            <div className="pm-sensitive" role="note">
              <strong><AlertTriangle aria-hidden="true" /> صلاحيات حساسة ({integer(sensitive.length)})</strong>
              <ul>{sensitive.map((s) => <li key={s}>{s}</li>)}</ul>
            </div>
          )}
        </aside>

        <section className="pm-main" aria-label="الصلاحيات">
          <div className="panel pm-tools">
            <label className="search pm-search"><Search aria-hidden="true" /><input className="input" type="search" placeholder="ابحث عن صفحة أو إجراء: اعتماد، حذف، الهدر…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="بحث في الصلاحيات" /></label>
            <label className="checkbox"><input type="checkbox" checked={onlySelected} onChange={(e) => setOnlySelected(e.target.checked)} />المحدد فقط</label>
            {!readOnly && <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())} disabled={!picked.size}>مسح الكل</Button>}
            <span className="pm-legend muted"><span className="pm-box is-demo" aria-hidden="true"><Lock /></span> مطلوبة لغيرها <AlertTriangle className="pm-warn" aria-hidden="true" /> حساسة</span>
          </div>
          <PermissionMatrix catalog={data.catalog} effective={effective} picked={picked} implies={data.implies} grantable={grantable} readOnly={readOnly}
            query={q} onlySelected={onlySelected} onChange={setPicked} />
        </section>
      </div>

      {!readOnly && (
        <div className="pf-form-foot pm-foot">
          <Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…" disabled={!dirty && Boolean(role)}>{role ? "حفظ التعديلات" : "إنشاء الدور"}</Button>
          <Link to={`/w/${tenantId}/members?tab=roles`} className="btn btn-ghost">إلغاء</Link>
          <span className="spacer" />
          <span className="muted num" aria-live="polite">{integer(effective.size)} صلاحية{sensitive.length ? ` · ${integer(sensitive.length)} حساسة` : ""}</span>
        </div>
      )}
      {(error != null || missing.length > 0) && (
        <div className="pm-error">
          <FormError error={error} />
          {missing.length > 0 && <p className="muted">غير مسموح لك بمنح: {missing.map((m) => labels[m] ?? m).join("، ")}</p>}
        </div>
      )}
      {readOnly && builtinKey && <p className="muted acc-small">الأدوار الجاهزة ثابتة في النظام ومغطاة باختبارات. انسخ أياً منها وعدّله كما تريد.</p>}
      {readOnly && !builtinKey && <p className="muted acc-small"><Badge tone="neutral">للقراءة</Badge> تعديل الأدوار لمن يملك «الأدوار والصلاحيات · إنشاء الأدوار وتعديلها».</p>}
    </form>
  );
}
