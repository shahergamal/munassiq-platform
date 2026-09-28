import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import {
  type Actor, type App, addMember, call, createTenant, createUser, expectStatus, raiseLimits, setupKitchen, startApp, stopApp, type Kitchen,
} from "./helpers.ts";

describe("roles, support access and request guards", () => {
  let app: App;
  let owner: Actor;
  let admin: Actor;
  let tenant: string;
  let k: Kitchen;
  let accountant: Actor;
  let cashier: Actor;
  let manager: Actor;

  before(async () => {
    app = await startApp();
    [owner, admin] = await Promise.all([createUser(), createUser({ admin: true })]);
    tenant = await createTenant(app, owner);
    await raiseLimits(tenant);
    k = await setupKitchen(app, owner, tenant);
    accountant = await addMember(app, owner, tenant, "accountant");
    cashier = await addMember(app, owner, tenant, "cashier");
    manager = await addMember(app, owner, tenant, "manager");
  });
  after(() => stopApp(app));

  const po = () => ({ supplierId: k.supplierId, locationId: k.locationId, items: [{ ingredientId: k.ingredientId, quantity: 1, unitPrice: 1 }] });

  it("accountant reads purchases and reports but cannot write the catalog or sell", async () => {
    expectStatus(await call(app, accountant, "GET", "/t/purchases", { tenant }), 200, "purchases");
    expectStatus(await call(app, accountant, "GET", "/t/suppliers", { tenant }), 200, "suppliers");
    expectStatus(await call(app, accountant, "GET", "/t/reports/daily-sales", { tenant }), 200, "reports");
    for (const [method, url, body] of [
      ["POST", "/t/suppliers", { code: "ACC", name: "مورد" }],
      ["PATCH", `/t/suppliers/${k.supplierId}`, { name: "تعديل" }],
      ["POST", "/t/ingredients", { name: "مادة" }],
      ["POST", "/t/recipes", { code: "R", name: "وصفة" }],
      ["POST", "/t/purchases", po()],
    ] as const) {
      const r = await call(app, accountant, method, url, { tenant, body, idem: true });
      assert.equal(r.status, 403, `${method} ${url}`);
      assert.equal(r.body.error.code, "forbidden");
    }
  });

  it("cashier sells but cannot refund, see purchases or reports", async () => {
    const refund = await call(app, cashier, "POST", `/t/pos/orders/${randomUUID()}/refund`, {
      tenant, idem: true, body: { shiftId: randomUUID(), amount: 1, method: "cash", reason: "سبب" },
    });
    assert.equal(refund.status, 403);
    assert.equal((await call(app, cashier, "GET", "/t/purchases", { tenant })).status, 403);
    assert.equal((await call(app, cashier, "GET", "/t/reports/daily-sales", { tenant })).status, 403);
    expectStatus(await call(app, cashier, "GET", `/t/pos/menu?locationId=${k.locationId}`, { tenant }), 200, "menu");
  });

  it("manager cannot manage members or settings", async () => {
    assert.equal((await call(app, manager, "GET", "/t/members", { tenant })).status, 403);
    assert.equal((await call(app, manager, "PATCH", "/t/settings", { tenant, body: { vatRatePercent: 5 } })).status, 403);
  });

  it("a deactivated member loses access on the next request", async () => {
    const clerk = await addMember(app, owner, tenant, "inventory_clerk");
    expectStatus(await call(app, clerk, "GET", "/t/suppliers", { tenant }), 200);
    expectStatus(await call(app, owner, "PATCH", `/t/members/${clerk.id}`, { tenant, body: { isActive: false } }), 200, "deactivate");
    assert.equal((await call(app, clerk, "GET", "/t/suppliers", { tenant })).status, 403);
  });

  it("platform admin: no implicit access; a support session is read-only and ends cleanly", async () => {
    assert.equal((await call(app, admin, "GET", "/t/suppliers", { tenant })).status, 403);
    assert.equal((await call(app, owner, "POST", "/admin/support-sessions", { body: { tenantId: tenant, reason: "طلب دعم" } })).status, 403);
    assert.equal((await call(app, admin, "POST", "/admin/support-sessions", { body: { tenantId: tenant, reason: "x" } })).status, 422);

    const s = await call(app, admin, "POST", "/admin/support-sessions", { body: { tenantId: tenant, reason: "طلب دعم رقم 42" } });
    expectStatus(s, 201, "support session");
    const ctx = await call(app, admin, "GET", "/t/context", { tenant });
    expectStatus(ctx, 200);
    assert.equal(ctx.body.readOnlySupport, true);
    assert.equal(ctx.body.supportSession.id, s.body.id);
    expectStatus(await call(app, admin, "GET", "/t/purchases", { tenant }), 200);
    assert.equal((await call(app, admin, "POST", "/t/suppliers", { tenant, body: { code: "SUP", name: "مورد" } })).status, 403);
    assert.equal((await call(app, admin, "GET", "/t/members", { tenant })).status, 403);

    const audit = await call(app, admin, "GET", `/admin/audit?tenantId=${tenant}`);
    assert.ok(audit.body.items.some((a: { action: string }) => a.action === "support.started"));

    expectStatus(await call(app, admin, "DELETE", `/admin/support-sessions/${s.body.id}`), 200, "end support");
    assert.equal((await call(app, admin, "GET", "/t/suppliers", { tenant })).status, 403);
  });

  it("non-admins get a clear 403 from /admin", async () => {
    const r = await call(app, owner, "GET", "/admin/stats");
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, "forbidden");
    expectStatus(await call(app, admin, "GET", "/admin/stats"), 200);
  });

  it("CSRF token, Origin and session are enforced on writes", async () => {
    const body = { code: "CSRF", name: "مورد" };
    const noToken = await call(app, owner, "POST", "/t/suppliers", { tenant, body, csrf: false });
    assert.equal(noToken.body.error.code, "csrf_invalid");
    const otherSession = await call(app, owner, "POST", "/t/suppliers", { tenant, body, csrf: accountant.csrf });
    assert.equal(otherSession.body.error.code, "csrf_invalid");
    const evil = await call(app, owner, "POST", "/t/suppliers", { tenant, body, headers: { origin: "https://evil.example" } });
    assert.equal(evil.body.error.code, "origin_not_allowed");
    assert.equal((await call(app, null, "GET", "/t/suppliers", { tenant })).status, 401);
  });

  it("unknown routes and malformed bodies return the API's error shape, never raw internals", async () => {
    const nf = await call(app, owner, "GET", "/nope");
    assert.deepEqual(nf.body.error.code, "not_found");
    const bad = await call(app, owner, "POST", "/t/suppliers", { tenant, body: { code: "", name: 1 } });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.error.code, "validation_failed");
    const badJson = await call(app, owner, "POST", "/t/suppliers", { tenant, body: "{not json", headers: { "content-type": "application/json" } });
    assert.equal(badJson.status, 400);
    assert.equal(badJson.body.error.code, "bad_request");
  });
});
