import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Cloud, Cpu, Database, HardDrive, MemoryStick, Plus, RefreshCw, Rocket, RotateCcw, ShieldBan, ShieldCheck, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";
import { api, type Page } from "../../api/client";
import { dayTime, integer, money } from "../../lib/format";
import { Button } from "../../ui/Button";
import { DataTable } from "../../ui/DataTable";
import { ConfirmDialog, Dialog } from "../../ui/Dialog";
import { focusFirstInvalid, TextAreaField, TextField } from "../../ui/Field";
import { Badge, PageHeader, StatCard } from "../../ui/Layout";
import { ErrorState, FormError, TableSkeleton } from "../../ui/States";
import { useToast } from "../../ui/Toast";
import { StatusTabs } from "../workspace/Inventory";

/**
 * Platform operations for a non-developer owner: is the server healthy, publish the latest version (the hosting
 * platform builds it), restart, clear Cloudflare's cache, and block addresses that attack the site. Every button
 * says what it will do before doing it; a feature whose variables are missing says which ones.
 */

interface Stats {
  host: string; platform: string; node: string; commit: string | null; environment: string;
  uptime: { server: number; process: number };
  cpu: { cores: number; load: number[]; model: string };
  memory: { totalBytes: number; freeBytes: number; processRss: number; heapUsed: number };
  disk: { totalBytes: number; freeBytes: number } | null;
  database: { sizeBytes: number; connections: number; version: string; appPool: { total: number; idle: number; waiting: number } };
  features: { cloudflare: boolean; deploy: boolean; restart: boolean };
}
interface Suspicious { ip: string; events: number; loginFailed: number; rateLimited: number; other: number; firstAt: string; lastAt: string }
interface Block { id: string; value: string; target: string; notes: string | null; createdAt: string | null }

export const bytes = (n: number | null | undefined) => {
  if (n === null || n === undefined) return "—";
  const u = ["بايت", "كيلوبايت", "ميجابايت", "جيجابايت", "تيرابايت"];
  let v = n, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toLocaleString("en-US", { maximumFractionDigits: v < 10 && i > 0 ? 1 : 0 })} ${u[i]}`;
};
const duration = (s: number) => {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${integer(d)} يوم و${integer(h)} ساعة` : h ? `${integer(h)} ساعة و${integer(m)} دقيقة` : `${integer(m)} دقيقة`;
};
const pct = (used: number, total: number) => (total ? Math.round((used / total) * 100) : 0);

export function AdminServerPage() {
  const qc = useQueryClient();
  const toast = useToast();
  // Refreshed while the page is open, so a spike shows without reloading.
  const s = useQuery({ queryKey: ["admin", "server"], queryFn: () => api<Stats>("GET", "/admin/server"), refetchInterval: 15_000 });
  const [confirm, setConfirm] = useState<null | "deploy" | "restart">(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function run(kind: "deploy" | "restart") {
    setBusy(true); setError(null);
    try {
      if (kind === "deploy") {
        await api("POST", "/admin/server/deploy");
        toast.success("بدأ نشر التحديث في منصة الاستضافة. يستغرق عادةً من 2 إلى 5 دقائق، والموقع يعمل أثناءها");
      } else {
        await api("POST", "/admin/server/restart");
        toast.success("يُعاد تشغيل الخادم الآن. قد تنقطع الصفحة ثوانيَ ثم تعود");
        setTimeout(() => void qc.invalidateQueries({ queryKey: ["admin", "server"] }), 8000);
      }
      setConfirm(null);
    } catch (e) { setError(e); } finally { setBusy(false); }
  }

  if (s.isPending) return <div className="page"><TableSkeleton columns={4} rows={3} label="جارٍ قراءة حالة الخادم…" /></div>;
  if (s.isError) return <div className="page"><ErrorState error={s.error} title="تعذر قراءة حالة الخادم" onRetry={() => s.refetch()} /></div>;
  const d = s.data;
  const memUsed = d.memory.totalBytes - d.memory.freeBytes;
  const diskUsed = d.disk ? d.disk.totalBytes - d.disk.freeBytes : 0;
  const cpuPct = Math.round((d.cpu.load[0]! / Math.max(1, d.cpu.cores)) * 100);
  const warn = (p: number) => (p >= 90 ? "warning" as const : undefined);

  return (
    <div className="page">
      <PageHeader title="الخادم والحماية" description="حالة الخادم، ونشر التحديثات بضغطة زر، وحماية الموقع عبر Cloudflare. كل إجراء هنا مسجّل في سجل التدقيق."
        actions={<Button variant="primary" icon={<Rocket />} disabled={!d.features.deploy} onClick={() => { setError(null); setConfirm("deploy"); }}>نشر التحديث</Button>} />

      {!d.features.deploy && (
        <p className="banner banner-info" role="status">زر «نشر التحديث» غير مربوط بعد. من منصة الاستضافة (Coolify أو Railway أو Render) انسخ «رابط النشر Deploy Webhook» وضعه في متغير البيئة <bdi dir="ltr">DEPLOY_HOOK_URL</bdi> (والرمز إن وُجد في <bdi dir="ltr">DEPLOY_HOOK_TOKEN</bdi>)، ثم أعد تشغيل الخادم.</p>
      )}

      <div className="stats stats-4">
        <StatCard label="المعالج (آخر دقيقة)" value={`${integer(cpuPct)}%`} icon={<Cpu />} hue="indigo" note={`${integer(d.cpu.cores)} أنوية · حمل ${d.cpu.load.join(" / ")}`} noteTone={warn(cpuPct)} />
        <StatCard label="الذاكرة" value={`${integer(pct(memUsed, d.memory.totalBytes))}%`} icon={<MemoryStick />} hue="sky" note={`${bytes(memUsed)} من ${bytes(d.memory.totalBytes)} · التطبيق ${bytes(d.memory.processRss)}`} noteTone={warn(pct(memUsed, d.memory.totalBytes))} />
        <StatCard label="القرص" value={d.disk ? `${integer(pct(diskUsed, d.disk.totalBytes))}%` : "—"} icon={<HardDrive />} hue="amber" note={d.disk ? `متبقٍ ${bytes(d.disk.freeBytes)} من ${bytes(d.disk.totalBytes)}` : "غير متاح على هذا النظام"} noteTone={d.disk ? warn(pct(diskUsed, d.disk.totalBytes)) : undefined} />
        <StatCard label="قاعدة البيانات" value={bytes(d.database.sizeBytes)} icon={<Database />} hue="green" note={`${integer(d.database.connections)} اتصال${d.database.appPool.waiting ? ` · ${integer(d.database.appPool.waiting)} بانتظار اتصال` : ""}`} noteTone={d.database.appPool.waiting ? "warning" : undefined} />
      </div>

      <section className="panel" aria-labelledby="srv-info">
        <div className="card-head"><span className="ca-head-icon tone-indigo" aria-hidden="true"><Rocket /></span><h2 id="srv-info">التشغيل والإصدار</h2><span className="spacer" />
          <Button variant="ghost" icon={<RotateCcw />} disabled={!d.features.restart} onClick={() => { setError(null); setConfirm("restart"); }}>إعادة تشغيل الخادم</Button>
        </div>
        <div className="card-body">
          <dl className="dl">
            <dt>الإصدار المنشور</dt><dd>{d.commit ? <span className="num" dir="ltr">{d.commit.slice(0, 12)}</span> : <span className="muted">غير معروف (تضعه منصة الاستضافة في SOURCE_COMMIT)</span>}</dd>
            <dt>البيئة</dt><dd>{d.environment === "production" ? <Badge tone="success">الإنتاج</Badge> : <Badge tone="warning">{d.environment}</Badge>}</dd>
            <dt>يعمل منذ</dt><dd>{duration(d.uptime.process)} <span className="muted">(الجهاز منذ {duration(d.uptime.server)})</span></dd>
            <dt>الخادم</dt><dd><span dir="ltr">{d.host}</span> · {d.platform} · Node {d.node} · PostgreSQL {d.database.version}</dd>
          </dl>
          {!d.features.restart && <p className="muted acc-small">إعادة التشغيل متوقفة حتى تضع <bdi dir="ltr">SERVER_RESTART_ENABLED=true</bdi>، وذلك فقط إن كانت منصة الاستضافة تعيد تشغيل الخادم تلقائياً بعد توقفه.</p>}
        </div>
      </section>

      <CloudflareSection enabled={d.features.cloudflare} />

      <ConfirmDialog open={confirm === "deploy"} onClose={() => setConfirm(null)} busy={busy} destructive={false} onConfirm={() => void run("deploy")}
        title="نشر آخر تحديث؟" confirmLabel="نشر التحديث" error={error ? (error as Error).message : undefined}
        message="ستبني منصة الاستضافة آخر نسخة من الكود وتستبدل بها الحالية. يستغرق ذلك عادةً 2 إلى 5 دقائق، ويبقى الموقع يعمل بالنسخة الحالية حتى تجهز الجديدة. إن فشل البناء تبقى النسخة الحالية." />
      <ConfirmDialog open={confirm === "restart"} onClose={() => setConfirm(null)} busy={busy} onConfirm={() => void run("restart")}
        title="إعادة تشغيل الخادم؟" confirmLabel="إعادة التشغيل" error={error ? (error as Error).message : undefined}
        message="يتوقف الخادم بهدوء بعد إنهاء الطلبات الجارية ثم يعود خلال ثوانٍ. من يستخدم النظام في هذه اللحظة قد يرى رسالة انقطاع قصيرة، ولا تضيع أي بيانات محفوظة." />
    </div>
  );
}

function CloudflareSection({ enabled }: { enabled: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [hours, setHours] = useState("24");
  const sus = useQuery({ queryKey: ["admin", "suspicious", hours], placeholderData: keepPreviousData,
    queryFn: () => api<{ items: Suspicious[] }>("GET", "/admin/security/suspicious", { query: { hours, min: 10 } }) });
  const blocks = useQuery({ enabled, queryKey: ["admin", "cf-blocks"], queryFn: () => api<{ items: Block[] }>("GET", "/admin/cloudflare/blocks") });
  const [purging, setPurging] = useState(false);
  const [blocking, setBlocking] = useState<{ ip: string; note: string } | null>(null);
  const [unblocking, setUnblocking] = useState<Block | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin", "cf-blocks"] });

  async function unblock(b: Block) {
    setBusy(true); setError(null);
    try { await api("DELETE", `/admin/cloudflare/blocks/${b.id}`); toast.success(`أُلغي حظر ${b.value}`); setUnblocking(null); await refresh(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  }

  return (
    <>
      <section className="panel" aria-labelledby="cf-h">
        <div className="card-head"><span className="ca-head-icon tone-orange" aria-hidden="true"><Cloud /></span><h2 id="cf-h">Cloudflare</h2><span className="spacer" />
          {enabled ? <Badge tone="success">مربوط</Badge> : <Badge tone="neutral">غير مربوط</Badge>}
        </div>
        <div className="card-body stack">
          {enabled ? (
            <div className="row" style={{ gap: "var(--sp-2)", flexWrap: "wrap" }}>
              <Button icon={<RefreshCw />} onClick={() => setPurging(true)}>مسح الكاش</Button>
              <Button icon={<ShieldBan />} onClick={() => setBlocking({ ip: "", note: "" })}>حظر عنوان IP</Button>
              <span className="muted acc-small">امسح الكاش بعد نشر تحديث إن ظهرت للزوار النسخة القديمة.</span>
            </div>
          ) : (
            <p className="muted">لربط Cloudflare: من لوحة Cloudflare ← My Profile ← API Tokens أنشئ رمزاً بصلاحيتي «Zone: Cache Purge» و«Zone: Firewall Services: Edit» لنطاقك، وضعه في <bdi dir="ltr">CLOUDFLARE_API_TOKEN</bdi>، وضع معرّف النطاق (Zone ID من صفحة Overview) في <bdi dir="ltr">CLOUDFLARE_ZONE_ID</bdi>، ثم أعد تشغيل الخادم.</p>
          )}
        </div>
      </section>

      <section className="panel" aria-labelledby="sus-h">
        <DataTable caption="عناوين مشبوهة" tableId="admin-suspicious" query={sus} rowKey={(r) => r.ip}
          toolbar={<><h2 id="sus-h">عناوين مشبوهة</h2><span className="spacer" /><StatusTabs value={hours} onChange={setHours} options={[["1", "آخر ساعة"], ["24", "آخر 24 ساعة"], ["168", "آخر 7 أيام"]]} /></>}
          empty={{ title: "لا توجد عناوين مشبوهة", body: "يظهر هنا كل عنوان سجّل 10 محاولات دخول فاشلة أو تجاوزات لحد الطلبات أو أكثر في الفترة المختارة." }}
          columns={[
            { key: "ip", header: "العنوان", cell: (r) => <strong className="num" dir="ltr">{r.ip}</strong> },
            { key: "events", header: "إجمالي الأحداث", numeric: true, cell: (r) => integer(r.events) },
            { key: "loginFailed", header: "دخول فاشل", numeric: true, cell: (r) => integer(r.loginFailed) },
            { key: "rateLimited", header: "تجاوز حد الطلبات", numeric: true, cell: (r) => integer(r.rateLimited) },
            { key: "lastAt", header: "آخر محاولة", cell: (r) => dayTime(r.lastAt) },
          ]}
          actions={(r) => enabled ? <Button size="sm" variant="ghost" destructive icon={<ShieldBan />} onClick={() => setBlocking({ ip: r.ip, note: `${integer(r.loginFailed)} محاولة دخول فاشلة و${integer(r.rateLimited)} تجاوز لحد الطلبات` })}>حظر</Button> : null} />
      </section>

      {enabled && (
        <section className="panel" aria-labelledby="blk-h">
          <DataTable caption="العناوين المحظورة" tableId="admin-cf-blocks" query={blocks} rowKey={(r) => r.id}
            toolbar={<h2 id="blk-h">العناوين المحظورة في Cloudflare</h2>}
            empty={{ title: "لا توجد عناوين محظورة", body: "العناوين التي تحظرها من هنا أو من لوحة Cloudflare تظهر في هذه القائمة." }}
            columns={[
              { key: "value", header: "العنوان", cell: (r) => <strong className="num" dir="ltr">{r.value}</strong> },
              { key: "target", header: "النوع", cell: (r) => (r.target === "ip_range" ? "نطاق" : "عنوان واحد") },
              { key: "notes", header: "السبب", wrap: true, cell: (r) => r.notes ?? "—" },
              { key: "createdAt", header: "التاريخ", cell: (r) => dayTime(r.createdAt) },
            ]}
            actions={(r) => <Button size="sm" variant="ghost" onClick={() => { setError(null); setUnblocking(r); }}>إلغاء الحظر</Button>} />
        </section>
      )}

      {purging && <PurgeDialog onClose={() => setPurging(false)} />}
      {blocking && <BlockDialog initial={blocking} onClose={() => setBlocking(null)} onDone={() => { setBlocking(null); void refresh(); }} />}
      <ConfirmDialog open={unblocking !== null} onClose={() => setUnblocking(null)} busy={busy} destructive={false} onConfirm={() => unblocking && void unblock(unblocking)}
        title={`إلغاء حظر ${unblocking?.value ?? ""}؟`} confirmLabel="إلغاء الحظر" error={error ? (error as Error).message : undefined}
        message="سيستطيع هذا العنوان الوصول إلى الموقع مرة أخرى." />
    </>
  );
}

function PurgeDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [files, setFiles] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit() {
    const list = files.split(/\s+/).map((f) => f.trim()).filter(Boolean);
    if (list.some((f) => !/^https?:\/\//.test(f))) return setError("كل رابط يبدأ بـ https://، رابط في كل سطر");
    setBusy(true); setError(null);
    try {
      await api("POST", "/admin/cloudflare/purge", { body: list.length ? { files: list } : {} });
      toast.success(list.length ? `مُسح كاش ${integer(list.length)} رابط` : "مُسح كاش الموقع بالكامل");
      onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} title="مسح كاش Cloudflare" onSubmit={() => void submit()}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ المسح…">{files.trim() ? "مسح هذه الروابط" : "مسح الكاش بالكامل"}</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <p>بعد المسح يجلب Cloudflare أحدث نسخة من الخادم. قد يبطؤ الموقع قليلاً لدقائق حتى يُبنى الكاش من جديد.</p>
      <TextAreaField label="روابط محددة" optional rows={4} dir="ltr" value={files} onChange={(e) => setFiles(e.target.value)} hint="اتركه فارغاً لمسح كل الكاش، أو ضع رابطاً في كل سطر (حتى 30)" />
      <FormError error={error} />
    </Dialog>
  );
}

function BlockDialog({ initial, onClose, onDone }: { initial: { ip: string; note: string }; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const form = useRef<HTMLDivElement>(null);
  const [v, setV] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit() {
    const e: Record<string, string> = {};
    if (!/^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(v.ip.trim())) e.ip = "اكتب عنوان IP مثل 203.0.113.7 أو نطاقاً مثل 203.0.113.0/24";
    if (v.note.trim().length < 3) e.note = "اكتب سبب الحظر ليُعرف لاحقاً";
    setErrors(e);
    if (Object.keys(e).length) return focusFirstInvalid(form.current as unknown as HTMLFormElement);
    setBusy(true); setError(null);
    try { await api("POST", "/admin/cloudflare/blocks", { body: { ip: v.ip.trim(), note: v.note.trim() } }); toast.success(`حُظر ${v.ip.trim()} في Cloudflare`); onDone(); }
    catch (err) { setError(err); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} title="حظر عنوان IP" onSubmit={() => void submit()}
      footer={<><Button type="submit" variant="danger" loading={busy} loadingText="جارٍ الحظر…">حظر العنوان</Button><Button onClick={onClose} disabled={busy} autoFocus>إلغاء</Button></>}>
      <div ref={form} className="stack">
        <p>لن يستطيع هذا العنوان فتح الموقع إطلاقاً حتى تلغي الحظر. لا يمكن حظر عنوانك الحالي.</p>
        <TextField label="العنوان" required dir="ltr" value={v.ip} onChange={(e) => setV({ ...v, ip: e.target.value })} error={errors.ip} />
        <TextField label="السبب" required value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} error={errors.note} />
      </div>
      <FormError error={error} />
    </Dialog>
  );
}

// ── Billing: payments received and storage packages ─────────────────────────────────
interface Payment { id: string; kind: "subscription" | "storage"; description: string; amount: number; status: string; mode: "test" | "live"; createdAt: string; paidAt: string | null; failure: string | null; tenantId: string; companyName: string }
interface Addon { id: string; nameAr: string; sizeMb: number; price: number; isActive: boolean; sortOrder: number; soldCount: number }

export const PAYMENT_STATUS: Record<string, [string, "success" | "info" | "danger" | "neutral"]> = {
  paid: ["مدفوعة", "success"], pending: ["بانتظار الدفع", "info"], failed: ["فشلت", "danger"], expired: ["منتهية", "neutral"], canceled: ["ملغاة", "neutral"],
};
export const mbLabel = (mbv: number) => (mbv >= 1024
  ? `${(mbv / 1024).toLocaleString("en-US", { maximumFractionDigits: 1 })} جيجابايت`
  : `${mbv.toLocaleString("en-US", { maximumFractionDigits: mbv < 10 ? 1 : 0 })} ميجابايت`);

export function AdminBillingPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const payments = useQuery({ queryKey: ["admin", "billing", status, page], placeholderData: keepPreviousData,
    queryFn: () => api<Page<Payment> & { totals: { paid30: number; paidAll: number }; billingEnabled: boolean }>("GET", "/admin/billing/payments", { query: { status: status || undefined, page, pageSize: 25 } }) });
  const addons = useQuery({ queryKey: ["admin", "storage-addons"], queryFn: () => api<{ items: Addon[] }>("GET", "/admin/storage-addons") });
  const [editing, setEditing] = useState<Addon | "new" | null>(null);
  const [measuring, setMeasuring] = useState(false);

  async function recalc() {
    setMeasuring(true);
    try { const r = await api<{ measured: number }>("POST", "/admin/storage/recalculate", { body: {} }); toast.success(`قيست مساحة ${integer(r.measured)} منشأة`); }
    catch (e) { toast.error((e as Error).message); } finally { setMeasuring(false); }
  }

  const t = payments.data?.totals;
  return (
    <div className="page">
      <PageHeader title="المدفوعات والمساحة" description="اشتراكات العملاء ومشتريات المساحة المدفوعة عبر ميسّر، وباقات المساحة الإضافية المعروضة للبيع. يتفعّل كل منها تلقائياً عند تأكيد الدفع."
        actions={<>
          <Button variant="ghost" icon={<RefreshCw />} loading={measuring} loadingText="جارٍ القياس…" onClick={() => void recalc()}>إعادة قياس المساحة</Button>
          <Button variant="primary" icon={<Plus />} onClick={() => setEditing("new")}>باقة مساحة جديدة</Button>
        </>} />
      {payments.data && !payments.data.billingEnabled && (
        <p className="banner banner-warning" role="status"><TriangleAlert aria-hidden="true" />الدفع الإلكتروني للعملاء غير مفعّل: ضع المفتاح السري لحساب ميسّر الخاص بالمنصة في <bdi dir="ltr">PLATFORM_MOYASAR_SECRET_KEY</bdi> ثم أعد تشغيل الخادم.</p>
      )}
      <div className="stats">
        <StatCard label="المحصّل آخر 30 يوماً" value={t ? money(t.paid30) : "…"} icon={<ShieldCheck />} hue="green" note="مدفوعات حقيقية فقط (لا تشمل التجريبية)" />
        <StatCard label="إجمالي المحصّل" value={t ? money(t.paidAll) : "…"} icon={<Database />} hue="indigo" />
      </div>

      <section className="panel">
        <DataTable caption="المدفوعات" tableId="admin-billing" query={payments} rowKey={(r) => r.id} onPageChange={setPage}
          toolbar={<StatusTabs value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={[["", "الكل"], ["paid", "مدفوعة"], ["pending", "بانتظار الدفع"], ["failed", "فشلت"]]} />}
          filtered={Boolean(status)} onClearFilters={() => setStatus("")}
          empty={{ title: "لا توجد مدفوعات بعد", body: "عندما يشترك عميل أو يشتري مساحة من صفحة «الاشتراك والفوترة» تظهر العملية هنا." }}
          columns={[
            { key: "companyName", header: "العميل", cell: (r) => <Link to={`/admin/tenants/${r.tenantId}`}><strong>{r.companyName}</strong></Link> },
            { key: "description", header: "البند", cell: (r) => <>{r.description}{r.mode === "test" && <> <Badge tone="warning">تجريبي</Badge></>}</> },
            { key: "amount", header: "المبلغ", numeric: true, cell: (r) => money(r.amount) },
            { key: "status", header: "الحالة", cell: (r) => { const [l, tone] = PAYMENT_STATUS[r.status] ?? [r.status, "neutral"]; return <Badge tone={tone}>{l}</Badge>; } },
            { key: "createdAt", header: "التاريخ", cell: (r) => dayTime(r.paidAt ?? r.createdAt) },
          ]} />
      </section>

      <section className="panel">
        <DataTable caption="باقات المساحة الإضافية" tableId="admin-addons" query={addons} rowKey={(r) => r.id} onRowClick={(r) => setEditing(r)}
          toolbar={<h2>باقات المساحة الإضافية</h2>}
          empty={{ title: "لا توجد باقات مساحة", body: "أنشئ باقة ليستطيع العملاء شراء مساحة إضافية فوق حد باقتهم.", action: <Button icon={<Plus />} onClick={() => setEditing("new")}>باقة مساحة جديدة</Button> }}
          columns={[
            { key: "nameAr", header: "الباقة", cell: (r) => <strong>{r.nameAr}</strong> },
            { key: "sizeMb", header: "المساحة", numeric: true, cell: (r) => mbLabel(r.sizeMb) },
            { key: "price", header: "السعر", numeric: true, cell: (r) => money(r.price) },
            { key: "soldCount", header: "المبيعات", numeric: true, cell: (r) => integer(r.soldCount) },
            { key: "isActive", header: "الحالة", cell: (r) => (r.isActive ? <Badge tone="success">معروضة</Badge> : <Badge tone="neutral">موقوفة</Badge>) },
          ]} />
      </section>
      {editing && <AddonDialog addon={editing === "new" ? null : editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); void qc.invalidateQueries({ queryKey: ["admin", "storage-addons"] }); }} />}
    </div>
  );
}

function AddonDialog({ addon, onClose, onDone }: { addon: Addon | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [v, setV] = useState({ nameAr: addon?.nameAr ?? "", sizeGb: addon ? String(addon.sizeMb / 1024) : "1", price: addon ? String(addon.price) : "", isActive: addon?.isActive ?? true, sortOrder: String(addon?.sortOrder ?? 0) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function save() {
    const sizeMb = Math.round(Number(v.sizeGb) * 1024);
    if (v.nameAr.trim().length < 2) return setError("اكتب اسم الباقة، مثل: مساحة إضافية 10 جيجابايت");
    if (!(sizeMb >= 10)) return setError("المساحة بالجيجابايت، مثل 1 أو 0.5");
    if (!(Number(v.price) > 0)) return setError("السعر أكبر من صفر");
    setBusy(true); setError(null);
    const body = { nameAr: v.nameAr.trim(), sizeMb, price: Number(v.price), isActive: v.isActive, sortOrder: Math.max(0, Math.round(Number(v.sortOrder) || 0)) };
    try {
      if (addon) await api("PATCH", `/admin/storage-addons/${addon.id}`, { body });
      else await api("POST", "/admin/storage-addons", { body });
      toast.success(`تم حفظ ${body.nameAr}`);
      onDone();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} title={addon ? `تعديل ${addon.nameAr}` : "باقة مساحة جديدة"} onSubmit={() => void save()}
      footer={<><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ الحفظ…">حفظ الباقة</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <TextField label="الاسم" required value={v.nameAr} onChange={(e) => setV({ ...v, nameAr: e.target.value })} />
      <div className="form-grid">
        <TextField label="المساحة (جيجابايت)" required numeric value={v.sizeGb} onChange={(e) => setV({ ...v, sizeGb: e.target.value })} />
        <TextField label="السعر" required numeric value={v.price} onChange={(e) => setV({ ...v, price: e.target.value })} hint="يُدفع مرة واحدة وتُضاف المساحة دائمة" />
        <TextField label="الترتيب" numeric value={v.sortOrder} onChange={(e) => setV({ ...v, sortOrder: e.target.value })} />
      </div>
      <label className="checkbox"><input type="checkbox" checked={v.isActive} onChange={(e) => setV({ ...v, isActive: e.target.checked })} />معروضة للبيع</label>
      <FormError error={error} />
    </Dialog>
  );
}

