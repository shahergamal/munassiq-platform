import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { call, createTenant, createUser, expectStatus, raiseLimits, startApp, stopApp, type Actor, type App } from "./helpers.ts";
import { config } from "../../src/config.ts";
import { systemPool } from "../../src/db/pool.ts";
import { stepOf, totpAt } from "../../src/lib/auth/totp.ts";
import { adminPolicy } from "../../src/plugins/auth.ts";
import { csrfTokenFor, newToken, sha256Hex } from "../../src/lib/security.ts";

// M8: two-step sign-in. A new session of a user with MFA on can only verify, read /auth/me or sign out; a code
// works once; recovery codes work once each; turning it off needs a code.
describe("two-step sign-in (TOTP)", () => {
  let app: App;
  let owner: Actor;
  let t: string;
  let secret: string;
  let recovery: string[];

  /** Another sign-in of the same user (as a login would create it). */
  const newSession = async (u: Actor): Promise<Actor> => {
    const token = newToken(32);
    const s = await systemPool.query<{ id: string }>(
      "INSERT INTO sessions (user_id, token_hash, idle_expires_at, absolute_expires_at) VALUES ($1, $2, now() + interval '1 hour', now() + interval '1 day') RETURNING id",
      [u.id, sha256Hex(token)]);
    return { ...u, token, csrf: csrfTokenFor(s.rows[0]!.id, config.SESSION_SECRET) };
  };
  // Codes are single-use: waiting 30 s for the next one is simulated by moving the last used step back.
  let used = 0;
  const freshCode = async () => {
    await systemPool.query("UPDATE users SET mfa_last_step = $2 WHERE id = $1", [owner.id, stepOf() - 5]);
    return totpAt(secret, stepOf());
  };

  before(async () => {
    app = await startApp();
    owner = await createUser();
    t = await createTenant(app, owner, "مطعم التحقق");
    await raiseLimits(t);
  });
  after(() => stopApp(app));

  it("setup shows a secret; enabling needs a correct code and returns recovery codes once", async () => {
    const s = await call(app, owner, "POST", "/auth/mfa/setup");
    expectStatus(s, 200, "setup");
    secret = s.body.secret;
    assert.match(s.body.uri, /^otpauth:\/\/totp\/Munassiq%3A.+\?secret=[A-Z2-7]+&issuer=Munassiq/);
    const raw = (await systemPool.query<{ enc: string }>("SELECT mfa_pending_secret_enc AS enc FROM users WHERE id = $1", [owner.id])).rows[0]!.enc;
    assert.ok(!raw.includes(secret), "sealed at rest");
    assert.equal((await call(app, owner, "POST", "/auth/mfa/enable", { body: { code: "000000" } })).status, 422);
    const e = await call(app, owner, "POST", "/auth/mfa/enable", { body: { code: totpAt(secret, stepOf()) } });
    expectStatus(e, 200, "enable");
    used = stepOf();
    recovery = e.body.recoveryCodes;
    assert.equal(recovery.length, 10);
    // The session that enabled it keeps working.
    expectStatus(await call(app, owner, "GET", "/t/ingredients", { tenant: t }), 200, "same session");
  });

  it("a new session is pending: only verify, me and logout; then a code completes it", async () => {
    const s2 = await newSession(owner);
    const blocked = await call(app, s2, "GET", "/t/ingredients", { tenant: t });
    assert.deepEqual([blocked.status, blocked.body.error.code], [401, "mfa_required"]);
    expectStatus(await call(app, s2, "GET", "/auth/me"), 200, "me stays open");
    assert.equal((await call(app, s2, "GET", "/auth/mfa")).body.pending, true);
    assert.equal((await call(app, s2, "POST", "/auth/mfa/verify", { body: { code: "123456" } })).status, 422);
    expectStatus(await call(app, s2, "POST", "/auth/mfa/verify", { body: { code: totpAt(secret, used) } }), 422, "a used code is refused");
    expectStatus(await call(app, s2, "POST", "/auth/mfa/verify", { body: { code: await freshCode() } }), 200, "verify");
    expectStatus(await call(app, s2, "GET", "/t/ingredients", { tenant: t }), 200, "now open");
    const fails = (await systemPool.query("SELECT 1 FROM audit_log WHERE actor_user_id = $1 AND action = 'auth.mfa_failed'", [owner.id])).rowCount;
    assert.ok(fails! >= 2, "failed attempts are audited");
  });

  it("a recovery code works once", async () => {
    const s3 = await newSession(owner);
    const r = await call(app, s3, "POST", "/auth/mfa/verify", { body: { recoveryCode: recovery[0] } });
    expectStatus(r, 200, "recovery");
    assert.equal(r.body.recoveryCodesLeft, 9);
    const s4 = await newSession(owner);
    assert.equal((await call(app, s4, "POST", "/auth/mfa/verify", { body: { recoveryCode: recovery[0] } })).status, 422, "used up");
  });

  it("turning it off needs a code; afterwards sessions are not pending", async () => {
    assert.equal((await call(app, owner, "POST", "/auth/mfa/disable", { body: { code: "000000" } })).status, 422);
    expectStatus(await call(app, owner, "POST", "/auth/mfa/disable", { body: { code: await freshCode() } }), 200, "disable");
    const s5 = await newSession(owner);
    expectStatus(await call(app, s5, "GET", "/t/ingredients", { tenant: t }), 200, "no second step");
  });

  it("with the production policy, a platform admin must turn it on before the admin panel", async () => {
    adminPolicy.mfaRequired = true;
    try {
      const admin = await createUser({ admin: true });
      const r = await call(app, admin, "GET", "/admin/tenants");
      assert.deepEqual([r.status, r.body.error.code], [403, "mfa_enrollment_required"]);
      const s = (await call(app, admin, "POST", "/auth/mfa/setup")).body.secret as string;
      expectStatus(await call(app, admin, "POST", "/auth/mfa/enable", { body: { code: totpAt(s, stepOf()) } }), 200, "enable");
      expectStatus(await call(app, admin, "GET", "/admin/tenants"), 200, "admin panel after enrolling");
    } finally {
      adminPolicy.mfaRequired = false;
    }
  });
});
