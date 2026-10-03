import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { FastifyRequest } from "fastify";
import type { Db } from "../../src/db/pool.ts";
import { createTenant as createTenantRecord, defaultGeneralSettings } from "../../src/lib/tenancy.ts";
import { type Actor, type App, addMember, call, comingSoonSector, createTenant, createUser, expectStatus, ownerPool, startApp, stopApp } from "./helpers.ts";

// Unique per run: the shared test database keeps every run's workspaces, and the admin lists are paginated.
const NAME = `مطعم عمليات الإدارة ${Math.random().toString(36).slice(2, 8)}`;

const qs = (o: Record<string, string>) => new URLSearchParams(o).toString();
const iso = (d: Date) => d.toISOString().slice(0, 10);
const inDays = (n: number) => iso(new Date(Date.now() + n * 86_400_000));

describe("admin operations: subscriptions, sectors, usage, reports, settings, create customer", () => {
  let app: App;
  let admin: Actor;
  let owner: Actor;
  let stranger: Actor;
  let tenant: string;
  let soon: Awaited<ReturnType<typeof comingSoonSector>>;

  before(async () => {
    soon = await comingSoonSector();
    app = await startApp();
    [admin, owner, stranger] = await Promise.all([createUser({ admin: true }), createUser({ name: "مالك الاختبار" }), createUser()]);
    tenant = await createTenant(app, owner, NAME);
  });
  after(async () => { await soon.drop(); await stopApp(app); });

  it("every endpoint is platform-admin only", async () => {
    for (const url of ["/admin/subscriptions", "/admin/sectors", "/admin/usage", "/admin/reports/financial", "/admin/reports/operations", "/admin/settings"]) {
      expectStatus(await call(app, stranger, "GET", url), 403, url);
    }
    expectStatus(await call(app, stranger, "POST", "/admin/tenants", { body: {} }), 403, "create");
  });

  it("lists subscriptions with days left, and filters the ones ending within 30 days", async () => {
    const r = await call(app, admin, "GET", `/admin/subscriptions?${qs({ q: NAME })}`);
    expectStatus(r, 200);
    const s = r.body.items.find((x: { tenantId: string }) => x.tenantId === tenant);
    assert.equal(s.status, "trial");
    assert.equal(s.daysLeft, 14);
    const expiring = await call(app, admin, "GET", `/admin/subscriptions?${qs({ expiring: "true", q: NAME })}`);
    assert.ok(expiring.body.items.some((x: { tenantId: string }) => x.tenantId === tenant));
    assert.ok(typeof r.body.summary.trial === "number");
  });

  it("sectors show real availability, tenant and waitlist counts", async () => {
    const r = await call(app, admin, "GET", "/admin/sectors");
    const restaurants = r.body.items.find((x: { key: string }) => x.key === "restaurants");
    const coming = r.body.items.find((x: { key: string }) => x.key === soon.key);
    assert.equal(restaurants.isAvailable, true);
    assert.equal(coming.isAvailable, false);
    assert.ok(restaurants.activeTenants >= 1);
  });

  it("usage counts branches and users against the plan limits", async () => {
    await addMember(app, owner, tenant, "cashier");
    const r = await call(app, admin, "GET", `/admin/usage?${qs({ q: NAME })}`);
    const u = r.body.items.find((x: { id: string }) => x.id === tenant);
    // Trial: 1 branch / 3 users. Owner + cashier = 2 of 3 users → 67%.
    assert.deepEqual([u.usersUsed, u.usersLimit, u.branchesLimit, u.peak], [2, 3, 1, 67]);
    await addMember(app, owner, tenant, "manager");
    const near = await call(app, admin, "GET", `/admin/usage?${qs({ near: "true", q: NAME })}`);
    assert.equal(near.body.items.find((x: { id: string }) => x.id === tenant)?.peak, 100);
  });

  it("platform settings are validated, saved and audited", async () => {
    expectStatus(await call(app, admin, "PUT", "/admin/settings", { body: { trialDays: 0, defaultVatPercent: 15, defaultDiscountApprovalPercent: 10 } }), 422, "0 days");
    expectStatus(await call(app, admin, "PUT", "/admin/settings", { body: { trialDays: 14, defaultVatPercent: 101, defaultDiscountApprovalPercent: 10 } }), 422, "vat > 100");
    // Saving the defaults: other test files create workspaces in parallel, so this must not change what they get.
    expectStatus(await call(app, admin, "PUT", "/admin/settings", { body: defaultGeneralSettings }), 200, "save");
    const r = await call(app, admin, "GET", "/admin/settings");
    assert.deepEqual(r.body.settings, defaultGeneralSettings);
    const audit = await ownerPool.query("SELECT 1 FROM audit_log WHERE action = 'platform.settings_updated' AND actor_user_id = $1", [admin.id]);
    assert.equal(audit.rowCount, 1);
  });

  it("a NEW workspace takes the platform defaults; existing ones keep their own (checked in a rolled-back transaction)", async () => {
    const fresh = await createUser();
    const db = await ownerPool.connect();
    try {
      await db.query("BEGIN");
      await db.query("INSERT INTO platform_settings (key, value) VALUES ('general', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        [JSON.stringify({ trialDays: 30, defaultVatPercent: 5, defaultDiscountApprovalPercent: 20 })]);
      const fakeReq = { auth: { id: admin.id }, ip: "127.0.0.1" } as unknown as FastifyRequest;
      const t2 = await createTenantRecord(db as unknown as Db, fakeReq, { ownerId: fresh.id, companyName: "مطعم بعد تغيير الإعدادات", sector: "restaurants", taxId: "3005556667", city: null });
      const st = (await db.query("SELECT vat_rate_percent::float8 AS vat, discount_approval_percent::float8 AS disc FROM tenant_settings WHERE tenant_id = $1", [t2])).rows[0];
      const sub = (await db.query("SELECT (ends_at - starts_at)::int AS days FROM subscriptions WHERE tenant_id = $1", [t2])).rows[0];
      assert.deepEqual([st.vat, st.disc, sub.days], [5, 20, 30]);
      const old = (await db.query("SELECT vat_rate_percent::float8 AS vat FROM tenant_settings WHERE tenant_id = $1", [tenant])).rows[0];
      assert.equal(old.vat, 15, "existing workspaces keep their own settings");
    } finally {
      await db.query("ROLLBACK");
      db.release();
    }
  });

  it("the admin creates a workspace for an existing verified account, on trial or a paid plan", async () => {
    const newOwner = await createUser();
    expectStatus(await call(app, admin, "POST", "/admin/tenants", { body: { ownerEmail: "nobody@test.munassiq.local", companyName: "منشأة", sector: "restaurants", taxId: "3001234567" } }), 422, "unknown owner");
    const paid = await call(app, admin, "POST", "/admin/tenants", {
      body: { ownerEmail: newOwner.email, companyName: "مطعم الباقة المدفوعة", sector: "restaurants", taxId: "3009876543", planCode: "restaurants-starter", endsAt: inDays(365), totalValue: 3588 },
    });
    expectStatus(paid, 201, "paid");
    const s = (await ownerPool.query("SELECT s.status, s.total_value::float8 AS v, p.code FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.tenant_id = $1", [paid.body.id])).rows[0];
    assert.deepEqual([s.status, s.v, s.code], ["active", 3588, "restaurants-starter"]);
    const me = await call(app, newOwner, "GET", "/auth/me");
    assert.equal(me.body.tenants.find((x: { id: string }) => x.id === paid.body.id)?.role, "owner");
    expectStatus(await call(app, admin, "POST", "/admin/tenants", { body: { ownerEmail: newOwner.email, companyName: "منشأة ماضية", sector: "restaurants", taxId: "3001112223", planCode: "restaurants-starter", endsAt: inDays(-1) } }), 422, "past end");
    // Any sector with plans (manufacturing is on sale now); a sector with no plans yet is refused, even as a pilot.
    const factory = await call(app, admin, "POST", "/admin/tenants", { body: { ownerEmail: newOwner.email, companyName: "مصنع", sector: "manufacturing", taxId: "3001112224" } });
    expectStatus(factory, 201, "manufacturing");
    const factoryAudit = await ownerPool.query("SELECT meta FROM audit_log WHERE action = 'tenant.created' AND entity_id = $1", [factory.body.id]);
    assert.equal(factoryAudit.rows[0].meta.pilot, false, "not a pilot once the sector is open");
    expectStatus(await call(app, admin, "POST", "/admin/tenants", { body: { ownerEmail: newOwner.email, companyName: "قادم", sector: soon.key, taxId: "3001112225" } }), 422, "no plans");
    const audit = await ownerPool.query("SELECT meta FROM audit_log WHERE action = 'tenant.created' AND entity_id = $1", [paid.body.id]);
    assert.equal(audit.rows[0].meta.byAdmin, true);
  });

  it("financial and operations reports aggregate subscriptions and activity", async () => {
    const f = await call(app, admin, "GET", `/admin/reports/financial?${qs({ from: inDays(-1), to: inDays(1), sector: "restaurants" })}`);
    expectStatus(f, 200);
    assert.ok(f.body.summary.activePaid >= 1);
    assert.ok(f.body.summary.mrr >= 299);
    assert.ok(f.body.contracts.some((c: { companyName: string }) => c.companyName === "مطعم الباقة المدفوعة"));
    const o = await call(app, admin, "GET", `/admin/reports/operations?${qs({ from: inDays(-1), to: inDays(1) })}`);
    expectStatus(o, 200);
    assert.ok(o.body.summary.newTenants >= 3);
    assert.equal(o.body.daily.length, 3);
    expectStatus(await call(app, admin, "GET", `/admin/reports/operations?${qs({ from: inDays(1), to: inDays(-1) })}`), 422, "reversed range");
  });
});
