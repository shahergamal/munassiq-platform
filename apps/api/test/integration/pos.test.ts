import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { decodeQr, GENESIS_HASH } from "../../src/lib/zatca.ts";
import {
  type Actor, type App, addMember, call, code, createApprovedRecipe, createTenant, createUser, expectStatus, openShift, ownerPool, receivePo,
  setupKitchen, startApp, stockOf, stopApp, type Kitchen,
} from "./helpers.ts";

// Stock: 1 kg tomatoes at 0.01 / g. Salad: 100 g tomatoes, 20.00 net → 23.00 with 15% VAT.
describe("point of sale", () => {
  let app: App;
  let owner: Actor;
  let cashier: Actor;
  let tenant: string;
  let k: Kitchen;
  let salad: string;
  let shift: string;

  const order = (items: { recipeId: string; quantity: number }[], total: number, extra: object = {}) => ({
    locationId: k.locationId, shiftId: shift, channel: "takeaway", items, payments: [{ method: "cash", amount: total }], ...extra,
  });
  const sell = (actor: Actor, body: object, idem: string | true = true) => call(app, actor, "POST", "/t/pos/orders", { tenant, idem, body });
  const stock = async () => (await stockOf(tenant, k.locationId, k.ingredientId)).quantity;

  before(async () => {
    app = await startApp();
    owner = await createUser();
    tenant = await createTenant(app, owner, "مطعم نقطة البيع");
    k = await setupKitchen(app, owner, tenant);
    await receivePo(app, owner, tenant, { supplierId: k.supplierId, locationId: k.locationId, items: [{ ingredientId: k.ingredientId, quantity: 1, unitPrice: 10 }] });
    salad = await createApprovedRecipe(app, owner, tenant, 20, [{ ingredientId: k.ingredientId, quantity: 100 }]);
    cashier = await addMember(app, owner, tenant, "cashier");
    shift = await openShift(app, cashier, tenant, k.locationId);
  });
  after(() => stopApp(app));

  let firstOrder: string;

  it("sells with server-side prices, deducts stock, issues a chained invoice with QR (no digest())", async () => {
    const key = randomUUID();
    // Client-supplied prices/totals are ignored: only ids and quantities are read.
    const r = await sell(cashier, order([{ recipeId: salad, quantity: 2, unitPrice: 0.01 } as never], 46, { total: 0.01, vat: 0 }), key);
    expectStatus(r, 201, "sale");
    firstOrder = r.body.id;
    assert.equal(r.body.total, 46);
    assert.equal(r.body.vat, 6);
    assert.equal(r.body.orderNumber, 1);
    assert.equal(await stock(), 800);

    const qr = decodeQr(r.body.qr);
    assert.equal(qr[1], "مطعم نقطة البيع");
    assert.equal(qr[4], "46.00");
    assert.equal(qr[5], "6.00");

    const inv = await ownerPool.query("SELECT kind, icv, previous_hash, integrity_hash FROM e_invoices WHERE order_id = $1", [firstOrder]);
    assert.equal(inv.rows[0].kind, "simplified_invoice");
    assert.equal(Number(inv.rows[0].icv), 1);
    assert.equal(inv.rows[0].previous_hash, GENESIS_HASH);
    assert.match(inv.rows[0].integrity_hash, /^[0-9a-f]{64}$/);

    const o = await ownerPool.query("SELECT cost_total::float8 AS c FROM pos_orders WHERE id = $1", [firstOrder]);
    assert.equal(o.rows[0].c, 2); // 200 g × 0.01

    // Replaying the same Idempotency-Key returns the same order and changes nothing.
    const again = await sell(cashier, order([{ recipeId: salad, quantity: 2 }], 46), key);
    assert.equal(again.status, 200);
    assert.equal(again.body.id, firstOrder);
    assert.equal(await stock(), 800);
    const n = await ownerPool.query("SELECT count(*)::int AS n FROM pos_orders WHERE tenant_id = $1", [tenant]);
    assert.equal(n.rows[0].n, 1);
  });

  it("the same Idempotency-Key sent twice in parallel creates one order", async () => {
    const key = randomUUID();
    const before = await stock();
    const res = await Promise.all([1, 2].map(() => sell(cashier, order([{ recipeId: salad, quantity: 1 }], 23), key)));
    const ok = res.filter((r) => r.status === 201 || r.status === 200);
    assert.ok(ok.length >= 1, JSON.stringify(res.map((r) => r.body)));
    for (const r of res) assert.ok([200, 201, 409].includes(r.status), `${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(await stock(), before - 100);
    const n = await ownerPool.query("SELECT count(*)::int AS n FROM pos_orders WHERE tenant_id = $1 AND idempotency_key = $2", [tenant, key]);
    assert.equal(n.rows[0].n, 1);
  });

  it("rejects a payment that does not match the server total", async () => {
    const before = await stock();
    const r = await sell(cashier, order([{ recipeId: salad, quantity: 2 }], 45));
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, "payment_mismatch");
    assert.deepEqual(r.body.error.details, { expected: 46, received: 45 });
    assert.equal(await stock(), before);
  });

  it("rejects a sale when stock is insufficient, without partial deduction", async () => {
    const before = await stock();
    const r = await sell(cashier, order([{ recipeId: salad, quantity: 50 }], 1150));
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, "insufficient_stock");
    assert.equal(r.body.error.details.required, 5000);
    assert.equal(await stock(), before);
  });

  it("a cashier's discount above the approval limit needs a manager; within it needs a reason", async () => {
    // 20% > 10% default limit
    const over = await sell(cashier, order([{ recipeId: salad, quantity: 1 }], 18.4, { discount: { type: "percent", value: 20 }, discountReason: "عميل دائم" }));
    assert.equal(over.status, 403);
    assert.equal(over.body.error.code, "manager_approval_required");

    const noReason = await sell(cashier, order([{ recipeId: salad, quantity: 1 }], 20.7, { discount: { type: "percent", value: 10 } }));
    assert.equal(noReason.status, 422);

    // 10% of 20.00 = 2.00 → 18.00 + 2.70 VAT = 20.70
    const ok = await sell(cashier, order([{ recipeId: salad, quantity: 1 }], 20.7, { discount: { type: "percent", value: 10 }, discountReason: "عميل دائم" }));
    expectStatus(ok, 201, "discount within limit");

    // The owner may override the limit.
    const owner50 = await sell(owner, order([{ recipeId: salad, quantity: 1 }], 11.5, { discount: { type: "percent", value: 50 }, discountReason: "تعويض عميل" }));
    expectStatus(owner50, 201, "owner override");
  });

  it("refuses recipes that are not approved", async () => {
    const r = await call(app, owner, "POST", "/t/recipes", { tenant, body: { code: code("D"), name: "مسودة", priceNet: 5, items: [{ ingredientId: k.ingredientId, quantity: 1 }] } });
    const s = await sell(cashier, order([{ recipeId: r.body.id, quantity: 1 }], 5.75));
    assert.equal(s.status, 422);
    assert.equal(s.body.error.code, "recipe_unavailable");
  });

  it("a cashier cannot refund; the owner refunds with restock and a chained credit note", async () => {
    const body = { shiftId: shift, amount: 46, method: "cash", reason: "طلب خاطئ", restock: true };
    const c = await call(app, cashier, "POST", `/t/pos/orders/${firstOrder}/refund`, { tenant, idem: true, body });
    assert.equal(c.status, 403);

    const partialRestock = await call(app, owner, "POST", `/t/pos/orders/${firstOrder}/refund`, { tenant, idem: true, body: { ...body, amount: 10 } });
    assert.equal(partialRestock.status, 422);

    const before = await stock();
    const r = await call(app, owner, "POST", `/t/pos/orders/${firstOrder}/refund`, { tenant, idem: true, body });
    expectStatus(r, 201, "refund");
    assert.equal(await stock(), before + 200);

    const again = await call(app, owner, "POST", `/t/pos/orders/${firstOrder}/refund`, { tenant, idem: true, body: { ...body, restock: false, amount: 1 } });
    assert.equal(again.status, 409);

    const detail = await call(app, owner, "GET", `/t/pos/orders/${firstOrder}`, { tenant });
    assert.equal(detail.body.status, "refunded");
    assert.deepEqual(detail.body.invoices.map((i: { kind: string }) => i.kind), ["simplified_invoice", "credit_note"]);

    // The whole per-location chain links: each previous_hash is the prior row's integrity_hash.
    const chain = await ownerPool.query("SELECT icv, previous_hash, integrity_hash FROM e_invoices WHERE tenant_id = $1 AND location_id = $2 ORDER BY icv", [tenant, k.locationId]);
    let prev = GENESIS_HASH;
    for (const [i, row] of chain.rows.entries()) {
      assert.equal(Number(row.icv), i + 1);
      assert.equal(row.previous_hash, prev);
      prev = row.integrity_hash;
    }
    await assert.rejects(ownerPool.query("UPDATE e_invoices SET total = 0 WHERE tenant_id = $1", [tenant]), /append_only_table/);
  });

  it("reports reflect today's sales, refunds, costs and stock value", async () => {
    const accountant = await addMember(app, owner, tenant, "accountant");
    const orders = await ownerPool.query(
      `SELECT count(*)::int AS n, sum(taxable)::float8 AS net, sum(total)::float8 AS total, sum(cost_total)::float8 AS cost
         FROM pos_orders WHERE tenant_id = $1`, [tenant]);
    const daily = await call(app, accountant, "GET", "/t/reports/daily-sales", { tenant });
    expectStatus(daily, 200, "daily sales");
    assert.equal(daily.body.items.length, 1);
    const d = daily.body.items[0];
    assert.equal(d.orders, orders.rows[0].n);
    assert.equal(d.netSales, orders.rows[0].net);
    assert.equal(d.total, orders.rows[0].total);
    assert.equal(d.refunds, 46);
    assert.equal(d.grossProfit, Math.round((orders.rows[0].net - orders.rows[0].cost) * 10000) / 10000);

    const menu = await call(app, accountant, "GET", "/t/reports/menu-profitability", { tenant });
    expectStatus(menu, 200, "menu profitability");
    const row = menu.body.items.find((i: { id: string }) => i.id === salad);
    assert.equal(row.idealCost, 1); // 100 g × 0.01
    assert.equal(row.foodCostPercent, 5);
    assert.ok(row.qtySold >= 5);

    const val = await call(app, accountant, "GET", "/t/reports/stock-valuation", { tenant });
    expectStatus(val, 200, "stock valuation");
    assert.equal(val.body.total, Math.round((await stock()) * 0.01 * 100) / 100);

    assert.equal((await call(app, accountant, "GET", "/t/reports/daily-sales?from=2026-01-01&to=2026-12-31", { tenant })).status, 422, "range cap");
  });

  it("closing the shift reconciles cash", async () => {
    const r = await call(app, cashier, "POST", `/t/pos/shifts/${shift}/close`, { tenant, body: { countedCash: 0 } });
    expectStatus(r, 200, "close");
    const sums = await ownerPool.query(
      `SELECT (SELECT coalesce(sum(amount), 0) FROM pos_payments WHERE shift_id = $1 AND method = 'cash')::float8 AS inn,
              (SELECT coalesce(sum(amount), 0) FROM pos_refunds WHERE shift_id = $1 AND method = 'cash')::float8 AS out`, [shift]);
    const expected = Math.round((100 + sums.rows[0].inn - sums.rows[0].out) * 100) / 100;
    assert.equal(r.body.expectedCash, expected);
    assert.equal(r.body.overShort, -expected);
    const late = await sell(cashier, order([{ recipeId: salad, quantity: 1 }], 23));
    assert.equal(late.body.error.code, "shift_closed");
  });
});
