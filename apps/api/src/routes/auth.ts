import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { config } from "../config.ts";
import { systemPool, withSystemTx, type Db } from "../db/pool.ts";
import { AppError, badRequest } from "../lib/errors.ts";
import { sendMail } from "../lib/mailer.ts";
import {
  csrfTokenFor, DUMMY_HASH_PROMISE, hashPassword, newToken, passwordProblem, sha256Hex, verifyPassword,
} from "../lib/security.ts";
import { ABSOLUTE_DAYS, auditSystem, IDLE_HOURS, requireUser, SESSION_COOKIE } from "../plugins/auth.ts";

const email = z.string().trim().toLowerCase().email("بريد إلكتروني غير صحيح").max(255);
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

function setSessionCookie(reply: FastifyReply, token: string) {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax",
    path: "/",
    maxAge: ABSOLUTE_DAYS * 24 * 3600,
  });
}

async function issueToken(db: Db, userId: string, purpose: "verify_email" | "reset_password", hours: number): Promise<string> {
  const token = newToken();
  await db.query(
    "INSERT INTO one_time_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1, $2, $3, now() + make_interval(hours => $4))",
    [userId, purpose, sha256Hex(token), hours],
  );
  return token;
}

interface MeTenant {
  id: string; company_name: string; sector: string; status: string; role: string; role_name: string | null;
  sub_status: string | null; ends_at: string | null; operational: boolean;
}

async function buildMe(user: { id: string; email: string; fullName: string; emailVerified: boolean; isPlatformAdmin: boolean; sessionId: string }) {
  const { rows } = await systemPool.query<MeTenant>(
    `SELECT t.id, t.company_name, t.sector, t.status, m.role, (SELECT r.name FROM tenant_roles r WHERE r.id = m.custom_role_id) AS role_name, s.status AS sub_status, s.ends_at::text AS ends_at,
            (t.status = 'active' AND s.status IN ('trial', 'active') AND s.ends_at >= current_date) AS operational
       FROM memberships m
       JOIN tenants t ON t.id = m.tenant_id
       LEFT JOIN subscriptions s ON s.tenant_id = t.id AND s.status IN ('trial', 'active', 'suspended')
      WHERE m.user_id = $1 AND m.is_active
      ORDER BY t.created_at`,
    [user.id],
  );
  return {
    user: { id: user.id, email: user.email, fullName: user.fullName, emailVerified: user.emailVerified, isPlatformAdmin: user.isPlatformAdmin },
    tenants: rows.map((r) => ({
      id: r.id, companyName: r.company_name, sector: r.sector, status: r.status, role: r.role, roleName: r.role_name,
      subscriptionStatus: r.sub_status, endsAt: r.ends_at, operational: Boolean(r.operational),
    })),
    csrfToken: csrfTokenFor(user.sessionId, config.SESSION_SECRET),
  };
}

const MAX_PREFS = 300;

export default async function authRoutes(app: FastifyInstance) {
  app.post("/register", { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } }, async (req, reply) => {
    const body = z.object({
      email,
      password: z.string().min(1).max(128),
      fullName: z.string().trim().min(2, "أدخل الاسم الكامل").max(120),
      phone: z.string().trim().regex(/^\+?[0-9]{9,15}$/, "رقم جوال غير صحيح").optional(),
    }).parse(req.body);
    const problem = passwordProblem(body.password, body.email);
    if (problem) throw badRequest(problem);

    const hash = await hashPassword(body.password); // always hashed, so timing does not reveal whether the email exists
    let mail: { to: string; subject: string; text: string } | null = null;
    await withSystemTx(async (db) => {
      const ins = await db.query<{ id: string }>(
        "INSERT INTO users (email, password_hash, full_name, phone) VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING RETURNING id",
        [body.email, hash, body.fullName, body.phone ?? null],
      );
      const id = ins.rows[0]?.id;
      if (id) {
        const token = await issueToken(db, id, "verify_email", 24);
        await auditSystem(db, req, null, "user.registered", "user", id);
        mail = {
          to: body.email, subject: "فعّل حسابك في مُنَسِّق",
          text: `مرحباً ${body.fullName}،\n\nلتفعيل حسابك افتح الرابط التالي (صالح 24 ساعة):\n${config.APP_URL}/verify-email?token=${token}\n\nإذا لم تنشئ هذا الحساب تجاهل الرسالة.`,
        };
      } else {
        mail = {
          to: body.email, subject: "لديك حساب في مُنَسِّق بالفعل",
          text: `حاول أحدهم إنشاء حساب بهذا البريد وهو مسجل لدينا.\nسجّل الدخول من ${config.APP_URL}/login أو استعد كلمة المرور من ${config.APP_URL}/forgot-password`,
        };
      }
    });
    if (mail) await sendMail(mail);
    // Same answer whether or not the email was already registered.
    return reply.status(202).send({ ok: true });
  });

  app.post("/verify-email", { config: { rateLimit: { max: 20, timeWindow: "1 hour" } } }, async (req) => {
    const { token } = z.object({ token: z.string().min(20).max(200) }).parse(req.body);
    await withSystemTx(async (db) => {
      const used = await db.query<{ user_id: string }>(
        `UPDATE one_time_tokens SET used_at = now()
          WHERE token_hash = $1 AND purpose = 'verify_email' AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
        [sha256Hex(token)],
      );
      const userId = used.rows[0]?.user_id;
      if (!userId) throw new AppError(400, "invalid_token", "رابط التفعيل غير صالح أو منتهي. اطلب رابطاً جديداً");
      await db.query("UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1", [userId]);
    });
    return { ok: true };
  });

  app.post("/resend-verification", { config: { rateLimit: { max: 3, timeWindow: "1 hour" } } }, async (req, reply) => {
    const body = z.object({ email }).parse(req.body);
    let mail: { to: string; subject: string; text: string } | null = null;
    await withSystemTx(async (db) => {
      const u = await db.query<{ id: string }>("SELECT id FROM users WHERE email = $1 AND email_verified_at IS NULL AND status = 'active'", [body.email]);
      const id = u.rows[0]?.id;
      if (!id) return;
      const token = await issueToken(db, id, "verify_email", 24);
      mail = { to: body.email, subject: "رابط تفعيل حسابك", text: `${config.APP_URL}/verify-email?token=${token}` };
    });
    if (mail) await sendMail(mail);
    return reply.status(202).send({ ok: true });
  });

  app.post("/login", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (req, reply) => {
    const body = z.object({ email, password: z.string().min(1).max(128) }).parse(req.body);
    const generic = new AppError(401, "invalid_credentials", "البريد الإلكتروني أو كلمة المرور غير صحيحة");

    const found = await systemPool.query<{
      id: string; password_hash: string; email_verified_at: Date | null; status: string; locked_until: Date | null;
    }>("SELECT id, password_hash, email_verified_at, status, locked_until FROM users WHERE email = $1", [body.email]);
    const user = found.rows[0];

    if (user?.locked_until && user.locked_until > new Date()) {
      throw new AppError(429, "account_locked", "تم إيقاف تسجيل الدخول مؤقتاً بسبب محاولات كثيرة. حاول لاحقاً أو استعد كلمة المرور");
    }
    const ok = await verifyPassword(body.password, user?.password_hash ?? (await DUMMY_HASH_PROMISE));
    if (!user || !ok || user.status !== "active") {
      if (user) {
        await systemPool.query(
          `UPDATE users SET failed_login_count = CASE WHEN failed_login_count + 1 >= $2 THEN 0 ELSE failed_login_count + 1 END,
                            locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
            WHERE id = $1`,
          [user.id, MAX_FAILED, LOCK_MINUTES],
        );
      }
      throw generic;
    }
    if (!user.email_verified_at) {
      throw new AppError(403, "email_not_verified", "فعّل بريدك الإلكتروني أولاً. أرسلنا لك رابط التفعيل عند التسجيل");
    }

    const token = newToken(32);
    const session = await withSystemTx(async (db) => {
      await db.query("UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1", [user.id]);
      const s = await db.query<{ id: string }>(
        `INSERT INTO sessions (user_id, token_hash, idle_expires_at, absolute_expires_at, ip, user_agent)
         VALUES ($1, $2, now() + make_interval(hours => $3), now() + make_interval(days => $4), $5, $6) RETURNING id`,
        [user.id, sha256Hex(token), IDLE_HOURS, ABSOLUTE_DAYS, req.ip, (req.headers["user-agent"] ?? "").slice(0, 300)],
      );
      await db.query(
        "INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, ip) VALUES ($1, 'auth.login', 'user', $2, $3)",
        [user.id, user.id, req.ip],
      );
      return s.rows[0] as { id: string };
    });
    setSessionCookie(reply, token);
    const me = await systemPool.query<{ email: string; full_name: string; is_platform_admin: boolean }>(
      "SELECT email, full_name, is_platform_admin FROM users WHERE id = $1", [user.id]);
    const u = me.rows[0] as { email: string; full_name: string; is_platform_admin: boolean };
    return buildMe({ id: user.id, email: u.email, fullName: u.full_name, emailVerified: true, isPlatformAdmin: u.is_platform_admin, sessionId: session.id });
  });

  app.get("/me", async (req) => {
    const user = await requireUser(req);
    return buildMe(user);
  });

  // ── UI preferences (table sort + visible columns), per user, shared by all their devices ──────────
  const prefKey = z.string().min(1).max(120).refine((k) => !/[\u0000-\u001f\u007f]/.test(k), "مفتاح غير صالح");
  const tablePref = z.object({
    sort: z.array(z.object({ key: z.string().min(1).max(80), dir: z.enum(["asc", "desc"]) })).max(3),
    hidden: z.array(z.string().min(1).max(80)).max(100),
  }).strict();

  app.get("/prefs", async (req) => {
    const user = await requireUser(req);
    const { rows } = await systemPool.query<{ pref_key: string; value: unknown }>(
      "SELECT pref_key, value FROM user_ui_prefs WHERE user_id = $1", [user.id]);
    return { items: Object.fromEntries(rows.map((r) => [r.pref_key, r.value])) };
  });

  app.put("/prefs/:key", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req) => {
    const user = await requireUser(req);
    const key = prefKey.parse((req.params as { key: string }).key);
    const value = tablePref.parse(req.body);
    await withSystemTx(async (db) => {
      // A bounded number of layouts per user; replacing an existing one is always allowed.
      const n = (await db.query<{ n: number; has: boolean }>(
        "SELECT count(*)::int AS n, bool_or(pref_key = $2) AS has FROM user_ui_prefs WHERE user_id = $1", [user.id, key])).rows[0];
      if (n && !n.has && n.n >= MAX_PREFS) throw new AppError(422, "validation_failed", "تجاوزت الحد الأقصى للتفضيلات المحفوظة");
      await db.query(
        `INSERT INTO user_ui_prefs (user_id, pref_key, value) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, pref_key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [user.id, key, JSON.stringify(value)]);
    });
    return { ok: true };
  });

  app.delete("/prefs/:key", async (req) => {
    const user = await requireUser(req);
    const key = prefKey.parse((req.params as { key: string }).key);
    await systemPool.query("DELETE FROM user_ui_prefs WHERE user_id = $1 AND pref_key = $2", [user.id, key]);
    return { ok: true };
  });

  app.post("/logout", async (req, reply) => {
    const user = await requireUser(req);
    await systemPool.query("UPDATE sessions SET revoked_at = now() WHERE id = $1", [user.sessionId]);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.post("/change-password", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (req) => {
    const user = await requireUser(req);
    const body = z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(1).max(128) }).parse(req.body);
    const problem = passwordProblem(body.newPassword, user.email);
    if (problem) throw badRequest(problem);
    const row = (await systemPool.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [user.id])).rows[0];
    if (!row || !(await verifyPassword(body.currentPassword, row.password_hash))) {
      throw new AppError(403, "wrong_password", "كلمة المرور الحالية غير صحيحة");
    }
    const hash = await hashPassword(body.newPassword);
    await withSystemTx(async (db) => {
      await db.query("UPDATE users SET password_hash = $2 WHERE id = $1", [user.id, hash]);
      await db.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL", [user.id, user.sessionId]);
      await auditSystem(db, req, null, "auth.password_changed", "user", user.id);
    });
    return { ok: true };
  });

  app.post("/forgot-password", { config: { rateLimit: { max: 3, timeWindow: "1 hour" } } }, async (req, reply) => {
    const body = z.object({ email }).parse(req.body);
    let mail: { to: string; subject: string; text: string } | null = null;
    await withSystemTx(async (db) => {
      const u = await db.query<{ id: string }>("SELECT id FROM users WHERE email = $1 AND status = 'active'", [body.email]);
      const id = u.rows[0]?.id;
      if (!id) return;
      const token = await issueToken(db, id, "reset_password", 1);
      mail = { to: body.email, subject: "استعادة كلمة المرور", text: `لإعادة تعيين كلمة المرور (صالح ساعة واحدة):\n${config.APP_URL}/reset-password?token=${token}` };
    });
    if (mail) await sendMail(mail);
    return reply.status(202).send({ ok: true });
  });

  app.post("/reset-password", { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } }, async (req) => {
    const body = z.object({ token: z.string().min(20).max(200), password: z.string().min(1).max(128) }).parse(req.body);
    await withSystemTx(async (db) => {
      const used = await db.query<{ user_id: string }>(
        `UPDATE one_time_tokens SET used_at = now()
          WHERE token_hash = $1 AND purpose = 'reset_password' AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
        [sha256Hex(body.token)],
      );
      const userId = used.rows[0]?.user_id;
      if (!userId) throw new AppError(400, "invalid_token", "رابط الاستعادة غير صالح أو منتهي. اطلب رابطاً جديداً");
      const u = (await db.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [userId])).rows[0];
      const problem = passwordProblem(body.password, u?.email ?? "");
      if (problem) throw badRequest(problem);
      const hash = await hashPassword(body.password);
      await db.query(
        "UPDATE users SET password_hash = $2, failed_login_count = 0, locked_until = NULL, email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1",
        [userId, hash],
      );
      await db.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
      await auditSystem(db, req, null, "auth.password_reset", "user", userId);
    });
    return { ok: true };
  });
}
