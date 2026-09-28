import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { type Actor, type App, call, nextIp, ownerPool, startApp, stopApp, uniqueEmail } from "./helpers.ts";

// In development/test (no SMTP_URL) the mailer prints messages to the console; capture them to read the links.
const mails: string[] = [];
const realLog = console.log;
console.log = (...args: unknown[]) => {
  const s = args.map(String).join(" ");
  if (s.includes("[mail:dev]")) mails.push(s);
  else realLog(...args);
};
function tokenFor(email: string, path: string): string {
  const m = [...mails].reverse().find((x) => x.includes(`to=${email}`) && x.includes(path));
  const t = m?.match(new RegExp(`${path}\\?token=([A-Za-z0-9_-]+)`))?.[1];
  if (!t) throw new Error(`no ${path} mail for ${email}`);
  return t;
}

describe("account lifecycle", () => {
  let app: App;
  const pw = "Correct-Horse-Battery-9";

  before(async () => { app = await startApp(); });
  after(async () => { console.log = realLog; await stopApp(app); });

  async function login(email: string, password: string, ip = nextIp()) {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password }, remoteAddress: ip });
    const cookie = res.cookies.find((c) => c.name === "mn_sid");
    const body = JSON.parse(res.body);
    return { status: res.statusCode, body, actor: cookie ? ({ id: body.user.id, email, token: cookie.value, csrf: body.csrfToken, ip } as Actor) : null, cookie };
  }

  it("register → verify e-mail → login → create workspace → logout", async () => {
    const email = uniqueEmail("reg");
    const reg = await call(app, null, "POST", "/auth/register", { body: { email, password: pw, fullName: "سارة أحمد" } });
    assert.equal(reg.status, 202);

    const early = await login(email, pw);
    assert.equal(early.status, 403);
    assert.equal(early.body.error.code, "email_not_verified");

    assert.equal((await call(app, null, "POST", "/auth/verify-email", { body: { token: tokenFor(email, "verify-email") } })).status, 200);
    assert.equal((await call(app, null, "POST", "/auth/verify-email", { body: { token: tokenFor(email, "verify-email") } })).status, 400, "token is single-use");

    const ok = await login(email, pw);
    assert.equal(ok.status, 200);
    assert.equal(ok.cookie?.httpOnly, true);
    assert.equal(ok.cookie?.sameSite, "Lax");
    const me = ok.actor!;

    const sectors = await call(app, null, "GET", "/sectors");
    assert.deepEqual(sectors.body.filter((s: { isAvailable: boolean }) => s.isAvailable).map((s: { key: string }) => s.key).sort(), ["manufacturing", "restaurants"]);
    const unavailable = await call(app, me, "POST", "/tenants", { body: { companyName: "مقاولات", sector: "contracting", taxId: "3001234567" } });
    assert.equal(unavailable.body.error.code, "sector_unavailable");
    const t = await call(app, me, "POST", "/tenants", { body: { companyName: "مطعم سارة", sector: "restaurants", taxId: "3001234567" } });
    assert.equal(t.status, 201);

    const profile = await call(app, me, "GET", "/auth/me");
    assert.equal(profile.body.tenants.length, 1);
    assert.equal(profile.body.tenants[0].role, "owner");
    assert.equal(profile.body.tenants[0].operational, true);

    assert.equal((await call(app, me, "POST", "/auth/logout")).status, 200);
    assert.equal((await call(app, me, "GET", "/auth/me")).status, 401);
  });

  it("registering an existing e-mail gives the same answer and does not create a second account", async () => {
    const email = uniqueEmail("dup");
    await call(app, null, "POST", "/auth/register", { body: { email, password: pw, fullName: "مستخدم" } });
    const again = await call(app, null, "POST", "/auth/register", { body: { email, password: pw, fullName: "مستخدم آخر" } });
    assert.equal(again.status, 202);
    const n = await ownerPool.query("SELECT count(*)::int AS n FROM users WHERE email = $1", [email]);
    assert.equal(n.rows[0].n, 1);
  });

  it("weak passwords are refused", async () => {
    const r = await call(app, null, "POST", "/auth/register", { body: { email: uniqueEmail(), password: "short", fullName: "مستخدم" } });
    assert.equal(r.status, 422);
  });

  it("wrong password is generic; five failures lock the account", async () => {
    const email = uniqueEmail("lock");
    await call(app, null, "POST", "/auth/register", { body: { email, password: pw, fullName: "مستخدم" } });
    await call(app, null, "POST", "/auth/verify-email", { body: { token: tokenFor(email, "verify-email") } });
    const ip = nextIp();
    for (let i = 0; i < 5; i++) {
      const r = await login(email, "Wrong-Password-000", ip);
      assert.equal(r.body.error.code, "invalid_credentials");
    }
    const locked = await login(email, pw, ip);
    assert.equal(locked.status, 429);
    assert.equal(locked.body.error.code, "account_locked");
  });

  it("password reset revokes existing sessions and unlocks the account", async () => {
    const email = uniqueEmail("reset");
    await call(app, null, "POST", "/auth/register", { body: { email, password: pw, fullName: "مستخدم" } });
    await call(app, null, "POST", "/auth/verify-email", { body: { token: tokenFor(email, "verify-email") } });
    const s = await login(email, pw);
    assert.equal(s.status, 200);

    assert.equal((await call(app, null, "POST", "/auth/forgot-password", { body: { email } })).status, 202);
    const newPw = "Another-Strong-Pass-7";
    assert.equal((await call(app, null, "POST", "/auth/reset-password", { body: { token: tokenFor(email, "reset-password"), password: newPw } })).status, 200);
    assert.equal((await call(app, s.actor, "GET", "/auth/me")).status, 401, "old session revoked");
    assert.equal((await login(email, pw)).status, 401);
    assert.equal((await login(email, newPw)).status, 200);
  });
});
