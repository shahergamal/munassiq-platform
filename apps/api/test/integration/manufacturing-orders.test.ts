import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  addMember, call, code, createFactory, createIngredient, createTenant, createUser, expectStatus, ownerPool, raiseLimits, receivePo, startApp, stockOf, stopApp,
  type Actor, type App,
} from "./helpers.ts";

// Manufacturing M2 (docs/manufacturing/ARCHITECTURE.md): bills of materials with a standard cost roll-up, and
// orders whose issues, labour, output, by-products and scrap each post; closing leaves the order's WIP at zero.
describe("manufacturing orders", () => {
  let app: App;
  let owner: Actor;
  let t: string;
  let floor: string; // production location (components are issued here)
  let fg: string; // finished goods store
  let supplier: string;
  let A: string; let B: string; let P: string; let S: string; let F: string; let bran: string;
  let oven: string;

  const post = async (url: string, body: object = {}, status = 201) => {
    const r = await call(app, owner, "POST", url, { tenant: t, idem: true, body });
    expectStatus(r, status, url);
    return r.body;
  };
  const ledger = async (key: string) => Number((await ownerPool.query<{ b: string }>(
    `SELECT coalesce(sum(l.debit - l.credit), 0)::text AS b FROM journal_lines l JOIN accounts a ON a.id = l.account_id
      WHERE a.tenant_id = $1 AND a.system_key = $2`, [t, key])).rows[0]!.b);

  before(async () => {
    app = await startApp();
    owner = await createUser();
    t = await createFactory(app, owner);
    await raiseLimits(t);
    floor = (await post("/t/locations", { code: code("PR"), name: "صالة الإنتاج", locationType: "kitchen" })).id;
    fg = (await post("/t/locations", { code: code("FG"), name: "مستودع المنتج التام", locationType: "warehouse" })).id;
    supplier = (await post("/t/suppliers", { code: code("S"), name: "مورد الخامات" })).id;
    A = await createIngredient(app, owner, t, "دقيق", "kg", "kg");
    B = await createIngredient(app, owner, t, "سكر", "kg", "kg");
    P = await createIngredient(app, owner, t, "كرتون", "pcs", "pcs", { itemType: "packaging" });
    S = await createIngredient(app, owner, t, "عجينة", "kg", "kg", { itemType: "semi_finished" });
    F = await createIngredient(app, owner, t, "بسكويت", "pcs", "pcs", { itemType: "finished" });
    bran = await createIngredient(app, owner, t, "نخالة", "kg", "kg", { itemType: "semi_finished" });
    await receivePo(app, owner, t, { supplierId: supplier, locationId: floor, items: [
      { ingredientId: A, quantity: 1000, unitPrice: 2 }, { ingredientId: B, quantity: 300, unitPrice: 5 }, { ingredientId: P, quantity: 500, unitPrice: 1.5 }] });
    oven = (await post("/t/work-centers", { code: code("OV"), name: "الفرن", laborRate: 60, overheadRate: 30, locationId: floor })).id;
  });
  after(() => stopApp(app));

  let doughBom: string;

  it("a BOM is drafted, costed, activated and then frozen", async () => {
    doughBom = (await post("/t/boms", {
      itemId: S, quantity: 100,
      lines: [{ componentId: A, quantity: 80 }, { componentId: B, quantity: 20, scrapPercent: 5 }],
      operations: [{ name: "عجن", workCenterId: oven, runMinutes: 60 }],
      byproducts: [{ itemId: bran, quantity: 10, costShare: 20 }],
    })).id;
    const d = await call(app, owner, "GET", `/t/boms/${doughBom}`, { tenant: t });
    expectStatus(d, 200, "bom");
    // A 80×2 + B 21×5 + 60 min × (60 + 30)/h = 160 + 105 + 90 = 355; bran carries 20% (71); dough 284 / 100.
    assert.deepEqual(d.body.cost, { material: 265, labor: 60, overhead: 30, total: 355, mainCost: 284, unitCost: 2.84 });
    expectStatus(await call(app, owner, "POST", `/t/boms/${doughBom}/activate`, { tenant: t }), 200, "activate");
    const edit = await call(app, owner, "PUT", `/t/boms/${doughBom}`, { tenant: t, body: { quantity: 100, lines: [{ componentId: A, quantity: 90 }] } });
    assert.equal(edit.status, 409, "an active version is not edited");
    // A new version copies it; activating the copy archives the old one.
    const v2 = (await post("/t/boms", { itemId: S, copyFrom: doughBom })).id;
    const v2d = await call(app, owner, "GET", `/t/boms/${v2}`, { tenant: t });
    assert.equal(v2d.body.version, 2);
    assert.equal(v2d.body.lines.length, 2);
    expectStatus(await call(app, owner, "DELETE", `/t/boms/${v2}`, { tenant: t }), 200, "delete draft");
  });

  it("an order with a by-product and abnormal scrap: WIP closes to zero, the unit cost is the hand calculation", async () => {
    const mo = (await post("/t/manufacturing-orders", { itemId: S, quantity: 200, locationId: floor, outputLocationId: fg })).id;
    const c = await call(app, owner, "POST", `/t/manufacturing-orders/${mo}/confirm`, { tenant: t });
    expectStatus(c, 200, "confirm");
    assert.equal(c.body.standardUnitCost, 2.84);
    let d = (await call(app, owner, "GET", `/t/manufacturing-orders/${mo}`, { tenant: t })).body;
    assert.deepEqual(d.components.map((x: any) => [x.name, x.requiredQty]).sort(), [["دقيق", 160], ["سكر", 42]]);
    assert.equal(d.operations[0].plannedMinutes, 120);

    await post(`/t/manufacturing-orders/${mo}/issue`, { remaining: true }); // 160×2 + 42×5 = 530
    assert.equal((await stockOf(t, floor, A)).quantity, 840);
    await post(`/t/manufacturing-orders/${mo}/labor`, { seq: 1, minutes: 120 }); // 120 + 60
    assert.equal(await ledger("wip"), 710);
    // 190 good (at 2.84 = 539.60), bran 19 by default (at 7.10 = 134.90), 5 lost abnormally (14.20).
    await post(`/t/manufacturing-orders/${mo}/produce`, { quantity: 190, scrapQuantity: 5, scrapReason: "احتراق دفعة" });
    const out = await stockOf(t, fg, S);
    assert.deepEqual([out.quantity, out.avgCost], [190, 2.84]);
    assert.equal((await stockOf(t, fg, bran)).quantity, 19);
    assert.equal(await ledger("wip"), 21.3);
    assert.equal(await ledger("abnormal_scrap"), 14.2);
    assert.equal(await ledger("applied_labor"), -120);
    assert.equal(await ledger("applied_overhead"), -60);

    d = (await call(app, owner, "GET", `/t/manufacturing-orders/${mo}`, { tenant: t })).body;
    assert.equal(d.costs.wip, 21.3);
    // Usage: (160 − 152)×2 + (42 − 39.9)×5 = 26.5; efficiency: (120 − 114) min × 90/h = 9; no price variance.
    assert.deepEqual([d.costs.price, d.costs.usage, d.costs.efficiency], [0, 26.5, 9]);

    const cl = await post(`/t/manufacturing-orders/${mo}/close`);
    assert.equal(cl.variance, 21.3);
    assert.equal(await ledger("wip"), 0, "WIP closes to zero");
    assert.equal(await ledger("production_variance"), 21.3);
    // Inventory accounts = issued out, output in: nothing is created or lost between ledger and stock.
    const semi = await ledger("inventory_semi");
    assert.equal(semi, 539.6 + 134.9);
    expectStatus(await call(app, owner, "POST", `/t/manufacturing-orders/${mo}/produce`, { tenant: t, idem: true, body: { quantity: 1 } }), 409, "closed is final");
  });

  it("phantom sub-assemblies explode, backflush issues by the plan, returns go back at cost", async () => {
    // Biscuits: dough as a phantom (never stocked here) + cartons.
    const fBom = (await post("/t/boms", {
      itemId: F, quantity: 50,
      lines: [{ componentId: S, quantity: 10, phantom: true }, { componentId: P, quantity: 2 }],
      operations: [{ name: "خبز", workCenterId: oven, setupMinutes: 30, runMinutes: 90 }],
    })).id;
    expectStatus(await call(app, owner, "POST", `/t/boms/${fBom}/activate`, { tenant: t }), 200, "activate F");
    const mo = (await post("/t/manufacturing-orders", { itemId: F, quantity: 100, locationId: floor, outputLocationId: fg })).id;
    expectStatus(await call(app, owner, "POST", `/t/manufacturing-orders/${mo}/confirm`, { tenant: t }), 200, "confirm");
    let d = (await call(app, owner, "GET", `/t/manufacturing-orders/${mo}`, { tenant: t })).body;
    // 20 dough → A 16, B 4.2; cartons 4; the dough's kneading joins the plan.
    assert.deepEqual(d.components.map((x: any) => [x.name, x.requiredQty]).sort(), [["دقيق", 16], ["سكر", 4.2], ["كرتون", 4]]);
    assert.deepEqual(d.operations.map((o: any) => o.name), ["خبز", "عجن"]);

    await post(`/t/manufacturing-orders/${mo}/produce`, { quantity: 50, backflush: true });
    d = (await call(app, owner, "GET", `/t/manufacturing-orders/${mo}`, { tenant: t })).body;
    assert.deepEqual(d.components.map((x: any) => [x.name, x.issuedQty]).sort(), [["دقيق", 8], ["سكر", 2.1], ["كرتون", 2]]);
    const before = (await stockOf(t, floor, P)).quantity;
    await post(`/t/manufacturing-orders/${mo}/return`, { lines: [{ componentId: P, quantity: 2 }] });
    assert.equal((await stockOf(t, floor, P)).quantity, before + 2);
    const tooMuch = await call(app, owner, "POST", `/t/manufacturing-orders/${mo}/return`, { tenant: t, idem: true, body: { lines: [{ componentId: P, quantity: 1 }] } });
    assert.equal(tooMuch.status, 422, "nothing left to return");
    await post(`/t/manufacturing-orders/${mo}/close`);
    assert.equal(await ledger("wip"), 0);
  });

  it("guards: confirmed orders cancel, started ones do not; cycles are refused; clerks produce but do not close", async () => {
    const m1 = (await post("/t/manufacturing-orders", { itemId: S, quantity: 10, locationId: floor })).id;
    expectStatus(await call(app, owner, "POST", `/t/manufacturing-orders/${m1}/cancel`, { tenant: t, body: { reason: "خطة تغيرت" } }), 200, "cancel draft");
    // An item whose BOM contains the item that contains it.
    const loop = (await post("/t/boms", { itemId: bran, quantity: 1, lines: [{ componentId: S, quantity: 1 }] })).id;
    expectStatus(await call(app, owner, "POST", `/t/boms/${loop}/activate`, { tenant: t }), 200, "bran from dough is fine");
    const back = (await post("/t/boms", { itemId: S, copyFrom: doughBom })).id;
    const lines = [{ componentId: A, quantity: 80 }, { componentId: bran, quantity: 5 }];
    expectStatus(await call(app, owner, "PUT", `/t/boms/${back}`, { tenant: t, body: { quantity: 100, lines } }), 200, "draft edit");
    const cyc = await call(app, owner, "POST", `/t/boms/${back}/activate`, { tenant: t });
    assert.equal(cyc.status, 422);
    assert.equal(cyc.body.error.code, "bom_cycle");
    // No BOM for a raw material.
    assert.equal((await call(app, owner, "POST", "/t/boms", { tenant: t, body: { itemId: A, quantity: 1, lines: [{ componentId: B, quantity: 1 }] } })).status, 422);

    const clerk = await addMember(app, owner, t, "inventory_clerk");
    const m2 = (await post("/t/manufacturing-orders", { itemId: S, quantity: 10, locationId: floor, outputLocationId: fg })).id;
    expectStatus(await call(app, owner, "POST", `/t/manufacturing-orders/${m2}/confirm`, { tenant: t }), 200, "confirm");
    expectStatus(await call(app, clerk, "POST", `/t/manufacturing-orders/${m2}/produce`, { tenant: t, idem: true, body: { quantity: 10, backflush: true } }), 201, "clerk produces");
    assert.equal((await call(app, clerk, "POST", `/t/manufacturing-orders/${m2}/close`, { tenant: t, idem: true })).status, 403);
    assert.equal((await call(app, owner, "POST", `/t/manufacturing-orders/${m2}/cancel`, { tenant: t, body: { reason: "محاولة" } })).status, 409, "started orders close, not cancel");
    expectStatus(await call(app, owner, "POST", `/t/manufacturing-orders/${m2}/close`, { tenant: t, idem: true }), 201, "owner closes");
  });

  it("the sector is open for sign-up; a restaurant has no production pages", async () => {
    const sectors = await call(app, null, "GET", "/sectors");
    assert.equal(sectors.body.find((s: { key: string }) => s.key === "manufacturing").isAvailable, true);
    const o = await createUser();
    const r = await createTenant(app, o);
    assert.equal((await call(app, o, "GET", "/t/boms", { tenant: r })).status, 404);
    assert.equal((await call(app, o, "GET", "/t/manufacturing-orders", { tenant: r })).status, 404);
  });
});
