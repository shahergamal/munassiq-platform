import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  addMember, call, code, createApprovedPo, createFactory, createIngredient, createUser, expectStatus, isoToday, ownerPool, raiseLimits, receivePo, startApp, stockOf, stopApp,
  type Actor, type App,
} from "./helpers.ts";

const day = (n: number) => new Date(Date.parse(`${isoToday()}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// Manufacturing M5 (docs/manufacturing/ARCHITECTURE.md): inspection holds a failing lot in quarantine (nothing uses
// it until released), a rejection opens a non-conformance report, and a finished batch traces back to its supplier
// and forward to its customer. Maintenance: plans come due, parts post to maintenance expense, breakdowns give MTTR.
describe("quality and maintenance", () => {
  let app: App;
  let owner: Actor;
  let t: string;
  let floor: string;
  let supplier: string;
  let A: string; let F: string; let spare: string;
  let po: string;
  let oven: string;

  const post = async (url: string, body: object = {}, status = 201) => {
    const r = await call(app, owner, "POST", url, { tenant: t, idem: true, body });
    expectStatus(r, status, url);
    return r.body;
  };
  const get = async (url: string) => {
    const r = await call(app, owner, "GET", url, { tenant: t });
    expectStatus(r, 200, url);
    return r.body;
  };
  const ledger = async (key: string) => Number((await ownerPool.query<{ b: string }>(
    `SELECT coalesce(sum(l.debit - l.credit), 0)::text AS b FROM journal_lines l JOIN accounts a ON a.id = l.account_id
      WHERE a.tenant_id = $1 AND a.system_key = $2`, [t, key])).rows[0]!.b);
  const batchOf = async (batchNo: string, locationId: string) => (await ownerPool.query<{ id: string }>(
    "SELECT id FROM stock_batches WHERE tenant_id = $1 AND batch_no = $2 AND location_id = $3 AND remaining > 0", [t, batchNo, locationId])).rows[0]?.id;

  before(async () => {
    app = await startApp();
    owner = await createUser();
    t = await createFactory(app, owner);
    await raiseLimits(t);
    floor = (await post("/t/locations", { code: code("PR"), name: "صالة الإنتاج", locationType: "warehouse" })).id;
    supplier = (await post("/t/suppliers", { code: code("S"), name: "مورد الدقيق" })).id;
    A = await createIngredient(app, owner, t, "دقيق", "kg", "kg");
    F = await createIngredient(app, owner, t, "كيس خبز", "pcs", "pcs", { itemType: "finished", salePrice: 5 });
    spare = await createIngredient(app, owner, t, "سير ناقل", "pcs", "pcs", { itemType: "spare_part" });
    po = await createApprovedPo(app, owner, t, { supplierId: supplier, locationId: floor, items: [{ ingredientId: A, quantity: 200, unitPrice: 2 }] });
    oven = (await post("/t/work-centers", { code: code("OV"), name: "الفرن", hoursPerDay: 8, laborRate: 0, overheadRate: 0 })).id;
  });
  after(() => stopApp(app));

  let lot1: string;

  it("a failing receipt inspection holds the lot in quarantine; nothing uses it until quality releases it", async () => {
    const plan = await post("/t/qc/plans", { itemId: A, stage: "receipt", name: "فحص الدقيق", characteristics: [
      { name: "الرطوبة", kind: "numeric", max: 12, unit: "%" }, { name: "العبوة سليمة", kind: "check" }] });
    expectStatus(await call(app, owner, "POST", "/t/qc/plans", { tenant: t, body: { itemId: A, stage: "receipt", name: "ثانية", characteristics: [{ name: "x", kind: "check" }] } }), 409, "one active plan");
    await post(`/t/purchases/${po}/receipts`, { items: [{ ingredientId: A, quantity: 100, batchNo: "RAW-1" }] });
    lot1 = (await batchOf("RAW-1", floor))!;
    const pending = await get("/t/qc/pending");
    assert.deepEqual(pending.items.map((x: { batchNo: string; planId: string }) => [x.batchNo, x.planId]), [["RAW-1", plan.id]]);

    const missing = await call(app, owner, "POST", "/t/qc/inspections", { tenant: t, idem: true, body: { batchId: lot1, values: { "الرطوبة": 11 } } });
    assert.equal(missing.status, 422, "every characteristic needs a value");
    const force = await call(app, owner, "POST", "/t/qc/inspections", { tenant: t, idem: true, body: { batchId: lot1, values: { "الرطوبة": 14, "العبوة سليمة": true }, decision: "accept" } });
    assert.equal(force.body.error.code, "failed_characteristics", "the server judges the values, not the browser");
    const ins = await post("/t/qc/inspections", { batchId: lot1, values: { "الرطوبة": 14, "العبوة سليمة": true } });
    assert.equal(ins.decision, "on_hold");
    assert.equal((await stockOf(t, floor, A)).quantity, 0, "moved out of the floor");
    const list = await get("/t/qc/inspections");
    assert.deepEqual(list.held.map((h: { batchNo: string; remaining: number }) => [h.batchNo, h.remaining]), [["RAW-1", 100]]);
    assert.equal(list.items[0].results.find((r: { name: string }) => r.name === "الرطوبة").pass, false);
    assert.equal(await ledger("inventory"), 200, "a move between locations posts nothing");
    assert.equal((await get("/t/qc/pending")).items.length, 0);

    // Using stock straight from quarantine is refused (an order placed there cannot issue).
    const qLoc = (await ownerPool.query<{ id: string }>("SELECT id FROM locations WHERE tenant_id = $1 AND location_type = 'quarantine'", [t])).rows[0]!.id;
    const bom = (await post("/t/boms", { itemId: F, quantity: 1, lines: [{ componentId: A, quantity: 0.5 }], operations: [{ name: "خبز", workCenterId: oven, runMinutes: 1 }] })).id;
    await post(`/t/boms/${bom}/activate`, {}, 200);
    const bad = (await post("/t/manufacturing-orders", { itemId: F, quantity: 4, locationId: qLoc, outputLocationId: floor })).id;
    await post(`/t/manufacturing-orders/${bad}/confirm`, {}, 200);
    const issue = await call(app, owner, "POST", `/t/manufacturing-orders/${bad}/issue`, { tenant: t, idem: true, body: { remaining: true } });
    assert.equal(issue.body.error.code, "quality_hold");
    await post(`/t/manufacturing-orders/${bad}/cancel`, { reason: "موقع خاطئ" }, 200);

    const clerk = await addMember(app, owner, t, "inventory_clerk");
    const heldId = list.held[0].batchId;
    assert.equal((await call(app, clerk, "POST", `/t/qc/batches/${heldId}/release`, { tenant: t, body: { reason: "إعادة القياس سليمة" } })).status, 403, "release is sensitive");
    await post(`/t/qc/batches/${heldId}/release`, { reason: "إعادة القياس 11.5% ضمن الحد" }, 200);
    assert.deepEqual(await stockOf(t, floor, A), { quantity: 100, avgCost: 2 });
    assert.equal((await get("/t/qc/inspections")).held.length, 0);
  });

  it("a rejected lot opens a non-conformance report against the supplier, closed with a disposition", async () => {
    await post(`/t/purchases/${po}/receipts`, { items: [{ ingredientId: A, quantity: 100, batchNo: "RAW-2" }] });
    const lot2 = (await batchOf("RAW-2", floor))!;
    const ins = await post("/t/qc/inspections", { batchId: lot2, values: { "الرطوبة": 16, "العبوة سليمة": false }, decision: "reject", notes: "حشرات" });
    assert.equal(ins.decision, "rejected");
    const ncrs = (await get("/t/ncrs?status=open")).items;
    assert.equal(ncrs.length, 1);
    assert.equal(ncrs[0].supplierName, "مورد الدقيق");
    assert.match(ncrs[0].description, /الرطوبة: 16/);
    const noCause = await call(app, owner, "POST", `/t/ncrs/${ncrs[0].id}/close`, { tenant: t, body: { disposition: "return_to_supplier" } });
    assert.equal(noCause.status, 422);
    await post(`/t/ncrs/${ncrs[0].id}/close`, { disposition: "return_to_supplier", rootCause: "تخزين رطب عند المورد", correctiveAction: "فحص إلزامي لكل شحنة" }, 200);
    assert.equal((await get("/t/ncrs?status=open")).items.length, 0);
    expectStatus(await call(app, owner, "POST", `/t/ncrs/${ncrs[0].id}/close`, { tenant: t, body: { disposition: "scrap", rootCause: "xxx", correctiveAction: "yyy" } }), 409, "closed once");
  });

  it("a finished batch traces back to the supplier's lot and forward to the customer", async () => {
    const mo = (await post("/t/manufacturing-orders", { itemId: F, quantity: 20, locationId: floor, outputLocationId: floor })).id;
    await post(`/t/manufacturing-orders/${mo}/confirm`, {}, 200);
    await post(`/t/manufacturing-orders/${mo}/issue`, { remaining: true });
    await post(`/t/manufacturing-orders/${mo}/produce`, { quantity: 20, batchNo: "FG-7" });
    const fgLot = (await batchOf("FG-7", floor))!;
    const cust = (await post("/t/customers", { name: "سوبرماركت الحي", phone: `05${Math.floor(10000000 + Math.random() * 89999999)}` })).id;
    const so = (await post("/t/sales-orders", { customerId: cust, locationId: floor, lines: [{ itemId: F, quantity: 8 }] })).id;
    await post(`/t/sales-orders/${so}/confirm`, {}, 200);
    const line = (await get(`/t/sales-orders/${so}`)).lines[0].id;
    await post(`/t/sales-orders/${so}/deliver`, { lines: [{ lineId: line, quantity: 8 }] });

    const tr = await get(`/t/trace/batches/${fgLot}`);
    assert.equal(tr.backward.origin.kind, "production");
    const labels = (n: { origin: { label: string }; inputs: unknown[] }): string[] => [n.origin.label, ...(n.inputs as typeof n[]).flatMap(labels)];
    assert.ok(labels(tr.backward).some((l) => l.includes("مورد الدقيق") && l.includes("GRN-")), `supplier reached: ${labels(tr.backward).join(" | ")}`);
    assert.deepEqual(tr.forward.map((f: { kind: string; quantity: number }) => [f.kind, f.quantity]), [["customer", 8]]);
    assert.match(tr.forward[0].label, /سوبرماركت الحي/);

    // Forward from the supplier's original lot: held, released, into the order, out as FG-7, to the customer.
    const fwd = await get(`/t/trace/batches/${lot1}`);
    const flat = (xs: { kind: string; next: unknown[] }[]): string[] => xs.flatMap((x) => [x.kind, ...flat(x.next as typeof xs)]);
    assert.deepEqual(flat(fwd.forward), ["moved", "moved", "production", "output", "customer"]);
    assert.equal((await get(`/t/trace/search?q=FG-7`)).items.length, 1);
  });

  it("preventive plans come due, parts leave stock into maintenance expense, breakdowns give MTTR", async () => {
    await receivePo(app, owner, t, { supplierId: supplier, locationId: floor, items: [{ ingredientId: spare, quantity: 10, unitPrice: 5 }] });
    const m = (await post("/t/machines", { code: code("M"), name: "خط التعبئة", workCenterId: oven, meterUnit: "ساعة" })).id;
    const monthly = (await post("/t/maintenance/plans", { machineId: m, name: "تشحيم شهري", triggerKind: "days", intervalValue: 30, plannedMinutes: 90,
      parts: [{ itemId: spare, quantity: 2 }], lastDoneOn: day(-40) })).id;
    await post("/t/maintenance/plans", { machineId: m, name: "عمرة كل 500 ساعة", triggerKind: "meter", intervalValue: 500 });
    let plans = (await get("/t/maintenance/plans")).items;
    assert.deepEqual(plans.map((p: { name: string; state: string }) => [p.name, p.state]).sort(), [["تشحيم شهري", "overdue"], ["عمرة كل 500 ساعة", "ok"]]);
    assert.equal((await post("/t/maintenance/generate", {}, 200)).created, 1);
    assert.equal((await post("/t/maintenance/generate", {}, 200)).created, 0, "not twice while one is open");

    const open = (await get("/t/maintenance/orders?status=open")).items;
    assert.equal(open.length, 1);
    const sched = await get("/t/production/schedule");
    assert.ok(sched.orders.some((o: { kind: string; moId: string }) => o.kind === "maintenance" && o.moId === open[0].id), "maintenance takes the oven's time");

    const noLoc = await call(app, owner, "POST", `/t/maintenance/orders/${open[0].id}/complete`, { tenant: t, idem: true, body: { parts: [{ itemId: spare, quantity: 2 }] } });
    assert.equal(noLoc.status, 422);
    const done = await post(`/t/maintenance/orders/${open[0].id}/complete`, { parts: [{ itemId: spare, quantity: 2 }], locationId: floor, findings: "تم" }, 200);
    assert.ok(done.journalId);
    assert.equal((await stockOf(t, floor, spare)).quantity, 8);
    assert.equal(await ledger("maintenance_expense"), 10);
    assert.equal(await ledger("inventory_spare"), 40, "50 received − 10 used");
    const again = await post(`/t/maintenance/orders/${open[0].id}/complete`, { parts: [{ itemId: spare, quantity: 2 }], locationId: floor }, 200);
    assert.equal(again.replay, true, "completing twice issues nothing twice");
    assert.equal((await stockOf(t, floor, spare)).quantity, 8);
    plans = (await get("/t/maintenance/plans")).items;
    assert.equal(plans.find((p: { id: string }) => p.id === monthly).dueOn, day(30), "restarts from today");

    // The meter only goes forward, and past the interval the overhaul is due.
    expectStatus(await call(app, owner, "POST", `/t/machines/${m}/meter`, { tenant: t, body: { reading: 520 } }), 200, "meter");
    assert.equal((await call(app, owner, "POST", `/t/machines/${m}/meter`, { tenant: t, body: { reading: 100 } })).status, 422);
    plans = (await get("/t/maintenance/plans")).items;
    assert.equal(plans.find((p: { triggerKind: string }) => p.triggerKind === "meter").state, "overdue");

    // A breakdown two hours ago, repaired now: two hours down.
    const failedAt = new Date(Date.now() - 120 * 60_000).toISOString();
    const noTime = await call(app, owner, "POST", "/t/maintenance/orders", { tenant: t, idem: true, body: { machineId: m, kind: "corrective", description: "توقف السير" } });
    assert.equal(noTime.status, 422);
    const br = (await post("/t/maintenance/orders", { machineId: m, kind: "corrective", description: "توقف السير", failedAt })).id;
    await post(`/t/maintenance/orders/${br}/complete`, {}, 200);
    const k = await get("/t/maintenance/kpis");
    const row = k.items.find((x: { machineId: string }) => x.machineId === m);
    assert.equal(row.failures, 1);
    assert.ok(Math.abs(row.mttrHours - 2) < 0.05, `MTTR ${row.mttrHours}`);
    // 90 days × 8 h = 720 h planned, 2 h down.
    assert.ok(Math.abs(row.mtbfHours - 718) < 0.05, `MTBF ${row.mtbfHours}`);
    assert.equal(k.totals.preventiveCompliance, 1);
  });
});
