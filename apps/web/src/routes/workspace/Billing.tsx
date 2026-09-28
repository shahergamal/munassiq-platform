import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Check, CreditCard, HardDrive, RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import { useIdempotencyKey } from "../../app/session";
import { useTenant } from "../../app/tenant";
import { day, dayTime, integer, money } from "../../lib/format";
import { Button } from "../../ui/Button";
import { DataTable } from "../../ui/DataTable";
import { Badge, PageHeader, StatusBadge } from "../../ui/Layout";
import { ErrorState, FormError, TableSkeleton } from "../../ui/States";
import { useToast } from "../../ui/Toast";
import { mbLabel, PAYMENT_STATUS } from "../admin/AdminServer";

/**
 * The owner's subscription page: what the workspace is on and how much of it is used, then the plans and storage
 * packages to buy. Paying opens Moyasar in this tab; Moyasar sends the payer back here with the payment id, and
 * the page confirms it with the server (which applies it once).
 */

interface Plan { code: string; nameAr: string; monthlyPrice: number; annualPrice: number | null; branchesLimit: number; usersLimit: number; storageLimitMb: number; description: string | null; features: string[]; badge: string | null; isFeatured: boolean }
interface Addon { id: string; nameAr: string; sizeMb: number; price: number }
interface Payment { id: string; kind: "subscription" | "storage"; description: string; amount: number; status: string; mode: "test" | "live"; url: string; failure: string | null; createdAt: string; paidAt: string | null }
interface Billing {
  enabled: boolean;
  current: {
    status: string | null; startsAt: string | null; endsAt: string | null; planCode: string | null; planName: string | null;
    branchesLimit: number | null; usersLimit: number | null; branchesUsed: number; usersUsed: number;
    storageLimitMb: number | null; storageUsedMb: number; storageMeasuredAt: string | null;
  };
  plans: Plan[]; addons: Addon[]; payments: Payment[];
}

function Usage({ label, used, limit, format }: { label: string; used: number; limit: number | null; format: (n: number) => string }) {
  const ratio = limit ? Math.min(1, used / limit) : 0;
  const tone = ratio >= 1 ? "is-full" : ratio >= 0.8 ? "is-near" : "";
  return (
    <div className="bl-usage">
      <div className="bl-usage-head"><span>{label}</span><span className="bl-usage-val">{format(used)} من {limit === null ? "—" : format(limit)}</span></div>
      <span className={`meter bl-meter ${tone}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={limit ?? 0} aria-valuenow={used}><span style={{ inlineSize: `${Math.round(ratio * 100)}%` }} /></span>
    </div>
  );
}

export function BillingPage() {
  const { tenantId, writable } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ["t", tenantId, "billing"], queryFn: () => api<Billing>("GET", "/t/billing", { tenant: tenantId }) });
  const [period, setPeriod] = useState<"monthly" | "annual">("monthly");
  const [key, renewKey] = useIdempotencyKey();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const returned = useRef(false);

  async function check(id: string, quiet = false) {
    setChecking(id);
    try {
      const r = await api<{ status: string; storageAddedMb?: number; subscriptionEndsAt?: string }>("POST", `/t/billing/payments/${id}/check`, { tenant: tenantId });
      if (r.status === "paid") {
        toast.success(r.storageAddedMb ? `تم الدفع وأُضيفت ${mbLabel(r.storageAddedMb)} إلى مساحتك` : `تم الدفع وتفعيل الاشتراك حتى ${day(r.subscriptionEndsAt ?? null)}`);
        await qc.invalidateQueries({ queryKey: ["t", tenantId] });
      } else if (!quiet) toast.error(r.status === "pending" ? "لم يكتمل الدفع بعد. إن دفعت للتو انتظر دقيقة ثم أعد التحقق" : "لم تكتمل عملية الدفع. يمكنك المحاولة من جديد");
      await q.refetch();
    } catch (e) { if (!quiet) toast.error((e as Error).message); } finally { setChecking(null); }
  }

  // Back from Moyasar: ?payment=<id> is confirmed once, then removed from the address.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("payment");
    if (!id || returned.current) return;
    returned.current = true;
    void check(id).then(() => navigate({ to: `/w/${tenantId}/billing`, replace: true }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function buy(body: object, label: string) {
    setBusy(label); setError(null);
    try {
      const r = await api<{ id: string; url: string }>("POST", "/t/billing/checkout", { tenant: tenantId, idempotencyKey: key, body });
      renewKey();
      window.location.assign(r.url);
    } catch (e) { setError(e); setBusy(null); }
  }

  if (q.isPending) return <div className="page"><TableSkeleton columns={3} rows={4} label="جارٍ تحميل الاشتراك…" /></div>;
  if (q.isError) return <div className="page"><ErrorState error={q.error} title="تعذر تحميل بيانات الاشتراك" onRetry={() => q.refetch()} /></div>;
  const b = q.data;
  const c = b.current;
  const canBuy = b.enabled && writable;
  const pending = b.payments.find((p) => p.status === "pending");
  const priceOf = (p: Plan) => (period === "annual" ? p.annualPrice ?? p.monthlyPrice * 12 : p.monthlyPrice);

  return (
    <div className="page">
      <PageHeader title="الاشتراك والفوترة" description="باقتك الحالية وما استُهلك منها، وترقية الباقة أو تجديدها أو شراء مساحة إضافية بالدفع الإلكتروني (مدى، فيزا، ماستركارد، Apple Pay)." />

      {!b.enabled && <p className="banner banner-info" role="status">الدفع الإلكتروني للاشتراكات غير مفعّل حالياً. للتجديد أو الترقية تواصل مع إدارة المنصة.</p>}
      {pending && (
        <p className="banner banner-warning" role="status"><TriangleAlert aria-hidden="true" />
          <span>عملية دفع لم تكتمل: {pending.description} ({money(pending.amount)}).</span><span className="spacer" />
          <Button size="sm" icon={<RefreshCw />} loading={checking === pending.id} loadingText="جارٍ التحقق…" onClick={() => void check(pending.id)}>تحقق من الدفع</Button>
          <a className="btn btn-ghost btn-sm" href={pending.url}>إكمال الدفع</a>
        </p>
      )}

      <section className="panel" aria-labelledby="bl-cur">
        <div className="card-head"><span className="ca-head-icon tone-indigo" aria-hidden="true"><CreditCard /></span><h2 id="bl-cur">باقتك الحالية: {c.planName ?? "—"}</h2><span className="spacer" /><StatusBadge kind="subscription" value={c.status} /></div>
        <div className="card-body stack">
          <p className="muted">{c.endsAt ? <>سارية حتى <strong>{day(c.endsAt)}</strong>{c.status === "trial" ? " (فترة تجريبية)" : ""}.</> : "لا يوجد اشتراك ساري."}</p>
          <div className="bl-usages">
            <Usage label="المستخدمون" used={c.usersUsed} limit={c.usersLimit} format={integer} />
            <Usage label="الفروع" used={c.branchesUsed} limit={c.branchesLimit} format={integer} />
            <Usage label="مساحة التخزين" used={c.storageUsedMb} limit={c.storageLimitMb} format={mbLabel} />
          </div>
          <p className="muted acc-small">المساحة هي حجم بيانات منشأتك في النظام (المواد والطلبات والقيود والملفات المحفوظة)، وتُقاس كل ساعة{c.storageMeasuredAt ? `، آخر قياس ${dayTime(c.storageMeasuredAt)}` : ""}. عند امتلائها يتوقف الاستيراد وحفظ الملفات فقط، ولا يتوقف البيع أو المخزون.</p>
        </div>
      </section>

      {b.plans.length > 0 && (
        <section aria-labelledby="bl-plans" className="stack">
          <div className="row"><h2 id="bl-plans">الباقات</h2><span className="spacer" />
            <div className="segmented" role="group" aria-label="مدة الاشتراك">
              <button type="button" aria-pressed={period === "monthly"} onClick={() => setPeriod("monthly")}>شهري</button>
              <button type="button" aria-pressed={period === "annual"} onClick={() => setPeriod("annual")}>سنوي</button>
            </div>
          </div>
          <div className="bl-plans">
            {b.plans.map((p) => {
              const current = p.code === c.planCode && c.status === "active";
              return (
                <article key={p.code} className={`panel bl-plan${p.isFeatured ? " is-featured" : ""}${current ? " is-current" : ""}`}>
                  <div className="bl-plan-head"><h3>{p.nameAr}</h3>{current ? <Badge tone="success">باقتك</Badge> : p.badge && <Badge tone="info">{p.badge}</Badge>}</div>
                  <p className="bl-price"><span className="num">{money(priceOf(p))}</span><span className="muted"> / {period === "annual" ? "سنة" : "شهر"}</span></p>
                  {p.description && <p className="muted acc-small">{p.description}</p>}
                  <ul className="bl-feats">
                    <li><Check aria-hidden="true" />{integer(p.usersLimit)} مستخدمين</li>
                    <li><Check aria-hidden="true" />{integer(p.branchesLimit)} فروع</li>
                    <li><Check aria-hidden="true" />{mbLabel(p.storageLimitMb)} تخزين</li>
                    {p.features.map((f) => <li key={f}><Check aria-hidden="true" />{f}</li>)}
                  </ul>
                  <Button variant={p.isFeatured || current ? "primary" : "secondary"} disabled={!canBuy || (busy !== null && busy !== p.code)} loading={busy === p.code} loadingText="جارٍ فتح صفحة الدفع…"
                    onClick={() => void buy({ kind: "subscription", planCode: p.code, period }, p.code)}>
                    {current ? `تجديد ${period === "annual" ? "سنة" : "شهر"}` : c.planCode === p.code ? "تفعيل الباقة" : "الاشتراك في الباقة"}
                  </Button>
                </article>
              );
            })}
          </div>
          <p className="muted acc-small">الترقية لباقة أخرى تبدأ فوراً وتنهي الحالية. التجديد لنفس الباقة يضيف المدة بعد تاريخ انتهائها.</p>
        </section>
      )}

      {b.addons.length > 0 && (
        <section className="panel" aria-labelledby="bl-storage">
          <div className="card-head"><span className="ca-head-icon tone-amber" aria-hidden="true"><HardDrive /></span><h2 id="bl-storage">مساحة إضافية</h2></div>
          <div className="card-body">
            <ul className="bl-addons">
              {b.addons.map((a) => (
                <li key={a.id}>
                  <span><strong>{a.nameAr}</strong><span className="muted acc-small"> · تُضاف لمساحتك فور الدفع وتبقى دائمة</span></span>
                  <span className="spacer" /><span className="num">{money(a.price)}</span>
                  <Button size="sm" disabled={!canBuy || (busy !== null && busy !== a.id)} loading={busy === a.id} loadingText="جارٍ فتح صفحة الدفع…" onClick={() => void buy({ kind: "storage", addonId: a.id }, a.id)}>شراء</Button>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
      <FormError error={error} />

      <section className="panel">
        <DataTable caption="عمليات الدفع" tableId="billing-payments" query={{ ...q, data: { items: b.payments } }} rowKey={(p) => p.id}
          toolbar={<h2>عمليات الدفع</h2>}
          empty={{ title: "لا توجد عمليات دفع بعد", body: "كل اشتراك أو شراء مساحة تدفعه من هنا يظهر في هذه القائمة." }}
          columns={[
            { key: "description", header: "البند", cell: (p) => <>{p.description}{p.mode === "test" && <> <Badge tone="warning">تجريبي</Badge></>}</> },
            { key: "amount", header: "المبلغ", numeric: true, cell: (p) => money(p.amount) },
            { key: "status", header: "الحالة", cell: (p) => { const [l, tone] = PAYMENT_STATUS[p.status] ?? [p.status, "neutral"]; return <Badge tone={tone}>{l}</Badge>; } },
            { key: "createdAt", header: "التاريخ", cell: (p) => dayTime(p.paidAt ?? p.createdAt) },
          ]}
          actions={(p) => p.status === "pending"
            ? <Button size="sm" variant="ghost" icon={<RefreshCw />} loading={checking === p.id} loadingText="جارٍ التحقق…" onClick={() => void check(p.id)}>تحقق</Button> : null} />
      </section>
    </div>
  );
}
