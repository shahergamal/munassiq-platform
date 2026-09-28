import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { type Actor, type App, addMember, call, code, createTenant, createUser, expectStatus, ownerPool, startApp, stopApp } from "./helpers.ts";

// Trial plan: 1 branch, 3 users. The triggers serialise per tenant, so parallel requests cannot both slip under the cap.
describe("plan limits under concurrency", () => {
  let app: App;
  let admin: Actor;

  before(async () => {
    app = await startApp();
    admin = await createUser({ admin: true });
  });
  after(() => stopApp(app));

  const count = async (sql: string, tenant: string) => (await ownerPool.query(sql, [tenant])).rows[0].n as number;

  it("two parallel branch creations with one slot left: exactly one succeeds", async () => {
    const owner = await createUser();
    const tenant = await createTenant(app, owner);
    const res = await Promise.all([1, 2].map(() => call(app, owner, "POST", "/t/branches", { tenant, body: { code: code("B"), name: "فرع" } })));
    assert.deepEqual(res.map((r) => r.status).sort(), [201, 402]);
    const refused = res.find((r) => r.status === 402)!;
    assert.equal(refused.body.error.code, "plan_limit_reached");
    assert.equal(refused.body.error.details.limit, "branches");
    assert.equal(await count("SELECT count(*)::int AS n FROM branches WHERE tenant_id = $1 AND is_active", tenant), 1);
  });

  it("reactivating a branch cannot bypass the limit", async () => {
    const owner = await createUser();
    const tenant = await createTenant(app, owner);
    const off = await call(app, owner, "POST", "/t/branches", { tenant, body: { code: code("B"), name: "فرع متوقف", isActive: false } });
    expectStatus(off, 201);
    expectStatus(await call(app, owner, "POST", "/t/branches", { tenant, body: { code: code("B"), name: "فرع نشط" } }), 201);
    const re = await call(app, owner, "PATCH", `/t/branches/${off.body.id}`, { tenant, body: { isActive: true } });
    assert.equal(re.status, 402);
  });

  it("two parallel member invitations with one seat left: exactly one succeeds", async () => {
    const owner = await createUser();
    const tenant = await createTenant(app, owner);
    await addMember(app, owner, tenant, "cashier"); // owner + 1 = 2 of 3
    const [x, y] = await Promise.all([createUser(), createUser()]);
    const res = await Promise.all([x, y].map((u) => call(app, owner, "POST", "/t/members", { tenant, body: { email: u.email, role: "cashier" } })));
    assert.deepEqual(res.map((r) => r.status).sort(), [201, 402]);
    assert.equal(await count("SELECT count(*)::int AS n FROM memberships WHERE tenant_id = $1 AND is_active", tenant), 3);
  });

  it("an admin override raises the cap", async () => {
    const owner = await createUser();
    const tenant = await createTenant(app, owner);
    expectStatus(await call(app, owner, "POST", "/t/branches", { tenant, body: { code: code("B"), name: "فرع 1" } }), 201);
    assert.equal((await call(app, owner, "POST", "/t/branches", { tenant, body: { code: code("B"), name: "فرع 2" } })).status, 402);
    expectStatus(await call(app, admin, "PUT", `/admin/tenants/${tenant}/limits`, { body: { branchesLimit: 3, usersLimit: null } }), 200, "override");
    const res = await Promise.all([1, 2, 3].map(() => call(app, owner, "POST", "/t/branches", { tenant, body: { code: code("B"), name: "فرع" } })));
    assert.deepEqual(res.map((r) => r.status).sort(), [201, 201, 402]);
  });
});
