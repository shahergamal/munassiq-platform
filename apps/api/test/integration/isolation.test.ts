import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  type Actor, type App, call, createTenant, createUser, expectStatus, ownerPool, rawAppPool, setupKitchen, startApp, stopApp, type Kitchen,
} from "./helpers.ts";

// Tenant A's user must never read or write tenant B's data, whatever headers or ids it sends.
describe("tenant isolation", () => {
  let app: App;
  let a: Actor;
  let b: Actor;
  let tA: string;
  let tB: string;
  let kB: Kitchen;

  before(async () => {
    app = await startApp();
    [a, b] = await Promise.all([createUser(), createUser()]);
    [tA, tB] = await Promise.all([createTenant(app, a, "مطعم أ"), createTenant(app, b, "مطعم ب")]);
    await setupKitchen(app, a, tA);
    kB = await setupKitchen(app, b, tB);
  });
  after(() => stopApp(app));

  it("refuses X-Tenant-Id of a tenant the user is not a member of", async () => {
    for (const [method, url, body] of [
      ["GET", "/t/suppliers", undefined],
      ["GET", "/t/context", undefined],
      ["POST", "/t/suppliers", { code: "X1", name: "مورد دخيل" }],
    ] as const) {
      const r = await call(app, a, method, url, { tenant: tB, body });
      assert.equal(r.status, 403, `${method} ${url}`);
      assert.equal(r.body.error.code, "forbidden");
    }
    const n = await ownerPool.query("SELECT count(*)::int AS n FROM suppliers WHERE tenant_id = $1 AND code = 'X1'", [tB]);
    assert.equal(n.rows[0].n, 0);
  });

  it("requires a valid X-Tenant-Id", async () => {
    assert.equal((await call(app, a, "GET", "/t/suppliers")).body.error.code, "tenant_required");
    assert.equal((await call(app, a, "GET", "/t/suppliers", { tenant: "not-a-uuid" })).status, 400);
  });

  it("does not list, read, update or delete B's rows through A's own tenant", async () => {
    const list = await call(app, a, "GET", "/t/suppliers", { tenant: tA });
    expectStatus(list, 200);
    assert.ok(!list.body.items.some((s: { id: string }) => s.id === kB.supplierId));

    const upd = await call(app, a, "PATCH", `/t/suppliers/${kB.supplierId}`, { tenant: tA, body: { name: "مخترق" } });
    assert.equal(upd.status, 404);
    const del = await call(app, a, "DELETE", `/t/ingredients/${kB.ingredientId}`, { tenant: tA });
    assert.equal(del.status, 404);

    const s = await ownerPool.query("SELECT name FROM suppliers WHERE id = $1", [kB.supplierId]);
    assert.equal(s.rows[0].name, "مورد الخضار");
    const i = await ownerPool.query("SELECT 1 FROM ingredients WHERE id = $1", [kB.ingredientId]);
    assert.equal(i.rowCount, 1);
  });

  it("cannot reference B's supplier/location/ingredient from A's purchase order", async () => {
    const r = await call(app, a, "POST", "/t/purchases", {
      tenant: tA, idem: true,
      body: { supplierId: kB.supplierId, locationId: kB.locationId, items: [{ ingredientId: kB.ingredientId, quantity: 1, unitPrice: 1 }] },
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, "reference_conflict");
    const n = await ownerPool.query("SELECT count(*)::int AS n FROM purchase_orders WHERE supplier_id = $1", [kB.supplierId]);
    assert.equal(n.rows[0].n, 0);
  });

  it("RLS in the database hides B's rows and rejects rows stamped with B's tenant_id", async () => {
    const db = await rawAppPool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [tA, a.id]);
      const seen = await db.query("SELECT id FROM suppliers WHERE id = $1", [kB.supplierId]);
      assert.equal(seen.rowCount, 0);
      const tenants = await db.query("SELECT id FROM tenants");
      assert.deepEqual(tenants.rows.map((r) => r.id), [tA]);
      await assert.rejects(
        db.query("INSERT INTO suppliers (tenant_id, code, name) VALUES ($1, 'EVIL', 'مورد')", [tB]),
        (e: { code?: string }) => e.code === "42501",
      );
    } finally {
      await db.query("ROLLBACK");
      db.release();
    }
  });

  it("with no tenant context the app role sees nothing", async () => {
    const r = await rawAppPool.query("SELECT (SELECT count(*) FROM suppliers)::int AS s, (SELECT count(*) FROM tenants)::int AS t, (SELECT count(*) FROM stock_levels)::int AS l");
    assert.deepEqual(r.rows[0], { s: 0, t: 0, l: 0 });
  });
});
