import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BadgeCheck, CalendarClock, ShieldCheck, Wrench } from "lucide-react";
import { useState } from "react";
import { ApiError, api, errorMessage } from "../../api/client";
import { useInvalidate, useTenant } from "../../app/tenant";
import { day, integer, isoDay, money } from "../../lib/format";
import { Button } from "../../ui/Button";
import { DataTable } from "../../ui/DataTable";
import { ConfirmDialog, Dialog } from "../../ui/Dialog";
import { SelectField, TextAreaField, TextField } from "../../ui/Field";
import { Badge, PageHeader, StatCard } from "../../ui/Layout";
import { ErrorState, FormError } from "../../ui/States";
import { useToast } from "../../ui/Toast";
import { StatusTabs } from "./Inventory";

// Contracting C12: handover. On the contract: taking over (starts the DLP and, where it applies, the decennial
// liability), the snag list and the defects reported in the DLP to fixed and verified, final acceptance, and closing
// once retention and guarantees are settled. The register lists every contract after taking over.

interface Item { id: string; number: number; kind: "snag" | "defect"; description: string; location: string | null; reportedOn: string; dueOn: string | null; status: string;
  fixedOn: string | null; verifiedOn: string | null; supplier: string | null; overdue: boolean }
interface HandoverResp { status: string; role: string; dlpMonths: number; decennialApplies: boolean; retentionHeld: number; ipcsInProgress: number;
  activeGuarantees: { id: string; kind: string; number: string; bank: string; amount: number; expiresOn: string }[]; items: Item[];
  handover: null | { takingOverOn: string; takingOverRef: string; dlpMonths: number; dlpEndsOn: string; finalOn: string | null; finalRef: string | null; earlyFinalReason: string | null;
    decennialMonths: number | null; decennialUntil: string | null; decennialBasis: string | null; insurer: string | null; policyNo: string | null; policyUntil: string | null } }
const ITEM_STATUS: Record<string, [string, "warning" | "info" | "success"]> = { open: ["مفتوح", "warning"], fixed: ["أُصلح، بانتظار التحقق", "info"], verified: ["تم التحقق", "success"] };
const GUARANTEE: Record<string, string> = { bid: "ابتدائي", performance: "نهائي (حسن تنفيذ)", advance: "دفعة مقدمة", retention: "بدل محتجز" };
const Ref = ({ children }: { children: string }) => <bdi dir="ltr" className="num">{children}</bdi>;

export function HandoverTab({ contractId }: { contractId: string }) {
  const { tenantId, can, writable } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const q = useQuery({ queryKey: ["t", tenantId, "contracting", "handover", contractId], queryFn: () => api<HandoverResp>("GET", `/t/contracts/${contractId}/handover`, { tenant: tenantId }) });
  const [dialog, setDialog] = useState<"taking" | "item" | "final" | "policy" | "close" | null>(null);
  const [acting, setActing] = useState<{ item: Item; action: "fix" | "verify" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const accept = can("handover.accept") && writable;
  const record = can("handover.record") && writable;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const d = q.data;
  if (!d) return <p className="muted">جارٍ التحميل…</p>;
  const h = d.handover;
  const open = d.items.filter((i) => i.status !== "verified").length;
  async function close() {
    setBusy(true); setErr(null);
    try { await api("POST", `/t/contracts/${contractId}/close`, { tenant: tenantId }); toast.success("أُقفل العقد"); setDialog(null); await invalidate("contracting"); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  }
  if (!h) return (
    <div className="stack">
      <p className="muted">لم يُستلم العقد بعد. الاستلام الابتدائي يبدأ فترة الضمان ({integer(d.dlpMonths)} شهراً في العقد){d.decennialApplies ? " والمسؤولية العشرية عن المبنى" : ""}، وتُسجَّل بعده ملاحظات الاستلام وعيوب فترة الضمان.</p>
      {accept && d.status === "active" && <div><Button variant="primary" icon={<BadgeCheck />} onClick={() => setDialog("taking")}>تسجيل الاستلام الابتدائي</Button></div>}
      {dialog === "taking" && <TakingOverDialog contractId={contractId} onClose={() => setDialog(null)} />}
    </div>
  );
  const blockers = [open ? `${integer(open)} ملاحظة أو عيب لم يُتحقق منه` : null, d.ipcsInProgress ? "مستخلص قيد الإعداد" : null].filter(Boolean);
  return (
    <div className="stack">
      <div className="stats">
        <StatCard label="الاستلام الابتدائي" value={day(h.takingOverOn)} icon={<BadgeCheck />} hue="indigo" note={`شهادة ${h.takingOverRef}`} />
        <StatCard label="نهاية فترة الضمان" value={day(h.dlpEndsOn)} icon={<CalendarClock />} hue={h.finalOn ? "green" : "amber"}
          note={h.finalOn ? `استلام نهائي ${day(h.finalOn)}` : `${integer(h.dlpMonths)} شهراً`} />
        <StatCard label="ملاحظات وعيوب مفتوحة" value={integer(open)} icon={<Wrench />} hue={open ? "red" : "green"} note={`من ${integer(d.items.length)}`} />
        {d.decennialApplies && <StatCard label="المسؤولية العشرية حتى" value={h.decennialUntil ? day(h.decennialUntil) : "—"} icon={<ShieldCheck />} hue="violet"
          note={h.decennialUntil ? (h.policyNo ? `وثيقة ${h.policyNo}${h.insurer ? ` · ${h.insurer}` : ""}` : "بلا وثيقة تأمين مسجلة") : "مدتها لم يوثّقها مدير المنصة بعد"} noteTone={h.decennialUntil ? undefined : "warning"} />}
      </div>
      <div className="toolbar row" style={{ gap: "var(--sp-2)", justifyContent: "end" }}>
        {record && !h.finalOn && <Button onClick={() => setDialog("item")}>ملاحظة أو عيب</Button>}
        {accept && d.decennialApplies && <Button variant="ghost" onClick={() => setDialog("policy")}>وثيقة التأمين العشري</Button>}
        {accept && !h.finalOn && d.status === "active" && <Button variant="primary" icon={<BadgeCheck />} disabled={blockers.length > 0} title={blockers.join("؛ ") || undefined} onClick={() => setDialog("final")}>الاستلام النهائي</Button>}
        {accept && d.status === "completed" && <Button variant="primary" onClick={() => { setErr(null); setDialog("close"); }}>إقفال العقد</Button>}
      </div>
      {h.earlyFinalReason && <p className="muted acc-small">استلام نهائي قبل نهاية الضمان: {h.earlyFinalReason}</p>}
      <DataTable caption="ملاحظات الاستلام وعيوب فترة الضمان" query={{ ...q, data: { items: d.items } }} rowKey={(r) => r.id}
        empty={{ title: "لا ملاحظات ولا عيوب", body: "سجّل ملاحظات الاستلام (قائمة الملاحظات) والعيوب التي تظهر في فترة الضمان، وتابعها حتى إصلاحها والتحقق منها." }}
        columns={[
          { key: "number", header: "رقم", cell: (r) => <span className="stack-tight"><strong className="num">#{r.number}</strong><Badge tone="neutral">{r.kind === "snag" ? "ملاحظة استلام" : "عيب"}</Badge></span> },
          { key: "description", header: "الوصف", wrap: true, cell: (r) => <span className="stack-tight"><span>{r.description}</span><span className="muted acc-small">{[r.location, r.supplier].filter(Boolean).join(" · ")}</span></span> },
          { key: "reportedOn", header: "الإبلاغ والموعد", cell: (r) => <span className="stack-tight"><span>{day(r.reportedOn)}</span>{r.dueOn && <span className="muted acc-small">حتى {day(r.dueOn)}</span>}{r.overdue && <Badge tone="danger">متأخر</Badge>}</span> },
          { key: "status", header: "الحالة", cell: (r) => <span className="stack-tight"><Badge tone={ITEM_STATUS[r.status]![1]}>{ITEM_STATUS[r.status]![0]}</Badge>{r.fixedOn && <span className="muted acc-small">أُصلح {day(r.fixedOn)}</span>}</span> },
        ]}
        actions={record && !h.finalOn ? (r) => r.status === "open" ? <Button size="sm" variant="ghost" onClick={() => setActing({ item: r, action: "fix" })}>تم الإصلاح</Button>
          : r.status === "fixed" ? <Button size="sm" variant="ghost" onClick={() => setActing({ item: r, action: "verify" })}>تحقق</Button> : null : undefined} />
      {(d.activeGuarantees.length > 0 || d.retentionHeld > 0) && <section className="panel panel-pad" aria-label="ما يبقى قبل الإقفال">
        <h3 className="panel-title">ما يبقى قبل إقفال العقد</h3>
        <ul className="stack-tight">
          {d.retentionHeld > 0 && <li>محتجز قائم {money(d.retentionHeld)}: {d.role === "SUB" ? "يُفرج لمقاول الباطن" : "يُطالب به العميل ويُقبض"} من <Link to="/w/$tenantId/contracting/retention" params={{ tenantId }}>المحتجزات</Link>.</li>}
          {d.activeGuarantees.map((g) => <li key={g.id}>ضمان {GUARANTEE[g.kind]} <Ref>{g.number}</Ref> من {g.bank} بمبلغ {money(g.amount)} (ينتهي {day(g.expiresOn)}): يُرد من تبويب «الضمانات».</li>)}
        </ul>
      </section>}
      {dialog === "item" && <ItemDialog contractId={contractId} takingOverOn={h.takingOverOn} onClose={() => setDialog(null)} />}
      {dialog === "final" && <FinalDialog contractId={contractId} dlpEndsOn={h.dlpEndsOn} onClose={() => setDialog(null)} />}
      {dialog === "policy" && <PolicyDialog contractId={contractId} h={h} onClose={() => setDialog(null)} />}
      {acting && <ItemActionDialog {...acting} onClose={() => setActing(null)} />}
      <ConfirmDialog open={dialog === "close"} onClose={() => setDialog(null)} busy={busy} error={err ? errorMessage(err) : null} destructive={false} onConfirm={() => void close()}
        title="إقفال العقد؟" confirmLabel="إقفال العقد" message="يُقفل العقد بعد قبض أو صرف المحتجز كله ورد كل الضمانات وإصدار فاتورة آخر مستخلص. المقفل لا تُسجَّل عليه عمليات." />
    </div>
  );
}

function TakingOverDialog({ contractId, onClose }: { contractId: string; onClose: () => void }) {
  const { tenantId } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [v, setV] = useState({ date: isoDay(), reference: "", notes: "" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true); setError(null);
    try {
      const r = await api<{ dlpEndsOn: string; note: string | null }>("POST", `/t/contracts/${contractId}/taking-over`, { tenant: tenantId, body: { ...v, notes: v.notes || null } });
      toast.success(`سُجّل الاستلام الابتدائي؛ الضمان حتى ${day(r.dlpEndsOn)}${r.note ? `. ${r.note}` : ""}`); await invalidate("contracting"); onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title="الاستلام الابتدائي"
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">تسجيل الاستلام</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <div className="form-grid">
        <TextField label="تاريخ الاستلام" required type="date" dir="ltr" max={isoDay()} value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} />
        <TextField label="رقم شهادة الاستلام" required value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} maxLength={80} />
      </div>
      <TextAreaField label="ملاحظات" optional value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} maxLength={1000} rows={2} />
      <p className="muted acc-small">يبدأ من هذا التاريخ الضمان بمدته في العقد، ويُحسب تاريخ نهايته. لا يُعدَّل بعد تسجيله.</p>
      <FormError error={error} />
    </Dialog>
  );
}

function ItemDialog({ contractId, takingOverOn, onClose }: { contractId: string; takingOverOn: string; onClose: () => void }) {
  const { tenantId } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const suppliers = useQuery({ queryKey: ["t", tenantId, "suppliers", "options"], queryFn: () => api<{ items: { id: string; name: string }[] }>("GET", "/t/suppliers", { tenant: tenantId, query: { isActive: "true", pageSize: 100 } }) });
  const [v, setV] = useState({ kind: "defect", description: "", location: "", reportedOn: isoDay(), dueOn: "", supplierId: "" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true); setError(null);
    try {
      await api("POST", `/t/contracts/${contractId}/handover-items`, { tenant: tenantId, body: { ...v, location: v.location || null, dueOn: v.dueOn || null, supplierId: v.supplierId || null } });
      await invalidate("contracting"); onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title="ملاحظة استلام أو عيب"
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">تسجيل</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <div className="form-grid">
        <SelectField label="النوع" required value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })}
          options={[{ value: "snag", label: "ملاحظة استلام" }, { value: "defect", label: "عيب في فترة الضمان" }]} />
        <TextField label="تاريخ الإبلاغ" required type="date" dir="ltr" min={takingOverOn} max={isoDay()} value={v.reportedOn} onChange={(e) => setV({ ...v, reportedOn: e.target.value })} />
        <TextField label="موعد الإصلاح" optional type="date" dir="ltr" value={v.dueOn} onChange={(e) => setV({ ...v, dueOn: e.target.value })} />
        <TextField label="المكان" optional value={v.location} onChange={(e) => setV({ ...v, location: e.target.value })} maxLength={200} />
      </div>
      <TextAreaField label="الوصف" required value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} maxLength={1000} rows={2} />
      <SelectField label="المسؤول عن الإصلاح" optional value={v.supplierId} onChange={(e) => setV({ ...v, supplierId: e.target.value })} placeholder="فريقنا"
        options={(suppliers.data?.items ?? []).map((s) => ({ value: s.id, label: s.name }))} />
      <FormError error={error} />
    </Dialog>
  );
}

function ItemActionDialog({ item, action, onClose }: { item: Item; action: "fix" | "verify"; onClose: () => void }) {
  const { tenantId } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const [date, setDate] = useState(isoDay());
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true); setError(null);
    try { await api("POST", `/t/handover-items/${item.id}/${action}`, { tenant: tenantId, body: { date } }); await invalidate("contracting"); onClose(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title={action === "fix" ? `إصلاح #${item.number}` : `التحقق من إصلاح #${item.number}`}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">{action === "fix" ? "تسجيل الإصلاح" : "تأكيد التحقق"}</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <p className="muted">{item.description}</p>
      <TextField label={action === "fix" ? "تاريخ الإصلاح" : "تاريخ التحقق في الموقع"} required type="date" dir="ltr" max={isoDay()} value={date} onChange={(e) => setDate(e.target.value)} />
      <FormError error={error} />
    </Dialog>
  );
}

function FinalDialog({ contractId, dlpEndsOn, onClose }: { contractId: string; dlpEndsOn: string; onClose: () => void }) {
  const { tenantId } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [v, setV] = useState({ date: isoDay(), reference: "", earlyReason: "" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const early = v.date < dlpEndsOn;
  async function submit() {
    setBusy(true); setError(null);
    try {
      await api("POST", `/t/contracts/${contractId}/final-acceptance`, { tenant: tenantId, body: { date: v.date, reference: v.reference, earlyReason: early ? v.earlyReason || null : null } });
      toast.success("سُجّل الاستلام النهائي: يبقى المستخلص الختامي ورد المحتجز والضمانات"); await invalidate("contracting"); onClose();
    } catch (e) {
      setError(e instanceof ApiError && e.code === "not_ready" ? new Error(((e.details as { blockers?: string[] })?.blockers ?? []).join("؛ ") || e.message) : e);
    } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title="الاستلام النهائي"
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">تسجيل الاستلام النهائي</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <div className="form-grid">
        <TextField label="تاريخ الاستلام النهائي" required type="date" dir="ltr" max={isoDay()} value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} />
        <TextField label="رقم الشهادة" required value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} maxLength={80} />
      </div>
      {early && <TextAreaField label="سبب الاستلام قبل نهاية الضمان" required value={v.earlyReason} onChange={(e) => setV({ ...v, earlyReason: e.target.value })} maxLength={500} rows={2}
        hint={`فترة الضمان تنتهي ${day(dlpEndsOn)}. قبلها بموافقة المالك الكتابية.`} />}
      <p className="muted acc-small">بعد الاستلام النهائي يكتمل العقد: لا مستخلصات جارية بعده إلا المستخلص الختامي، ولا عيوب ضمان جديدة.</p>
      <FormError error={error} />
    </Dialog>
  );
}

function PolicyDialog({ contractId, h, onClose }: { contractId: string; h: NonNullable<HandoverResp["handover"]>; onClose: () => void }) {
  const { tenantId } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const [v, setV] = useState({ insurer: h.insurer ?? "", policyNo: h.policyNo ?? "", policyUntil: h.policyUntil ?? "" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true); setError(null);
    try { await api("PUT", `/t/contracts/${contractId}/decennial`, { tenant: tenantId, body: { insurer: v.insurer || null, policyNo: v.policyNo || null, policyUntil: v.policyUntil || null } }); await invalidate("contracting"); onClose(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title="وثيقة التأمين على المسؤولية العشرية"
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">حفظ</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      {h.decennialBasis && <p className="muted acc-small">{h.decennialBasis}</p>}
      <div className="form-grid">
        <TextField label="شركة التأمين" optional value={v.insurer} onChange={(e) => setV({ ...v, insurer: e.target.value })} maxLength={120} />
        <TextField label="رقم الوثيقة" optional dir="ltr" value={v.policyNo} onChange={(e) => setV({ ...v, policyNo: e.target.value })} maxLength={80} />
        <TextField label="سارية حتى" optional type="date" dir="ltr" value={v.policyUntil} onChange={(e) => setV({ ...v, policyUntil: e.target.value })} />
      </div>
      <FormError error={error} />
    </Dialog>
  );
}

interface RegisterRow { id: string; number: string; title: string; role: string; status: string; projectCode: string; projectName: string; takingOverOn: string; dlpEndsOn: string;
  finalOn: string | null; decennialUntil: string | null; policyUntil: string | null; dlpDaysLeft: number; openItems: number; overdueItems: number; retentionHeld: number; activeGuarantees: number }

export function HandoversPage() {
  const { tenantId } = useTenant();
  const [tab, setTab] = useState("dlp");
  const q = useQuery({ queryKey: ["t", tenantId, "contracting", "handovers"], queryFn: () => api<{ items: RegisterRow[] }>("GET", "/t/contracting/handovers", { tenant: tenantId }) });
  const rows = q.data?.items ?? [];
  const inDlp = rows.filter((r) => !r.finalOn);
  const toClose = rows.filter((r) => r.status === "completed");
  const decennial = rows.filter((r) => r.decennialUntil);
  const shown = tab === "dlp" ? inDlp : tab === "close" ? toClose : tab === "decennial" ? decennial : rows;
  return (
    <div className="page">
      <PageHeader eyebrow="المقاولات" title="الاستلام وفترة الضمان"
        description="العقود بعد الاستلام الابتدائي: فترة الضمان وعيوبها، وما يبقى قبل الإقفال من محتجزات وضمانات، وسجل المسؤولية العشرية." />
      <div className="stats">
        <StatCard label="في فترة الضمان" value={q.data ? integer(inDlp.length) : "—"} icon={<CalendarClock />} hue="amber" note={q.data ? `${integer(inDlp.filter((r) => r.dlpDaysLeft <= 60).length)} تنتهي خلال 60 يوماً` : undefined} />
        <StatCard label="عيوب مفتوحة" value={q.data ? integer(rows.reduce((a, r) => a + r.openItems, 0)) : "—"} icon={<Wrench />} hue="red" note={q.data ? `${integer(rows.reduce((a, r) => a + r.overdueItems, 0))} متأخرة` : undefined} />
        <StatCard label="بانتظار الإقفال" value={q.data ? integer(toClose.length) : "—"} icon={<BadgeCheck />} hue="sky" note={q.data ? `محتجز ${money(toClose.reduce((a, r) => a + r.retentionHeld, 0))}` : undefined} />
        <StatCard label="تحت المسؤولية العشرية" value={q.data ? integer(decennial.length) : "—"} icon={<ShieldCheck />} hue="violet" />
      </div>
      <section className="panel" aria-label="سجل الاستلام">
        <div className="toolbar"><StatusTabs value={tab} onChange={setTab} options={[["dlp", "في فترة الضمان"], ["close", "بانتظار الإقفال"], ["decennial", "المسؤولية العشرية"], ["all", "الكل"]]} /></div>
        <DataTable caption="العقود بعد الاستلام" query={q.data ? { ...q, data: { items: shown } } : q} rowKey={(r) => r.id}
          empty={{ title: "لا عقود هنا", body: "يظهر العقد بعد تسجيل استلامه الابتدائي من تبويب «الاستلام والضمان» في صفحة العقد." }}
          columns={[
            { key: "number", header: "العقد", cell: (r) => <span className="stack-tight"><Link to="/w/$tenantId/contracting/contracts/$contractId" params={{ tenantId, contractId: r.id }}><Ref>{r.number}</Ref></Link>
              <span className="muted acc-small">{r.title} · {r.projectCode}{r.role === "SUB" ? " · باطن" : ""}</span></span> },
            { key: "takingOverOn", header: "الاستلام الابتدائي", cell: (r) => day(r.takingOverOn) },
            { key: "dlpEndsOn", header: "نهاية الضمان", cell: (r) => r.finalOn ? <span className="stack-tight">{day(r.dlpEndsOn)}<Badge tone="success">نهائي {day(r.finalOn)}</Badge></span>
              : <span className="stack-tight">{day(r.dlpEndsOn)}{r.dlpDaysLeft < 0 ? <Badge tone="warning">انتهى الضمان، لم يُستلم نهائياً</Badge> : <span className="muted acc-small">بعد {integer(r.dlpDaysLeft)} يوم</span>}</span> },
            { key: "openItems", header: "عيوب مفتوحة", numeric: true, cell: (r) => r.openItems ? <span className="stack-tight">{integer(r.openItems)}{r.overdueItems > 0 && <Badge tone="danger">{integer(r.overdueItems)} متأخر</Badge>}</span> : "—" },
            { key: "retentionHeld", header: "محتجز قائم", numeric: true, cell: (r) => r.retentionHeld ? money(r.retentionHeld) : "—" },
            { key: "activeGuarantees", header: "ضمانات لم ترد", numeric: true, cell: (r) => r.activeGuarantees ? integer(r.activeGuarantees) : "—" },
            { key: "decennialUntil", header: "المسؤولية العشرية", cell: (r) => r.decennialUntil ? <span className="stack-tight">{day(r.decennialUntil)}{!r.policyUntil && <span className="muted acc-small">بلا وثيقة تأمين</span>}</span> : "—" },
          ]} />
      </section>
    </div>
  );
}
