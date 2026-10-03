import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { config } from "../../config.ts";
import { type Db, type TenantCtx, withTenantTx } from "../../db/pool.ts";
import { postCustomerReceipt } from "../accounting/posting.ts";
import { AppError, notFound } from "../errors.ts";
import { formatMoney, parseMoney } from "../money.ts";
import { open, seal } from "../zatca/vault.ts";
import { fetchPayment, GatewayError, keyMode, openPayment, type Provider, verifyKey } from "./gateways.ts";

/**
 * Each workspace connects its own Moyasar / Tap account; money goes straight to the workspace, never through us.
 * A payment link collects a credit invoice's balance. A link becomes paid only after the server re-reads the payment
 * from the gateway (webhook or "check now") and the amount matches; that records a customer receipt and posts
 * Dr gateway clearing / Cr receivables in the same transaction.
 */

const PURPOSE = "payments/gateway-keys/v1";
const secret = () => config.ZATCA_KEY_SECRET ?? config.SESSION_SECRET;
const TZ = "Asia/Riyadh";
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());

export const PROVIDER_AR: Record<Provider, string> = { moyasar: "ميسّر", tap: "تاب" };

/** Public addresses the gateway calls back / sends the payer to. Webhooks need https (gateways refuse plain http). */
const publicApi = () => `${config.appOrigin}/api/v1`;
export const webhookUrl = (tenantId: string, provider: Provider, token: string) =>
  config.appOrigin.startsWith("https://") ? `${publicApi()}/webhooks/payments/${tenantId}/${provider}/${token}` : null;
export const returnUrl = () => `${publicApi()}/pay/return`;

export function gatewayFailure(err: unknown): never {
  if (err instanceof GatewayError) throw new AppError(err.status === 401 || err.status === 403 ? 422 : 502, "gateway_error", err.message);
  throw err;
}

export async function connect(ctx: TenantCtx, provider: Provider, secretKey: string) {
  const mode = keyMode(secretKey);
  if (!mode) throw new AppError(422, "validation_failed", "المفتاح السري يبدأ بـ ⁦sk_test_⁩ أو ⁦sk_live_⁩ (لا تستخدم المفتاح المنشور ⁦pk_⁩)");
  try { await verifyKey(provider, secretKey); } catch (err) { gatewayFailure(err); }
  const token = randomBytes(24).toString("base64url");
  return withTenantTx(ctx, async (db) => {
    const r = await db.query<{ id: string }>(
      `INSERT INTO payment_connections (tenant_id, provider, mode, secret_enc, key_hint, webhook_token, connected_by)
       VALUES (app_tenant_id(), $1, $2, $3, $4, $5, app_user_id())
       ON CONFLICT (tenant_id, provider) DO UPDATE SET mode = EXCLUDED.mode, secret_enc = EXCLUDED.secret_enc, key_hint = EXCLUDED.key_hint,
              webhook_token = EXCLUDED.webhook_token, connected_by = EXCLUDED.connected_by
       RETURNING id`,
      [provider, mode, seal(secretKey, secret(), PURPOSE), secretKey.slice(-4), token]);
    return { id: r.rows[0]!.id, mode };
  });
}

export interface Conn { id: string; mode: "test" | "live"; key: string; token: string }
export async function connection(db: Db, provider: Provider): Promise<Conn | null> {
  const c = (await db.query<{ id: string; mode: "test" | "live"; secret_enc: string; webhook_token: string }>(
    "SELECT id, mode, secret_enc, webhook_token FROM payment_connections WHERE provider = $1", [provider])).rows[0];
  if (!c) return null;
  let key: string;
  try { key = open(c.secret_enc, secret(), PURPOSE); } catch {
    throw new AppError(409, "gateway_key_unreadable", "تعذر فك مفتاح بوابة الدفع (تغيّر مفتاح التشفير على الخادم). أعد ربط البوابة");
  }
  return { id: c.id, mode: c.mode, key, token: c.webhook_token };
}

/** What is still owed on a credit invoice (after notes and receipts), in halalas. */
export async function invoiceBalance(db: Db, documentId: string) {
  const d = (await db.query<{ doc_number: string; kind: string; payment_means: string; customer_id: string | null; invoice_type: string; balance: string }>(
    `SELECT d.doc_number, d.kind, d.payment_means, d.customer_id, d.invoice_type,
            (d.total - coalesce((SELECT sum(n.total) FROM sales_documents n WHERE n.original_id = d.id AND n.kind = 'credit_note'), 0)
                     + coalesce((SELECT sum(n.total) FROM sales_documents n WHERE n.original_id = d.id AND n.kind = 'debit_note'), 0)
                     - d.prepaid_amount - d.retention_amount - coalesce((SELECT sum(r.amount) FROM customer_receipts r WHERE r.document_id = d.id), 0))::text AS balance
       FROM sales_documents d WHERE d.id = $1`, [documentId])).rows[0];
  return d ? { ...d, balance: parseMoney(d.balance) } : null;
}

export async function createLink(ctx: TenantCtx, documentId: string, provider: Provider, idempotencyKey: string) {
  // 1. Everything the gateway needs, read (and checked) up front.
  const pre = await withTenantTx(ctx, async (db) => {
    const dup = (await db.query("SELECT id FROM payment_links WHERE idempotency_key = $1", [idempotencyKey])).rows[0];
    if (dup) return { replay: dup.id as string };
    const d = await invoiceBalance(db, documentId);
    if (!d || d.kind !== "invoice") throw notFound("الفاتورة غير موجودة");
    if (d.payment_means !== "credit" || !d.customer_id) throw new AppError(409, "already_paid", "رابط الدفع للفواتير الآجلة فقط (هذه مدفوعة عند الإصدار)");
    if (d.balance <= 0) throw new AppError(409, "nothing_due", "لا يوجد مبلغ مستحق على هذه الفاتورة");
    const z = (await db.query<{ outcome: string | null }>(
      `SELECT (SELECT s.outcome FROM zatca_submissions s WHERE s.document_id = z.id ORDER BY s.created_at DESC LIMIT 1) AS outcome
         FROM zatca_documents z WHERE z.source_type = 'sales_document' AND z.source_id = $1`, [documentId])).rows[0];
    if (d.invoice_type === "standard" && z && z.outcome !== "accepted" && z.outcome !== "accepted_with_warnings")
      throw new AppError(409, "not_cleared", "لا تُرسل الفاتورة الضريبية للعميل قبل اعتمادها من الهيئة. أرسلها للهيئة أولاً");
    // An open link for the same amount is reused instead of opening a second page the customer could pay twice.
    const open = (await db.query<{ id: string }>(
      `SELECT id FROM payment_links WHERE document_id = $1 AND provider = $2 AND status = 'pending' AND amount = $3
          AND (provider = 'moyasar' OR created_at > now() - interval '25 minutes') ORDER BY created_at DESC LIMIT 1`,
      [documentId, provider, formatMoney(d.balance)])).rows[0];
    if (open) return { replay: open.id };
    const conn = await connection(db, provider);
    if (!conn) throw new AppError(409, "gateway_not_connected", `بوابة ${PROVIDER_AR[provider]} غير مربوطة. اربطها من «بوابات الدفع»`);
    const payer = (await db.query<{ name: string; phone: string; email: string | null }>("SELECT name, phone, email FROM customers WHERE id = $1", [d.customer_id])).rows[0]!;
    const seller = (await db.query<{ name: string }>("SELECT coalesce((SELECT nullif(legal_name, '') FROM tax_profiles LIMIT 1), company_name) AS name FROM tenants WHERE id = app_tenant_id()")).rows[0]?.name ?? "";
    return { replay: null, d, conn, payer, seller };
  }, { readOnly: true });
  if (pre.replay) return { id: pre.replay, created: false };

  // 2. The hosted payment page (outside any transaction: a slow gateway never holds a database connection).
  const { d, conn, payer, seller } = pre as Required<typeof pre>;
  const linkId = randomUUID();
  let opened;
  try {
    opened = await openPayment(provider, conn.key, {
      linkId, amount: d.balance, documentNumber: d.doc_number, payer: payer,
      description: `${seller} - فاتورة رقم ${d.doc_number}`,
      webhookUrl: webhookUrl(ctx.tenantId, provider, conn.token), returnUrl: returnUrl(),
    });
  } catch (err) { gatewayFailure(err); }

  // 3. Recorded; a concurrent retry with the same key lands on the unique index and gets the first link.
  return withTenantTx(ctx, async (db) => {
    const r = await db.query<{ id: string }>(
      `INSERT INTO payment_links (id, tenant_id, provider, mode, document_id, customer_id, amount, provider_ref, url, provider_status, idempotency_key, created_by)
       VALUES ($1, app_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, app_user_id())
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id`,
      [linkId, provider, conn.mode, documentId, d.customer_id, formatMoney(d.balance), opened.ref, opened.url, opened.providerStatus, idempotencyKey]);
    if (r.rows[0]) return { id: linkId, created: true };
    const first = (await db.query<{ id: string }>("SELECT id FROM payment_links WHERE idempotency_key = $1", [idempotencyKey])).rows[0]!;
    return { id: first.id, created: false };
  });
}

export async function disconnect(db: Db, provider: Provider) {
  const r = await db.query<{ id: string }>("DELETE FROM payment_connections WHERE provider = $1 RETURNING id", [provider]);
  return r.rows[0]?.id ?? null;
}

/**
 * Asks the gateway where a link stands and settles it once. Safe to call any number of times, from the webhook and
 * from the "check now" button at once: the link row is locked and a paid link is never paid again.
 */
export async function reconcile(tenantId: string, linkId: string): Promise<{ status: string; receiptId: string | null }> {
  // The receipt is recorded in the name of whoever created the link (the webhook has no signed-in user).
  const nobody = "00000000-0000-0000-0000-000000000000";
  const link = await withTenantTx({ tenantId, userId: nobody }, async (db) => {
    const l = (await db.query<{ id: string; provider: Provider; provider_ref: string; status: string; receipt_id: string | null; amount: string; created_by: string }>(
      "SELECT id, provider, provider_ref, status, receipt_id, amount::text, created_by FROM payment_links WHERE id = $1", [linkId])).rows[0];
    if (!l) throw notFound("رابط الدفع غير موجود");
    if (l.status === "paid") return { l, conn: null };
    const conn = await connection(db, l.provider);
    if (!conn) throw new AppError(409, "gateway_not_connected", "بوابة الدفع لم تعد مربوطة. أعد ربطها ثم تحقق من الدفع");
    return { l, conn };
  }, { readOnly: true });
  if (!link.conn) return { status: "paid", receiptId: link.l.receipt_id };

  let remote;
  try { remote = await fetchPayment(link.l.provider, link.conn.key, link.l.provider_ref); } catch (err) { gatewayFailure(err); }
  const amountOk = remote.amount === parseMoney(link.l.amount) && remote.currency.toUpperCase() === "SAR";

  return withTenantTx({ tenantId, userId: link.l.created_by }, async (db) => {
    const cur = (await db.query<{ status: string; receipt_id: string | null; document_id: string; customer_id: string; idempotency_key: string }>(
      "SELECT status, receipt_id, document_id, customer_id, id AS idempotency_key FROM payment_links WHERE id = $1 FOR UPDATE", [linkId])).rows[0]!;
    if (cur.status === "paid") return { status: "paid", receiptId: cur.receipt_id };
    if (remote.status !== "paid" || !amountOk) {
      // A paid page for another amount is never booked automatically; the owner sees the gateway's word for it.
      const providerStatus = remote.status === "paid" && !amountOk ? `${remote.providerStatus} (المبلغ لا يطابق)` : remote.providerStatus;
      const status = remote.status === "paid" ? "pending" : remote.status;
      await db.query("UPDATE payment_links SET status = $2, provider_status = $3, checked_at = now() WHERE id = $1", [linkId, status, providerStatus]);
      return { status, receiptId: null };
    }
    await db.query("SELECT pg_advisory_xact_lock(hashtext('sales_document:' || $1))", [cur.document_id]);
    const n = (await db.query<{ n: string }>("SELECT next_counter('customer_receipt')::text AS n")).rows[0]!.n;
    const ref = `${link.l.provider === "moyasar" ? "Moyasar" : "Tap"} ${remote.paymentRef ?? link.l.provider_ref}`.slice(0, 80);
    const receiptId = (await db.query<{ id: string }>(
      `INSERT INTO customer_receipts (tenant_id, receipt_number, customer_id, document_id, received_on, amount, method, reference, notes, idempotency_key, created_by)
       VALUES (app_tenant_id(), $1, $2, $3, $4, $5, 'online', $6, $7, $8, app_user_id()) RETURNING id`,
      [n, cur.customer_id, cur.document_id, today(), link.l.amount, ref, `دفع إلكتروني عبر ${PROVIDER_AR[link.l.provider]}`, cur.idempotency_key])).rows[0]!.id;
    await postCustomerReceipt(db, receiptId);
    await db.query(
      "UPDATE payment_links SET status = 'paid', receipt_id = $2, payment_ref = $3, provider_status = $4, paid_at = now(), checked_at = now() WHERE id = $1",
      [linkId, receiptId, remote.paymentRef, remote.providerStatus]);
    await db.query(
      `INSERT INTO audit_log (actor_user_id, tenant_id, action, entity_type, entity_id, meta) VALUES (NULL, app_tenant_id(), 'payment_link.paid', 'payment_link', $1, $2)`,
      [linkId, JSON.stringify({ provider: link.l.provider, amount: link.l.amount, receiptId })]);
    return { status: "paid", receiptId };
  });
}

/**
 * The webhook: the URL token must match the connection's; then the invoice link or till payment the gateway names is
 * returned, for the caller to re-read from the gateway (the body itself is never trusted).
 */
export async function webhookTarget(tenantId: string, provider: Provider, token: string, ref: string | null):
  Promise<"unknown" | { linkId: string | null; intentId: string | null }> {
  const nobody = "00000000-0000-0000-0000-000000000000";
  const found = await withTenantTx({ tenantId, userId: nobody }, async (db) => {
    const c = (await db.query<{ webhook_token: string }>("SELECT webhook_token FROM payment_connections WHERE provider = $1", [provider])).rows[0];
    const a = Buffer.from(token), b = Buffer.from(c?.webhook_token ?? "");
    if (!c || a.length !== b.length || !timingSafeEqual(a, b)) return null;
    if (!ref) return { linkId: null, intentId: null };
    const l = (await db.query<{ id: string }>("SELECT id FROM payment_links WHERE provider = $1 AND provider_ref = $2", [provider, ref])).rows[0];
    const i = l ? undefined : (await db.query<{ id: string }>("SELECT id FROM pos_payment_intents WHERE provider = $1 AND provider_ref = $2", [provider, ref])).rows[0];
    return { linkId: l?.id ?? null, intentId: i?.id ?? null };
  }, { readOnly: true });
  return found ?? "unknown";
}
