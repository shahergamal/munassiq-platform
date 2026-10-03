import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { HardHat, Plus, ShieldAlert, Trash2, Wallet } from "lucide-react";
import { useState } from "react";
import { api, errorMessage, type Page } from "../../api/client";
import type { Supplier } from "../../api/types";
import { useIdempotencyKey } from "../../app/session";
import { useInvalidate, useTenant } from "../../app/tenant";
import { day, integer, isoDay, money, text } from "../../lib/format";
import { Button, IconButton } from "../../ui/Button";
import { DataTable } from "../../ui/DataTable";
import { ConfirmDialog, Dialog } from "../../ui/Dialog";
import { SelectField, TextAreaField, TextField } from "../../ui/Field";
import { ActionMenu, Badge, PageHeader, StatCard } from "../../ui/Layout";
import { FormError } from "../../ui/States";
import { useToast } from "../../ui/Toast";
import { StatusTabs } from "./Inventory";

// Contracting C4: subcontractor qualification, the retention aging, and the dialogs the contract and IPC pages use
// for subcontracts (advance paid, retention release, set-off deductions, recording the subcontractor's invoice).
// Every amount is computed and checked by the server.

const num = (s: string) => Number(s.replace(/,/g, ""));
const Ref = ({ children }: { children: string }) => <bdi dir="ltr" className="num">{children}</bdi>;
const expiring = (d: string | null, today: string) => {
  if (!d) return null;
  const days = Math.round((Date.parse(d) - Date.parse(today)) / 86_400_000);
  return days < 0 ? <Badge tone="danger">منتهٍ</Badge> : days <= 60 ? <Badge tone="warning">بعد {integer(days)} يوماً</Badge> : null;
};

// ── Subcontractors ────────────────────────────────────────────────────────────────────────────
export interface SubcontractorRow { supplierId: string; code: string; name: string; taxId: string | null; residency: string; crNumber: string | null; classificationField: string | null;
  classificationGrade: string | null; classificationExpiry: string | null; zakatCertExpiry: string | null; gosiCertExpiry: string | null; insuranceExpiry: string | null;
  specialties: string | null; status: "pending" | "approved" | "suspended"; rating: number | null; ratedAt: string | null; notes: string | null; activeContracts: number;
  contractValue: number; retentionHeld: number; nextExpiry: string | null }
export const useSubcontractors = (tenantId: string) =>
  useQuery({ queryKey: ["t", tenantId, "contracting", "subcontractors"], queryFn: () => api<{ today: string; items: SubcontractorRow[] }>("GET", "/t/subcontractors", { tenant: tenantId }) });
const STATUS: Record<string, [string, "warning" | "success" | "danger"]> = { pending: ["بانتظار الاعتماد", "warning"], approved: ["معتمد", "success"], suspended: ["موقوف", "danger"] };

export function SubcontractorsPage() {
  const { tenantId, can, writable } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const q = useSubcontractors(tenantId);
  const [editing, setEditing] = useState<SubcontractorRow | "new" | null>(null);
  const [acting, setActing] = useState<{ s: SubcontractorRow; action: "approve" | "suspend" } | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const items = q.data?.items ?? [];
  const today = q.data?.today ?? isoDay();
  async function act() {
    if (!acting) return;
    if (acting.action === "suspend" && reason.trim().length < 3) return setErr(new Error("اذكر سبب الإيقاف"));
    setBusy(true); setErr(null);
    try {
      await api("POST", `/t/subcontractors/${acting.s.supplierId}/${acting.action}`, { tenant: tenantId, body: acting.action === "suspend" ? { reason } : {} });
      toast.success(acting.action === "approve" ? `اعتُمد ${acting.s.name} مقاول باطن` : `أُوقف ${acting.s.name}`);
      setActing(null);
      await invalidate("contracting");
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <div className="page">
      <PageHeader eyebrow="المقاولات" title="مقاولو الباطن"
        description="التأهيل والتصنيف وشهادات الزكاة والتأمينات والتأمين، وتقييم الأداء. لا يُسند عقد باطن إلا لمقاول معتمد تصنيفه ساري، وغير المقيم يخضع للاحتساب العكسي والاستقطاع."
        actions={can("subcontractors.create") && writable ? <Button variant="primary" icon={<Plus />} onClick={() => setEditing("new")}>تأهيل مقاول باطن</Button> : undefined} />
      <div className="stats">
        <StatCard label="معتمدون" value={q.data ? integer(items.filter((s) => s.status === "approved").length) : "—"} icon={<HardHat />} hue="indigo" />
        <StatCard label="وثائق تنتهي خلال 60 يوماً" value={q.data ? integer(items.filter((s) => s.nextExpiry && Date.parse(s.nextExpiry) - Date.parse(today) <= 60 * 86_400_000).length) : "—"}
          icon={<ShieldAlert />} hue="amber" />
        <StatCard label="محتجزات مقاولي الباطن" value={q.data ? money(items.reduce((a, s) => a + s.retentionHeld, 0)) : "—"} icon={<Wallet />} hue="violet" />
      </div>
      <section className="panel" aria-label="مقاولو الباطن">
        <DataTable caption="مقاولو الباطن" query={q} rowKey={(r) => r.supplierId}
          empty={{ title: "لا مقاولي باطن بعد", body: "أضف المقاول مورداً أولاً (مع حالة إقامته ورقمه الضريبي)، ثم سجّل تأهيله هنا.",
            action: <Link to="/w/$tenantId/suppliers" params={{ tenantId }} className="btn btn-secondary">الموردون</Link> }}
          columns={[
            { key: "name", header: "المقاول", cell: (r) => <span className="stack-tight"><strong>{r.name}</strong><span className="muted acc-small">{r.residency === "non_resident" ? "غير مقيم" : r.taxId ? "مقيم مسجل في الضريبة" : "مقيم غير مسجل"}</span></span> },
            { key: "status", header: "الحالة", cell: (r) => <Badge tone={STATUS[r.status]![1]}>{STATUS[r.status]![0]}</Badge> },
            { key: "classificationField", header: "التصنيف", cell: (r) => r.classificationField ? <span className="stack-tight">{r.classificationField} · {text(r.classificationGrade)}<span className="acc-small">{day(r.classificationExpiry)} {expiring(r.classificationExpiry, today)}</span></span> : "—" },
            { key: "nextExpiry", header: "أقرب وثيقة تنتهي", cell: (r) => <>{day(r.nextExpiry)} {expiring(r.nextExpiry, today)}</> },
            { key: "rating", header: "التقييم", numeric: true, cell: (r) => r.rating ? <span aria-label={`${r.rating} من 5`}>{"★".repeat(r.rating)}<span className="muted">{"★".repeat(5 - r.rating)}</span></span> : "—" },
            { key: "contractValue", header: "العقود", numeric: true, cell: (r) => <span className="stack-tight">{money(r.contractValue)}<span className="muted acc-small">{integer(r.activeContracts)} مفعّل</span></span> },
            { key: "retentionHeld", header: "المحتجز لدينا", numeric: true, cell: (r) => money(r.retentionHeld) },
          ]}
          actions={writable ? (r) => {
            const items = [
              ...(can("subcontractors.edit") ? [{ label: "التأهيل والتقييم", onSelect: () => setEditing(r) }] : []),
              ...(can("subcontractors.approve") && r.status !== "approved" ? [{ label: "اعتماد", onSelect: () => { setErr(null); setActing({ s: r, action: "approve" }); } }] : []),
              ...(can("subcontractors.approve") && r.status === "approved" ? [{ label: "إيقاف", onSelect: () => { setErr(null); setReason(""); setActing({ s: r, action: "suspend" }); }, danger: true, separated: true }] : []),
            ];
            return items.length ? <ActionMenu label={`إجراءات ${r.name}`} items={items} /> : null;
          } : undefined} />
      </section>
      {editing && <ProfileDialog tenantId={tenantId} row={editing === "new" ? null : editing} taken={items.map((s) => s.supplierId)} onClose={() => setEditing(null)} />}
      <ConfirmDialog open={Boolean(acting)} onClose={() => setActing(null)} busy={busy} error={err ? errorMessage(err) : null} onConfirm={() => void act()} destructive={acting?.action === "suspend"}
        title={acting?.action === "approve" ? `اعتماد ${acting.s.name} مقاول باطن؟` : `إيقاف ${acting?.s.name ?? ""}؟`} confirmLabel={acting?.action === "approve" ? "اعتماد" : "إيقاف"}
        message={acting?.action === "approve" ? "راجعت السجل التجاري والتصنيف والشهادات. يمكن بعدها إسناد عقود باطن إليه." : "لا تُفعَّل له عقود باطن جديدة. عقوده الحالية ومستخلصاتها مستمرة."}>
        {acting?.action === "suspend" && <TextField label="السبب" required value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />}
      </ConfirmDialog>
    </div>
  );
}

function ProfileDialog({ tenantId, row, taken, onClose }: { tenantId: string; row: SubcontractorRow | null; taken: string[]; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const suppliers = useQuery({ enabled: !row, queryKey: ["t", tenantId, "suppliers", "options"],
    queryFn: () => api<Page<Supplier>>("GET", "/t/suppliers", { tenant: tenantId, query: { isActive: "true", pageSize: 100 } }) });
  const [v, setV] = useState({ supplierId: row?.supplierId ?? "", crNumber: row?.crNumber ?? "", classificationField: row?.classificationField ?? "", classificationGrade: row?.classificationGrade ?? "",
    classificationExpiry: row?.classificationExpiry ?? "", zakatCertExpiry: row?.zakatCertExpiry ?? "", gosiCertExpiry: row?.gosiCertExpiry ?? "", insuranceExpiry: row?.insuranceExpiry ?? "",
    specialties: row?.specialties ?? "", rating: row?.rating ? String(row.rating) : "", notes: row?.notes ?? "" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  async function submit() {
    if (!v.supplierId) return setError(new Error("اختر المورد"));
    setBusy(true); setError(null);
    const t = (s: string) => s.trim() || null;
    try {
      await api("PUT", `/t/subcontractors/${v.supplierId}`, { tenant: tenantId, body: { crNumber: t(v.crNumber), classificationField: t(v.classificationField),
        classificationGrade: t(v.classificationGrade), classificationExpiry: v.classificationExpiry || null, zakatCertExpiry: v.zakatCertExpiry || null, gosiCertExpiry: v.gosiCertExpiry || null,
        insuranceExpiry: v.insuranceExpiry || null, specialties: t(v.specialties), rating: v.rating ? Number(v.rating) : null, notes: t(v.notes) } });
      toast.success("حُفظ التأهيل");
      await invalidate("contracting");
      onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open wide onClose={onClose} busy={busy} onSubmit={() => void submit()} title={row ? `تأهيل ${row.name}` : "تأهيل مقاول باطن"}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">حفظ التأهيل</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      {!row && <SelectField label="المورد" required placeholder={suppliers.isPending ? "جارٍ التحميل…" : suppliers.isError ? "تعذر تحميل الموردين" : "اختر المورد"} value={v.supplierId} onChange={set("supplierId")}
        hint={suppliers.data && !suppliers.data.items.some((s) => !taken.includes(s.id)) ? "كل الموردين مؤهلون أو لا موردين: أضف المقاول من «الموردون»" : "حالة الإقامة والرقم الضريبي من بطاقة المورد"}
        options={(suppliers.data?.items ?? []).filter((s) => !taken.includes(s.id)).map((s) => ({ value: s.id, label: `${s.name} (${s.code})` }))} />}
      <fieldset className="stack">
        <legend className="acc-small">السجل والتصنيف (مطلوبة للمقيم قبل الاعتماد)</legend>
        <div className="form-grid">
          <TextField label="السجل التجاري" optional dir="ltr" value={v.crNumber} onChange={set("crNumber")} maxLength={30} />
          <TextField label="مجال التصنيف" optional value={v.classificationField} onChange={set("classificationField")} maxLength={120} placeholder="المباني، الكهرباء، الطرق…" />
          <TextField label="الدرجة" optional value={v.classificationGrade} onChange={set("classificationGrade")} maxLength={20} />
          <TextField label="انتهاء التصنيف" optional type="date" dir="ltr" value={v.classificationExpiry} onChange={set("classificationExpiry")} />
        </div>
      </fieldset>
      <fieldset className="stack">
        <legend className="acc-small">الشهادات</legend>
        <div className="form-grid">
          <TextField label="انتهاء شهادة الزكاة" optional type="date" dir="ltr" value={v.zakatCertExpiry} onChange={set("zakatCertExpiry")} />
          <TextField label="انتهاء شهادة التأمينات" optional type="date" dir="ltr" value={v.gosiCertExpiry} onChange={set("gosiCertExpiry")} />
          <TextField label="انتهاء وثيقة التأمين" optional type="date" dir="ltr" value={v.insuranceExpiry} onChange={set("insuranceExpiry")} />
          <SelectField label="تقييم الأداء" placeholder="بلا تقييم" value={v.rating} onChange={set("rating")} options={[5, 4, 3, 2, 1].map((n) => ({ value: String(n), label: `${"★".repeat(n)} (${n})` }))} />
        </div>
        <TextField label="التخصصات" optional value={v.specialties} onChange={set("specialties")} maxLength={300} />
        <TextAreaField label="ملاحظات" optional value={v.notes} onChange={set("notes")} maxLength={1000} />
      </fieldset>
      <FormError error={error} />
    </Dialog>
  );
}

// ── Retention aging ───────────────────────────────────────────────────────────────────────────
interface AgingRow { contractId: string; number: string; title: string; role: string; party: string; project: string; dlpEnd: string | null;
  d0_180: number; d181_365: number; d366_730: number; over730: number; total: number }

export function RetentionPage() {
  const { tenantId } = useTenant();
  const q = useQuery({ queryKey: ["t", tenantId, "contracting", "retention"],
    queryFn: () => api<{ asOf: string; items: AgingRow[]; totals: { receivable: number; payable: number } }>("GET", "/t/contracting/retention", { tenant: tenantId }) });
  const [side, setSide] = useState<"MAIN" | "SUB">("MAIN");
  const rows = (q.data?.items ?? []).filter((r) => r.role === side);
  return (
    <div className="page">
      <PageHeader eyebrow="المقاولات" title="أعمار المحتجزات"
        description="المحتجز لدى العملاء (مدين) والمحتجز من مقاولي الباطن (دائن)، بعمره من نهاية فترة المستخلص. الإفراج يسدد الأقدم أولاً، ويُسجَّل من صفحة العقد." />
      <div className="stats">
        <StatCard label="محتجزات لدى العملاء" value={q.data ? money(q.data.totals.receivable) : "—"} icon={<Wallet />} hue="indigo" />
        <StatCard label="محتجزات مقاولي الباطن" value={q.data ? money(q.data.totals.payable) : "—"} icon={<HardHat />} hue="violet" />
      </div>
      <section className="panel" aria-label="أعمار المحتجزات">
        <div className="toolbar"><StatusTabs value={side} onChange={(v) => setSide(v as "MAIN" | "SUB")} options={[["MAIN", "لدى العملاء"], ["SUB", "لمقاولي الباطن"]]} /></div>
        <DataTable caption={side === "MAIN" ? "محتجزات لدى العملاء" : "محتجزات مقاولي الباطن"} query={{ ...q, data: q.data ? { items: rows } : undefined }} rowKey={(r) => r.contractId}
          empty={{ title: "لا محتجزات قائمة", body: side === "MAIN" ? "تظهر هنا محتجزات المستخلصات المفوترة حتى يفرج عنها العميل." : "تظهر هنا محتجزات مستخلصات مقاولي الباطن المسجلة." }}
          columns={[
            { key: "number", header: "العقد", cell: (r) => <span className="stack-tight"><Link to="/w/$tenantId/contracting/contracts/$contractId" params={{ tenantId, contractId: r.contractId }}><Ref>{r.number}</Ref></Link><span className="muted acc-small">{r.party} · {r.project}</span></span> },
            { key: "d0_180", header: "حتى 6 أشهر", numeric: true, cell: (r) => money(r.d0_180) },
            { key: "d181_365", header: "6–12 شهراً", numeric: true, cell: (r) => money(r.d181_365) },
            { key: "d366_730", header: "1–2 سنة", numeric: true, cell: (r) => money(r.d366_730) },
            { key: "over730", header: "أكثر من سنتين", numeric: true, cell: (r) => money(r.over730) },
            { key: "total", header: "القائم", numeric: true, cell: (r) => <strong>{money(r.total)}</strong> },
            { key: "dlpEnd", header: "نهاية فترة الضمان", cell: (r) => r.dlpEnd ? day(r.dlpEnd) : <span className="muted">بعد الختامي</span> },
          ]} />
      </section>
    </div>
  );
}

// ── Dialogs used by the contract and IPC pages ────────────────────────────────────────────────
export function ReleaseDialog({ tenantId, contractId, role, held, onClose }: { tenantId: string; contractId: string; role: string; held: number; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [key] = useIdempotencyKey();
  const [v, setV] = useState({ amount: String(held), releasedOn: isoDay(), method: "bank_transfer", reason: "" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!(num(v.amount) > 0 && num(v.amount) <= held + 0.001)) return setError(new Error(`المبلغ بين 0 و${money(held)}`));
    if (v.reason.trim().length < 3) return setError(new Error("اذكر سبب الإفراج"));
    setBusy(true); setError(null);
    try {
      await api("POST", `/t/contracts/${contractId}/retention-release`, { tenant: tenantId, idempotencyKey: key,
        body: { amount: num(v.amount), releasedOn: v.releasedOn, reason: v.reason.trim(), ...(role === "MAIN" ? { method: v.method } : {}) } });
      toast.success(role === "MAIN" ? "سُجّل قبض المحتجز من العميل" : "سُجّل الإفراج وصار المبلغ مستحقاً لمقاول الباطن في كشف حسابه");
      await invalidate("contracting");
      onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title="الإفراج عن المحتجزات"
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ التسجيل…">تسجيل الإفراج</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <p className="muted">المحتجز القائم {money(held)}. بلا ضريبة: فُوتر كاملاً مع المستخلصات.{role === "SUB" && " يُضاف لمستحقات مقاول الباطن ويُسدد من «مستحقات الموردين»."}</p>
      <div className="form-grid">
        <TextField label="المبلغ (⃁)" required numeric inputMode="decimal" dir="ltr" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} />
        <TextField label="التاريخ" required type="date" dir="ltr" value={v.releasedOn} onChange={(e) => setV({ ...v, releasedOn: e.target.value })} />
        {role === "MAIN" && <SelectField label="قُبض عبر" required value={v.method} onChange={(e) => setV({ ...v, method: e.target.value })}
          options={[{ value: "bank_transfer", label: "تحويل بنكي" }, { value: "cheque", label: "شيك" }, { value: "cash", label: "نقداً" }]} />}
      </div>
      <TextField label="السبب" required value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} maxLength={300} placeholder="الاستلام الابتدائي، نهاية فترة الضمان…" />
      <FormError error={error} />
    </Dialog>
  );
}

export function SubAdvanceDialog({ tenantId, contractId, left, vatMode, onClose }: { tenantId: string; contractId: string; left: number; vatMode: string; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [key] = useIdempotencyKey();
  const [v, setV] = useState({ amount: String(left), supplierInvoice: "", advanceDate: isoDay() });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!(num(v.amount) > 0 && num(v.amount) <= left + 0.001)) return setError(new Error(`المبلغ بين 0 و${money(left)}`));
    setBusy(true); setError(null);
    try {
      await api("POST", `/t/contracts/${contractId}/subcontract-advance`, { tenant: tenantId, idempotencyKey: key,
        body: { amount: num(v.amount), supplierInvoice: v.supplierInvoice.trim() || null, advanceDate: v.advanceDate } });
      toast.success("سُجّلت الدفعة المقدمة. تُسدد من «مستحقات الموردين» وتُسترد من مستخلصاته بنسبتها.");
      await invalidate("contracting");
      onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title="دفعة مقدمة لمقاول الباطن"
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ التسجيل…">تسجيل الدفعة</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <p className="muted">{vatMode === "reverse" ? "مقاول غير مقيم: لا ضريبة على فاتورته، وتُحتسب علينا بالاحتساب العكسي." : vatMode === "charged" ? "فاتورته تحمل ضريبة القيمة المضافة وتُخصم مدخلات." : "مقاول غير مسجل في الضريبة: بلا ضريبة."}</p>
      <div className="form-grid">
        <TextField label="المبلغ قبل الضريبة (⃁)" required numeric inputMode="decimal" dir="ltr" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} />
        <TextField label="رقم فاتورته" required={vatMode === "charged"} optional={vatMode !== "charged"} dir="ltr" value={v.supplierInvoice} onChange={(e) => setV({ ...v, supplierInvoice: e.target.value })} maxLength={60} />
        <TextField label="التاريخ" required type="date" dir="ltr" value={v.advanceDate} onChange={(e) => setV({ ...v, advanceDate: e.target.value })} />
      </div>
      <FormError error={error} />
    </Dialog>
  );
}

export interface Deduction { id?: string; kind: string; description: string; amount: number }
const DEDUCTION_KIND: Record<string, string> = { damages: "أضرار وتعويضات", other: "أخرى" };
/** Set-off back-charges on a subcontractor IPC; editable until it is approved. */
export function DeductionsPanel({ tenantId, ipcId, items, editable, onSaved }: { tenantId: string; ipcId: string; items: Deduction[]; editable: boolean; onSaved: () => void }) {
  const [rows, setRows] = useState(items.map((d) => ({ kind: d.kind, description: d.description, amount: String(d.amount) })));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const change = (next: typeof rows) => { setRows(next); setDirty(true); };
  async function save() {
    const bad = rows.find((r) => r.description.trim().length < 3 || !(num(r.amount) > 0));
    if (bad) return setError(new Error("لكل خصم وصف ومبلغ موجب"));
    setBusy(true); setError(null);
    try {
      await api("PUT", `/t/ipcs/${ipcId}/deductions`, { tenant: tenantId, body: { items: rows.map((r) => ({ kind: r.kind, description: r.description.trim(), amount: num(r.amount) })) } });
      setDirty(false);
      onSaved();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <section className="panel panel-pad stack" aria-label="الخصومات والمقاصة">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 className="acc-small">الخصومات والمقاصة (تعويضات بلا ضريبة)</h2>
        {editable && <Button size="sm" icon={<Plus />} onClick={() => change([...rows, { kind: "damages", description: "", amount: "" }])}>خصم</Button>}
      </div>
      {rows.length === 0 && <p className="muted">لا خصومات. أضف الأضرار أو التعويضات المتفق على تحميلها عليه. المواد والمعدات التي تورّدها له توريد خاضع للضريبة: أصدر له فاتورة ضريبية بها.</p>}
      {rows.map((r, i) => (
        <div key={i} className="row" style={{ gap: "var(--sp-2)", alignItems: "end", flexWrap: "wrap" }}>
          <SelectField label="النوع" value={r.kind} disabled={!editable} onChange={(e) => change(rows.map((x, j) => (j === i ? { ...x, kind: e.target.value } : x)))}
            options={Object.entries(DEDUCTION_KIND).map(([value, label]) => ({ value, label }))} />
          <TextField label="الوصف" value={r.description} disabled={!editable} maxLength={300} onChange={(e) => change(rows.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
          <TextField label="المبلغ (⃁)" numeric inputMode="decimal" dir="ltr" value={r.amount} disabled={!editable} onChange={(e) => change(rows.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
          {editable && <IconButton label={`حذف الخصم ${i + 1}`} icon={<Trash2 />} onClick={() => change(rows.filter((_, j) => j !== i))} />}
        </div>
      ))}
      {editable && dirty && <div><Button loading={busy} loadingText="جارٍ الحفظ…" onClick={() => void save()}>حفظ الخصومات</Button></div>}
      <FormError error={error} />
    </section>
  );
}

/** Recording the subcontractor's invoice for an approved IPC (its number is the evidence for input VAT). */
export function RecordInvoiceDialog({ tenantId, ipcId, vatMode, net, onClose, onDone }: { tenantId: string; ipcId: string; vatMode: string; net: number; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState({ supplierInvoice: "", supplierInvoiceDate: isoDay() });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (vatMode === "charged" && !v.supplierInvoice.trim()) return setError(new Error("أدخل رقم فاتورته الضريبية"));
    setBusy(true); setError(null);
    try {
      await api("POST", `/t/ipcs/${ipcId}/record`, { tenant: tenantId, body: { supplierInvoice: v.supplierInvoice.trim() || null, supplierInvoiceDate: v.supplierInvoiceDate } });
      onDone();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title="تسجيل فاتورة مقاول الباطن"
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ التسجيل…">تسجيل الفاتورة</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <p className="muted">يُرحَّل قيد التكلفة على المشروع ويُضاف الصافي {money(net)} لمستحقاته، ويُسدد من «مستحقات الموردين»{vatMode === "reverse" ? " مع ضريبة الاستقطاع عند السداد" : ""}.</p>
      <div className="form-grid">
        <TextField label="رقم فاتورته" required={vatMode === "charged"} optional={vatMode !== "charged"} dir="ltr" value={v.supplierInvoice} onChange={(e) => setV({ ...v, supplierInvoice: e.target.value })} maxLength={60} />
        <TextField label="تاريخها" required type="date" dir="ltr" value={v.supplierInvoiceDate} onChange={(e) => setV({ ...v, supplierInvoiceDate: e.target.value })} />
      </div>
      <FormError error={error} />
    </Dialog>
  );
}
