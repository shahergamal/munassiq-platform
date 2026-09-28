import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Copy, CreditCard, ExternalLink, Link2, RefreshCw, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";
import { api, type Page } from "../../api/client";
import { useIdempotencyKey } from "../../app/session";
import { useTenant } from "../../app/tenant";
import { dayTime, money } from "../../lib/format";
import { Button, IconButton } from "../../ui/Button";
import { DataTable } from "../../ui/DataTable";
import { ConfirmDialog } from "../../ui/Dialog";
import { focusFirstInvalid } from "../../ui/Field";
import { Badge, PageHeader } from "../../ui/Layout";
import { PasswordField } from "../../ui/PasswordField";
import { ErrorState, FormError, TableSkeleton } from "../../ui/States";
import { useToast } from "../../ui/Toast";
import { StatusTabs } from "./Inventory";

/**
 * Online payments through the workspace's own Moyasar / Tap account. The owner pastes the secret key once; invoices
 * then get payment links, and a paid link records its receipt by itself.
 */

export type Provider = "moyasar" | "tap";
export type LinkStatus = "pending" | "paid" | "failed" | "expired" | "canceled";
interface Connection { provider: Provider; connected: boolean; mode?: "test" | "live"; keyHint?: string; connectedAt?: string; updatedAt?: string; webhooks?: boolean }
export interface PaymentLink {
  id: string; provider: Provider; mode: "test" | "live"; amount: number; url: string; status: LinkStatus; providerStatus: string | null; paymentRef: string | null;
  receiptId: string | null; paidAt: string | null; checkedAt: string | null; createdAt: string; documentId?: string; documentNumber?: string; customerName?: string;
}

export const PROVIDERS: Record<Provider, { name: string; dashboard: string; steps: string }> = {
  moyasar: { name: "ميسّر (Moyasar)", dashboard: "https://dashboard.moyasar.com", steps: "من لوحة ميسّر: الإعدادات ← مفاتيح API ← انسخ المفتاح السري (Secret Key)." },
  tap: { name: "تاب (Tap Payments)", dashboard: "https://businesses.tap.company", steps: "من لوحة تاب: goSell ← API Credentials ← انسخ المفتاح السري (Secret Key)." },
};

export function LinkStatusBadge({ status }: { status: LinkStatus }) {
  if (status === "paid") return <Badge tone="success">مدفوع</Badge>;
  if (status === "pending") return <Badge tone="info">بانتظار الدفع</Badge>;
  if (status === "failed") return <Badge tone="danger">فشل الدفع</Badge>;
  if (status === "expired") return <Badge tone="neutral">منتهي</Badge>;
  return <Badge tone="neutral">ملغى</Badge>;
}

/** Copy / open / check buttons for one link, shared by this page and the invoice page. */
export function LinkActions({ tenantId, link, onChecked }: { tenantId: string; link: PaymentLink; onChecked: () => void }) {
  const { can, writable } = useTenant();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (link.status !== "pending") return null;
  async function check() {
    setBusy(true);
    try {
      const r = await api<{ status: LinkStatus }>("POST", `/t/payments/links/${link.id}/check`, { tenant: tenantId });
      if (r.status === "paid") toast.success("تم الدفع وسُجّل سند القبض تلقائياً");
      else if (r.status === "pending") toast.success("لم يُدفع بعد");
      else toast.error("الرابط لم يعد صالحاً للدفع. أنشئ رابطاً جديداً");
      onChecked();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <span className="row" style={{ gap: "var(--sp-1)" }}>
      <IconButton label="نسخ رابط الدفع" icon={<Copy />} onClick={() => void navigator.clipboard.writeText(link.url).then(() => toast.success("نُسخ الرابط. أرسله للعميل"), () => toast.error("تعذر النسخ. افتح الرابط وانسخه من المتصفح"))} />
      <a className="btn btn-ghost btn-icon" href={link.url} target="_blank" rel="noreferrer" aria-label="فتح صفحة الدفع" title="فتح صفحة الدفع"><ExternalLink aria-hidden="true" /></a>
      {can("acc_receipts.create") && writable && <Button size="sm" variant="ghost" icon={<RefreshCw />} loading={busy} loadingText="جارٍ التحقق…" onClick={() => void check()}>تحقق من الدفع</Button>}
    </span>
  );
}

export function PaymentsPage() {
  const { tenantId, can, writable } = useTenant();
  const qc = useQueryClient();
  const conns = useQuery({ queryKey: ["t", tenantId, "payments", "connections"], queryFn: () => api<{ items: Connection[] }>("GET", "/t/payments/connections", { tenant: tenantId }) });
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(1);
  const links = useQuery({ queryKey: ["t", tenantId, "payments", "links", filter, page], placeholderData: keepPreviousData,
    queryFn: () => api<Page<PaymentLink>>("GET", "/t/payments/links", { tenant: tenantId, query: { status: filter || undefined, page, pageSize: 25 } }) });
  const refresh = () => qc.invalidateQueries({ queryKey: ["t", tenantId] });

  if (conns.isPending) return <div className="page"><TableSkeleton columns={3} rows={3} label="جارٍ تحميل بوابات الدفع…" /></div>;
  if (conns.isError) return <div className="page"><ErrorState error={conns.error} title="تعذر تحميل بوابات الدفع" onRetry={() => conns.refetch()} /></div>;
  const items = conns.data.items;
  const testing = items.filter((c) => c.connected && c.mode === "test");
  const noWebhooks = items.some((c) => c.connected && !c.webhooks);

  return (
    <div className="page">
      <PageHeader eyebrow="الحسابات" title="بوابات الدفع الإلكتروني"
        description="اربط حساب منشأتك في ميسّر أو تاب، ثم أرسل لعملائك رابط دفع لأي فاتورة آجلة. المبالغ تذهب مباشرة إلى حسابك في البوابة، وعند الدفع يُسجَّل سند القبض والقيد تلقائياً." />

      {testing.length > 0 && (
        <p className="banner banner-warning" role="status"><TriangleAlert aria-hidden="true" />{testing.map((c) => PROVIDERS[c.provider].name).join(" و")} {testing.length > 1 ? "مربوطتان" : "مربوطة"} بمفتاح تجريبي: الروابط للتجربة ولا تُحصّل أموالاً حقيقية.</p>
      )}
      {noWebhooks && (
        <p className="banner banner-info" role="status">الخادم لا يعمل على عنوان https عام، فلن تصل إشعارات البوابة تلقائياً. استخدم «تحقق من الدفع» بجانب الرابط بعد أن يدفع العميل.</p>
      )}

      <div className="pay-grid">
        {items.map((c) => <ProviderCard key={c.provider} tenantId={tenantId} c={c} canManage={can("gateways.manage") && writable} onChange={refresh} />)}
      </div>

      {can("orders.view") && <TillAttention tenantId={tenantId} />}

      <section className="panel" aria-labelledby="pay-links">
        <div className="card-head"><h2 id="pay-links">روابط الدفع</h2></div>
        <DataTable caption="روابط الدفع" tableId="payment-links" query={links} rowKey={(r) => r.id} onPageChange={setPage}
          toolbar={<StatusTabs value={filter} onChange={(v) => { setFilter(v); setPage(1); }} options={[["", "الكل"], ["pending", "بانتظار الدفع"], ["paid", "مدفوعة"], ["failed", "فشلت"], ["expired", "منتهية"]]} />}
          filtered={Boolean(filter)} onClearFilters={() => setFilter("")}
          empty={{ title: "لا توجد روابط دفع بعد", body: "افتح أي فاتورة آجلة لها رصيد واضغط «إنشاء رابط دفع»، ثم أرسل الرابط للعميل." }}
          columns={[
            { key: "d", header: "الفاتورة", sortKey: false, cell: (r) => <span><Link to={`/w/${tenantId}/accounting/invoices/${r.documentId}`} className="num"><strong>{r.documentNumber}</strong></Link> <span className="muted">{r.customerName}</span></span> },
            { key: "p", header: "البوابة", sortKey: false, cell: (r) => <span>{PROVIDERS[r.provider].name}{r.mode === "test" && <> <Badge tone="warning">تجريبي</Badge></>}</span> },
            { key: "a", header: "المبلغ", numeric: true, sortKey: false, cell: (r) => <span className="num">{money(r.amount)}</span> },
            { key: "s", header: "الحالة", sortKey: false, cell: (r) => <LinkStatusBadge status={r.status} /> },
            { key: "t", header: "التاريخ", sortKey: false, cell: (r) => <span className="muted">{dayTime(r.paidAt ?? r.createdAt)}</span> },
            { key: "x", header: "", sortKey: false, cell: (r) => <LinkActions tenantId={tenantId} link={r} onChecked={refresh} /> },
          ]} />
      </section>
    </div>
  );
}

function ProviderCard({ tenantId, c, canManage, onChange }: { tenantId: string; c: Connection; canManage: boolean; onChange: () => void }) {
  const toast = useToast();
  const p = PROVIDERS[c.provider];
  const form = useRef<HTMLFormElement>(null);
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);

  async function save() {
    const k = key.trim();
    if (!/^sk_(test|live)_/.test(k)) {
      setFieldError(k.startsWith("pk_") ? "هذا المفتاح المنشور (⁦pk_⁩). الصق المفتاح السري الذي يبدأ بـ ⁦sk_⁩" : "المفتاح السري يبدأ بـ ⁦sk_test_⁩ (تجريبي) أو ⁦sk_live_⁩ (حقيقي)");
      return focusFirstInvalid(form.current);
    }
    setFieldError(undefined);
    setError(null);
    setBusy(true);
    try {
      const r = await api<{ mode: "test" | "live" }>("PUT", `/t/payments/connections/${c.provider}`, { tenant: tenantId, body: { secretKey: k } });
      toast.success(`تم ربط ${p.name}${r.mode === "test" ? " بمفتاح تجريبي" : ""}`);
      setKey("");
      setEditing(false);
      onChange();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }

  async function disconnect() {
    setBusy(true);
    try {
      await api("DELETE", `/t/payments/connections/${c.provider}`, { tenant: tenantId });
      toast.success(`تم فصل ${p.name}`);
      setConfirmOff(false);
      onChange();
    } catch (e) { setError(e); setConfirmOff(false); } finally { setBusy(false); }
  }

  return (
    <section className="panel" aria-labelledby={`pay-${c.provider}`}>
      <div className="card-head">
        <span className="ca-head-icon tone-indigo" aria-hidden="true"><CreditCard /></span>
        <h2 id={`pay-${c.provider}`}>{p.name}</h2>
        <span className="spacer" />
        {c.connected ? <Badge tone={c.mode === "live" ? "success" : "warning"}>{c.mode === "live" ? "مربوطة" : "مربوطة (تجريبي)"}</Badge> : <Badge tone="neutral">غير مربوطة</Badge>}
      </div>
      <div className="card-body stack">
        {c.connected && (
          <dl className="dl">
            <dt>المفتاح</dt><dd className="num" dir="ltr">sk_{c.mode}_••••{c.keyHint}</dd>
            <dt>آخر تحديث</dt><dd>{c.updatedAt ? dayTime(c.updatedAt) : "—"}</dd>
          </dl>
        )}
        {!c.connected && !editing && <p className="muted acc-small">روابط دفع بمدى وفيزا وماستركارد وApple Pay، تصل مبالغها إلى حسابك في {p.name.split(" ")[0]}.</p>}

        {editing ? (
          <form ref={form} className="stack" noValidate onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <ol className="stack acc-small">
              <li>ادخل <a href={p.dashboard} target="_blank" rel="noreferrer">لوحة التحكم</a> بحساب منشأتك.</li>
              <li>{p.steps}</li>
              <li>ابدأ بالمفتاح التجريبي (<bdi dir="ltr">sk_test_</bdi>) للتجربة، ثم استبدله بالحقيقي (<bdi dir="ltr">sk_live_</bdi>) عند التفعيل.</li>
            </ol>
            <PasswordField label="المفتاح السري" autoComplete="off" required dir="ltr" value={key} onChange={(e) => setKey(e.target.value)} error={fieldError} />
            <p className="muted acc-small">يُتحقق من المفتاح مع البوابة ثم يُحفظ مشفّراً على الخادم، ولا يُعرض مرة أخرى.</p>
            <FormError error={error} />
            <div className="row" style={{ gap: "var(--sp-2)" }}>
              <Button type="submit" variant="primary" icon={<Link2 />} loading={busy} loadingText="جارٍ التحقق من المفتاح…">{c.connected ? "حفظ المفتاح الجديد" : "ربط الحساب"}</Button>
              <Button variant="secondary" disabled={busy} onClick={() => { setEditing(false); setKey(""); setFieldError(undefined); setError(null); }}>إلغاء</Button>
            </div>
          </form>
        ) : canManage ? (
          <div className="row" style={{ gap: "var(--sp-2)" }}>
            <Button variant={c.connected ? "secondary" : "primary"} icon={<Link2 />} onClick={() => setEditing(true)}>{c.connected ? "تغيير المفتاح" : "ربط الحساب"}</Button>
            {c.connected && <Button variant="ghost" destructive onClick={() => setConfirmOff(true)}>فصل</Button>}
          </div>
        ) : !c.connected ? <p className="muted acc-small">ربط البوابة من صلاحية مالك المنشأة (إعدادات المنشأة).</p> : null}
        {!editing && error != null && <FormError error={error} />}
      </div>
      <ConfirmDialog open={confirmOff} onClose={() => setConfirmOff(false)} busy={busy} onConfirm={() => void disconnect()}
        title={`فصل ${p.name}؟`} confirmLabel="فصل البوابة"
        message="يُحذف المفتاح من الخادم، ولن تُنشأ روابط دفع جديدة، ولن يُتحقق من الروابط المفتوحة حتى تعيد الربط. سندات القبض المسجلة لا تتأثر." />
    </section>
  );
}

/** On a credit invoice: open a payment link through a connected gateway, and follow the links already sent. */
export function PaymentLinksPanel({ tenantId, documentId, balance, onPaid }: { tenantId: string; documentId: string; balance: number; onPaid: () => void }) {
  const { can, writable } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const [key, renewKey] = useIdempotencyKey();
  const [busy, setBusy] = useState<Provider | null>(null);
  const [error, setError] = useState<unknown>(null);
  const conns = useQuery({ queryKey: ["t", tenantId, "payments", "connections"], queryFn: () => api<{ items: Connection[] }>("GET", "/t/payments/connections", { tenant: tenantId }) });
  const links = useQuery({ queryKey: ["t", tenantId, "payments", "links", "doc", documentId],
    queryFn: () => api<Page<PaymentLink>>("GET", "/t/payments/links", { tenant: tenantId, query: { documentId, pageSize: 20 } }) });
  const connected = (conns.data?.items ?? []).filter((c) => c.connected);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["t", tenantId, "payments"] }); onPaid(); };

  async function create(provider: Provider) {
    setBusy(provider);
    setError(null);
    try {
      const l = await api<PaymentLink>("POST", `/t/sales-documents/${documentId}/payment-links`, { tenant: tenantId, idempotencyKey: key, body: { provider } });
      renewKey();
      await navigator.clipboard?.writeText(l.url).then(() => toast.success("أُنشئ رابط الدفع ونُسخ. أرسله للعميل"), () => toast.success("أُنشئ رابط الدفع"));
      void qc.invalidateQueries({ queryKey: ["t", tenantId, "payments"] });
    } catch (e) { setError(e); } finally { setBusy(null); }
  }

  return (
    <section className="panel" aria-labelledby="inv-online-h">
      <div className="card-head"><h2 id="inv-online-h">الدفع الإلكتروني</h2></div>
      <div className="card-body stack">
        {links.isError ? <ErrorState error={links.error} title="تعذر تحميل روابط الدفع" onRetry={() => links.refetch()} />
          : (links.data?.items.length ?? 0) > 0 && (
          <ul className="acc-mini-list">{links.data!.items.map((l) => (
            <li key={l.id}>
              <LinkStatusBadge status={l.status} /><span className="muted">{PROVIDERS[l.provider].name.split(" ")[0]}{l.mode === "test" ? " (تجريبي)" : ""}</span>
              <span className="spacer" /><span className="num">{money(l.amount)}</span>
              <LinkActions tenantId={tenantId} link={l} onChecked={refresh} />
            </li>
          ))}</ul>
        )}
        {balance > 0 && can("acc_invoices.create") && writable && (conns.isPending ? null : connected.length === 0 ? (
          <p className="muted acc-small">اربط حساب ميسّر أو تاب لترسل للعميل رابط دفع لهذه الفاتورة. <Link to={`/w/${tenantId}/accounting/payments`}>بوابات الدفع</Link></p>
        ) : (
          <div className="row" style={{ gap: "var(--sp-2)", flexWrap: "wrap" }}>
            {connected.map((c) => (
              <Button key={c.provider} variant="secondary" icon={<Link2 />} loading={busy === c.provider} loadingText="جارٍ إنشاء الرابط…" disabled={busy !== null && busy !== c.provider}
                onClick={() => void create(c.provider)}>رابط دفع عبر {PROVIDERS[c.provider].name.split(" ")[0]}</Button>
            ))}
          </div>
        ))}
        {balance <= 0 && (links.data?.items.length ?? 0) === 0 && <p className="muted acc-small">لا يوجد مبلغ مستحق على الفاتورة.</p>}
        <FormError error={error} />
      </div>
    </section>
  );
}

interface TillIntent { id: string; provider: Provider; amount: number; status: "paid_unfulfilled" | "paid_after_cancel"; failure: string | null; createdAt: string; locationName: string }

/**
 * Till payments the gateway confirmed but that did not become a sale: stock ran out or the shift closed (retry once
 * fixed), or the cashier canceled and the customer paid anyway (refund from the gateway's dashboard). Hidden when empty.
 */
function TillAttention({ tenantId }: { tenantId: string }) {
  const { can, writable } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["t", tenantId, "payments", "till-attention"],
    queryFn: () => api<Page<TillIntent>>("GET", "/t/pos/online-payments", { tenant: tenantId, query: { status: "attention", pageSize: 50 } }) });
  if (q.isPending || (q.data && q.data.items.length === 0)) return null;
  if (q.isError) return <ErrorState error={q.error} title="تعذر تحميل مدفوعات الكاشير" onRetry={() => q.refetch()} />;

  async function retry(id: string) {
    setBusy(id);
    try {
      const r = await api<{ status: string; failure: string | null }>("POST", `/t/pos/online-payments/${id}/check`, { tenant: tenantId });
      if (r.status === "paid") toast.success("سُجّل البيع");
      else toast.error(r.failure ?? "لم يُسجَّل البيع بعد");
      void qc.invalidateQueries({ queryKey: ["t", tenantId, "payments"] });
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }

  return (
    <section className="panel" aria-labelledby="pay-till">
      <div className="card-head"><span className="ca-head-icon tone-red" aria-hidden="true"><TriangleAlert /></span><h2 id="pay-till">مدفوعات من الكاشير تحتاج متابعة</h2></div>
      <div className="card-body">
        <ul className="acc-mini-list">{q.data!.items.map((i) => (
          <li key={i.id}>
            <span className="num">{money(i.amount)}</span>
            <span className="muted">{PROVIDERS[i.provider].name.split(" ")[0]} · {i.locationName} · {dayTime(i.createdAt)}</span>
            <span className="spacer" />
            {i.status === "paid_unfulfilled" && can("pos.sell") && writable
              ? <Button size="sm" variant="ghost" icon={<RefreshCw />} loading={busy === i.id} loadingText="جارٍ المحاولة…" onClick={() => void retry(i.id)}>إعادة تسجيل البيع</Button>
              : null}
            <span className="muted acc-small acc-mini-note">{i.failure}</span>
          </li>
        ))}</ul>
      </div>
    </section>
  );
}
