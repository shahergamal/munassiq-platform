import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { call, code, createIngredient, createUser, expectStatus, ownerPool, raiseLimits, receivePo, startApp, stopApp, type Actor, type App } from "./helpers.ts";

// Contracting C7: a site store, materials issued to a project on its BOQ item (and returned at the project's cost),
// consumption against the BOQ's norms, local content, and equipment charged to the project by its timesheet.
describe("contracting: site materials and equipment", () => {
  let app: App;
  let owner: Actor;
  let t: string;
  let project: string;
  let site: string;
  let cement: string;
  let item: string;
  let contract: string;
  const today = new Date().toISOString().slice(0, 10);

  const post = async (url: string, body: object = {}, status = 201) => {
    const r = await call(app, owner, "POST", url, { tenant: t, idem: true, body });
    expectStatus(r, status, url);
    return r.body;
  };
  const put = async (url: string, body: object) => expectStatus(await call(app, owner, "PUT", url, { tenant: t, body }), 200, url);
  const get = async (url: string) => { const r = await call(app, owner, "GET", url, { tenant: t }); expectStatus(r, 200, url); return r.body; };
  const ledger = async (key: string) => Number((await ownerPool.query<{ b: string }>(
    `SELECT coalesce(sum(l.debit - l.credit), 0)::text AS b FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.tenant_id = $1 AND a.system_key = $2`, [t, key])).rows[0]!.b);

  before(async () => {
    app = await startApp();
    owner = await createUser();
    const r = await call(app, owner, "POST", "/tenants", { body: { companyName: "مقاولات الموقع", sector: "contracting", taxId: `3${randomInt(10_000_000, 99_999_999)}${randomInt(100_000, 999_999)}`, city: "الرياض" } });
    expectStatus(r, 201, "tenant");
    t = r.body.id;
    await raiseLimits(t);
    const client = (await post("/t/customers", { name: "مطور", phone: `05${randomInt(10_000_000, 99_999_999)}` })).id;
    project = (await post("/t/projects", { code: `M${randomInt(1000, 9999)}`, name: "فيلا", specialty: "BUILDING", clientId: client })).id;
    contract = (await post("/t/contracts", { projectId: project, number: `C-${randomInt(1000, 9999)}`, title: "العقد", customerId: client, profile: "CUSTOM",
      pricingModel: "UNIT_PRICE", governingRegime: "PRIVATE", value: 50_000 })).id;
    item = (await post(`/t/contracts/${contract}/boq/items`, { code: "1", description: "لياسة", unit: "m2", quantity: 100, rate: 500 })).id;
    await post(`/t/contracts/${contract}/activate`, {}, 200);
    site = (await post("/t/locations", { code: code("SITE"), name: "مخزن موقع الفيلا", locationType: "site", projectId: project })).id;
    cement = await createIngredient(app, owner, t, "أسمنت", "kg", "ton");
    const sup = (await post("/t/suppliers", { code: code("S"), name: "مصنع الأسمنت" })).id;
    await receivePo(app, owner, t, { supplierId: sup, locationId: site, items: [{ ingredientId: cement, quantity: 1, unitPrice: 2_000 }] }); // 1 ton = 1000 kg at 2/kg
    // 20 m² certified so far.
    const ipc = (await post(`/t/contracts/${contract}/ipcs`, { periodFrom: today, periodTo: today })).id;
    const line = (await get(`/t/ipcs/${ipc}`)).lines.find((l: { kind: string }) => l.kind === "boq");
    await put(`/t/ipcs/${ipc}/quantities`, { lines: [{ id: line.id, quantity: 20 }] });
    await post(`/t/ipcs/${ipc}/submit`, {}, 200);
    await post(`/t/ipcs/${ipc}/approve`, {}, 200);
  });
  after(() => stopApp(app));

  it("a site store belongs to a project; materials are issued to it on the BOQ item, and returned at the project's cost", async () => {
    const orphan = await call(app, owner, "POST", "/t/locations", { tenant: t, body: { code: code("X"), name: "موقع بلا مشروع", locationType: "site" } });
    assert.equal(orphan.status, 422, "a site store needs its project");
    await post("/t/site-issues", { kind: "issue", projectId: project, locationId: site, lines: [{ ingredientId: cement, quantity: 110, boqItemId: item }] });
    assert.equal(await ledger("contract_materials"), 220);
    const mat = (await ownerPool.query("SELECT count(*)::int AS n FROM journal_lines l JOIN cost_codes c ON c.id = l.cost_code_id WHERE l.tenant_id = $1 AND c.code = 'MAT'", [t])).rows[0].n;
    assert.ok(mat > 0, "on the MAT cost code");
    await post("/t/site-issues", { kind: "return", projectId: project, locationId: site, lines: [{ ingredientId: cement, quantity: 10, boqItemId: item }] });
    assert.equal(await ledger("contract_materials"), 200);
    const over = await call(app, owner, "POST", "/t/site-issues", { tenant: t, idem: true, body: { kind: "return", projectId: project, locationId: site, lines: [{ ingredientId: cement, quantity: 101 }] } });
    assert.equal(over.body.error?.code, "exceeds_issued");
    const tooMuch = await call(app, owner, "POST", "/t/site-issues", { tenant: t, idem: true, body: { kind: "issue", projectId: project, locationId: site, lines: [{ ingredientId: cement, quantity: 5_000 }] } });
    assert.equal(tooMuch.body.error?.code, "insufficient_stock");
  });

  it("consumption against the norm of the certified work", async () => {
    await put(`/t/boq-items/${item}/norms`, { norms: [{ ingredientId: cement, qtyPerUnit: 4.5 }] });
    const c = (await get(`/t/contracts/${contract}/consumption`)).items[0];
    assert.deepEqual([c.certifiedQty, c.theoretical, c.issuedQty, c.variance, c.wastePct], [20, 90, 100, 10, 11.11]);
  });

  it("local content: the value carried by a valid certificate", async () => {
    await put(`/t/ingredients/${cement}/local-content`, { mandatoryList: true, certificate: "LC-2026-77", pct: 60, validTo: "2099-12-31" });
    const lc = await get(`/t/projects/${project}/local-content`);
    assert.deepEqual([lc.total, lc.localValue, lc.localPct], [200, 120, 60]);
  });

  it("equipment: a day on the project at the internal rate, one day per machine, and its utilisation", async () => {
    const m = (await post("/t/machines", { code: code("EX"), name: "حفار" })).id;
    await put(`/t/machines/${m}/equipment`, { ownership: "owned", hourlyRate: 200, idleRatePct: 50 });
    await post("/t/equipment-timesheets", { machineId: m, projectId: project, workDate: today, operatingHours: 6, idleHours: 2, fuelLiters: 40 });
    assert.equal(await ledger("contract_equipment"), 1_400);
    assert.equal(await ledger("equipment_recovery"), -1_400);
    const again = await call(app, owner, "POST", "/t/equipment-timesheets", { tenant: t, body: { machineId: m, projectId: project, workDate: today, operatingHours: 1 } });
    assert.equal(again.body.error?.code, "duplicate");
    const e = (await get(`/t/equipment?from=${today}&to=${today}`)).items.find((x: { id: string }) => x.id === m);
    assert.deepEqual([e.operatingHours, e.utilisation, e.charged, e.fuelLiters], [6, 75, 1_400, 40]);
  });
});
