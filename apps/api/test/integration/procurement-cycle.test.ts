import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  type Actor, type App, addMember, call, code, createApprovedRecipe, createIngredient, createTenant, createUser, expectStatus, isoToday, openShift, ownerPool,
  raiseLimits, setupKitchen, startApp, stockOf, stopApp, type Kitchen,
} from "./helpers.ts";

/**
 * The whole purchasing and inventory document cycle, walked through the way a restaurant finance head audits it:
 * every document, every control (segregation of duties, approval limit, over-receipt, quality rejection, three-way
 * match, transit shortage, blind barcode count), and at the end the books must agree with the sub-ledgers:
 * inventory in the ledger = stock valuation, payables in the ledger = the supplier ledger, VAT input = the receipts.
 */
describe("procurement & inventory cycle, reconciled like a CFO would", () => {
  let app: App;
  let owner: Actor, manager: Actor, accountant: Actor, clerk: Actor, cashier: Actor;
  let tenant: string;
  let k: Kitchen;
  let warehouse: string;
  let onions: string;
  let vatSupplier: string;
  let reqId: string;
  let poTomatoes: string, poOnions: string;
  const today = isoToday();
  const accounts = async () => (await call(app, owner, "GET", "/t/accounts", { tenant })).body.items as { systemKey: string | null; netDebit: number }[];
  const gl = async (key: string) => (await accounts()).find((a) => a.systemKey === key)!.netDebit;

  before(async () => {
    app = await startApp();
    owner = await createUser({ name: "المالك" });
    tenant = await createTenant(app, owner, "مطعم الدورة المستندية");
    await raiseLimits(tenant);
    k = await setupKitchen(app, owner, tenant);
    manager = await addMember(app, owner, tenant, "manager");
    accountant = await addMember(app, owner, tenant, "accountant");
    clerk = await addMember(app, owner, tenant, "inventory_clerk");
    cashier = await addMember(app, owner, tenant, "cashier");
    const w = await call(app, owner, "POST", "/t/locations", { tenant, body: { code: code("W"), name: "المستودع المركزي", locationType: "warehouse" } });
    warehouse = w.body.id;
    onions = await createIngredient(app, owner, tenant, "بصل", "g", "kg", { category: "خضار", minStock: 3000, parStock: 8000 });
    expectStatus(await call(app, owner, "PATCH", `/t/ingredients/${k.ingredientId}`, { tenant, body: { category: "خضار" } }), 200, "category");
    const s = await call(app, owner, "POST", "/t/suppliers", { tenant, body: { code: code("S"), name: "مورد مسجل بالضريبة", taxId: "300000000000003" } });
    vatSupplier = s.body.id;
  });
  after(() => stopApp(app));

  it("1. requisition: the clerk asks, cannot approve; the manager approves and converts it into one PO per supplier", async () => {
    const r = await call(app, clerk, "POST", "/t/requisitions", { tenant, idem: true, body: {
      locationId: warehouse, neededBy: today, notes: "تجهيز نهاية الأسبوع",
      items: [{ ingredientId: k.ingredientId, quantity: 10 }, { ingredientId: onions, quantity: 5, note: "بصل أحمر" }] } });
    expectStatus(r, 201, "requisition");
    reqId = r.body.id;
    expectStatus(await call(app, clerk, "POST", `/t/requisitions/${reqId}/approve`, { tenant }), 403, "clerk cannot approve");
    expectStatus(await call(app, manager, "POST", `/t/requisitions/${reqId}/convert`, { tenant, idem: true, body: { lines: [] } }), 422, "empty conversion");
    expectStatus(await call(app, manager, "POST", `/t/requisitions/${reqId}/approve`, { tenant }), 200, "manager approves");

    const d = (await call(app, manager, "GET", `/t/requisitions/${reqId}`, { tenant })).body;
    const [tom, oni] = [d.items.find((i: any) => i.ingredientId === k.ingredientId), d.items.find((i: any) => i.ingredientId === onions)];
    const conv = await call(app, manager, "POST", `/t/requisitions/${reqId}/convert`, { tenant, idem: true, body: {
      expectedDate: today,
      lines: [{ itemId: tom.id, supplierId: vatSupplier, unitPrice: 9 }, { itemId: oni.id, supplierId: k.supplierId, unitPrice: 4 }] } });
    expectStatus(conv, 201, "convert");
    assert.equal(conv.body.purchaseOrderIds.length, 2, "one PO per supplier");
    const pos = await Promise.all(conv.body.purchaseOrderIds.map((id: string) => call(app, owner, "GET", `/t/purchases/${id}`, { tenant })));
    poTomatoes = pos.find((p) => p.body.supplierId === vatSupplier)!.body.id;
    poOnions = pos.find((p) => p.body.supplierId === k.supplierId)!.body.id;
    const t = pos.find((p) => p.body.id === poTomatoes)!.body;
    assert.deepEqual([t.total, t.vatAmount, t.grandTotal, t.requisitionNumber], [90, 13.5, 103.5, d.number]);
    assert.equal((await call(app, owner, "GET", `/t/requisitions/${reqId}`, { tenant })).body.status, "converted");
  });

  it("2. PO approval: its author cannot approve; above the limit only the owner can", async () => {
    expectStatus(await call(app, owner, "PATCH", "/t/settings", { tenant, body: { poOwnerApprovalAbove: 100 } }), 200, "limit");
    expectStatus(await call(app, manager, "POST", `/t/purchases/${poTomatoes}/approve`, { tenant }), 403, "author");
    const over = await call(app, accountant, "POST", `/t/purchases/${poTomatoes}/approve`, { tenant });
    expectStatus(over, 403, "above limit");
    assert.equal(over.body.error.code, "approval_limit");
    expectStatus(await call(app, owner, "POST", `/t/purchases/${poTomatoes}/approve`, { tenant }), 200, "owner approves");
    expectStatus(await call(app, accountant, "POST", `/t/purchases/${poOnions}/approve`, { tenant }), 200, "below limit");
  });

  it("3. receiving: partial delivery with a rejected carton, over-receipt refused, price variance, then closed short", async () => {
    const g1 = await call(app, clerk, "POST", `/t/purchases/${poTomatoes}/receipts`, { tenant, idem: true, body: {
      supplierInvoice: "A-1001", supplierInvoiceDate: today, invoiceAmount: 70,
      items: [{ ingredientId: k.ingredientId, quantity: 6, rejectedQuantity: 1, rejectReason: "كرتونة تالفة" }] } });
    expectStatus(g1, 201, "GRN 1");
    let po = (await call(app, owner, "GET", `/t/purchases/${poTomatoes}`, { tenant })).body;
    assert.equal(po.status, "partially_received");
    assert.equal(po.items[0].receivedQuantity, 6);
    const grn1 = (await call(app, owner, "GET", `/t/goods-receipts/${g1.body.id}`, { tenant })).body;
    assert.deepEqual([grn1.total, grn1.vatAmount, grn1.grandTotal], [54, 8.1, 62.1]);
    assert.equal(grn1.items[0].rejectedQuantity, 1);
    assert.equal((await stockOf(tenant, warehouse, k.ingredientId)).quantity, 6000);

    const over = await call(app, clerk, "POST", `/t/purchases/${poTomatoes}/receipts`, { tenant, idem: true, body: { items: [{ ingredientId: k.ingredientId, quantity: 5 }] } });
    expectStatus(over, 422, "over-receipt");
    const noReason = await call(app, clerk, "POST", `/t/purchases/${poTomatoes}/receipts`, { tenant, idem: true, body: { items: [{ ingredientId: k.ingredientId, quantity: 1, rejectedQuantity: 1 }] } });
    expectStatus(noReason, 422, "rejection needs a reason");

    const g2 = await call(app, clerk, "POST", `/t/purchases/${poTomatoes}/receipts`, { tenant, idem: true, body: {
      supplierInvoice: "A-1002", invoiceAmount: 34.5, items: [{ ingredientId: k.ingredientId, quantity: 3, unitPrice: 10 }] } });
    expectStatus(g2, 201, "GRN 2 at a higher price");
    po = (await call(app, owner, "GET", `/t/purchases/${poTomatoes}`, { tenant })).body;
    assert.equal(po.status, "partially_received");
    assert.equal(po.receipts.length, 2);
    assert.equal(po.receipts[0].invoiceVariance, 7.9, "invoice 70 vs receipt 62.10");
    expectStatus(await call(app, clerk, "POST", `/t/purchases/${poTomatoes}/close`, { tenant, body: { reason: "المورد لا يملك الباقي" } }), 403, "clerk cannot close");
    expectStatus(await call(app, accountant, "POST", `/t/purchases/${poTomatoes}/close`, { tenant, body: { reason: "المورد لا يملك الباقي" } }), 200, "closed short");
    expectStatus(await call(app, clerk, "POST", `/t/purchases/${poTomatoes}/receipts`, { tenant, idem: true, body: { items: [{ ingredientId: k.ingredientId, quantity: 1 }] } }), 409, "closed PO");
    assert.equal((await stockOf(tenant, warehouse, k.ingredientId)).quantity, 9000);

    expectStatus(await call(app, clerk, "POST", `/t/purchases/${poOnions}/receive`, { tenant }), 200, "onions in full");
    assert.equal((await call(app, owner, "GET", `/t/purchases/${poOnions}`, { tenant })).body.status, "received");
    const mism = (await call(app, owner, "GET", "/t/goods-receipts?mismatch=true", { tenant })).body.items;
    assert.ok(mism.some((g: any) => g.supplierInvoice === "A-1001"), "three-way mismatch listed");
  });

  it("4. reorder suggestions: below minimum, net of what is on order, up to the par level", async () => {
    const s = (await call(app, owner, "GET", `/t/purchasing/suggestions?locationId=${warehouse}`, { tenant })).body.items;
    // Onions: 5 kg on hand at the warehouse, min 3 kg → not suggested yet.
    assert.ok(!s.some((x: any) => x.ingredientId === onions));
    const sk = (await call(app, owner, "GET", `/t/purchasing/suggestions?locationId=${k.locationId}`, { tenant })).body.items;
    const o = sk.find((x: any) => x.ingredientId === onions);
    assert.ok(o, "kitchen has none");
    assert.equal(o.suggestedQuantity, 8, "par 8 kg − 0 on hand");
    assert.equal(o.lastPrice, 4);
  });

  it("5. transfer: dispatched (in transit), received short with a reason; the loss is expensed", async () => {
    const t = await call(app, clerk, "POST", "/t/transfers", { tenant, idem: true, body: { fromLocationId: warehouse, toLocationId: k.locationId, items: [{ ingredientId: k.ingredientId, quantity: 2000 }] } });
    expectStatus(t, 201, "transfer");
    expectStatus(await call(app, clerk, "POST", `/t/transfers/${t.body.id}/dispatch`, { tenant }), 200, "dispatch");
    assert.equal((await stockOf(tenant, warehouse, k.ingredientId)).quantity, 7000);
    assert.equal((await stockOf(tenant, k.locationId, k.ingredientId)).quantity, 0, "in transit, not yet in the kitchen");
    const bad = await call(app, clerk, "POST", `/t/transfers/${t.body.id}/receive`, { tenant, body: { items: [{ ingredientId: k.ingredientId, receivedQuantity: 1800 }] } });
    expectStatus(bad, 422, "shortage needs a reason");
    const r = await call(app, clerk, "POST", `/t/transfers/${t.body.id}/receive`, { tenant, body: { items: [{ ingredientId: k.ingredientId, receivedQuantity: 1800, shortageReason: "سقط كيس في السيارة" }] } });
    expectStatus(r, 200, "receive");
    assert.ok(r.body.shortageValue > 0);
    assert.equal((await stockOf(tenant, k.locationId, k.ingredientId)).quantity, 1800);
    const adj = await gl("inventory_adjustment");
    assert.equal(Math.round(adj * 100), Math.round(r.body.shortageValue * 100), "shortage in the ledger");
  });

  it("6. barcode count: carton barcodes, a category cycle count, counted blind by scanner", async () => {
    const dup = await call(app, owner, "POST", `/t/ingredients/${k.ingredientId}/barcodes`, { tenant, body: { barcode: "6281000000017", baseQuantity: 5000, label: "كرتونة 5 كجم" } });
    expectStatus(dup, 201, "carton barcode");
    expectStatus(await call(app, owner, "POST", `/t/ingredients/${onions}/barcodes`, { tenant, body: { barcode: "6281000000017", baseQuantity: 1000 } }), 409, "a code belongs to one item");
    const look = await call(app, clerk, "GET", "/t/barcodes/6281000000017", { tenant });
    assert.deepEqual([look.body.ingredientId, look.body.baseQuantity], [k.ingredientId, 5000]);
    expectStatus(await call(app, clerk, "GET", "/t/barcodes/0000000000", { tenant }), 404, "unknown code");

    const st = await call(app, clerk, "POST", "/t/stocktakes", { tenant, body: { locationId: warehouse, category: "خضار" } });
    expectStatus(st, 201, "cycle count");
    const sheet = (await call(app, clerk, "GET", `/t/stocktakes/${st.body.id}`, { tenant })).body;
    assert.equal(sheet.category, "خضار");
    assert.ok(sheet.items.every((i: any) => i.systemQty === null), "blind count");
    assert.ok(sheet.barcodes.some((b: any) => b.code === "6281000000017" && b.baseQuantity === 5000));
    // The scanner read one carton (5 kg) + 1.5 kg loose: 6.5 kg of tomatoes, onions 5 kg.
    expectStatus(await call(app, clerk, "PUT", `/t/stocktakes/${st.body.id}/counts`, { tenant, body: { scanned: true, items: [
      { ingredientId: k.ingredientId, countedQty: 6500 }, { ingredientId: onions, countedQty: 5000 }] } }), 200, "counts");
    expectStatus(await call(app, clerk, "POST", `/t/stocktakes/${st.body.id}/post`, { tenant }), 403, "the counter does not post");
    const p = await call(app, accountant, "POST", `/t/stocktakes/${st.body.id}/post`, { tenant });
    expectStatus(p, 200, "post");
    assert.ok(p.body.varianceValue < 0, "500 g short");
    assert.equal((await stockOf(tenant, warehouse, k.ingredientId)).quantity, 6500);
  });

  it("7. sale, supplier payment, and the reports a finance head reads", async () => {
    const salad = await createApprovedRecipe(app, owner, tenant, 20, [{ ingredientId: k.ingredientId, quantity: 100 }]);
    const shift = await openShift(app, cashier, tenant, k.locationId);
    expectStatus(await call(app, cashier, "POST", "/t/pos/orders", { tenant, idem: true, body: {
      locationId: k.locationId, shiftId: shift, channel: "takeaway", items: [{ recipeId: salad, quantity: 3 }], payments: [{ method: "cash", amount: 69 }] } }), 201, "sale");
    expectStatus(await call(app, accountant, "POST", "/t/supplier-payments", { tenant, idem: true, body: { supplierId: vatSupplier, amount: 50, method: "bank_transfer", paidOn: today } }), 201, "payment");

    const sp = (await call(app, owner, "GET", `/t/reports/supplier-performance?from=${today}&to=${today}`, { tenant })).body;
    const vs = sp.items.find((x: any) => x.supplierId === vatSupplier);
    assert.equal(vs.receipts, 2);
    assert.equal(vs.priceVariance, 3, "3 kg × 1.00 above the PO price");
    assert.equal(vs.rejectedLines, 1);
    assert.equal(vs.invoiceMismatches, 1);
    assert.equal(vs.onTimePercent, 100);
    const me = (await call(app, owner, "GET", `/t/reports/menu-engineering?from=${today}&to=${today}`, { tenant })).body;
    assert.equal(me.items[0].sold, 3);
    assert.ok(["star", "plowhorse", "puzzle", "dog"].includes(me.items[0].class));
    const turn = (await call(app, owner, "GET", `/t/reports/stock-turnover?from=${today}&to=${today}`, { tenant })).body;
    assert.ok(turn.totals.stockValue > 0 && turn.items.some((i: any) => i.ingredientId === k.ingredientId && i.usedQty === 300));
  });

  it("8. the books agree with the sub-ledgers (inventory, payables, VAT input) and the trial balance balances", async () => {
    const tb = (await call(app, owner, "GET", `/t/accounting/trial-balance?from=2000-01-01&to=${today}`, { tenant })).body;
    assert.equal(tb.totals.closing.debit, tb.totals.closing.credit, "balanced");

    const stock = (await ownerPool.query("SELECT coalesce(sum(quantity * avg_cost), 0)::float8 AS v FROM stock_levels WHERE tenant_id = $1", [tenant])).rows[0].v as number;
    const inv = await gl("inventory");
    assert.ok(Math.abs(inv - stock) < 0.05, `inventory ledger ${inv} vs stock ${stock}`);

    const payables = (await call(app, owner, "GET", "/t/payables", { tenant })).body.totalOwed as number;
    const ap = -(await gl("ap"));
    assert.equal(Math.round(ap * 100), Math.round(payables * 100), `AP ledger ${ap} vs supplier ledger ${payables}`);

    const grnVat = (await ownerPool.query("SELECT coalesce(sum(vat_amount), 0)::float8 AS v FROM goods_receipts WHERE tenant_id = $1", [tenant])).rows[0].v as number;
    assert.equal(Math.round((await gl("vat_input")) * 100), Math.round(grnVat * 100), "VAT input = receipts' VAT");
  });
});
