import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { setGatewayTransport, type Transport } from "../../src/lib/payments/gateways.ts";
import {
  type Actor, type App, addMember, call, createApprovedRecipe, createTenant, createUser, expectStatus, openShift, ownerPool, receivePo, setupKitchen, startApp, stockOf, stopApp, type Kitchen,
} from "./helpers.ts";

const KEY = "sk_test_posMoyasar12345678";

/** A stand-in Moyasar: it opens invoices and reports whatever status the test sets. */
const pages = new Map<string, { amount: number; status: string }>();
const transport: Transport = async (_provider, method, path, key, body: any) => {
  if (key !== KEY) return { status: 401, body: { message: "Invalid authorization credentials" } };
  if (method === "GET" && path.startsWith("/invoices?")) return { status: 200, body: { invoices: [] } };
  if (method === "POST" && path === "/invoices") {
    const id = `inv_${randomUUID().replace(/-/g, "")}`;
    pages.set(id, { amount: body.amount, status: "initiated" });
    return { status: 201, body: { id, status: "initiated", amount: body.amount, currency: "SAR", url: `https://checkout.moyasar.com/invoices/${id}` } };
  }
  const p = pages.get(path.replace("/invoices/", ""));
  if (!p) return { status: 404, body: { message: "Object not found" } };
  return { status: 200, body: { status: p.status, amount: p.amount, currency: "SAR", payments: p.status === "paid" ? [{ id: "pay_pos1", status: "paid" }] : [] } };
};

// Stock: 1 kg tomatoes. Salad: 100 g, 20.00 net → 23.00 with VAT.
describe("paying at the till through the workspace's gateway (QR on screen)", () => {
  let app: App;
  let owner: Actor;
  let cashier: Actor;
  let tenant: string;
  let k: Kitchen;
  let salad: string;
  let shift: string;

  const cart = (quantity: number) => ({ locationId: k.locationId, shiftId: shift, channel: "takeaway", items: [{ recipeId: salad, quantity }], provider: "moyasar" });
  const start = (quantity: number) => call(app, cashier, "POST", "/t/pos/online-payments", { tenant, idem: true, body: cart(quantity) });
  const check = (id: string) => call(app, cashier, "POST", `/t/pos/online-payments/${id}/check`, { tenant });
  const payAtGateway = (url: string) => { pages.get(url.split("/").at(-1)!)!.status = "paid"; };
  const stock = async () => (await stockOf(tenant, k.locationId, k.ingredientId)).quantity;
  const orders = async () => (await ownerPool.query("SELECT count(*)::int AS n FROM pos_orders WHERE tenant_id = $1", [tenant])).rows[0].n as number;

  before(async () => {
    setGatewayTransport(transport);
    app = await startApp();
    owner = await createUser();
    tenant = await createTenant(app, owner, "مطعم الدفع بالكاشير");
    k = await setupKitchen(app, owner, tenant);
    await receivePo(app, owner, tenant, { supplierId: k.supplierId, locationId: k.locationId, items: [{ ingredientId: k.ingredientId, quantity: 1, unitPrice: 10 }] });
    salad = await createApprovedRecipe(app, owner, tenant, 20, [{ ingredientId: k.ingredientId, quantity: 100 }]);
    cashier = await addMember(app, owner, tenant, "cashier");
    shift = await openShift(app, cashier, tenant, k.locationId);
  });
  after(async () => { setGatewayTransport(null); await stopApp(app); });

  it("the till offers only connected gateways, and nothing is sold before the gateway confirms", async () => {
    assert.deepEqual((await call(app, cashier, "GET", "/t/pos/online-payments/providers", { tenant })).body.items, []);
    expectStatus(await start(1), 409, "no gateway");
    expectStatus(await call(app, owner, "PUT", "/t/payments/connections/moyasar", { tenant, body: { secretKey: KEY } }), 200, "connect");
    assert.deepEqual((await call(app, cashier, "GET", "/t/pos/online-payments/providers", { tenant })).body.items, [{ provider: "moyasar", mode: "test" }]);

    const i = await start(2);
    expectStatus(i, 201, "start");
    assert.equal(i.body.amount, 46, "the server's total");
    assert.equal(i.body.status, "pending");
    assert.equal(await stock(), 1000, "the dry run was rolled back");
    assert.equal(await orders(), 0);
    assert.equal((await check(i.body.id)).body.status, "pending");

    // The customer pays; the gateway's webhook names the invoice, the server re-reads it and records the sale once.
    payAtGateway(i.body.url);
    const token = (await ownerPool.query("SELECT webhook_token FROM payment_connections WHERE tenant_id = $1", [tenant])).rows[0].webhook_token;
    const ref = i.body.url.split("/").at(-1);
    for (let n = 0; n < 2; n++) {
      const hook = await app.inject({ method: "POST", url: `/api/v1/webhooks/payments/${tenant}/moyasar/${token}`, payload: { id: ref } });
      assert.equal(hook.statusCode, 200, hook.body);
    }
    const done = await check(i.body.id);
    expectStatus(done, 200, "check");
    assert.equal(done.body.status, "paid");
    assert.equal(done.body.sale.total, 46);
    assert.ok(done.body.sale.qr, "the invoice QR for the receipt");
    assert.equal(await orders(), 1, "one order despite webhook + check");
    assert.equal(await stock(), 800);
    const pay = (await ownerPool.query("SELECT method, amount::float8 AS amount FROM pos_payments WHERE order_id = $1", [done.body.sale.id])).rows;
    assert.deepEqual(pay, [{ method: "online", amount: 46 }]);
    const clearing = (await call(app, owner, "GET", "/t/accounts", { tenant })).body.items.find((a: any) => a.systemKey === "gateway_clearing");
    assert.equal(clearing.netDebit, 46, "Dr gateway clearing");
  });

  it("a cart the till could not sell is refused before the customer is asked to pay", async () => {
    const r = await start(9); // 900 g needed, 800 g left
    expectStatus(r, 409, "insufficient stock");
    assert.equal(r.body.error.code, "insufficient_stock");
    expect(await call(app, cashier, "POST", "/t/pos/online-payments", { tenant, idem: true, body: { ...cart(1), platformId: randomUUID(), channel: "delivery" } }), 422);
  });

  it("canceled at the till, paid anyway: flagged for a manager, never sold", async () => {
    const i = await start(1);
    const c = await call(app, cashier, "POST", `/t/pos/online-payments/${i.body.id}/cancel`, { tenant });
    assert.equal(c.body.status, "canceled");
    payAtGateway(i.body.url);
    const late = await check(i.body.id);
    assert.equal(late.body.status, "paid_after_cancel");
    assert.equal(await orders(), 1);
  });

  it("paid but the stock ran out meanwhile: kept as paid-unfulfilled with the reason", async () => {
    const i = await start(8); // 800 g: fits now
    expectStatus(i, 201, "start");
    const cash = await call(app, cashier, "POST", "/t/pos/orders", { tenant, idem: true, body: { locationId: k.locationId, shiftId: shift, channel: "takeaway", items: [{ recipeId: salad, quantity: 1 }], payments: [{ method: "cash", amount: 23 }] } });
    expectStatus(cash, 201, "cash sale takes 100 g");
    payAtGateway(i.body.url);
    const r = await check(i.body.id);
    assert.equal(r.body.status, "paid_unfulfilled");
    assert.match(r.body.failure, /تم الدفع ولم يُسجَّل البيع/);
    const attention = (await call(app, owner, "GET", "/t/pos/online-payments?status=attention", { tenant })).body.items.map((x: any) => x.status).sort();
    assert.deepEqual(attention, ["paid_after_cancel", "paid_unfulfilled"]);
  });
});

function expect(res: { status: number; body: unknown }, status: number) {
  assert.equal(res.status, status, JSON.stringify(res.body));
}
