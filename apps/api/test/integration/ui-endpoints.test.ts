import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { after, before, describe, it } from "node:test";
import {
  type Actor, type App, addMember, call, createApprovedRecipe, createIngredient, createTenant, createUser, expectStatus, openShift,
  receivePo, setupKitchen, startApp, stopApp, type Kitchen,
} from "./helpers.ts";

// Endpoints added for the web UI (stage 1): everything the old UI computed in the browser is now computed here.
describe("endpoints for the web UI", () => {
  let app: App;
  let owner: Actor;
  let admin: Actor;
  let tenant: string;
  let k: Kitchen;
  let cheese: string;

  before(async () => {
    app = await startApp();
    [owner, admin] = await Promise.all([createUser({ name: "سارة المالكة" }), createUser({ admin: true })]);
    tenant = await createTenant(app, owner);
    k = await setupKitchen(app, owner, tenant);
    cheese = await createIngredient(app, owner, tenant, "جبن", "g", "kg", { category: "ألبان", minStock: 5000 });
    // Tomatoes 2 kg at 10.00 → 0.01 / g ; cheese 1 kg at 30.00 → 0.03 / g (below its 5 kg minimum)
    await receivePo(app, owner, tenant, {
      supplierId: k.supplierId, locationId: k.locationId,
      items: [{ ingredientId: k.ingredientId, quantity: 2, unitPrice: 10 }, { ingredientId: cheese, quantity: 1, unitPrice: 30 }],
    });
    await createIngredient(app, owner, tenant, "ملح", "g", "kg", { category: "توابل" });
  });
  after(() => stopApp(app));

  it("ingredient list carries stock and weighted-average cost, with category and stock filters", async () => {
    const all = await call(app, owner, "GET", "/t/ingredients", { tenant });
    expectStatus(all, 200);
    const tomato = all.body.items.find((i: { id: string }) => i.id === k.ingredientId);
    assert.equal(tomato.stockQty, 2000);
    assert.equal(tomato.avgCost, 0.01);

    const dairy = await call(app, owner, "GET", `/t/ingredients?category=${encodeURIComponent("ألبان")}`, { tenant });
    assert.deepEqual(dairy.body.items.map((i: { name: string }) => i.name), ["جبن"]);
    const low = await call(app, owner, "GET", "/t/ingredients?stock=low", { tenant });
    assert.deepEqual(low.body.items.map((i: { name: string }) => i.name), ["جبن"]);
    const zero = await call(app, owner, "GET", "/t/ingredients?stock=zero", { tenant });
    assert.deepEqual(zero.body.items.map((i: { name: string }) => i.name), ["ملح"]);

    const cats = await call(app, owner, "GET", "/t/ingredients/categories", { tenant });
    assert.deepEqual(cats.body.items, ["ألبان", "توابل"]);
  });

  it("exports a real xlsx workbook", async () => {
    const res = await app.inject({
      method: "GET", url: "/api/v1/t/ingredients/export",
      headers: { cookie: `mn_sid=${owner.token}`, "x-tenant-id": tenant }, remoteAddress: owner.ip,
    });
    assert.equal(res.statusCode, 200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    assert.equal(ws.rowCount, 4); // header + 3 ingredients
    assert.equal(ws.getRow(1).getCell(2).value, "الاسم");
  });

  it("previews recipe cost on the server, flagging ingredients with no cost yet", async () => {
    const salt = (await call(app, owner, "GET", "/t/ingredients?stock=zero", { tenant })).body.items[0].id;
    const r = await call(app, owner, "POST", "/t/recipes/cost-preview", {
      tenant,
      body: { priceNet: 10, packagingCost: 0.5, items: [{ ingredientId: k.ingredientId, quantity: 100 }, { ingredientId: cheese, quantity: 50 }, { ingredientId: salt, quantity: 2 }] },
    });
    expectStatus(r, 200);
    // 100 g × 0.01 + 50 g × 0.03 = 2.50 ; + packaging 0.50 = 3.00 ; food cost 30 %
    assert.equal(r.body.ingredientCost, 2.5);
    assert.equal(r.body.totalCost, 3);
    assert.equal(r.body.margin, 7);
    assert.equal(r.body.foodCostPercent, 30);
    assert.equal(r.body.missingCost, 1);

    const cashier = await addMember(app, owner, tenant, "cashier");
    expectStatus(await call(app, cashier, "POST", "/t/recipes/cost-preview", { tenant, body: { items: [] } }), 200, "cashier may read costs");
  });

  it("lists shifts with the opener's name; expected cash stays hidden until the shift is closed", async () => {
    const recipe = await createApprovedRecipe(app, owner, tenant, 20, [{ ingredientId: k.ingredientId, quantity: 100 }]);
    const shift = await openShift(app, owner, tenant, k.locationId);
    expectStatus(await call(app, owner, "POST", "/t/pos/orders", {
      tenant, idem: true,
      body: { locationId: k.locationId, shiftId: shift, channel: "takeaway", items: [{ recipeId: recipe, quantity: 1 }], payments: [{ method: "cash", amount: 23 }] },
    }), 201, "sale");

    const open = await call(app, owner, "GET", "/t/pos/shifts?status=open", { tenant });
    expectStatus(open, 200);
    const row = open.body.items.find((s: { id: string }) => s.id === shift);
    assert.equal(row.openedByName, "سارة المالكة");
    assert.equal(row.isMine, true);
    assert.equal(row.ordersCount, 1);
    assert.equal(row.salesTotal, 23);
    assert.equal(row.expectedCash, null);
    assert.equal("openedBy" in row, false, "raw user ids are not exposed");

    expectStatus(await call(app, owner, "POST", `/t/pos/shifts/${shift}/close`, { tenant, body: { countedCash: 120 } }), 200, "close");
    const closed = await call(app, owner, "GET", "/t/pos/shifts?status=closed", { tenant });
    const c = closed.body.items.find((s: { id: string }) => s.id === shift);
    assert.equal(c.expectedCash, 123);
    assert.equal(c.overShort, -3);
  });

  it("the POS quote is exactly what the sale records, and the menu carries the VAT-inclusive price", async () => {
    // 3 × 7.33 net (odd halalas) with 10% discount: rounding must match the sale to the halala.
    const recipe = await createApprovedRecipe(app, owner, tenant, 7.33, [{ ingredientId: k.ingredientId, quantity: 10 }]);
    const menu = await call(app, owner, "GET", `/t/pos/menu?locationId=${k.locationId}`, { tenant });
    assert.equal(menu.body.items.find((m: { id: string }) => m.id === recipe).priceGross, 8.43);

    const cart = { items: [{ recipeId: recipe, quantity: 3 }], discount: { type: "percent", value: 10 } };
    const quote = await call(app, owner, "POST", "/t/pos/quote", { tenant, body: cart });
    expectStatus(quote, 200, "quote");
    assert.equal(quote.body.subtotal, 21.99);
    assert.equal(quote.body.discount, 2.2);

    const shift = await openShift(app, owner, tenant, k.locationId);
    const sale = await call(app, owner, "POST", "/t/pos/orders", {
      tenant, idem: true,
      body: { ...cart, locationId: k.locationId, shiftId: shift, channel: "dine_in", discountReason: "عرض", payments: [{ method: "mada", amount: quote.body.total }] },
    });
    expectStatus(sale, 201, "sale at the quoted total");
    assert.equal(sale.body.total, quote.body.total);
    assert.equal(sale.body.vat, quote.body.vat);

    const cashier = await addMember(app, owner, tenant, "cashier");
    const over = await call(app, cashier, "POST", "/t/pos/quote", { tenant, body: { ...cart, discount: { type: "percent", value: 30 } } });
    assert.equal(over.status, 403);
    assert.equal(over.body.error.code, "manager_approval_required");
  });

  it("admins list plans; others cannot", async () => {
    const r = await call(app, admin, "GET", "/admin/plans");
    expectStatus(r, 200);
    assert.ok(r.body.items.some((p: { code: string }) => p.code === "restaurants-trial"));
    assert.equal((await call(app, owner, "GET", "/admin/plans")).status, 403);
  });
});
