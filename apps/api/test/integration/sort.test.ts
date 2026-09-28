import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { type Actor, type App, call, code, createIngredient, createTenant, createUser, expectStatus, startApp, stopApp } from "./helpers.ts";

describe("multi-column sorting on paginated lists", () => {
  let app: App;
  let owner: Actor;
  let tenant: string;

  before(async () => {
    app = await startApp();
    owner = await createUser();
    tenant = await createTenant(app, owner);
    for (const [name, category] of [["جزر", "خضار"], ["أرز", "حبوب"], ["بصل", "خضار"], ["عدس", "حبوب"], ["ثوم", "خضار"]]) {
      await createIngredient(app, owner, tenant, name as string, "g", "kg", { category });
    }
    for (const [name, terms] of [["مورد ب", 30], ["مورد أ", 0], ["مورد ج", 30]]) {
      expectStatus(await call(app, owner, "POST", "/t/suppliers", { tenant, body: { code: code("S"), name, paymentTermsDays: terms } }), 201, "supplier");
    }
  });
  after(() => stopApp(app));

  const names = (r: { body: { items: { name: string }[] } }) => r.body.items.map((i) => i.name);

  it("sorts the whole list on the server, not just the current page", async () => {
    const p1 = await call(app, owner, "GET", "/t/ingredients?sort=name:desc&pageSize=2&page=1", { tenant });
    const p2 = await call(app, owner, "GET", "/t/ingredients?sort=name:desc&pageSize=2&page=2", { tenant });
    assert.deepEqual([...names(p1), ...names(p2)], ["عدس", "جزر", "ثوم", "بصل"]);
  });

  it("applies levels in order: category, then name descending", async () => {
    const r = await call(app, owner, "GET", "/t/ingredients?sort=category:asc,name:desc", { tenant });
    assert.deepEqual(names(r), ["عدس", "أرز", "جزر", "ثوم", "بصل"]);
  });

  it("generic directories sort by any column they return", async () => {
    const r = await call(app, owner, "GET", "/t/suppliers?sort=paymentTermsDays:desc,name:asc", { tenant });
    assert.deepEqual(names(r), ["مورد ب", "مورد ج", "مورد أ"]); // default is by name, so this proves the sort ran
    const byCode = await call(app, owner, "GET", "/t/suppliers?sort=isActive:asc,name:desc", { tenant });
    assert.deepEqual(names(byCode), ["مورد ج", "مورد ب", "مورد أ"]);
  });

  it("ignores columns that are not offered, and injection attempts, instead of failing", async () => {
    for (const sort of ["tenant_id:asc", "base_unit_id:desc", `name";DROP TABLE users;--:asc`, "name:sideways"]) {
      const r = await call(app, owner, "GET", `/t/ingredients?sort=${encodeURIComponent(sort)}`, { tenant });
      expectStatus(r, 200, sort);
    }
    const r = await call(app, owner, "GET", "/t/ingredients?sort=tenant_id:desc", { tenant });
    assert.deepEqual(names(r), ["أرز", "بصل", "ثوم", "جزر", "عدس"]); // default order kept
  });
});
