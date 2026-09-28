import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { notFound } from "../../lib/errors.ts";
import { pageMeta, parsePage } from "../../lib/pagination.ts";
import { cancelPosPayment, POS_INTENT_COLUMNS, settlePosPayment, startPosPayment } from "../../lib/payments/pos.ts";
import { isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";
import { orderSchema } from "./pos.ts";
import { idempotencyKey } from "./purchases.ts";

/**
 * Paying at the till through the workspace's Moyasar / Tap account: the till shows a QR of the payment page, polls
 * "check", and receives the recorded sale once the gateway confirms it.
 */
export default async function posOnlineRoutes(app: FastifyInstance) {
  // Which gateways the till can offer (no keys, just the names and test/live).
  app.get("/pos/online-payments/providers", { preHandler: requireTenant("pos.sell") }, async (req) =>
    tenantTx(req, async (db) => ({ items: (await db.query(`SELECT provider, mode FROM payment_connections ORDER BY provider`)).rows }), { readOnly: true }));

  app.post("/pos/online-payments", { preHandler: requireTenant("pos.sell"), config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const key = idempotencyKey(req);
    const body = orderSchema.omit({ payments: true }).extend({ provider: z.enum(["moyasar", "tap"], { message: "اختر بوابة الدفع" }) }).parse(req.body);
    const { provider, ...cart } = body;
    await tenantTx(req, async () => undefined);
    const out = await startPosPayment({ tenantId: req.tenant!.id, userId: req.tenant!.userId }, cart, provider, req.tenant!.permissions, key);
    return reply.status(out.created ? 201 : 200).send(out.intent);
  });

  // Polled by the till every few seconds while the customer pays (a POST: it may record the sale).
  app.post("/pos/online-payments/:id/check", { preHandler: requireTenant("pos.sell"), config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req) => {
    const id = (req.params as { id: string }).id;
    if (!isUuid(id)) throw notFound("عملية الدفع غير موجودة");
    await tenantTx(req, async () => undefined);
    return settlePosPayment(req.tenant!.id, id, (err) => req.log.warn({ err }, "zatca reporting deferred"));
  });

  app.post("/pos/online-payments/:id/cancel", { preHandler: requireTenant("pos.sell") }, async (req) => {
    const id = (req.params as { id: string }).id;
    if (!isUuid(id)) throw notFound("عملية الدفع غير موجودة");
    await tenantTx(req, async () => undefined);
    return cancelPosPayment(req.tenant!.id, id, (err) => req.log.warn({ err }, "zatca reporting deferred"));
  });

  // For managers: till payments that need attention (paid but not recorded, paid after the cashier canceled).
  app.get("/pos/online-payments", { preHandler: requireTenant("orders.view", "gateways.view") }, async (req) => {
    const q = req.query as { status?: string; page?: string; pageSize?: string };
    const page = parsePage(q);
    const status = q.status === "attention" ? "attention"
      : ["pending", "paid", "paid_unfulfilled", "failed", "expired", "canceled", "paid_after_cancel"].includes(q.status ?? "") ? q.status : null;
    return tenantTx(req, async (db) => {
      const { rows } = await db.query(
        `SELECT ${POS_INTENT_COLUMNS.split(", ").map((c) => `i.${c}`).join(", ")}, o.order_number::int AS "orderNumber", l.name AS "locationName", count(*) OVER()::int AS "_total"
           FROM pos_payment_intents i JOIN locations l ON l.id = i.location_id LEFT JOIN pos_orders o ON o.id = i.order_id
          WHERE $1::text IS NULL OR ($1 = 'attention' AND i.status IN ('paid_unfulfilled', 'paid_after_cancel')) OR i.status = $1
          ORDER BY i.created_at DESC LIMIT $2 OFFSET $3`, [status, page.pageSize, page.offset]);
      return { items: rows.map(({ _total, ...r }) => r), meta: pageMeta(page, rows[0]?._total ?? 0) };
    }, { readOnly: true });
  });
}
