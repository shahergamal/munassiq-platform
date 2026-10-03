import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { type Actor, type App, call, comingSoonSector, createTenant, createUser, expectStatus, ownerPool, startApp, stopApp, uniqueEmail } from "./helpers.ts";

// The admin lists are platform-wide, so each test narrows the result to its own rows (search, tenant filter, or
// its own e-mails) and checks their order. Every row is created so the requested order differs from the default.
describe("sorting on the platform admin lists", () => {
  let app: App;
  let admin: Actor;
  const tag = `srt${randomUUID().slice(0, 8)}`;
  const tenants: Record<string, string> = {};
  const users: Record<string, Actor> = {};
  const waitEmails: Record<string, string> = {};
  let auditTenant: string;
  let soon: Awaited<ReturnType<typeof comingSoonSector>>;

  before(async () => {
    app = await startApp();
    admin = await createUser({ admin: true });
    // Created in this order, so the default (newest first) is ج, أ, ب.
    for (const letter of ["ب", "أ", "ج"]) {
      tenants[letter] = await createTenant(app, await createUser(), `${tag} ${letter}`);
      users[letter] = await createUser({ name: `${tag} ${letter}` });
    }
    expectStatus(await call(app, admin, "POST", `/admin/tenants/${tenants["أ"]}/status`, { body: { status: "blocked", reason: "اختبار الترتيب" } }), 200, "block");
    expectStatus(await call(app, admin, "POST", `/admin/users/${users["أ"]!.id}/suspend`, { body: { reason: "اختبار الترتيب" } }), 200, "suspend");

    // Open sectors take no new waitlist entries, so theirs are written as they were before opening; the other one is still waited for.
    soon = await comingSoonSector();
    for (const [letter, sector] of [["ب", "manufacturing"], ["أ", soon.key], ["ج", "manufacturing"]] as const) {
      waitEmails[letter] = uniqueEmail(tag);
      if (sector === soon.key) expectStatus(await call(app, null, "POST", "/waitlist", { body: { email: waitEmails[letter], companyName: `${tag} ${letter}`, sector } }), 202, "waitlist");
      else await ownerPool.query("INSERT INTO waitlist (email, company_name, sector) VALUES ($1, $2, $3)", [waitEmails[letter], `${tag} ${letter}`, sector]);
    }

    auditTenant = await createTenant(app, await createUser(), "منشأة سجل التدقيق");
    expectStatus(await call(app, admin, "PUT", `/admin/tenants/${auditTenant}/limits`, { body: { branchesLimit: 2, usersLimit: null } }), 200, "limits");
    expectStatus(await call(app, admin, "POST", `/admin/tenants/${auditTenant}/verify-tax-id`), 200, "verify");
  });
  after(async () => { await soon.drop(); await stopApp(app); });

  const suffix = (items: { companyName?: string; fullName?: string }[]) => items.map((i) => (i.companyName ?? i.fullName ?? "").slice(tag.length + 1));
  const get = async (url: string) => {
    const r = await call(app, admin, "GET", url);
    expectStatus(r, 200, url);
    return r.body as { items: Record<string, any>[]; meta: { totalPages: number } };
  };
  const tenantNames = async (sort: string, extra = "") => suffix((await get(`/admin/tenants?q=${tag}&sort=${encodeURIComponent(sort)}${extra}`)).items);
  const userNames = async (sort: string) => suffix((await get(`/admin/users?q=${tag}&sort=${encodeURIComponent(sort)}`)).items);
  const auditActions = async (sort: string) => (await get(`/admin/audit?tenantId=${auditTenant}&sort=${encodeURIComponent(sort)}`)).items.map((a) => a["action"]);
  // The waitlist has no search, so read every page and keep this test's rows (their relative order is the sort's).
  const waitNames = async (sort: string) => {
    const mine = new Set(Object.values(waitEmails));
    const out: Record<string, any>[] = [];
    for (let page = 1; ; page++) {
      const body = await get(`/admin/waitlist?pageSize=100&page=${page}&sort=${encodeURIComponent(sort)}`);
      out.push(...body.items.filter((w) => mine.has(w["email"])));
      if (page >= body.meta.totalPages) break;
    }
    return suffix(out);
  };

  it("tenants: sorts the whole list on the server, then by several columns", async () => {
    assert.deepEqual(await tenantNames(""), ["ج", "أ", "ب"]);
    const p1 = await tenantNames("companyName:asc", "&pageSize=2&page=1");
    const p2 = await tenantNames("companyName:asc", "&pageSize=2&page=2");
    assert.deepEqual([...p1, ...p2], ["أ", "ب", "ج"]);
    // Among the active ones the default tie-breaker (newest first) would give ج, ب: only the second level gives ب, ج.
    assert.deepEqual(await tenantNames("status:asc,companyName:asc"), ["ب", "ج", "أ"]);
  });

  it("users: sorts by name, then by status and name", async () => {
    assert.deepEqual(await userNames(""), ["ج", "أ", "ب"]);
    assert.deepEqual(await userNames("fullName:asc"), ["أ", "ب", "ج"]);
    assert.deepEqual(await userNames("status:asc,fullName:asc"), ["ب", "ج", "أ"]);
  });

  it("audit: sorts by action, time, and actor then action", async () => {
    assert.deepEqual(await auditActions(""), ["tenant.tax_id_verified", "limits.updated", "tenant.created"]);
    assert.deepEqual(await auditActions("action:asc"), ["limits.updated", "tenant.created", "tenant.tax_id_verified"]);
    assert.deepEqual(await auditActions("at:asc"), ["tenant.created", "limits.updated", "tenant.tax_id_verified"]);
    // The owner ("u-…") created the tenant; the admin ("admin-…") did the rest.
    assert.deepEqual(await auditActions("actorEmail:desc,action:asc"), ["tenant.created", "limits.updated", "tenant.tax_id_verified"]);
  });

  it("waitlist: sorts by company, then by sector and company", async () => {
    assert.deepEqual(await waitNames(""), ["ج", "أ", "ب"]);
    assert.deepEqual(await waitNames("companyName:asc"), ["أ", "ب", "ج"]);
    assert.deepEqual(await waitNames("sector:asc,companyName:asc"), ["ب", "ج", "أ"], "manufacturing (ب, ج) before soon_… (أ)");
  });

  it("every column the screens offer is a real output column", async () => {
    const offered: Record<string, string[]> = {
      [`/admin/tenants?q=${tag}`]: ["companyName", "ownerEmail", "taxId", "planName", "subscriptionStatus", "endsAt", "status"],
      [`/admin/users?q=${tag}`]: ["fullName", "email", "tenantsCount", "lastLoginAt", "status"],
      [`/admin/audit?tenantId=${auditTenant}`]: ["at", "action", "actorEmail"],
      "/admin/waitlist?pageSize=5": ["companyName", "sector", "email", "phone", "createdAt"],
    };
    for (const [url, keys] of Object.entries(offered)) {
      for (const key of keys) await get(`${url}&sort=${key}:desc`);
    }
  });

  it("ignores columns that are not offered, keeping the default order", async () => {
    for (const sort of ["tenant_id:asc", "password_hash:desc", `"companyName";DROP TABLE users;--:asc`, "companyName:sideways,meta:asc"]) {
      for (const url of ["/admin/tenants", "/admin/users", "/admin/audit", "/admin/waitlist"]) {
        expectStatus(await call(app, admin, "GET", `${url}?sort=${encodeURIComponent(sort)}`), 200, `${url} ${sort}`);
      }
    }
    assert.deepEqual(await tenantNames("tenant_id:asc"), ["ج", "أ", "ب"]);
    assert.deepEqual(await userNames("password_hash:asc"), ["ج", "أ", "ب"]);
    assert.deepEqual(await auditActions("tenant_id:asc,meta:asc"), ["tenant.tax_id_verified", "limits.updated", "tenant.created"]);
    assert.deepEqual(await waitNames("id:asc"), ["ج", "أ", "ب"]);
  });

  it("only platform admins can read the sorted lists", async () => {
    const owner = await createUser();
    assert.equal((await call(app, owner, "GET", "/admin/tenants?sort=companyName:asc")).status, 403);
  });
});
