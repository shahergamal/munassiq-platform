import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { systemPool, withSystemTx } from "../db/pool.ts";
import { AppError, badRequest, notFound } from "../lib/errors.ts";
import { likePattern, pageMeta, parsePage, sortSql } from "../lib/pagination.ts";
import { auditSystem, isUuid, requireAdmin } from "../plugins/auth.ts";
import { CATALOG, PERMISSIONS, permissionsOf, ROLES } from "../lib/rbac.ts";
import { config } from "../config.ts";

const SUPPORT_MINUTES = 60;
const TENANT_SORT = ["companyName", "ownerEmail", "taxId", "planName", "subscriptionStatus", "endsAt", "status"];
const USER_SORT = ["fullName", "email", "tenantsCount", "lastLoginAt", "status"];
const AUDIT_SORT = ["at", "action", "actorEmail"];
const WAITLIST_SORT = ["companyName", "sector", "email", "phone", "createdAt"];

// Platform administration. Every route: platform admin only, system pool, GET = no side effects,
// every state change = one transaction + one audit record.
export default async function adminRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAdmin);

  app.get("/stats", async () => {
    const r = (await systemPool.query(
      `SELECT (SELECT count(*)::int FROM tenants WHERE status = 'active') AS "activeTenants",
              (SELECT count(*)::int FROM tenants WHERE status = 'blocked') AS "blockedTenants",
              (SELECT count(*)::int FROM users) AS users,
              (SELECT count(*)::int FROM subscriptions WHERE status = 'trial' AND ends_at >= current_date) AS "runningTrials",
              (SELECT count(*)::int FROM subscriptions WHERE status IN ('trial','active') AND ends_at BETWEEN current_date AND current_date + 7) AS "expiringSoon",
              (SELECT count(*)::int FROM subscriptions WHERE status = 'active' AND ends_at >= current_date) AS "paidActive",
              (SELECT count(*)::int FROM waitlist) AS waitlist`)).rows[0];
    return r;
  });

  app.get("/plans", async () => {
    const { rows } = await systemPool.query(
      `SELECT p.code, p.name_ar AS "nameAr", p.sector, s.name_ar AS "sectorName", p.monthly_price::float8 AS "monthlyPrice",
              p.branches_limit AS "branchesLimit", p.users_limit AS "usersLimit", p.storage_limit_mb AS "storageLimitMb", p.is_active AS "isActive",
              p.description, p.features, p.badge, p.is_featured AS "isFeatured", p.is_public AS "isPublic",
              p.annual_price::float8 AS "annualPrice", p.sort_order AS "sortOrder",
              (SELECT count(*)::int FROM subscriptions x WHERE x.plan_id = p.id AND x.status IN ('trial', 'active', 'suspended')) AS "tenantsCount"
         FROM plans p JOIN sectors s ON s.key = p.sector ORDER BY p.sector, p.sort_order, p.monthly_price`);
    return { items: rows };
  });

  // The matrix the server actually enforces (lib/rbac.ts), read-only: roles are code, not settings.
  app.get("/roles", async () => ({ catalog: CATALOG, permissions: PERMISSIONS, roles: [...ROLES, "support" as const].map((r) => ({ role: r, permissions: permissionsOf(r) })) }));

  const planBody = z.object({
    nameAr: z.string().trim().min(2).max(80),
    monthlyPrice: z.number().min(0).max(1_000_000),
    branchesLimit: z.number().int().min(1).max(10_000),
    usersLimit: z.number().int().min(1).max(100_000),
    storageLimitMb: z.number().int().min(10).max(10_000_000).default(1024),
    isActive: z.boolean().default(true),
    // What the public landing page shows for this plan.
    description: z.string().trim().max(300).nullable().optional().transform((v) => v || null),
    features: z.array(z.string().trim().min(1).max(80)).max(12).default([]),
    badge: z.string().trim().max(30).nullable().optional().transform((v) => v || null),
    isFeatured: z.boolean().default(false),
    // A new plan stays off the landing page until the admin publishes it.
    isPublic: z.boolean().default(false),
    annualPrice: z.number().min(0).max(12_000_000).nullable().optional().transform((v) => v ?? null),
    sortOrder: z.number().int().min(0).max(1000).default(0),
  });

  app.post("/plans", async (req, reply) => {
    const b = planBody.extend({
      code: z.string().trim().regex(/^[a-z0-9-]{3,60}$/, "الرمز حروف إنجليزية صغيرة وأرقام وشرطة فقط"),
      sector: z.string().trim().min(2).max(40),
    }).parse(req.body);
    await withSystemTx(async (db) => {
      const sec = await db.query("SELECT 1 FROM sectors WHERE key = $1", [b.sector]);
      if (!sec.rowCount) throw badRequest("قطاع غير معروف");
      try {
        await db.query(
          `INSERT INTO plans (sector, code, name_ar, monthly_price, branches_limit, users_limit, is_active, description, features, badge, is_featured, is_public, annual_price, sort_order, storage_limit_mb)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [b.sector, b.code, b.nameAr, b.monthlyPrice, b.branchesLimit, b.usersLimit, b.isActive, b.description, b.features, b.badge, b.isFeatured, b.isPublic, b.annualPrice, b.sortOrder, b.storageLimitMb]);
      } catch (err) {
        if ((err as { code?: string }).code === "23505") throw new AppError(409, "duplicate", "رمز الباقة مستخدم");
        throw err;
      }
      await auditSystem(db, req, null, "plan.created", "plan", b.code, b);
    });
    return reply.status(201).send({ ok: true });
  });

  app.patch("/plans/:code", async (req) => {
    const { code } = req.params as { code: string };
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const b = planBody.partial().parse(req.body);
    // Only fields the client actually sent are written (zod defaults must not reset the others).
    const sent = (k: string) => Object.prototype.hasOwnProperty.call(raw, k);
    await withSystemTx(async (db) => {
      const cur = (await db.query<{ sector: string }>("SELECT sector FROM plans WHERE code = $1 FOR UPDATE", [code])).rows[0];
      if (!cur) throw notFound("الباقة غير موجودة");
      // Sign-up gives every new tenant the "<sector>-trial" plan; disabling it would break registration.
      if (b.isActive === false && code === `${cur.sector}-trial`) throw new AppError(409, "plan_required", "باقة التجربة مطلوبة لتسجيل المنشآت الجديدة ولا يمكن إيقافها");
      await db.query(
        `UPDATE plans SET name_ar = coalesce($2, name_ar), monthly_price = coalesce($3, monthly_price), branches_limit = coalesce($4, branches_limit),
                users_limit = coalesce($5, users_limit), is_active = coalesce($6, is_active),
                description = CASE WHEN $7 THEN $8 ELSE description END, features = CASE WHEN $9 THEN $10::text[] ELSE features END,
                badge = CASE WHEN $11 THEN $12 ELSE badge END, is_featured = CASE WHEN $13 THEN $14 ELSE is_featured END,
                is_public = CASE WHEN $15 THEN $16 ELSE is_public END, annual_price = CASE WHEN $17 THEN $18::numeric ELSE annual_price END,
                sort_order = CASE WHEN $19 THEN $20 ELSE sort_order END, storage_limit_mb = coalesce($21, storage_limit_mb) WHERE code = $1`,
        [code, b.nameAr ?? null, b.monthlyPrice ?? null, b.branchesLimit ?? null, b.usersLimit ?? null, sent("isActive") ? b.isActive : null,
          sent("description"), b.description ?? null, sent("features"), b.features ?? [], sent("badge"), b.badge ?? null, sent("isFeatured"), b.isFeatured ?? false,
          sent("isPublic"), b.isPublic ?? false, sent("annualPrice"), b.annualPrice ?? null, sent("sortOrder"), b.sortOrder ?? 0, sent("storageLimitMb") ? b.storageLimitMb : null]);
      await auditSystem(db, req, null, "plan.updated", "plan", code, b);
    });
    return { ok: true };
  });

  app.get("/tenants", async (req) => {
    const q = req.query as { q?: string; status?: string; page?: string; pageSize?: string; sort?: string };
    const page = parsePage(q);
    const search = q.q?.trim() ? likePattern(q.q) : null;
    const status = ["active", "blocked", "archived"].includes(q.status ?? "") ? q.status : null;
    const { rows } = await systemPool.query(
      `SELECT t.id, t.company_name AS "companyName", t.sector, t.status, t.tax_id AS "taxId", t.tax_id_verified AS "taxIdVerified", t.created_at AS "createdAt",
              u.email AS "ownerEmail", s.status AS "subscriptionStatus", s.ends_at::text AS "endsAt", p.name_ar AS "planName",
              (SELECT count(*)::int FROM tenants d WHERE d.tax_id = t.tax_id AND d.id <> t.id) > 0 AS "duplicateTaxId",
              count(*) OVER()::int AS "_total"
         FROM tenants t JOIN users u ON u.id = t.owner_user_id
         LEFT JOIN subscriptions s ON s.tenant_id = t.id AND s.status IN ('trial','active','suspended')
         LEFT JOIN plans p ON p.id = s.plan_id
        WHERE ($1::text IS NULL OR t.company_name ILIKE $1 OR u.email ILIKE $1 OR t.tax_id ILIKE $1)
          AND ($2::text IS NULL OR t.status = $2)
        ORDER BY ${sortSql(q.sort, TENANT_SORT)}t.created_at DESC LIMIT $3 OFFSET $4`, [search, status, page.pageSize, page.offset]);
    return { items: rows.map(({ _total, ...r }) => r), meta: pageMeta(page, rows[0]?._total ?? 0) };
  });

  app.get("/tenants/:id", async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const t = (await systemPool.query(
      `SELECT t.id, t.company_name AS "companyName", t.sector, t.status, t.blocked_reason AS "blockedReason", t.tax_id AS "taxId",
              t.tax_id_verified AS "taxIdVerified", t.city, t.created_at AS "createdAt", u.email AS "ownerEmail", u.full_name AS "ownerName",
              s.id AS "subscriptionId", s.status AS "subscriptionStatus", s.starts_at::text AS "startsAt", s.ends_at::text AS "endsAt",
              s.total_value::float8 AS "totalValue", p.code AS "planCode", p.name_ar AS "planName",
              o.branches_limit AS "branchesOverride", o.users_limit AS "usersOverride", o.assistant_daily_turns AS "assistantOverride",
              (SELECT coalesce(sum(a.turns), 0)::int FROM assistant_usage a WHERE a.tenant_id = t.id AND a.day = (now() AT TIME ZONE 'Asia/Riyadh')::date) AS "assistantTurnsToday",
              (SELECT coalesce(sum(a.turns), 0)::int FROM assistant_usage a WHERE a.tenant_id = t.id AND a.day > (now() AT TIME ZONE 'Asia/Riyadh')::date - 30) AS "assistantTurns30",
              tenant_limit(t.id, 'branches') AS "branchesLimit", tenant_limit(t.id, 'users') AS "usersLimit",
              (SELECT count(*)::int FROM branches b WHERE b.tenant_id = t.id AND b.is_active) AS "branchesUsed",
              (SELECT count(*)::int FROM memberships m WHERE m.tenant_id = t.id AND m.is_active) AS "usersUsed",
              st.limit_mb AS "storageLimitMb", st.used_bytes::float8 AS "storageUsedBytes", st.measured_at AS "storageMeasuredAt",
              coalesce((SELECT x.extra_mb FROM tenant_storage x WHERE x.tenant_id = t.id), 0) AS "storageExtraMb"
         FROM tenants t JOIN users u ON u.id = t.owner_user_id CROSS JOIN LATERAL tenant_storage_state(t.id) st
         LEFT JOIN subscriptions s ON s.tenant_id = t.id AND s.status IN ('trial','active','suspended')
         LEFT JOIN plans p ON p.id = s.plan_id LEFT JOIN tenant_limit_overrides o ON o.tenant_id = t.id
        WHERE t.id = $1`, [id])).rows[0];
    if (!t) throw notFound();
    const members = (await systemPool.query(
      `SELECT u.id AS "userId", u.email, u.full_name AS "fullName", m.role, (SELECT r.name FROM tenant_roles r WHERE r.id = m.custom_role_id) AS "roleName", m.is_active AS "isActive"
         FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = $1 ORDER BY m.created_at`, [id])).rows;
    return { ...t, assistantDefault: config.ASSISTANT_DAILY_TURNS, members };
  });

  app.post("/tenants/:id/status", async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const body = z.object({ status: z.enum(["active", "blocked"]), reason: z.string().trim().max(300).optional() }).parse(req.body);
    if (body.status === "blocked" && (body.reason?.length ?? 0) < 3) throw badRequest("سبب الإيقاف مطلوب");
    await withSystemTx(async (db) => {
      const cur = (await db.query<{ status: string }>("SELECT status FROM tenants WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!cur) throw notFound();
      await db.query("UPDATE tenants SET status = $2, blocked_reason = $3 WHERE id = $1", [id, body.status, body.status === "blocked" ? body.reason : null]);
      await auditSystem(db, req, id, "tenant.status_changed", "tenant", id, { from: cur.status, to: body.status, reason: body.reason ?? null });
    });
    return { ok: true };
  });

  app.put("/tenants/:id/subscription", async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const body = z.object({
      planCode: z.string().min(3).max(60),
      status: z.enum(["trial", "active", "suspended", "expired"]),
      startsAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endsAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      totalValue: z.number().min(0).max(100_000_000).default(0),
    }).parse(req.body);
    if (body.endsAt <= body.startsAt) throw badRequest("تاريخ النهاية يجب أن يكون بعد البداية");
    await withSystemTx(async (db) => {
      const t = (await db.query<{ sector: string }>("SELECT sector FROM tenants WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!t) throw notFound();
      const plan = (await db.query<{ id: string; sector: string }>("SELECT id, sector FROM plans WHERE code = $1 AND is_active", [body.planCode])).rows[0];
      if (!plan || plan.sector !== t.sector) throw badRequest("الباقة غير موجودة أو لا تخص قطاع هذه المنشأة");
      const cur = (await db.query<{ id: string }>("SELECT id FROM subscriptions WHERE tenant_id = $1 AND status IN ('trial','active','suspended') FOR UPDATE", [id])).rows[0];
      if (cur) {
        await db.query("UPDATE subscriptions SET plan_id = $2, status = $3, starts_at = $4, ends_at = $5, total_value = $6 WHERE id = $1",
          [cur.id, plan.id, body.status, body.startsAt, body.endsAt, body.totalValue]);
      } else {
        await db.query("INSERT INTO subscriptions (tenant_id, plan_id, status, starts_at, ends_at, total_value) VALUES ($1, $2, $3, $4, $5, $6)",
          [id, plan.id, body.status, body.startsAt, body.endsAt, body.totalValue]);
      }
      await auditSystem(db, req, id, "subscription.updated", "subscription", id, body);
    });
    return { ok: true };
  });

  app.put("/tenants/:id/limits", async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const body = z.object({
      branchesLimit: z.number().int().min(1).max(10_000).nullable(),
      usersLimit: z.number().int().min(1).max(100_000).nullable(),
      // Questions per member per day; null = server default, 0 = assistant off for this workspace. Omitted = unchanged.
      assistantDailyTurns: z.number().int().min(0).max(10_000).nullable().optional(),
    }).parse(req.body);
    await withSystemTx(async (db) => {
      await db.query(
        `INSERT INTO tenant_limit_overrides (tenant_id, branches_limit, users_limit, assistant_daily_turns) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id) DO UPDATE SET branches_limit = EXCLUDED.branches_limit, users_limit = EXCLUDED.users_limit,
           assistant_daily_turns = CASE WHEN $5 THEN EXCLUDED.assistant_daily_turns ELSE tenant_limit_overrides.assistant_daily_turns END`,
        [id, body.branchesLimit, body.usersLimit, body.assistantDailyTurns ?? null, body.assistantDailyTurns !== undefined]);
      await auditSystem(db, req, id, "limits.updated", "tenant", id, body);
    });
    return { ok: true };
  });

  app.post("/tenants/:id/verify-tax-id", async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    await withSystemTx(async (db) => {
      try {
        const res = await db.query("UPDATE tenants SET tax_id_verified = true WHERE id = $1", [id]);
        if (!res.rowCount) throw notFound();
      } catch (err) {
        if ((err as { constraint?: string }).constraint === "tenants_tax_id_verified_uq") {
          throw new AppError(409, "tax_id_taken", "هذا الرقم الضريبي موثّق لمنشأة أخرى");
        }
        throw err;
      }
      await auditSystem(db, req, id, "tenant.tax_id_verified", "tenant", id);
    });
    return { ok: true };
  });

  app.get("/users", async (req) => {
    const q = req.query as { q?: string; page?: string; pageSize?: string; sort?: string };
    const page = parsePage(q);
    const search = q.q?.trim() ? likePattern(q.q) : null;
    const { rows } = await systemPool.query(
      `SELECT u.id, u.email, u.full_name AS "fullName", u.status, u.is_platform_admin AS "isPlatformAdmin",
              u.email_verified_at IS NOT NULL AS "emailVerified", u.last_login_at AS "lastLoginAt",
              (SELECT count(*)::int FROM memberships m WHERE m.user_id = u.id AND m.is_active) AS "tenantsCount", count(*) OVER()::int AS "_total"
         FROM users u WHERE ($1::text IS NULL OR u.email ILIKE $1 OR u.full_name ILIKE $1)
        ORDER BY ${sortSql(q.sort, USER_SORT)}u.created_at DESC LIMIT $2 OFFSET $3`, [search, page.pageSize, page.offset]);
    return { items: rows.map(({ _total, ...r }) => r), meta: pageMeta(page, rows[0]?._total ?? 0) };
  });

  // One transaction: the account is suspended AND every session is revoked, or nothing changes.
  app.post("/users/:id/suspend", async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    if (id === req.auth!.id) throw badRequest("لا يمكنك إيقاف حسابك الحالي");
    const { reason } = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body);
    await withSystemTx(async (db) => {
      const res = await db.query("UPDATE users SET status = 'suspended' WHERE id = $1", [id]);
      if (!res.rowCount) throw notFound();
      await db.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [id]);
      await auditSystem(db, req, null, "user.suspended", "user", id, { reason });
    });
    return { ok: true };
  });

  app.post("/users/:id/restore", async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    await withSystemTx(async (db) => {
      const res = await db.query("UPDATE users SET status = 'active', failed_login_count = 0, locked_until = NULL WHERE id = $1", [id]);
      if (!res.rowCount) throw notFound();
      await auditSystem(db, req, null, "user.restored", "user", id);
    });
    return { ok: true };
  });

  // Support access: explicit, reasoned, time-boxed, audited, READ-ONLY (role "support").
  app.post("/support-sessions", async (req, reply) => {
    const body = z.object({ tenantId: z.string().uuid(), reason: z.string().trim().min(5, "اكتب سبب الدخول (5 أحرف على الأقل)").max(300) }).parse(req.body);
    const out = await withSystemTx(async (db) => {
      const t = await db.query("SELECT 1 FROM tenants WHERE id = $1", [body.tenantId]);
      if (!t.rowCount) throw notFound("المنشأة غير موجودة");
      await db.query("UPDATE support_sessions SET ended_at = now() WHERE admin_user_id = $1 AND tenant_id = $2 AND ended_at IS NULL", [req.auth!.id, body.tenantId]);
      const s = (await db.query<{ id: string; expires_at: Date }>(
        `INSERT INTO support_sessions (admin_user_id, tenant_id, reason, expires_at) VALUES ($1, $2, $3, now() + make_interval(mins => $4))
         RETURNING id, expires_at`, [req.auth!.id, body.tenantId, body.reason, SUPPORT_MINUTES])).rows[0] as { id: string; expires_at: Date };
      await auditSystem(db, req, body.tenantId, "support.started", "support_session", s.id, { reason: body.reason });
      return { id: s.id, expiresAt: s.expires_at };
    });
    return reply.status(201).send(out);
  });

  app.delete("/support-sessions/:id", async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    await withSystemTx(async (db) => {
      const res = await db.query<{ tenant_id: string }>("UPDATE support_sessions SET ended_at = now() WHERE id = $1 AND admin_user_id = $2 AND ended_at IS NULL RETURNING tenant_id", [id, req.auth!.id]);
      if (!res.rows[0]) throw notFound();
      await auditSystem(db, req, res.rows[0].tenant_id, "support.ended", "support_session", id);
    });
    return { ok: true };
  });

  app.get("/audit", async (req) => {
    const q = req.query as { tenantId?: string; page?: string; pageSize?: string; sort?: string };
    const page = parsePage(q);
    const tenantId = isUuid(q.tenantId) ? q.tenantId : null;
    const { rows } = await systemPool.query(
      `SELECT a.id, a.at, a.action, a.entity_type AS "entityType", a.entity_id AS "entityId", a.tenant_id AS "tenantId", a.meta,
              u.email AS "actorEmail", count(*) OVER()::int AS "_total"
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE ($1::uuid IS NULL OR a.tenant_id = $1) ORDER BY ${sortSql(q.sort, AUDIT_SORT)}a.id DESC LIMIT $2 OFFSET $3`, [tenantId, page.pageSize, page.offset]);
    return { items: rows.map(({ _total, ...r }) => r), meta: pageMeta(page, rows[0]?._total ?? 0) };
  });

  app.get("/waitlist", async (req) => {
    const q = req.query as { page?: string; pageSize?: string; sort?: string };
    const page = parsePage(q);
    const { rows } = await systemPool.query(
      `SELECT id, email, company_name AS "companyName", sector, phone, created_at AS "createdAt", count(*) OVER()::int AS "_total"
         FROM waitlist ORDER BY ${sortSql(q.sort, WAITLIST_SORT)}created_at DESC LIMIT $1 OFFSET $2`, [page.pageSize, page.offset]);
    return { items: rows.map(({ _total, ...r }) => r), meta: pageMeta(page, rows[0]?._total ?? 0) };
  });
}
