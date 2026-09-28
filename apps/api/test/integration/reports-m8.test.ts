import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { after, before, describe, it } from "node:test";
import { call, code, createFactory, createIngredient, createUser, expectStatus, isoToday, raiseLimits, receivePo, startApp, stopApp, type Actor, type App } from "./helpers.ts";

// M8 reports: one order (100 ordered, 90 good + 10 scrapped, 80 minutes worked against 60 planned) and a two-hour
// breakdown on the oven give hand-checkable production, cost and OEE figures.
describe("production and OEE reports", () => {
  let app: App;
  let owner: Actor;
  let t: string;
  let mo: string;
  let oven: string;
  const today = isoToday();

  const post = async (url: string, body: object = {}, status = 201) => {
    const r = await call(app, owner, "POST", url, { tenant: t, idem: true, body });
    expectStatus(r, status, url);
    return r.body;
  };
  const get = async (url: string) => { const r = await call(app, owner, "GET", url, { tenant: t }); expectStatus(r, 200, url); return r.body; };

  before(async () => {
    app = await startApp();
    owner = await createUser();
    t = await createFactory(app, owner);
    await raiseLimits(t);
    const floor = (await post("/t/locations", { code: code("PR"), name: "صالة الإنتاج", locationType: "warehouse" })).id;
    const sup = (await post("/t/suppliers", { code: code("S"), name: "مورد" })).id;
    const A = await createIngredient(app, owner, t, "دقيق", "kg", "kg");
    const F = await createIngredient(app, owner, t, "خبز", "pcs", "pcs", { itemType: "finished" });
    await receivePo(app, owner, t, { supplierId: sup, locationId: floor, items: [{ ingredientId: A, quantity: 100, unitPrice: 2 }] });
    oven = (await post("/t/work-centers", { code: code("OV"), name: "الفرن", hoursPerDay: 8, laborRate: 60, overheadRate: 0 })).id;
    const bom = (await post("/t/boms", { itemId: F, quantity: 100, lines: [{ componentId: A, quantity: 50 }], operations: [{ name: "خبز", workCenterId: oven, runMinutes: 60 }] })).id;
    await post(`/t/boms/${bom}/activate`, {}, 200);
    mo = (await post("/t/manufacturing-orders", { itemId: F, quantity: 100, locationId: floor, outputLocationId: floor })).id;
    await post(`/t/manufacturing-orders/${mo}/confirm`, {}, 200);
    await post(`/t/manufacturing-orders/${mo}/issue`, { remaining: true });
    await post(`/t/manufacturing-orders/${mo}/labor`, { seq: 1, minutes: 80 });
    await post(`/t/manufacturing-orders/${mo}/produce`, { quantity: 90, scrapQuantity: 10, scrapReason: "احتراق" });
    await post(`/t/manufacturing-orders/${mo}/close`);
    const m = (await post("/t/machines", { code: code("M"), name: "الفرن 1", workCenterId: oven })).id;
    const wo = (await post("/t/maintenance/orders", { machineId: m, kind: "corrective", description: "تعطل الحراق", failedAt: new Date(Date.now() - 3 * 3_600_000).toISOString() })).id;
    await post(`/t/maintenance/orders/${wo}/complete`, { downtimeMinutes: 120 }, 200);
  });
  after(() => stopApp(app));

  it("production: made, scrap and yield per order; the closed order's actual cost agrees with its page", async () => {
    const r = await get(`/t/reports/production?from=${today}&to=${today}`);
    const o = r.orders.find((x: { moId: string }) => x.moId === mo);
    assert.deepEqual([o.made, o.scrap, o.yield], [90, 10, 0.9]);
    const d = await get(`/t/manufacturing-orders/${mo}`);
    assert.equal(o.closed.variance, d.costs.variance);
    assert.deepEqual([o.closed.price, o.closed.usage, o.closed.efficiency], [d.costs.price, d.costs.usage, d.costs.efficiency]);
    assert.equal(o.closed.actualValue, Math.round((d.costs.standardForOutput + d.costs.variance) * 100) / 100);
    assert.equal(r.items[0].made, 90);
    assert.equal(r.totals.closed, 1);
  });

  it("OEE: 480 planned − 120 down; 54 standard minutes in 80 worked; 90 good of 100", async () => {
    const r = await get(`/t/reports/oee?from=${today}&to=${today}`);
    const w = r.items.find((x: { workCenterId: string }) => x.workCenterId === oven);
    assert.deepEqual([w.plannedMinutes, w.downtimeMinutes, w.runMinutes, w.standardMinutes], [480, 120, 80, 54]);
    assert.deepEqual([w.availability, w.performance, w.quality], [0.75, 0.675, 0.9]);
    assert.equal(w.oee, Math.round(0.75 * 0.675 * 0.9 * 10000) / 10000);
  });

  it("the same figures download as an Excel workbook (right to left)", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/t/reports/production?from=${today}&to=${today}&format=xlsx`,
      headers: { cookie: `mn_sid=${owner.token}`, "x-tenant-id": t }, remoteAddress: owner.ip });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers["content-type"]), /spreadsheetml/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    const orders = wb.getWorksheet("أوامر التشغيل")!;
    assert.equal(orders.views[0]?.rightToLeft, true);
    assert.equal(orders.getRow(2).getCell(4).value, 90, "made");
    assert.equal(orders.getRow(2).getCell(5).value, 10, "scrap");
  });

  it("an empty period reads zero, and a reversed range is refused", async () => {
    const r = await get("/t/reports/production?from=2020-01-01&to=2020-01-31");
    assert.equal(r.orders.length, 0);
    assert.equal((await call(app, owner, "GET", `/t/reports/oee?from=${today}&to=2020-01-01`, { tenant: t })).status, 422);
  });
});
