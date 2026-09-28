import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import {
  type Actor, type App, addMember, call, code, createTenant, createUser, expectStatus, ownerPool, raiseLimits, receivePo, setupKitchen, startApp, stockOf, stopApp, type Kitchen,
} from "./helpers.ts";

// Tomatoes: base g. Warehouse starts with 10 kg at 0.01/g, kitchen with 1 kg at 0.02/g.
describe("inventory operations: transfers, waste, stocktakes", () => {
  let app: App;
  let owner: Actor;
  let tenant: string;
  let k: Kitchen;
  let warehouse: string;

  before(async () => {
    app = await startApp();
    owner = await createUser();
    tenant = await createTenant(app, owner);
    await raiseLimits(tenant);
    k = await setupKitchen(app, owner, tenant);
    warehouse = (await call(app, owner, "POST", "/t/locations", { tenant, body: { code: code("WH"), name: "المستودع", locationType: "warehouse" } })).body.id;
    await receivePo(app, owner, tenant, { supplierId: k.supplierId, locationId: warehouse, items: [{ ingredientId: k.ingredientId, quantity: 10, unitPrice: 10 }] });
    await receivePo(app, owner, tenant, { supplierId: k.supplierId, locationId: k.locationId, items: [{ ingredientId: k.ingredientId, quantity: 1, unitPrice: 20 }] });
  });
  after(() => stopApp(app));

  const transfer = (quantity: number, completeNow = false, idem: string | true = true) => call(app, owner, "POST", "/t/transfers", {
    tenant, idem, body: { fromLocationId: warehouse, toLocationId: k.locationId, items: [{ ingredientId: k.ingredientId, quantity }], completeNow },
  });

  it("a transfer moves stock at source cost and re-averages at the destination", async () => {
    const t = await transfer(3000);
    expectStatus(t, 201, "draft transfer");
    assert.equal((await stockOf(tenant, warehouse, k.ingredientId)).quantity, 10000, "draft moves nothing");
    expectStatus(await call(app, owner, "POST", `/t/transfers/${t.body.id}/complete`, { tenant }), 200, "complete");
    assert.deepEqual(await stockOf(tenant, warehouse, k.ingredientId), { quantity: 7000, avgCost: 0.01 });
    // kitchen: 1000 g × 0.02 + 3000 g × 0.01 = 50 / 4000 g = 0.0125
    assert.deepEqual(await stockOf(tenant, k.locationId, k.ingredientId), { quantity: 4000, avgCost: 0.0125 });
    const mv = await ownerPool.query("SELECT movement_type, quantity::float8 AS q FROM stock_movements WHERE ref_id = $1 ORDER BY movement_type", [t.body.id]);
    assert.deepEqual(mv.rows, [{ movement_type: "transfer_in", q: 3000 }, { movement_type: "transfer_out", q: -3000 }]);
  });

  it("refuses to go negative, rolls back completely, and completes once under concurrency", async () => {
    const big = await transfer(999_999);
    const r = await call(app, owner, "POST", `/t/transfers/${big.body.id}/complete`, { tenant });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, "insufficient_stock");
    assert.equal((await stockOf(tenant, warehouse, k.ingredientId)).quantity, 7000);
    const d = await call(app, owner, "GET", `/t/transfers/${big.body.id}`, { tenant });
    assert.equal(d.body.status, "draft");

    const t = await transfer(1000);
    const res = await Promise.all([1, 2].map(() => call(app, owner, "POST", `/t/transfers/${t.body.id}/complete`, { tenant })));
    assert.deepEqual(res.map((x) => x.status).sort(), [200, 409]);
    assert.equal((await stockOf(tenant, warehouse, k.ingredientId)).quantity, 6000);

    const same = await call(app, owner, "POST", "/t/transfers", { tenant, idem: true, body: { fromLocationId: warehouse, toLocationId: warehouse, items: [{ ingredientId: k.ingredientId, quantity: 1 }] } });
    assert.equal(same.status, 422);
  });

  it("waste writes off at weighted-average cost, is idempotent and can never be edited", async () => {
    const key = randomUUID();
    const body = { locationId: warehouse, reason: "expired", items: [{ ingredientId: k.ingredientId, quantity: 500 }] };
    const w = await call(app, owner, "POST", "/t/waste", { tenant, idem: key, body });
    expectStatus(w, 201, "waste");
    assert.equal(w.body.totalCost, 5); // 500 g × 0.01
    const again = await call(app, owner, "POST", "/t/waste", { tenant, idem: key, body });
    assert.equal(again.status, 200);
    assert.equal(again.body.id, w.body.id);
    assert.equal((await stockOf(tenant, warehouse, k.ingredientId)).quantity, 5500);

    const other = await call(app, owner, "POST", "/t/waste", { tenant, idem: true, body: { ...body, reason: "other" } });
    assert.equal(other.status, 422);
    const tooMuch = await call(app, owner, "POST", "/t/waste", { tenant, idem: true, body: { ...body, items: [{ ingredientId: k.ingredientId, quantity: 1e8 }] } });
    assert.equal(tooMuch.body.error.code, "insufficient_stock");

    await assert.rejects(ownerPool.query("UPDATE waste_records SET total_cost = 0 WHERE id = $1", [w.body.id]), /append_only_table/);
    await assert.rejects(ownerPool.query("DELETE FROM waste_items WHERE waste_id = $1", [w.body.id]), /append_only_table/);
  });

  it("stocktake: blind while counting, one open per location, clerk counts but cannot post", async () => {
    const clerk = await addMember(app, owner, tenant, "inventory_clerk");
    const accountant = await addMember(app, owner, tenant, "accountant");
    const s = await call(app, clerk, "POST", "/t/stocktakes", { tenant, body: { locationId: warehouse } });
    expectStatus(s, 201, "start count");
    const dup = await call(app, clerk, "POST", "/t/stocktakes", { tenant, body: { locationId: warehouse } });
    assert.equal(dup.body.error.code, "count_open");

    const sheet = await call(app, clerk, "GET", `/t/stocktakes/${s.body.id}`, { tenant });
    const line = sheet.body.items.find((i: { ingredientId: string }) => i.ingredientId === k.ingredientId);
    assert.equal(line.systemQty, null, "system quantity hidden while counting");

    // Physical count finds 5 kg where the system says 5.5 kg → 500 g short at 0.01 = −5.00
    expectStatus(await call(app, clerk, "PUT", `/t/stocktakes/${s.body.id}/counts`, { tenant, body: { items: [{ ingredientId: k.ingredientId, countedQty: 5000 }] } }), 200, "counts");
    assert.equal((await call(app, clerk, "POST", `/t/stocktakes/${s.body.id}/post`, { tenant })).status, 403, "segregation of duties");
    const posted = await call(app, accountant, "POST", `/t/stocktakes/${s.body.id}/post`, { tenant });
    expectStatus(posted, 200, "post");
    assert.equal(posted.body.varianceValue, -5);
    assert.equal((await stockOf(tenant, warehouse, k.ingredientId)).quantity, 5000);

    const after = await call(app, owner, "GET", `/t/stocktakes/${s.body.id}`, { tenant });
    const l2 = after.body.items.find((i: { ingredientId: string }) => i.ingredientId === k.ingredientId);
    assert.deepEqual([l2.systemQty, l2.countedQty, l2.variance, l2.varianceValue], [5500, 5000, -500, -5]);
    assert.equal((await call(app, owner, "PUT", `/t/stocktakes/${s.body.id}/counts`, { tenant, body: { items: [] } })).status, 409, "posted counts are frozen");
    assert.equal((await call(app, accountant, "POST", `/t/stocktakes/${s.body.id}/post`, { tenant })).status, 409);

    // Uncounted items are left unchanged: the kitchen still has its balance.
    assert.equal((await stockOf(tenant, k.locationId, k.ingredientId)).quantity, 5000);
  });

  it("reports and the movement ledger reflect every operation", async () => {
    const ledger = await call(app, owner, "GET", `/t/stock/movements?ingredientId=${k.ingredientId}&locationId=${warehouse}`, { tenant });
    expectStatus(ledger, 200);
    const types = ledger.body.items.map((m: { type: string }) => m.type).sort();
    assert.deepEqual([...new Set(types)], ["count_adjustment", "purchase", "transfer_out", "waste"]);

    const all = await call(app, owner, "GET", "/t/ingredients", { tenant });
    const atWh = await call(app, owner, "GET", `/t/ingredients?locationId=${warehouse}`, { tenant });
    const pick = (r: { body: { items: { id: string; stockQty: number }[] } }) => r.body.items.find((i) => i.id === k.ingredientId)!.stockQty;
    assert.equal(pick(all), 10000, "total across locations");
    assert.equal(pick(atWh), 5000, "one location only");

    const waste = await call(app, owner, "GET", "/t/reports/waste-analysis", { tenant });
    assert.equal(waste.body.total, 5);
    assert.equal(waste.body.byReason[0].reason, "expired");
    const variance = await call(app, owner, "GET", "/t/reports/stock-variance", { tenant });
    assert.equal(variance.body.total, -5);

    const stranger = await createUser();
    const t2 = await createTenant(app, stranger);
    const leak = await call(app, stranger, "GET", "/t/transfers", { tenant: t2 });
    assert.equal(leak.body.items.length, 0, "another tenant sees nothing");
  });
});
