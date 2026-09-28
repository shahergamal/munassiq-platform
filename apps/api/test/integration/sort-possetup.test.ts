import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  type Actor, type App, addMember, call, createApprovedRecipe, createTenant, createUser, expectStatus, openShift, receivePo, setupKitchen, startApp, stopApp, type Kitchen,
} from "./helpers.ts";

// Salad: 20.00 net → 23.00 with VAT. Default customer order is by name: بدر، خالد، زياد، سالم.
describe("server sorting: customers", () => {
  let app: App;
  let owner: Actor;
  let cashier: Actor;
  let tenant: string;
  let k: Kitchen;
  let salad: string;
  let shift: string;

  before(async () => {
    app = await startApp();
    owner = await createUser();
    tenant = await createTenant(app, owner);
    k = await setupKitchen(app, owner, tenant);
    await receivePo(app, owner, tenant, { supplierId: k.supplierId, locationId: k.locationId, items: [{ ingredientId: k.ingredientId, quantity: 2, unitPrice: 10 }] });
    salad = await createApprovedRecipe(app, owner, tenant, 20, [{ ingredientId: k.ingredientId, quantity: 100 }]);
    cashier = await addMember(app, owner, tenant, "cashier");
    shift = await openShift(app, cashier, tenant, k.locationId);

    const ids: Record<string, string> = {};
    for (const [name, phone] of [["سالم", "0551000002"], ["بدر", "0551000003"], ["زياد", "0551000004"], ["خالد", "0551000001"]] as const) {
      const r = await call(app, cashier, "POST", "/t/customers", { tenant, body: { name, phone } });
      expectStatus(r, 201, `customer ${name}`);
      ids[name] = r.body.id;
    }
    // Orders placed in this sequence, so lastOrderAt ascends سالم → خالد → زياد; بدر never ordered.
    for (const [name, qty] of [["سالم", 3], ["خالد", 1], ["زياد", 1], ["زياد", 1]] as const) {
      const r = await call(app, cashier, "POST", "/t/pos/orders", { tenant, idem: true, body: {
        locationId: k.locationId, shiftId: shift, channel: "takeaway", customerId: ids[name],
        items: [{ recipeId: salad, quantity: qty }], payments: [{ method: "cash", amount: 23 * qty }],
      } });
      expectStatus(r, 201, `sale to ${name}`);
    }
  });
  after(() => stopApp(app));

  const names = (r: { body: { items: { name: string }[] } }) => r.body.items.map((i) => i.name);
  const list = (query: string) => call(app, owner, "GET", `/t/customers?${query}`, { tenant });

  it("keeps the default order by name without a sort", async () => {
    assert.deepEqual(names(await list("")), ["بدر", "خالد", "زياد", "سالم"]);
  });

  it("sorts the whole list on the server, not just the current page", async () => {
    const p1 = await list("sort=phone:desc&pageSize=2&page=1");
    const p2 = await list("sort=phone:desc&pageSize=2&page=2");
    assert.deepEqual([...names(p1), ...names(p2)], ["زياد", "بدر", "سالم", "خالد"]);
    assert.equal(p1.body.meta.total, 4);
  });

  it("sorts by the computed columns the table shows", async () => {
    assert.deepEqual(names(await list("sort=totalSpent:desc")), ["سالم", "زياد", "خالد", "بدر"]);
    // Customers without orders stay last in both directions.
    assert.deepEqual(names(await list("sort=lastOrderAt:asc")), ["سالم", "خالد", "زياد", "بدر"]);
    assert.deepEqual(names(await list("sort=lastOrderAt:desc")), ["زياد", "خالد", "سالم", "بدر"]);
  });

  it("applies levels in order: orders count, then name descending", async () => {
    const r = await list("sort=ordersCount:desc,name:desc");
    assert.deepEqual(names(r), ["زياد", "سالم", "خالد", "بدر"]);
    assert.deepEqual(r.body.items.map((c: { ordersCount: number }) => c.ordersCount), [2, 1, 1, 0]);
  });

  it("ignores columns that are not offered, and injection attempts, instead of failing", async () => {
    for (const sort of ["tenant_id:asc", "createdAt:desc", "email:asc", `name";DROP TABLE customers;--:asc`, "name:sideways"]) {
      expectStatus(await list(`sort=${encodeURIComponent(sort)}`), 200, sort);
    }
    assert.deepEqual(names(await list("sort=tenant_id:desc")), ["بدر", "خالد", "زياد", "سالم"]);
    assert.deepEqual(names(await list("sort=email:desc,phone:asc")), ["خالد", "سالم", "بدر", "زياد"]);
  });

  // One customer, three takeaway orders placed A (2 salads, 46.00), B (1, 23.00), C (2, 46.00). Default is newest first: C, B, A.
  describe("a customer's order history", () => {
    let customerId: string;
    const num: Record<"A" | "B" | "C", number> = { A: 0, B: 0, C: 0 };

    before(async () => {
      const c = await call(app, cashier, "POST", "/t/customers", { tenant, body: { name: "فهد", phone: "0552000001" } });
      expectStatus(c, 201, "customer");
      customerId = c.body.id;
      for (const [label, qty] of [["A", 2], ["B", 1], ["C", 2]] as const) {
        const r = await call(app, cashier, "POST", "/t/pos/orders", { tenant, idem: true, body: {
          locationId: k.locationId, shiftId: shift, channel: "takeaway", customerId,
          items: [{ recipeId: salad, quantity: qty }], payments: [{ method: "cash", amount: 23 * qty }],
        } });
        expectStatus(r, 201, `order ${label}`);
        num[label] = r.body.orderNumber;
      }
    });

    const labels = (r: { body: { items: { number: number }[] } }) =>
      r.body.items.map((i) => (Object.keys(num) as ("A" | "B" | "C")[]).find((k) => num[k] === Number(i.number)));
    const list = (query: string) => call(app, owner, "GET", `/t/customers/${customerId}/orders?${query}`, { tenant });

    it("keeps newest first without a sort", async () => {
      assert.deepEqual(labels(await list("")), ["C", "B", "A"]);
    });

    it("sorts every order, not just the loaded page", async () => {
      const pages: (string | undefined)[] = [];
      for (const page of [1, 2, 3]) pages.push(...labels(await list(`sort=number:asc&pageSize=1&page=${page}`)));
      assert.deepEqual(pages, ["A", "B", "C"]);
    });

    it("applies levels in order: total, then order number", async () => {
      // Equal totals fall back to newest first on one level, and to the second level when given.
      assert.deepEqual(labels(await list("sort=total:asc")), ["B", "C", "A"]);
      assert.deepEqual(labels(await list("sort=total:desc,number:asc")), ["A", "C", "B"]);
    });

    it("ignores columns that are not offered", async () => {
      for (const sort of ["customer_id:asc", "tenant_id:desc", "idempotency_key:asc", `number";DROP TABLE pos_orders;--:asc`]) {
        expectStatus(await list(`sort=${encodeURIComponent(sort)}`), 200, sort);
      }
      assert.deepEqual(labels(await list("sort=tenant_id:asc")), ["C", "B", "A"]);
      assert.deepEqual(labels(await list("sort=customer_id:desc,number:asc")), ["A", "B", "C"]);
    });
  });
});
