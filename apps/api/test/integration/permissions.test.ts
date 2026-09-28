import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { inSector, PERMISSIONS } from "../../src/lib/rbac.ts";
import { type Actor, type App, call, code, createApprovedPo, createTenant, createUser, expectStatus, raiseLimits, setupKitchen, startApp, stopApp, type Kitchen } from "./helpers.ts";

/**
 * Detailed permissions: each page and each action (view, add, edit, delete, approve…) is granted on its own and
 * enforced by the server on every endpoint, whatever the screen shows.
 */
describe("detailed permissions (page × action)", () => {
  let app: App;
  let owner: Actor;
  let tenant: string;
  let k: Kitchen;

  const member = async (name: string, permissions: string[]) => {
    const r = await call(app, owner, "POST", "/t/roles", { tenant, body: { name, permissions } });
    expectStatus(r, 201, `role ${name}`);
    const u = await createUser();
    expectStatus(await call(app, owner, "POST", "/t/members", { tenant, body: { email: u.email, role: "custom", customRoleId: r.body.id } }), 201, "assign");
    return { user: u, roleId: r.body.id as string, permissions: r.body.permissions as string[] };
  };

  before(async () => {
    app = await startApp();
    owner = await createUser({ name: "المالك" });
    tenant = await createTenant(app, owner, "مطعم الصلاحيات");
    await raiseLimits(tenant);
    k = await setupKitchen(app, owner, tenant);
  });
  after(() => stopApp(app));

  it("the role editor gets the whole tree: modules, pages, actions", async () => {
    const r = await call(app, owner, "GET", "/t/roles", { tenant });
    expectStatus(r, 200);
    const pages = r.body.catalog.flatMap((m: { pages: { key: string; actions: { key: string }[] }[] }) => m.pages);
    assert.ok(pages.length >= 40, `${pages.length} pages`);
    assert.deepEqual(pages.find((p: { key: string }) => p.key === "ingredients").actions.map((a: { key: string }) => a.key), ["view", "create", "edit", "delete", "import", "export"]);
    assert.equal(r.body.canEdit, true);
    // The restaurant's own pages only: production belongs to factories.
    assert.deepEqual(r.body.grantable, PERMISSIONS.filter((p) => inSector(p, "restaurants")));
  });

  it("add without edit or delete: each action is its own permission", async () => {
    const { user, permissions } = await member("مدخل مواد", ["ingredients.create"]);
    assert.deepEqual(permissions, ["ingredients.view", "ingredients.create"], "an action brings its page");
    const g = (await call(app, owner, "GET", "/t/units", { tenant })).body.items.find((u: { code: string }) => u.code === "g").id;
    const made = await call(app, user, "POST", "/t/ingredients", { tenant, body: { name: "ملح", baseUnitId: g, purchaseUnitId: g } });
    expectStatus(made, 201, "create");
    expectStatus(await call(app, user, "GET", "/t/ingredients", { tenant }), 200, "list");
    expectStatus(await call(app, user, "PATCH", `/t/ingredients/${made.body.id}`, { tenant, body: { name: "ملح خشن" } }), 403, "no edit");
    expectStatus(await call(app, user, "DELETE", `/t/ingredients/${made.body.id}`, { tenant }), 403, "no delete");
    expectStatus(await call(app, user, "GET", "/t/ingredients/export", { tenant }), 403, "no export");
    expectStatus(await call(app, user, "POST", "/t/suppliers", { tenant, body: { code: code("S"), name: "مورد" } }), 403, "another page");
  });

  it("view only: the page opens, nothing on it changes", async () => {
    const { user } = await member("مراجع مشتريات", ["purchases.view"]);
    expectStatus(await call(app, user, "GET", "/t/purchases", { tenant }), 200, "list POs");
    expectStatus(await call(app, user, "POST", "/t/purchases", { tenant, idem: true, body: { supplierId: k.supplierId, locationId: k.locationId, items: [{ ingredientId: k.ingredientId, quantity: 1, unitPrice: 1 }] } }), 403, "create");
    const po = await createApprovedPo(app, owner, tenant, { supplierId: k.supplierId, locationId: k.locationId, items: [{ ingredientId: k.ingredientId, quantity: 1, unitPrice: 1 }] });
    expectStatus(await call(app, user, "POST", `/t/purchases/${po}/cancel`, { tenant }), 403, "cancel");
    expectStatus(await call(app, user, "POST", `/t/purchases/${po}/receive`, { tenant }), 403, "receive");
    expectStatus(await call(app, user, "GET", "/t/goods-receipts", { tenant }), 403, "receipts page is a different page");
  });

  it("one report, not all reports", async () => {
    const { user } = await member("قارئ الهدر", ["rep_waste.view"]);
    expectStatus(await call(app, user, "GET", "/t/reports/waste-analysis", { tenant }), 200, "waste report");
    expectStatus(await call(app, user, "GET", "/t/reports/daily-sales", { tenant }), 403, "sales report");
    expectStatus(await call(app, user, "GET", "/t/reports/vat", { tenant }), 403, "VAT report");
  });

  it("a shared list opens for the screens that pick from it", async () => {
    const { user } = await member("مسجّل هدر", ["waste.create"]);
    expectStatus(await call(app, user, "GET", "/t/ingredients", { tenant }), 200, "picks ingredients");
    expectStatus(await call(app, user, "GET", "/t/locations", { tenant }), 200, "picks a location");
    expectStatus(await call(app, user, "GET", "/t/ingredients/:id/barcodes".replace(":id", k.ingredientId), { tenant }), 403, "not the ingredient page");
    expectStatus(await call(app, user, "GET", "/t/recipes", { tenant }), 403, "not recipes");
  });

  it("instant transfer needs both sending and receiving", async () => {
    const { user } = await member("مرسل فقط", ["transfers.dispatch", "transfers.create"]);
    const w = (await call(app, owner, "POST", "/t/locations", { tenant, body: { code: code("W"), name: "مستودع", locationType: "warehouse" } })).body.id;
    const t = await call(app, user, "POST", "/t/transfers", { tenant, idem: true, body: { fromLocationId: w, toLocationId: k.locationId, items: [{ ingredientId: k.ingredientId, quantity: 1 }], completeNow: true } });
    expectStatus(t, 403, "completeNow");
  });

  it("someone with role management can only hand out what they hold, and cannot touch a wider role", async () => {
    const lead = await member("مشرف الفريق", ["roles.manage", "members.invite", "members.edit", "pos.sell", "orders.view"]);
    const ok = await call(app, lead.user, "POST", "/t/roles", { tenant, body: { name: "كاشير مساعد", permissions: ["pos.sell"] } });
    expectStatus(ok, 201, "within their own");
    const wide = await call(app, lead.user, "POST", "/t/roles", { tenant, body: { name: "كاشير بخصم", permissions: ["pos.sell", "pos.discount"] } });
    expectStatus(wide, 403, "beyond their own");
    assert.deepEqual(wide.body.error.details.missing, ["pos.discount"]);
    const ownerRole = (await call(app, owner, "POST", "/t/roles", { tenant, body: { name: "محاسب أول", permissions: ["acc_journal.create"] } })).body.id;
    expectStatus(await call(app, lead.user, "PATCH", `/t/roles/${ownerRole}`, { tenant, body: { name: "محاسب أول", permissions: ["pos.sell"] } }), 403, "wider role");
    expectStatus(await call(app, lead.user, "DELETE", `/t/roles/${ownerRole}`, { tenant }), 403, "cannot delete it either");
    const r = await call(app, lead.user, "GET", "/t/roles", { tenant });
    assert.equal(r.body.canEdit, true);
    assert.ok(!r.body.grantable.includes("pos.discount"));
  });

  it("unknown names are refused; first-version names are translated", async () => {
    expectStatus(await call(app, owner, "POST", "/t/roles", { tenant, body: { name: "خطأ", permissions: ["ingredients.fly"] } }), 422, "unknown");
    const legacy = await call(app, owner, "POST", "/t/roles", { tenant, body: { name: "قديم", permissions: ["pos:refund"] } });
    expectStatus(legacy, 201, "legacy");
    assert.ok(["orders.refund", "pos.void", "pos.supervise", "orders.view"].every((p) => legacy.body.permissions.includes(p)));
    assert.ok(!legacy.body.permissions.some((p: string) => p.includes(":")));
  });
});
