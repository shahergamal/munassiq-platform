import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { type Actor, type App, call, createUser, expectStatus, ownerPool, startApp, stopApp } from "./helpers.ts";

// The landing content is one platform-wide record, so this file restores the default at the end.
describe("public landing page and its admin editor", () => {
  let app: App;
  let admin: Actor;
  let user: Actor;
  let defaults: Record<string, any>;

  before(async () => {
    app = await startApp();
    [admin, user] = await Promise.all([createUser({ admin: true }), createUser()]);
    const r = await call(app, admin, "GET", "/admin/landing-content");
    expectStatus(r, 200, "admin read");
    defaults = r.body.defaults;
  });
  after(async () => {
    await call(app, admin, "DELETE", "/admin/landing-content");
    await stopApp(app);
  });

  it("is public: no session needed, content merged over defaults, only published plans of live sectors", async () => {
    const r = await call(app, null, "GET", "/public/landing");
    expectStatus(r, 200);
    assert.ok(r.body.content.hero.title);
    assert.ok(r.body.plans.length > 0);
    assert.ok(r.body.plans.every((p: { sector: string }) => r.body.sectors.find((s: { key: string; isAvailable: boolean }) => s.key === p.sector)?.isAvailable));
  });

  it("only a platform admin can read or change the content", async () => {
    expectStatus(await call(app, user, "GET", "/admin/landing-content"), 403, "read");
    expectStatus(await call(app, user, "PUT", "/admin/landing-content", { body: defaults }), 403, "write");
    expectStatus(await call(app, null, "PUT", "/admin/landing-content", { body: defaults }), 401, "anonymous");
  });

  it("rejects unsafe links and oversized text instead of storing them", async () => {
    const js = structuredClone(defaults);
    js.footer.exploreLinks = [{ label: "x", url: "javascript:alert(1)" }];
    expectStatus(await call(app, admin, "PUT", "/admin/landing-content", { body: js }), 422, "javascript: link");
    const data = structuredClone(defaults);
    data.footer.linkedin = "data:text/html,<script>";
    expectStatus(await call(app, admin, "PUT", "/admin/landing-content", { body: data }), 422, "data: link");
    const long = structuredClone(defaults);
    long.hero.title = "س".repeat(500);
    expectStatus(await call(app, admin, "PUT", "/admin/landing-content", { body: long }), 422, "too long");
  });

  it("a saved edit shows on the public page and is audited; reset restores the default", async () => {
    const next = structuredClone(defaults);
    next.hero.title = "عنوان تجريبي من الاختبار";
    next.faq.items = [{ question: "سؤال؟", answer: "جواب." }];
    expectStatus(await call(app, admin, "PUT", "/admin/landing-content", { body: next }), 200, "save");
    let pub = await call(app, null, "GET", "/public/landing");
    assert.equal(pub.body.content.hero.title, "عنوان تجريبي من الاختبار");
    assert.equal(pub.body.content.faq.items.length, 1);
    const audit = await ownerPool.query("SELECT 1 FROM audit_log WHERE action = 'landing.updated' AND actor_user_id = $1", [admin.id]);
    assert.equal(audit.rowCount, 1);
    expectStatus(await call(app, admin, "DELETE", "/admin/landing-content"), 200, "reset");
    pub = await call(app, null, "GET", "/public/landing");
    assert.equal(pub.body.content.hero.title, defaults.hero.title);
  });

  it("a new plan stays off the landing page until it is published", async () => {
    const code = `restaurants-t${Date.now().toString(36)}`;
    expectStatus(await call(app, admin, "POST", "/admin/plans", { body: { code, sector: "restaurants", nameAr: "باقة اختبار", monthlyPrice: 10, branchesLimit: 1, usersLimit: 1, features: ["ميزة"] } }), 201, "create");
    const has = async () => (await call(app, null, "GET", "/public/landing")).body.plans.some((p: { code: string }) => p.code === code);
    assert.equal(await has(), false);
    expectStatus(await call(app, admin, "PATCH", `/admin/plans/${code}`, { body: { isPublic: true } }), 200, "publish");
    assert.equal(await has(), true);
    const p = (await call(app, null, "GET", "/public/landing")).body.plans.find((x: { code: string }) => x.code === code);
    assert.deepEqual([p.features, p.monthlyPrice], [["ميزة"], 10]);
    // A partial edit leaves the marketing fields alone.
    expectStatus(await call(app, admin, "PATCH", `/admin/plans/${code}`, { body: { monthlyPrice: 12 } }), 200, "price");
    const q = (await call(app, null, "GET", "/public/landing")).body.plans.find((x: { code: string }) => x.code === code);
    assert.deepEqual([q.features, q.monthlyPrice], [["ميزة"], 12]);
    await call(app, admin, "PATCH", `/admin/plans/${code}`, { body: { isPublic: false, isActive: false } });
  });
});
