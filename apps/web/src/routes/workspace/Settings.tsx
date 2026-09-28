import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { AlertTriangle, CreditCard, Plus, Store, Users } from "lucide-react";
import { useState } from "react";
import { api, ApiError } from "../../api/client";
import { contextKey, useMe } from "../../app/session";
import { useTenant } from "../../app/tenant";
import { day, integer, text } from "../../lib/format";
import { Button } from "../../ui/Button";
import { DataTable } from "../../ui/DataTable";
import { ConfirmDialog, Dialog } from "../../ui/Dialog";
import { SelectField, TextField } from "../../ui/Field";
import { ActionMenu, Badge, PageHeader, StatCard, StatusBadge, type Hue } from "../../ui/Layout";
import { EmptyState, ErrorState, FormError, TableSkeleton } from "../../ui/States";
import { moduleCoverage, sensitiveIn } from "../../ui/permissions";
import { BUILTIN_HINTS, type CustomRole, type RolesData, useRoles } from "./Roles";
import { ROLE_LABELS } from "../../ui/status";
import { useToast } from "../../ui/Toast";

export function SettingsPage() {
  const { tenantId, ctx, can, writable } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const poLimit = ctx.settings.poOwnerApprovalAbove ?? null;
  const [v, setV] = useState({ vat: String(ctx.settings.vatRatePercent), approval: String(ctx.settings.discountApprovalPercent), po: poLimit === null ? "" : String(poLimit) });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const canEdit = can("settings.edit") && writable;
  const poValue = v.po.trim() === "" ? null : Number(v.po);
  const dirty = Number(v.vat) !== ctx.settings.vatRatePercent || Number(v.approval) !== ctx.settings.discountApprovalPercent || poValue !== poLimit;

  async function save() {
    const vat = Number(v.vat); const approval = Number(v.approval);
    if (!(vat >= 0 && vat <= 100)) return setError("نسبة الضريبة بين 0 و100");
    if (!(approval >= 0 && approval <= 100)) return setError("حد الخصم بين 0 و100");
    if (poValue !== null && !(poValue >= 0)) return setError("حد اعتماد أوامر الشراء رقم صفر أو أكبر، أو اتركه فارغاً");
    setBusy(true); setError(null);
    try {
      await api("PATCH", "/t/settings", { tenant: tenantId, body: { vatRatePercent: vat, discountApprovalPercent: approval, poOwnerApprovalAbove: poValue } });
      await qc.invalidateQueries({ queryKey: contextKey(tenantId) });
      toast.success("تم حفظ الإعدادات");
    } catch (e) { setError(e); } finally { setBusy(false); }
  }

  const t = ctx.tenant;
  return (
    <div className="page ca-page-narrow">
      <PageHeader eyebrow="الإعدادات" title="المنشأة والضريبة" description="بيانات المنشأة كما تظهر في الفواتير، وحدود البيع التي يطبقها الخادم على كل طلب." />
      <div className="stats" aria-label="الباقة والاستخدام">
        <StatCard label="الباقة" value={text(ctx.subscription.planName)} icon={<CreditCard />} hue="violet"
          note={<span className="row" style={{ gap: "var(--sp-1)" }}><StatusBadge kind="subscription" value={ctx.subscription.status} /> حتى {day(ctx.subscription.endsAt)}</span>} />
        <StatCard label="الفروع" value={`${integer(ctx.limits.branches.used)} من ${integer(ctx.limits.branches.limit)}`} note="الفروع المستخدمة من حد الباقة" icon={<Store />} hue="indigo" />
        <StatCard label="المستخدمون" value={`${integer(ctx.limits.users.used)} من ${integer(ctx.limits.users.limit)}`} note="المستخدمون من حد الباقة" icon={<Users />} hue="sky" />
      </div>
      <section className="panel" aria-labelledby="org">
        <div className="card-head"><h2 id="org">بيانات المنشأة</h2></div>
        <div className="card-body stack-lg">
          <dl className="dl">
            <dt>الاسم</dt><dd>{t.companyName}</dd>
            <dt>الرقم الضريبي</dt><dd><span className="num">{t.taxId}</span> {t.taxIdVerified ? <Badge tone="success">موثّق</Badge> : <Badge tone="warning">بانتظار التوثيق</Badge>}</dd>
            <dt>المدينة</dt><dd>{text(t.city)}</dd>
          </dl>
          <p className="muted" style={{ fontSize: "var(--fs-xs)" }}>لتعديل الاسم أو الرقم الضريبي أو الترقية تواصل مع إدارة المنصة، لأنهما يظهران في الفواتير المصدرة.</p>
        </div>
      </section>
      <form className="panel" noValidate onSubmit={(e) => { e.preventDefault(); void save(); }} aria-labelledby="sale">
        <div className="card-head"><h2 id="sale">حدود البيع والشراء</h2></div>
        <div className="card-body stack-lg">
          <div className="form-grid">
            <TextField label="نسبة ضريبة القيمة المضافة ٪" numeric required disabled={!canEdit} value={v.vat} onChange={(e) => setV({ ...v, vat: e.target.value })} hint="تُطبق على الطلبات الجديدة فقط." />
            <TextField label="أقصى خصم للكاشير دون موافقة ٪" numeric required disabled={!canEdit} value={v.approval} onChange={(e) => setV({ ...v, approval: e.target.value })} hint="الخصم الأعلى يحتاج مالكاً أو مديراً." />
            <TextField label="أوامر الشراء فوق هذا المبلغ يعتمدها المالك" numeric optional disabled={!canEdit} value={v.po} onChange={(e) => setV({ ...v, po: e.target.value })} hint="الإجمالي شامل الضريبة. اتركه فارغاً ليعتمد كل من له صلاحية الاعتماد بلا حد." />
          </div>
          <FormError error={error} />
          {canEdit && <div className="row" style={{ gap: "var(--sp-3)" }}><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…" disabled={!dirty}>حفظ الإعدادات</Button>{!dirty && <span className="muted" style={{ fontSize: "var(--fs-sm)" }}>لا توجد تغييرات</span>}</div>}
          {!can("settings.edit") && <p className="muted">يعدّلها من يملك صلاحية «تعديل حدود البيع والشراء».</p>}
        </div>
      </form>
    </div>
  );
}

interface Member { userId: string; fullName: string; email: string; role: string; customRoleId: string | null; roleName: string | null; isActive: boolean; createdAt: string }

const ASSIGNABLE = ["manager", "accountant", "inventory_clerk", "cashier"] as const;
const ROLE_HINTS = BUILTIN_HINTS;
/** Built-in roles and custom roles share one select; custom ones are encoded as `custom:<id>`. */
const roleValue = (m: { role: string; customRoleId: string | null }) => (m.role === "custom" ? `custom:${m.customRoleId}` : m.role);
const roleBody = (value: string) => (value.startsWith("custom:") ? { role: "custom", customRoleId: value.slice(7) } : { role: value });
const HUES: Hue[] = ["indigo", "sky", "green", "orange", "violet", "amber"];
/** A stable colour per person, so the same member keeps the same avatar tint on every visit. */
const hueOf = (id: string) => HUES[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length]!;
const initials = (name: string) => name.trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join("");
export const memberRoleLabel = (m: { role: string; roleName?: string | null }) => (m.role === "custom" ? m.roleName ?? "دور مخصص" : ROLE_LABELS[m.role] ?? m.role);

function roleOptions(roles: RolesData | undefined) {
  return [
    ...ASSIGNABLE.map((r) => ({ value: r as string, label: ROLE_LABELS[r] as string })),
    ...(roles?.custom ?? []).map((r) => ({ value: `custom:${r.id}`, label: `${r.name} (مخصص)` })),
  ];
}
function roleHint(value: string, roles: RolesData | undefined) {
  if (!value.startsWith("custom:")) return ROLE_HINTS[value];
  const r = roles?.custom.find((x) => `custom:${x.id}` === value);
  return r ? r.description ?? `${integer(r.permissions.length)} صلاحية` : undefined;
}

export function MembersPage() {
  const { tenantId, can } = useTenant();
  const search = useSearch({ strict: false }) as { tab?: string };
  const navigate = useNavigate();
  const showMembers = can("members.view");
  const showRoles = can("roles.view");
  const tab: "members" | "roles" = (search.tab === "roles" && showRoles) || !showMembers ? "roles" : "members";
  const setTab = (t: "members" | "roles") => navigate({ to: `/w/${tenantId}/members${t === "roles" ? "?tab=roles" : ""}`, replace: true });
  return (
    <div className="page">
      <PageHeader eyebrow="الإعدادات" title="الأعضاء والصلاحيات" description="من يدخل المنشأة، وماذا يرى ويعمل في كل صفحة: عرض، إضافة، تعديل، حذف، واعتماد." />
      <div className="tabs" role="tablist" aria-label="الأعضاء والأدوار">
        {showMembers && <button type="button" role="tab" id="tab-members" aria-controls="panel-members" aria-selected={tab === "members"} className="tab" onClick={() => setTab("members")}>الأعضاء</button>}
        {showRoles && <button type="button" role="tab" id="tab-roles" aria-controls="panel-roles" aria-selected={tab === "roles"} className="tab" onClick={() => setTab("roles")}>الأدوار وصلاحياتها</button>}
      </div>
      {tab === "members"
        ? <div role="tabpanel" id="panel-members" aria-labelledby="tab-members" className="stack-lg"><MembersTab tenantId={tenantId} /></div>
        : <div role="tabpanel" id="panel-roles" aria-labelledby="tab-roles" className="stack-lg"><RolesTab tenantId={tenantId} /></div>}
    </div>
  );
}

function MembersTab({ tenantId }: { tenantId: string }) {
  const { ctx, writable, can } = useTenant();
  const canInvite = can("members.invite") && writable;
  const canChange = can("members.edit") && writable;
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const [inviting, setInviting] = useState(false);
  const [changing, setChanging] = useState<Member | null>(null);
  const [deactivating, setDeactivating] = useState<Member | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ["t", tenantId, "members"], queryFn: () => api<{ items: Member[] }>("GET", "/t/members", { tenant: tenantId }),
    // The role column shows a label built from two fields; sorting uses that same label so the order matches what is read.
    select: (d) => ({ items: d.items.map((m) => ({ ...m, roleLabel: memberRoleLabel(m) })) }),
  });
  const full = ctx.limits.users.limit !== null && ctx.limits.users.used >= ctx.limits.users.limit;
  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: ["t", tenantId, "members"] }), qc.invalidateQueries({ queryKey: ["t", tenantId, "roles"] }), qc.invalidateQueries({ queryKey: contextKey(tenantId) }),
  ]);

  async function update(m: Member, body: { isActive: boolean }, msg: string) {
    setBusy(true); setErr(null);
    try {
      await api("PATCH", `/t/members/${m.userId}`, { tenant: tenantId, body });
      toast.success(msg);
      setDeactivating(null);
      await refresh();
    } catch (e) {
      const text = (e as Error).message;
      if (deactivating) setErr(text); else toast.error(text);
    } finally { setBusy(false); }
  }

  return (
    <>
      <div className="row">
        <p className="muted" style={{ margin: 0 }}>{integer(ctx.limits.users.used)} من {integer(ctx.limits.users.limit)} مستخدمين في باقتك. الإيقاف يسري فوراً على الطلب التالي للعضو.</p>
        <span className="spacer" />
        {canInvite && <Button variant="primary" icon={<Plus />} onClick={() => setInviting(true)} disabled={full} title={full ? "وصلت لحد المستخدمين في باقتك" : undefined}>إضافة عضو</Button>}
      </div>
      {full && <p className="banner banner-warning ca-banner">وصلت لحد المستخدمين في باقتك. أوقف عضواً أو تواصل مع إدارة المنصة للترقية.</p>}
      <section className="panel">
        <DataTable caption="الأعضاء" query={list} rowKey={(m) => m.userId}
          empty={{ title: "لا يوجد أعضاء", body: "" }}
          columns={[
            { key: "name", sortKey: "fullName", header: "الاسم", cell: (m) => (
              <span className="ca-person-cell">
                <span className={`avatar tone-${hueOf(m.userId)}`} aria-hidden="true">{initials(m.fullName)}</span>
                <strong>{m.fullName}{m.userId === me.data?.user.id && <span className="muted"> (أنت)</span>}</strong>
              </span>
            ) },
            { key: "email", sortKey: "email", header: "البريد", cell: (m) => <span dir="ltr">{m.email}</span> },
            { key: "role", sortKey: "roleLabel", header: "الدور", cell: (m) => (
              <span className="row" style={{ gap: "var(--sp-2)" }}>
                {can("roles.view") ? <Link to={`/w/${tenantId}/members/roles/${m.role === "custom" ? m.customRoleId : `builtin-${m.role}`}`} title="عرض صلاحيات الدور">{memberRoleLabel(m)}</Link> : memberRoleLabel(m)}
                {m.role === "custom" && <Badge tone="info">مخصص</Badge>}
              </span>
            ) },
            { key: "since", sortKey: "createdAt", header: "منذ", cell: (m) => day(m.createdAt) },
            { key: "status", sortKey: "isActive", header: "الحالة", cell: (m) => <StatusBadge kind="active" value={m.isActive} /> },
          ]}
          actions={canChange ? (m) => (m.role === "owner" || m.userId === me.data?.user.id ? null : (
            <ActionMenu label={`إجراءات العضو ${m.fullName}`} items={[
              { label: "تغيير الدور…", onSelect: () => setChanging(m) },
              m.isActive
                ? { label: "إيقاف الوصول", danger: true, separated: true, onSelect: () => { setErr(null); setDeactivating(m); } }
                : { label: "إعادة التفعيل", separated: true, onSelect: () => void update(m, { isActive: true }, `تمت إعادة تفعيل ${m.fullName}`) },
            ]} />
          )) : undefined} />
      </section>
      {inviting && <InviteDialog tenantId={tenantId} onClose={() => setInviting(false)} onDone={async (email) => { setInviting(false); toast.success(`تمت إضافة ${email}`); await refresh(); }} />}
      {changing && <ChangeRoleDialog tenantId={tenantId} member={changing} onClose={() => setChanging(null)} onDone={async (label) => { toast.success(`أصبح دور ${changing.fullName}: ${label}`); setChanging(null); await refresh(); }} />}
      <ConfirmDialog open={Boolean(deactivating)} onClose={() => setDeactivating(null)} busy={busy} error={err}
        onConfirm={() => deactivating && void update(deactivating, { isActive: false }, `تم إيقاف وصول ${deactivating.fullName}`)}
        title="إيقاف وصول عضو" confirmLabel={`إيقاف وصول ${deactivating?.fullName ?? ""}`}
        message={<>لن يتمكن <strong>{deactivating?.fullName}</strong> (<span dir="ltr">{deactivating?.email}</span>) من فتح هذه المنشأة بدءاً من طلبه التالي. سجلاته السابقة تبقى كما هي، ويمكن إعادة تفعيله لاحقاً.</>} />
    </>
  );
}

function InviteDialog({ tenantId, onClose, onDone }: { tenantId: string; onClose: () => void; onDone: (email: string) => void }) {
  const roles = useRoles(tenantId);
  const [v, setV] = useState({ email: "", role: "cashier" });
  const [error, setError] = useState<unknown>(null);
  const [emailErr, setEmailErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email.trim())) return setEmailErr("أدخل بريد الموظف الصحيح");
    setBusy(true); setError(null); setEmailErr(null);
    try { await api("POST", "/t/members", { tenant: tenantId, body: { email: v.email.trim(), ...roleBody(v.role) } }); onDone(v.email.trim()); }
    catch (e) { if (e instanceof ApiError && e.code === "user_not_found") setEmailErr(e.message); else setError(e); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} title="إضافة عضو" onSubmit={() => void submit()}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الإضافة…">إضافة العضو</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <p className="muted">يجب أن يكون للموظف حساب مفعّل في مُنَسِّق. اطلب منه التسجيل وتفعيل بريده أولاً، ثم أضفه هنا.</p>
      <TextField label="بريد الموظف" type="email" dir="ltr" required autoFocus value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} error={emailErr} />
      <SelectField label="الدور" required value={v.role} onChange={(e) => setV({ ...v, role: e.target.value })} hint={roleHint(v.role, roles.data)} options={roleOptions(roles.data)} />
      <FormError error={error} />
    </Dialog>
  );
}

function ChangeRoleDialog({ tenantId, member, onClose, onDone }: { tenantId: string; member: Member; onClose: () => void; onDone: (label: string) => void }) {
  const roles = useRoles(tenantId);
  const [value, setValue] = useState(roleValue(member));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const options = roleOptions(roles.data);
  async function submit() {
    if (value === roleValue(member)) return onClose();
    setBusy(true); setError(null);
    try {
      await api("PATCH", `/t/members/${member.userId}`, { tenant: tenantId, body: roleBody(value) });
      onDone(options.find((o) => o.value === value)?.label ?? "");
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} title={`تغيير دور ${member.fullName}`} onSubmit={() => void submit()}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">حفظ الدور</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <p className="muted">الدور الحالي: <strong>{memberRoleLabel(member)}</strong>. يسري التغيير على الطلب التالي للعضو.</p>
      <SelectField label="الدور الجديد" required value={value} onChange={(e) => setValue(e.target.value)} hint={roleHint(value, roles.data)} options={options} />
      <FormError error={error} />
    </Dialog>
  );
}

function RolesTab({ tenantId }: { tenantId: string }) {
  const { writable } = useTenant();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const roles = useRoles(tenantId);
  const [deleting, setDeleting] = useState<CustomRole | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const canEdit = Boolean(roles.data?.canEdit) && writable;

  async function remove(r: CustomRole) {
    setBusy(true); setErr(null);
    try {
      await api("DELETE", `/t/roles/${r.id}`, { tenant: tenantId });
      toast.success(`تم حذف الدور ${r.name}`);
      setDeleting(null);
      await qc.invalidateQueries({ queryKey: ["t", tenantId, "roles"] });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  if (roles.isPending) return <TableSkeleton columns={4} rows={4} />;
  if (roles.isError) return <ErrorState error={roles.error} onRetry={() => roles.refetch()} />;
  const d = roles.data;
  const total = d.permissions.length;
  /** The modules a role reaches, as compact chips ("المشتريات 8/17"). */
  const reach = (perms: RolesData["custom"][number]["permissions"]) => moduleCoverage(d.catalog, perms).filter((c) => c.count > 0);
  return (
    <>
      <div className="row">
        <p className="muted" style={{ margin: 0 }}>
          {canEdit ? `كل دور يحدد لكل صفحة ما يُسمح به: عرض، إضافة، تعديل، حذف، واعتماد وغيرها (${integer(total)} صلاحية). التعديل يسري فوراً على كل من يحمل الدور.`
            : "يمكنك الاطلاع على صلاحيات الأدوار. إنشاؤها وتعديلها لمن يملك صلاحية «إنشاء الأدوار وتعديلها»."}
        </p>
        <span className="spacer" />
        {canEdit && <Link to={`/w/${tenantId}/members/roles/new`} className="btn btn-primary"><Plus aria-hidden="true" />دور جديد</Link>}
      </div>

      <section className="panel" aria-labelledby="custom-roles">
        <div className="toolbar"><h2 id="custom-roles">أدوار منشأتك</h2></div>
        {d.custom.length === 0 ? (
          <EmptyState title="لا توجد أدوار مخصصة بعد" action={canEdit ? <Link to={`/w/${tenantId}/members/roles/new`} className="btn btn-secondary">إنشاء أول دور</Link> : undefined}>
            مثال: «مشرف وردية» يبيع ويسترجع ويرى تقرير الكاشير فقط، أو «مسؤول مشتريات» ينشئ أوامر الشراء ويستلمها دون اعتمادها أو حذف الموردين.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <caption className="sr-only">أدوار منشأتك</caption>
              <thead><tr><th scope="col">الدور</th><th scope="col">ما يصل إليه</th><th scope="col" className="end">الصلاحيات</th><th scope="col" className="end">الأعضاء</th><th scope="col"><span className="sr-only">إجراءات</span></th></tr></thead>
              <tbody>{d.custom.map((r) => {
                const sens = sensitiveIn(d.catalog, new Set(r.permissions)).length;
                return (
                  <tr key={r.id}>
                    <td><Link to={`/w/${tenantId}/members/roles/${r.id}`}><strong>{r.name}</strong></Link>{r.description && <div className="muted" style={{ fontSize: "var(--fs-xs)" }}>{r.description}</div>}</td>
                    <td><div className="role-perms">{reach(r.permissions).map((c) => <span key={c.key} className="badge badge-neutral">{c.label} <span className="num">{integer(c.count)}/{integer(c.total)}</span></span>)}</div></td>
                    <td className="end num">{integer(r.permissions.length)}{sens > 0 && <div><Badge tone="warning"><AlertTriangle aria-hidden="true" /> {integer(sens)} حساسة</Badge></div>}</td>
                    <td className="end num">{integer(r.membersCount)}</td>
                    <td className="actions">{canEdit && <ActionMenu label={`إجراءات الدور ${r.name}`} items={[
                      { label: "تعديل الصلاحيات", onSelect: () => navigate({ to: `/w/${tenantId}/members/roles/${r.id}` }) },
                      { label: "نسخ كدور جديد", onSelect: () => navigate({ to: `/w/${tenantId}/members/roles/new?from=${r.id}` }) },
                      { label: "حذف الدور", danger: true, separated: true, onSelect: () => { setErr(null); setDeleting(r); } },
                    ]} />}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel" aria-labelledby="builtin-roles">
        <div className="toolbar"><h2 id="builtin-roles">الأدوار الجاهزة</h2><span className="muted" style={{ fontSize: "var(--fs-xs)" }}>ثابتة ولا تُعدّل. اعرض صلاحياتها، أو انسخ أياً منها كنقطة بداية.</span></div>
        <div className="table-wrap">
          <table className="data-table">
            <caption className="sr-only">الأدوار الجاهزة</caption>
            <thead><tr><th scope="col">الدور</th><th scope="col">ما يصل إليه</th><th scope="col" className="end">الصلاحيات</th><th scope="col"><span className="sr-only">إجراءات</span></th></tr></thead>
            <tbody>{d.builtin.map((b) => (
              <tr key={b.key}>
                <td><Link to={`/w/${tenantId}/members/roles/builtin-${b.key}`}><strong>{ROLE_LABELS[b.key] ?? b.key}</strong></Link><div className="muted" style={{ fontSize: "var(--fs-xs)" }}>{ROLE_HINTS[b.key]}</div></td>
                <td><div className="role-perms">{reach(b.permissions).map((c) => <span key={c.key} className="badge badge-neutral">{c.label} <span className="num">{integer(c.count)}/{integer(c.total)}</span></span>)}</div></td>
                <td className="end num">{integer(b.permissions.length)}</td>
                <td className="actions">{canEdit && b.key !== "owner" && <Link to={`/w/${tenantId}/members/roles/new?from=builtin-${b.key}`} className="btn btn-ghost btn-sm">نسخ كدور جديد</Link>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </section>

      <ConfirmDialog open={Boolean(deleting)} onClose={() => setDeleting(null)} busy={busy} error={err}
        onConfirm={() => deleting && void remove(deleting)} title={`حذف الدور ${deleting?.name ?? ""}`} confirmLabel="حذف الدور"
        message={deleting && deleting.membersCount > 0
          ? <>الدور مُسند إلى <strong className="num">{integer(deleting.membersCount)}</strong> عضو. غيّر أدوارهم من تبويب الأعضاء أولاً، ثم احذفه.</>
          : <>سيُحذف الدور <strong>{deleting?.name}</strong>. لا يحمله أي عضو حالياً.</>} />
    </>
  );
}
