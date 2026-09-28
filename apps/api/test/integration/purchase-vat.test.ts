import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { type Actor, type App, call, code, createTenant, createUser, expectStatus, receivePo, setupKitchen, startApp, stockOf, stopApp, type Kitchen } from "./helpers.ts";

// Registered supplier: 10 kg × 10.00 + shipping 15.00 = 115.00 net, VAT 15% = 17.25, invoice 132.25.
describe("purchase VAT", () => {
  let app: App;
  let owner: Actor;
  let tenant: string;
  let k: Kitchen;
  let vatSupplier: string;
  let po: string;

  before(async () => {
    app = await startApp();
    owner = await createUser();
    tenant = await createTenant(app, owner);
    k = await setupKitchen(app, owner, tenant);
    const s = await call(app, owner, "POST", "/t/suppliers", { tenant, body: { code: code("S"), name: "مورد مسجل", taxId: "300000000000003" } });
    expectStatus(s, 201, "supplier");
    vatSupplier = s.body.id;
    po = await receivePo(app, owner, tenant, { supplierId: vatSupplier, locationId: k.locationId, shipping: 15, items: [{ ingredientId: k.ingredientId, quantity: 10, unitPrice: 10 }] });
  });
  after(() => stopApp(app));

  it("a VAT-registered supplier's order carries VAT on the net total, computed on the server", async () => {
    const r = await call(app, owner, "GET", `/t/purchases/${po}`, { tenant });
    assert.deepEqual([r.body.total, r.body.vatRate, r.body.vatAmount, r.body.grandTotal], [115, 15, 17.25, 132.25]);
  });

  it("VAT never enters inventory cost", async () => {
    assert.equal((await stockOf(tenant, k.locationId, k.ingredientId)).avgCost, 0.0115);
  });

  it("an unregistered supplier defaults to no VAT; the buyer can still say the invoice has VAT", async () => {
    const plain = await call(app, owner, "POST", "/t/purchases", { tenant, idem: true, body: { supplierId: k.supplierId, locationId: k.locationId, items: [{ ingredientId: k.ingredientId, quantity: 1, unitPrice: 20 }] } });
    const withVat = await call(app, owner, "POST", "/t/purchases", { tenant, idem: true, body: { supplierId: k.supplierId, locationId: k.locationId, vatApplicable: true, items: [{ ingredientId: k.ingredientId, quantity: 1, unitPrice: 20 }] } });
    const noVat = await call(app, owner, "POST", "/t/purchases", { tenant, idem: true, body: { supplierId: vatSupplier, locationId: k.locationId, vatApplicable: false, items: [{ ingredientId: k.ingredientId, quantity: 1, unitPrice: 20 }] } });
    const got = await Promise.all([plain, withVat, noVat].map(async (c) => (await call(app, owner, "GET", `/t/purchases/${c.body.id}`, { tenant })).body.vatAmount));
    assert.deepEqual(got, [0, 3, 0]);
  });

  it("the supplier is owed the VAT-inclusive amount; a return reverses its VAT too", async () => {
    let p = await call(app, owner, "GET", "/t/payables", { tenant });
    assert.equal(p.body.items.find((x: { supplierId: string }) => x.supplierId === vatSupplier).balance, 132.25);
    // 2 000 g at 0.0115 = 23.00 + VAT 3.45
    const ret = await call(app, owner, "POST", "/t/purchase-returns", {
      tenant, idem: true, body: { supplierId: vatSupplier, locationId: k.locationId, purchaseOrderId: po, reason: "تالف", items: [{ ingredientId: k.ingredientId, quantity: 2000 }] },
    });
    expectStatus(ret, 201, "return");
    assert.deepEqual([ret.body.totalValue, ret.body.vatAmount], [23, 3.45]);
    p = await call(app, owner, "GET", "/t/payables", { tenant });
    assert.equal(p.body.items.find((x: { supplierId: string }) => x.supplierId === vatSupplier).balance, 105.8);
  });

  it("the VAT report counts purchase input VAT net of returns", async () => {
    const r = await call(app, owner, "GET", "/t/reports/vat", { tenant });
    expectStatus(r, 200);
    assert.deepEqual([r.body.summary.inputVatPurchases, r.body.summary.purchasesWithVat, r.body.summary.returnsVat], [13.8, 1, 3.45]);
    assert.equal(r.body.summary.netVat, -13.8);
  });
});
