import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  type Actor, type App, addMember, call, code, createApprovedRecipe, createIngredient, createTenant, createUser, expectStatus, openShift, ownerPool,
  raiseLimits, receivePo, setupKitchen, startApp, stockOf, stopApp, type Kitchen,
} from "./helpers.ts";

// Burger: 20.00 net, 100 g tomato. Modifiers: size (exactly 1: regular +0 / large +5), extras (0–2: cheese +3 & 30 g cheese, no onion +0).
describe("batch 3: modifiers, tables, delivery platforms, customers, kitchen display", () => {
  let app: App;
  let owner: Actor;
  let cashier: Actor;
  let tenant: string;
  let k: Kitchen;
  let cheese: string;
  let burger: string;
  let shift: string;
  const opt: Record<string, string> = {};

  before(async () => {
    app = await startApp();
    owner = await createUser();
    tenant = await createTenant(app, owner);
    await raiseLimits(tenant);
    k = await setupKitchen(app, owner, tenant);
    cheese = await createIngredient(app, owner, tenant, "جبنة شيدر", "g", "kg");
    await receivePo(app, owner, tenant, { supplierId: k.supplierId, locationId: k.locationId, items: [{ ingredientId: k.ingredientId, quantity: 5, unitPrice: 10 }, { ingredientId: cheese, quantity: 1, unitPrice: 40 }] });
    burger = await createApprovedRecipe(app, owner, tenant, 20, [{ ingredientId: k.ingredientId, quantity: 100 }]);

    const size = await call(app, owner, "POST", "/t/modifier-groups", { tenant, body: { name: "الحجم", minSelect: 1, maxSelect: 1, options: [{ name: "عادي", priceNet: 0 }, { name: "كبير", priceNet: 5 }] } });
    expectStatus(size, 201, "size group");
    const extras = await call(app, owner, "POST", "/t/modifier-groups", { tenant, body: { name: "إضافات", minSelect: 0, maxSelect: 2,
      options: [{ name: "جبنة إضافية", priceNet: 3, ingredientId: cheese, ingredientQty: 30 }, { name: "بدون بصل", priceNet: 0 }] } });
    expectStatus(extras, 201, "extras group");
    const groups = await call(app, owner, "GET", "/t/modifier-groups", { tenant });
    for (const g of groups.body.items) for (const o of g.options) opt[o.name] = o.id;
    expectStatus(await call(app, owner, "PUT", `/t/recipes/${burger}/modifier-groups`, { tenant, body: { groupIds: [size.body.id, extras.body.id] } }), 200, "link groups");
    cashier = await addMember(app, owner, tenant, "cashier");
    shift = await openShift(app, cashier, tenant, k.locationId);
  });
  after(() => stopApp(app));

  const sale = (actor: Actor, body: object, total: number, method = "cash") => call(app, actor, "POST", "/t/pos/orders", {
    tenant, idem: true, body: { locationId: k.locationId, shiftId: shift, channel: "takeaway", payments: [{ method, amount: total }], ...body },
  });

  it("modifier rules are enforced by the server and priced into the line", async () => {
    const missing = await call(app, cashier, "POST", "/t/pos/quote", { tenant, body: { items: [{ recipeId: burger, quantity: 1 }] } });
    assert.equal(missing.status, 422);
    assert.equal(missing.body.error.code, "modifier_selection");

    const both = await call(app, cashier, "POST", "/t/pos/quote", { tenant, body: { items: [{ recipeId: burger, quantity: 1, modifiers: [opt["عادي"], opt["كبير"]] }] } });
    assert.equal(both.body.error.code, "modifier_selection", "size is exactly one");

    const q = await call(app, cashier, "POST", "/t/pos/quote", { tenant, body: { items: [{ recipeId: burger, quantity: 2, modifiers: [opt["كبير"], opt["جبنة إضافية"]] }] } });
    expectStatus(q, 200, "quote");
    // (20 + 5 + 3) × 2 = 56.00 net → 64.40 with 15 % VAT
    assert.equal(q.body.subtotal, 56);
    assert.equal(q.body.total, 64.4);
    assert.deepEqual(q.body.lines[0].modifiers, ["كبير", "جبنة إضافية"]);

    const menu = await call(app, cashier, "GET", `/t/pos/menu?locationId=${k.locationId}`, { tenant });
    const m = menu.body.items.find((x: { id: string }) => x.id === burger);
    assert.deepEqual(m.modifierGroups.map((g: { name: string }) => g.name), ["الحجم", "إضافات"]);
    assert.equal(m.modifierGroups[0].options.find((o: { name: string }) => o.name === "كبير").priceGross, 5.75);

    const plain = await createApprovedRecipe(app, owner, tenant, 5, [{ ingredientId: k.ingredientId, quantity: 10 }]);
    const foreign = await call(app, cashier, "POST", "/t/pos/quote", { tenant, body: { items: [{ recipeId: plain, quantity: 1, modifiers: [opt["جبنة إضافية"]] }] } });
    assert.equal(foreign.body.error.code, "modifier_unavailable", "option not linked to that recipe");
  });

  it("a sale with modifiers deducts the modifier's ingredient and records the modifiers", async () => {
    const r = await sale(cashier, { items: [{ recipeId: burger, quantity: 2, modifiers: [opt["كبير"], opt["جبنة إضافية"]] }] }, 64.4);
    expectStatus(r, 201, "sale");
    assert.equal((await stockOf(tenant, k.locationId, cheese)).quantity, 940); // 1000 − 2 × 30
    assert.equal((await stockOf(tenant, k.locationId, k.ingredientId)).quantity, 4800);
    const d = await call(app, owner, "GET", `/t/pos/orders/${r.body.id}`, { tenant });
    assert.deepEqual(d.body.items[0].modifiers.sort(), ["جبنة إضافية", "كبير"].sort());
    assert.equal(d.body.items[0].unitPriceNet, 28);
    const cost = await ownerPool.query("SELECT cost_total::float8 AS c FROM pos_orders WHERE id = $1", [r.body.id]);
    assert.equal(cost.rows[0].c, 4.4); // 200 g × 0.01 + 60 g × 0.04
  });

  it("tables: dine-in only, same location, shown busy until the kitchen serves", async () => {
    const area = await call(app, owner, "POST", "/t/dining-areas", { tenant, body: { locationId: k.locationId, name: "الصالة الرئيسية" } });
    expectStatus(area, 201, "area");
    const table = await call(app, owner, "POST", "/t/dining-tables", { tenant, body: { areaId: area.body.id, name: "T1", seats: 4 } });
    expectStatus(table, 201, "table");
    const items = [{ recipeId: burger, quantity: 1, modifiers: [opt["عادي"]] }];
    const wrongChannel = await sale(cashier, { items, tableId: table.body.id }, 23);
    assert.equal(wrongChannel.status, 422);

    const otherLoc = await call(app, owner, "POST", "/t/locations", { tenant, body: { code: code("L"), name: "فرع آخر" } });
    const otherArea = await call(app, owner, "POST", "/t/dining-areas", { tenant, body: { locationId: otherLoc.body.id, name: "صالة" } });
    const otherTable = await call(app, owner, "POST", "/t/dining-tables", { tenant, body: { areaId: otherArea.body.id, name: "X1" } });
    const elsewhere = await sale(cashier, { items, channel: "dine_in", tableId: otherTable.body.id }, 23);
    assert.equal(elsewhere.body.error.code, "table_unavailable");

    const ok = await sale(cashier, { items, channel: "dine_in", tableId: table.body.id, guests: 3 }, 23);
    expectStatus(ok, 201, "dine-in sale");
    const areas = await call(app, cashier, "GET", `/t/dining-areas?locationId=${k.locationId}`, { tenant });
    assert.equal(areas.body.items[0].tables[0].busy, true);
    const d = await call(app, owner, "GET", `/t/pos/orders/${ok.body.id}`, { tenant });
    assert.deepEqual([d.body.tableName, d.body.guests], ["T1", 3]);
  });

  it("kitchen display: forward-only steps, recall within 15 minutes; cashier allowed, accountant not", async () => {
    const board = await call(app, cashier, "GET", `/t/kds?locationId=${k.locationId}`, { tenant });
    expectStatus(board, 200, "kds");
    const ticket = board.body.items.find((t: { tableName: string | null }) => t.tableName === "T1");
    assert.equal(ticket.status, "new");
    assert.equal(ticket.items[0].name, "سلطة");
    assert.equal((await call(app, cashier, "POST", `/t/kds/${ticket.id}/status`, { tenant, body: { status: "ready" } })).status, 409, "cannot skip preparing");
    for (const s of ["preparing", "ready", "served"]) expectStatus(await call(app, cashier, "POST", `/t/kds/${ticket.id}/status`, { tenant, body: { status: s } }), 200, s);
    const areas = await call(app, cashier, "GET", `/t/dining-areas?locationId=${k.locationId}`, { tenant });
    assert.equal(areas.body.items[0].tables[0].busy, false, "table frees when served");
    expectStatus(await call(app, cashier, "POST", `/t/kds/${ticket.id}/status`, { tenant, body: { status: "recall" } }), 200, "recall");

    const accountant = await addMember(app, owner, tenant, "accountant");
    assert.equal((await call(app, accountant, "GET", `/t/kds?locationId=${k.locationId}`, { tenant })).status, 403);
  });

  it("delivery platforms: commission computed by the server, settled only via the platform", async () => {
    const p = await call(app, owner, "POST", "/t/delivery-platforms", { tenant, body: { name: "هنقرستيشن", commissionPercent: 20 } });
    expectStatus(p, 201, "platform");
    const items = [{ recipeId: burger, quantity: 1, modifiers: [opt["عادي"]] }];
    const cashPaid = await sale(cashier, { items, channel: "delivery", platformId: p.body.id }, 23);
    assert.equal(cashPaid.body.error.code, "payment_mismatch");
    const platformNoPlatform = await sale(cashier, { items }, 23, "platform");
    assert.equal(platformNoPlatform.body.error.code, "payment_mismatch");

    const r = await sale(cashier, { items, channel: "delivery", platformId: p.body.id, externalRef: "HS-99812" }, 23, "platform");
    expectStatus(r, 201, "platform sale");
    const d = await call(app, owner, "GET", `/t/pos/orders/${r.body.id}`, { tenant });
    assert.deepEqual([d.body.platformName, d.body.externalRef, d.body.commission], ["هنقرستيشن", "HS-99812", 4]); // 20 % of 20.00

    const rep = await call(app, owner, "GET", "/t/reports/sales-by-channel", { tenant });
    const row = rep.body.items.find((x: { platformName: string | null }) => x.platformName === "هنقرستيشن");
    assert.deepEqual([row.orders, row.netSales, row.commission], [1, 20, 4]);
  });

  it("customers: unique phone, attached to orders with history; accountant cannot add", async () => {
    const c = await call(app, cashier, "POST", "/t/customers", { tenant, body: { name: "أحمد العتيبي", phone: "0551234567" } });
    expectStatus(c, 201, "customer");
    const dup = await call(app, cashier, "POST", "/t/customers", { tenant, body: { name: "آخر", phone: "0551234567" } });
    assert.equal(dup.body.error.code, "customer_exists");
    const bad = await call(app, cashier, "POST", "/t/customers", { tenant, body: { name: "خطأ", phone: "abc" } });
    assert.equal(bad.status, 422);

    expectStatus(await sale(cashier, { items: [{ recipeId: burger, quantity: 1, modifiers: [opt["عادي"]] }], customerId: c.body.id }, 23), 201, "sale to customer");
    const found = await call(app, cashier, "GET", "/t/customers?q=0551", { tenant });
    assert.deepEqual([found.body.items[0].ordersCount, found.body.items[0].totalSpent], [1, 23]);
    const hist = await call(app, owner, "GET", `/t/customers/${c.body.id}/orders`, { tenant });
    assert.equal(hist.body.items.length, 1);

    const accountant = await addMember(app, owner, tenant, "accountant");
    assert.equal((await call(app, accountant, "POST", "/t/customers", { tenant, body: { name: "س", phone: "0559999999" } })).status, 403);
  });
});
