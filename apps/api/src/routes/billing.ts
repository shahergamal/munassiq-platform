import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { billingEnabled, checkout, settle } from "../lib/billing/service.ts";
import { mb } from "../lib/billing/storage.ts";
import { notFound } from "../lib/errors.ts";
import { isUuid, requireTenant, tenantTx } from "../plugins/auth.ts";
import { idempotencyKey } from "./restaurants/purchases.ts";

/**
 * The workspace's own subscription page: its plan, usage against limits, plans and storage packages to buy, and
 * its payments. Owners only (settings:manage). Prices come from the database; the browser sends only what to buy.
 */
export default async function billingRoutes(app: FastifyInstance) {
  app.get("/billing", { preHandler: requireTenant("billing.view") }, async (req) =>
    tenantTx(req, async (db) => {
      const t = (await db.query(
        `SELECT t.sector, s.status, s.starts_at::text AS "startsAt", s.ends_at::text AS "endsAt", p.code AS "planCode", p.name_ar AS "planName",
                tenant_limit(t.id, 'branches') AS "branchesLimit", tenant_limit(t.id, 'users') AS "usersLimit",
                (SELECT count(*)::int FROM branches b WHERE b.is_active) AS "branchesUsed",
                (SELECT count(*)::int FROM memberships m WHERE m.is_active) AS "usersUsed",
                st.limit_mb AS "storageLimitMb", st.used_bytes::float8 AS "storageUsedBytes", st.measured_at AS "storageMeasuredAt"
           FROM tenants t
           LEFT JOIN subscriptions s ON s.tenant_id = t.id AND s.status IN ('trial', 'active', 'suspended')
           LEFT JOIN plans p ON p.id = s.plan_id
           CROSS JOIN LATERAL tenant_storage_state(t.id) st`)).rows[0];
      if (!t) throw notFound();
      // Plans the workspace can move to: its sector, active and published (the trial is never sold).
      const plans = (await db.query(
        `SELECT code, name_ar AS "nameAr", monthly_price::float8 AS "monthlyPrice", annual_price::float8 AS "annualPrice",
                branches_limit AS "branchesLimit", users_limit AS "usersLimit", storage_limit_mb AS "storageLimitMb",
                description, features, badge, is_featured AS "isFeatured"
           FROM plans WHERE sector = $1 AND is_active AND is_public AND code NOT LIKE '%-trial' AND monthly_price > 0
          ORDER BY sort_order, monthly_price`, [t.sector])).rows;
      const addons = (await db.query(
        `SELECT id, name_ar AS "nameAr", size_mb AS "sizeMb", price::float8 AS price FROM storage_addons WHERE is_active ORDER BY sort_order, size_mb`)).rows;
      const payments = (await db.query(
        `SELECT id, kind, description, amount::float8 AS amount, status, mode, url, failure, created_at AS "createdAt", paid_at AS "paidAt"
           FROM platform_payments ORDER BY created_at DESC LIMIT 20`)).rows;
      const { sector: _s, storageUsedBytes, ...current } = t;
      return { enabled: billingEnabled(), current: { ...current, storageUsedMb: mb(storageUsedBytes) }, plans, addons, payments };
    }, { readOnly: true }));

  app.post("/billing/checkout", { preHandler: requireTenant("billing.pay"), config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } }, async (req, reply) => {
    const key = idempotencyKey(req);
    const b = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("subscription"), planCode: z.string().trim().min(3).max(60), period: z.enum(["monthly", "annual"]) }),
      z.object({ kind: z.literal("storage"), addonId: z.string().uuid() }),
    ]).parse(req.body);
    const out = await checkout(req.tenant!.id, req.tenant!.userId, b, key);
    return reply.status(201).send(out);
  });

  // After paying (or when the webhook cannot reach a local server): ask Moyasar and apply the payment once.
  app.post("/billing/payments/:id/check", { preHandler: requireTenant("billing.pay"), config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound("عملية الدفع غير موجودة");
    return settle(id, req.tenant!.id);
  });
}
