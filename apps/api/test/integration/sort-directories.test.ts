import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { type Actor, type App, call, code, createTenant, createUser, expectStatus, raiseLimits, startApp, stopApp } from "./helpers.ts";

describe("sorting the suppliers, branches and locations directories", () => {
  let app: App;
  let owner: Actor;
  let tenant: string;

  before(async () => {
    app = await startApp();
    owner = await createUser();
    tenant = await createTenant(app, owner);
    await raiseLimits(tenant);
    // Default order is by name, so every sort below that differs from [أ, ب, ج, د] proves the sort ran.
    for (const [name, city, branchCode] of [["فرع ج", "جدة", "B-2"], ["فرع أ", "الرياض", "B-4"], ["فرع د", null, "B-1"], ["فرع ب", "جدة", "B-3"]]) {
      expectStatus(await call(app, owner, "POST", "/t/branches", { tenant, body: { code: branchCode, name, city } }), 201, `branch ${name}`);
    }
    for (const [name, locationType] of [["موقع ب", "warehouse"], ["موقع د", "kitchen"], ["موقع أ", "store"], ["موقع ج", "kitchen"]]) {
      expectStatus(await call(app, owner, "POST", "/t/locations", { tenant, body: { code: code("L"), name, locationType } }), 201, `location ${name}`);
    }
    for (const [name, paymentTermsDays, taxId, phone] of [["مورد ب", 30, "300000000000003", "0500000003"], ["مورد د", 0, null, "0500000001"], ["مورد أ", 30, "300000000000001", null], ["مورد ج", 60, "300000000000002", "0500000002"]] as const) {
      expectStatus(await call(app, owner, "POST", "/t/suppliers", { tenant, body: { code: code("S"), name, paymentTermsDays, taxId, phone } }), 201, `supplier ${name}`);
    }
    const d = await call(app, owner, "GET", `/t/locations?q=${encodeURIComponent("موقع د")}`, { tenant });
    expectStatus(await call(app, owner, "PATCH", `/t/locations/${d.body.items[0].id}`, { tenant, body: { isActive: false } }), 200, "deactivate location");
  });
  after(() => stopApp(app));

  const names = async (path: string, qs: string) => {
    const r = await call(app, owner, "GET", `${path}${qs}`, { tenant });
    expectStatus(r, 200, `${path}${qs}`);
    return (r.body.items as { name: string }[]).map((i) => i.name);
  };

  it("keeps the name order without a sort", async () => {
    assert.deepEqual(await names("/t/branches", ""), ["فرع أ", "فرع ب", "فرع ج", "فرع د"]);
    assert.deepEqual(await names("/t/locations", ""), ["موقع أ", "موقع ب", "موقع ج", "موقع د"]);
  });

  it("sorts branches by one column across pages, empty values last", async () => {
    const p1 = await names("/t/branches", "?sort=name:desc&pageSize=2&page=1");
    const p2 = await names("/t/branches", "?sort=name:desc&pageSize=2&page=2");
    assert.deepEqual([...p1, ...p2], ["فرع د", "فرع ج", "فرع ب", "فرع أ"]);
    assert.deepEqual(await names("/t/branches", "?sort=city:desc"), ["فرع ب", "فرع ج", "فرع أ", "فرع د"]);
    assert.deepEqual(await names("/t/branches", "?sort=code:asc"), ["فرع د", "فرع ج", "فرع ب", "فرع أ"]);
  });

  it("applies two levels in order", async () => {
    assert.deepEqual(await names("/t/branches", "?sort=city:asc,name:desc"), ["فرع أ", "فرع ج", "فرع ب", "فرع د"]);
    assert.deepEqual(await names("/t/locations", "?sort=locationType:asc,name:desc"), ["موقع د", "موقع ج", "موقع أ", "موقع ب"]);
    // The inactive د comes first only because of isActive; name alone would put it last.
    assert.deepEqual(await names("/t/locations", "?sort=isActive:asc,name:asc"), ["موقع د", "موقع أ", "موقع ب", "موقع ج"]);
    assert.deepEqual(await names("/t/locations", "?sort=isActive:desc,name:desc"), ["موقع ج", "موقع ب", "موقع أ", "موقع د"]);
  });

  it("sorts suppliers by the fields their columns show", async () => {
    assert.deepEqual(await names("/t/suppliers", ""), ["مورد أ", "مورد ب", "مورد ج", "مورد د"]);
    assert.deepEqual(await names("/t/suppliers", "?sort=paymentTermsDays:desc"), ["مورد ج", "مورد أ", "مورد ب", "مورد د"]);
    assert.deepEqual(await names("/t/suppliers", "?sort=taxId:desc"), ["مورد ب", "مورد ج", "مورد أ", "مورد د"]);
    assert.deepEqual(await names("/t/suppliers", "?sort=phone:asc"), ["مورد د", "مورد ج", "مورد ب", "مورد أ"]);
    assert.deepEqual(await names("/t/suppliers", "?sort=paymentTermsDays:asc,name:desc"), ["مورد د", "مورد ب", "مورد أ", "مورد ج"]);
    for (const sort of ["payment_terms_days:desc", "tax_id:desc", "tenant_id:asc", "bogus:asc,name:desc"]) {
      const expected = sort.startsWith("bogus") ? ["مورد د", "مورد ج", "مورد ب", "مورد أ"] : ["مورد أ", "مورد ب", "مورد ج", "مورد د"];
      assert.deepEqual(await names("/t/suppliers", `?sort=${encodeURIComponent(sort)}`), expected, sort);
    }
  });

  it("combines with the active filter", async () => {
    assert.deepEqual(await names("/t/locations", "?isActive=true&sort=locationType:desc"), ["موقع ب", "موقع أ", "موقع ج"]);
  });

  it("ignores columns that are not offered instead of failing", async () => {
    for (const sort of ["tenant_id:asc", "branch_id:desc", "location_type:desc", `name";DROP TABLE users;--:asc`]) {
      assert.deepEqual(await names("/t/branches", `?sort=${encodeURIComponent(sort)}`), ["فرع أ", "فرع ب", "فرع ج", "فرع د"], sort);
      assert.deepEqual(await names("/t/locations", `?sort=${encodeURIComponent(sort)}`), ["موقع أ", "موقع ب", "موقع ج", "موقع د"], sort);
    }
  });
});
