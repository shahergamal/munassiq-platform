import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { call, createUser, expectStatus, ownerPool, raiseLimits, startApp, stopApp, type Actor, type App } from "./helpers.ts";

// Contracting C5: revenue over time. The WIP schedule by the output method (certified work), then by the input
// method (cost to date / estimated cost) on an onerous contract: the close books the contract liability (billed
// ahead of the work) and the rest of the expected loss as a provision; the policy locks after the first close.
describe("contracting: revenue over time and the monthly close", () => {
  let app: App;
  let owner: Actor;
  let t: string;
  let contract: string;
  const period = new Date().toISOString().slice(0, 7);
  const prevPeriod = (() => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); })();

  const post = async (url: string, body: object = {}, status = 201) => {
    const r = await call(app, owner, "POST", url, { tenant: t, idem: true, body });
    expectStatus(r, status, url);
    return r.body;
  };
  const get = async (url: string) => { const r = await call(app, owner, "GET", url, { tenant: t }); expectStatus(r, 200, url); return r.body; };
  const ledger = async (key: string) => Number((await ownerPool.query<{ b: string }>(
    `SELECT coalesce(sum(l.debit - l.credit), 0)::text AS b FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.tenant_id = $1 AND a.system_key = $2`, [t, key])).rows[0]!.b);
  const wip = async () => (await get(`/t/contracting/wip?period=${period}`)).items.find((x: { contractId: string }) => x.contractId === contract);

  before(async () => {
    app = await startApp();
    owner = await createUser();
    const r = await call(app, owner, "POST", "/tenants", { body: { companyName: "مقاولات الإيراد", sector: "contracting", taxId: `3${randomInt(10_000_000, 99_999_999)}${randomInt(100_000, 999_999)}`, city: "الرياض" } });
    expectStatus(r, 201, "tenant");
    t = r.body.id;
    await raiseLimits(t);
    await ownerPool.query("UPDATE tenants SET tax_id = '399999999900003' WHERE id = $1", [t]);
    expectStatus(await call(app, owner, "PUT", "/t/accounting/tax-profile", { tenant: t, body: {
      legalName: "مقاولات الإيراد", crNumber: "1010010000", street: "طريق الملك فهد", buildingNo: "1234", district: "العليا", city: "الرياض", postalCode: "12345" } }), 200, "profile");
    const client = (await post("/t/customers", { name: "مطور", phone: `05${randomInt(10_000_000, 99_999_999)}`, customerType: "business", vatNumber: "310123456700003",
      street: "العليا", buildingNo: "4321", district: "الملز", city: "الرياض", postalCode: "11564" })).id;
    const project = (await post("/t/projects", { code: `R${randomInt(1000, 9999)}`, name: "مجمع", specialty: "BUILDING", clientId: client })).id;
    contract = (await post("/t/contracts", { projectId: project, number: `C-${randomInt(1000, 9999)}`, title: "العقد", customerId: client, profile: "CUSTOM",
      pricingModel: "LUMP_SUM", governingRegime: "PRIVATE", value: 1_000_000 })).id;
    await post(`/t/contracts/${contract}/boq/items`, { code: "1", description: "الأعمال", unit: "ls", quantity: 1, rate: 1_000_000 });
    await post(`/t/contracts/${contract}/activate`, {}, 200);
    // Billed 300,000 (IPC 1), and 300,000 of cost on the project (a guarantee fee posts to its cost center).
    const ipc = (await post(`/t/contracts/${contract}/ipcs`, { periodFrom: `${period}-01`, periodTo: `${period}-01` })).id;
    const line = (await get(`/t/ipcs/${ipc}`)).lines.find((l: { kind: string }) => l.kind === "boq");
    expectStatus(await call(app, owner, "PUT", `/t/ipcs/${ipc}/quantities`, { tenant: t, body: { lines: [{ id: line.id, quantity: 0.3 }] } }), 200, "qty");
    await post(`/t/ipcs/${ipc}/submit`, {}, 200);
    await post(`/t/ipcs/${ipc}/approve`, {}, 200);
    await post(`/t/ipcs/${ipc}/invoice`, {});
    await post(`/t/contracts/${contract}/guarantees`, { kind: "performance", number: "LG-1", bank: "بنك", amount: 50_000, issuedOn: `${period}-01`, expiresOn: "2099-01-01",
      fee: 300_000, feePaidFrom: "bank_transfer" });
  });
  after(() => stopApp(app));

  it("output method: revenue follows the certified work", async () => {
    const w = await wip();
    assert.deepEqual([w.pct, w.revenueToDate, w.billedToDate, w.contractAsset, w.contractLiability, w.costToDate], [0.3, 300_000, 300_000, 0, 0, 300_000]);
  });

  it("input method needs the estimated cost; an onerous contract shows its expected loss", async () => {
    expectStatus(await call(app, owner, "PUT", "/t/contracting/revenue-settings", { tenant: t, body: { method: "input" } }), 200, "policy");
    assert.ok((await wip()).error, "no estimate yet");
    await post(`/t/contracts/${contract}/estimates`, { estimatedCost: 1_200_000, asOf: `${period}-01` });
    const w = await wip();
    assert.deepEqual([w.pct, w.revenueToDate, w.contractLiability, w.expectedLoss, w.provision], [0.25, 250_000, 50_000, 200_000, 150_000]);
  });

  it("the close books the contract liability and the onerous provision; periods close in order; the policy locks", async () => {
    const future = await call(app, owner, "POST", "/t/contracting/close", { tenant: t, body: { period: "2999-01" } });
    assert.equal(future.status, 422);
    const r = await post("/t/contracting/close", { period }, 200);
    assert.equal(r.closed.length, 1);
    assert.equal(await ledger("contract_liability"), -50_000);
    assert.equal(await ledger("onerous_provision"), -150_000);
    assert.equal(await ledger("onerous_loss"), 150_000);
    assert.equal(await ledger("contract_revenue"), -250_000, "revenue = 300,000 billed − 50,000 deferred");
    assert.equal((await post("/t/contracting/close", { period }, 200)).closed.length, 0, "already closed");
    assert.equal((await call(app, owner, "POST", "/t/contracting/close", { tenant: t, body: { period: prevPeriod } })).body.error?.code, "later_period_closed");
    assert.equal((await call(app, owner, "PUT", "/t/contracting/revenue-settings", { tenant: t, body: { method: "output" } })).body.error?.code, "policy_locked");
    assert.equal((await wip()).closedThisPeriod, true);
  });

  it("a close after a liability position undoes it (a negative previous position is read correctly)", async () => {
    // A second contract whose earlier month closed as a contract liability (recorded directly: periods close in order).
    const client = (await get(`/t/contracts/${contract}`)).customerId;
    const project = (await post("/t/projects", { code: `Q${randomInt(1000, 9999)}`, name: "ثانٍ", specialty: "BUILDING", clientId: client })).id;
    const k = (await post("/t/contracts", { projectId: project, number: `D-${randomInt(1000, 9999)}`, title: "الثاني", customerId: client, profile: "CUSTOM",
      pricingModel: "LUMP_SUM", governingRegime: "PRIVATE", value: 100_000 })).id;
    await post(`/t/contracts/${k}/boq/items`, { code: "1", description: "الأعمال", unit: "ls", quantity: 1, rate: 100_000 });
    await post(`/t/contracts/${k}/activate`, {}, 200);
    await post(`/t/contracts/${k}/estimates`, { estimatedCost: 80_000, asOf: `${prevPeriod}-01` });
    const owner2 = (await ownerPool.query("SELECT created_by FROM contracts WHERE id = $1", [k])).rows[0].created_by;
    await ownerPool.query(`INSERT INTO contract_closes (tenant_id, contract_id, period, method, transaction_price, estimated_cost, cost_to_date, certified_to_date, billed_to_date,
                           pct_complete, revenue_to_date, position, created_by) VALUES ($1, $2, $3, 'input', 100000, 80000, 0, 0, 10000, 0, 0, -10000, $4)`, [t, k, prevPeriod, owner2]);
    await ownerPool.query("DELETE FROM contract_closes WHERE tenant_id = $1 AND contract_id = $2 AND period = $3", [t, contract, period]).catch(() => undefined);
    const r = await call(app, owner, "POST", "/t/contracting/close", { tenant: t, body: { period } });
    assert.ok(r.status === 200, JSON.stringify(r.body));
    const e = (await ownerPool.query(`SELECT count(*)::int AS n FROM journal_entries j JOIN contract_closes x ON j.source_key = 'contract_close:' || x.id
                                      WHERE x.contract_id = $1 AND x.period = $2`, [k, period])).rows[0].n;
    assert.equal(e, 1, "the close of the next period is posted");
  });
});
