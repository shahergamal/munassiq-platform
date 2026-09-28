import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  type Actor, type App, call, createTenant, createUser, expectStatus, expireSubscription, setSubscriptionStatus, setupKitchen, startApp, stopApp, type Kitchen,
} from "./helpers.ts";

// A tenant whose subscription ended, is suspended, or which the platform blocked: reads work, every write is 403.
describe("operational gate (subscription / block)", () => {
  let app: App;
  let admin: Actor;

  before(async () => {
    app = await startApp();
    admin = await createUser({ admin: true });
  });
  after(() => stopApp(app));

  async function fixture() {
    const owner = await createUser();
    const tenant = await createTenant(app, owner);
    const k = await setupKitchen(app, owner, tenant);
    return { owner, tenant, k };
  }

  async function assertReadOnly(owner: Actor, tenant: string, k: Kitchen) {
    const ctx = await call(app, owner, "GET", "/t/context", { tenant });
    expectStatus(ctx, 200, "context");
    assert.equal(ctx.body.operational, false);
    expectStatus(await call(app, owner, "GET", "/t/suppliers", { tenant }), 200, "list suppliers");
    expectStatus(await call(app, owner, "GET", "/t/ingredients", { tenant }), 200, "list ingredients");

    const writes = [
      await call(app, owner, "POST", "/t/suppliers", { tenant, body: { code: "NEW1", name: "مورد جديد" } }),
      await call(app, owner, "PATCH", `/t/suppliers/${k.supplierId}`, { tenant, body: { name: "اسم جديد" } }),
      await call(app, owner, "DELETE", `/t/suppliers/${k.supplierId}`, { tenant }),
      await call(app, owner, "PATCH", `/t/ingredients/${k.ingredientId}`, { tenant, body: { minStock: 3 } }),
      await call(app, owner, "PATCH", "/t/settings", { tenant, body: { vatRatePercent: 5 } }),
      await call(app, owner, "POST", "/t/purchases", {
        tenant, idem: true, body: { supplierId: k.supplierId, locationId: k.locationId, items: [{ ingredientId: k.ingredientId, quantity: 1, unitPrice: 1 }] },
      }),
      await call(app, owner, "POST", "/t/members", { tenant, body: { email: (await createUser()).email, role: "cashier" } }),
    ];
    for (const [i, w] of writes.entries()) {
      assert.equal(w.status, 403, `write #${i}: ${JSON.stringify(w.body)}`);
      assert.equal(w.body.error.code, "tenant_not_operational", `write #${i}`);
    }
  }

  it("expired subscription: read-only", async () => {
    const { owner, tenant, k } = await fixture();
    await expireSubscription(tenant, "expired");
    await assertReadOnly(owner, tenant, k);
  });

  it("trial past its end date (status still 'trial'): read-only", async () => {
    const { owner, tenant, k } = await fixture();
    await expireSubscription(tenant, "trial");
    await assertReadOnly(owner, tenant, k);
  });

  it("suspended subscription: read-only", async () => {
    const { owner, tenant, k } = await fixture();
    await setSubscriptionStatus(tenant, "suspended");
    await assertReadOnly(owner, tenant, k);
  });

  it("blocked by the platform admin: read-only, and writable again once restored", async () => {
    const { owner, tenant, k } = await fixture();
    const noReason = await call(app, admin, "POST", `/admin/tenants/${tenant}/status`, { body: { status: "blocked" } });
    assert.equal(noReason.status, 422);
    expectStatus(await call(app, admin, "POST", `/admin/tenants/${tenant}/status`, { body: { status: "blocked", reason: "عدم السداد" } }), 200, "block");
    await assertReadOnly(owner, tenant, k);

    expectStatus(await call(app, admin, "POST", `/admin/tenants/${tenant}/status`, { body: { status: "active" } }), 200, "unblock");
    expectStatus(await call(app, owner, "PATCH", `/t/suppliers/${k.supplierId}`, { tenant, body: { name: "بعد التفعيل" } }), 200, "write after restore");
  });

  it("an admin renewing the subscription reopens writes", async () => {
    const { owner, tenant } = await fixture();
    await expireSubscription(tenant, "expired");
    const today = new Date().toISOString().slice(0, 10);
    const next = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    expectStatus(await call(app, admin, "PUT", `/admin/tenants/${tenant}/subscription`, {
      body: { planCode: "restaurants-starter", status: "active", startsAt: today, endsAt: next, totalValue: 299 },
    }), 200, "renew");
    expectStatus(await call(app, owner, "POST", "/t/suppliers", { tenant, body: { code: "AFTER", name: "مورد بعد التجديد" } }), 201, "write after renew");
  });
});
