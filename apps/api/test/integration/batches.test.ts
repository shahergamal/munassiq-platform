import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  type Actor, type App, call, code, createApprovedPo, createApprovedRecipe, createIngredient, createTenant, createUser, expectStatus, isoToday, openShift, ownerPool,
  raiseLimits, setupKitchen, startApp, stopApp, type Kitchen,
} from "./helpers.ts";

const plus = (days: number) => new Date(Date.parse(`${isoToday()}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Batch and expiry tracking, end to end: received with the supplier's label, carried by a transfer, sold first-expiry-
 * first, an expired lot disposed of by name, stock from before tracking registered, a count and a production run.
 * After every step the batches of a location never hold more than its stock.
 */
describe("batches & expiry (FEFO)", () => {
  let app: App;
  let owner: Actor;
  let tenant: string;
  let k: Kitchen;
  let warehouse: string;
  let meat: string;
  let po: string;
  let grn1: string;
  let lotA: string;
  const batchesOf = async (locationId: string, ingredientId: string) =>
    (await call(app, owner, "GET", `/t/stock/batches?locationId=${locationId}&ingredientId=${ingredientId}&pageSize=50`, { tenant })).body.items as
      { id: string; batchNo: string; expiryDate: string | null; remaining: number; sourceType: string; daysLeft: number | null }[];
  const invariant = async () => {
    const r = await ownerPool.query(
      `SELECT * FROM (SELECT sl.location_id, sl.ingredient_id, sl.quantity::float8 AS q,
                (SELECT coalesce(sum(b.remaining), 0) FROM stock_batches b WHERE b.location_id = sl.location_id AND b.ingredient_id = sl.ingredient_id)::float8 AS b
           FROM stock_levels sl WHERE sl.tenant_id = $1) x WHERE x.b > x.q + 0.0001`, [tenant]);
    assert.equal(r.rowCount, 0, `batches exceed stock: ${JSON.stringify(r.rows)}`);
  };

  before(async () => {
    app = await startApp();
    owner = await createUser({ name: "مدير المخزون" });
    tenant = await createTenant(app, owner, "مطعم الصلاحية");
    await raiseLimits(tenant);
    k = await setupKitchen(app, owner, tenant);
    warehouse = (await call(app, owner, "POST", "/t/locations", { tenant, body: { code: code("W"), name: "المستودع", locationType: "warehouse" } })).body.id;
    meat = await createIngredient(app, owner, tenant, "لحم مفروم", "g", "kg", { trackExpiry: true });
    po = await createApprovedPo(app, owner, tenant, { supplierId: k.supplierId, locationId: warehouse, items: [{ ingredientId: meat, quantity: 10, unitPrice: 30 }] });
  });
  after(() => stopApp(app));

  it("receiving a tracked item needs a valid expiry; each delivery becomes a dated batch", async () => {
    const noDate = await call(app, owner, "POST", `/t/purchases/${po}/receipts`, { tenant, idem: true, body: { items: [{ ingredientId: meat, quantity: 4 }] } });
    expectStatus(noDate, 422, "expiry required");
    assert.equal(noDate.body.error.code, "expiry_required");
    const past = await call(app, owner, "POST", `/t/purchases/${po}/receipts`, { tenant, idem: true, body: { items: [{ ingredientId: meat, quantity: 4, expiryDate: plus(-1) }] } });
    assert.equal(past.body.error.code, "expired_on_receipt");
    expectStatus(await call(app, owner, "POST", `/t/purchases/${po}/receive`, { tenant }), 422, "one-click receive cannot guess the date");

    const r1 = await call(app, owner, "POST", `/t/purchases/${po}/receipts`, { tenant, idem: true, body: { items: [{ ingredientId: meat, quantity: 4, batchNo: "L-A", expiryDate: plus(2), productionDate: plus(-3) }] } });
    expectStatus(r1, 201, "GRN 1");
    grn1 = r1.body.id;
    expectStatus(await call(app, owner, "POST", `/t/purchases/${po}/receipts`, { tenant, idem: true, body: { items: [{ ingredientId: meat, quantity: 6, batchNo: "L-B", expiryDate: plus(10) }] } }), 201, "GRN 2");

    const bs = await batchesOf(warehouse, meat);
    assert.deepEqual(bs.map((b) => [b.batchNo, b.remaining, b.daysLeft]), [["L-A", 4000, 2], ["L-B", 6000, 10]], "first expiry first");
    lotA = bs[0]!.id;
    const grn = (await call(app, owner, "GET", `/t/goods-receipts/${grn1}`, { tenant })).body;
    assert.deepEqual([grn.items[0].batchNo, grn.items[0].expiryDate], ["L-A", plus(2)], "the GRN keeps the label");

    const sum = (await call(app, owner, "GET", "/t/stock/batches/summary?days=7", { tenant })).body;
    assert.deepEqual([sum.expiring.count, sum.expiring.value, sum.expired.count], [1, 120, 0], "4 kg at 30/kg expire within a week");
    await invariant();
  });

  it("a transfer takes the earliest batches and they arrive with their dates; a shortage is not a dated batch", async () => {
    const t = await call(app, owner, "POST", "/t/transfers", { tenant, idem: true, body: { fromLocationId: warehouse, toLocationId: k.locationId, items: [{ ingredientId: meat, quantity: 5000 }] } });
    expectStatus(t, 201, "transfer");
    expectStatus(await call(app, owner, "POST", `/t/transfers/${t.body.id}/dispatch`, { tenant }), 200, "dispatch");
    const r = await call(app, owner, "POST", `/t/transfers/${t.body.id}/receive`, { tenant, body: { items: [{ ingredientId: meat, receivedQuantity: 4800, shortageReason: "كيس ممزق" }] } });
    expectStatus(r, 200, "receive");
    assert.deepEqual((await batchesOf(warehouse, meat)).map((b) => [b.batchNo, b.remaining]), [["L-B", 5000]], "warehouse keeps the later lot");
    const kb = await batchesOf(k.locationId, meat);
    assert.deepEqual(kb.map((b) => [b.batchNo, b.remaining, b.expiryDate, b.sourceType]), [["L-A", 4000, plus(2), "transfer"], ["L-B", 800, plus(10), "transfer"]]);
    const trace = (await call(app, owner, "GET", `/t/stock/batches/${lotA}`, { tenant })).body;
    assert.equal(trace.sourceRef.startsWith("GRN-"), true, "traced to its receipt");
    assert.equal(trace.children.length, 1, "and to where it went");
    assert.equal(trace.remaining, 0);
    await invariant();
  });

  it("a sale consumes the earliest expiry; a disposal names its lot", async () => {
    const recipe = await createApprovedRecipe(app, owner, tenant, 40, [{ ingredientId: meat, quantity: 1000 }]);
    const shift = await openShift(app, owner, tenant, k.locationId);
    const sale = await call(app, owner, "POST", "/t/pos/orders", { tenant, idem: true, body: {
      locationId: k.locationId, shiftId: shift, channel: "takeaway", items: [{ recipeId: recipe, quantity: 1 }], payments: [{ method: "cash", amount: 46 }] } });
    expectStatus(sale, 201, "sale");
    let kb = await batchesOf(k.locationId, meat);
    assert.deepEqual(kb.map((b) => [b.batchNo, b.remaining]), [["L-A", 3000], ["L-B", 800]], "sold from the lot that expires first");

    const lotB = kb.find((b) => b.batchNo === "L-B")!;
    const w = await call(app, owner, "POST", "/t/waste", { tenant, idem: true, body: { locationId: k.locationId, reason: "expired", items: [{ ingredientId: meat, quantity: 800, batchId: lotB.id }] } });
    expectStatus(w, 201, "dispose lot B");
    kb = await batchesOf(k.locationId, meat);
    assert.deepEqual(kb.map((b) => [b.batchNo, b.remaining]), [["L-A", 3000]], "only the named lot left");
    const tooMuch = await call(app, owner, "POST", "/t/waste", { tenant, idem: true, body: { locationId: k.locationId, reason: "expired", items: [{ ingredientId: meat, quantity: 5000, batchId: kb[0]!.id }] } });
    assert.equal(tooMuch.body.error.code, "batch_insufficient");
    await invariant();
  });

  it("stock from before tracking can be registered as a batch, never more than the stock without one; a count trims batches", async () => {
    const tomPo = await createApprovedPo(app, owner, tenant, { supplierId: k.supplierId, locationId: k.locationId, items: [{ ingredientId: k.ingredientId, quantity: 2, unitPrice: 5 }] });
    expectStatus(await call(app, owner, "POST", `/t/purchases/${tomPo}/receive`, { tenant }), 200, "untracked item, no date needed");
    assert.equal((await batchesOf(k.locationId, k.ingredientId)).length, 0);
    const over = await call(app, owner, "POST", "/t/stock/batches", { tenant, body: { locationId: k.locationId, ingredientId: k.ingredientId, batchNo: "OLD", expiryDate: plus(5), quantity: 3000 } });
    assert.equal(over.body.error.code, "exceeds_unbatched");
    expectStatus(await call(app, owner, "POST", "/t/stock/batches", { tenant, body: { locationId: k.locationId, ingredientId: k.ingredientId, batchNo: "OLD", expiryDate: plus(5), quantity: 1500 } }), 201, "opening batch");

    const st = await call(app, owner, "POST", "/t/stocktakes", { tenant, body: { locationId: k.locationId } });
    expectStatus(st, 201, "stocktake");
    expectStatus(await call(app, owner, "PUT", `/t/stocktakes/${st.body.id}/counts`, { tenant, body: { items: [{ ingredientId: k.ingredientId, countedQty: 1000 }] } }), 200, "count");
    expectStatus(await call(app, owner, "POST", `/t/stocktakes/${st.body.id}/post`, { tenant }), 200, "post");
    assert.deepEqual((await batchesOf(k.locationId, k.ingredientId)).map((b) => b.remaining), [1000], "the count loss comes out of the unbatched stock first, then the batch");
    await invariant();
  });

  it("a production run makes a batch that expires no later than its earliest input", async () => {
    const g = (await call(app, owner, "GET", "/t/units", { tenant })).body.items.find((u: { code: string }) => u.code === "g").id;
    const p = await call(app, owner, "POST", "/t/prep-recipes", { tenant, body: { name: "صلصة طماطم", unitId: g, batchYield: 400, items: [{ ingredientId: k.ingredientId, quantity: 500 }] } });
    expectStatus(p, 201, "prep recipe");
    const sauce = (await ownerPool.query("SELECT ingredient_id FROM prep_recipes WHERE id = $1", [p.body.id])).rows[0].ingredient_id as string;
    expectStatus(await call(app, owner, "PATCH", `/t/ingredients/${sauce}`, { tenant, body: { trackExpiry: true, shelfLifeDays: 30 } }), 200, "shelf life");
    expectStatus(await call(app, owner, "POST", `/t/prep-recipes/${p.body.id}/produce`, { tenant, idem: true, body: { locationId: k.locationId, batches: 1 } }), 201, "produce");
    const sb = await batchesOf(k.locationId, sauce);
    assert.equal(sb.length, 1);
    assert.equal(sb[0]!.expiryDate, plus(5), "capped by the tomatoes' expiry, not 30 days");
    assert.equal(sb[0]!.sourceType, "production");
    await invariant();
  });

  it("a batch can only be consumed: its remainder never grows and it is never deleted", async () => {
    await assert.rejects(ownerPool.query("UPDATE stock_batches SET remaining = quantity WHERE id = $1", [lotA]), /cannot grow back/);
    await assert.rejects(ownerPool.query("DELETE FROM stock_batches WHERE id = $1", [lotA]), /never deleted/);
    await assert.rejects(ownerPool.query("UPDATE stock_batches SET expiry_date = expiry_date + 30 WHERE id = $1", [lotA]), /only be consumed/);
  });
});
