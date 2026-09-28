import { randomUUID } from "node:crypto";
import { type Db, type TenantCtx, withTenantTx } from "../../db/pool.ts";
import { type OrderInput, performSale, priceCart } from "../../routes/restaurants/pos.ts";
import { resolveTicketCart } from "../../routes/restaurants/posTickets.ts";
import { AppError, notFound } from "../errors.ts";
import { formatMoney, parseMoney } from "../money.ts";
import type { Permission } from "../rbac.ts";
import { submitSoon } from "../zatca/service.ts";
import { fetchPayment, openPayment, type Provider } from "./gateways.ts";
import { connection, gatewayFailure, returnUrl, webhookUrl } from "./service.ts";

/**
 * Paying at the till through the workspace's own gateway. The cart is validated by a full dry run of the sale
 * (rolled back), the gateway page is opened for the server's total, and the sale is recorded only after the gateway
 * confirms the payment for exactly that amount. The order's single payment has method 'online'.
 */

export type Cart = Omit<OrderInput, "payments">;
const NOBODY = "00000000-0000-0000-0000-000000000000";

class DryRun extends Error {
  total: number;
  constructor(total: number) { super("dry run"); this.total = total; }
}

const auditRow = (db: Db, action: string, entityId: string, meta: object) =>
  db.query("INSERT INTO audit_log (actor_user_id, tenant_id, action, entity_type, entity_id, meta) VALUES (app_user_id(), app_tenant_id(), $1, 'pos_payment_intent', $2, $3)",
    [action, entityId, JSON.stringify(meta)]).then(() => undefined);

const INTENT_COLUMNS = `id, provider, mode, amount::float8 AS amount, url, status, provider_status AS "providerStatus", failure, order_id AS "orderId", created_at AS "createdAt"`;

export async function startPosPayment(ctx: TenantCtx, cart: Cart, provider: Provider, perms: readonly Permission[], idempotencyKey: string) {
  if (cart.platformId) throw new AppError(422, "payment_mismatch", "طلبات التطبيقات تُسدَّد عبر التطبيق فقط");
  const dup = await withTenantTx(ctx, async (db) =>
    (await db.query(`SELECT ${INTENT_COLUMNS} FROM pos_payment_intents WHERE idempotency_key = $1`, [idempotencyKey])).rows[0], { readOnly: true });
  if (dup) return { intent: dup, created: false };

  // 1. The whole sale, exactly as it will be replayed, then rolled back: stock, shift, table, discount, total.
  let total = 0;
  try {
    await withTenantTx(ctx, async (db) => {
      const op = await db.query<{ ok: boolean }>("SELECT tenant_is_operational(app_tenant_id()) AS ok");
      if (!op.rows[0]?.ok) throw new AppError(403, "tenant_not_operational", "المنشأة غير مفعّلة حالياً، فلا يمكن تسجيل عمليات جديدة");
      const { priced } = await priceCart(db, (await resolveTicketCart(db, cart, false)).body, perms);
      await performSale(db, { ...cart, payments: [{ method: "online", amount: priced.total / 100 }] }, randomUUID(), perms, ctx.userId, async () => undefined);
      throw new DryRun(priced.total);
    });
  } catch (err) {
    if (!(err instanceof DryRun)) throw err;
    total = err.total;
  }

  const pre = await withTenantTx(ctx, async (db) => {
    const conn = await connection(db, provider);
    if (!conn) throw new AppError(409, "gateway_not_connected", "بوابة الدفع غير مربوطة. يربطها المالك من «بوابات الدفع»");
    const payer = cart.customerId
      ? (await db.query<{ name: string; phone: string; email: string | null }>("SELECT name, phone, email FROM customers WHERE id = $1", [cart.customerId])).rows[0]
      : undefined;
    const seller = (await db.query<{ name: string }>("SELECT company_name AS name FROM tenants WHERE id = app_tenant_id()")).rows[0]?.name ?? "";
    return { conn, payer: payer ?? { name: cart.customerName ?? "عميل", phone: null, email: null }, seller };
  }, { readOnly: true });

  // 2. The hosted page, outside any transaction.
  const id = randomUUID();
  let opened;
  try {
    opened = await openPayment(provider, pre.conn.key, {
      linkId: id, amount: total, documentNumber: `POS-${id.slice(0, 8)}`, payer: pre.payer,
      description: `${pre.seller} - طلب نقطة بيع`,
      webhookUrl: webhookUrl(ctx.tenantId, provider, pre.conn.token), returnUrl: returnUrl(),
    });
  } catch (err) {
    if (provider === "tap" && !pre.payer.phone && !pre.payer.email) {
      throw new AppError(502, "gateway_error", `${(err as Error).message}. تاب قد تطلب جوال العميل: اربط عميلاً بالطلب ثم أعد المحاولة`);
    }
    gatewayFailure(err);
  }

  // 3. Recorded with the cart and the cashier's permissions, for the replay once paid.
  return withTenantTx(ctx, async (db) => {
    const r = await db.query(
      `INSERT INTO pos_payment_intents (id, tenant_id, provider, mode, location_id, shift_id, amount, cart, permissions, provider_ref, url, provider_status, idempotency_key, created_by)
       VALUES ($1, app_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, app_user_id())
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING ${INTENT_COLUMNS}`,
      [id, provider, pre.conn.mode, cart.locationId, cart.shiftId, formatMoney(total), JSON.stringify(cart), [...perms], opened.ref, opened.url, opened.providerStatus, idempotencyKey]);
    if (r.rows[0]) {
      await auditRow(db, "pos_payment.started", id, { provider, amount: formatMoney(total) });
      return { intent: r.rows[0], created: true };
    }
    return { intent: (await db.query(`SELECT ${INTENT_COLUMNS} FROM pos_payment_intents WHERE idempotency_key = $1`, [idempotencyKey])).rows[0], created: false };
  });
}

export interface Settled {
  status: string;
  failure: string | null;
  sale: { id: string; orderNumber: number; total: number; vat: number; qr: string | null } | null;
}

async function saleOf(db: Db, orderId: string) {
  const o = (await db.query<{ n: string; total: string; vat: string; qr: string | null }>(
    `SELECT o.order_number::text AS n, o.total::text, o.vat::text,
            (SELECT e.qr_base64 FROM e_invoices e WHERE e.order_id = o.id AND e.kind = 'simplified_invoice' LIMIT 1) AS qr
       FROM pos_orders o WHERE o.id = $1`, [orderId])).rows[0]!;
  return { id: orderId, orderNumber: Number(o.n), total: Number(o.total), vat: Number(o.vat), qr: o.qr };
}

/**
 * Asks the gateway about the payment and, when it is paid for the right amount, records the sale once. Called by the
 * till (polling), by the webhook and by a manager's retry; the intent row is locked, so the sale happens once.
 */
export async function settlePosPayment(tenantId: string, intentId: string, log: (err: unknown) => void = () => undefined): Promise<Settled> {
  const cur = await withTenantTx({ tenantId, userId: NOBODY }, async (db) => {
    const i = (await db.query<{ provider: Provider; provider_ref: string; status: string; amount: string; order_id: string | null; failure: string | null }>(
      "SELECT provider, provider_ref, status, amount::text, order_id, failure FROM pos_payment_intents WHERE id = $1", [intentId])).rows[0];
    if (!i) throw notFound("عملية الدفع غير موجودة");
    if (i.status === "paid") return { i, conn: null, sale: await saleOf(db, i.order_id!) };
    if (i.status === "paid_after_cancel") return { i, conn: null, sale: null };
    const conn = await connection(db, i.provider);
    if (!conn) throw new AppError(409, "gateway_not_connected", "بوابة الدفع لم تعد مربوطة");
    return { i, conn, sale: null };
  }, { readOnly: true });
  if (!cur.conn) return { status: cur.i.status, failure: cur.i.failure, sale: cur.sale };

  let remote;
  try { remote = await fetchPayment(cur.i.provider, cur.conn.key, cur.i.provider_ref); } catch (err) { gatewayFailure(err); }
  const paid = remote.status === "paid" && remote.amount === parseMoney(cur.i.amount) && remote.currency.toUpperCase() === "SAR";

  if (!paid) {
    const mismatch = remote.status === "paid";
    return withTenantTx({ tenantId, userId: NOBODY }, async (db) => {
      const row = (await db.query<{ status: string; order_id: string | null }>("SELECT status, order_id FROM pos_payment_intents WHERE id = $1 FOR UPDATE", [intentId])).rows[0]!;
      if (row.status === "paid" || row.status === "paid_after_cancel") return { status: row.status, failure: null, sale: row.order_id ? await saleOf(db, row.order_id) : null };
      // A canceled intent stays canceled; one the gateway failed or expired takes the gateway's word.
      const status = row.status === "canceled" || row.status === "paid_unfulfilled" || remote.status === "paid" ? row.status : remote.status;
      const failure = mismatch ? "دُفع مبلغ لا يطابق إجمالي الطلب. راجع البوابة" : null;
      await db.query("UPDATE pos_payment_intents SET status = $2, provider_status = $3, failure = coalesce($4, failure) WHERE id = $1", [intentId, status, remote.providerStatus, failure]);
      return { status, failure, sale: null };
    });
  }

  // Paid: the sale, in the name of the cashier who started it.
  const owner = await withTenantTx({ tenantId, userId: NOBODY }, async (db) =>
    (await db.query<{ created_by: string; cart: Cart; permissions: Permission[] }>("SELECT created_by, cart, permissions FROM pos_payment_intents WHERE id = $1", [intentId])).rows[0]!, { readOnly: true });
  try {
    const out = await withTenantTx({ tenantId, userId: owner.created_by }, async (db) => {
      const row = (await db.query<{ status: string; order_id: string | null }>("SELECT status, order_id FROM pos_payment_intents WHERE id = $1 FOR UPDATE", [intentId])).rows[0]!;
      if (row.status === "paid") return { status: "paid", failure: null, sale: await saleOf(db, row.order_id!), zatca: null };
      if (row.status === "canceled") {
        // The cashier gave up on this payment (and may have taken cash); the money arrived anyway: flag it, never sell twice.
        await db.query("UPDATE pos_payment_intents SET status = 'paid_after_cancel', provider_status = $2, payment_ref = $3, paid_at = now(), failure = $4 WHERE id = $1",
          [intentId, remote.providerStatus, remote.paymentRef, "دُفع بعد إلغاء العملية في الكاشير. استرجع المبلغ من لوحة البوابة إن لم يُسلَّم الطلب"]);
        await auditRow(db, "pos_payment.paid_after_cancel", intentId, { amount: cur.i.amount });
        return { status: "paid_after_cancel", failure: null, sale: null, zatca: null };
      }
      const r = await performSale(db, { ...owner.cart, payments: [{ method: "online", amount: parseMoney(cur.i.amount) / 100 }] }, intentId, owner.permissions, owner.created_by,
        (db, orderId, total) => db.query(
          "INSERT INTO audit_log (actor_user_id, tenant_id, action, entity_type, entity_id, meta) VALUES (app_user_id(), app_tenant_id(), 'order.completed', 'pos_order', $1, $2)",
          [orderId, JSON.stringify({ total, online: cur.i.provider })]).then(() => undefined));
      await db.query("UPDATE pos_payment_intents SET status = 'paid', order_id = $2, provider_status = $3, payment_ref = $4, paid_at = now(), failure = NULL WHERE id = $1",
        [intentId, r.id, remote.providerStatus, remote.paymentRef]);
      const zatca = (r as { zatcaDocument?: string | null }).zatcaDocument ?? null;
      return { status: "paid", failure: null, sale: { id: r.id, orderNumber: r.orderNumber, total: r.total, vat: r.vat, qr: r.qr }, zatca };
    });
    if (out.zatca) submitSoon({ tenantId, userId: owner.created_by }, out.zatca, log);
    return { status: out.status, failure: out.failure, sale: out.sale };
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    // Money received, sale refused (stock ran out, shift closed…): kept for a manager, never silently dropped.
    const failure = `تم الدفع ولم يُسجَّل البيع: ${err.message}`;
    await withTenantTx({ tenantId, userId: owner.created_by }, async (db) => {
      await db.query("UPDATE pos_payment_intents SET status = 'paid_unfulfilled', provider_status = $2, payment_ref = $3, paid_at = coalesce(paid_at, now()), failure = $4 WHERE id = $1 AND status <> 'paid'",
        [intentId, remote.providerStatus, remote.paymentRef, failure]);
      await auditRow(db, "pos_payment.unfulfilled", intentId, { reason: err.message });
    });
    return { status: "paid_unfulfilled", failure, sale: null };
  }
}

/** The cashier gives up: checked with the gateway first, so a payment that already went through is never lost. */
export async function cancelPosPayment(tenantId: string, intentId: string, log?: (err: unknown) => void): Promise<Settled> {
  let s: Settled;
  try { s = await settlePosPayment(tenantId, intentId, log); } catch (err) {
    // Gateway unreachable: cancel locally anyway; a later confirmation is flagged as paid after cancel.
    if (!(err instanceof AppError) || err.code !== "gateway_error") throw err;
    s = { status: "pending", failure: null, sale: null };
  }
  if (s.status !== "pending") return s;
  return withTenantTx({ tenantId, userId: NOBODY }, async (db) => {
    const r = await db.query<{ status: string }>("UPDATE pos_payment_intents SET status = 'canceled' WHERE id = $1 AND status = 'pending' RETURNING status", [intentId]);
    return { status: r.rows[0]?.status ?? s.status, failure: null, sale: null };
  });
}

export const POS_INTENT_COLUMNS = INTENT_COLUMNS;
