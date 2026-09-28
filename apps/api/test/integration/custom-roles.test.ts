import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { normalizePermissions, PERMISSIONS } from "../../src/lib/rbac.ts";
import { type Actor, type App, addMember, call, createTenant, createUser, expectStatus, raiseLimits, setupKitchen, startApp, stopApp, type Kitchen } from "./helpers.ts";

describe("custom roles", () => {
  let app: App;
  let owner: Actor;
  let tenant: string;
  let k: Kitchen;
  let buyerRole: string;
  let buyer: Actor;

  const assign = async (actor: Actor, email: string, body: object) => call(app, actor, "POST", "/t/members", { tenant, body: { email, ...body } });

  before(async () => {
    app = await startApp();
    owner = await createUser();
    tenant = await createTenant(app, owner);
    await raiseLimits(tenant);
    k = await setupKitchen(app, owner, tenant);
  });
  after(() => stopApp(app));

  it("the owner creates a role from hand-picked permissions; what they depend on is added", async () => {
    const r = await call(app, owner, "POST", "/t/roles", { tenant, body: { name: "مشرف مشتريات", permissions: ["purchases:write", "purchases:approve"] } });
    expectStatus(r, 201, "create role");
    buyerRole = r.body.id;
    // First-version names still work: they open what they used to (plus base data, as before), in the new names.
    assert.deepEqual(r.body.permissions, normalizePermissions(["catalog:read", "purchases:read", "purchases:write", "purchases:approve"]));
    assert.ok(r.body.permissions.includes("purchases.approve") && r.body.permissions.every((p: string) => /^[a-z_]+\.[a-z_]+$/.test(p)));
  });

  it("a member with the role gets exactly those permissions, and /context says so", async () => {
    buyer = await createUser();
    expectStatus(await assign(owner, buyer.email, { role: "custom", customRoleId: buyerRole }), 201, "assign");
    const ctx = await call(app, buyer, "GET", "/t/context", { tenant });
    assert.deepEqual([ctx.body.role, ctx.body.roleName], ["custom", "مشرف مشتريات"]);
    assert.deepEqual(ctx.body.permissions, normalizePermissions(["catalog:read", "purchases:read", "purchases:write", "purchases:approve"]));
    expectStatus(await call(app, buyer, "GET", "/t/purchases", { tenant }), 200, "list");
    expectStatus(await call(app, buyer, "POST", "/t/purchases", { tenant, idem: true, body: { supplierId: k.supplierId, locationId: k.locationId, items: [{ ingredientId: k.ingredientId, quantity: 1, unitPrice: 1 }] } }), 201, "create PO");
    expectStatus(await call(app, buyer, "GET", "/t/reports/daily-sales", { tenant }), 403, "reports");
    expectStatus(await call(app, buyer, "POST", "/t/suppliers", { tenant, body: { code: "X1", name: "مورد" } }), 403, "catalog write");
    expectStatus(await call(app, buyer, "GET", "/t/members", { tenant }), 403, "members");
  });

  it("editing the role applies on the member's next request", async () => {
    expectStatus(await call(app, owner, "PATCH", `/t/roles/${buyerRole}`, { tenant, body: { name: "مشرف مشتريات", permissions: ["purchases:write", "purchases:approve", "reports:read"] } }), 200, "edit");
    expectStatus(await call(app, buyer, "GET", "/t/reports/daily-sales", { tenant }), 200, "reports now allowed");
  });

  it("rejects duplicate names, unknown permissions and non-owners editing roles", async () => {
    expectStatus(await call(app, owner, "POST", "/t/roles", { tenant, body: { name: " مشرف مشتريات ", permissions: ["pos:read"] } }), 409, "duplicate");
    expectStatus(await call(app, owner, "POST", "/t/roles", { tenant, body: { name: "دور", permissions: ["root:all"] } }), 422, "unknown permission");
    const manager = await addMember(app, owner, tenant, "manager");
    expectStatus(await call(app, manager, "POST", "/t/roles", { tenant, body: { name: "دور المدير", permissions: ["pos:read"] } }), 403, "manager has no members:manage");
  });

  it("the database accepts every permission the code knows", async () => {
    expectStatus(await call(app, owner, "POST", "/t/roles", { tenant, body: { name: "كل الصلاحيات", permissions: [...PERMISSIONS] } }), 201, "all permissions");
  });

  it("someone managing members cannot grant, or touch, more than they hold", async () => {
    const hr = await call(app, owner, "POST", "/t/roles", { tenant, body: { name: "مسؤول الورديات", permissions: ["members:manage", "pos:operate", "pos:kitchen", "recipes:read", "assistant:use"] } });
    expectStatus(hr, 201, "hr role");
    const lead = await createUser();
    expectStatus(await assign(owner, lead.email, { role: "custom", customRoleId: hr.body.id }), 201, "assign lead");
    expectStatus(await call(app, lead, "POST", "/t/roles", { tenant, body: { name: "دور جديد", permissions: ["pos:read"] } }), 403, "only the owner edits roles");
    expectStatus(await assign(lead, (await createUser()).email, { role: "cashier" }), 201, "cashier is within the lead's permissions");
    expectStatus(await assign(lead, (await createUser()).email, { role: "manager" }), 403, "manager is not");
    expectStatus(await assign(lead, (await createUser()).email, { role: "custom", customRoleId: buyerRole }), 403, "nor is the buyer role");
    expectStatus(await call(app, lead, "PATCH", `/t/members/${buyer.id}`, { tenant, body: { isActive: false } }), 403, "cannot deactivate a wider member");
  });

  it("a role from another workspace cannot be assigned, and is not listed", async () => {
    const other = await createUser();
    const t2 = await createTenant(app, other, "مطعم آخر");
    const foreign = await call(app, other, "POST", "/t/roles", { tenant: t2, body: { name: "دور خارجي", permissions: ["pos:read"] } });
    expectStatus(foreign, 201, "foreign role");
    expectStatus(await assign(owner, (await createUser()).email, { role: "custom", customRoleId: foreign.body.id }), 404, "foreign role");
    const list = await call(app, owner, "GET", "/t/roles", { tenant });
    assert.ok(!list.body.custom.some((r: { id: string }) => r.id === foreign.body.id));
    assert.equal(list.body.custom.find((r: { id: string }) => r.id === buyerRole).membersCount, 1);
  });

  it("a role in use cannot be deleted until its members are moved", async () => {
    expectStatus(await call(app, owner, "DELETE", `/t/roles/${buyerRole}`, { tenant }), 409, "in use");
    expectStatus(await call(app, owner, "PATCH", `/t/members/${buyer.id}`, { tenant, body: { role: "accountant" } }), 200, "move member");
    expectStatus(await call(app, owner, "DELETE", `/t/roles/${buyerRole}`, { tenant }), 200, "delete");
    const ctx = await call(app, buyer, "GET", "/t/context", { tenant });
    assert.deepEqual([ctx.body.role, ctx.body.roleName], ["accountant", null]);
  });
});
