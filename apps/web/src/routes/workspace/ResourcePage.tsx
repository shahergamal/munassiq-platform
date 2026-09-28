import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError, type Page } from "../../api/client";
import type { Permission } from "../../api/types";
import { useInvalidate, useTenant } from "../../app/tenant";
import { Button } from "../../ui/Button";
import { DataTable, type Column } from "../../ui/DataTable";
import { ConfirmDialog, Dialog } from "../../ui/Dialog";
import { Checkbox, focusFirstInvalid, SelectField, TextField, SearchInput } from "../../ui/Field";
import { ActionMenu, PageHeader } from "../../ui/Layout";
import { FormError } from "../../ui/States";
import { useTablePrefs } from "../../ui/tablePrefs";
import { useToast } from "../../ui/Toast";

export interface FieldDef<V> {
  name: keyof V & string;
  label: string;
  kind?: "text" | "number" | "select" | "checkbox" | "email" | "tel";
  required?: boolean;
  hint?: string;
  options?: { value: string; label: string }[];
  /** Codes, phones, emails and tax numbers read left-to-right inside RTL. */
  ltr?: boolean;
  /** Client-side check that can be decided without the server (format only). */
  validate?: (v: V) => string | null;
  /** Hidden on edit (e.g. nothing yet) or conditional. */
  show?: (v: V, mode: "create" | "edit") => boolean;
}

export interface ResourceConfig<R extends { id: string; isActive: boolean }, V extends Record<string, unknown>> {
  path: string; // "/suppliers"
  queryKey: string;
  eyebrow: string;
  title: string;
  description: string;
  noun: string; // "المورد"
  addLabel: string; // "إضافة مورد"
  searchPlaceholder: string;
  /** The list is sorted on the server: a sortable column names an output alias of crud()'s select as `sortKey`. */
  columns: Column<R>[];
  nameOf: (r: R) => string;
  empty: { title: string; body: string };
  fields: FieldDef<V>[];
  blank: () => V;
  fromRow: (r: R) => V;
  toBody: (v: V) => Record<string, unknown>;
  read: Permission;
  create: Permission;
  edit: Permission;
  remove: Permission;
  headerExtra?: ReactNode;
}

/**
 * One implementation for every simple directory: server search + pagination, active filter, create/edit in a
 * short dialog, deactivate (reversible) before delete, delete confirmed by name with focus on "إلغاء".
 */
export function ResourcePage<R extends { id: string; isActive: boolean }, V extends Record<string, unknown>>({ cfg }: { cfg: ResourceConfig<R, V> }) {
  const { tenantId, can, writable } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [active, setActive] = useState<"" | "true" | "false">("");
  const [page, setPage] = useState(1);
  const prefs = useTablePrefs(cfg.queryKey, { server: true, onSortChange: () => setPage(1) });
  // Send only the levels the table offers: a level saved for a column that no longer sorts (or never did) would
  // otherwise order the list on the server with no indicator and no way to clear it.
  const offered = new Set(cfg.columns.map((c) => c.sortKey).filter((k): k is string => typeof k === "string"));
  const sortParam = prefs.sort.filter((s) => offered.has(s.key)).map((s) => `${s.key}:${s.dir}`).join(",") || undefined;
  const [editing, setEditing] = useState<{ mode: "create" | "edit"; id?: string; values: V } | null>(null);
  const [deleting, setDeleting] = useState<R | null>(null);
  const [delBusy, setDelBusy] = useState(false);
  const [delError, setDelError] = useState<string | null>(null);

  useEffect(() => { const t = setTimeout(() => { setDebounced(q.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);

  const list = useQuery({
    queryKey: ["t", tenantId, cfg.queryKey, { q: debounced, active, page, sort: sortParam }],
    queryFn: ({ signal }) => api<Page<R>>("GET", cfg.path, { tenant: tenantId, signal, query: { q: debounced, isActive: active, page, pageSize: 25, sort: sortParam } }),
    placeholderData: keepPreviousData,
  });

  const canCreate = can(cfg.create) && writable;
  const canEdit = can(cfg.edit) && writable;
  const canDelete = can(cfg.remove) && writable;
  const filtered = Boolean(debounced || active);

  async function toggleActive(r: R) {
    try {
      await api("PATCH", `${cfg.path}/${r.id}`, { tenant: tenantId, body: { isActive: !r.isActive } });
      toast.success(r.isActive ? `تم إيقاف ${cfg.noun} «${cfg.nameOf(r)}»` : `تم تفعيل ${cfg.noun} «${cfg.nameOf(r)}»`);
      await invalidate(cfg.queryKey);
    } catch (err) { toast.error((err as Error).message); }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setDelBusy(true); setDelError(null);
    try {
      await api("DELETE", `${cfg.path}/${deleting.id}`, { tenant: tenantId });
      toast.success(`تم حذف ${cfg.noun} «${cfg.nameOf(deleting)}»`);
      setDeleting(null);
      await invalidate(cfg.queryKey);
    } catch (err) {
      setDelError(err instanceof ApiError && err.code === "reference_conflict"
        ? `لا يمكن حذف ${cfg.noun} لأنه مستخدم في سجلات أخرى. أوقفه بدلاً من الحذف ليختفي من الاختيارات مع بقاء السجلات.`
        : (err as Error).message);
    } finally { setDelBusy(false); }
  }

  return (
    <div className="page">
      <PageHeader eyebrow={cfg.eyebrow} title={cfg.title} description={cfg.description}
        actions={<>{cfg.headerExtra}{canCreate && <Button variant="primary" icon={<Plus />} onClick={() => setEditing({ mode: "create", values: cfg.blank() })}>{cfg.addLabel}</Button>}</>} />
      <section className="panel" aria-label={cfg.title}>
        <DataTable
          caption={cfg.title}
          prefs={prefs}
          toolbar={<>
          <SearchInput placeholder={cfg.searchPlaceholder} value={q} onChange={setQ} />
          <label className="row">
            <span className="field-label">الحالة</span>
            <select className="select" value={active} onChange={(e) => { setActive(e.target.value as typeof active); setPage(1); }}>
              <option value="">الكل</option><option value="true">النشطة</option><option value="false">الموقوفة</option>
            </select>
          </label>
          </>}
          columns={cfg.columns}
          query={list}
          rowKey={(r) => r.id}
          filtered={filtered}
          onClearFilters={() => { setQ(""); setActive(""); }}
          onPageChange={setPage}
          onRowClick={canEdit ? (r) => setEditing({ mode: "edit", id: r.id, values: cfg.fromRow(r) }) : undefined}
          empty={{ ...cfg.empty, action: canCreate ? <Button variant="primary" icon={<Plus />} onClick={() => setEditing({ mode: "create", values: cfg.blank() })}>{cfg.addLabel}</Button> : undefined }}
          actions={canEdit || canDelete ? (r) => (
            <ActionMenu label={`إجراءات ${cfg.noun} ${cfg.nameOf(r)}`} items={[
              ...(canEdit ? [{ label: "تعديل", onSelect: () => setEditing({ mode: "edit", id: r.id, values: cfg.fromRow(r) }) },
                { label: r.isActive ? "إيقاف" : "تفعيل", onSelect: () => void toggleActive(r) }] : []),
              ...(canDelete ? [{ label: "حذف", danger: true, separated: canEdit, onSelect: () => { setDelError(null); setDeleting(r); } }] : []),
            ]} />
          ) : undefined}
        />
      </section>

      {editing && (
        <ResourceForm cfg={cfg} tenantId={tenantId} state={editing} onClose={() => setEditing(null)}
          onSaved={async (msg) => { setEditing(null); toast.success(msg); await invalidate(cfg.queryKey); }} />
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={() => void confirmDelete()}
        title={`حذف ${cfg.noun}`}
        message={<>سيُحذف {cfg.noun} <strong>«{deleting ? cfg.nameOf(deleting) : ""}»</strong> نهائياً ولا يمكن التراجع. إذا أردت إخفاءه فقط فاستخدم «إيقاف».</>}
        confirmLabel={`حذف ${cfg.noun} نهائياً`}
        busy={delBusy}
        error={delError}
      />
    </div>
  );
}

function ResourceForm<R extends { id: string; isActive: boolean }, V extends Record<string, unknown>>({ cfg, tenantId, state, onClose, onSaved }: {
  cfg: ResourceConfig<R, V>; tenantId: string; state: { mode: "create" | "edit"; id?: string; values: V }; onClose: () => void; onSaved: (msg: string) => void;
}) {
  const form = useRef<HTMLFormElement>(null);
  const [v, setV] = useState<V>(state.values);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const visible = cfg.fields.filter((f) => !f.show || f.show(v, state.mode));

  async function submit() {
    const e: Record<string, string> = {};
    for (const f of visible) {
      const val = v[f.name];
      if (f.required && (val === "" || val === null || val === undefined)) e[f.name] = `أدخل ${f.label}`;
      const custom = f.validate?.(v);
      if (!e[f.name] && custom) e[f.name] = custom;
    }
    setErrors(e);
    if (Object.keys(e).length) return focusFirstInvalid(form.current);
    setBusy(true); setError(null);
    try {
      if (state.mode === "create") await api("POST", cfg.path, { tenant: tenantId, body: cfg.toBody(v) });
      else await api("PATCH", `${cfg.path}/${state.id}`, { tenant: tenantId, body: cfg.toBody(v) });
      onSaved(state.mode === "create" ? `تمت إضافة ${cfg.noun} «${String(v["name"] ?? "")}»` : `تم حفظ تعديلات ${cfg.noun}`);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === "duplicate") setErrors({ code: "هذا الرمز مستخدم لسجل آخر. اختر رمزاً مختلفاً" });
        else setErrors(err.fieldErrors);
        focusFirstInvalid(form.current);
      }
      setError(err);
    } finally { setBusy(false); }
  }

  return (
    <Dialog open onClose={onClose} busy={busy} formRef={form} onSubmit={() => void submit()}
      title={state.mode === "create" ? cfg.addLabel : `تعديل ${cfg.noun}`}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">{state.mode === "create" ? `حفظ ${cfg.noun}` : "حفظ التعديلات"}</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <div className="form-grid">
        {visible.map((f) => {
          const common = { label: f.label, required: f.required, optional: !f.required && f.kind !== "checkbox", hint: f.hint, error: errors[f.name] };
          const raw = v[f.name];
          if (f.kind === "checkbox") return <Checkbox key={f.name} label={f.label} checked={Boolean(raw)} onChange={(e) => setV({ ...v, [f.name]: e.target.checked })} />;
          if (f.kind === "select") return <SelectField key={f.name} {...common} value={String(raw ?? "")} options={f.options ?? []} placeholder={f.required ? undefined : "—"} onChange={(e) => setV({ ...v, [f.name]: e.target.value })} />;
          return (
            <TextField key={f.name} {...common} type={f.kind === "number" ? "text" : f.kind ?? "text"} numeric={f.kind === "number"} dir={f.ltr ? "ltr" : undefined}
              value={String(raw ?? "")} onChange={(e) => setV({ ...v, [f.name]: e.target.value })} />
          );
        })}
      </div>
      <FormError error={error} />
    </Dialog>
  );
}
