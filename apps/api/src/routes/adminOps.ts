import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { systemPool, withSystemTx } from "../db/pool.ts";
import { AppError } from "../lib/errors.ts";
import { likePattern, pageMeta, parsePage, sortSql } from "../lib/pagination.ts";
import { createTenant, defaultGeneralSettings, generalSettingsSchema, readGeneralSettings } from "../lib/tenancy.ts";
import { auditSystem, requireAdmin } from "../plugins/auth.ts";

const TZ = "Asia/Riyadh";
const SUBSCRIPTION_SORT = ["companyName", "planName", "status", "startsAt", "endsAt", "daysLeft", "totalValue"];
const USAGE_SORT = ["companyName", "planName", "branchesUsed", "usersUsed", "locations", "peak"];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** `from`/`to` as YYYY-MM-DD in Riyadh; default: the last 30 days. */
function period(q: { from?: string; to?: string }) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
  const back = new Date(Date.parse(`${today}T12:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
  const from = ISO.test(q.from ?? "") ? q.from! : back;
  const to = ISO.test(q.to ?? "") ? q.to! : today;
  if (from > to) throw new AppError(422, "validation_failed", "تاريخ البداية بعد تاريخ النهاية");
  return { from, to };
}
const sectorOf = (v: unknown) => (typeof v === "string" && /^[a-z_]{2,40}$/.test(v) ? v : null);

// Platform operations. Admin only; aggregated counts and subscription records, never a tenant's business data
// (a tenant's own records stay reachable only through an audited support session).
export default async function adminOpsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAdmin);

  app.get("/subscriptions", async (req) => {
    const q = req.query as { q?: string; status?: string; expiring?: string; page?: string; pageSize?: string; sort?: string };
    const page = parsePage(q);
    const search = q.q?.trim() ? likePattern(q.q) : null;
    const status = ["trial", "active", "expired", "suspended"].includes(q.status ?? "") ? q.status : null;
    const { rows } = await systemPool.query(
      `SELECT s.id, s.tenant_id AS "tenantId", t.company_name AS "companyName", t.sector, p.name_ar AS "planName", s.status,
              s.starts_at::text AS "startsAt", s.ends_at::text AS "endsAt", (s.ends_at - current_date)::int AS "daysLeft",
              (s.ends_at - s.starts_at)::int AS "totalDays", s.total_value::float8 AS "totalValue", count(*) OVER()::int AS "_total"
         FROM subscriptions s JOIN tenants t ON t.id = s.tenant_id JOIN plans p ON p.id = s.plan_id JOIN users u ON u.id = t.owner_user_id
        WHERE ($1::text IS NULL OR t.company_name ILIKE $1 OR u.email ILIKE $1)
          AND ($2::text IS NULL OR s.status = $2)
          AND (NOT $3 OR (s.status IN ('trial', 'active') AND s.ends_at BETWEEN current_date AND current_date + 30))
        ORDER BY ${sortSql(q.sort, SUBSCRIPTION_SORT)}s.ends_at, s.id LIMIT $4 OFFSET $5`,
      [search, status, q.expiring === "true", page.pageSize, page.offset]);
    const sum = (await systemPool.query(
      `SELECT count(*) FILTER (WHERE status = 'active' AND ends_at >= current_date)::int AS active,
              count(*) FILTER (WHERE status = 'trial' AND ends_at >= current_date)::int AS trial,
              count(*) FILTER (WHERE status IN ('trial', 'active') AND ends_at BETWEEN current_date AND current_date + 30)::int AS expiring,
              count(*) FILTER (WHERE status = 'suspended' OR (status IN ('trial', 'active') AND ends_at < current_date))::int AS lapsed
         FROM subscriptions`)).rows[0];
    return { items: rows.map(({ _total, ...r }) => r), meta: pageMeta(page, rows[0]?._total ?? 0), summary: sum };
  });

  app.get("/sectors", async () => {
    const { rows } = await systemPool.query(
      `SELECT s.key, s.name_ar AS "nameAr", s.is_available AS "isAvailable",
              (SELECT count(*)::int FROM tenants t WHERE t.sector = s.key AND t.status = 'active') AS "activeTenants",
              (SELECT count(*)::int FROM tenants t WHERE t.sector = s.key) AS "allTenants",
              (SELECT count(*)::int FROM plans p WHERE p.sector = s.key AND p.is_active) AS "plans",
              (SELECT count(*)::int FROM waitlist w WHERE w.sector = s.key) AS waitlist,
              (SELECT count(*)::int FROM waitlist w WHERE w.sector = s.key AND w.created_at > now() - interval '30 days') AS "waitlist30"
         FROM sectors s ORDER BY s.is_available DESC, s.key`);
    return { items: rows };
  });

  app.get("/usage", async (req) => {
    const q = req.query as { q?: string; near?: string; page?: string; pageSize?: string; sort?: string };
    const page = parsePage(q);
    const search = q.q?.trim() ? likePattern(q.q) : null;
    const { rows } = await systemPool.query(
      `WITH u AS (
         SELECT t.id, t.company_name AS "companyName", t.status, p.name_ar AS "planName",
                (SELECT count(*)::int FROM branches b WHERE b.tenant_id = t.id AND b.is_active) AS "branchesUsed",
                tenant_limit(t.id, 'branches') AS "branchesLimit",
                (SELECT count(*)::int FROM memberships m WHERE m.tenant_id = t.id AND m.is_active) AS "usersUsed",
                tenant_limit(t.id, 'users') AS "usersLimit",
                (SELECT count(*)::int FROM locations l WHERE l.tenant_id = t.id AND l.is_active) AS locations
           FROM tenants t
           LEFT JOIN subscriptions s ON s.tenant_id = t.id AND s.status IN ('trial', 'active', 'suspended')
           LEFT JOIN plans p ON p.id = s.plan_id JOIN users o ON o.id = t.owner_user_id
          WHERE t.status <> 'archived' AND ($1::text IS NULL OR t.company_name ILIKE $1 OR o.email ILIKE $1)
       )
       SELECT *, round(100.0 * greatest(coalesce("branchesUsed"::numeric / nullif("branchesLimit", 0), 0),
                                        coalesce("usersUsed"::numeric / nullif("usersLimit", 0), 0)))::int AS peak,
              count(*) OVER()::int AS "_total"
         FROM u
        WHERE NOT $2 OR greatest(coalesce("branchesUsed"::numeric / nullif("branchesLimit", 0), 0), coalesce("usersUsed"::numeric / nullif("usersLimit", 0), 0)) >= 0.8
        ORDER BY ${sortSql(q.sort, USAGE_SORT)}peak DESC, "companyName" LIMIT $3 OFFSET $4`,
      [search, q.near === "true", page.pageSize, page.offset]);
    return { items: rows.map(({ _total, ...r }) => r), meta: pageMeta(page, rows[0]?._total ?? 0) };
  });

  app.get("/reports/financial", async (req) => {
    const q = req.query as { from?: string; to?: string; sector?: string };
    const { from, to } = period(q);
    const sector = sectorOf(q.sector);
    const args = [from, to, sector];
    const summary = (await systemPool.query(
      `SELECT count(*) FILTER (WHERE s.status = 'active' AND s.ends_at >= current_date)::int AS "activePaid",
              coalesce(sum(p.monthly_price) FILTER (WHERE s.status = 'active' AND s.ends_at >= current_date), 0)::float8 AS mrr,
              count(*) FILTER (WHERE s.status = 'trial' AND s.ends_at >= current_date)::int AS "runningTrials",
              count(*) FILTER (WHERE s.status = 'active' AND s.ends_at BETWEEN current_date AND current_date + 30)::int AS "renewalsDue",
              coalesce(sum(p.monthly_price) FILTER (WHERE s.status = 'active' AND s.ends_at BETWEEN current_date AND current_date + 30), 0)::float8 AS "renewalsMrr",
              count(*) FILTER (WHERE s.status <> 'trial' AND s.starts_at BETWEEN $1::date AND $2::date)::int AS "contracts",
              coalesce(sum(s.total_value) FILTER (WHERE s.status <> 'trial' AND s.starts_at BETWEEN $1::date AND $2::date), 0)::float8 AS "contractsValue"
         FROM subscriptions s JOIN plans p ON p.id = s.plan_id JOIN tenants t ON t.id = s.tenant_id
        WHERE $3::text IS NULL OR t.sector = $3`, args)).rows[0];
    const byPlan = (await systemPool.query(
      `SELECT p.code, p.name_ar AS "planName", x.name_ar AS "sectorName", p.monthly_price::float8 AS "monthlyPrice",
              count(s.id) FILTER (WHERE s.status = 'active' AND s.ends_at >= current_date)::int AS active,
              count(s.id) FILTER (WHERE s.status = 'trial' AND s.ends_at >= current_date)::int AS trials,
              coalesce(sum(p.monthly_price) FILTER (WHERE s.status = 'active' AND s.ends_at >= current_date), 0)::float8 AS mrr
         FROM plans p JOIN sectors x ON x.key = p.sector LEFT JOIN subscriptions s ON s.plan_id = p.id
        WHERE $1::text IS NULL OR p.sector = $1
        GROUP BY p.id, x.name_ar HAVING count(s.id) > 0 OR p.is_active
        ORDER BY mrr DESC, active DESC, p.name_ar`, [sector])).rows;
    const contracts = (await systemPool.query(
      `SELECT s.id, s.tenant_id AS "tenantId", t.company_name AS "companyName", p.name_ar AS "planName", s.status,
              s.starts_at::text AS "startsAt", s.ends_at::text AS "endsAt", s.total_value::float8 AS "totalValue"
         FROM subscriptions s JOIN plans p ON p.id = s.plan_id JOIN tenants t ON t.id = s.tenant_id
        WHERE s.status <> 'trial' AND s.starts_at BETWEEN $1::date AND $2::date AND ($3::text IS NULL OR t.sector = $3)
        ORDER BY s.starts_at DESC LIMIT 500`, args)).rows;
    return { from, to, summary, byPlan, contracts };
  });

  app.get("/reports/operations", async (req) => {
    const q = req.query as { from?: string; to?: string; sector?: string };
    const { from, to } = period(q);
    const sector = sectorOf(q.sector);
    const inRange = (col: string) => `(${col} AT TIME ZONE '${TZ}')::date BETWEEN $1::date AND $2::date`;
    const summary = (await systemPool.query(
      `WITH t AS (SELECT * FROM tenants WHERE $3::text IS NULL OR sector = $3)
       SELECT (SELECT count(*) FROM t WHERE ${inRange("created_at")})::int AS "newTenants",
              (SELECT count(*) FROM t WHERE status = 'active')::int AS "activeTenants",
              (SELECT count(*) FROM t WHERE status = 'blocked')::int AS "blockedTenants",
              (SELECT count(*) FROM subscriptions s JOIN t ON t.id = s.tenant_id WHERE s.status = 'trial' AND s.starts_at BETWEEN $1::date AND $2::date)::int AS "trialsStarted",
              (SELECT count(DISTINCT t.id) FROM t JOIN subscriptions a ON a.tenant_id = t.id AND a.status = 'active'
                 WHERE ${inRange("t.created_at")})::int AS "converted",
              (SELECT count(*) FROM t WHERE status = 'active' AND NOT EXISTS (
                 SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
                  WHERE m.tenant_id = t.id AND m.is_active AND u.last_login_at > now() - interval '14 days'))::int AS "dormantTenants",
              (SELECT count(*) FROM users WHERE ${inRange("created_at")})::int AS "newUsers",
              (SELECT count(*) FROM users WHERE last_login_at > now() - interval '14 days')::int AS "activeUsers14",
              (SELECT count(*) FROM users WHERE status = 'suspended')::int AS "suspendedUsers",
              (SELECT count(*) FROM support_sessions ss JOIN t ON t.id = ss.tenant_id WHERE ${inRange("ss.started_at")})::int AS "supportSessions",
              (SELECT count(*) FROM waitlist w WHERE ${inRange("w.created_at")} AND ($3::text IS NULL OR w.sector = $3))::int AS "waitlist"`,
      [from, to, sector])).rows[0];
    const daily = (await systemPool.query(
      `SELECT d::date::text AS day,
              (SELECT count(*)::int FROM tenants t WHERE ($3::text IS NULL OR t.sector = $3) AND (t.created_at AT TIME ZONE '${TZ}')::date = d::date) AS tenants,
              (SELECT count(*)::int FROM users u WHERE (u.created_at AT TIME ZONE '${TZ}')::date = d::date) AS users
         FROM generate_series($1::date, $2::date, interval '1 day') d ORDER BY d DESC`, [from, to, sector])).rows;
    return { from, to, summary, daily };
  });

  app.get("/settings", async () => {
    const r = (await systemPool.query<{ updated_at: Date; name: string | null }>(
      "SELECT s.updated_at, u.full_name AS name FROM platform_settings s LEFT JOIN users u ON u.id = s.updated_by WHERE s.key = 'general'")).rows[0];
    return { settings: await readGeneralSettings(systemPool), defaults: defaultGeneralSettings, updatedAt: r?.updated_at ?? null, updatedBy: r?.name ?? null };
  });

  app.put("/settings", async (req) => {
    const next = generalSettingsSchema.parse(req.body);
    await withSystemTx(async (db) => {
      const before = await readGeneralSettings(db);
      await db.query(
        `INSERT INTO platform_settings (key, value, updated_by) VALUES ('general', $1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [JSON.stringify(next), req.auth!.id]);
      await auditSystem(db, req, null, "platform.settings_updated", "platform_settings", "general", { before, after: next });
    });
    return { ok: true };
  });

  // A workspace created by the admin for an existing, verified account; that account becomes its owner. The admin may
  // open one in a sector that is not on sale yet (a pilot customer); self sign-up never can.
  app.post("/tenants", async (req, reply) => {
    const body = z.object({
      ownerEmail: z.string().trim().toLowerCase().email("أدخل بريد المالك الصحيح"),
      companyName: z.string().trim().min(2, "أدخل اسم المنشأة").max(180),
      sector: z.string().trim().min(2).max(40),
      taxId: z.string().trim().regex(/^[0-9]{10,15}$/, "أدخل رقماً ضريبياً أو سجلاً تجارياً صحيحاً (10 إلى 15 رقماً)"),
      city: z.string().trim().max(100).nullable().optional().transform((v) => v || null),
      planCode: z.string().trim().max(60).nullable().optional().transform((v) => v || null),
      endsAt: z.string().regex(ISO).nullable().optional().transform((v) => v || null),
      totalValue: z.number().min(0).max(100_000_000).default(0),
    }).parse(req.body);
    const id = await withSystemTx(async (db) => {
      const owner = (await db.query<{ id: string }>("SELECT id FROM users WHERE email = $1 AND email_verified_at IS NOT NULL AND status = 'active'", [body.ownerEmail])).rows[0];
      if (!owner) throw new AppError(422, "validation_failed", "لا يوجد حساب مفعّل بهذا البريد. اطلب من العميل التسجيل وتفعيل بريده أولاً", [{ path: "ownerEmail", message: "لا يوجد حساب مفعّل بهذا البريد" }]);
      const trialCode = `${body.sector}-trial`;
      if (!body.planCode || body.planCode === trialCode) {
        return createTenant(db, req, { ownerId: owner.id, companyName: body.companyName, sector: body.sector, taxId: body.taxId, city: body.city, pilot: true });
      }
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
      if (!body.endsAt || body.endsAt <= today) throw new AppError(422, "validation_failed", "حدد تاريخ نهاية الاشتراك بعد اليوم", [{ path: "endsAt", message: "تاريخ النهاية بعد اليوم" }]);
      return createTenant(db, req, { ownerId: owner.id, companyName: body.companyName, sector: body.sector, taxId: body.taxId, city: body.city, pilot: true,
        plan: { code: body.planCode, status: "active", endsAt: body.endsAt, totalValue: body.totalValue } });
    });
    return reply.status(201).send({ id });
  });
}
