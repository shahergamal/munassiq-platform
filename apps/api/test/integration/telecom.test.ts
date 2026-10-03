import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { after, before, describe, it } from "node:test";
import { call, createUser, expectStatus, raiseLimits, startApp, stopApp, type Actor, type App } from "./helpers.ts";

async function sitesFile(rows: (string | number)[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sites");
  ws.addRow(["الرمز", "الاسم", "المنطقة", "النوع", "خط العرض", "خط الطول"]);
  for (const r of rows) ws.addRow(r);
  const file = Buffer.from(await wb.xlsx.writeBuffer());
  const boundary = `----munassiq${randomUUID()}`;
  const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sites.xlsx"\r\nContent-Type: application/octet-stream\r\n\r\n`), file, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return { payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

// Contracting C11: a telecom rollout under a rate-card contract. Sites are imported, scoped from the rate card and
// moved through their states (PAC/FAC with certificates); the milestone terms fill a draft IPC from the sites.
describe("contracting: telecom rollout", () => {
  let app: App;
  let owner: Actor;
  let t: string;
  let p: string;
  let contract: string;
  let items: { id: string; code: string }[];
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh" }).format(new Date());
  const back = (n: number) => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

  const post = async (url: string, body: object = {}, status = 201) => { const r = await call(app, owner, "POST", url, { tenant: t, idem: true, body }); expectStatus(r, status, url); return r.body; };
  const put = async (url: string, body: object, status = 200) => { const r = await call(app, owner, "PUT", url, { tenant: t, body }); expectStatus(r, status, url); return r.body; };
  const get = async (url: string) => { const r = await call(app, owner, "GET", url, { tenant: t }); expectStatus(r, 200, url); return r.body; };
  const code = async (method: string, url: string, body: object = {}) => (await call(app, owner, method, url, { tenant: t, idem: true, body })).body.error?.code;
  const advance = (site: string, to: string, date: string, reference?: string) => post(`/t/telecom-sites/${site}/advance`, { to, date, reference }, 200);

  before(async () => {
    app = await startApp();
    owner = await createUser();
    const r = await call(app, owner, "POST", "/tenants", { body: { companyName: "اتصالات المقاولات", sector: "contracting", taxId: `3${randomInt(10_000_000, 99_999_999)}${randomInt(100_000, 999_999)}`, city: "الرياض" } });
    expectStatus(r, 201, "tenant");
    t = r.body.id;
    await raiseLimits(t);
    const cust = (await post("/t/customers", { name: "مشغل الاتصالات", phone: `05${randomInt(10_000_000, 99_999_999)}`, customerType: "business", vatNumber: "310123456700003",
      street: "العليا", buildingNo: "4321", district: "الملز", city: "الرياض", postalCode: "11564" })).id;
    p = (await post("/t/projects", { code: `TL${randomInt(100, 999)}`, name: "توسعة شبكة الجيل الخامس", specialty: "TELECOM_SITE", clientId: cust })).id;
    contract = (await post("/t/contracts", { projectId: p, number: `5G-${randomInt(1000, 9999)}`, title: "إطار نشر المواقع", customerId: cust, profile: "CUSTOM", pricingModel: "RATE_CARD",
      governingRegime: "PRIVATE", value: 260_000 })).id;
    await post(`/t/contracts/${contract}/boq/items`, { code: "T1", description: "تركيب محطة كاملة", unit: "site", quantity: 2, rate: 100_000 });
    await post(`/t/contracts/${contract}/boq/items`, { code: "T2", description: "ألياف بصرية", unit: "m", quantity: 300, rate: 200 });
    await post(`/t/contracts/${contract}/activate`, {}, 200);
    items = (await get(`/t/contracts/${contract}/boq`)).items;
  });
  after(() => stopApp(app));

  it("imports sites from Excel all or nothing, and only on a telecom project", async () => {
    const bad = await sitesFile([["S-001", "حي النرجس", "الرياض", "سطح", 24.8, 46.6], ["S-001", "مكرر", "الرياض", "سطح", "", ""], ["S 3", "رمز خاطئ", "", "قمر", 99, 0]]);
    const rb = await call(app, owner, "POST", `/t/projects/${p}/sites/import?contractId=${contract}`, { tenant: t, body: bad.payload, headers: bad.headers });
    assert.equal(rb.body.error?.code, "import_invalid");
    assert.ok(rb.body.error.details.errors.length >= 3);
    assert.equal((await get(`/t/projects/${p}/sites`)).items.length, 0, "nothing imported");
    const good = await sitesFile([["S-001", "حي النرجس", "الرياض", "سطح", 24.8, 46.6], ["S-002", "حي الملقا", "الرياض", "greenfield", "", ""], ["S-003", "مول الواحة", "الرياض", "داخلي", "", ""]]);
    const r = await call(app, owner, "POST", `/t/projects/${p}/sites/import?contractId=${contract}`, { tenant: t, body: good.payload, headers: good.headers });
    expectStatus(r, 200, "import");
    assert.equal(r.body.sites, 3);
    const other = (await post("/t/projects", { code: `BL${randomInt(100, 999)}`, name: "مبنى", specialty: "BUILDING" })).id;
    assert.equal(await code("POST", `/t/projects/${other}/sites`, { code: "X1", name: "موقع", siteType: "rooftop" }), "not_telecom");
  });

  it("moves sites forward with dated events; PAC needs its certificate; scope freezes on air", async () => {
    const sites = (await get(`/t/projects/${p}/sites`)).items as { id: string; code: string }[];
    const [s1, s2, s3] = ["S-001", "S-002", "S-003"].map((c) => sites.find((s) => s.code === c)!.id) as [string, string, string];
    const t1 = items.find((i) => i.code === "T1")!.id, t2 = items.find((i) => i.code === "T2")!.id;
    for (const s of [s1, s2]) await put(`/t/telecom-sites/${s}/items`, { items: [{ boqItemId: t1, quantity: 1 }, { boqItemId: t2, quantity: 100 }] });
    assert.equal(await code("POST", `/t/telecom-sites/${s3}/advance`, { to: "on_air", date: back(5) }), "validation_failed", "no scope, no on air");
    await advance(s1, "survey", back(30));
    await advance(s1, "installation", back(20));
    assert.equal(await code("POST", `/t/telecom-sites/${s1}/advance`, { to: "cancelled", date: back(19), note: "إلغاء" }), "invalid_transition", "installation is billable: no cancelling");
    assert.equal(await code("PUT", `/t/telecom-sites/${s1}/items`, { items: [{ boqItemId: t1, quantity: 2 }] }), "site_scope_frozen", "scope frozen from installation");
    assert.equal(await code("POST", `/t/telecom-sites/${s1}/advance`, { to: "survey", date: back(19) }), "invalid_transition", "no going back");
    assert.equal(await code("POST", `/t/telecom-sites/${s1}/advance`, { to: "pac", date: back(19), reference: "PAC-1" }), "invalid_transition", "PAC after on air");
    await advance(s1, "on_air", back(15));
    assert.equal(await code("POST", `/t/telecom-sites/${s1}/advance`, { to: "pac", date: back(10) }), "validation_failed", "PAC needs the certificate");
    await advance(s1, "pac", back(10), "PAC-2026-001");
    await advance(s2, "on_air", back(3));
    assert.equal(await code("PUT", `/t/telecom-sites/${s2}/items`, { items: [{ boqItemId: t1, quantity: 2 }] }), "site_scope_frozen");
    assert.equal(await code("POST", `/t/telecom-sites/${s2}/advance`, { to: "cancelled", date: back(1), note: "إلغاء" }), "invalid_transition", "not cancelled once on air");
    await post(`/t/telecom-sites/${s3}/advance`, { to: "cancelled", date: back(1), note: "رفض المالك التأجير" }, 200);
    const d = await get(`/t/telecom-sites/${s1}`);
    assert.deepEqual(d.events.map((e: { to: string }) => e.to), ["planned", "survey", "installation", "on_air", "pac"]);
  });

  it("milestone terms fill a draft IPC from the sites; terms lock once an IPC is approved", async () => {
    assert.equal(await code("PUT", `/t/contracts/${contract}/milestone-terms`, { items: [{ milestone: "on_air", pct: 60 }, { milestone: "pac", pct: 30 }] }), "validation_failed", "must total 100%");
    await put(`/t/contracts/${contract}/milestone-terms`, { items: [{ milestone: "on_air", pct: 60 }, { milestone: "pac", pct: 30 }, { milestone: "fac", pct: 10 }] });
    const list = await get(`/t/projects/${p}/sites`);
    // S-001 at PAC (90%) and S-002 on air (60%): each 1 × 100,000 + 100 m × 200 = 120,000.
    assert.equal(list.totals.billable, 120_000 * 0.9 + 120_000 * 0.6);
    assert.equal(list.byStatus.cancelled, 1);
    const ipc = (await post(`/t/contracts/${contract}/ipcs`, { periodFrom: back(30), periodTo: back(5) })).id;
    const f = await post(`/t/ipcs/${ipc}/fill-from-sites`, {}, 200);
    assert.equal(f.lines, 2);
    const d = await get(`/t/ipcs/${ipc}`);
    const qty = (c: string) => Number(d.lines.find((l: { code: string }) => l.code === c).submittedQty);
    // By the period's end (5 days ago) S-002 was not yet on air (3 days ago): only S-001 at PAC counts.
    assert.deepEqual([qty("T1"), qty("T2")], [0.9, 90]);
    await post(`/t/ipcs/${ipc}/submit`, {}, 200);
    await post(`/t/ipcs/${ipc}/approve`, {}, 200);
    assert.equal(await code("PUT", `/t/contracts/${contract}/milestone-terms`, { items: [{ milestone: "on_air", pct: 100 }] }), "terms_locked");
    assert.equal(await code("POST", `/t/ipcs/${ipc}/fill-from-sites`), "invalid_state", "only a draft is filled");
    // The next period ends today: each site counts at the furthest state it reached (S-001 PAC, S-002 on air), even
    // though their "planned" registration is dated today.
    const next = (await post(`/t/contracts/${contract}/ipcs`, { periodFrom: back(4), periodTo: today })).id;
    await post(`/t/ipcs/${next}/fill-from-sites`, {}, 200);
    const n = await get(`/t/ipcs/${next}`);
    const nq = (c: string) => Number(n.lines.find((l: { code: string }) => l.code === c).submittedQty);
    assert.deepEqual([nq("T1"), nq("T2")], [1.5, 150]);
    assert.equal(n.totals.currentGross, 0.6 * 120_000);
  });
});
