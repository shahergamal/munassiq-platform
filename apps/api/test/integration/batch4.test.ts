import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  type Actor, type App, call, createApprovedRecipe, createTenant, createUser, expectStatus, isoToday, openShift, receivePo, setupKitchen, startApp, stopApp, unitId, type Kitchen,
} from "./helpers.ts";

// Tomatoes: 10 kg at 10.00 then 10 kg at 12.00 → 0.011 / g. Salad = 100 g tomato, 20.00 net.
describe("batch 4: analytical reports and platform admin", () => {
  let app: App;
  let owner: Actor;
  let admin: Actor;
  let tenant: string;
  let k: Kitchen;
  let salad: string;
  let shift: string;

  before(async () => {
    app = await startApp();
    [owner, admin] = await Promise.all([createUser({ name: "نورة الكاشير" }), createUser({ admin: true })]);
    tenant = await createTenant(app, owner);
    k = await setupKitchen(app, owner, tenant);
    await receivePo(app, owner, tenant, { supplierId: k.supplierId, locationId: k.locationId, items: [{ ingredientId: k.ingredientId, quantity: 10, unitPrice: 10 }] });
    await receivePo(app, owner, tenant, { supplierId: k.supplierId, locationId: k.locationId, items: [{ ingredientId: k.ingredientId, quantity: 10, unitPrice: 12 }] });
    salad = await createApprovedRecipe(app, owner, tenant, 20, [{ ingredientId: k.ingredientId, quantity: 100 }]);
    shift = await openShift(app, owner, tenant, k.locationId);
    expectStatus(await call(app, owner, "POST", "/t/pos/orders", {
      tenant, idem: true, body: { locationId: k.locationId, shiftId: shift, channel: "takeaway", items: [{ recipeId: salad, quantity: 3 }], payments: [{ method: "cash", amount: 69 }] },
    }), 201, "sale");
    expectStatus(await call(app, owner, "POST", "/t/waste", { tenant, idem: true, body: { locationId: k.locationId, reason: "spoiled", items: [{ ingredientId: k.ingredientId, quantity: 200 }] } }), 201, "waste");
    const st = await call(app, owner, "POST", "/t/stocktakes", { tenant, body: { locationId: k.locationId } });
    await call(app, owner, "PUT", `/t/stocktakes/${st.body.id}/counts`, { tenant, body: { items: [{ ingredientId: k.ingredientId, countedQty: 19000 }] } }); // system 19 500
    expectStatus(await call(app, owner, "POST", `/t/stocktakes/${st.body.id}/post`, { tenant }), 200, "post count");
  });
  after(() => stopApp(app));

  it("ideal vs actual: sales usage, plus waste and stocktake shortage, from the ledger", async () => {
    const r = await call(app, owner, "GET", "/t/reports/ideal-vs-actual", { tenant });
    expectStatus(r, 200);
    const row = r.body.items.find((x: { ingredientId: string }) => x.ingredientId === k.ingredientId);
    assert.deepEqual([row.idealQty, row.idealValue, row.wasteValue, row.countQty, row.countValue], [300, 3.3, 2.2, 500, 5.5]);
    assert.deepEqual([row.actualQty, row.actualValue, row.varianceValue, row.variancePercent], [1000, 11, 7.7, 233.33]);
    assert.equal(r.body.totals.netSales, 60);
    assert.equal(r.body.totals.idealFoodCostPercent, 5.5);
    assert.equal(r.body.totals.actualFoodCostPercent, 18.33);
  });

  it("purchase prices: min / max / first / last and change over the period", async () => {
    const r = await call(app, owner, "GET", "/t/reports/purchase-prices", { tenant });
    const row = r.body.items.find((x: { ingredientId: string }) => x.ingredientId === k.ingredientId);
    assert.deepEqual([row.receipts, row.minCost, row.maxCost, row.weightedAvg, row.firstCost, row.lastCost, row.changePercent], [2, 0.01, 0.012, 0.011, 0.01, 0.012, 20]);
  });

  it("cashier reconciliation groups closed shifts per cashier with the shortage", async () => {
    // expected = float 100 + cash 69 = 169; counted 164 → short 5
    expectStatus(await call(app, owner, "POST", `/t/pos/shifts/${shift}/close`, { tenant, body: { countedCash: 164 } }), 200, "close");
    const r = await call(app, owner, "GET", "/t/reports/cashier-reconciliation", { tenant });
    assert.deepEqual([r.body.items[0].cashier, r.body.items[0].shifts, r.body.items[0].sales, r.body.items[0].overShort], ["نورة الكاشير", 1, 69, -5]);
  });

  it("VAT summary: output from invoices less credit notes, input from approved expenses", async () => {
    const cats = await call(app, owner, "GET", "/t/expense-categories", { tenant });
    const e = await call(app, owner, "POST", "/t/expenses", { tenant, idem: true, body: { categoryId: cats.body.items[0].id, expenseDate: isoToday(), description: "فاتورة صيانة", amountNet: 100, vatAmount: 15 } });
    expectStatus(await call(app, owner, "POST", `/t/expenses/${e.body.id}/approve`, { tenant }), 200, "owner approves own");
    const r = await call(app, owner, "GET", "/t/reports/vat", { tenant });
    expectStatus(r, 200);
    assert.deepEqual([r.body.summary.taxableSales, r.body.summary.outputVat, r.body.summary.inputVatExpenses, r.body.summary.netVat], [60, 9, 15, -6]);
    assert.ok(r.body.notes.some((n: string) => n.includes("ليس إقراراً")));
  });

  it("recipe explosion: cost shares, with a prepared ingredient broken into its raw inputs", async () => {
    const direct = await call(app, owner, "GET", `/t/reports/recipe-explosion?recipeId=${salad}`, { tenant });
    assert.deepEqual([direct.body.lines.length, direct.body.lines[0].cost, direct.body.lines[0].sharePercent, direct.body.recipe.foodCostPercent], [1, 1.1, 100, 5.5]);

    // Sauce: 1000 g tomato → 500 g. A dish using 50 g sauce really uses 100 g tomato.
    const prep = await call(app, owner, "POST", "/t/prep-recipes", { tenant, body: { name: "صلصة", unitId: await unitId(app, owner, tenant, "g"), batchYield: 500, items: [{ ingredientId: k.ingredientId, quantity: 1000 }] } });
    const sauce = (await call(app, owner, "GET", `/t/prep-recipes/${prep.body.id}`, { tenant })).body.ingredientId;
    const dish = await createApprovedRecipe(app, owner, tenant, 10, [{ ingredientId: sauce, quantity: 50 }]);
    const ex = await call(app, owner, "GET", `/t/reports/recipe-explosion?recipeId=${dish}`, { tenant });
    assert.equal(ex.body.lines.length, 1);
    assert.deepEqual([ex.body.lines[0].ingredientId, ex.body.lines[0].rawQty, ex.body.lines[0].viaPrep, ex.body.lines[0].cost], [k.ingredientId, 100, "صلصة", 1.1]);
  });

  it("admin: role matrix is read-only data, plans can be added and edited, the trial plan cannot be disabled", async () => {
    const roles = await call(app, admin, "GET", "/admin/roles");
    const cashier = roles.body.roles.find((r: { role: string }) => r.role === "cashier");
    assert.ok(cashier.permissions.includes("kitchen.use") && !cashier.permissions.includes("orders.refund"));
    assert.equal((await call(app, owner, "GET", "/admin/roles")).status, 403);

    const code = `restaurants-gold-${Date.now()}`;
    expectStatus(await call(app, admin, "POST", "/admin/plans", { body: { code, sector: "restaurants", nameAr: "الذهبية", monthlyPrice: 1299, branchesLimit: 20, usersLimit: 60 } }), 201, "create plan");
    assert.equal((await call(app, admin, "POST", "/admin/plans", { body: { code, sector: "restaurants", nameAr: "مكرر", monthlyPrice: 1, branchesLimit: 1, usersLimit: 1 } })).status, 409);
    expectStatus(await call(app, admin, "PATCH", `/admin/plans/${code}`, { body: { monthlyPrice: 1199 } }), 200, "edit plan");
    const plans = await call(app, admin, "GET", "/admin/plans");
    assert.equal(plans.body.items.find((p: { code: string }) => p.code === code).monthlyPrice, 1199);
    const trial = await call(app, admin, "PATCH", "/admin/plans/restaurants-trial", { body: { isActive: false } });
    assert.equal(trial.body.error.code, "plan_required");
  });
});
