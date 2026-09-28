import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  call, code, createFactory, createIngredient, createTenant, createUser, expectStatus, ownerPool, raiseLimits, receivePo, startApp, stockOf, stopApp,
  type Actor, type App,
} from "./helpers.ts";

// Manufacturing M3 (docs/manufacturing/ARCHITECTURE.md): quotation → order (reservation, credit limit) → delivery
// (stock out at cost, cost of sales) → tax invoice from what was delivered → customer return.
describe("sales orders", () => {
  let app: App;
  let owner: Actor;
  let t: string;
  let store: string;
  let F: string; // finished product, sold at 12.00
  let G: string; // another product, tracked by expiry
  let customer: string;

  const post = async (url: string, body: object = {}, status = 201) => {
    const r = await call(app, owner, "POST", url, { tenant: t, idem: true, body });
    expectStatus(r, status, url);
    return r.body;
  };
  const get = async (url: string) => { const r = await call(app, owner, "GET", url, { tenant: t }); expectStatus(r, 200, url); return r.body; };
  const ledger = async (key: string) => Number((await ownerPool.query<{ b: string }>(
    `SELECT coalesce(sum(l.debit - l.credit), 0)::text AS b FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.tenant_id = $1 AND a.system_key = $2`, [t, key])).rows[0]!.b);

  before(async () => {
    app = await startApp();
    owner = await createUser();
    t = await createFactory(app, owner);
    await raiseLimits(t);
    store = (await post("/t/locations", { code: code("FG"), name: "مستودع المنتج التام", locationType: "warehouse" })).id;
    const sup = (await post("/t/suppliers", { code: code("S"), name: "مورد" })).id;
    F = await createIngredient(app, owner, t, "علبة بسكويت", "pcs", "pcs", { itemType: "finished", salePrice: 12, nameEn: "Biscuit box" });
    G = await createIngredient(app, owner, t, "عصير", "pcs", "pcs", { itemType: "finished", salePrice: 5, trackExpiry: true, shelfLifeDays: 30 });
    await receivePo(app, owner, t, { supplierId: sup, locationId: store, items: [{ ingredientId: F, quantity: 100, unitPrice: 7 }] });
    expectStatus(await call(app, owner, "PUT", "/t/accounting/tax-profile", { tenant: t, body: {
      legalName: "مصنع الاختبار", street: "طريق الملك فهد", buildingNo: "1234", district: "العليا", city: "الرياض", postalCode: "12345" } }), 200, "tax profile");
    customer = (await post("/t/customers", { name: "شركة التوزيع", phone: `05${Math.floor(10000000 + Math.random() * 89999999)}`, customerType: "business",
      vatNumber: "310123456700003", street: "شارع العليا", buildingNo: "4321", district: "الملز", city: "الرياض", postalCode: "11564", paymentTermsDays: 30, creditLimit: 2000 })).id;
  });
  after(() => stopApp(app));

  let order: string;

  it("a quotation prices from the item, reserves on confirmation, and refuses what is not available", async () => {
    order = (await post("/t/sales-orders", { customerId: customer, locationId: store, lines: [{ itemId: F, quantity: 60, discount: 12 }] })).id;
    let o = await get(`/t/sales-orders/${order}`);
    // 60 × 12 = 720 − 12 discount = 708, VAT 15% = 106.20 → 814.20.
    assert.deepEqual([o.status, o.taxable, o.vat, o.total], ["quotation", 708, 106.2, 814.2]);
    assert.equal(o.lines[0].description, "علبة بسكويت");
    expectStatus(await call(app, owner, "PUT", `/t/sales-orders/${order}`, { tenant: t, body: { customerId: customer, locationId: store, lines: [{ itemId: F, quantity: 70, unitPrice: 11 }] } }), 200, "edit quotation");
    await post(`/t/sales-orders/${order}/confirm`, {}, 200);
    o = await get(`/t/sales-orders/${order}`);
    assert.equal(o.total, 885.5); // 70 × 11 = 770 + 115.50
    // 100 on hand, 70 reserved: a second order for 40 is short.
    const second = (await post("/t/sales-orders", { customerId: customer, locationId: store, lines: [{ itemId: F, quantity: 40 }] })).id;
    const short = await call(app, owner, "POST", `/t/sales-orders/${second}/confirm`, { tenant: t, body: {} });
    assert.equal(short.status, 409);
    assert.equal(short.body.error.code, "insufficient_availability");
    assert.equal(short.body.error.details.short[0].available, 30);
    // Within credit (885.50 + 480 + VAT = 1437.50 ≤ 2000) it can wait for production.
    const bo = await post(`/t/sales-orders/${second}/confirm`, { backorder: true }, 200);
    assert.equal(bo.backorder[0].required, 40);
    // A third one would pass the credit limit.
    const third = (await post("/t/sales-orders", { customerId: customer, locationId: store, lines: [{ itemId: F, quantity: 50 }] })).id;
    const over = await call(app, owner, "POST", `/t/sales-orders/${third}/confirm`, { tenant: t, body: { backorder: true } });
    assert.equal(over.status, 409);
    assert.equal(over.body.error.code, "credit_limit_exceeded");
    expectStatus(await call(app, owner, "POST", `/t/sales-orders/${third}/cancel`, { tenant: t, body: { reason: "تجاوز الحد" } }), 200, "cancel");
    expectStatus(await call(app, owner, "POST", `/t/sales-orders/${second}/cancel`, { tenant: t, body: { reason: "تأجيل" } }), 200, "cancel backorder");
  });

  it("delivery takes stock out at cost; the invoice bills what was delivered; a return comes back at cost", async () => {
    await post(`/t/sales-orders/${order}/deliver`, { lines: [{ lineId: (await get(`/t/sales-orders/${order}`)).lines[0].id, quantity: 50 }], driver: "سالم" });
    assert.equal((await stockOf(t, store, F)).quantity, 50);
    assert.equal(await ledger("cogs"), 350, "50 × 7 cost of sales");
    assert.equal(await ledger("inventory_finished"), 350, "700 received − 350 delivered");

    const inv = await post(`/t/sales-orders/${order}/invoice`, {});
    const doc = (await ownerPool.query<{ invoice_type: string; total: string; sales_order_id: string }>("SELECT invoice_type, total::text, sales_order_id FROM sales_documents WHERE id = $1", [inv.id])).rows[0]!;
    // 50 × 11 = 550 + 82.50 VAT.
    assert.deepEqual([doc.invoice_type, Number(doc.total), doc.sales_order_id], ["standard", 632.5, order]);
    const line = (await ownerPool.query<{ item_id: string; description: string }>("SELECT item_id, description FROM sales_document_lines WHERE document_id = $1", [inv.id])).rows[0]!;
    assert.equal(line.item_id, F);
    assert.equal(line.description, "علبة بسكويت / Biscuit box");
    assert.equal(await ledger("ar"), 632.5);
    const again = await call(app, owner, "POST", `/t/sales-orders/${order}/invoice`, { tenant: t, idem: true, body: {} });
    assert.equal(again.status, 409, "nothing delivered is left to invoice");

    const o = await get(`/t/sales-orders/${order}`);
    assert.deepEqual([o.lines[0].deliveredQty, o.lines[0].invoicedQty, o.lines[0].toDeliver], [50, 50, 20]);
    assert.equal(o.invoices.length, 1);
    await post(`/t/sales-orders/${order}/returns`, { lines: [{ lineId: o.lines[0].id, quantity: 5 }], reason: "كرتون تالف عند العميل" });
    assert.equal((await stockOf(t, store, F)).quantity, 55);
    assert.equal(await ledger("cogs"), 315);
    const after = await get(`/t/sales-orders/${order}`);
    assert.equal(after.lines[0].overInvoiced, 5, "the returned 5 were invoiced: they need a credit note");
    const tooMany = await call(app, owner, "POST", `/t/sales-orders/${order}/returns`, { tenant: t, idem: true, body: { lines: [{ lineId: o.lines[0].id, quantity: 46 }], reason: "خطأ" } });
    assert.equal(tooMany.status, 422);
  });

  it("an expired batch is never delivered; a partly delivered order closes instead of cancelling", async () => {
    const sup = (await post("/t/suppliers", { code: code("S"), name: "مورد العصير" })).id;
    await receivePo(app, owner, t, { supplierId: sup, locationId: store, items: [{ ingredientId: G, quantity: 10, unitPrice: 2 }] });
    // The batch has since expired and nobody disposed of it.
    // (Time passing: an expiry date is immutable, so the fixture steps around the guard for this one session only.)
    const c = await ownerPool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      await c.query("UPDATE stock_batches SET expiry_date = current_date - 1, production_date = current_date - 40 WHERE tenant_id = $1 AND ingredient_id = $2", [t, G]);
      await c.query("COMMIT");
    } finally { c.release(); }
    const so = (await post("/t/sales-orders", { customerId: customer, locationId: store, lines: [{ itemId: G, quantity: 2 }] })).id;
    await post(`/t/sales-orders/${so}/confirm`, {}, 200);
    const d = await call(app, owner, "POST", `/t/sales-orders/${so}/deliver`, { tenant: t, idem: true, body: {} });
    assert.equal(d.status, 409);
    assert.equal(d.body.error.code, "expired_stock");

    const partial = await get(`/t/sales-orders/${order}`);
    assert.equal((await call(app, owner, "POST", `/t/sales-orders/${order}/cancel`, { tenant: t, body: { reason: "محاولة" } })).status, 409);
    assert.ok(partial.lines[0].toDeliver > 0);
    expectStatus(await call(app, owner, "POST", `/t/sales-orders/${order}/close`, { tenant: t, body: { reason: "العميل اكتفى بما استلم" } }), 200, "short close");
  });

  it("a restaurant has no sales orders", async () => {
    const o = await createUser();
    const r = await createTenant(app, o);
    assert.equal((await call(app, o, "GET", "/t/sales-orders", { tenant: r })).status, 404);
  });
});
