import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { call, createUser, expectStatus, ownerPool, raiseLimits, startApp, stopApp, type Actor, type App } from "./helpers.ts";

// Contracting C6: a tender priced by rate build-up, submitted (frozen), won, and converted into a project and a draft
// main contract whose BOQ equals the offer and whose estimated cost is the cost without profit.
describe("contracting: tenders", () => {
  let app: App;
  let owner: Actor;
  let t: string;
  let client: string;
  let tender: string;

  const post = async (url: string, body: object = {}, status = 201) => {
    const r = await call(app, owner, "POST", url, { tenant: t, idem: true, body });
    expectStatus(r, status, url);
    return r.body;
  };
  const put = async (url: string, body: object) => expectStatus(await call(app, owner, "PUT", url, { tenant: t, body }), 200, url);
  const get = async (url: string) => { const r = await call(app, owner, "GET", url, { tenant: t }); expectStatus(r, 200, url); return r.body; };

  before(async () => {
    app = await startApp();
    owner = await createUser();
    const r = await call(app, owner, "POST", "/tenants", { body: { companyName: "مقاولات العطاءات", sector: "contracting", taxId: `3${randomInt(10_000_000, 99_999_999)}${randomInt(100_000, 999_999)}`, city: "الرياض" } });
    expectStatus(r, 201, "tenant");
    t = r.body.id;
    await raiseLimits(t);
    client = (await post("/t/customers", { name: "مطور", phone: `05${randomInt(10_000_000, 99_999_999)}`, customerType: "business", vatNumber: "310123456700003",
      street: "العليا", buildingNo: "4321", district: "الملز", city: "الرياض", postalCode: "11564" })).id;
  });
  after(() => stopApp(app));

  it("prices a tender from its resources and markups", async () => {
    tender = (await post("/t/tenders", { number: `T-${randomInt(1000, 9999)}`, title: "مبنى مدرسة", customerId: client, specialty: "BUILDING", overheadPct: 10, riskPct: 5, profitPct: 10 })).id;
    const sec = (await post(`/t/tenders/${tender}/items`, { code: "1", description: "الخرسانة", isSection: true })).id;
    const conc = (await post(`/t/tenders/${tender}/items`, { parentId: sec, code: "1.1", description: "خرسانة مسلحة", unit: "m3", quantity: 100 })).id;
    await put(`/t/tender-items/${conc}/resources`, { resources: [
      { kind: "material", description: "خرسانة جاهزة", unit: "m3", quantity: 1, unitCost: 250, wastePct: 4 },
      { kind: "labor", description: "عمالة صب", quantity: 0.5, unitCost: 40 },
    ] });
    await post(`/t/tenders/${tender}/items`, { code: "2", description: "تجهيز الموقع", unit: "ls", quantity: 1, directRate: 10_000 });
    const d = await get(`/t/tenders/${tender}`);
    const item = d.items.find((i: { code: string }) => i.code === "1.1");
    assert.equal(item.directCost, 280, "260 concrete with waste + 20 labour");
    assert.equal(item.rate, Math.round(Math.round(Math.round(28_000 * 1.1) * 1.05) * 1.1) / 100);
    assert.equal(d.items.find((i: { code: string }) => i.code === "1").amount, item.amount, "the section adds up its items");
    assert.equal(d.totals.margin, Math.round((d.totals.total - d.totals.cost) * 100) / 100);
    assert.equal(d.totals.byKind.labor, 2_000);
  });

  it("submitting freezes the offer; a won tender becomes a contract with the priced BOQ and its estimated cost", async () => {
    const offer = (await post(`/t/tenders/${tender}/submit`, {}, 200)).total;
    const edit = await call(app, owner, "POST", `/t/tenders/${tender}/items`, { tenant: t, body: { code: "3", description: "إضافة", unit: "ls", quantity: 1, directRate: 1 } });
    assert.equal(edit.body.error?.code, "tender_locked");
    const early = await call(app, owner, "POST", `/t/tenders/${tender}/convert`, { tenant: t, body: { newProject: { code: "X1", name: "سكن" }, contractNumber: "C1", profile: "CUSTOM", pricingModel: "UNIT_PRICE" } });
    assert.equal(early.status, 409, JSON.stringify(early.body));
    await post(`/t/tenders/${tender}/outcome`, { status: "won" }, 200);
    const code = `SCH${randomInt(100, 999)}`;
    const c = await post(`/t/tenders/${tender}/convert`, { newProject: { code, name: "مدرسة الحي" }, contractNumber: `C-${randomInt(1000, 9999)}`, profile: "CUSTOM", pricingModel: "UNIT_PRICE" });
    const k = await get(`/t/contracts/${c.contractId}`);
    assert.equal(k.value, offer);
    assert.equal(k.figures.boqTotal, offer, "the BOQ adds up to the offer");
    const d = await get(`/t/tenders/${tender}`);
    const est = (await get(`/t/contracts/${c.contractId}/estimates`)).items[0];
    assert.equal(est.estimatedCost, d.totals.cost);
    await post(`/t/contracts/${c.contractId}/activate`, {}, 200);
    const again = await call(app, owner, "POST", `/t/tenders/${tender}/convert`, { tenant: t, body: { newProject: { code: "X2", name: "سكن" }, contractNumber: "C2", profile: "CUSTOM", pricingModel: "UNIT_PRICE" } });
    assert.equal(again.status, 409);
    const cc = (await ownerPool.query("SELECT kind FROM cost_centers WHERE tenant_id = $1 AND code = $2", [t, code])).rows[0];
    assert.equal(cc.kind, "project");
    const list = await get("/t/tenders");
    assert.equal(list.winRate, 100);
  });
});
