import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useBlocker } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, ExternalLink, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../../api/client";
import { dayTime } from "../../lib/format";
import { Button, IconButton } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/Dialog";
import { TextAreaField, TextField } from "../../ui/Field";
import { PageHeader } from "../../ui/Layout";
import { ErrorState, FormError, Skeleton } from "../../ui/States";
import { useToast } from "../../ui/Toast";
import { landingKey, type LandingContent } from "../Landing";

type Kind = "text" | "area" | "long" | "lines" | "url";
interface Field { key: string; label: string; kind?: Kind; hint?: string }
interface ListDef { key: string; label: string; item: string; fields: Field[]; max: number; fixed?: boolean }
interface SectionDef { id: string; label: string; base: string; fields: Field[]; lists?: ListDef[]; note?: React.ReactNode }

const HEAD: Field[] = [{ key: "eyebrow", label: "العنوان الصغير فوق القسم" }, { key: "title", label: "عنوان القسم" }];
const ITEM: Field[] = [{ key: "title", label: "العنوان" }, { key: "description", label: "الوصف", kind: "area" }];
const LINK: Field[] = [{ key: "label", label: "النص" }, { key: "url", label: "الرابط", kind: "url", hint: "#قسم أو /صفحة أو https://…" }];
const policy = (id: "privacy" | "terms" | "security", label: string): SectionDef => ({
  id, label, base: `policies.${id}`,
  fields: [{ key: "title", label: "العنوان" }, { key: "summary", label: "سطر تعريفي" }, { key: "body", label: "النص الكامل", kind: "long", hint: "افصل الفقرات بسطر فارغ" }],
});

const SECTIONS: SectionDef[] = [
  { id: "announcement", label: "شريط الإعلان", base: "announcement", fields: [
    { key: "title", label: "العنوان", hint: "اتركه فارغاً لإخفاء الشريط" }, { key: "text", label: "السطر الوصفي" },
    { key: "action", label: "نص الزر" }, { key: "url", label: "رابط الزر", kind: "url", hint: "#قسم أو /صفحة أو https://…" },
  ] },
  { id: "hero", label: "الواجهة", base: "hero", fields: [
    { key: "badge", label: "الشارة فوق العنوان" }, { key: "title", label: "العنوان الرئيسي" }, { key: "highlight", label: "السطر الملوّن" },
    { key: "description", label: "الوصف", kind: "area" }, { key: "primaryAction", label: "زر التسجيل" }, { key: "secondaryAction", label: "الزر الثانوي" },
    { key: "trustItems", label: "نقاط الثقة", kind: "lines", hint: "نقطة في كل سطر، حتى 6" },
    { key: "note", label: "السطر تحت الأزرار", hint: "مثل: تجربة مجانية - بدون بطاقة ائتمان" },
  ] },
  { id: "integrations", label: "شريط التكاملات", base: "integrations", fields: [
    { key: "title", label: "العنوان فوق الشريط" }, { key: "items", label: "العناصر", kind: "lines", hint: "عنصر في كل سطر، حتى 24. تتحرك في شريطين" },
  ] },
  { id: "navigation", label: "القائمة العلوية", base: "navigation", fields: [
    { key: "features", label: "المميزات" }, { key: "why", label: "لماذا مُنَسِّق" }, { key: "useCases", label: "حالات الاستخدام" },
    { key: "pricing", label: "الباقات" }, { key: "faq", label: "الأسئلة الشائعة" }, { key: "signIn", label: "تسجيل الدخول" }, { key: "trial", label: "زر التجربة" },
  ] },
  { id: "sectors", label: "القطاعات", base: "sectors", fields: [...HEAD, { key: "description", label: "الوصف", kind: "area" },
    { key: "availableLabel", label: "شارة القطاع المتاح" }, { key: "comingSoonLabel", label: "شارة القطاع القادم" }, { key: "waitlistAction", label: "زر تسجيل الاهتمام" }],
    lists: [{ key: "items", label: "بطاقات القطاعات", item: "قطاع", fields: [{ key: "label", label: "العنوان" }, { key: "description", label: "الوصف", kind: "area" }], max: 3, fixed: true }],
    note: "إتاحة القطاع للتسجيل تأتي من النظام نفسه، لا من هذا النص." },
  { id: "preview", label: "معاينة المنتج", base: "preview", fields: [{ key: "title", label: "عنوان المعاينة" }, { key: "note", label: "تنبيه الأرقام التوضيحية" }, { key: "listTitle", label: "عنوان القائمة" }],
    lists: [
      { key: "metrics", label: "المؤشرات", item: "مؤشر", fields: [{ key: "label", label: "التسمية" }, { key: "value", label: "القيمة" }], max: 4 },
      { key: "list", label: "عناصر القائمة", item: "عنصر", fields: [{ key: "label", label: "العنوان" }, { key: "meta", label: "السطر الوصفي" }, { key: "tag", label: "الوسم" }], max: 5 },
    ] },
  { id: "features", label: "المميزات", base: "features", fields: [...HEAD, { key: "description", label: "الوصف", kind: "area" }], lists: [{ key: "items", label: "المميزات", item: "ميزة", fields: ITEM, max: 8 }] },
  { id: "mobileApp", label: "التطبيق على الجوال", base: "mobileApp", fields: [...HEAD, { key: "description", label: "الوصف", kind: "area" },
    { key: "points", label: "النقاط", kind: "lines", hint: "نقطة في كل سطر، حتى 6" }] },
  { id: "why", label: "لماذا مُنَسِّق", base: "why", fields: [...HEAD, { key: "description", label: "الوصف", kind: "area" }], lists: [{ key: "items", label: "الأسباب", item: "سبب", fields: ITEM, max: 6 }] },
  { id: "useCases", label: "حالات الاستخدام", base: "useCases", fields: HEAD, lists: [{ key: "items", label: "الحالات", item: "حالة", fields: ITEM, max: 6 }] },
  { id: "pricing", label: "الباقات", base: "pricing", fields: [...HEAD, { key: "description", label: "الوصف", kind: "area" }, { key: "note", label: "ملاحظة أسفل الباقات" },
    { key: "monthly", label: "كلمة «شهرياً»" }, { key: "yearly", label: "كلمة «سنوياً»" }, { key: "empty", label: "نص عند عدم وجود باقات", kind: "area" }],
    note: <>الباقات نفسها وأسعارها ومزاياها تُدار من <Link to="/admin/plans">صفحة الباقات</Link>.</> },
  { id: "faq", label: "الأسئلة الشائعة", base: "faq", fields: [...HEAD, { key: "description", label: "الوصف", kind: "area" }],
    lists: [{ key: "items", label: "الأسئلة", item: "سؤال", fields: [{ key: "question", label: "السؤال" }, { key: "answer", label: "الجواب", kind: "area" }], max: 20 }] },
  { id: "cta", label: "الدعوة الختامية", base: "cta", fields: [...HEAD, { key: "description", label: "الوصف", kind: "area" }] },
  { id: "footer", label: "التذييل", base: "footer", fields: [
    { key: "description", label: "نبذة", kind: "area" }, { key: "exploreTitle", label: "عنوان العمود الأول" }, { key: "sectorsTitle", label: "عنوان العمود الثاني" },
    { key: "contactTitle", label: "عنوان التواصل" }, { key: "phone", label: "الجوال" }, { key: "email", label: "البريد" }, { key: "address", label: "العنوان" },
    { key: "linkedin", label: "لينكدإن", kind: "url" }, { key: "instagram", label: "إنستغرام", kind: "url" }, { key: "whatsapp", label: "واتساب", kind: "url", hint: "https://wa.me/966…" },
    { key: "copyright", label: "حقوق النشر" },
  ], lists: [
    { key: "exploreLinks", label: "روابط العمود الأول", item: "رابط", fields: LINK, max: 8 },
    { key: "sectorLinks", label: "روابط العمود الثاني", item: "رابط", fields: LINK, max: 8 },
  ] },
  policy("privacy", "سياسة الخصوصية"), policy("terms", "الشروط والأحكام"), policy("security", "أمن المعلومات"),
];

// Small immutable path helpers over the content object.
type Obj = Record<string, unknown>;
const get = (o: unknown, path: string): unknown => path.split(".").reduce<unknown>((a, k) => (a as Obj | undefined)?.[k], o);
function set<T>(o: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split(".");
  const copy: Obj = Array.isArray(o) ? ([...o] as unknown as Obj) : { ...(o as Obj) };
  copy[head!] = rest.length ? set(copy[head!], rest.join("."), value) : value;
  return copy as T;
}

interface Loaded { content: LandingContent; defaults: LandingContent; customized: boolean; updatedAt: string | null; updatedBy: string | null }

export function AdminLanding() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["admin", "landing"], queryFn: () => api<Loaded>("GET", "/admin/landing-content") });
  const [draft, setDraft] = useState<LandingContent | null>(null);
  const [section, setSection] = useState(SECTIONS[0]!.id);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState(false);

  useEffect(() => { if (q.data && !draft) setDraft(q.data.content); }, [q.data, draft]);
  const dirty = useMemo(() => Boolean(draft && q.data && JSON.stringify(draft) !== JSON.stringify(q.data.content)), [draft, q.data]);
  useBlocker({ shouldBlockFn: () => dirty && !window.confirm("لديك تغييرات لم تُحفظ. تغادر الصفحة وتتركها؟"), enableBeforeUnload: () => dirty });

  async function save() {
    if (!draft) return;
    setBusy(true); setError(null); setErrors({});
    try {
      await api("PUT", "/admin/landing-content", { body: draft });
      await Promise.all([qc.invalidateQueries({ queryKey: ["admin", "landing"] }), qc.invalidateQueries({ queryKey: landingKey })]);
      setDraft(null);
      toast.success("تم نشر التغييرات على الصفحة العامة");
    } catch (e) {
      if (e instanceof ApiError && Object.keys(e.fieldErrors).length) {
        setErrors(e.fieldErrors);
        const first = Object.keys(e.fieldErrors)[0]!;
        const owner = SECTIONS.find((s) => first.startsWith(`${s.base}.`));
        if (owner) setSection(owner.id);
      }
      setError(e);
    } finally { setBusy(false); }
  }
  async function reset() {
    setBusy(true);
    try {
      await api("DELETE", "/admin/landing-content");
      await Promise.all([qc.invalidateQueries({ queryKey: ["admin", "landing"] }), qc.invalidateQueries({ queryKey: landingKey })]);
      setDraft(null); setResetting(false); setErrors({});
      toast.success("عادت الصفحة العامة إلى المحتوى الافتراضي");
    } catch (e) { setError(e); } finally { setBusy(false); }
  }

  if (q.isError) return <div className="page"><ErrorState error={q.error} onRetry={() => q.refetch()} /></div>;
  const s = SECTIONS.find((x) => x.id === section)!;
  const sectionHasError = (x: SectionDef) => Object.keys(errors).some((k) => k.startsWith(`${x.base}.`));

  return (
    <div className="page">
      <PageHeader title="محتوى الصفحة العامة" description={q.data ? (q.data.customized && q.data.updatedAt ? `آخر نشر ${dayTime(q.data.updatedAt)}${q.data.updatedBy ? ` بواسطة ${q.data.updatedBy}` : ""}` : "تعرض الصفحة المحتوى الافتراضي. أي حفظ يُنشر فوراً.") : " "}
        actions={<a href="/" target="_blank" rel="noreferrer" className="btn btn-secondary"><ExternalLink aria-hidden="true" />معاينة الصفحة</a>} />
      {!draft ? <div className="panel panel-pad stack">{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={38} />)}</div> : (
        <form className="lc-layout" noValidate onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <nav className="panel lc-nav" aria-label="أقسام الصفحة العامة">
            {SECTIONS.map((x) => (
              <button key={x.id} type="button" className="side-link" aria-current={x.id === section ? "page" : undefined} onClick={() => setSection(x.id)}>
                {x.label}{sectionHasError(x) && <span className="badge badge-danger" style={{ marginInlineStart: "auto" }}>خطأ</span>}
              </button>
            ))}
          </nav>
          <section className="panel lc-body" aria-labelledby="lc-title">
            <div className="card-head"><h2 id="lc-title">{s.label}</h2></div>
            <div className="card-body stack-lg">
              {s.note && <p className="banner banner-info lc-note">{s.note}</p>}
              <div className="form-grid">
                {s.fields.map((f) => <FieldEditor key={f.key} f={f} path={`${s.base}.${f.key}`} draft={draft} setDraft={setDraft} errors={errors} />)}
              </div>
              {s.lists?.map((l) => <ListEditor key={l.key} l={l} path={`${s.base}.${l.key}`} draft={draft} setDraft={setDraft} errors={errors} />)}
            </div>
          </section>
          <div className="lc-bar panel">
            <Button type="submit" variant="primary" loading={busy} loadingText="جارٍ النشر…" disabled={!dirty}>نشر التغييرات</Button>
            {dirty && <Button onClick={() => { setDraft(q.data!.content); setErrors({}); setError(null); }}>تجاهل التغييرات</Button>}
            <span className="muted" role="status">{dirty ? "تغييرات غير منشورة" : "كل التغييرات منشورة"}</span>
            <span className="spacer" />
            {q.data?.customized && <Button variant="ghost" destructive icon={<RotateCcw />} onClick={() => setResetting(true)}>استعادة المحتوى الافتراضي</Button>}
          </div>
          <div className="lc-error"><FormError error={error} /></div>
        </form>
      )}
      <ConfirmDialog open={resetting} onClose={() => setResetting(false)} onConfirm={() => void reset()} busy={busy}
        title="استعادة المحتوى الافتراضي" confirmLabel="استعادة الافتراضي ونشره"
        message="سيُحذف كل ما عدّلته في نصوص الصفحة العامة وسياساتها، ويُنشر المحتوى الافتراضي فوراً. الباقات لا تتأثر." />
    </div>
  );
}

function FieldEditor({ f, path, draft, setDraft, errors }: { f: Field; path: string; draft: LandingContent; setDraft: (d: LandingContent) => void; errors: Record<string, string> }) {
  const raw = get(draft, path);
  const err = Object.entries(errors).find(([k]) => k === path || k.startsWith(`${path}.`))?.[1];
  if (f.kind === "lines") {
    const value = Array.isArray(raw) ? (raw as string[]).join("\n") : "";
    return <div className="lc-wide"><TextAreaField label={f.label} hint={f.hint} value={value} rows={4} error={err} onChange={(e) => setDraft(set(draft, path, e.target.value.split("\n")))} onBlur={(e) => setDraft(set(draft, path, e.target.value.split("\n").map((x) => x.trim()).filter(Boolean)))} /></div>;
  }
  const value = typeof raw === "string" ? raw : "";
  if (f.kind === "area" || f.kind === "long") {
    return <div className="lc-wide"><TextAreaField label={f.label} hint={f.hint} value={value} rows={f.kind === "long" ? 14 : 3} error={err} onChange={(e) => setDraft(set(draft, path, e.target.value))} /></div>;
  }
  return <TextField label={f.label} hint={f.hint} value={value} error={err} dir={f.kind === "url" ? "ltr" : undefined} onChange={(e) => setDraft(set(draft, path, e.target.value))} />;
}

function ListEditor({ l, path, draft, setDraft, errors }: { l: ListDef; path: string; draft: LandingContent; setDraft: (d: LandingContent) => void; errors: Record<string, string> }) {
  const items = (get(draft, path) as Obj[] | undefined) ?? [];
  const move = (i: number, d: -1 | 1) => { const n = [...items]; [n[i], n[i + d]] = [n[i + d]!, n[i]!]; setDraft(set(draft, path, n)); };
  return (
    <fieldset className="lc-list">
      <legend>{l.label} <span className="muted num">({items.length}/{l.max})</span></legend>
      {items.map((_, i) => (
        <div key={i} className="lc-item">
          <div className="lc-item-head">
            <strong>{l.item} {i + 1}</strong>
            <span className="spacer" />
            {!l.fixed && <>
              <IconButton size="sm" label={`تحريك ${l.item} ${i + 1} للأعلى`} icon={<ArrowUp />} disabled={i === 0} onClick={() => move(i, -1)} />
              <IconButton size="sm" label={`تحريك ${l.item} ${i + 1} للأسفل`} icon={<ArrowDown />} disabled={i === items.length - 1} onClick={() => move(i, 1)} />
              <IconButton size="sm" destructive label={`حذف ${l.item} ${i + 1}`} icon={<Trash2 />} onClick={() => setDraft(set(draft, path, items.filter((__, n) => n !== i)))} />
            </>}
          </div>
          <div className="form-grid">
            {l.fields.map((f) => <FieldEditor key={f.key} f={f} path={`${path}.${i}.${f.key}`} draft={draft} setDraft={setDraft} errors={errors} />)}
          </div>
        </div>
      ))}
      {!l.fixed && items.length < l.max && (
        <Button size="sm" icon={<Plus />} onClick={() => setDraft(set(draft, path, [...items, Object.fromEntries(l.fields.map((f) => [f.key, ""]))]))}>إضافة {l.item}</Button>
      )}
    </fieldset>
  );
}
