import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { config } from "../../config.ts";
import { systemPool, withSystemTx, type Db } from "../../db/pool.ts";
import { AppError, notFound } from "../errors.ts";
import { formatMoney, parseMoney } from "../money.ts";
import { fetchPayment, GatewayError, keyMode, openPayment } from "../payments/gateways.ts";

/**
 * Workspaces pay the PLATFORM (its own Moyasar account, PLATFORM_MOYASAR_SECRET_KEY) for a plan or extra storage.
 * The price always comes from the database (plans / storage_addons), never from the browser. A payment is applied
 * only after the server re-reads it from Moyasar and the amount matches: then, in one transaction, the subscription
 * is activated or extended, or the workspace's storage is raised, and the payment is marked paid (once).
 */

export const billingEnabled = () => Boolean(config.PLATFORM_MOYASAR_SECRET_KEY);
const key = () => {
  if (!config.PLATFORM_MOYASAR_SECRET_KEY) throw new AppError(503, "billing_disabled", "الدفع الإلكتروني للاشتراكات غير مفعّل بعد. تواصل مع إدارة المنصة");
  return config.PLATFORM_MOYASAR_SECRET_KEY;
};

/** The webhook address carries a token derived from the server secret (nothing extra to configure). */
export const billingWebhookToken = () => createHmac("sha256", config.SESSION_SECRET).update("billing-webhook/v1").digest("base64url");
export function validWebhookToken(t: string) {
  const a = Buffer.from(t), b = Buffer.from(billingWebhookToken());
  return a.length === b.length && timingSafeEqual(a, b);
}
const webhookUrl = () => (config.appOrigin.startsWith("https://") ? `${config.appOrigin}/api/v1/webhooks/billing/${billingWebhookToken()}` : null);

function gatewayFailure(err: unknown): never {
  if (err instanceof GatewayError) throw new AppError(502, "gateway_error", err.message);
  throw err;
}

export type Purchase = { kind: "subscription"; planCode: string; period: "monthly" | "annual" } | { kind: "storage"; addonId: string };

/** What the workspace is buying and its price, from the database. */
async function priced(db: Db, tenantId: string, p: Purchase) {
  if (p.kind === "subscription") {
    const plan = (await db.query<{ id: string; name_ar: string; monthly: string; annual: string | null; is_active: boolean; code: string; tenant_sector: string; sector: string }>(
      `SELECT p.id, p.name_ar, p.monthly_price::text AS monthly, p.annual_price::text AS annual, p.is_active, p.code, p.sector,
              (SELECT sector FROM tenants WHERE id = $2) AS tenant_sector
         FROM plans p WHERE p.code = $1`, [p.planCode, tenantId])).rows[0];
    if (!plan || !plan.is_active || plan.sector !== plan.tenant_sector) throw notFound("الباقة غير متاحة");
    if (plan.code.endsWith("-trial")) throw new AppError(422, "validation_failed", "باقة التجربة لا تُشترى");
    const amount = p.period === "annual" ? (plan.annual ? parseMoney(plan.annual) : parseMoney(plan.monthly) * 12) : parseMoney(plan.monthly);
    if (amount <= 0) throw new AppError(422, "validation_failed", "هذه الباقة بلا سعر. تواصل مع إدارة المنصة");
    return { amount, planId: plan.id, addonId: null, sizeMb: null, description: `اشتراك ${p.period === "annual" ? "سنوي" : "شهري"} - باقة ${plan.name_ar}` };
  }
  const a = (await db.query<{ id: string; name_ar: string; size_mb: number; price: string; is_active: boolean }>(
    "SELECT id, name_ar, size_mb, price::text, is_active FROM storage_addons WHERE id = $1", [p.addonId])).rows[0];
  if (!a || !a.is_active) throw notFound("باقة المساحة غير متاحة");
  return { amount: parseMoney(a.price), planId: null, addonId: a.id, sizeMb: a.size_mb, description: a.name_ar };
}

export async function checkout(tenantId: string, userId: string, p: Purchase, idempotencyKey: string) {
  const secret = key();
  const dup = (await systemPool.query<{ id: string; url: string; status: string }>(
    "SELECT id, url, status FROM platform_payments WHERE tenant_id = $1 AND idempotency_key = $2", [tenantId, idempotencyKey])).rows[0];
  if (dup) return dup;
  const item = await withSystemTx((db) => priced(db, tenantId, p), { readOnly: true });
  const company = (await systemPool.query<{ company_name: string }>("SELECT company_name FROM tenants WHERE id = $1", [tenantId])).rows[0]?.company_name ?? "";
  const id = randomUUID();
  let opened;
  try {
    opened = await openPayment("moyasar", secret, {
      linkId: id, amount: item.amount, documentNumber: `SUB-${id.slice(0, 8)}`, description: `مُنَسِّق - ${item.description} - ${company}`,
      // Back to the workspace's billing page, which checks the payment on arrival.
      payer: { name: company, phone: null, email: null }, webhookUrl: webhookUrl(), returnUrl: `${config.appOrigin}/w/${tenantId}/billing?payment=${id}`,
    });
  } catch (err) { gatewayFailure(err); }
  return withSystemTx(async (db) => {
    const r = await db.query<{ id: string; url: string; status: string }>(
      `INSERT INTO platform_payments (id, tenant_id, kind, plan_id, period, addon_id, size_mb, description, amount, mode, provider_ref, url, provider_status, idempotency_key, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id, url, status`,
      [id, tenantId, p.kind, item.planId, p.kind === "subscription" ? p.period : null, item.addonId, item.sizeMb, item.description, formatMoney(item.amount),
        keyMode(secret) ?? "test", opened.ref, opened.url, opened.providerStatus, idempotencyKey, userId]);
    if (r.rows[0]) {
      await db.query("INSERT INTO audit_log (actor_user_id, tenant_id, action, entity_type, entity_id, meta) VALUES ($1, $2, 'billing.checkout', 'platform_payment', $3, $4)",
        [userId, tenantId, id, JSON.stringify({ kind: p.kind, amount: formatMoney(item.amount) })]);
      return r.rows[0];
    }
    return (await db.query<{ id: string; url: string; status: string }>("SELECT id, url, status FROM platform_payments WHERE tenant_id = $1 AND idempotency_key = $2", [tenantId, idempotencyKey])).rows[0]!;
  });
}

interface Row { id: string; tenant_id: string; kind: "subscription" | "storage"; plan_id: string | null; period: "monthly" | "annual" | null; size_mb: number | null; amount: string; provider_ref: string; status: string; created_by: string }

/** Applies a confirmed payment. Runs inside the caller's system transaction with the payment row locked. */
async function apply(db: Db, p: Row) {
  if (p.kind === "storage") {
    await db.query(
      `INSERT INTO tenant_storage (tenant_id, extra_mb) VALUES ($1, $2)
       ON CONFLICT (tenant_id) DO UPDATE SET extra_mb = tenant_storage.extra_mb + EXCLUDED.extra_mb`, [p.tenant_id, p.size_mb]);
    return { storageAddedMb: p.size_mb };
  }
  const months = p.period === "annual" ? 12 : 1;
  const cur = (await db.query<{ id: string; plan_id: string; status: string; ends_at: string }>(
    `SELECT id, plan_id, status, ends_at::text FROM subscriptions WHERE tenant_id = $1 AND status IN ('trial', 'active', 'suspended')
      ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [p.tenant_id])).rows[0];
  if (cur && cur.plan_id === p.plan_id && cur.status === "active") {
    // Renewal of the same plan: the new period starts when the current one ends (or today if it already ended).
    const r = await db.query<{ ends_at: string }>(
      `UPDATE subscriptions SET ends_at = greatest(ends_at, current_date) + make_interval(months => $2), total_value = total_value + $3
        WHERE id = $1 RETURNING ends_at::text`, [cur.id, months, p.amount]);
    return { subscriptionEndsAt: r.rows[0]!.ends_at };
  }
  // A new plan (or leaving the trial): the current one ends today and the paid one starts now.
  if (cur) await db.query("UPDATE subscriptions SET status = 'expired', ends_at = greatest(starts_at + 1, current_date) WHERE id = $1", [cur.id]);
  const r = await db.query<{ ends_at: string }>(
    `INSERT INTO subscriptions (tenant_id, plan_id, status, starts_at, ends_at, total_value)
     VALUES ($1, $2, 'active', current_date, current_date + make_interval(months => $3), $4) RETURNING ends_at::text`, [p.tenant_id, p.plan_id, months, p.amount]);
  return { subscriptionEndsAt: r.rows[0]!.ends_at };
}

/**
 * Where a payment stands with Moyasar; applies it once when paid for the exact amount. Safe to run from the
 * webhook and from the "check" button at the same time.
 */
export async function settle(paymentId: string, tenantId?: string) {
  const p = (await systemPool.query<Row>(
    "SELECT id, tenant_id, kind, plan_id, period, size_mb, amount::text, provider_ref, status, created_by FROM platform_payments WHERE id = $1", [paymentId])).rows[0];
  if (!p || (tenantId && p.tenant_id !== tenantId)) throw notFound("عملية الدفع غير موجودة");
  if (p.status === "paid") return { status: "paid" as const };
  let remote;
  try { remote = await fetchPayment("moyasar", key(), p.provider_ref); } catch (err) { gatewayFailure(err); }
  const ok = remote.status === "paid" && remote.amount === parseMoney(p.amount) && remote.currency.toUpperCase() === "SAR";
  return withSystemTx(async (db) => {
    const cur = (await db.query<Row>("SELECT id, tenant_id, kind, plan_id, period, size_mb, amount::text, provider_ref, status, created_by FROM platform_payments WHERE id = $1 FOR UPDATE", [paymentId])).rows[0]!;
    if (cur.status === "paid") return { status: "paid" as const };
    if (!ok) {
      const failure = remote.status === "paid" ? "دُفع مبلغ لا يطابق السعر. راجع لوحة ميسّر" : null;
      const status = remote.status === "paid" ? cur.status : remote.status;
      await db.query("UPDATE platform_payments SET status = $2, provider_status = $3, failure = coalesce($4, failure) WHERE id = $1", [paymentId, status, remote.providerStatus, failure]);
      return { status };
    }
    const applied = await apply(db, cur);
    await db.query("UPDATE platform_payments SET status = 'paid', paid_at = now(), provider_status = $2, payment_ref = $3, failure = NULL WHERE id = $1",
      [paymentId, remote.providerStatus, remote.paymentRef]);
    await db.query("INSERT INTO audit_log (actor_user_id, tenant_id, action, entity_type, entity_id, meta) VALUES (NULL, $1, 'billing.paid', 'platform_payment', $2, $3)",
      [cur.tenant_id, paymentId, JSON.stringify({ kind: cur.kind, amount: cur.amount, ...applied })]);
    return { status: "paid" as const, ...applied };
  });
}

export async function settleByRef(ref: string) {
  const p = (await systemPool.query<{ id: string }>("SELECT id FROM platform_payments WHERE provider_ref = $1", [ref])).rows[0];
  if (p) await settle(p.id);
  return Boolean(p);
}
