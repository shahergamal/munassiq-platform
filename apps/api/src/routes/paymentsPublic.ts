import type { FastifyInstance } from "fastify";
import { PROVIDERS, type Provider, webhookRef } from "../lib/payments/gateways.ts";
import { settlePosPayment } from "../lib/payments/pos.ts";
import { reconcile, webhookTarget } from "../lib/payments/service.ts";
import { isUuid } from "../plugins/auth.ts";
import { settleByRef, validWebhookToken } from "../lib/billing/service.ts";

/**
 * The two addresses a payment gateway reaches without a session: the webhook (per workspace and gateway, guarded by
 * a random token) and the page the payer lands on after paying. The webhook body is only a hint: the payment is
 * re-read from the gateway with the workspace's own key before anything is recorded.
 */
export default async function paymentsPublicRoutes(app: FastifyInstance) {
  app.post("/webhooks/payments/:tenantId/:provider/:token", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply) => {
    const p = req.params as { tenantId: string; provider: string; token: string };
    if (!isUuid(p.tenantId) || !PROVIDERS.includes(p.provider as Provider) || !/^[A-Za-z0-9_-]{32,64}$/.test(p.token)) {
      return reply.status(404).send({ error: { code: "not_found", message: "not found" } });
    }
    const provider = p.provider as Provider;
    const out = await webhookTarget(p.tenantId, provider, p.token, webhookRef(provider, req.body));
    if (out === "unknown") return reply.status(404).send({ error: { code: "not_found", message: "not found" } });
    if (out.linkId) await reconcile(p.tenantId, out.linkId);
    if (out.intentId) await settlePosPayment(p.tenantId, out.intentId, (err) => req.log.warn({ err }, "zatca reporting deferred"));
    return { received: true };
  });

  // Moyasar's callback for payments to the PLATFORM (subscriptions, storage).
  app.post("/webhooks/billing/:token", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { token } = req.params as { token: string };
    if (!validWebhookToken(token)) return reply.status(404).send({ error: { code: "not_found", message: "not found" } });
    const ref = webhookRef("moyasar", req.body);
    if (ref) await settleByRef(ref);
    return { received: true };
  });

  app.get("/pay/return", async (_req, reply) =>
    reply.type("text/html; charset=utf-8").header("Cache-Control", "no-store").send(`<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>تمت العملية</title></head>
<body><main><h1>شكراً لك</h1><p>انتهت عملية الدفع. سيصلك إشعار من البائع عند تأكيد استلام المبلغ، ويمكنك إغلاق هذه الصفحة.</p></main></body></html>`));
}
