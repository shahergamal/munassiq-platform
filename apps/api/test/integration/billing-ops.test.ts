import "./billing-env.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { billingWebhookToken } from "../../src/lib/billing/service.ts";
import { setGatewayTransport, type Transport } from "../../src/lib/payments/gateways.ts";
import { setOpsTransport, type OpsTransport } from "../../src/lib/ops/service.ts";
import { type Actor, type App, addMember, call, createTenant, createUser, expectStatus, ownerPool, startApp, stopApp } from "./helpers.ts";

/** A stand-in for the platform's Moyasar account. */
const pages = new Map<string, { amount: number; status: string }>();
const moyasar: Transport = async (_p, method, path, key, body: any) => {
  if (key !== "sk_test_platformKey12345678") return { status: 401, body: { message: "Invalid authorization credentials" } };
  if (method === "POST" && path === "/invoices") {
    const id = `inv_${randomUUID().replace(/-/g, "")}`;
    pages.set(id, { amount: body.amount, status: "initiated" });
    return { status: 201, body: { id, status: "initiated", amount: body.amount, currency: "SAR", url: `https://checkout.moyasar.com/invoices/${id}` } };
  }
  const p = pages.get(path.replace("/invoices/", ""));
  return p ? { status: 200, body: { status: p.status, amount: p.amount, currency: "SAR", payments: p.status === "paid" ? [{ id: "pay_1", status: "paid" }] : [] } } : { status: 404, body: null };
};
const payAt = (url: string) => { pages.get(url.split("/").at(-1)!)!.status = "paid"; };

/** Stand-ins for Cloudflare and the hosting platform's deploy hook. */
const calls: { url: string; method: string; headers: Record<string, string>; body?: any }[] = [];
const rules = new Map<string, { value: string; target: string; notes: string }>();
const ops: OpsTransport = async (url, init) => {
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ url, method: init.method, headers: init.headers, body });
  if (url.startsWith("https://deploy.example.test")) return init.headers.Authorization === "Bearer deploy-token-123" ? { status: 200, body: { message: "queued" } } : { status: 401, body: null };
  if (init.headers.Authorization !== "Bearer cf-test-token-0123456789abcdef") return { status: 403, body: { success: false, errors: [{ message: "Authentication error" }] } };
  const path = url.replace("https://api.cloudflare.com/client/v4/zones/0123456789abcdef0123456789abcdef", "");
  if (path === "/purge_cache") return { status: 200, body: { success: true, result: { id: "x" } } };
  if (path.startsWith("/firewall/access_rules/rules") && init.method === "GET") {
    return { status: 200, body: { success: true, result: [...rules].map(([id, r]) => ({ id, mode: "block", configuration: { target: r.target, value: r.value }, notes: r.notes })) } };
  }
  if (path === "/firewall/access_rules/rules" && init.method === "POST") {
    const id = randomUUID().replace(/-/g, "");
    rules.set(id, { value: body.configuration.value, target: body.configuration.target, notes: body.notes });
    return { status: 200, body: { success: true, result: { id } } };
  }
  if (init.method === "DELETE") { rules.delete(path.split("/").at(-1)!); return { status: 200, body: { success: true, result: { id: "x" } } }; }
  return { status: 404, body: { success: false, errors: [{ message: "not found" }] } };
};

describe("billing (plans, storage upgrade) and server operations", () => {
  let app: App;
  let admin: Actor;
  let owner: Actor;
  let manager: Actor;
  let tenant: string;
  const billing = async () => (await call(app, owner, "GET", "/t/billing", { tenant })).body;

  before(async () => {
    setGatewayTransport(moyasar);
    setOpsTransport(ops);
    app = await startApp();
    admin = await createUser({ admin: true });
    owner = await createUser({ name: "المالك" });
    tenant = await createTenant(app, owner, "مطعم الفوترة");
    manager = await addMember(app, owner, tenant, "manager");
  });
  after(async () => { setGatewayTransport(null); setOpsTransport(null); await stopApp(app); });

  it("plans carry a storage limit the admin sets; the workspace sees plans, packages and its usage", async () => {
    expectStatus(await call(app, admin, "PATCH", "/admin/plans/restaurants-starter", { body: { storageLimitMb: 2048, isPublic: true } }), 200, "set storage");
    const plans = (await call(app, admin, "GET", "/admin/plans")).body.items;
    assert.equal(plans.find((p: any) => p.code === "restaurants-starter").storageLimitMb, 2048);
    await ownerPool.query("UPDATE plans SET is_public = true WHERE code = 'restaurants-pro'");

    expectStatus(await call(app, manager, "GET", "/t/billing", { tenant }), 403, "owners only");
    const b = await billing();
    assert.equal(b.enabled, true);
    assert.equal(b.current.planCode, "restaurants-trial");
    assert.equal(b.current.storageLimitMb, 200);
    assert.ok(b.plans.some((p: any) => p.code === "restaurants-starter" && p.storageLimitMb === 2048));
    assert.ok(!b.plans.some((p: any) => p.code.endsWith("-trial")), "the trial is never sold");
    assert.ok(b.addons.length >= 1);
  });

  it("paying for a plan activates it only after Moyasar confirms, once", async () => {
    const idem = randomUUID();
    const c = await call(app, owner, "POST", "/t/billing/checkout", { tenant, idem, body: { kind: "subscription", planCode: "restaurants-starter", period: "monthly", amount: 1 } });
    expectStatus(c, 201, "checkout");
    assert.match(c.body.url, /^https:\/\/checkout\.moyasar\.com\//);
    assert.equal([...pages.values()].at(-1)!.amount, 29900, "the plan's price from the database, in halalas");
    const again = await call(app, owner, "POST", "/t/billing/checkout", { tenant, idem, body: { kind: "subscription", planCode: "restaurants-starter", period: "monthly" } });
    assert.equal(again.body.id, c.body.id, "same key, same payment");

    assert.equal((await call(app, owner, "POST", `/t/billing/payments/${c.body.id}/check`, { tenant })).body.status, "pending");
    assert.equal((await billing()).current.planCode, "restaurants-trial");

    payAt(c.body.url);
    const hook = await app.inject({ method: "POST", url: `/api/v1/webhooks/billing/${billingWebhookToken()}`, payload: { id: c.body.url.split("/").at(-1) } });
    assert.equal(hook.statusCode, 200);
    const bad = await app.inject({ method: "POST", url: "/api/v1/webhooks/billing/not-the-token", payload: {} });
    assert.equal(bad.statusCode, 404);
    const paid = await call(app, owner, "POST", `/t/billing/payments/${c.body.id}/check`, { tenant });
    assert.equal(paid.body.status, "paid");
    const b = await billing();
    assert.equal(b.current.planCode, "restaurants-starter");
    assert.equal(b.current.status, "active");
    assert.equal(b.current.storageLimitMb, 2048);
    const subs = (await ownerPool.query("SELECT status FROM subscriptions WHERE tenant_id = $1 ORDER BY created_at", [tenant])).rows.map((r) => r.status);
    assert.deepEqual(subs, ["expired", "active"], "trial ended, paid plan started, exactly one current");

    // Renewing the same plan extends it from its end date.
    const before = b.current.endsAt;
    const r = await call(app, owner, "POST", "/t/billing/checkout", { tenant, idem: true, body: { kind: "subscription", planCode: "restaurants-starter", period: "monthly" } });
    payAt(r.body.url);
    await call(app, owner, "POST", `/t/billing/payments/${r.body.id}/check`, { tenant });
    const after1 = (await billing()).current.endsAt;
    assert.ok(after1 > before, `extended ${before} → ${after1}`);
  });

  it("buying storage raises the workspace's limit automatically and saves it", async () => {
    const addon = (await billing()).addons[0];
    const c = await call(app, owner, "POST", "/t/billing/checkout", { tenant, idem: true, body: { kind: "storage", addonId: addon.id } });
    expectStatus(c, 201, "checkout storage");
    payAt(c.body.url);
    const done = await call(app, owner, "POST", `/t/billing/payments/${c.body.id}/check`, { tenant });
    assert.equal(done.body.status, "paid");
    assert.equal(done.body.storageAddedMb, addon.sizeMb);
    assert.equal((await billing()).current.storageLimitMb, 2048 + addon.sizeMb);
    const saved = (await ownerPool.query("SELECT extra_mb FROM tenant_storage WHERE tenant_id = $1", [tenant])).rows[0].extra_mb;
    assert.equal(saved, addon.sizeMb);
    // A second check never adds it twice.
    await call(app, owner, "POST", `/t/billing/payments/${c.body.id}/check`, { tenant });
    assert.equal((await billing()).current.storageLimitMb, 2048 + addon.sizeMb);
  });

  it("storage is measured; over the limit, stored files and imports are refused (sales never are)", async () => {
    expectStatus(await call(app, admin, "POST", "/admin/storage/recalculate", { body: { tenantId: tenant } }), 200, "measure");
    const used = (await ownerPool.query("SELECT used_bytes FROM tenant_storage WHERE tenant_id = $1", [tenant])).rows[0].used_bytes;
    assert.ok(Number(used) > 0, "its rows take space");
    await ownerPool.query("UPDATE tenant_storage SET used_bytes = 100000000000 WHERE tenant_id = $1", [tenant]);
    const imp = await call(app, owner, "POST", "/t/ingredients/import", { tenant });
    expectStatus(imp, 402, "import refused");
    assert.equal(imp.body.error.details.limit, "storage");
    const ctx = (await call(app, owner, "GET", "/t/context", { tenant })).body;
    assert.ok(ctx.limits.storage.usedMb > ctx.limits.storage.limitMb);
    expectStatus(await call(app, admin, "PUT", `/admin/tenants/${tenant}/storage`, { body: { extraMb: 200000 } }), 200, "admin grants");
    const d = (await call(app, admin, "GET", `/admin/tenants/${tenant}`)).body;
    assert.equal(d.storageExtraMb, 200000);
    await ownerPool.query("UPDATE tenant_storage SET used_bytes = 0 WHERE tenant_id = $1", [tenant]);
  });

  it("admin payments list and storage packages", async () => {
    const list = (await call(app, admin, "GET", "/admin/billing/payments")).body;
    assert.ok(list.items.filter((p: any) => p.companyName === "مطعم الفوترة").length >= 3);
    const created = await call(app, admin, "POST", "/admin/storage-addons", { body: { nameAr: "مساحة 10 جيجا", sizeMb: 10240, price: 179 } });
    expectStatus(created, 201, "addon");
    expectStatus(await call(app, admin, "PATCH", `/admin/storage-addons/${created.body.id}`, { body: { isActive: false } }), 200, "disable");
    expectStatus(await call(app, owner, "POST", "/t/billing/checkout", { tenant, idem: true, body: { kind: "storage", addonId: created.body.id } }), 404, "inactive package not sold");
    expectStatus(await call(app, owner, "GET", "/admin/billing/payments"), 403, "not for workspace owners");
  });

  it("server screen: stats, deploy through the hosting hook, restart off unless enabled", async () => {
    const s = await call(app, admin, "GET", "/admin/server");
    expectStatus(s, 200, "stats");
    assert.ok(s.body.memory.totalBytes > 0 && s.body.cpu.cores > 0 && s.body.database.sizeBytes > 0);
    assert.deepEqual(s.body.features, { cloudflare: true, deploy: true, restart: false });
    const d = await call(app, admin, "POST", "/admin/server/deploy");
    expectStatus(d, 200, "deploy");
    assert.equal(calls.at(-1)!.headers.Authorization, "Bearer deploy-token-123");
    expectStatus(await call(app, admin, "POST", "/admin/server/restart"), 409, "restart disabled");
    expectStatus(await call(app, owner, "GET", "/admin/server"), 403, "admins only");
  });

  it("Cloudflare: purge cache, block and unblock an IP, never the admin's own; suspicious IPs from failed logins", async () => {
    expectStatus(await call(app, admin, "POST", "/admin/cloudflare/purge", { body: {} }), 200, "purge");
    assert.deepEqual(calls.at(-1)!.body, { purge_everything: true });
    expectStatus(await call(app, admin, "POST", "/admin/cloudflare/blocks", { body: { ip: "not-an-ip", note: "سبب" } }), 422, "invalid ip");
    const selfIp = admin.ip ?? "127.0.0.1";
    expectStatus(await call(app, admin, "POST", "/admin/cloudflare/blocks", { body: { ip: selfIp, note: "خطأ" } }), 409, "self block refused");
    const b = await call(app, admin, "POST", "/admin/cloudflare/blocks", { body: { ip: "203.0.113.0/24", note: "محاولات دخول متكررة" } });
    expectStatus(b, 201, "block");
    assert.deepEqual(calls.at(-1)!.body.configuration, { target: "ip_range", value: "203.0.113.0/24" });
    const list = (await call(app, admin, "GET", "/admin/cloudflare/blocks")).body.items;
    assert.equal(list.length, 1);
    expectStatus(await call(app, admin, "DELETE", `/admin/cloudflare/blocks/${list[0].id}`), 204, "unblock");

    for (let n = 0; n < 4; n++) {
      await app.inject({ method: "POST", url: "/api/v1/auth/login", remoteAddress: "198.51.100.9", payload: { email: "nobody@example.test", password: "wrong-password-1" } });
    }
    await new Promise((r) => setTimeout(r, 200));
    const sus = (await call(app, admin, "GET", "/admin/security/suspicious?min=3")).body.items;
    const hit = sus.find((x: any) => x.ip === "198.51.100.9");
    assert.ok(hit && hit.loginFailed >= 3, JSON.stringify(sus));
  });
});
