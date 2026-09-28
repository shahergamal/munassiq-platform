import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenantTx } from "../../db/pool.ts";
import { notFound } from "../../lib/errors.ts";
import { pageMeta, parsePage } from "../../lib/pagination.ts";
import { PROVIDERS, type Provider } from "../../lib/payments/gateways.ts";
import { connect, createLink, disconnect, reconcile, webhookUrl } from "../../lib/payments/service.ts";
import { auditTenant, isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";
import { idempotencyKey } from "./purchases.ts";

/**
 * The workspace's own payment gateways (Moyasar, Tap): the owner pastes the secret key from the gateway's
 * dashboard; invoices then get payment links, and paid links become receipts automatically.
 */

const providerParam = (v: unknown): Provider => {
  if (!PROVIDERS.includes(v as Provider)) throw notFound("بوابة الدفع غير معروفة");
  return v as Provider;
};

const LINK_COLUMNS = `l.id, l.provider, l.mode, l.amount::float8 AS amount, l.url, l.status, l.provider_status AS "providerStatus", l.payment_ref AS "paymentRef",
  l.receipt_id AS "receiptId", l.paid_at AS "paidAt", l.checked_at AS "checkedAt", l.created_at AS "createdAt"`;

export default async function paymentsRoutes(app: FastifyInstance) {
  app.get("/payments/connections", { preHandler: requireTenant("gateways.view", "acc_invoices.view") }, async (req) =>
    tenantTx(req, async (db) => {
      const rows = (await db.query<{ provider: Provider; mode: string; keyHint: string; webhookToken: string; connectedAt: Date; updatedAt: Date }>(
        `SELECT c.provider, c.mode, c.key_hint AS "keyHint", c.webhook_token AS "webhookToken", c.created_at AS "connectedAt", c.updated_at AS "updatedAt"
           FROM payment_connections c`)).rows;
      return {
        items: PROVIDERS.map((p) => {
          const c = rows.find((r) => r.provider === p);
          if (!c) return { provider: p, connected: false };
          const { webhookToken, ...rest } = c;
          return { ...rest, connected: true, webhooks: webhookUrl(req.tenant!.id, p, webhookToken) !== null };
        }),
      };
    }, { readOnly: true }));

  app.put("/payments/connections/:provider", { preHandler: requireTenant("gateways.manage"), config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } }, async (req) => {
    const provider = providerParam((req.params as { provider: string }).provider);
    const b = z.object({ secretKey: z.string().trim().min(10, "الصق المفتاح السري").max(200) }).parse(req.body);
    const ctx = { tenantId: req.tenant!.id, userId: req.tenant!.userId };
    await tenantTx(req, async () => undefined); // fails early (and the same way as every write) when the workspace is not operational
    const out = await connect(ctx, provider, b.secretKey);
    await withTenantTx(ctx, (db) => auditTenant(db, req, "payment_gateway.connected", "payment_connection", out.id, { provider, mode: out.mode }));
    return { provider, mode: out.mode };
  });

  app.delete("/payments/connections/:provider", { preHandler: requireTenant("gateways.manage") }, async (req, reply) => {
    const provider = providerParam((req.params as { provider: string }).provider);
    await tenantTx(req, async (db) => {
      const id = await disconnect(db, provider);
      if (!id) throw notFound("البوابة غير مربوطة");
      await auditTenant(db, req, "payment_gateway.disconnected", "payment_connection", id, { provider });
    });
    return reply.status(204).send();
  });

  app.get("/payments/links", { preHandler: requireTenant("gateways.view", "acc_invoices.view") }, async (req) => {
    const q = req.query as { documentId?: string; status?: string; page?: string; pageSize?: string };
    const page = parsePage(q);
    const doc = isUuid(q.documentId) ? q.documentId : null;
    const status = ["pending", "paid", "failed", "expired", "canceled"].includes(q.status ?? "") ? q.status : null;
    return tenantTx(req, async (db) => {
      const { rows } = await db.query(
        `SELECT ${LINK_COLUMNS}, l.document_id AS "documentId", d.doc_number AS "documentNumber", c.name AS "customerName", count(*) OVER()::int AS "_total"
           FROM payment_links l JOIN sales_documents d ON d.id = l.document_id JOIN customers c ON c.id = l.customer_id
          WHERE ($1::uuid IS NULL OR l.document_id = $1) AND ($2::text IS NULL OR l.status = $2)
          ORDER BY l.created_at DESC LIMIT $3 OFFSET $4`, [doc, status, page.pageSize, page.offset]);
      return { items: rows.map(({ _total, ...r }) => r), meta: pageMeta(page, rows[0]?._total ?? 0) };
    }, { readOnly: true });
  });

  app.post("/sales-documents/:id/payment-links", { preHandler: requireTenant("acc_invoices.create"), config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!isUuid(id)) throw notFound("الفاتورة غير موجودة");
    const key = idempotencyKey(req);
    const b = z.object({ provider: z.enum(["moyasar", "tap"], { message: "اختر بوابة الدفع" }) }).parse(req.body);
    await tenantTx(req, async () => undefined);
    const ctx = { tenantId: req.tenant!.id, userId: req.tenant!.userId };
    const out = await createLink(ctx, id, b.provider, key);
    const link = await withTenantTx(ctx, async (db) => {
      if (out.created) await auditTenant(db, req, "payment_link.created", "payment_link", out.id, { provider: b.provider, documentId: id });
      return (await db.query(`SELECT ${LINK_COLUMNS} FROM payment_links l WHERE l.id = $1`, [out.id])).rows[0];
    });
    return reply.status(out.created ? 201 : 200).send(link);
  });

  // "Check now": for when the webhook cannot reach this server (local development) or arrived before a hiccup.
  app.post("/payments/links/:id/check", { preHandler: requireTenant("acc_receipts.create", "acc_invoices.create"), config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    const id = (req.params as { id: string }).id;
    if (!isUuid(id)) throw notFound("رابط الدفع غير موجود");
    await tenantTx(req, async () => undefined);
    return reconcile(req.tenant!.id, id);
  });
}
