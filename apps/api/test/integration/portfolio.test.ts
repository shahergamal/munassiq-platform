import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import ExcelJS from "exceljs";
import { after, before, describe, it } from "node:test";
import { addMember, call, createUser, expectStatus, ownerPool, raiseLimits, startApp, stopApp, type Actor, type App } from "./helpers.ts";

// Contracting C13: the portfolio report. The estimate at completion comes from earned value, the budget, or the
// contract's estimate, in that order; with none of them the margin is unknown (flagged), never zero.
describe("contracting: the executive portfolio", () => {
  let app: App;
  let owner: Actor;
  let t: string;
  let a: string;
  let b: string;
  let c: string;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh" }).format(new Date());

  const post = async (url: string, body: object = {}, status = 201) => { const r = await call(app, owner, "POST", url, { tenant: t, idem: true, body }); expectStatus(r, status, url); return r.body; };
  const get = async (url: string) => { const r = await call(app, owner, "GET", url, { tenant: t }); expectStatus(r, 200, url); return r.body; };

  before(async () => {
    app = await startApp();
    owner = await createUser();
    const r = await call(app, owner, "POST", "/tenants", { body: { companyName: "مقاولات المحفظة", sector: "contracting", taxId: `3${randomInt(10_000_000, 99_999_999)}${randomInt(100_000, 999_999)}`, city: "الرياض" } });
    expectStatus(r, 201, "tenant");
    t = r.body.id;
    await raiseLimits(t);
    const cust = (await post("/t/customers", { name: "المالك", phone: `05${randomInt(10_000_000, 99_999_999)}`, customerType: "business" })).id;
    const project = async (code: string, value: number | null) => {
      const id = (await post("/t/projects", { code: `${code}${randomInt(100, 999)}`, name: `مشروع ${code}`, specialty: "BUILDING", clientId: cust })).id as string;
      let contract: string | null = null;
      if (value) {
        contract = (await post("/t/contracts", { projectId: id, number: `${code}-${randomInt(1000, 9999)}`, title: code, customerId: cust, profile: "CUSTOM", pricingModel: "LUMP_SUM",
          governingRegime: "PRIVATE", value })).id as string;
        await post(`/t/contracts/${contract}/boq/items`, { code: "X1", description: "الأعمال", unit: "ls", quantity: 1, rate: value });
        await post(`/t/contracts/${contract}/activate`, {}, 200);
      }
      return { id, contract };
    };
    const pa = await project("PA", 1_000_000);
    a = pa.id;
    await post(`/t/contracts/${pa.contract}/estimates`, { estimatedCost: 900_000, asOf: today });
    const ipc = (await post(`/t/contracts/${pa.contract}/ipcs`, { periodFrom: `${today.slice(0, 7)}-01`, periodTo: today })).id;
    const line = (await get(`/t/ipcs/${ipc}`)).lines.find((l: { kind: string }) => l.kind === "boq").id;
    expectStatus(await call(app, owner, "PUT", `/t/ipcs/${ipc}/quantities`, { tenant: t, body: { lines: [{ id: line, quantity: 0.2 }] } }), 200, "qty");
    await post(`/t/ipcs/${ipc}/submit`, {}, 200);
    await post(`/t/ipcs/${ipc}/approve`, {}, 200);
    const pb = await project("PB", 500_000);
    b = pb.id;
    const codes = (await get("/t/contracting/reference")).costCodes as { id: string; code: string }[];
    expectStatus(await call(app, owner, "PUT", `/t/projects/${b}/budget`, { tenant: t, body: { lines: [{ costCodeId: codes.find((x) => x.code === "MAT")!.id, amount: 550_000 }] } }), 200, "budget");
    const cc = (await get(`/t/projects/${b}`)).costCenterId;
    const acc = async (sql: string) => (await ownerPool.query<{ id: string }>(sql, [t])).rows[0]!.id;
    await post("/t/accounting/journal", { date: today, description: "تكلفة", lines: [
      { accountId: await acc("SELECT id FROM accounts WHERE tenant_id = $1 AND type = 'expense' AND NOT is_group AND is_active ORDER BY code LIMIT 1"), debit: 100_000, credit: 0, costCenterId: cc },
      { accountId: await acc("SELECT id FROM accounts WHERE tenant_id = $1 AND system_key = 'cash'"), debit: 0, credit: 100_000 }] });
    c = (await project("PC", 300_000)).id;
  });
  after(() => stopApp(app));

  it("each project's estimate at completion and margin, with the flags", async () => {
    const p = await get("/t/contracting/portfolio");
    const row = (id: string) => p.items.find((x: { id: string }) => x.id === id);
    assert.deepEqual([row(a).eacBasis, row(a).eac, row(a).margin, row(a).marginPct, row(a).certified, row(a).progressPct, row(a).backlog], ["estimate", 900_000, 100_000, 10, 200_000, 20, 800_000]);
    assert.deepEqual([row(b).eacBasis, row(b).costToDate, row(b).eac, row(b).margin], ["budget", 100_000, 550_000, -50_000]);
    assert.ok(row(b).flags.includes("loss"));
    assert.deepEqual([row(c).eac, row(c).margin, row(c).flags], [null, null, ["no_estimate"]]);
    assert.equal(p.totals.contractValue, 1_800_000);
    assert.equal(p.totals.margin, 50_000, "the known margins only");
    assert.equal(p.totals.unknownMargin, 1);
  });

  it("exports the portfolio to Excel; the cash forecast spans the months asked", async () => {
    const x = await app.inject({ method: "GET", url: "/api/v1/t/contracting/portfolio.xlsx", headers: { cookie: `mn_sid=${owner.token}`, "x-tenant-id": t }, remoteAddress: owner.ip });
    assert.equal(x.statusCode, 200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.rawPayload as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    assert.equal(ws.rowCount, 1 + 3 + 1, "header, three projects, totals");
    assert.equal(ws.getRow(5).getCell(1).value, "الإجمالي");
    const f = await get("/t/contracting/cash-forecast?months=6");
    assert.equal(f.items.length, 6);
    assert.equal(f.projects.length, 3);
    // The free built-in assistant answers from the same report, flagging the loss.
    const chat = await call(app, owner, "POST", "/t/assistant/chat", { tenant: t, body: { message: "ما هامش مشاريعي وأيها خاسر؟" } });
    expectStatus(chat, 200, "assistant");
    const ev = String(chat.body).split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
    assert.ok(ev.some((e) => e.type === "tool" && e.name === "contracting_portfolio"), "reads the portfolio");
    assert.ok(ev.filter((e) => e.type === "text").map((e) => e.delta).join("").includes("خسارة متوقعة"));
    const clerk = await addMember(app, owner, t, "inventory_clerk");
    expectStatus(await call(app, clerk, "GET", "/t/contracting/portfolio", { tenant: t }), 403, "not the storekeeper's");
  });
});
