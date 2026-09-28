import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  call, code, createApprovedPo, createFactory, createIngredient, createUser, expectStatus, raiseLimits, receivePo, startApp, stockOf, stopApp,
  type Actor, type App,
} from "./helpers.ts";

// The rest of M3: landed cost by weight or quantity, customer price lists, and the supplier-invoice match report.
describe("purchasing and pricing extras", () => {
  let app: App;
  let owner: Actor;
  let t: string;
  let store: string;
  let supplier: string;
  let flour: string; // kg-based
  let carton: string; // pieces
  let biscuit: string;

  before(async () => {
    app = await startApp();
    owner = await createUser();
    t = await createFactory(app, owner);
    await raiseLimits(t);
    store = (await call(app, owner, "POST", "/t/locations", { tenant: t, body: { code: code("W"), name: "مستودع", locationType: "warehouse" } })).body.id;
    supplier = (await call(app, owner, "POST", "/t/suppliers", { tenant: t, body: { code: code("S"), name: "مورد مستورد" } })).body.id;
    flour = await createIngredient(app, owner, t, "دقيق", "kg", "kg");
    carton = await createIngredient(app, owner, t, "كرتون", "pcs", "pcs", { itemType: "packaging" });
    biscuit = await createIngredient(app, owner, t, "بسكويت", "pcs", "pcs", { itemType: "finished", salePrice: 3 });
  });
  after(() => stopApp(app));

  it("freight follows the weight when the order says so", async () => {
    const items = [{ ingredientId: flour, quantity: 100, unitPrice: 2 }, { ingredientId: carton, quantity: 10, unitPrice: 80 }];
    const po = await call(app, owner, "POST", "/t/purchases", { tenant: t, idem: true, body: { supplierId: supplier, locationId: store, items, shipping: 300, costAllocation: "weight" } });
    expectStatus(po, 201, "po");
    expectStatus(await call(app, owner, "POST", `/t/purchases/${po.body.id}/approve`, { tenant: t }), 200, "approve");
    expectStatus(await call(app, owner, "POST", `/t/purchases/${po.body.id}/receive`, { tenant: t }), 200, "receive");
    // All 300 of freight rides on the 100 kg of flour: (200 + 300) / 100 kg; the cartons stay at 80.
    assert.equal((await stockOf(t, store, flour)).avgCost, 5);
    assert.equal((await stockOf(t, store, carton)).avgCost, 80);
    // By value (the default) the same freight would split 60 / 240.
    const again = await receivePo(app, owner, t, { supplierId: supplier, locationId: store, items: [{ ingredientId: flour, quantity: 100, unitPrice: 2 }, { ingredientId: carton, quantity: 10, unitPrice: 80 }], shipping: 300 });
    assert.ok(again);
    assert.equal((await stockOf(t, store, carton)).avgCost, 92, "(80 + 104) / 2 after the second receipt");
  });

  it("a customer's price list sets the quotation price before the item's own", async () => {
    const list = await call(app, owner, "POST", "/t/price-lists", { tenant: t, body: { name: code("جملة"), items: [{ itemId: biscuit, price: 2.4 }] } });
    expectStatus(list, 201, "list");
    const phone = `05${Math.floor(10000000 + Math.random() * 89999999)}`;
    const wholesale = (await call(app, owner, "POST", "/t/customers", { tenant: t, body: { name: "تاجر جملة", phone, priceListId: list.body.id } })).body.id;
    const retail = (await call(app, owner, "POST", "/t/customers", { tenant: t, body: { name: "عميل عادي", phone: `05${Math.floor(10000000 + Math.random() * 89999999)}` } })).body.id;
    const q1 = await call(app, owner, "POST", "/t/sales-orders", { tenant: t, idem: true, body: { customerId: wholesale, locationId: store, lines: [{ itemId: biscuit, quantity: 100 }] } });
    const q2 = await call(app, owner, "POST", "/t/sales-orders", { tenant: t, idem: true, body: { customerId: retail, locationId: store, lines: [{ itemId: biscuit, quantity: 100 }] } });
    const price = async (id: string) => (await call(app, owner, "GET", `/t/sales-orders/${id}`, { tenant: t })).body.lines[0].unitPrice;
    assert.equal(await price(q1.body.id), 2.4);
    assert.equal(await price(q2.body.id), 3);
    const avail = await call(app, owner, "GET", `/t/sales-orders/availability?locationId=${store}&itemIds=${biscuit}&customerId=${wholesale}`, { tenant: t });
    assert.equal(avail.body.items[0].salePrice, 2.4);
    // A stopped list no longer prices.
    expectStatus(await call(app, owner, "PUT", `/t/price-lists/${list.body.id}`, { tenant: t, body: { name: "جملة موقوفة", items: [{ itemId: biscuit, price: 2.4 }], isActive: false } }), 200, "stop");
    const q3 = await call(app, owner, "POST", "/t/sales-orders", { tenant: t, idem: true, body: { customerId: wholesale, locationId: store, lines: [{ itemId: biscuit, quantity: 1 }] } });
    assert.equal(await price(q3.body.id), 3);
  });

  it("the match report flags a missing invoice, an amount off the receipt, and a price above the order", async () => {
    const po = await createApprovedPo(app, owner, t, { supplierId: supplier, locationId: store, items: [{ ingredientId: flour, quantity: 50, unitPrice: 2 }, { ingredientId: carton, quantity: 5, unitPrice: 10 }] });
    // First receipt: flour invoiced dearer than ordered, invoice amount matching what was received.
    const r1 = await call(app, owner, "POST", `/t/purchases/${po}/receipts`, { tenant: t, idem: true, body: { supplierInvoice: "INV-1", invoiceAmount: 110,
      items: [{ ingredientId: flour, quantity: 50, unitPrice: 2.2 }] } });
    expectStatus(r1, 201, "receipt 1");
    // Second: invoice amount far from the receipt.
    const r2 = await call(app, owner, "POST", `/t/purchases/${po}/receipts`, { tenant: t, idem: true, body: { supplierInvoice: "INV-2", invoiceAmount: 80,
      items: [{ ingredientId: carton, quantity: 5 }] } });
    expectStatus(r2, 201, "receipt 2");
    const rep = await call(app, owner, "GET", "/t/reports/purchase-matching?tolerance=1", { tenant: t });
    expectStatus(rep, 200, "report");
    const byInvoice = (inv: string) => rep.body.items.find((x: { supplierInvoice: string | null }) => x.supplierInvoice === inv);
    assert.equal(byInvoice("INV-1").status, "price_above_order");
    assert.equal(byInvoice("INV-1").priceVariance, 10);
    assert.equal(byInvoice("INV-2").status, "amount_mismatch");
    assert.ok(rep.body.items.some((x: { status: string }) => x.status === "no_invoice"), "receipts without an invoice amount");
    const issues = await call(app, owner, "GET", "/t/reports/purchase-matching?issues=true", { tenant: t });
    assert.ok(issues.body.items.every((x: { status: string }) => x.status !== "matched"));
  });
});
