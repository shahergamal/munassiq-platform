import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { type Actor, type App, call, code, createTenant, createUser, expectStatus, openShift, receivePo, setupKitchen, startApp, stopApp, type Kitchen } from "./helpers.ts";

// Tomatoes at 0.01 / g. Recipes (price net, grams → ideal cost, food cost %):
//   برجر 30, 100 g → 1.00, 3.33%   شاورما 10, 300 g → 3.00, 30%   فلافل 20, 200 g → 2.00, 10%
//   كبسة 50, 50 g → 0.50, 1%       دجاج 40, 100 g → 1.00, 2.5%
// Shifts, opened in this order by the same cashier:
//   S1 closed: A برجر×1 (34.50)                                  → 1 order, 34.50, over/short −4.50
//   S2 closed: B شاورما×3 (34.50), C فلافل×1 (23), D فلافل×1 (23) → 3 orders, 80.50, over/short 0
//   S3 open:   E فلافل×1 (23), F شاورما×1 (11.50)                → 2 orders, 34.50, over/short null
describe("sorting the paginated sales lists: shifts, orders and menu profitability", () => {
  let app: App;
  let owner: Actor;
  let tenant: string;
  let k: Kitchen;
  const recipe: Record<string, string> = {};
  const shift: Record<string, string> = {};
  const order: Record<string, string> = {};

  const sell = async (label: string, shiftId: string, name: string, quantity: number, total: number) => {
    const r = await call(app, owner, "POST", "/t/pos/orders", {
      tenant, idem: true,
      body: { locationId: k.locationId, shiftId, channel: "takeaway", items: [{ recipeId: recipe[name], quantity }], payments: [{ method: "cash", amount: total }] },
    });
    expectStatus(r, 201, `sale ${label}`);
    order[r.body.id] = label;
  };
  const close = async (id: string, countedCash: number) =>
    expectStatus(await call(app, owner, "POST", `/t/pos/shifts/${id}/close`, { tenant, body: { countedCash } }), 200, "close shift");

  before(async () => {
    app = await startApp();
    owner = await createUser();
    tenant = await createTenant(app, owner);
    k = await setupKitchen(app, owner, tenant);
    await receivePo(app, owner, tenant, { supplierId: k.supplierId, locationId: k.locationId, items: [{ ingredientId: k.ingredientId, quantity: 10, unitPrice: 10 }] });
    for (const [name, priceNet, grams] of [["برجر", 30, 100], ["شاورما", 10, 300], ["فلافل", 20, 200], ["كبسة", 50, 50], ["دجاج", 40, 100]] as const) {
      const r = await call(app, owner, "POST", "/t/recipes", { tenant, body: { code: code("R"), name, priceNet, items: [{ ingredientId: k.ingredientId, quantity: grams }] } });
      expectStatus(r, 201, `recipe ${name}`);
      expectStatus(await call(app, owner, "POST", `/t/recipes/${r.body.id}/status`, { tenant, body: { status: "approved" } }), 200, "approve recipe");
      recipe[name] = r.body.id;
    }

    shift.S1 = await openShift(app, owner, tenant, k.locationId);
    await sell("A", shift.S1, "برجر", 1, 34.5);
    await close(shift.S1, 130);
    shift.S2 = await openShift(app, owner, tenant, k.locationId);
    await sell("B", shift.S2, "شاورما", 3, 34.5);
    await sell("C", shift.S2, "فلافل", 1, 23);
    await sell("D", shift.S2, "فلافل", 1, 23);
    await close(shift.S2, 180.5);
    shift.S3 = await openShift(app, owner, tenant, k.locationId);
    await sell("E", shift.S3, "فلافل", 1, 23);
    await sell("F", shift.S3, "شاورما", 1, 11.5);
  });
  after(() => stopApp(app));

  const get = async (url: string) => {
    const r = await call(app, owner, "GET", url, { tenant });
    expectStatus(r, 200, url);
    return r.body as { items: Record<string, unknown>[] };
  };
  const shiftsBy = async (sort?: string) => {
    const label = Object.fromEntries(Object.entries(shift).map(([l, id]) => [id, l]));
    return (await get(`/t/pos/shifts${sort ? `?sort=${encodeURIComponent(sort)}` : ""}`)).items.map((s) => label[s.id as string]);
  };
  const ordersBy = async (sort?: string, extra = "") =>
    (await get(`/t/pos/orders?${sort ? `sort=${encodeURIComponent(sort)}` : ""}${extra}`)).items.map((o) => order[o.id as string]);
  const menuBy = async (sort?: string, extra = "") =>
    (await get(`/t/reports/menu-profitability?${sort ? `sort=${encodeURIComponent(sort)}` : ""}${extra}`)).items.map((m) => m.name);

  describe("shifts", () => {
    it("default is newest first", async () => {
      assert.deepEqual(await shiftsBy(), ["S3", "S2", "S1"]);
    });

    it("sorts by a count, a date and a signed amount with open shifts' empty values last", async () => {
      assert.deepEqual(await shiftsBy("ordersCount:desc"), ["S2", "S3", "S1"]);
      assert.deepEqual(await shiftsBy("overShort:asc"), ["S1", "S2", "S3"]);
      assert.deepEqual(await shiftsBy("overShort:desc"), ["S2", "S1", "S3"]);
      assert.deepEqual(await shiftsBy("closedAt:desc"), ["S2", "S1", "S3"]);
    });

    it("applies the second level within ties of the first", async () => {
      assert.deepEqual(await shiftsBy("status:asc"), ["S2", "S1", "S3"]);
      assert.deepEqual(await shiftsBy("status:asc,ordersCount:asc"), ["S1", "S2", "S3"]);
      assert.deepEqual(await shiftsBy("salesTotal:asc"), ["S3", "S1", "S2"]);
      assert.deepEqual(await shiftsBy("salesTotal:asc,openedAt:asc"), ["S1", "S3", "S2"]);
    });

    it("ignores columns it does not offer, including hidden ones it selects", async () => {
      for (const sort of ["tenant_id:asc", "openedBy:desc", "isMine:asc", "openedByName:asc", `status";DROP TABLE users;--:asc`]) {
        assert.deepEqual(await shiftsBy(sort), ["S3", "S2", "S1"], sort);
      }
    });
  });

  describe("orders", () => {
    it("default is newest first", async () => {
      assert.deepEqual(await ordersBy(), ["F", "E", "D", "C", "B", "A"]);
    });

    it("sorts the whole list on the server, across pages", async () => {
      assert.deepEqual(await ordersBy("number:asc"), ["A", "B", "C", "D", "E", "F"]);
      assert.deepEqual(await ordersBy("total:desc"), ["B", "A", "E", "D", "C", "F"]);
      const p1 = await ordersBy("total:desc", "&pageSize=4&page=1");
      const p2 = await ordersBy("total:desc", "&pageSize=4&page=2");
      assert.deepEqual([...p1, ...p2], ["B", "A", "E", "D", "C", "F"]);
    });

    it("applies the second level within ties of the first", async () => {
      assert.deepEqual(await ordersBy("total:asc"), ["F", "E", "D", "C", "B", "A"]);
      assert.deepEqual(await ordersBy("total:asc,number:asc"), ["F", "C", "D", "E", "A", "B"]);
    });

    it("ignores columns it does not offer", async () => {
      for (const sort of ["tenant_id:asc", "shift_id:desc", "order_number:asc", "created_at:asc"]) {
        assert.deepEqual(await ordersBy(sort), ["F", "E", "D", "C", "B", "A"], sort);
      }
    });
  });

  describe("menu profitability", () => {
    // Revenue: فلافل 60, شاورما 40, برجر 30, دجاج 0, كبسة 0 (ties broken by name).
    it("default is by revenue, then name", async () => {
      assert.deepEqual(await menuBy(), ["فلافل", "شاورما", "برجر", "دجاج", "كبسة"]);
    });

    it("sorts by price and by the computed costs, across pages", async () => {
      assert.deepEqual(await menuBy("priceNet:asc"), ["شاورما", "فلافل", "برجر", "دجاج", "كبسة"]);
      assert.deepEqual(await menuBy("idealCost:asc"), ["كبسة", "برجر", "دجاج", "فلافل", "شاورما"]);
      assert.deepEqual(await menuBy("foodCostPercent:asc"), ["كبسة", "دجاج", "برجر", "فلافل", "شاورما"]);
      const p1 = await menuBy("foodCostPercent:asc", "&pageSize=3&page=1");
      const p2 = await menuBy("foodCostPercent:asc", "&pageSize=3&page=2");
      assert.deepEqual([...p1, ...p2], ["كبسة", "دجاج", "برجر", "فلافل", "شاورما"]);
    });

    it("applies the second level within ties of the first", async () => {
      assert.deepEqual(await menuBy("qtySold:asc"), ["دجاج", "كبسة", "برجر", "فلافل", "شاورما"]);
      assert.deepEqual(await menuBy("qtySold:asc,priceNet:desc"), ["كبسة", "دجاج", "برجر", "فلافل", "شاورما"]);
    });

    it("ignores columns it does not offer", async () => {
      for (const sort of ["tenant_id:asc", "ingredientCost:desc", "packagingCost:desc", "_total:asc", "code:desc"]) {
        assert.deepEqual(await menuBy(sort), ["فلافل", "شاورما", "برجر", "دجاج", "كبسة"], sort);
      }
    });
  });

  // Every sortKey the web tables send (Sales.tsx) must resolve to an output column of that exact SELECT.
  it("accepts every column the tables offer, in both directions", async () => {
    const offered: [string, string[]][] = [
      ["/t/pos/shifts?", ["locationName", "openedAt", "closedAt", "ordersCount", "salesTotal", "expectedCash", "overShort", "status"]],
      ["/t/pos/orders?", ["number", "createdAt", "channel", "locationName", "vat", "total", "status"]],
      ["/t/reports/menu-profitability?", ["name", "priceNet", "idealCost", "foodCostPercent", "qtySold", "revenue", "actualCost"]],
    ];
    for (const [url, keys] of offered) {
      for (const key of keys) for (const dir of ["asc", "desc"]) await get(`${url}sort=${key}:${dir}`);
    }
    assert.deepEqual(await menuBy("revenue:asc"), ["دجاج", "كبسة", "برجر", "شاورما", "فلافل"]);
    assert.deepEqual(await menuBy("actualCost:desc"), ["شاورما", "فلافل", "برجر", "دجاج", "كبسة"]);
  });
});
