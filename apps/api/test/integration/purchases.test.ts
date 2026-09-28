import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import {
  type Actor, type App, addMember, call, code, createApprovedPo, createIngredient, createTenant, createUser, expectStatus, ownerPool,
  raiseLimits, receivePo, setupKitchen, startApp, stockOf, stopApp, type Kitchen,
} from "./helpers.ts";

// Tomatoes: base unit g, bought in kg (1 kg = 1000 g). Costs below are per gram.
describe("purchasing and receiving", () => {
  let app: App;
  let owner: Actor;
  let tenant: string;
  let k: Kitchen;

  before(async () => {
    app = await startApp();
    owner = await createUser();
    tenant = await createTenant(app, owner);
    await raiseLimits(tenant);
    k = await setupKitchen(app, owner, tenant);
  });
  after(() => stopApp(app));

  async function newLocation(): Promise<string> {
    const r = await call(app, owner, "POST", "/t/locations", { tenant, body: { code: code("L"), name: "مستودع", locationType: "warehouse" } });
    expectStatus(r, 201, "location");
    return r.body.id;
  }

  it("landed cost (shipping added, discount subtracted) and moving weighted average", async () => {
    const loc = await newLocation();
    // 10 kg × 10.00 = 100.00 + shipping 20.00 → 120.00 / 10 000 g = 0.012
    const po1 = await receivePo(app, owner, tenant, { supplierId: k.supplierId, locationId: loc, shipping: 20, items: [{ ingredientId: k.ingredientId, quantity: 10, unitPrice: 10 }] });
    assert.deepEqual(await stockOf(tenant, loc, k.ingredientId), { quantity: 10000, avgCost: 0.012 });
    const d1 = await call(app, owner, "GET", `/t/purchases/${po1}`, { tenant });
    assert.equal(d1.body.status, "received");
    assert.equal(d1.body.items[0].receivedUnitCost, 0.012);

    // 10 kg × 20.00 = 200.00 − discount 40.00 → 160.00 / 10 000 g = 0.016 ; average (0.012 + 0.016) / 2 = 0.014
    await receivePo(app, owner, tenant, { supplierId: k.supplierId, locationId: loc, discount: 40, items: [{ ingredientId: k.ingredientId, quantity: 10, unitPrice: 20 }] });
    assert.deepEqual(await stockOf(tenant, loc, k.ingredientId), { quantity: 20000, avgCost: 0.014 });

    const mv = await ownerPool.query(
      "SELECT movement_type, quantity::float8 AS q, unit_cost::float8 AS c FROM stock_movements WHERE tenant_id = $1 AND location_id = $2 ORDER BY created_at",
      [tenant, loc]);
    assert.deepEqual(mv.rows, [{ movement_type: "purchase", q: 10000, c: 0.012 }, { movement_type: "purchase", q: 10000, c: 0.016 }]);
  });

  it("spreads shipping across lines by value, with a manual purchase→base factor", async () => {
    const loc = await newLocation();
    // Cheese: base pcs, bought by the carton of 24 (count ↔ count, so the factor must be given explicitly).
    const cheese = await createIngredient(app, owner, tenant, "جبن", "pcs", "carton", { purchaseToBase: 24 });
    await receivePo(app, owner, tenant, {
      supplierId: k.supplierId, locationId: loc, shipping: 40,
      items: [{ ingredientId: k.ingredientId, quantity: 10, unitPrice: 10 }, { ingredientId: cheese, quantity: 5, unitPrice: 60 }],
    });
    // Values 100 : 300 → shipping 10 : 30. Tomato 110 / 10 000 g = 0.011 ; cheese 330 / 120 pcs = 2.75
    assert.deepEqual(await stockOf(tenant, loc, k.ingredientId), { quantity: 10000, avgCost: 0.011 });
    assert.deepEqual(await stockOf(tenant, loc, cheese), { quantity: 120, avgCost: 2.75 });
  });

  it("two different receipts of the same ingredient in parallel: both applied, average exact", async () => {
    const loc = await newLocation();
    const a = await createApprovedPo(app, owner, tenant, { supplierId: k.supplierId, locationId: loc, items: [{ ingredientId: k.ingredientId, quantity: 10, unitPrice: 10 }] });
    const b = await createApprovedPo(app, owner, tenant, { supplierId: k.supplierId, locationId: loc, items: [{ ingredientId: k.ingredientId, quantity: 30, unitPrice: 20 }] });
    const res = await Promise.all([a, b].map((id) => call(app, owner, "POST", `/t/purchases/${id}/receive`, { tenant })));
    assert.deepEqual(res.map((r) => r.status), [200, 200]);
    // (10 000 × 0.01 + 30 000 × 0.02) / 40 000 = 0.0175
    assert.deepEqual(await stockOf(tenant, loc, k.ingredientId), { quantity: 40000, avgCost: 0.0175 });
  });

  it("the same order received twice in parallel adds stock only once", async () => {
    const loc = await newLocation();
    const id = await createApprovedPo(app, owner, tenant, { supplierId: k.supplierId, locationId: loc, items: [{ ingredientId: k.ingredientId, quantity: 2, unitPrice: 10 }] });
    const res = await Promise.all([1, 2].map(() => call(app, owner, "POST", `/t/purchases/${id}/receive`, { tenant })));
    assert.deepEqual(res.map((r) => r.status).sort(), [200, 409]);
    assert.equal((await stockOf(tenant, loc, k.ingredientId)).quantity, 2000);
    const n = await ownerPool.query("SELECT count(*)::int AS n FROM stock_movements m JOIN goods_receipts g ON g.id = m.ref_id WHERE g.purchase_order_id = $1", [id]);
    assert.equal(n.rows[0].n, 1);
    const grns = await ownerPool.query("SELECT count(*)::int AS n FROM goods_receipts WHERE purchase_order_id = $1", [id]);
    assert.equal(grns.rows[0].n, 1, "one receipt note");
  });

  it("cannot receive a draft; Idempotency-Key replays return the same order", async () => {
    const key = randomUUID();
    const body = { supplierId: k.supplierId, locationId: k.locationId, items: [{ ingredientId: k.ingredientId, quantity: 1, unitPrice: 5 }] };
    const first = await call(app, owner, "POST", "/t/purchases", { tenant, idem: key, body });
    const again = await call(app, owner, "POST", "/t/purchases", { tenant, idem: key, body });
    assert.equal(first.status, 201);
    assert.equal(again.status, 200);
    assert.equal(again.body.id, first.body.id);
    assert.equal((await call(app, owner, "POST", "/t/purchases", { tenant, body })).body.error.code, "idempotency_key_required");

    const r = await call(app, owner, "POST", `/t/purchases/${first.body.id}/receive`, { tenant });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, "invalid_state");
  });

  it("segregation of duties: a manager cannot approve their own order; an accountant can", async () => {
    const manager = await addMember(app, owner, tenant, "manager");
    const accountant = await addMember(app, owner, tenant, "accountant");
    const clerk = await addMember(app, owner, tenant, "inventory_clerk");
    const po = await call(app, manager, "POST", "/t/purchases", {
      tenant, idem: true, body: { supplierId: k.supplierId, locationId: k.locationId, items: [{ ingredientId: k.ingredientId, quantity: 1, unitPrice: 5 }] },
    });
    expectStatus(po, 201);
    assert.equal((await call(app, manager, "POST", `/t/purchases/${po.body.id}/approve`, { tenant })).status, 403);
    assert.equal((await call(app, clerk, "POST", `/t/purchases/${po.body.id}/approve`, { tenant })).status, 403);
    expectStatus(await call(app, accountant, "POST", `/t/purchases/${po.body.id}/approve`, { tenant }), 200, "accountant approves");
    assert.equal((await call(app, accountant, "POST", `/t/purchases/${po.body.id}/receive`, { tenant })).status, 403);
    expectStatus(await call(app, clerk, "POST", `/t/purchases/${po.body.id}/receive`, { tenant }), 200, "clerk receives");
  });
});
