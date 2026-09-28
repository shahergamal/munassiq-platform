import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  type Actor, type App, createTenant, createUser, ownerPool, rawAppPool, receivePo, setupKitchen, startApp, stopApp, type Kitchen,
} from "./helpers.ts";

const denied = (e: { code?: string }) => e.code === "42501";
const appendOnly = (e: { message?: string }) => e.message === "append_only_table";

// What the database itself refuses, independent of any API code.
describe("database roles and append-only tables", () => {
  let app: App;
  let owner: Actor;
  let tenant: string;
  let k: Kitchen;

  async function asApp<T>(fn: (db: import("pg").PoolClient) => Promise<T>): Promise<T> {
    const db = await rawAppPool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [tenant, owner.id]);
      return await fn(db);
    } finally {
      await db.query("ROLLBACK").catch(() => undefined);
      db.release();
    }
  }

  before(async () => {
    app = await startApp();
    owner = await createUser();
    tenant = await createTenant(app, owner);
    k = await setupKitchen(app, owner, tenant);
    await receivePo(app, owner, tenant, { supplierId: k.supplierId, locationId: k.locationId, items: [{ ingredientId: k.ingredientId, quantity: 1, unitPrice: 10 }] });
  });
  after(() => stopApp(app));

  it("munassiq_app is not a superuser and has no BYPASSRLS", async () => {
    const r = await ownerPool.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'munassiq_app'");
    assert.deepEqual(r.rows[0], { rolsuper: false, rolbypassrls: false });
  });

  it("munassiq_app cannot switch RLS off", async () => {
    await asApp(async (db) => {
      await db.query("SET LOCAL row_security = off");
      await assert.rejects(db.query("SELECT * FROM suppliers"), denied);
    });
    await asApp((db) => assert.rejects(db.query("ALTER TABLE suppliers DISABLE ROW LEVEL SECURITY"), denied));
    await asApp((db) => assert.rejects(db.query("ALTER TABLE suppliers NO FORCE ROW LEVEL SECURITY"), denied));
    await asApp((db) => assert.rejects(db.query("DROP POLICY suppliers_sel ON suppliers"), denied));
  });

  it("munassiq_app cannot read auth tables", async () => {
    await asApp((db) => assert.rejects(db.query("SELECT * FROM users"), denied));
    await asApp((db) => assert.rejects(db.query("SELECT * FROM sessions"), denied));
  });

  it("munassiq_app cannot UPDATE or DELETE stock_movements", async () => {
    await asApp(async (db) => {
      const rows = await db.query("SELECT id FROM stock_movements");
      assert.ok(rows.rowCount && rows.rowCount > 0, "fixture should have a movement");
    });
    await asApp((db) => assert.rejects(db.query("UPDATE stock_movements SET quantity = 999"), denied));
    await asApp((db) => assert.rejects(db.query("DELETE FROM stock_movements"), denied));
  });

  it("munassiq_app can only append to audit_log (no read, update or delete)", async () => {
    await asApp((db) => assert.rejects(db.query("UPDATE audit_log SET action = 'x'"), denied));
    await asApp((db) => assert.rejects(db.query("DELETE FROM audit_log"), denied));
    await asApp((db) => assert.rejects(db.query("SELECT * FROM audit_log"), denied));
    // ...and only for its own tenant
    const other = await createUser();
    await asApp((db) => assert.rejects(
      db.query("INSERT INTO audit_log (tenant_id, action) VALUES ((SELECT gen_random_uuid()), 'forged')"), denied));
    await asApp((db) => db.query("INSERT INTO audit_log (tenant_id, actor_user_id, action) VALUES (app_tenant_id(), $1, 'ok')", [other.id]));
  });

  it("even the table owner cannot mutate the financial ledgers (triggers)", async () => {
    await assert.rejects(ownerPool.query("UPDATE stock_movements SET quantity = 999 WHERE tenant_id = $1", [tenant]), appendOnly);
    await assert.rejects(ownerPool.query("DELETE FROM stock_movements WHERE tenant_id = $1", [tenant]), appendOnly);
    await assert.rejects(ownerPool.query("UPDATE audit_log SET action = 'x' WHERE tenant_id = $1", [tenant]), appendOnly);
    await assert.rejects(ownerPool.query("DELETE FROM audit_log WHERE tenant_id = $1", [tenant]), appendOnly);
  });

  it("migrations never depend on pgcrypto digest()", async () => {
    const dir = join(import.meta.dirname, "..", "..", "..", "..", "db", "migrations");
    for (const f of await readdir(dir)) {
      const sql = await readFile(join(dir, f), "utf8");
      assert.ok(!/\bdigest\s*\(|pgcrypto/i.test(sql), `${f} references digest()/pgcrypto`);
    }
    const ext = await ownerPool.query("SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto'");
    assert.equal(ext.rowCount, 0);
  });
});
