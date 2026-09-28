import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import {
  type Actor, type App, addMember, call, createApprovedRecipe, createIngredient, createTenant, createUser, expectStatus, isoToday, ownerPool, raiseLimits,
  receivePo, setupKitchen, startApp, stockOf, stopApp, unitId, type Kitchen,
} from "./helpers.ts";

// Kitchen: tomatoes 10 kg at 10.00/kg (0.01/g), oil 5 L at 8.00/L (0.008/ml).
describe("batch 2: prep recipes, purchase returns, supplier payments, expenses", () => {
  let app: App;
  let owner: Actor;
  let tenant: string;
  let k: Kitchen;
  let oil: string;
  let po: string;

  before(async () => {
    app = await startApp();
    owner = await createUser();
    tenant = await createTenant(app, owner);
    await raiseLimits(tenant);
    k = await setupKitchen(app, owner, tenant);
    oil = await createIngredient(app, owner, tenant, "زيت", "ml", "l");
    po = await receivePo(app, owner, tenant, { supplierId: k.supplierId, locationId: k.locationId, items: [{ ingredientId: k.ingredientId, quantity: 10, unitPrice: 10 }, { ingredientId: oil, quantity: 5, unitPrice: 8 }] });
  });
  after(() => stopApp(app));

  let prepId: string;
  let sauce: string;

  it("a prep recipe creates a prepared ingredient; production moves raw stock into it at exact cost", async () => {
    const r = await call(app, owner, "POST", "/t/prep-recipes", {
      tenant, body: { name: "صلصة طماطم", unitId: await unitId(app, owner, tenant, "g"), batchYield: 1200, items: [{ ingredientId: k.ingredientId, quantity: 1000 }, { ingredientId: oil, quantity: 250 }] },
    });
    expectStatus(r, 201, "prep recipe");
    prepId = r.body.id;
    const d = await call(app, owner, "GET", `/t/prep-recipes/${prepId}`, { tenant });
    sauce = d.body.ingredientId;
    // batch: 1000 g × 0.01 + 250 ml × 0.008 = 12.00 → 12 / 1200 g = 0.01 / g
    assert.equal(d.body.batchCost, 12);
    assert.equal(d.body.estimatedUnitCost, 0.01);

    const key = randomUUID();
    const p = await call(app, owner, "POST", `/t/prep-recipes/${prepId}/produce`, { tenant, idem: key, body: { locationId: k.locationId, batches: 2 } });
    expectStatus(p, 201, "produce");
    assert.equal(p.body.outputQuantity, 2400);
    assert.equal(p.body.unitCost, 0.01);
    assert.deepEqual(await stockOf(tenant, k.locationId, sauce), { quantity: 2400, avgCost: 0.01 });
    assert.equal((await stockOf(tenant, k.locationId, k.ingredientId)).quantity, 8000);
    assert.equal((await stockOf(tenant, k.locationId, oil)).quantity, 4500);

    const again = await call(app, owner, "POST", `/t/prep-recipes/${prepId}/produce`, { tenant, idem: key, body: { locationId: k.locationId, batches: 2 } });
    assert.equal(again.status, 200, "idempotent replay");
    assert.equal((await stockOf(tenant, k.locationId, sauce)).quantity, 2400);

    const tooMany = await call(app, owner, "POST", `/t/prep-recipes/${prepId}/produce`, { tenant, idem: true, body: { locationId: k.locationId, batches: 100 } });
    assert.equal(tooMany.body.error.code, "insufficient_stock");
    assert.equal((await stockOf(tenant, k.locationId, sauce)).quantity, 2400, "nothing half-done");

    const self = await call(app, owner, "PUT", `/t/prep-recipes/${prepId}`, { tenant, body: { batchYield: 1200, items: [{ ingredientId: sauce, quantity: 1 }] } });
    assert.equal(self.status, 422, "cannot be its own ingredient");
  });

  it("a menu recipe using the prepared ingredient is costed and sold like any other", async () => {
    const recipe = await createApprovedRecipe(app, owner, tenant, 10, [{ ingredientId: sauce, quantity: 100 }]);
    const list = await call(app, owner, "GET", "/t/recipes", { tenant });
    const row = list.body.items.find((x: { id: string }) => x.id === recipe);
    assert.equal(row.totalCost, 1); // 100 g × 0.01
    assert.equal(row.missingCost, 0);
    const menu = await call(app, owner, "GET", `/t/pos/menu?locationId=${k.locationId}`, { tenant });
    assert.equal(menu.body.items.find((m: { id: string }) => m.id === recipe).available, 24);
  });

  it("purchase return: stock leaves at average cost and the supplier is credited; statement and payables agree", async () => {
    const clerk = await addMember(app, owner, tenant, "inventory_clerk");
    const ret = await call(app, clerk, "POST", "/t/purchase-returns", {
      tenant, idem: true, body: { supplierId: k.supplierId, locationId: k.locationId, purchaseOrderId: po, reason: "طماطم تالفة عند الاستلام", items: [{ ingredientId: k.ingredientId, quantity: 1000 }] },
    });
    expectStatus(ret, 201, "return");
    assert.equal(ret.body.totalValue, 10);
    assert.equal((await stockOf(tenant, k.locationId, k.ingredientId)).quantity, 7000);

    const other = await call(app, owner, "POST", "/t/suppliers", { tenant, body: { code: "OTHER", name: "مورد آخر" } });
    const wrongSupplier = await call(app, clerk, "POST", "/t/purchase-returns", {
      tenant, idem: true, body: { supplierId: other.body.id, locationId: k.locationId, purchaseOrderId: po, reason: "خطأ", items: [{ ingredientId: k.ingredientId, quantity: 1 }] },
    });
    assert.equal(wrongSupplier.status, 422);

    const accountant = await addMember(app, owner, tenant, "accountant");
    assert.equal((await call(app, clerk, "POST", "/t/supplier-payments", { tenant, idem: true, body: { supplierId: k.supplierId, paidOn: isoToday(), amount: 50, method: "cash" } })).status, 403);
    expectStatus(await call(app, accountant, "POST", "/t/supplier-payments", { tenant, idem: true, body: { supplierId: k.supplierId, paidOn: isoToday(), amount: 50, method: "bank_transfer", reference: "TRX-1" } }), 201, "payment");
    const future = await call(app, accountant, "POST", "/t/supplier-payments", { tenant, idem: true, body: { supplierId: k.supplierId, paidOn: "2999-01-01", amount: 1, method: "cash" } });
    assert.equal(future.status, 422);

    // Purchased 140.00 (100 tomatoes + 40 oil) − return 10.00 − payment 50.00 = 80.00
    const st = await call(app, owner, "GET", `/t/suppliers/${k.supplierId}/statement`, { tenant });
    expectStatus(st, 200);
    assert.equal(st.body.closingBalance, 80);
    assert.deepEqual(st.body.lines.map((l: { kind: string }) => l.kind).sort(), ["payment", "purchase", "return"]);
    const payables = await call(app, owner, "GET", "/t/payables", { tenant });
    const row = payables.body.items.find((p: { supplierId: string }) => p.supplierId === k.supplierId);
    assert.deepEqual([row.purchases, row.returns, row.payments, row.balance], [140, 10, 50, 80]);
    assert.equal(payables.body.totalOwed, 80);

    await assert.rejects(ownerPool.query("UPDATE supplier_payments SET amount = 1 WHERE tenant_id = $1", [tenant]), /append_only_table/);
  });

  it("expenses: recorder cannot approve their own, approval before payment, cancel only while pending", async () => {
    const accountant = await addMember(app, owner, tenant, "accountant");
    const manager = await addMember(app, owner, tenant, "manager");
    const cats = await call(app, accountant, "GET", "/t/expense-categories", { tenant });
    assert.ok(cats.body.items.length >= 10, "default categories exist for new tenants");
    const rent = cats.body.items.find((c: { name: string }) => c.name === "الإيجار").id;

    const badVat = await call(app, accountant, "POST", "/t/expenses", { tenant, idem: true, body: { categoryId: rent, expenseDate: isoToday(), description: "إيجار", amountNet: 10, vatAmount: 20 } });
    assert.equal(badVat.status, 422);

    const e = await call(app, accountant, "POST", "/t/expenses", { tenant, idem: true, body: { categoryId: rent, expenseDate: isoToday(), description: "إيجار الشهر", amountNet: 5000, vatAmount: 750 } });
    expectStatus(e, 201, "expense");
    assert.equal((await call(app, accountant, "POST", `/t/expenses/${e.body.id}/approve`, { tenant })).status, 403, "own expense");
    assert.equal((await call(app, accountant, "POST", `/t/expenses/${e.body.id}/pay`, { tenant, body: { method: "cash" } })).status, 409, "pay needs approval");
    expectStatus(await call(app, manager, "POST", `/t/expenses/${e.body.id}/approve`, { tenant }), 200, "manager approves");
    assert.equal((await call(app, accountant, "POST", `/t/expenses/${e.body.id}/cancel`, { tenant, body: { reason: "خطأ" } })).status, 409);
    expectStatus(await call(app, accountant, "POST", `/t/expenses/${e.body.id}/pay`, { tenant, body: { method: "bank_transfer", reference: "TRX-9" } }), 200, "paid");

    const list = await call(app, accountant, "GET", "/t/expenses", { tenant });
    assert.equal(list.body.items[0].status, "paid");
    assert.equal(list.body.items[0].total, 5750);
    const rep = await call(app, owner, "GET", "/t/reports/expenses", { tenant });
    assert.equal(rep.body.totalNet, 5000);

    const cashier = await addMember(app, owner, tenant, "cashier");
    assert.equal((await call(app, cashier, "GET", "/t/expenses", { tenant })).status, 403);
  });
});
