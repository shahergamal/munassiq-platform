import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { systemPool, withSystemTx } from "../db/pool.ts";
import { billingEnabled } from "../lib/billing/service.ts";
import { measureAll, measureTenant } from "../lib/billing/storage.ts";
import { AppError, notFound } from "../lib/errors.ts";
import { pageMeta, parsePage } from "../lib/pagination.ts";
import { blockIp, features, listBlocks, purgeCache, serverStats, suspiciousIps, triggerDeploy, unblock } from "../lib/ops/service.ts";
import { auditSystem, isUuid, requireAdmin } from "../plugins/auth.ts";

/**
 * Platform admin: the server and Cloudflare (operations), storage packages and payments received (billing).
 * Every action is audited; the destructive ones (restart, block) are confirmed in the UI.
 */
export default async function adminServerRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAdmin);

  // ── Server ───────────────────────────────────────────────────────────────────────
  app.get("/server", async () => serverStats());

  app.post("/server/deploy", { config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } }, async (req) => {
    const out = await triggerDeploy();
    await withSystemTx((db) => auditSystem(db, req, null, "server.deploy_requested", "server", "deploy", { status: out.status }));
    return out;
  });

  app.post("/server/restart", { config: { rateLimit: { max: 3, timeWindow: "10 minutes" } } }, async (req, reply) => {
    if (!features().restart) {
      throw new AppError(409, "not_configured", "إعادة التشغيل غير مفعّلة. فعّلها بـ SERVER_RESTART_ENABLED=true فقط إن كانت منصة الاستضافة تعيد تشغيل الخادم تلقائياً");
    }
    await withSystemTx((db) => auditSystem(db, req, null, "server.restart_requested", "server", "restart", {}));
    // Answer first, then the normal graceful shutdown (server.ts): finish requests, close pools, exit; the supervisor starts it again.
    reply.send({ restarting: true });
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 500).unref();
    return reply;
  });

  // ── Cloudflare ─────────────────────────────────────────────────────────────────────
  app.post("/cloudflare/purge", { config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } }, async (req) => {
    const b = z.object({ files: z.array(z.string().url("رابط غير صحيح").max(500)).max(30).optional() }).parse(req.body ?? {});
    const out = await purgeCache(b.files ?? null);
    await withSystemTx((db) => auditSystem(db, req, null, "cloudflare.cache_purged", "cloudflare", "cache", { files: b.files ?? "everything" }));
    return out;
  });

  app.get("/cloudflare/blocks", async () => ({ items: await listBlocks() }));

  app.post("/cloudflare/blocks", async (req, reply) => {
    const b = z.object({ ip: z.string().trim().min(3).max(60), note: z.string().trim().min(3, "اكتب سبب الحظر").max(200) }).parse(req.body);
    const out = await blockIp(b.ip, b.note, req.ip ?? null);
    await withSystemTx((db) => auditSystem(db, req, null, "cloudflare.ip_blocked", "cloudflare_rule", out.id || out.value, { ip: out.value, note: b.note }));
    return reply.status(201).send(out);
  });

  app.delete("/cloudflare/blocks/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await unblock(id);
    await withSystemTx((db) => auditSystem(db, req, null, "cloudflare.ip_unblocked", "cloudflare_rule", id, {}));
    return reply.status(204).send();
  });

  app.get("/security/suspicious", async (req) => {
    const q = req.query as { hours?: string; min?: string };
    const hours = Math.min(Math.max(Number(q.hours) || 24, 1), 720);
    const min = Math.min(Math.max(Number(q.min) || 10, 1), 10_000);
    return { hours, min, items: await suspiciousIps(hours, min) };
  });

  // ── Storage and billing ─────────────────────────────────────────────────────────────
  app.get("/storage-addons", async () => ({
    items: (await systemPool.query(
      `SELECT a.id, a.name_ar AS "nameAr", a.size_mb AS "sizeMb", a.price::float8 AS price, a.is_active AS "isActive", a.sort_order AS "sortOrder",
              (SELECT count(*)::int FROM platform_payments p WHERE p.addon_id = a.id AND p.status = 'paid') AS "soldCount"
         FROM storage_addons a ORDER BY a.sort_order, a.size_mb`)).rows,
    billingEnabled: billingEnabled(),
  }));

  const addonBody = z.object({
    nameAr: z.string().trim().min(2, "اكتب اسم الباقة").max(80),
    sizeMb: z.number().int().min(10).max(10_000_000),
    price: z.number().positive("السعر أكبر من صفر").max(1_000_000),
    isActive: z.boolean().default(true),
    sortOrder: z.number().int().min(0).max(1000).default(0),
  });
  app.post("/storage-addons", async (req, reply) => {
    const b = addonBody.parse(req.body);
    const id = await withSystemTx(async (db) => {
      const r = await db.query<{ id: string }>("INSERT INTO storage_addons (name_ar, size_mb, price, is_active, sort_order) VALUES ($1, $2, $3, $4, $5) RETURNING id",
        [b.nameAr, b.sizeMb, b.price, b.isActive, b.sortOrder]);
      await auditSystem(db, req, null, "storage_addon.created", "storage_addon", r.rows[0]!.id, b);
      return r.rows[0]!.id;
    });
    return reply.status(201).send({ id });
  });
  app.patch("/storage-addons/:id", async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = addonBody.partial().parse(req.body);
    await withSystemTx(async (db) => {
      const r = await db.query(
        `UPDATE storage_addons SET name_ar = coalesce($2, name_ar), size_mb = coalesce($3, size_mb), price = coalesce($4, price),
                is_active = coalesce($5, is_active), sort_order = coalesce($6, sort_order) WHERE id = $1`,
        [id, b.nameAr ?? null, b.sizeMb ?? null, b.price ?? null, b.isActive ?? null, b.sortOrder ?? null]);
      if (!r.rowCount) throw notFound("باقة المساحة غير موجودة");
      await auditSystem(db, req, null, "storage_addon.updated", "storage_addon", id, b);
    });
    return { ok: true };
  });

  app.get("/billing/payments", async (req) => {
    const q = req.query as { status?: string; page?: string; pageSize?: string };
    const page = parsePage(q);
    const status = ["pending", "paid", "failed", "expired", "canceled"].includes(q.status ?? "") ? q.status : null;
    const { rows } = await systemPool.query(
      `SELECT p.id, p.kind, p.description, p.amount::float8 AS amount, p.status, p.mode, p.created_at AS "createdAt", p.paid_at AS "paidAt", p.failure,
              t.id AS "tenantId", t.company_name AS "companyName", count(*) OVER()::int AS "_total"
         FROM platform_payments p JOIN tenants t ON t.id = p.tenant_id
        WHERE $1::text IS NULL OR p.status = $1 ORDER BY p.created_at DESC LIMIT $2 OFFSET $3`, [status, page.pageSize, page.offset]);
    const totals = (await systemPool.query<{ paid30: number; paidAll: number }>(
      `SELECT coalesce(sum(amount) FILTER (WHERE paid_at > now() - interval '30 days'), 0)::float8 AS paid30, coalesce(sum(amount), 0)::float8 AS "paidAll"
         FROM platform_payments WHERE status = 'paid' AND mode = 'live'`)).rows[0];
    return { items: rows.map(({ _total, ...r }) => r), meta: pageMeta(page, rows[0]?._total ?? 0), totals, billingEnabled: billingEnabled() };
  });

  // Storage measured now instead of at the next hourly pass.
  app.post("/storage/recalculate", { config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } }, async (req) => {
    const b = z.object({ tenantId: z.string().uuid().optional() }).parse(req.body ?? {});
    const n = b.tenantId ? (await measureTenant(b.tenantId), 1) : await measureAll((err) => req.log.warn({ err }, "storage measure failed"));
    return { measured: n };
  });

  // The admin grants storage by hand (a gift, a correction): the new extra on top of the plan's limit.
  app.put("/tenants/:id/storage", async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ extraMb: z.number().int().min(0).max(100_000_000) }).parse(req.body);
    await withSystemTx(async (db) => {
      if (!(await db.query("SELECT 1 FROM tenants WHERE id = $1", [id])).rowCount) throw notFound();
      const before = (await db.query<{ extra_mb: number }>("SELECT extra_mb FROM tenant_storage WHERE tenant_id = $1", [id])).rows[0]?.extra_mb ?? 0;
      await db.query(`INSERT INTO tenant_storage (tenant_id, extra_mb) VALUES ($1, $2) ON CONFLICT (tenant_id) DO UPDATE SET extra_mb = EXCLUDED.extra_mb`, [id, b.extraMb]);
      await auditSystem(db, req, id, "storage.extra_set", "tenant", id, { from: before, to: b.extraMb });
    });
    return { ok: true };
  });
}
