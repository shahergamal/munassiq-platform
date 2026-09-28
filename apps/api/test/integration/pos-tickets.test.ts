import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import {
  type Actor, type App, addMember, call, createApprovedRecipe, createTenant, createUser, expectStatus, openShift, ownerPool, raiseLimits, receivePo,
  setupKitchen, startApp, stockOf, stopApp, type Kitchen,
} from "./helpers.ts";

/**
 * Several customers at once at one till: open tickets kept on the server, sent to the kitchen in rounds, a sent
 * item cancelled only by a manager (and the kitchen told), a bill split by items, tables that hold one order,
 * and an X report that keeps the cashier's count blind.
 */
describe("POS open tickets", () => {
  let app: App;
  let owner: Actor, manager: Actor, cashier: Actor;
  let tenant: string;
  let k: Kitchen;
  let burger: string, fries: string;
  let table: string;
  let shift: string;
  let t1: any, t2: any;
  const line = (recipeId: string, quantity: number, extra: object = {}) => ({ id: randomUUID(), recipeId, quantity, modifiers: [], ...extra });
  const kds = async () => {
    const r = await call(app, owner, "GET", `/t/kds?locationId=${k.locationId}`, { tenant });
    expectStatus(r, 200, "kitchen screen");
    return r.body.items as any[];
  };
  const put = (who: Actor, t: any, patch: object) => call(app, who, "PUT", `/t/pos/tickets/${t.id}`, { tenant, body: {
    version: t.version, label: t.label, channel: t.channel, tableId: t.tableId, guests: t.guests, customerId: t.customerId,
    items: t.items.map(({ id, recipeId, quantity, modifiers, note }: any) => ({ id, recipeId, quantity, modifiers, note })), ...patch } });

  before(async () => {
    app = await startApp();
    owner = await createUser({ name: "المالك" });
    tenant = await createTenant(app, owner, "مطعم الطاولات");
    await raiseLimits(tenant);
    k = await setupKitchen(app, owner, tenant);
    manager = await addMember(app, owner, tenant, "manager");
    cashier = await addMember(app, owner, tenant, "cashier");
    await receivePo(app, owner, tenant, { supplierId: k.supplierId, locationId: k.locationId, items: [{ ingredientId: k.ingredientId, quantity: 10, unitPrice: 5 }] });
    burger = await createApprovedRecipe(app, owner, tenant, 20, [{ ingredientId: k.ingredientId, quantity: 100 }]);
    fries = await createApprovedRecipe(app, owner, tenant, 10, [{ ingredientId: k.ingredientId, quantity: 50 }]);
    const area = await call(app, owner, "POST", "/t/dining-areas", { tenant, body: { locationId: k.locationId, name: "الصالة" } });
    table = (await call(app, owner, "POST", "/t/dining-tables", { tenant, body: { areaId: area.body.id, name: "4", seats: 4 } })).body.id;
    shift = await openShift(app, cashier, tenant, k.locationId);
  });
  after(() => stopApp(app));

  it("two customers at once: each ticket is priced by the server; a table holds one open ticket", async () => {
    const a = await call(app, cashier, "POST", "/t/pos/tickets", { tenant, idem: true, body: {
      locationId: k.locationId, channel: "dine_in", tableId: table, guests: 2, items: [line(burger, 2, { note: "بدون بصل" })] } });
    expectStatus(a, 201, "ticket 1");
    t1 = a.body;
    const b = await call(app, cashier, "POST", "/t/pos/tickets", { tenant, idem: true, body: { locationId: k.locationId, label: "أحمد", items: [line(fries, 1)] } });
    expectStatus(b, 201, "ticket 2");
    t2 = b.body;
    assert.deepEqual([t1.totals.total, t1.tableName, t1.count, t1.unsent], [46, "4", 2, 2]);
    assert.equal(t2.totals.total, 11.5);

    const list = (await call(app, cashier, "GET", `/t/pos/tickets?locationId=${k.locationId}`, { tenant })).body.items;
    assert.deepEqual(list.map((t: any) => t.id), [t1.id, t2.id], "the till's tabs");
    const clash = await call(app, cashier, "POST", "/t/pos/tickets", { tenant, idem: true, body: { locationId: k.locationId, channel: "dine_in", tableId: table } });
    expectStatus(clash, 409, "table busy");
    assert.equal(clash.body.error.details.ticketId, t1.id, "points to the open ticket");
    const areas = (await call(app, cashier, "GET", `/t/dining-areas?locationId=${k.locationId}`, { tenant })).body.items;
    assert.deepEqual([areas[0].tables[0].busy, areas[0].tables[0].ticketId], [true, t1.id]);
  });

  it("the kitchen gets rounds: the first order, then only the additions", async () => {
    let r = await call(app, cashier, "POST", `/t/pos/tickets/${t1.id}/send`, { tenant, body: { version: t1.version } });
    expectStatus(r, 200, "send round 1");
    t1 = r.body;
    assert.equal(t1.unsent, 0);
    r = await put(cashier, t1, { items: [...t1.items.map(({ id, recipeId, quantity, modifiers, note }: any) => ({ id, recipeId, quantity, modifiers, note })), line(fries, 1)] });
    expectStatus(r, 200, "add fries");
    t1 = r.body;
    expectStatus(await put(cashier, { ...t1, version: t1.version - 1 }, {}), 409, "stale version from another till");
    r = await call(app, cashier, "POST", `/t/pos/tickets/${t1.id}/send`, { tenant, body: { version: t1.version } });
    t1 = r.body;
    expectStatus(await call(app, cashier, "POST", `/t/pos/tickets/${t1.id}/send`, { tenant, body: { version: t1.version } }), 409, "nothing left to send");

    const rounds = (await kds()).filter((x) => x.ticketNumber === Number(t1.number)).sort((x, y) => x.round - y.round);
    assert.deepEqual(rounds.map((x) => x.items.map((i: any) => [i.quantity, i.note])), [[[2, "بدون بصل"]], [[1, null]]]);
    assert.equal(rounds[0].tableName, "4");
  });

  it("what the kitchen has cannot be quietly changed: a manager cancels it with a reason, and the kitchen is told", async () => {
    const burgerLine = t1.items.find((l: any) => l.recipeId === burger);
    const fewer = t1.items.map((l: any) => ({ id: l.id, recipeId: l.recipeId, quantity: l.id === burgerLine.id ? 1 : l.quantity, modifiers: l.modifiers, note: l.note }));
    expectStatus(await put(cashier, t1, { items: fewer }), 403, "the cashier cannot");
    expectStatus(await put(manager, t1, { items: fewer }), 422, "reason required");
    const locked = t1.items.map((l: any) => ({ id: l.id, recipeId: l.recipeId, quantity: l.quantity, modifiers: l.modifiers, note: l.id === burgerLine.id ? "حار" : l.note }));
    expectStatus(await put(cashier, t1, { items: locked }), 409, "a sent line is locked");
    const r = await put(manager, t1, { items: fewer, voidReason: "العميل غيّر رأيه" });
    expectStatus(r, 200, "manager cancels one");
    t1 = r.body;
    const voidRound = (await kds()).find((x) => x.ticketNumber === Number(t1.number) && x.items.some((i: any) => i.quantity < 0));
    assert.deepEqual(voidRound?.items.map((i: any) => i.quantity), [-1]);
    expectStatus(await call(app, cashier, "POST", `/t/kds/${voidRound.id}/status`, { tenant, body: { status: "served" } }), 200, "a cancellation is acknowledged in one step");
    expectStatus(await call(app, cashier, "POST", `/t/kds/${(await kds()).find((x) => x.ticketNumber === Number(t1.number) && x.round === 1).id}/status`, { tenant, body: { status: "served" } }), 409, "an order to cook still goes step by step");
    assert.equal(t1.totals.total, 34.5, "1 burger + 1 fries");
  });

  it("split bill: one guest pays the burger, the other the fries; the ticket closes with two sales", async () => {
    const burgerLine = t1.items.find((l: any) => l.recipeId === burger);
    const before = await stockOf(tenant, k.locationId, k.ingredientId);
    const p1 = await call(app, cashier, "POST", "/t/pos/orders", { tenant, idem: true, body: {
      locationId: k.locationId, shiftId: shift, channel: "takeaway", items: [{ recipeId: fries, quantity: 9 }], // the browser's copy is ignored
      payments: [{ method: "cash", amount: 23 }], ticket: { id: t1.id, version: t1.version, lines: [{ lineId: burgerLine.id, quantity: 1 }] } } });
    expectStatus(p1, 201, "first guest");
    assert.equal(p1.body.ticketClosed, false);
    t1 = (await call(app, cashier, "GET", `/t/pos/tickets/${t1.id}`, { tenant })).body;
    assert.deepEqual([t1.status, t1.items.length, t1.totals.total], ["open", 1, 11.5]);
    const p2 = await call(app, cashier, "POST", "/t/pos/orders", { tenant, idem: true, body: {
      locationId: k.locationId, shiftId: shift, channel: "takeaway", items: [{ recipeId: fries, quantity: 1 }],
      payments: [{ method: "mada", amount: 11.5 }], ticket: { id: t1.id, version: t1.version } } });
    expectStatus(p2, 201, "second guest");
    assert.equal(p2.body.ticketClosed, true);
    t1 = (await call(app, cashier, "GET", `/t/pos/tickets/${t1.id}`, { tenant })).body;
    assert.deepEqual([t1.status, t1.orders.length], ["paid", 2]);
    const o1 = (await call(app, cashier, "GET", `/t/pos/orders/${p1.body.id}`, { tenant })).body;
    assert.deepEqual([o1.channel, o1.tableName, o1.items[0].name, o1.items[0].note], ["dine_in", "4", "سلطة", "بدون بصل"], "the sale takes the ticket's details");
    assert.equal((await stockOf(tenant, k.locationId, k.ingredientId)).quantity, before.quantity - 150, "stock leaves at payment");
    assert.equal((await kds()).filter((x) => x.ticketNumber === Number(t1.number)).length, 3, "no new round: the kitchen had everything");

    expectStatus(await put(cashier, t1, {}), 409, "a paid ticket is closed");
    await assert.rejects(ownerPool.query("UPDATE pos_tickets SET label = 'x' WHERE id = $1", [t1.id]), /ticket_closed/);
    const areas = (await call(app, cashier, "GET", `/t/dining-areas?locationId=${k.locationId}`, { tenant })).body.items;
    assert.equal(areas[0].tables[0].ticketId, null, "the table is free");
  });

  it("paying a ticket the kitchen never saw sends it with the order number", async () => {
    const r = await call(app, cashier, "POST", "/t/pos/orders", { tenant, idem: true, body: {
      locationId: k.locationId, shiftId: shift, channel: "takeaway", items: [{ recipeId: fries, quantity: 1 }],
      payments: [{ method: "cash", amount: 11.5 }], ticket: { id: t2.id, version: t2.version } } });
    expectStatus(r, 201, "pay ticket 2");
    const round = (await kds()).find((x) => x.ticketNumber === Number(t2.number));
    assert.equal(Number(round?.orderNumber), r.body.orderNumber);
    assert.equal(round?.ticketLabel, "أحمد");
  });

  it("a fixed-amount discount is not split; voiding needs a manager once the kitchen has it; tickets merge", async () => {
    const d = await call(app, cashier, "POST", "/t/pos/tickets", { tenant, idem: true, body: {
      locationId: k.locationId, items: [line(burger, 1), line(fries, 1)], discount: { type: "amount", value: 1 }, discountReason: "عميل دائم" } });
    expectStatus(d, 201, "discounted ticket");
    const split = await call(app, cashier, "POST", "/t/pos/orders", { tenant, idem: true, body: {
      locationId: k.locationId, shiftId: shift, channel: "takeaway", items: [{ recipeId: fries, quantity: 1 }], payments: [{ method: "cash", amount: 1 }],
      ticket: { id: d.body.id, version: d.body.version, lines: [{ lineId: d.body.items[0].id, quantity: 1 }] } } });
    assert.equal(split.body.error.code, "split_amount_discount");

    const sent = await call(app, cashier, "POST", `/t/pos/tickets/${d.body.id}/send`, { tenant, body: { version: d.body.version } });
    expectStatus(await call(app, cashier, "POST", `/t/pos/tickets/${d.body.id}/void`, { tenant, body: { version: sent.body.version } }), 403, "cashier cannot void a sent ticket");
    expectStatus(await call(app, manager, "POST", `/t/pos/tickets/${d.body.id}/void`, { tenant, body: { version: sent.body.version, reason: "طلب مكرر" } }), 200, "manager voids");
    const voids = (await kds()).filter((x) => x.ticketNumber === Number(d.body.number) && x.items.every((i: any) => i.quantity < 0));
    assert.equal(voids.length, 1, "the kitchen is told");

    const x = await call(app, cashier, "POST", "/t/pos/tickets", { tenant, idem: true, body: { locationId: k.locationId, items: [line(fries, 2)] } });
    expectStatus(await call(app, cashier, "POST", `/t/pos/tickets/${x.body.id}/void`, { tenant, body: { version: x.body.version } }), 200, "unsent: the cashier can void");

    const m1 = (await call(app, cashier, "POST", "/t/pos/tickets", { tenant, idem: true, body: { locationId: k.locationId, items: [line(fries, 1)] } })).body;
    const m2 = (await call(app, cashier, "POST", "/t/pos/tickets", { tenant, idem: true, body: { locationId: k.locationId, items: [line(burger, 1)] } })).body;
    const merged = await call(app, cashier, "POST", `/t/pos/tickets/${m1.id}/merge`, { tenant, body: { version: m1.version, intoId: m2.id, intoVersion: m2.version } });
    expectStatus(merged, 200, "merge");
    assert.deepEqual([merged.body.count, merged.body.totals.total], [2, 34.5]);
    const open = (await call(app, cashier, "GET", `/t/pos/tickets?locationId=${k.locationId}`, { tenant })).body.items;
    assert.deepEqual(open.map((t: any) => t.id), [m2.id]);
  });

  it("X report: the cashier sees the shift without the cash figures; a manager sees the expected cash", async () => {
    const mine = (await call(app, cashier, "GET", `/t/pos/shifts/${shift}/summary`, { tenant })).body;
    assert.deepEqual([mine.ordersCount, mine.salesTotal, mine.blind, mine.expectedCash, mine.openTickets], [3, 46, true, null, 1]);
    assert.equal(mine.byMethod.find((m: any) => m.method === "cash").amount, null, "cash hidden");
    assert.equal(mine.byMethod.find((m: any) => m.method === "mada").amount, 11.5);
    const mgr = (await call(app, manager, "GET", `/t/pos/shifts/${shift}/summary`, { tenant })).body;
    assert.deepEqual([mgr.blind, mgr.expectedCash], [false, 134.5], "float 100 + cash 23 + 11.5");
    assert.equal(mgr.topItems[0].quantity, 3, "the helper names every recipe «سلطة»");
  });
});
