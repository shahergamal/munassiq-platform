import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { call, code, createFactory, createIngredient, createUser, expectStatus, isoToday, raiseLimits, receivePo, startApp, stopApp, type Actor, type App } from "./helpers.ts";

const day = (n: number) => new Date(Date.parse(`${isoToday()}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// Manufacturing M4 (docs/manufacturing/ARCHITECTURE.md): MRP from a sales order through a three-level BOM, the
// suggestions converted to draft orders, a second run that counts those drafts, and the finite-capacity schedule.
describe("planning", () => {
  let app: App;
  let owner: Actor;
  let t: string;
  let floor: string;
  let supplier: string;
  let F: string; let S: string; let A: string; let P: string;
  let oven: string;

  const post = async (url: string, body: object = {}, status = 201) => {
    const r = await call(app, owner, "POST", url, { tenant: t, idem: true, body });
    expectStatus(r, status, url);
    return r.body;
  };

  before(async () => {
    app = await startApp();
    owner = await createUser();
    t = await createFactory(app, owner);
    await raiseLimits(t);
    floor = (await post("/t/locations", { code: code("PR"), name: "صالة الإنتاج", locationType: "kitchen" })).id;
    supplier = (await post("/t/suppliers", { code: code("S"), name: "مورد" })).id;
    A = await createIngredient(app, owner, t, "دقيق", "kg", "kg", { leadTimeDays: 7 });
    P = await createIngredient(app, owner, t, "كرتون", "pcs", "pcs", { itemType: "packaging", leadTimeDays: 3 });
    S = await createIngredient(app, owner, t, "بسكويت سائب", "pcs", "pcs", { itemType: "semi_finished", leadTimeDays: 1 });
    F = await createIngredient(app, owner, t, "علبة بسكويت", "pcs", "pcs", { itemType: "finished", salePrice: 10, leadTimeDays: 1 });
    // Enough flour for the minimum only; cartons in stock; nothing made yet.
    await receivePo(app, owner, t, { supplierId: supplier, locationId: floor, items: [{ ingredientId: A, quantity: 5, unitPrice: 2 }, { ingredientId: P, quantity: 30, unitPrice: 1 }] });
    oven = (await post("/t/work-centers", { code: code("OV"), name: "الفرن", hoursPerDay: 8, laborRate: 30, overheadRate: 20 })).id;
    // Box ← 12 biscuits + 1 carton; 100 biscuits ← 4 kg flour (biscuits made in the oven, 240 min a batch).
    const bS = (await post("/t/boms", { itemId: S, quantity: 100, lines: [{ componentId: A, quantity: 4 }], operations: [{ name: "خبز", workCenterId: oven, runMinutes: 240 }] })).id;
    await post(`/t/boms/${bS}/activate`, {}, 200);
    const bF = (await post("/t/boms", { itemId: F, quantity: 1, lines: [{ componentId: S, quantity: 12 }, { componentId: P, quantity: 1 }], operations: [{ name: "تعبئة", workCenterId: oven, runMinutes: 1 }] })).id;
    await post(`/t/boms/${bF}/activate`, {}, 200);
    const cust = (await post("/t/customers", { name: "موزع", phone: `05${Math.floor(10000000 + Math.random() * 89999999)}` })).id;
    const so = (await post("/t/sales-orders", { customerId: cust, locationId: floor, deliveryDate: day(30), lines: [{ itemId: F, quantity: 50 }] })).id;
    await post(`/t/sales-orders/${so}/confirm`, { backorder: true }, 200);
  });
  after(() => stopApp(app));

  const latest = async () => (await call(app, owner, "GET", "/t/mrp/runs/latest", { tenant: t })).body;
  const open = (x: { suggestions: { status: string; itemId: string; kind: string; quantity: number; orderDate: string; needDate: string }[] }, id: string) =>
    x.suggestions.filter((s) => s.status === "open" && s.itemId === id);

  it("MRP explodes a sales order through three levels, net of stock, dated by lead times", async () => {
    const run = await post("/t/mrp/runs", { safetyStock: false });
    assert.equal(run.summary.make, 2);
    const x = await latest();
    // 50 boxes to make; 600 biscuits; 24 kg flour (5 on hand → 19 to buy); cartons: 50 needed, 30 on hand → 20.
    assert.deepEqual(open(x, F).map((s) => [s.kind, s.quantity, s.needDate, s.orderDate]), [["make", 50, day(30), day(29)]]);
    assert.deepEqual(open(x, S).map((s) => [s.kind, s.quantity, s.orderDate]), [["make", 600, day(28)]]);
    assert.deepEqual(open(x, A).map((s) => [s.kind, s.quantity, s.orderDate]), [["buy", 19, day(21)]]);
    assert.deepEqual(open(x, P).map((s) => [s.kind, s.quantity, s.orderDate]), [["buy", 20, day(26)]]);
  });

  it("suggestions become draft orders, and the next run counts them instead of suggesting again", async () => {
    const x = await latest();
    const ids = x.suggestions.filter((s: { status: string }) => s.status === "open").map((s: { id: string }) => s.id);
    const missing = await call(app, owner, "POST", "/t/mrp/suggestions/convert", { tenant: t, body: { ids } });
    assert.equal(missing.status, 422, "locations are required");
    const conv = await call(app, owner, "POST", "/t/mrp/suggestions/convert", { tenant: t, body: { ids, productionLocationId: floor, receivingLocationId: floor } });
    expectStatus(conv, 200, "convert");
    assert.deepEqual(conv.body.created.map((c: { kind: string }) => c.kind).sort(), ["mo", "mo", "po"], "two production orders and one purchase order for the supplier");
    const po = conv.body.created.find((c: { kind: string }) => c.kind === "po");
    const detail = await call(app, owner, "GET", `/t/purchases/${po.id}`, { tenant: t });
    assert.equal(detail.body.status, "draft");
    assert.equal(detail.body.items.length, 2);
    await post("/t/mrp/runs", { safetyStock: false });
    const again = await latest();
    assert.equal(again.suggestions.filter((s: { status: string }) => s.status === "open").length, 0, "drafts are supply now");
    const twice = await call(app, owner, "POST", "/t/mrp/suggestions/convert", { tenant: t, body: { ids, productionLocationId: floor, receivingLocationId: floor } });
    assert.equal(twice.status, 409);
  });

  it("the schedule queues the drafts on the oven by due date", async () => {
    const r = await call(app, owner, "GET", "/t/production/schedule", { tenant: t });
    expectStatus(r, 200, "schedule");
    assert.equal(r.body.orders.length, 2);
    const ovenOps = r.body.operations.filter((o: { workCenterId: string }) => o.workCenterId === oven);
    // Biscuits: 600 / 100 × 240 = 1440 min = 3 oven days; the boxes wait for them... biscuits due first (earlier due date).
    const biscuits = ovenOps.find((o: { name: string }) => o.name === "خبز");
    assert.equal(Math.round((biscuits.end - biscuits.start) * 100) / 100, 3);
    // Released on its planned start (the MRP order date), not before.
    assert.equal(biscuits.startDate, day(28));
    assert.equal(r.body.load[oven][0], 0);
    assert.equal(r.body.load[oven][28], 480);
  });
});
