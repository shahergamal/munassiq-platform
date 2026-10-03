import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Save } from "lucide-react";
import { useState } from "react";
import { api, ApiError, errorMessage } from "../../api/client";
import { day, integer, percent } from "../../lib/format";
import { Button } from "../../ui/Button";
import { DataTable } from "../../ui/DataTable";
import { ConfirmDialog, Dialog } from "../../ui/Dialog";
import { SelectField, TextAreaField, TextField } from "../../ui/Field";
import { ActionMenu, Badge, PageHeader } from "../../ui/Layout";
import { FormError } from "../../ui/States";
import { useToast } from "../../ui/Toast";
import { StatusTabs } from "../workspace/Inventory";

// The statutory values contracting applies (penalty and variation caps, guarantees, deadlines). Seeded as drafts from
// research; a value applies to a contract only after the platform admin checks it against the official text and
// verifies it here. A verified value is evidence: it is not edited, only closed by an end date or retired.

interface Param { id: string; key: string; regime: string; value: number; unit: string; label: string; legalBasis: string; sourceTitle: string; sourceUrl: string | null;
  confidence: string; effectiveFrom: string; effectiveTo: string | null; status: "draft" | "verified" | "retired"; notes: string | null; verifiedAt: string | null;
  verifiedBy: string | null; usedBy: number }
const REGIME: Record<string, string> = { GTPL_1440: "المنافسات 1440هـ", GTPL_1448: "المنافسات 1448هـ", PRIVATE: "العقود الخاصة", ALL: "الكل" };
const UNIT: Record<string, string> = { percent: "%", sar: "⃁", days: "يوم", working_days: "يوم عمل", months: "شهر" };
const CONFIDENCE: Record<string, [string, "success" | "warning" | "neutral"]> = { official: ["نص رسمي", "success"], secondary: ["مصدر مهني", "warning"], commercial: ["مصدر تجاري", "neutral"] };
const shown = (p: Param) => (p.unit === "sar" ? `${integer(p.value)} ⃁` : p.unit === "percent" ? percent(p.value) : `${integer(p.value)} ${UNIT[p.unit]}`);
/** The keys the platform's code reads when a contract is activated (others are reference values shown with it). */
const READ_KEYS = ["delay_penalty_cap_other", "vo_new_items_cap_pct", "vo_increase_consent_pct", "vo_total_increase_cap_pct", "vo_decrease_cap_pct"];

export function AdminRegulatory() {
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState("draft");
  const q = useQuery({ queryKey: ["admin", "regulatory", tab], queryFn: () => api<{ items: Param[] }>("GET", "/admin/regulatory-parameters", { query: { status: tab } }) });
  const [editing, setEditing] = useState<Param | "new" | null>(null);
  const [acting, setActing] = useState<{ p: Param; action: "verify" | "retire" | "delete" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  async function act() {
    if (!acting) return;
    setBusy(true); setErr(null);
    try {
      if (acting.action === "delete") await api("DELETE", `/admin/regulatory-parameters/${acting.p.id}`);
      else await api("POST", `/admin/regulatory-parameters/${acting.p.id}/${acting.action}`, { body: {} });
      toast.success(acting.action === "verify" ? `وُثّقت «${acting.p.label}» وصارت تُطبَّق على العقود الجديدة` : acting.action === "retire" ? `أُلغيت «${acting.p.label}»` : `حُذفت المسودة «${acting.p.label}»`);
      setActing(null);
      await qc.invalidateQueries({ queryKey: ["admin", "regulatory"] });
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <div className="page">
      <PageHeader title="القيم التنظيمية للمقاولات"
        description="سقوف الغرامات وأوامر التغيير والضمانات والمهل، لكل نظام وفترة سريان. لا يُطبَّق أي منها على عقد قبل توثيقك له بمطابقته للنص الرسمي؛ وعند التفعيل يُحفظ في العقد مع مصدره."
        actions={<Button variant="primary" icon={<Plus />} onClick={() => setEditing("new")}>قيمة جديدة</Button>} />
      <section className="panel" aria-label="القيم التنظيمية">
        <div className="toolbar"><StatusTabs value={tab} onChange={setTab} options={[["draft", "بانتظار التوثيق"], ["verified", "موثقة"], ["retired", "ملغاة"]]} /></div>
        <DataTable caption="القيم التنظيمية" query={q} rowKey={(r) => r.id}
          empty={tab === "draft" ? { title: "لا قيم بانتظار التوثيق", body: "كل القيم المضافة موثقة أو ملغاة." } : { title: tab === "verified" ? "لم تُوثَّق قيمة بعد" : "لا قيم ملغاة" }}
          columns={[
            { key: "label", header: "القيمة", wrap: true, cell: (r) => <span className="stack-tight"><strong>{r.label}</strong><bdi dir="ltr" className="muted num acc-small">{r.key}</bdi></span> },
            { key: "value", header: "المقدار", numeric: true, cell: (r) => <strong>{shown(r)}</strong> },
            { key: "regime", header: "النظام", cell: (r) => REGIME[r.regime] ?? r.regime },
            { key: "effectiveFrom", header: "السريان", cell: (r) => <>{day(r.effectiveFrom)} – {r.effectiveTo ? day(r.effectiveTo) : "مستمر"}</> },
            { key: "legalBasis", header: "السند", wrap: true, cell: (r) => <span className="stack-tight">{r.legalBasis}<span className="muted acc-small">{r.sourceUrl ? <a href={r.sourceUrl} target="_blank" rel="noreferrer noopener">{r.sourceTitle}</a> : r.sourceTitle}</span></span> },
            { key: "confidence", header: "الثقة", cell: (r) => <Badge tone={CONFIDENCE[r.confidence]?.[1] ?? "neutral"}>{CONFIDENCE[r.confidence]?.[0] ?? r.confidence}</Badge> },
            ...(tab === "verified" ? [{ key: "verifiedAt", header: "وثّقها", cell: (r: Param) => <span className="stack-tight">{r.verifiedBy}<span className="muted acc-small">{day(r.verifiedAt)} · في {integer(r.usedBy)} عقد</span></span> }] : []),
          ]}
          actions={tab === "retired" ? undefined : (r) => <ActionMenu label={`إجراءات ${r.label}`} items={[
            ...(r.status === "draft" ? [{ label: "توثيق بعد المطابقة", onSelect: () => { setErr(null); setActing({ p: r, action: "verify" }); } }] : []),
            { label: r.status === "draft" ? "تعديل" : "إغلاق الفترة أو تحديث المصدر", onSelect: () => setEditing(r) },
            r.status === "draft"
              ? { label: "حذف المسودة", onSelect: () => { setErr(null); setActing({ p: r, action: "delete" }); }, danger: true, separated: true }
              : { label: "إلغاء القيمة", onSelect: () => { setErr(null); setActing({ p: r, action: "retire" }); }, danger: true, separated: true },
          ]} />} />
      </section>
      {editing && <ParamDialog param={editing === "new" ? null : editing} onClose={() => setEditing(null)} onDone={async () => { setEditing(null); await qc.invalidateQueries({ queryKey: ["admin", "regulatory"] }); }} />}
      <ConfirmDialog open={Boolean(acting)} onClose={() => setActing(null)} busy={busy} error={err ? errorMessage(err) : null} onConfirm={() => void act()} destructive={acting?.action !== "verify"}
        title={acting?.action === "verify" ? `توثيق «${acting.p.label}»؟` : acting?.action === "retire" ? `إلغاء «${acting.p.label}»؟` : `حذف المسودة «${acting?.p.label ?? ""}»؟`}
        confirmLabel={acting?.action === "verify" ? "طابقتها وأوثّقها" : acting?.action === "retire" ? "إلغاء القيمة" : "حذف"}
        message={acting?.action === "verify"
          ? <>تقرّ بأن {shown(acting.p)} ({acting.p.legalBasis}) مطابقة لـ«{acting.p.sourceTitle}» للفترة من {day(acting.p.effectiveFrom)}. تُطبَّق بعدها على كل عقد يُفعَّل بهذا النظام، ولا تُعدّل القيمة بعد التوثيق. يُسجَّل التوثيق باسمك في سجل التدقيق.</>
          : acting?.action === "retire" ? "لا تُطبَّق على عقود جديدة؛ العقود المفعّلة تحتفظ بما طُبّق عليها. أضف القيمة الصحيحة بعدها إن لزم." : "المسودة لم تُطبَّق على أي عقد."} />
    </div>
  );
}

function ParamDialog({ param, onClose, onDone }: { param: Param | null; onClose: () => void; onDone: () => Promise<void> }) {
  const locked = param?.status === "verified";
  const [v, setV] = useState({ key: param?.key ?? "", regime: param?.regime ?? "GTPL_1448", value: param ? String(param.value) : "", unit: param?.unit ?? "percent", label: param?.label ?? "",
    legalBasis: param?.legalBasis ?? "", sourceTitle: param?.sourceTitle ?? "", sourceUrl: param?.sourceUrl ?? "", confidence: param?.confidence ?? "official",
    effectiveFrom: param?.effectiveFrom ?? "", effectiveTo: param?.effectiveTo ?? "", notes: param?.notes ?? "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  async function submit() {
    const e: Record<string, string> = {};
    if (!/^[a-z0-9_]{2,60}$/.test(v.key)) e.key = "حروف إنجليزية صغيرة وأرقام و _";
    if (v.value === "" || !(Number(v.value) >= 0)) e.value = "رقم موجب";
    if (v.label.trim().length < 3) e.label = "اكتب وصف القيمة";
    if (v.legalBasis.trim().length < 2) e.legalBasis = "المادة أو السند";
    if (v.sourceTitle.trim().length < 2) e.sourceTitle = "اسم المصدر";
    if (!v.effectiveFrom) e.effectiveFrom = "بداية السريان";
    if (v.effectiveTo && v.effectiveTo < v.effectiveFrom) e.effectiveTo = "النهاية قبل البداية";
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true); setError(null);
    const body = { key: v.key, regime: v.regime, value: Number(v.value), unit: v.unit, label: v.label.trim(), legalBasis: v.legalBasis.trim(), sourceTitle: v.sourceTitle.trim(),
      sourceUrl: v.sourceUrl.trim() || null, confidence: v.confidence, effectiveFrom: v.effectiveFrom, effectiveTo: v.effectiveTo || null, notes: v.notes.trim() || null };
    try {
      if (param) await api("PUT", `/admin/regulatory-parameters/${param.id}`, { body });
      else await api("POST", "/admin/regulatory-parameters", { body });
      await onDone();
    } catch (err) { if (err instanceof ApiError) setErrors(err.fieldErrors); setError(err); } finally { setBusy(false); }
  }
  return (
    <Dialog open wide onClose={onClose} busy={busy} onSubmit={() => void submit()} title={param ? param.label : "قيمة تنظيمية جديدة"}
      footer={<><Button type="submit" variant="primary" icon={<Save />} loading={busy} loadingText="جارٍ الحفظ…">{param ? "حفظ" : "حفظ مسودة"}</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      {locked && <p className="muted">قيمة موثقة: يُعدّل فقط تاريخ نهاية السريان والرابط والملاحظات. لتغيير المقدار أغلق هذه الفترة وأضف قيمة جديدة من اليوم التالي.</p>}
      <div className="form-grid">
        <TextField label="المفتاح" required dir="ltr" value={v.key} onChange={set("key")} error={errors.key} disabled={locked} hint={`يطبّقها النظام عند تفعيل العقود: ${READ_KEYS.join("، ")}`} list="regulatory-keys" />
        <datalist id="regulatory-keys">{READ_KEYS.map((k) => <option key={k} value={k} />)}</datalist>
        <SelectField label="النظام" required value={v.regime} onChange={set("regime")} disabled={locked} options={Object.entries(REGIME).map(([value, label]) => ({ value, label }))} />
        <TextField label="المقدار" required numeric inputMode="decimal" dir="ltr" value={v.value} onChange={set("value")} error={errors.value} disabled={locked} />
        <SelectField label="الوحدة" required value={v.unit} onChange={set("unit")} disabled={locked} options={Object.entries(UNIT).map(([value, label]) => ({ value, label }))} />
      </div>
      <TextField label="الوصف" required value={v.label} onChange={set("label")} error={errors.label} disabled={locked} maxLength={200} />
      <div className="form-grid">
        <TextField label="السند النظامي" required value={v.legalBasis} onChange={set("legalBasis")} error={errors.legalBasis} disabled={locked} maxLength={300} />
        <TextField label="المصدر" required value={v.sourceTitle} onChange={set("sourceTitle")} error={errors.sourceTitle} disabled={locked} maxLength={300} />
        <TextField label="رابط المصدر" optional dir="ltr" type="url" value={v.sourceUrl} onChange={set("sourceUrl")} error={errors.sourceUrl} />
        <SelectField label="درجة الثقة" required value={v.confidence} onChange={set("confidence")} options={Object.entries(CONFIDENCE).map(([value, [label]]) => ({ value, label }))} />
        <TextField label="يسري من" required type="date" dir="ltr" value={v.effectiveFrom} onChange={set("effectiveFrom")} error={errors.effectiveFrom} disabled={locked} />
        <TextField label="حتى" optional type="date" dir="ltr" value={v.effectiveTo} onChange={set("effectiveTo")} error={errors.effectiveTo} />
      </div>
      <TextAreaField label="ملاحظات" optional value={v.notes} onChange={set("notes")} maxLength={1000} />
      <FormError error={error} />
    </Dialog>
  );
}
