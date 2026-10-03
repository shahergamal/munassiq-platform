import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FileUp, Plus, Radio, Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError, api } from "../../api/client";
import { useInvalidate, useTenant } from "../../app/tenant";
import { day, integer, isoDay, money, percent, quantity } from "../../lib/format";
import { Button } from "../../ui/Button";
import { DataTable } from "../../ui/DataTable";
import { Dialog } from "../../ui/Dialog";
import { SearchInput, SelectField, TextField } from "../../ui/Field";
import { Badge, PageHeader, StatCard } from "../../ui/Layout";
import { EmptyState, ErrorState, FormError } from "../../ui/States";
import { useToast } from "../../ui/Toast";
import { StatusTabs } from "./Inventory";

// Contracting C11: the telecom rollout. A TELECOM_SITE project's sites, their scope from the main contract's rate
// card, their state on the rollout (PAC/FAC with certificates) and what each is billable at under the contract's
// milestone terms. The IPC is filled from here ("fill from sites" on a draft IPC); billing stays on the IPC.

interface Project { id: string; code: string; name: string; status: string; specialty?: string; specialtyName: string }
interface Site { id: string; code: string; name: string; region: string | null; siteType: string; status: string; statusDate: string; holdReason: string | null; pacRef: string | null;
  facRef: string | null; contractId: string | null; contractNumber: string | null; value: number; items: number; billableShare: number; billable: number; daysInStatus: number }
interface SitesResp { items: Site[]; byStatus: Record<string, number>; onHold: number; totals: { value: number; billable: number } }
interface SiteDetail { id: string; code: string; name: string; status: string; contractId: string | null; items: { boqItemId: string; code: string; description: string; unit: string; rate: number; quantity: number }[];
  events: { from: string | null; to: string; date: string; reference: string | null; note: string | null }[]; rateCard: { id: string; code: string; description: string; unit: string; rate: number }[] }

const FLOW = ["planned", "survey", "permitting", "civil", "installation", "on_air", "pac", "fac"] as const;
const STATUS: Record<string, string> = { planned: "مخطط", survey: "مسح", permitting: "تصاريح وتأجير", civil: "أعمال مدنية", installation: "تركيب", on_air: "تشغيل",
  pac: "استلام ابتدائي", fac: "استلام نهائي", cancelled: "ملغى" };
const TYPES: Record<string, string> = { greenfield: "أرضي", rooftop: "سطح", indoor: "داخلي", small_cell: "خلية صغيرة", fiber: "ألياف", upgrade: "تحديث" };
const MILESTONE: Record<string, string> = { installation: "التركيب", on_air: "التشغيل", pac: "الاستلام الابتدائي", fac: "الاستلام النهائي" };
const tone = (s: string) => (s === "fac" ? "success" : s === "pac" || s === "on_air" ? "info" : s === "cancelled" ? "neutral" : "warning") as "success" | "info" | "neutral" | "warning";
const Ref = ({ children }: { children: string }) => <bdi dir="ltr" className="num">{children}</bdi>;

export function TelecomSitesPage() {
  const { tenantId, can, writable } = useTenant();
  const projects = useQuery({ queryKey: ["t", tenantId, "contracting", "projects"], queryFn: () => api<{ items: Project[] }>("GET", "/t/projects", { tenant: tenantId }) });
  const telecom = (projects.data?.items ?? []).filter((p) => p.specialty === "TELECOM_SITE");
  const key = `mn.telecom.project.${tenantId}`;
  const [projectId, setProjectId] = useState(() => { try { return sessionStorage.getItem(key) ?? ""; } catch { return ""; } });
  useEffect(() => { if (telecom.length && !telecom.some((p) => p.id === projectId)) setProjectId(telecom[0]!.id); }, [telecom, projectId]);
  const pick = (v: string) => { setProjectId(v); try { sessionStorage.setItem(key, v); } catch { /* private mode */ } };
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const q = useQuery({ enabled: Boolean(projectId), queryKey: ["t", tenantId, "contracting", "sites", projectId, status, search],
    queryFn: () => api<SitesResp>("GET", `/t/projects/${projectId}/sites`, { tenant: tenantId, query: { status: status === "all" ? undefined : status, q: search || undefined } }) });
  const contracts = useQuery({ enabled: Boolean(projectId), queryKey: ["t", tenantId, "contracting", "project", projectId],
    queryFn: () => api<{ contracts: { id: string; number: string; title: string; role: string; status: string }[] }>("GET", `/t/projects/${projectId}`, { tenant: tenantId }) });
  const mains = (contracts.data?.contracts ?? []).filter((c) => c.role === "MAIN");
  const [dialog, setDialog] = useState<"new" | "import" | "terms" | null>(null);
  const [scope, setScope] = useState<Site | null>(null);
  const [moving, setMoving] = useState<Site | null>(null);
  const [editing, setEditing] = useState<Site | null>(null);
  const edit = can("telecom_sites.create") && writable;
  const d = q.data;
  return (
    <div className="page">
      <PageHeader eyebrow="المقاولات" title="مواقع الاتصالات"
        description="حالة كل موقع على مسار النشر من المسح حتى الاستلام النهائي، ونطاقه من جدول أسعار العقد، وما يستحق فوترته بشروط المراحل. الفوترة نفسها من مستخلص العقد: «تعبئة من المواقع»."
        actions={projectId && writable ? <>
          {can("telecom_sites.terms") && mains.length > 0 && <Button onClick={() => setDialog("terms")}>شروط الفوترة</Button>}
          {edit && <Button icon={<FileUp />} onClick={() => setDialog("import")}>استيراد من Excel</Button>}
          {edit && <Button variant="primary" icon={<Plus />} onClick={() => setDialog("new")}>موقع جديد</Button>}</> : undefined} />
      {projects.isError ? <ErrorState error={projects.error} onRetry={() => void projects.refetch()} /> : projects.data && !telecom.length ?
        <EmptyState title="لا مشاريع اتصالات">أنشئ مشروعاً بتخصص «اتصالات (بالموقع)» من «المشاريع والعقود»، وعقده الرئيسي بنموذج تسعير «جدول أسعار»، ثم أضف المواقع هنا.</EmptyState> : <>
        <div className="toolbar row" style={{ gap: "var(--sp-2)", alignItems: "end" }}>
          <SelectField label="المشروع" value={projectId} onChange={(e) => pick(e.target.value)} options={telecom.map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))} />
          <SearchInput label="بحث في المواقع" value={search} onChange={setSearch} placeholder="الرمز أو الاسم" />
        </div>
        <div className="stats">
          <StatCard label="المواقع" value={d ? integer(Object.values(d.byStatus).reduce((a, n) => a + n, 0) - (d.byStatus.cancelled ?? 0)) : "—"} icon={<Radio />} hue="indigo"
            note={d ? `${integer(d.onHold)} موقوف · ${integer(d.byStatus.cancelled ?? 0)} ملغى` : undefined} noteTone={d?.onHold ? "warning" : undefined} />
          <StatCard label="على الهواء" value={d ? integer((d.byStatus.on_air ?? 0) + (d.byStatus.pac ?? 0) + (d.byStatus.fac ?? 0)) : "—"} icon={<Radio />} hue="sky"
            note={d ? `${integer(d.byStatus.pac ?? 0)} ابتدائي · ${integer(d.byStatus.fac ?? 0)} نهائي` : undefined} />
          <StatCard label="قيمة النطاق" value={d ? money(d.totals.value) : "—"} icon={<Wallet />} hue="violet" />
          <StatCard label="المستحق فوترته" value={d ? money(d.totals.billable) : "—"} icon={<Wallet />} hue="green" note="بشروط المراحل حتى اليوم" />
        </div>
        <section className="panel" aria-label="المواقع">
          <div className="toolbar"><StatusTabs value={status} onChange={setStatus} options={[["all", "الكل"], ...[...FLOW, "cancelled"].map((s) => [s, `${STATUS[s]}${d ? ` ${d.byStatus[s] ?? 0}` : ""}`] as [string, string])]} /></div>
          <DataTable caption="المواقع" query={q.data ? { ...q, data: { items: q.data.items } } : q} rowKey={(r) => r.id}
            empty={search || status !== "all" ? { title: "لا مواقع مطابقة", body: "غيّر البحث أو الحالة." } : { title: "لا مواقع بعد", body: "أضف المواقع واحداً واحداً أو استوردها من Excel: الرمز، الاسم، المنطقة، النوع، خط العرض، خط الطول." }}
            columns={[
              { key: "code", header: "الموقع", cell: (r) => <span className="stack-tight"><strong><Ref>{r.code}</Ref></strong><span className="muted acc-small">{r.name}{r.region ? ` · ${r.region}` : ""} · {TYPES[r.siteType]}</span></span> },
              { key: "status", header: "الحالة", cell: (r) => <span className="stack-tight"><Badge tone={tone(r.status)}>{STATUS[r.status]}</Badge>
                <span className="muted acc-small">{day(r.statusDate)} · {integer(r.daysInStatus)} يوم</span>{r.holdReason && <Badge tone="warning">موقوف: {r.holdReason}</Badge>}
                {r.pacRef && <span className="muted acc-small">PAC <Ref>{r.pacRef}</Ref>{r.facRef && <> · FAC <Ref>{r.facRef}</Ref></>}</span>}</span> },
              { key: "contractNumber", header: "العقد", cell: (r) => r.contractNumber ? <Ref>{r.contractNumber}</Ref> : <span className="muted">بلا عقد</span> },
              { key: "value", header: "قيمة النطاق", numeric: true, cell: (r) => r.items ? money(r.value) : <span className="muted">بلا بنود</span> },
              { key: "billable", header: "المستحق", numeric: true, cell: (r) => r.billable ? <span className="stack-tight">{money(r.billable)}<span className="muted acc-small">{percent(r.billableShare * 100)}</span></span> : "—" },
            ]}
            actions={writable ? (r) => <>
              {edit && !["fac", "cancelled"].includes(r.status) && <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>تعديل</Button>}
              {edit && <Button size="sm" variant="ghost" onClick={() => setScope(r)}>{["on_air", "pac", "fac", "cancelled"].includes(r.status) ? "النطاق والسجل" : "النطاق"}</Button>}
              {can("telecom_sites.advance") && !["fac", "cancelled"].includes(r.status) && <Button size="sm" variant="ghost" onClick={() => setMoving(r)}>نقل الحالة</Button>}</> : undefined} />
        </section>
      </>}
      {dialog === "new" && <SiteDialog projectId={projectId} contracts={mains} onClose={() => setDialog(null)} />}
      {dialog === "import" && <ImportDialog projectId={projectId} contracts={mains} onClose={() => setDialog(null)} />}
      {dialog === "terms" && <TermsDialog contracts={mains} onClose={() => setDialog(null)} />}
      {scope && <ScopeDialog site={scope} onClose={() => setScope(null)} />}
      {moving && <AdvanceDialog site={moving} onClose={() => setMoving(null)} />}
      {editing && <EditSiteDialog site={editing} contracts={mains} onClose={() => setEditing(null)} />}
    </div>
  );
}

type Main = { id: string; number: string; title: string };

function EditSiteDialog({ site, contracts, onClose }: { site: Site; contracts: Main[]; onClose: () => void }) {
  const { tenantId } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const billed = ["on_air", "pac", "fac"].includes(site.status);
  const [v, setV] = useState({ name: site.name, region: site.region ?? "", siteType: site.siteType, contractId: site.contractId ?? "", holdReason: site.holdReason ?? "" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true); setError(null);
    try {
      await api("PUT", `/t/telecom-sites/${site.id}`, { tenant: tenantId, body: { name: v.name, region: v.region || null, siteType: v.siteType, contractId: v.contractId || null, holdReason: v.holdReason || null } });
      await invalidate("contracting"); onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title={`تعديل ${site.code}`}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">حفظ</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <div className="form-grid">
        <TextField label="الاسم" required value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} maxLength={120} />
        <TextField label="المنطقة" optional value={v.region} onChange={(e) => setV({ ...v, region: e.target.value })} maxLength={80} />
        <SelectField label="النوع" required value={v.siteType} onChange={(e) => setV({ ...v, siteType: e.target.value })} options={Object.entries(TYPES).map(([value, label]) => ({ value, label }))} />
        <SelectField label="العقد" optional disabled={billed} value={v.contractId} onChange={(e) => setV({ ...v, contractId: e.target.value })} placeholder="—"
          options={contracts.map((c) => ({ value: c.id, label: `${c.number} · ${c.title}` }))} hint={billed ? "لا يتغير عقد موقع بدأت فوترته." : undefined} />
      </div>
      <TextField label="سبب الإيقاف" optional value={v.holdReason} onChange={(e) => setV({ ...v, holdReason: e.target.value })} maxLength={300}
        hint="موقع متوقف (رفض المالك، انتظار تصريح…): اكتب السبب ليظهر في المتابعة، وامسحه حين يُستأنف. نقل الحالة يمسحه." />
      <FormError error={error} />
    </Dialog>
  );
}

function SiteDialog({ projectId, contracts, onClose }: { projectId: string; contracts: Main[]; onClose: () => void }) {
  const { tenantId } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [v, setV] = useState({ code: "", name: "", region: "", siteType: "rooftop", latitude: "", longitude: "", contractId: contracts[0]?.id ?? "" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true); setError(null);
    try {
      await api("POST", `/t/projects/${projectId}/sites`, { tenant: tenantId, body: { code: v.code.trim(), name: v.name, region: v.region || null, siteType: v.siteType,
        latitude: v.latitude ? Number(v.latitude) : null, longitude: v.longitude ? Number(v.longitude) : null, contractId: v.contractId || null } });
      toast.success(`أُضيف الموقع ${v.code}`); await invalidate("contracting"); onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title="موقع جديد"
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">إضافة الموقع</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <div className="form-grid">
        <TextField label="رمز الموقع" required dir="ltr" value={v.code} onChange={(e) => setV({ ...v, code: e.target.value })} maxLength={40} placeholder="RUH-0457" />
        <TextField label="الاسم" required value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} maxLength={120} />
        <SelectField label="النوع" required value={v.siteType} onChange={(e) => setV({ ...v, siteType: e.target.value })} options={Object.entries(TYPES).map(([value, label]) => ({ value, label }))} />
        <TextField label="المنطقة" optional value={v.region} onChange={(e) => setV({ ...v, region: e.target.value })} maxLength={80} />
        <TextField label="خط العرض" optional numeric inputMode="decimal" dir="ltr" value={v.latitude} onChange={(e) => setV({ ...v, latitude: e.target.value })} />
        <TextField label="خط الطول" optional numeric inputMode="decimal" dir="ltr" value={v.longitude} onChange={(e) => setV({ ...v, longitude: e.target.value })} />
      </div>
      <SelectField label="العقد" optional value={v.contractId} onChange={(e) => setV({ ...v, contractId: e.target.value })} placeholder="—"
        options={contracts.map((c) => ({ value: c.id, label: `${c.number} · ${c.title}` }))} hint="بنود الموقع من جدول أسعار هذا العقد، وعليه يُفوتر." />
      <FormError error={error} />
    </Dialog>
  );
}

function ImportDialog({ projectId, contracts, onClose }: { projectId: string; contracts: Main[]; onClose: () => void }) {
  const { tenantId } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [contractId, setContractId] = useState(contracts[0]?.id ?? "");
  const [error, setError] = useState<unknown>(null);
  const [rows, setRows] = useState<{ row: number; message: string }[]>([]);
  const [busy, setBusy] = useState(false);
  async function upload() {
    if (!file) return setError(new Error("اختر ملف Excel بصيغة ‎.xlsx"));
    if (file.size > 5 * 1024 * 1024) return setError(new Error("حجم الملف أكبر من 5 ميجابايت"));
    setBusy(true); setError(null); setRows([]);
    const fd = new FormData();
    fd.append("file", file);
    try {
      const r = await api<{ sites: number }>("POST", `/t/projects/${projectId}/sites/import`, { tenant: tenantId, body: fd, query: contractId ? { contractId } : {} });
      toast.success(`استُورد ${integer(r.sites)} موقع`); await invalidate("contracting"); onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === "import_invalid") setRows(((e.details as { errors?: { row: number; message: string }[] })?.errors) ?? []);
      setError(e);
    } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} title="استيراد المواقع من Excel"
      footer={<><Button variant="primary" icon={<FileUp />} onClick={() => void upload()} loading={busy} loadingText="جارٍ الفحص والاستيراد…">استيراد الملف</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <p className="muted">الصف الأول عناوين، ثم الأعمدة بالترتيب: الرمز، الاسم، المنطقة، النوع (سطح، أرضي، داخلي، خلية صغيرة، ألياف، تحديث)، خط العرض، خط الطول. إن وُجد صف خاطئ لا يُستورد شيء.</p>
      <div className="field">
        <label className="field-label" htmlFor="sites-file">ملف Excel ‎(.xlsx)</label>
        <input id="sites-file" className="input" type="file" accept=".xlsx" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(null); setRows([]); }} style={{ paddingBlock: "var(--sp-1)" }} />
      </div>
      <SelectField label="العقد" optional value={contractId} onChange={(e) => setContractId(e.target.value)} placeholder="—" options={contracts.map((c) => ({ value: c.id, label: `${c.number} · ${c.title}` }))} />
      <FormError error={error} />
      {rows.length > 0 && <div className="table-wrap panel"><table className="data-table"><caption className="sr-only">الصفوف غير الصالحة</caption>
        <thead><tr><th scope="col">الصف</th><th scope="col">المشكلة</th></tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}><td className="num">{r.row}</td><td className="wrap">{r.message}</td></tr>)}</tbody></table></div>}
    </Dialog>
  );
}

function TermsDialog({ contracts, onClose }: { contracts: Main[]; onClose: () => void }) {
  const { tenantId } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const [contractId, setContractId] = useState(contracts[0]?.id ?? "");
  const q = useQuery({ enabled: Boolean(contractId), queryKey: ["t", tenantId, "contracting", "milestone-terms", contractId],
    queryFn: () => api<{ items: { milestone: string; pct: number }[]; locked: boolean }>("GET", `/t/contracts/${contractId}/milestone-terms`, { tenant: tenantId }) });
  const [v, setV] = useState<Record<string, string> | null>(null);
  useEffect(() => { if (q.data) setV(Object.fromEntries(Object.keys(MILESTONE).map((m) => [m, String(q.data.items.find((i) => i.milestone === m)?.pct ?? "")]))); }, [q.data]);
  const total = v ? Object.values(v).reduce((a, x) => a + (Number(x) || 0), 0) : 0;
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!v) return;
    if (Math.round(total * 100) !== 10_000) return setError(new Error(`مجموع النسب ${total}% ويجب أن يكون 100%`));
    setBusy(true); setError(null);
    try {
      await api("PUT", `/t/contracts/${contractId}/milestone-terms`, { tenant: tenantId, body: { items: Object.entries(v).filter(([, x]) => Number(x) > 0).map(([milestone, x]) => ({ milestone, pct: Number(x) })) } });
      toast.success("حُفظت شروط الفوترة"); await invalidate("contracting"); onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  const locked = q.data?.locked ?? false;
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title="شروط الفوترة بالمراحل"
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…" disabled={locked || !v}>حفظ الشروط</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      {contracts.length > 1 && <SelectField label="العقد" value={contractId} onChange={(e) => { setContractId(e.target.value); setV(null); }} options={contracts.map((c) => ({ value: c.id, label: `${c.number} · ${c.title}` }))} />}
      <p className="muted">نسبة قيمة الموقع التي تُفوتر عند بلوغ كل مرحلة، ومجموعها 100%. {locked ? "اعتُمد مستخلص بهذه الشروط فلا تتغير من هنا." : "تثبت بعد اعتماد أول مستخلص."}</p>
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {v && <div className="form-grid">{Object.entries(MILESTONE).map(([m, label]) => (
        <TextField key={m} label={`${label} (%)`} optional numeric inputMode="decimal" dir="ltr" disabled={locked} value={v[m] ?? ""} onChange={(e) => setV({ ...v, [m]: e.target.value })} />
      ))}</div>}
      <p className={Math.round(total * 100) === 10_000 ? "muted" : "field-error"}>المجموع {percent(total)}</p>
      <FormError error={error} />
    </Dialog>
  );
}

function ScopeDialog({ site, onClose }: { site: Site; onClose: () => void }) {
  const { tenantId } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const q = useQuery({ queryKey: ["t", tenantId, "contracting", "site", site.id], queryFn: () => api<SiteDetail>("GET", `/t/telecom-sites/${site.id}`, { tenant: tenantId }) });
  const frozen = ["on_air", "pac", "fac", "cancelled"].includes(site.status);
  const [qty, setQty] = useState<Record<string, string> | null>(null);
  useEffect(() => { if (q.data && !qty) setQty(Object.fromEntries(q.data.items.map((i) => [i.boqItemId, String(i.quantity)]))); }, [q.data, qty]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const total = q.data && qty ? q.data.rateCard.reduce((a, r) => a + (Number(qty[r.id]) || 0) * r.rate, 0) : 0;
  async function submit() {
    if (!qty) return;
    setBusy(true); setError(null);
    try {
      await api("PUT", `/t/telecom-sites/${site.id}/items`, { tenant: tenantId, body: { items: Object.entries(qty).filter(([, v]) => Number(v) > 0).map(([boqItemId, v]) => ({ boqItemId, quantity: Number(v) })) } });
      toast.success(`حُفظ نطاق ${site.code}`); await invalidate("contracting"); onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  const d = q.data;
  return (
    <Dialog open onClose={onClose} busy={busy} wide onSubmit={frozen ? undefined : () => void submit()} title={`${site.code} · ${site.name}`}
      footer={frozen ? <Button onClick={onClose}>إغلاق</Button> : <><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…" disabled={!d?.rateCard.length}>حفظ النطاق</Button>
        <Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {d && !d.contractId && <p className="field-error">الموقع غير مربوط بعقد: اربطه من «تعديل» لتظهر بنود جدول الأسعار.</p>}
      {d && qty && d.rateCard.length > 0 && <>
        <p className="muted">{frozen ? "النطاق ثابت بعد التشغيل: ما فوتر لا يتغير." : "الكميات من جدول أسعار العقد. اترك البند فارغاً إن لم يكن في نطاق الموقع."} القيمة {money(total)}.</p>
        <div className="table-wrap"><table className="data-table"><caption className="sr-only">نطاق الموقع</caption>
          <thead><tr><th scope="col">البند</th><th scope="col">الوحدة</th><th scope="col" className="num">السعر</th><th scope="col" className="num">الكمية</th></tr></thead>
          <tbody>{d.rateCard.map((r) => <tr key={r.id}><td className="wrap"><Ref>{r.code}</Ref> {r.description}</td><td>{r.unit}</td><td className="num">{money(r.rate)}</td>
            <td className="num">{frozen ? quantity(Number(qty[r.id] || 0)) : <input className="input input-sm num" dir="ltr" inputMode="decimal" aria-label={`كمية ${r.code}`} style={{ maxWidth: "8rem" }}
              value={qty[r.id] ?? ""} onChange={(e) => setQty({ ...qty, [r.id]: e.target.value })} />}</td></tr>)}</tbody></table></div>
      </>}
      {d && d.events.length > 0 && <>
        <h3 className="panel-title">السجل</h3>
        <ul className="stack-tight">{d.events.map((e, i) => <li key={i} className="acc-small">{day(e.date)}: {e.from ? `${STATUS[e.from]} ← ` : ""}{STATUS[e.to]}{e.reference ? ` · ${e.reference}` : ""}{e.note ? ` · ${e.note}` : ""}</li>)}</ul>
      </>}
      <FormError error={error} />
    </Dialog>
  );
}

function AdvanceDialog({ site, onClose }: { site: Site; onClose: () => void }) {
  const { tenantId } = useTenant();
  const invalidate = useInvalidate(tenantId);
  const toast = useToast();
  const at = FLOW.indexOf(site.status as (typeof FLOW)[number]);
  const options = [
    ...FLOW.filter((s, i) => i > at && (s !== "pac" || site.status === "on_air") && (s !== "fac" || site.status === "pac") && (i <= FLOW.indexOf("on_air") || s === FLOW[at + 1])),
    ...(at < FLOW.indexOf("on_air") ? ["cancelled"] : [])];
  const [v, setV] = useState({ to: options[0] ?? "", date: isoDay(), reference: "", note: "" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true); setError(null);
    try {
      await api("POST", `/t/telecom-sites/${site.id}/advance`, { tenant: tenantId, body: { to: v.to, date: v.date, reference: v.reference || null, note: v.note || null } });
      toast.success(`${site.code}: ${STATUS[v.to]}`); await invalidate("contracting"); onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  const needsRef = v.to === "pac" || v.to === "fac";
  return (
    <Dialog open onClose={onClose} busy={busy} onSubmit={() => void submit()} title={`نقل حالة ${site.code}`}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…" disabled={!v.to}>{v.to === "cancelled" ? "إلغاء الموقع" : "نقل الحالة"}</Button><Button onClick={onClose} disabled={busy}>رجوع</Button></>}>
      <p className="muted">الحالة الآن {STATUS[site.status]} منذ {day(site.statusDate)}. الحالة تتقدم ولا ترجع، والخطوات التي لا تنطبق على الموقع تُتخطى حتى التشغيل.</p>
      <div className="form-grid">
        <SelectField label="إلى" required value={v.to} onChange={(e) => setV({ ...v, to: e.target.value })} options={options.map((s) => ({ value: s, label: STATUS[s]! }))} />
        <TextField label="التاريخ" required type="date" dir="ltr" max={isoDay()} value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} />
        {needsRef && <TextField label={v.to === "pac" ? "رقم شهادة الاستلام الابتدائي" : "رقم شهادة الاستلام النهائي"} required dir="ltr" value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} maxLength={80} />}
      </div>
      <TextField label={v.to === "cancelled" ? "سبب الإلغاء" : "ملاحظة"} required={v.to === "cancelled"} optional={v.to !== "cancelled"} value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} maxLength={500} />
      {["on_air", "pac", "fac"].includes(v.to) && <p className="muted acc-small">ببلوغ هذه المرحلة تدخل نسبتها من قيمة الموقع في المستخلص التالي (شروط الفوترة).</p>}
      <FormError error={error} />
      <p className="muted acc-small">العقد: {site.contractNumber ?? "—"} · <Link to="/w/$tenantId/contracting/projects" params={{ tenantId }}>المشاريع والعقود</Link></p>
    </Dialog>
  );
}
