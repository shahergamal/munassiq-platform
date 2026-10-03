import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { Calculator, FileSignature, Plus, Send, Trash2, Trophy } from "lucide-react";
import { useState } from "react";
import { api, ApiError, errorMessage } from "../../api/client";
import { useInvalidate, useTenant } from "../../app/tenant";
import { day, integer, money, percent, quantity } from "../../lib/format";
import { Button, IconButton } from "../../ui/Button";
import { DataTable } from "../../ui/DataTable";
import { ConfirmDialog, Dialog } from "../../ui/Dialog";
import { Checkbox, SelectField, TextField } from "../../ui/Field";
import { Badge, PageHeader, StatCard } from "../../ui/Layout";
import { ErrorState, FormError, TableSkeleton } from "../../ui/States";
import { useToast } from "../../ui/Toast";
import { CustomerPicker } from "./pickers";

// Contracting C6: tenders priced by rate build-up (materials, labour, equipment, subcontract, with waste), overheads,
// risk and profit; submitted as a frozen offer; converted when won into a project and a draft main contract.
// The server prices everything; the browser sends quantities, unit costs and percentages.

const num = (s: string) => Number(String(s).replace(/,/g, ""));
const Ref = ({ children }: { children: string }) => <bdi dir="ltr" className="num">{children}</bdi>;
const STATUS: Record<string, [string, "neutral" | "info" | "success" | "warning" | "danger"]> = {
  draft: ["تسعير", "neutral"], submitted: ["مقدَّم", "info"], won: ["فائز", "success"], lost: ["لم يُرسَ", "danger"], cancelled: ["ملغى", "neutral"] };
const KIND: Record<string, string> = { material: "مواد", labor: "عمالة", equipment: "معدات", subcontract: "باطن" };

interface TenderRow { id: string; number: string; title: string; status: string; customerName: string | null; specialtyName: string; submissionDue: string | null; total: number;
  marginPct: number | null; contractId: string | null }

export function TendersPage() {
  const { tenantId, can, writable } = useTenant();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ["t", tenantId, "contracting", "tenders"], queryFn: () => api<{ items: TenderRow[]; winRate: number | null }>("GET", "/t/tenders", { tenant: tenantId }) });
  const [adding, setAdding] = useState(false);
  const items = q.data?.items ?? [];
  return (
    <div className="page">
      <PageHeader eyebrow="المقاولات" title="العطاءات والتسعير"
        description="سعّر كل بند من موارده (مواد وعمالة ومعدات وباطن مع الهدر)، ثم أضف المصروفات غير المباشرة والمخاطر والربح. العطاء الفائز يتحول إلى عقد بجدول كمياته وتكلفته المقدرة."
        actions={can("tenders.create") && writable ? <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>عطاء جديد</Button> : undefined} />
      <div className="stats">
        <StatCard label="تحت التسعير" value={q.data ? integer(items.filter((t) => t.status === "draft").length) : "—"} icon={<Calculator />} hue="indigo" />
        <StatCard label="قيمة العطاءات المقدَّمة" value={q.data ? money(items.filter((t) => t.status === "submitted").reduce((a, t) => a + t.total, 0)) : "—"} icon={<Send />} hue="sky" />
        <StatCard label="نسبة الفوز" value={q.data?.winRate === null || !q.data ? "—" : percent(q.data.winRate)} icon={<Trophy />} hue="green" note="من العطاءات المحسومة" />
      </div>
      <section className="panel" aria-label="العطاءات">
        <DataTable caption="العطاءات" query={q} rowKey={(r) => r.id} onRowClick={(r) => void navigate({ to: "/w/$tenantId/contracting/tenders/$tenderId", params: { tenantId, tenderId: r.id } })}
          empty={{ title: "لا عطاءات بعد", body: "أنشئ عطاءً، وأدخل بنوده وكمياته، وسعّر كل بند من موارده." }}
          columns={[
            { key: "title", header: "العطاء", cell: (r) => <span className="stack-tight"><strong>{r.title}</strong><span className="muted acc-small"><Ref>{r.number}</Ref> · {r.specialtyName}</span></span> },
            { key: "customerName", header: "العميل", cell: (r) => r.customerName ?? "—" },
            { key: "status", header: "الحالة", cell: (r) => <Badge tone={STATUS[r.status]![1]}>{STATUS[r.status]![0]}</Badge> },
            { key: "submissionDue", header: "آخر موعد", cell: (r) => day(r.submissionDue) },
            { key: "total", header: "القيمة", numeric: true, cell: (r) => money(r.total) },
            { key: "marginPct", header: "الهامش", numeric: true, cell: (r) => r.marginPct === null ? "—" : percent(r.marginPct) },
          ]} />
      </section>
      {adding && <TenderDialog tenantId={tenantId} onClose={() => setAdding(false)} onDone={(id) => void navigate({ to: "/w/$tenantId/contracting/tenders/$tenderId", params: { tenantId, tenderId: id } })} />}
    </div>
  );
}

interface TenderHeader { number: string; title: string; customerId: string | null; customerName: string | null; specialty: string; governingRegime: string; tenderDate: string | null;
  submissionDue: string | null; overheadPct: number; riskPct: number; profitPct: number }
function TenderDialog({ tenantId, tender, tenderId, onClose, onDone }: { tenantId: string; tender?: TenderHeader; tenderId?: string; onClose: () => void; onDone: (id: string) => void }) {
  const invalidate = useInvalidate(tenantId);
  const ref = useQuery({ queryKey: ["t", tenantId, "contracting", "reference"], staleTime: 300_000,
    queryFn: () => api<{ specialties: { code: string; name: string }[] }>("GET", "/t/contracting/reference", { tenant: tenantId }) });
  const [v, setV] = useState({ number: tender?.number ?? "", title: tender?.title ?? "", customerId: tender?.customerId ?? "", customerName: tender?.customerName ?? "",
    specialty: tender?.specialty ?? "BUILDING", governingRegime: tender?.governingRegime ?? "PRIVATE", tenderDate: tender?.tenderDate ?? "", submissionDue: tender?.submissionDue ?? "",
    overheadPct: String(tender?.overheadPct ?? 10), riskPct: String(tender?.riskPct ?? 3), profitPct: String(tender?.profitPct ?? 10) });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  async function submit() {
    const e: Record<string, string> = {};
    if (!v.number.trim()) e.number = "أدخل رقم العطاء";
    if (v.title.trim().length < 2) e.title = "أدخل العنوان";
    if (v.governingRegime !== "PRIVATE" && !v.tenderDate) e.tenderDate = "تاريخ الطرح يحدد النظام الحاكم";
    for (const k of ["overheadPct", "riskPct", "profitPct"] as const) if (!(num(v[k]) >= 0 && num(v[k]) <= 100)) e[k] = "نسبة بين 0 و100";
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true); setError(null);
    const body = { number: v.number.trim(), title: v.title.trim(), customerId: v.customerId || null, specialty: v.specialty, governingRegime: v.governingRegime,
      tenderDate: v.tenderDate || null, submissionDue: v.submissionDue || null, overheadPct: num(v.overheadPct), riskPct: num(v.riskPct), profitPct: num(v.profitPct) };
    try {
      const id = tenderId ? (await api("PUT", `/t/tenders/${tenderId}`, { tenant: tenantId, body }), tenderId) : (await api<{ id: string }>("POST", "/t/tenders", { tenant: tenantId, body })).id;
      await invalidate("contracting");
      onDone(id);
    } catch (err) { if (err instanceof ApiError) setErrors(err.fieldErrors); setError(err); } finally { setBusy(false); }
  }
  return (
    <Dialog open wide onClose={onClose} busy={busy} onSubmit={() => void submit()} title={tender ? "بيانات العطاء والنسب" : "عطاء جديد"}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">{tender ? "حفظ" : "إنشاء العطاء"}</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <div className="form-grid">
        <TextField label="رقم العطاء" required dir="ltr" value={v.number} onChange={set("number")} error={errors.number} maxLength={40} />
        <TextField label="العنوان" required value={v.title} onChange={set("title")} error={errors.title} maxLength={200} />
        <SelectField label="التخصص" required value={v.specialty} disabled={Boolean(tender)} onChange={set("specialty")} options={(ref.data?.specialties ?? []).map((s) => ({ value: s.code, label: s.name }))} />
        <TextField label="آخر موعد للتقديم" optional type="date" dir="ltr" value={v.submissionDue} onChange={set("submissionDue")} />
        <SelectField label="النظام" required value={v.governingRegime} onChange={set("governingRegime")}
          options={[{ value: "PRIVATE", label: "عقد خاص" }, { value: "GTPL_1440", label: "نظام المنافسات 1440هـ" }, { value: "GTPL_1448", label: "نظام المنافسات 1448هـ" }]} />
        <TextField label="تاريخ الطرح" optional={v.governingRegime === "PRIVATE"} required={v.governingRegime !== "PRIVATE"} type="date" dir="ltr" value={v.tenderDate} onChange={set("tenderDate")} error={errors.tenderDate} />
      </div>
      {v.customerId ? <p className="row" style={{ gap: "var(--sp-2)" }}>العميل: <strong>{v.customerName}</strong> <Button size="sm" variant="ghost" onClick={() => setV({ ...v, customerId: "", customerName: "" })}>تغيير</Button></p>
        : <CustomerPicker tenantId={tenantId} label="العميل" hint="مطلوب قبل التقديم" onPick={(c) => setV({ ...v, customerId: c.id, customerName: c.name })} />}
      <fieldset className="stack">
        <legend className="acc-small">الإضافات على التكلفة المباشرة (تُطبق بالتتابع)</legend>
        <div className="form-grid">
          <TextField label="مصروفات غير مباشرة %" required numeric inputMode="decimal" dir="ltr" value={v.overheadPct} onChange={set("overheadPct")} error={errors.overheadPct} />
          <TextField label="احتياطي المخاطر %" required numeric inputMode="decimal" dir="ltr" value={v.riskPct} onChange={set("riskPct")} error={errors.riskPct} />
          <TextField label="الربح %" required numeric inputMode="decimal" dir="ltr" value={v.profitPct} onChange={set("profitPct")} error={errors.profitPct} />
        </div>
      </fieldset>
      <FormError error={error} />
    </Dialog>
  );
}

// ── Tender ────────────────────────────────────────────────────────────────────────────────────
interface Res { id?: string; kind: string; ingredientId: string | null; description: string; unit: string | null; quantity: number; unitCost: number; wastePct: number }
interface Item { id: string; parentId: string | null; code: string; description: string; isSection: boolean; unit: string | null; quantity: number; depth: number; directRate: number | null;
  amount: number; directCost?: number; costRate?: number; rate?: number; resources: Res[] }
interface Tender extends TenderHeader { id: string; status: string; specialtyName: string; specialtyDefinition: { units: { code: string; name: string }[] }; submittedTotal: number | null;
  contractId: string | null; items: Item[]; totals: { total: number; cost: number; direct: number; margin: number; marginPct: number; byKind: Record<string, number> } }

export function TenderPage() {
  const { tenantId, can, writable } = useTenant();
  const { tenderId } = useParams({ strict: false }) as { tenderId: string };
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ["t", tenantId, "contracting", "tender", tenderId], queryFn: () => api<Tender>("GET", `/t/tenders/${tenderId}`, { tenant: tenantId }) });
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [pricing, setPricing] = useState<Item | null>(null);
  const [removing, setRemoving] = useState<Item | null>(null);
  const [confirm, setConfirm] = useState<"submit" | "won" | "lost" | null>(null);
  const [converting, setConverting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  if (q.isPending) return <div className="page"><TableSkeleton columns={6} /></div>;
  if (q.isError) return <div className="page"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div>;
  const t = q.data;
  const draft = t.status === "draft";
  const edit = draft && can("tenders.edit") && writable;
  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true); setErr(null);
    try { await fn(); toast.success(done); setConfirm(null); setRemoving(null); await invalidate("contracting"); } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  // What still blocks submitting, said before the user tries.
  const unpriced = t.items.filter((i) => !i.isSection && i.quantity > 0 && !i.rate).length;
  const blocker = !t.customerId ? "حدد العميل من «البيانات والنسب»" : !t.items.some((i) => !i.isSection) ? "أضف البنود" : unpriced ? `${integer(unpriced)} بند بلا سعر` : null;
  const primary = draft && can("tenders.edit") ? <Button variant="primary" icon={<Send />} disabled={Boolean(blocker)} title={blocker ?? undefined} onClick={() => { setErr(null); setConfirm("submit"); }}>تقديم العطاء</Button>
    : t.status === "submitted" && can("tenders.edit") ? <Button variant="primary" icon={<Trophy />} onClick={() => { setErr(null); setConfirm("won"); }}>تسجيل الترسية</Button>
    : t.status === "won" && !t.contractId && can("tenders.convert") ? <Button variant="primary" icon={<FileSignature />} onClick={() => setConverting(true)}>تحويل إلى عقد</Button>
    : t.contractId ? <Link to="/w/$tenantId/contracting/contracts/$contractId" params={{ tenantId, contractId: t.contractId }} className="btn btn-primary">فتح العقد</Link> : null;
  return (
    <div className="page">
      <PageHeader eyebrow={t.specialtyName} title={<>{t.title} <Ref>{t.number}</Ref></>}
        description={<>{t.customerName ?? "بلا عميل"} · آخر موعد {day(t.submissionDue)} · <Badge tone={STATUS[t.status]![1]}>{STATUS[t.status]![0]}</Badge> · غير مباشرة {percent(t.overheadPct)} ·
          مخاطر {percent(t.riskPct)} · ربح {percent(t.profitPct)}</>}
        actions={<>
          <Link to="/w/$tenantId/contracting/tenders" params={{ tenantId }} className="btn btn-ghost">كل العطاءات</Link>
          {edit && <Button onClick={() => setEditing(true)}>البيانات والنسب</Button>}
          {t.status === "submitted" && can("tenders.edit") && writable && <Button variant="ghost" onClick={() => { setErr(null); setConfirm("lost"); }}>لم يُرسَ</Button>}
          {writable && primary}
        </>} />
      {draft && blocker && <p className="banner banner-warning" role="status">قبل التقديم: {blocker}.</p>}
      <div className="stats">
        <StatCard label="قيمة العطاء" value={money(t.status === "draft" ? t.totals.total : t.submittedTotal ?? t.totals.total)} icon={<Calculator />} hue="indigo" note={`التكلفة المباشرة ${money(t.totals.direct)}`} />
        <StatCard label="التكلفة بلا ربح" value={money(t.totals.cost)} icon={<Calculator />} hue="sky" note="تصبح التكلفة المقدرة للعقد" />
        <StatCard label="الهامش" value={money(t.totals.margin)} icon={<Trophy />} hue="green" note={percent(t.totals.marginPct)} />
        <StatCard label="المواد / العمالة / المعدات / الباطن" value={<span className="acc-small">{Object.entries(t.totals.byKind).map(([k, v]) => `${KIND[k]} ${money(v)}`).join(" · ")}</span>} hue="violet" />
      </div>
      <section className="panel" aria-label="بنود العطاء">
        {edit && <div className="toolbar row" style={{ justifyContent: "end" }}><Button size="sm" icon={<Plus />} onClick={() => setAdding(true)}>بند أو قسم</Button></div>}
        <DataTable caption="بنود العطاء" query={{ ...q, data: { items: t.items } }} rowKey={(r) => r.id}
          empty={{ title: "لا بنود", body: "أضف أقسام العطاء وبنوده بكمياتها، ثم سعّر كل بند من موارده أو بسعر مباشر." }}
          columns={[
            { key: "code", header: "البند", sortKey: false, cell: (r) => <span style={{ paddingInlineStart: `calc(${r.depth} * var(--sp-4))` }}>{r.isSection ? <strong><Ref>{r.code}</Ref></strong> : <Ref>{r.code}</Ref>}</span> },
            { key: "description", header: "الوصف", wrap: true, sortKey: false, cell: (r) => r.isSection ? <strong>{r.description}</strong> : <span className="stack-tight">{r.description}
              <span className="muted acc-small">{r.resources.length ? r.resources.map((x) => KIND[x.kind]).filter((x, i, a) => a.indexOf(x) === i).join(" + ") : r.directRate !== null ? "سعر مباشر" : "غير مسعّر"}</span></span> },
            { key: "quantity", header: "الكمية", numeric: true, sortKey: false, cell: (r) => r.isSection ? "" : <>{quantity(r.quantity)} <span className="muted">{t.specialtyDefinition.units.find((u) => u.code === r.unit)?.name ?? r.unit}</span></> },
            { key: "directCost", header: "التكلفة المباشرة", numeric: true, sortKey: false, cell: (r) => r.isSection ? "" : money(r.directCost) },
            { key: "rate", header: "سعر البيع", numeric: true, sortKey: false, cell: (r) => r.isSection ? "" : r.rate ? money(r.rate) : <Badge tone="warning">بلا سعر</Badge> },
            { key: "amount", header: "المبلغ", numeric: true, sortKey: false, cell: (r) => r.isSection ? <strong>{money(r.amount)}</strong> : money(r.amount) },
          ]}
          actions={(r) => r.isSection ? (edit ? <IconButton label={`حذف ${r.code}`} icon={<Trash2 />} onClick={() => { setErr(null); setRemoving(r); }} /> : null)
            : <span className="row" style={{ gap: "var(--sp-1)" }}><Button size="sm" variant="ghost" onClick={() => setPricing(r)}>{edit ? "تحليل السعر" : "عرض التحليل"}</Button>
              {edit && <IconButton label={`حذف ${r.code}`} icon={<Trash2 />} onClick={() => { setErr(null); setRemoving(r); }} />}</span>} />
      </section>
      {editing && <TenderDialog tenantId={tenantId} tender={t} tenderId={t.id} onClose={() => setEditing(false)} onDone={() => setEditing(false)} />}
      {adding && <ItemDialog tenantId={tenantId} tender={t} onClose={() => setAdding(false)} />}
      {pricing && <BuildUpDialog tenantId={tenantId} item={pricing} editable={edit} onClose={() => setPricing(null)} />}
      {converting && <ConvertDialog tenantId={tenantId} tender={t} onClose={() => setConverting(false)}
        onDone={(id) => void navigate({ to: "/w/$tenantId/contracting/contracts/$contractId", params: { tenantId, contractId: id } })} />}
      <ConfirmDialog open={Boolean(removing)} onClose={() => setRemoving(null)} busy={busy} error={err ? errorMessage(err) : null}
        onConfirm={() => void run(() => api("DELETE", `/t/tender-items/${removing!.id}`, { tenant: tenantId }), `حُذف ${removing!.code}`)}
        title={`حذف ${removing?.code ?? ""}؟`} confirmLabel="حذف" message={removing?.isSection ? "يُحذف القسم وكل بنوده وتحليل أسعارها." : "يُحذف البند وتحليل سعره."} />
      <ConfirmDialog open={confirm === "submit"} onClose={() => setConfirm(null)} busy={busy} error={err ? errorMessage(err) : null} destructive={false}
        onConfirm={() => void run(() => api("POST", `/t/tenders/${tenderId}/submit`, { tenant: tenantId }), "قُدِّم العطاء وثُبّت تسعيره")}
        title="تقديم العطاء؟" confirmLabel="تقديم" message={<>تُثبَّت القيمة {money(t.totals.total)} وهامشها {percent(t.totals.marginPct)}، ولا يتغير التسعير بعدها.</>} />
      <ConfirmDialog open={confirm === "won"} onClose={() => setConfirm(null)} busy={busy} error={err ? errorMessage(err) : null} destructive={false}
        onConfirm={() => void run(() => api("POST", `/t/tenders/${tenderId}/outcome`, { tenant: tenantId, body: { status: "won" } }), "سُجّلت الترسية. حوّله الآن إلى عقد.")}
        title="تسجيل الترسية؟" confirmLabel="رُسي علينا" message="بعدها تحوّله إلى عقد بجدول كمياته في مشروع جديد أو قائم." />
      <ConfirmDialog open={confirm === "lost"} onClose={() => setConfirm(null)} busy={busy} error={err ? errorMessage(err) : null}
        onConfirm={() => void run(() => api("POST", `/t/tenders/${tenderId}/outcome`, { tenant: tenantId, body: { status: "lost" } }), "سُجّل العطاء غير مُرسى")}
        title="العطاء لم يُرسَ علينا؟" confirmLabel="تسجيل" message="يُحفظ للمقارنة ونسبة الفوز، ولا يتحول إلى عقد." />
    </div>
  );
}

function ItemDialog({ tenantId, tender, onClose }: { tenantId: string; tender: Tender; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const [v, setV] = useState({ parentId: "", code: "", description: "", isSection: false, unit: tender.specialtyDefinition.units[0]?.code ?? "", quantity: "", directRate: "" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!v.code.trim() || !v.description.trim()) return setError(new Error("أدخل الرمز والوصف"));
    if (!v.isSection && !(num(v.quantity) >= 0 && v.quantity !== "")) return setError(new Error("أدخل الكمية"));
    setBusy(true); setError(null);
    try {
      await api("POST", `/t/tenders/${tender.id}/items`, { tenant: tenantId, body: { parentId: v.parentId || null, code: v.code.trim(), description: v.description.trim(), isSection: v.isSection,
        unit: v.isSection ? null : v.unit, quantity: v.isSection ? 0 : num(v.quantity), directRate: v.isSection || v.directRate === "" ? null : num(v.directRate) } });
      await invalidate("contracting");
      setV({ ...v, code: "", description: "", quantity: "", directRate: "" });
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title="بند أو قسم"
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الإضافة…">إضافة والاستمرار</Button><Button onClick={onClose} disabled={busy}>تم</Button></>}>
      <Checkbox label="قسم (يجمع البنود تحته)" checked={v.isSection} onChange={(e) => setV({ ...v, isSection: e.target.checked })} />
      <div className="form-grid">
        <SelectField label="تحت القسم" placeholder="المستوى الأعلى" value={v.parentId} onChange={(e) => setV({ ...v, parentId: e.target.value })}
          options={tender.items.filter((i) => i.isSection).map((s) => ({ value: s.id, label: `${s.code} ${s.description}` }))} />
        <TextField label="الرمز" required dir="ltr" value={v.code} onChange={(e) => setV({ ...v, code: e.target.value })} maxLength={40} />
      </div>
      <TextField label="الوصف" required value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} maxLength={1000} />
      {!v.isSection && <div className="form-grid">
        <SelectField label="الوحدة" required value={v.unit} onChange={(e) => setV({ ...v, unit: e.target.value })} options={tender.specialtyDefinition.units.map((u) => ({ value: u.code, label: u.name }))} />
        <TextField label="الكمية" required numeric inputMode="decimal" dir="ltr" value={v.quantity} onChange={(e) => setV({ ...v, quantity: e.target.value })} />
        <TextField label="سعر مباشر للوحدة (⃁)" optional numeric inputMode="decimal" dir="ltr" value={v.directRate} onChange={(e) => setV({ ...v, directRate: e.target.value })}
          hint="لبند بعرض سعر أو مقطوعية؛ وإلا سعّره من موارده" />
      </div>}
      <FormError error={error} />
    </Dialog>
  );
}

/** The item's resources per unit; the server returns the priced rate. */
function BuildUpDialog({ tenantId, item, editable, onClose }: { tenantId: string; item: Item; editable: boolean; onClose: () => void }) {
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [rows, setRows] = useState(item.resources.map((r) => ({ kind: r.kind, description: r.description, unit: r.unit ?? "", quantity: String(r.quantity), unitCost: String(r.unitCost), wastePct: String(r.wastePct) })));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const setRow = (i: number, p: Partial<(typeof rows)[number]>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const direct = rows.reduce((a, r) => a + (num(r.quantity) || 0) * (num(r.unitCost) || 0) * (1 + (num(r.wastePct) || 0) / 100), 0);
  async function submit() {
    const bad = rows.find((r) => !r.description.trim() || !(num(r.quantity) > 0) || !(num(r.unitCost) >= 0) || r.unitCost === "");
    if (bad) return setError(new Error("لكل مورد وصف وكمية لكل وحدة وتكلفة"));
    setBusy(true); setError(null);
    try {
      await api("PUT", `/t/tender-items/${item.id}/resources`, { tenant: tenantId, body: { resources: rows.map((r) => ({ kind: r.kind, description: r.description.trim(), unit: r.unit || null,
        quantity: num(r.quantity), unitCost: num(r.unitCost), wastePct: num(r.wastePct || "0") })) } });
      toast.success(`سُعّر البند ${item.code}`);
      await invalidate("contracting");
      onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open wide onClose={onClose} busy={busy} onSubmit={() => void submit()} title={`تحليل سعر ${item.code}: ${item.description}`.slice(0, 90)}
      footer={editable ? <><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ التسعير…">حفظ التحليل</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></> : <Button onClick={onClose}>إغلاق</Button>}>
      <p className="muted">الموارد لكل وحدة واحدة من البند. التكلفة المباشرة التقريبية للوحدة {money(Math.round(direct * 100) / 100)}؛ يضيف الخادم عليها غير المباشرة والمخاطر والربح.
        {item.rate !== undefined && <> سعر البيع الحالي {money(item.rate)}.</>}</p>
      {rows.map((r, i) => (
        <div key={i} className="row" style={{ gap: "var(--sp-2)", alignItems: "end", flexWrap: "wrap" }}>
          <SelectField label="النوع" value={r.kind} disabled={!editable} onChange={(e) => setRow(i, { kind: e.target.value })} options={Object.entries(KIND).map(([value, label]) => ({ value, label }))} />
          <TextField label="المورد" value={r.description} disabled={!editable} onChange={(e) => setRow(i, { description: e.target.value })} maxLength={200} />
          <TextField label="الوحدة" value={r.unit} disabled={!editable} onChange={(e) => setRow(i, { unit: e.target.value })} maxLength={20} />
          <TextField label="الكمية لكل وحدة" numeric inputMode="decimal" dir="ltr" value={r.quantity} disabled={!editable} onChange={(e) => setRow(i, { quantity: e.target.value })} />
          <TextField label="التكلفة (⃁)" numeric inputMode="decimal" dir="ltr" value={r.unitCost} disabled={!editable} onChange={(e) => setRow(i, { unitCost: e.target.value })} />
          <TextField label="الهدر %" numeric inputMode="decimal" dir="ltr" value={r.wastePct} disabled={!editable} onChange={(e) => setRow(i, { wastePct: e.target.value })} />
          {editable && <IconButton label={`حذف المورد ${i + 1}`} icon={<Trash2 />} onClick={() => setRows(rows.filter((_, j) => j !== i))} />}
        </div>
      ))}
      {editable && <Button size="sm" icon={<Plus />} onClick={() => setRows([...rows, { kind: "material", description: "", unit: "", quantity: "1", unitCost: "", wastePct: "0" }])}>مورد</Button>}
      {!rows.length && <p className="muted">{item.directRate !== null ? `مسعّر مباشرة بـ ${money(item.directRate)} للوحدة.` : "لا موارد بعد."}</p>}
      <FormError error={error} />
    </Dialog>
  );
}

function ConvertDialog({ tenantId, tender, onClose, onDone }: { tenantId: string; tender: Tender; onClose: () => void; onDone: (id: string) => void }) {
  const projects = useQuery({ queryKey: ["t", tenantId, "contracting", "projects"], queryFn: () => api<{ items: { id: string; code: string; name: string; specialty: string }[] }>("GET", "/t/projects", { tenant: tenantId }) });
  const ref = useQuery({ queryKey: ["t", tenantId, "contracting", "reference"], staleTime: 300_000,
    queryFn: () => api<{ profiles: { code: string; name: string }[] }>("GET", "/t/contracting/reference", { tenant: tenantId }) });
  const [v, setV] = useState({ projectId: "", code: "", name: tender.title, contractNumber: tender.number, profile: "CUSTOM", pricingModel: "UNIT_PRICE" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  async function submit() {
    if (!v.projectId && !/^[A-Za-z0-9-]{1,20}$/.test(v.code)) return setError(new Error("رمز المشروع الجديد حروف إنجليزية وأرقام وشرطة"));
    setBusy(true); setError(null);
    try {
      const r = await api<{ contractId: string }>("POST", `/t/tenders/${tender.id}/convert`, { tenant: tenantId, body: {
        ...(v.projectId ? { projectId: v.projectId } : { newProject: { code: v.code, name: v.name.trim() } }), contractNumber: v.contractNumber.trim(), profile: v.profile, pricingModel: v.pricingModel } });
      onDone(r.contractId);
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title="تحويل العطاء إلى عقد"
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ التحويل…">إنشاء العقد</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <p className="muted">يُنشأ عقد رئيسي مسودة بقيمة {money(tender.submittedTotal ?? tender.totals.total)} وجدول كمياته بأسعار البيع، وتُسجَّل {money(tender.totals.cost)} تكلفةً مقدرة له. راجعه ثم فعّله.</p>
      <SelectField label="المشروع" value={v.projectId} placeholder="مشروع جديد" onChange={set("projectId")}
        options={(projects.data?.items ?? []).filter((p) => p.specialty === tender.specialty).map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))} />
      {!v.projectId && <div className="form-grid">
        <TextField label="رمز المشروع الجديد" required dir="ltr" value={v.code} onChange={(e) => setV({ ...v, code: e.target.value.toUpperCase() })} maxLength={20} />
        <TextField label="اسمه" required value={v.name} onChange={set("name")} maxLength={160} />
      </div>}
      <div className="form-grid">
        <TextField label="رقم العقد" required dir="ltr" value={v.contractNumber} onChange={set("contractNumber")} maxLength={40} />
        <SelectField label="نموذج العقد" required value={v.profile} onChange={set("profile")} options={(ref.data?.profiles ?? []).map((p) => ({ value: p.code, label: p.name }))} />
        <SelectField label="التسعير" required value={v.pricingModel} onChange={set("pricingModel")} options={[{ value: "UNIT_PRICE", label: "أسعار وحدات" }, { value: "LUMP_SUM", label: "مقطوعية" }]} />
      </div>
      <FormError error={error} />
    </Dialog>
  );
}
