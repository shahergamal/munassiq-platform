import type { FastifyRequest } from "fastify";
import { config } from "../config.ts";
import { systemPool, withTenantTx, type Db, type TenantCtx } from "../db/pool.ts";
import { AppError, forbidden, notOperational, unauthorized } from "../lib/errors.ts";
import { inSector, normalizePermissions, permissionsOf, sectorPermissions, type EffectiveRole, type MemberRole, type Permission } from "../lib/rbac.ts";
import { sha256Hex, verifyCsrf } from "../lib/security.ts";

export const SESSION_COOKIE = "mn_sid";
export const IDLE_HOURS = 8;
export const ABSOLUTE_DAYS = 30;

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  emailVerified: boolean;
  isPlatformAdmin: boolean;
  sessionId: string;
  /** Signed in with the password, the authenticator code not yet verified (users with MFA on). */
  mfaPending?: boolean;
  mfaEnabled?: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthUser;
    tenant?: TenantAccess;
  }
}

export interface TenantAccess {
  id: string;
  role: EffectiveRole;
  /** Display name of a custom role; null for built-in roles. */
  roleName: string | null;
  userId: string;
  /** The workspace's business (tenants.sector): pages of other sectors do not exist for it. */
  sector: string;
  permissions: readonly Permission[];
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

interface SessionRow {
  session_id: string;
  last_seen_at: Date;
  id: string;
  email: string;
  full_name: string;
  email_verified_at: Date | null;
  is_platform_admin: boolean;
  mfa_pending: boolean;
  mfa_enabled: boolean;
}

export async function authenticate(req: FastifyRequest): Promise<AuthUser | null> {
  const raw = req.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const { rows } = await systemPool.query<SessionRow>(
    `SELECT s.id AS session_id, s.last_seen_at, u.id, u.email, u.full_name, u.email_verified_at, u.is_platform_admin,
            (u.mfa_enabled_at IS NOT NULL AND s.mfa_verified_at IS NULL) AS mfa_pending, u.mfa_enabled_at IS NOT NULL AS mfa_enabled
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL
        AND s.idle_expires_at > now() AND s.absolute_expires_at > now() AND u.status = 'active'`,
    [sha256Hex(raw)],
  );
  const row = rows[0];
  if (!row) return null;
  if (Date.now() - row.last_seen_at.getTime() > 5 * 60_000) {
    // Sliding idle timeout, refreshed at most every 5 minutes; failure here must never break the request.
    void systemPool
      .query(
        `UPDATE sessions SET last_seen_at = now(),
                idle_expires_at = least(now() + make_interval(hours => $2), absolute_expires_at) WHERE id = $1`,
        [row.session_id, IDLE_HOURS],
      )
      .catch(() => undefined);
  }
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    emailVerified: row.email_verified_at !== null,
    isPlatformAdmin: row.is_platform_admin,
    sessionId: row.session_id,
    mfaPending: row.mfa_pending,
    mfaEnabled: row.mfa_enabled,
  };
}

/** What a session still waiting for its authenticator code may do: identify itself, verify, or sign out. */
const MFA_PENDING_OPEN = new Set(["/api/v1/auth/me", "/api/v1/auth/logout", "/api/v1/auth/mfa", "/api/v1/auth/mfa/verify"]);

/** Requires a valid session; on unsafe methods also requires the CSRF token bound to that session. */
export async function requireUser(req: FastifyRequest): Promise<AuthUser> {
  const user = req.auth ?? (await authenticate(req));
  if (!user) throw unauthorized();
  if (user.mfaPending && !MFA_PENDING_OPEN.has(req.routeOptions?.url ?? "")) {
    throw new AppError(401, "mfa_required", "أدخل رمز التحقق من تطبيق المصادقة لإكمال تسجيل الدخول");
  }
  if (UNSAFE.has(req.method)) {
    const header = req.headers["x-csrf-token"];
    if (!verifyCsrf(user.sessionId, typeof header === "string" ? header : undefined, config.SESSION_SECRET)) {
      throw new AppError(403, "csrf_invalid", "انتهت صلاحية الجلسة الأمنية. أعد تحميل الصفحة");
    }
  }
  req.auth = user;
  return user;
}

/** Whether platform admins must have two-step sign-in on (ADMIN_MFA_REQUIRED, default: production). Tests switch it. */
export const adminPolicy = { mfaRequired: config.ADMIN_MFA_REQUIRED ? config.ADMIN_MFA_REQUIRED === "true" : config.isProd };
const adminNeedsMfa = (user: AuthUser) => adminPolicy.mfaRequired && !user.mfaEnabled;
const enrollMfa = () => new AppError(403, "mfa_enrollment_required", "فعّل التحقق بخطوتين من صفحة «حسابي» قبل استخدام صلاحيات مدير المنصة");

export async function requireAdmin(req: FastifyRequest): Promise<AuthUser> {
  const user = await requireUser(req);
  if (!user.isPlatformAdmin) throw forbidden("هذه الصفحة مخصصة لمدير المنصة");
  if (adminNeedsMfa(user)) throw enrollMfa();
  return user;
}

/**
 * Resolves the tenant explicitly from the X-Tenant-Id header and verifies membership on every request, then the
 * permission: `page.action` from lib/rbac.ts (one of several when a list is shared by screens).
 * A platform admin has no implicit access: only an active, audited support session grants read-only access.
 */
export function requireTenant(...anyOf: Permission[]) {
  return async (req: FastifyRequest): Promise<void> => {
    const user = await requireUser(req);
    const tenantId = req.headers["x-tenant-id"];
    if (!isUuid(tenantId)) throw new AppError(400, "tenant_required", "لم يتم تحديد المنشأة");

    const { rows } = await systemPool.query<{ role: MemberRole | null; permissions: string[] | null; role_name: string | null; sector: string }>(
      `SELECT m.role, r.permissions, r.name AS role_name, t.sector
         FROM tenants t LEFT JOIN memberships m ON m.tenant_id = t.id AND m.user_id = $2 AND m.is_active
         LEFT JOIN tenant_roles r ON r.id = m.custom_role_id
        WHERE t.id = $1`,
      [tenantId, user.id],
    );
    let role: EffectiveRole | null = rows[0]?.role ?? null;
    if (!role && user.isPlatformAdmin) {
      const support = await systemPool.query(
        "SELECT 1 FROM support_sessions WHERE admin_user_id = $1 AND tenant_id = $2 AND ended_at IS NULL AND expires_at > now()",
        [user.id, tenantId],
      );
      if (support.rowCount) {
        if (adminNeedsMfa(user)) throw enrollMfa();
        role = "support";
      }
    }
    if (!role) throw forbidden("ليس لديك وصول إلى هذه المنشأة");
    const sector = rows[0]!.sector;
    // Custom role permissions are read fresh on every request, so an edit to a role applies immediately. A role only
    // ever holds the pages of this workspace's sector.
    const permissions = sectorPermissions(role === "custom" ? normalizePermissions(rows[0]?.permissions ?? []) : permissionsOf(role), sector);
    // A page of another sector does not exist here (404, not "ask for access").
    if (anyOf.length && !anyOf.some((p) => inSector(p, sector))) throw new AppError(404, "not_found", "هذه الصفحة غير متاحة لنشاط منشأتك");
    // Any one of the listed permissions opens the endpoint (a lookup several screens share); none listed = any member.
    if (anyOf.length && !anyOf.some((p) => permissions.includes(p))) throw forbidden();
    req.tenant = { id: tenantId, role, roleName: rows[0]?.role_name ?? null, userId: user.id, sector, permissions };
  };
}

export function tenantTx<T>(req: FastifyRequest, fn: (db: Db) => Promise<T>, opts: { readOnly?: boolean } = {}): Promise<T> {
  if (!req.tenant) throw new AppError(500, "internal", "tenant context missing");
  const ctx: TenantCtx = { tenantId: req.tenant.id, userId: req.tenant.userId };
  if (opts.readOnly) return withTenantTx(ctx, fn, opts);
  // RLS rejects INSERTs on a non-operational tenant, but UPDATE/DELETE policies just filter rows out, which would
  // surface as a misleading 404 (or a silent no-op). Check once up front so every write fails the same way.
  return withTenantTx(ctx, async (db) => {
    const op = await db.query<{ ok: boolean }>("SELECT tenant_is_operational(app_tenant_id()) AS ok");
    if (!op.rows[0]?.ok) throw notOperational();
    return fn(db);
  });
}

export function clientIp(req: FastifyRequest): string | null {
  return req.ip || null;
}

/** Append an audit record inside the caller's tenant transaction. */
export async function auditTenant(db: Db, req: FastifyRequest, action: string, entityType: string, entityId: string, meta: object = {}): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor_user_id, tenant_id, action, entity_type, entity_id, meta, ip)
     VALUES ($1, app_tenant_id(), $2, $3, $4, $5, $6)`,
    [req.tenant?.userId ?? null, action, entityType, entityId, JSON.stringify(meta), clientIp(req)],
  );
}

/** Append an audit record from a system transaction. */
export async function auditSystem(db: Db, req: FastifyRequest, tenantId: string | null, action: string, entityType: string, entityId: string, meta: object = {}): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor_user_id, tenant_id, action, entity_type, entity_id, meta, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [req.auth?.id ?? null, tenantId, action, entityType, entityId, JSON.stringify(meta), clientIp(req)],
  );
}
