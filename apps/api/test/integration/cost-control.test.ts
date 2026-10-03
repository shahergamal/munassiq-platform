import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { addMember, call, createUser, expectStatus, ownerPool, raiseLimits, startApp, stopApp, type Actor, type App } from "./helpers.ts";

function multipart(text: string, filename: string) {
  const boundary = `----munassiq${randomUUID()}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    Buffer.from(text, "utf8"), Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return { payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

// Contracting C9: the programme from P6, progress from the site, the budget per cost code, cost control from the
// ledger, earned value with monthly snapshots, and the cash-flow forecast.
describe("contracting: schedule and cost control", () => {
  let app: App;
  let owner: Actor;
  let t: string;
  let p: string;
  const month = (offset: number) => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + offset); return d.toISOString().slice(0, 7); };
  const m2 = month(-2), m1 = month(-1), next = month(1);
  const xer = (pct: string) => ["ERMHDR\t19.12", "%T\tPROJWBS", "%F\twbs_id\tparent_wbs_id\twbs_short_name\twbs_name\tproj_node_flag",
    "%R\t1\t\tPRJ\tالمشروع\tY", "%R\t2\t1\tCIV\tالأعمال المدنية\tN",
    "%T\tTASK", "%F\ttask_code\ttask_name\twbs_id\ttarget_start_date\ttarget_end_date\tphys_complete_pct\tact_start_date\tact_end_date",
    `%R\tA100\tالحفر\t2\t${m2}-01 08:00\t${m1}-15 17:00\t${pct}\t${pct === "0" ? "" : `${m2}-01 08:00`}\t`,
    `%R\tA200\tالخرسانة\t2\t${m1}-01 08:00\t${next}-28 17:00\t0\t\t`].join("\r\n");

  const post = async (url: string, body: object = {}, status = 201) => { const r = await call(app, owner, "POST", url, { tenant: t, idem: true, body }); expectStatus(r, status, url); return r.body; };
  const put = async (url: string, body: object, status = 200) => { const r = await call(app, owner, "PUT", url, { tenant: t, body }); expectStatus(r, status, url); return r.body; };
  const get = async (url: string) => { const r = await call(app, owner, "GET", url, { tenant: t }); expectStatus(r, 200, url); return r.body; };

  before(async () => {
    app = await startApp();
    owner = await createUser();
    const r = await call(app, owner, "POST", "/tenants", { body: { companyName: "مقاولات التحكم", sector: "contracting", taxId: `3${randomInt(10_000_000, 99_999_999)}${randomInt(100_000, 999_999)}`, city: "الرياض" } });
    expectStatus(r, 201, "tenant");
    t = r.body.id;
    await raiseLimits(t);
    p = (await post("/t/projects", { code: `CC${randomInt(100, 999)}`, name: "برج التحكم", specialty: "BUILDING" })).id;
  });
  after(() => stopApp(app));

  it("imports a P6 programme with its WBS tree; a re-import keeps the site's progress", async () => {
    const f = multipart(xer("0"), "programme.xer");
    const r = await call(app, owner, "POST", `/t/projects/${p}/schedule/import`, { tenant: t, body: f.payload, headers: f.headers });
    expectStatus(r, 200, "import");
    assert.deepEqual([r.body.activities, r.body.summaries], [2, 1]);
    let s = await get(`/t/projects/${p}/schedule`);
    assert.deepEqual(s.items.map((a: { code: string; depth: number }) => [a.code, a.depth]), [["WBS-CIV", 0], ["A100", 1], ["A200", 1]]);
    const a100 = s.items.find((a: { code: string }) => a.code === "A100");
    assert.equal(a100.late, true, "planned to finish last month, nothing reported");
    await put(`/t/schedule-activities/${a100.id}/progress`, { pctComplete: 100, actualStart: `${m2}-03`, actualFinish: `${m1}-10` });
    await put(`/t/schedule-activities/${a100.id}/progress`, { pctComplete: 50 }, 422);
    // The same file again: names and dates from the file, progress stays the site's.
    const again = multipart(xer("0"), "programme.xer");
    expectStatus(await call(app, owner, "POST", `/t/projects/${p}/schedule/import`, { tenant: t, body: again.payload, headers: again.headers }), 200, "re-import");
    s = await get(`/t/projects/${p}/schedule`);
    const kept = s.items.find((a: { code: string }) => a.code === "A100");
    assert.equal(kept.pctComplete, 100);
    assert.equal(kept.late, false);
    const bad = multipart("not a schedule", "x.xml");
    expectStatus(await call(app, owner, "POST", `/t/projects/${p}/schedule/import`, { tenant: t, body: bad.payload, headers: bad.headers }), 422, "unreadable");
  });

  it("budgets by cost code; cost control shows actual from the ledger and the forecast", async () => {
    const ref = await get("/t/contracting/reference");
    const code = (c: string) => ref.costCodes.find((x: { code: string }) => x.code === c).id as string;
    await put(`/t/projects/${p}/budget`, { lines: [{ costCodeId: code("MAT"), amount: 600_000 }, { costCodeId: code("LAB"), amount: 400_000 }] });
    await put(`/t/projects/${p}/budget`, { lines: [{ costCodeId: code("MAT"), amount: 1 }, { costCodeId: code("MAT"), amount: 2 }] }, 422);
    // A cost on the project: a manual entry to an expense account on the project's cost center.
    const cc = (await get(`/t/projects/${p}`)).costCenterId as string;
    const acc = async (sql: string) => (await ownerPool.query<{ id: string }>(sql, [t])).rows[0]!.id;
    const expense = await acc("SELECT id FROM accounts WHERE tenant_id = $1 AND type = 'expense' AND NOT is_group AND is_active ORDER BY code LIMIT 1");
    const cash = await acc("SELECT id FROM accounts WHERE tenant_id = $1 AND system_key = 'cash'");
    await post("/t/accounting/journal", { date: `${m1}-20`, description: "تكلفة على المشروع", lines: [
      { accountId: expense, debit: 250_000, credit: 0, costCenterId: cc }, { accountId: cash, debit: 0, credit: 250_000 }] });
    const c = await get(`/t/projects/${p}/cost-control`);
    assert.equal(c.totals.budget, 1_000_000);
    assert.equal(c.totals.actual, 250_000);
    const mat = c.lines.find((l: { costCode: string }) => l.costCode === "MAT");
    assert.deepEqual([mat.budget, mat.actual, mat.forecast], [600_000, 0, 600_000]);
    const unc = c.lines.find((l: { costCodeId: string | null }) => l.costCodeId === null);
    assert.equal(unc.actual, 250_000, "a cost without a cost code is shown, not lost");
    assert.equal(c.totals.forecast, 1_250_000);
  });

  it("earned value from the programme and the ledger; month snapshots are final", async () => {
    const e = await get(`/t/projects/${p}/evm`);
    assert.equal(e.budgeted, "project");
    assert.equal(e.bac, 1_000_000);
    assert.equal(e.ac, 250_000);
    assert.ok(e.ev > 0 && e.ev < e.bac, "A100 is done, A200 not started");
    assert.ok(e.pv > e.ev, "A200 should have started");
    assert.ok(e.spi < 1);
    assert.equal(e.cpi, Math.round((e.ev / e.ac) * 1000) / 1000);
    assert.ok(e.curve.length >= 4);
    const snap = await post(`/t/projects/${p}/evm/snapshot`, { period: m1 }, 200);
    assert.equal(snap.ac, 250_000);
    assert.equal((await call(app, owner, "POST", `/t/projects/${p}/evm/snapshot`, { tenant: t, idem: true, body: { period: m1 } })).body.error?.code, "duplicate");
    expectStatus(await call(app, owner, "POST", `/t/projects/${p}/evm/snapshot`, { tenant: t, idem: true, body: { period: month(0) } }), 422, "current month");
    const after = await get(`/t/projects/${p}/evm`);
    assert.equal(after.curve.find((x: { period: string }) => x.period === m1).ac, 250_000);
    await assert.rejects(ownerPool.query("UPDATE evm_snapshots SET ac = 0 WHERE tenant_id = $1", [t]), "snapshots are append-only");
  });

  it("forecasts the cash flow; the accountant reads but does not change the programme", async () => {
    const cf = await get(`/t/projects/${p}/cashflow?months=6`);
    assert.equal(cf.items.length, 6);
    assert.equal(cf.hasSchedule, true);
    assert.ok(cf.items.some((x: { outflow: number }) => x.outflow > 0), "the remaining cost is spent over the programme");
    const accountant = await addMember(app, owner, t, "accountant");
    expectStatus(await call(app, accountant, "GET", `/t/projects/${p}/evm`, { tenant: t }), 200, "accountant reads");
    const f = multipart(xer("0"), "programme.xer");
    expectStatus(await call(app, accountant, "POST", `/t/projects/${p}/schedule/import`, { tenant: t, body: f.payload, headers: f.headers }), 403, "accountant imports");
  });
});
