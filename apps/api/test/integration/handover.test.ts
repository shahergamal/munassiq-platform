import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { call, createUser, expectStatus, ownerPool, raiseLimits, startApp, stopApp, type Actor, type App } from "./helpers.ts";

// Contracting C12: taking over starts the DLP (and the decennial liability once its length is verified); snags and
// defects are tracked to verified; final acceptance completes the contract (only its final IPC follows), and closing
// waits for the retention and the guarantees.
describe("contracting: handover and the defects liability period", () => {
  let app: App;
  let owner: Actor;
  let t: string;
  let contract: string;
  let second: string;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh" }).format(new Date());
  const back = (n: number) => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

  const post = async (url: string, body: object = {}, status = 201) => { const r = await call(app, owner, "POST", url, { tenant: t, idem: true, body }); expectStatus(r, status, url); return r.body; };
  const get = async (url: string) => { const r = await call(app, owner, "GET", url, { tenant: t }); expectStatus(r, 200, url); return r.body; };
  const err = async (url: string, body: object = {}, method = "POST") => (await call(app, owner, method, url, { tenant: t, idem: true, body })).body.error;
  let testParam: string | null = null;
  // A verified test value for the private regime on one day only (a regime's own value wins over the ALL draft).
  const verifyFor = async (day: string) => {
    testParam = (await ownerPool.query<{ id: string }>(
      `INSERT INTO regulatory_parameters (key, regime, value, unit, label, legal_basis, source_title, confidence, effective_from, effective_to, status, verified_by, verified_at)
       VALUES ('decennial_liability_months', 'PRIVATE', 120, 'months', 'اختبار', 'مادة اختبار', 'مصدر اختبار', 'official', $1, $1, 'verified', (SELECT id FROM users LIMIT 1), now()) RETURNING id`, [day])).rows[0]!.id;
  };

  before(async () => {
    app = await startApp();
    owner = await createUser();
    const r = await call(app, owner, "POST", "/tenants", { body: { companyName: "مقاولات التسليم", sector: "contracting", taxId: `3${randomInt(10_000_000, 99_999_999)}${randomInt(100_000, 999_999)}`, city: "الرياض" } });
    expectStatus(r, 201, "tenant");
    t = r.body.id;
    await raiseLimits(t);
    const cust = (await post("/t/customers", { name: "المالك", phone: `05${randomInt(10_000_000, 99_999_999)}`, customerType: "business" })).id;
    const p = (await post("/t/projects", { code: `H${randomInt(1000, 9999)}`, name: "فيلا سكنية", specialty: "BUILDING", clientId: cust })).id;
    const make = async (n: string) => {
      const id = (await post("/t/contracts", { projectId: p, number: `${n}-${randomInt(1000, 9999)}`, title: n, customerId: cust, profile: "CUSTOM", pricingModel: "LUMP_SUM",
        governingRegime: "PRIVATE", value: 500_000, dlpMonths: 12 })).id as string;
      await post(`/t/contracts/${id}/boq/items`, { code: "A1", description: "الأعمال", unit: "ls", quantity: 1, rate: 500_000 });
      await post(`/t/contracts/${id}/activate`, {}, 200);
      return id;
    };
    contract = await make("VILLA");
    second = await make("ANNEX");
  });
  after(async () => {
    if (testParam) {
      const c = await ownerPool.connect();
      try {
        await c.query("SET session_replication_role = replica"); // the test row only; the guard protects real verified values
        await c.query("DELETE FROM regulatory_parameters WHERE id = $1", [testParam]);
      } finally { await c.query("SET session_replication_role = DEFAULT"); c.release(); }
    }
    await stopApp(app);
  });

  it("taking over starts a 12-month DLP; an unverified decennial length is pending, not assumed", async () => {
    assert.equal((await err(`/t/contracts/${contract}/handover-items`, { kind: "snag", description: "شرخ في اللياسة", reportedOn: back(1) })).code, "invalid_state", "before taking over");
    const r = await post(`/t/contracts/${contract}/taking-over`, { date: back(40), reference: "TOC-001" }, 200);
    assert.equal(r.decennialUntil, null);
    assert.ok(r.note?.includes("لم يوثّقها"));
    assert.equal((await err(`/t/contracts/${contract}/taking-over`, { date: back(40), reference: "TOC-001" })).code, "duplicate");
    const h = await get(`/t/contracts/${contract}/handover`);
    const end = new Date(`${back(40)}T00:00:00Z`); end.setUTCMonth(end.getUTCMonth() + 12);
    assert.equal(h.handover.dlpEndsOn, end.toISOString().slice(0, 10));
    assert.equal(h.decennialApplies, true);
    await verifyFor(back(10));
    const r2 = await post(`/t/contracts/${second}/taking-over`, { date: back(10), reference: "TOC-002" }, 200);
    const ten = new Date(`${back(10)}T00:00:00Z`); ten.setUTCFullYear(ten.getUTCFullYear() + 10);
    assert.equal(r2.decennialUntil, ten.toISOString().slice(0, 10), "ten years once the value is verified");
  });

  it("final acceptance waits for every item verified and the DLP, unless the owner releases early with a reason", async () => {
    const snag = (await post(`/t/contracts/${contract}/handover-items`, { kind: "snag", description: "باب غرفة النوم لا يغلق", location: "الدور الأول", reportedOn: back(40), dueOn: back(30) })).id;
    const defect = (await post(`/t/contracts/${contract}/handover-items`, { kind: "defect", description: "تسرب مياه في سقف الحمام", reportedOn: back(5) })).id;
    const list = await get(`/t/contracts/${contract}/handover`);
    assert.equal(list.items.find((i: { id: string }) => i.id === snag).overdue, true);
    const blocked = await err(`/t/contracts/${contract}/final-acceptance`, { date: back(1), reference: "FAC-001" });
    assert.equal(blocked.code, "not_ready");
    assert.equal(blocked.details.blockers.length, 2, "open items and the DLP not over");
    assert.equal((await err(`/t/handover-items/${snag}/verify`, { date: back(2) })).code, "invalid_state", "verified after it is fixed");
    for (const i of [snag, defect]) { await post(`/t/handover-items/${i}/fix`, { date: back(3) }, 200); await post(`/t/handover-items/${i}/verify`, { date: back(2) }, 200); }
    assert.deepEqual((await err(`/t/contracts/${contract}/final-acceptance`, { date: back(1), reference: "FAC-001" })).details.blockers.length, 1, "only the DLP left");
    await post(`/t/contracts/${contract}/final-acceptance`, { date: back(1), reference: "FAC-001", earlyReason: "تسليم مبكر بموافقة المالك الكتابية" }, 200);
    assert.equal((await get(`/t/contracts/${contract}/handover`)).status, "completed");
    assert.equal((await err(`/t/contracts/${contract}/handover-items`, { kind: "defect", description: "عيب بعد الاستلام", reportedOn: back(0) })).code, "final_accepted");
  });

  it("after final acceptance only the final IPC follows; closing waits for the guarantees and the IPCs", async () => {
    assert.equal((await err(`/t/contracts/${contract}/ipcs`, { periodFrom: back(1), periodTo: back(0) })).code, "invalid_state", "no interim IPC");
    const fin = (await post(`/t/contracts/${contract}/ipcs`, { periodFrom: back(1), periodTo: back(0), kind: "final" })).id;
    const g = (await post(`/t/contracts/${contract}/guarantees`, { kind: "performance", number: "LG-77", bank: "بنك تجريبي", amount: 25_000, issuedOn: back(300), expiresOn: back(-60) })).id;
    const blocked = await err(`/t/contracts/${contract}/close`);
    assert.equal(blocked.code, "not_ready");
    assert.equal(blocked.details.blockers.length, 2, "a guarantee and an IPC");
    expectStatus(await call(app, owner, "DELETE", `/t/ipcs/${fin}`, { tenant: t }), 200, "drop the draft");
    await post(`/t/guarantees/${g}/release`, { releasedOn: back(0) }, 200);
    await post(`/t/contracts/${contract}/close`, {}, 200);
    const reg = (await get("/t/contracting/handovers")).items;
    assert.equal(reg.find((r: { id: string }) => r.id === contract).status, "closed");
    assert.equal(reg.find((r: { id: string }) => r.id === second).status, "active");
  });
});
