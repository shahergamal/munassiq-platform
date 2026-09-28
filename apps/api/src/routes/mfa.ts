import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.ts";
import { systemPool, withSystemTx } from "../db/pool.ts";
import { hashRecovery, newSecret, otpauthUri, recoveryCodes, verifyTotp } from "../lib/auth/totp.ts";
import { AppError } from "../lib/errors.ts";
import { open, seal } from "../lib/zatca/vault.ts";
import { auditSystem, requireUser } from "../plugins/auth.ts";

/**
 * Two-step sign-in with an authenticator app (M8). Turning it on: setup (a secret shown once as a QR code and as
 * text) → enable with a first code (recovery codes are shown once). Then every new session starts "pending" and
 * is completed here with a code or a recovery code (plugins/auth.ts lets a pending session reach only these).
 */

const PURPOSE = "auth/mfa/v1";
const secret = () => config.ZATCA_KEY_SECRET ?? config.SESSION_SECRET;
const code = z.string().trim().regex(/^\d{6}$/, "الرمز 6 أرقام من تطبيق المصادقة");

interface MfaRow { email: string; mfa_secret_enc: string | null; mfa_pending_secret_enc: string | null; mfa_enabled_at: Date | null; mfa_last_step: string | null; mfa_recovery_hashes: string[] }
const load = async (userId: string) => (await systemPool.query<MfaRow>(
  "SELECT email, mfa_secret_enc, mfa_pending_secret_enc, mfa_enabled_at, mfa_last_step::text, mfa_recovery_hashes FROM users WHERE id = $1", [userId])).rows[0]!;
const wrong = () => new AppError(422, "mfa_invalid", "الرمز غير صحيح أو مستخدم من قبل. انتظر الرمز التالي في التطبيق");

export default async function mfaRoutes(app: FastifyInstance) {
  app.get("/mfa", async (req) => {
    const user = await requireUser(req);
    const u = await load(user.id);
    return { enabled: Boolean(u.mfa_enabled_at), enabledAt: u.mfa_enabled_at, pending: Boolean(user.mfaPending), recoveryCodesLeft: u.mfa_recovery_hashes.length };
  });

  app.post("/mfa/setup", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (req) => {
    const user = await requireUser(req);
    const u = await load(user.id);
    if (u.mfa_enabled_at) throw new AppError(409, "mfa_enabled", "التحقق بخطوتين مفعّل. أوقفه أولاً لتغيير التطبيق");
    const s = newSecret();
    await systemPool.query("UPDATE users SET mfa_pending_secret_enc = $2 WHERE id = $1", [user.id, seal(s, secret(), PURPOSE)]);
    return { secret: s, uri: otpauthUri(s, u.email) };
  });

  app.post("/mfa/enable", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (req) => {
    const user = await requireUser(req);
    const b = z.object({ code }).parse(req.body);
    const u = await load(user.id);
    if (u.mfa_enabled_at) throw new AppError(409, "mfa_enabled", "التحقق بخطوتين مفعّل من قبل");
    if (!u.mfa_pending_secret_enc) throw new AppError(409, "mfa_setup_required", "ابدأ الإعداد أولاً لعرض رمز QR");
    const s = open(u.mfa_pending_secret_enc, secret(), PURPOSE);
    const step = verifyTotp(s, b.code, null);
    if (step === null) throw wrong();
    const rc = recoveryCodes();
    await withSystemTx(async (db) => {
      await db.query(`UPDATE users SET mfa_secret_enc = mfa_pending_secret_enc, mfa_pending_secret_enc = NULL, mfa_enabled_at = now(), mfa_last_step = $2,
                             mfa_recovery_hashes = $3 WHERE id = $1`, [user.id, step, rc.hashes]);
      // This session proved the code; the user's other sessions will be asked for it.
      await db.query("UPDATE sessions SET mfa_verified_at = now() WHERE id = $1", [user.sessionId]);
      await auditSystem(db, req, null, "auth.mfa_enabled", "user", user.id);
    });
    return { recoveryCodes: rc.codes };
  });

  // Completing a pending sign-in: a 6-digit code, or one recovery code (used up).
  app.post("/mfa/verify", { config: { rateLimit: { max: 8, timeWindow: "15 minutes" } } }, async (req) => {
    const user = await requireUser(req);
    const b = z.object({ code: code.optional(), recoveryCode: z.string().trim().min(8).max(20).optional() }).refine((x) => x.code || x.recoveryCode, "أدخل الرمز").parse(req.body);
    if (!user.mfaPending) return { ok: true };
    // A failed attempt is recorded in its own transaction: the verifying one rolls back.
    const failed = () => withSystemTx((d) => auditSystem(d, req, null, "auth.mfa_failed", "user", user.id));
    return withSystemTx(async (db) => {
      const u = (await db.query<MfaRow>(
        "SELECT email, mfa_secret_enc, mfa_pending_secret_enc, mfa_enabled_at, mfa_last_step::text, mfa_recovery_hashes FROM users WHERE id = $1 FOR UPDATE", [user.id])).rows[0]!;
      let how: "code" | "recovery";
      if (b.code) {
        const step = verifyTotp(open(u.mfa_secret_enc!, secret(), PURPOSE), b.code, u.mfa_last_step === null ? null : Number(u.mfa_last_step));
        if (step === null) { await failed(); throw wrong(); }
        await db.query("UPDATE users SET mfa_last_step = $2 WHERE id = $1", [user.id, step]);
        how = "code";
      } else {
        const h = hashRecovery(b.recoveryCode!);
        if (!u.mfa_recovery_hashes.includes(h)) { await failed(); throw new AppError(422, "mfa_invalid", "رمز الاسترداد غير صحيح أو مستخدم"); }
        await db.query("UPDATE users SET mfa_recovery_hashes = array_remove(mfa_recovery_hashes, $2) WHERE id = $1", [user.id, h]);
        how = "recovery";
      }
      await db.query("UPDATE sessions SET mfa_verified_at = now() WHERE id = $1", [user.sessionId]);
      await auditSystem(db, req, null, "auth.mfa_verified", "user", user.id, { how });
      return { ok: true, recoveryCodesLeft: how === "recovery" ? u.mfa_recovery_hashes.length - 1 : u.mfa_recovery_hashes.length };
    });
  });

  // Turning it off, or new recovery codes, both need a current code.
  const withCode = async (userId: string, c: string) => {
    const u = await load(userId);
    if (!u.mfa_enabled_at) throw new AppError(409, "mfa_disabled", "التحقق بخطوتين غير مفعّل");
    const step = verifyTotp(open(u.mfa_secret_enc!, secret(), PURPOSE), c, u.mfa_last_step === null ? null : Number(u.mfa_last_step));
    if (step === null) throw wrong();
    return step;
  };
  app.post("/mfa/disable", { config: { rateLimit: { max: 8, timeWindow: "15 minutes" } } }, async (req) => {
    const user = await requireUser(req);
    const b = z.object({ code }).parse(req.body);
    await withCode(user.id, b.code);
    await withSystemTx(async (db) => {
      await db.query(`UPDATE users SET mfa_secret_enc = NULL, mfa_pending_secret_enc = NULL, mfa_enabled_at = NULL, mfa_last_step = NULL, mfa_recovery_hashes = '{}' WHERE id = $1`, [user.id]);
      await auditSystem(db, req, null, "auth.mfa_disabled", "user", user.id);
    });
    return { ok: true };
  });
  app.post("/mfa/recovery-codes", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (req) => {
    const user = await requireUser(req);
    const b = z.object({ code }).parse(req.body);
    const step = await withCode(user.id, b.code);
    const rc = recoveryCodes();
    await withSystemTx(async (db) => {
      await db.query("UPDATE users SET mfa_recovery_hashes = $2, mfa_last_step = $3 WHERE id = $1", [user.id, rc.hashes, step]);
      await auditSystem(db, req, null, "auth.mfa_recovery_regenerated", "user", user.id);
    });
    return { recoveryCodes: rc.codes };
  });
}
