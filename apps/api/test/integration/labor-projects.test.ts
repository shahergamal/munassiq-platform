import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { call, createUser, expectStatus, ownerPool, raiseLimits, startApp, stopApp, type Actor, type App } from "./helpers.ts";

// Contracting C8: hours on projects, then an approved payroll run allocated to the projects by those hours — per
// project totals only, posted as labour cost on each project (LAB) against the contra account; one allocation a run.
describe("contracting: labour on projects", () => {
  let app: App;
  let owner: Actor;
  let t: string;
  let pA: string;
  let pB: string;
  let e1: string;
  let e2: string;
  const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1);
  const period = d.toISOString().slice(0, 7);
  const day = (n: number) => `${period}-${String(n).padStart(2, "0")}`;

  const post = async (url: string, body: object = {}, status = 201) => {
    const r = await call(app, owner, "POST", url, { tenant: t, idem: true, body });
    expectStatus(r, status, url);
    return r.body;
  };
  const put = async (url: string, body: object, status = 200) => { const r = await call(app, owner, "PUT", url, { tenant: t, body }); expectStatus(r, status, url); return r.body; };
  const get = async (url: string) => { const r = await call(app, owner, "GET", url, { tenant: t }); expectStatus(r, 200, url); return r.body; };
  const ledger = async (key: string) => Number((await ownerPool.query<{ b: string }>(
    `SELECT coalesce(sum(l.debit - l.credit), 0)::text AS b FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.tenant_id = $1 AND a.system_key = $2`, [t, key])).rows[0]!.b);

  before(async () => {
    app = await startApp();
    owner = await createUser();
    const r = await call(app, owner, "POST", "/tenants", { body: { companyName: "مقاولات العمالة", sector: "contracting", taxId: `3${randomInt(10_000_000, 99_999_999)}${randomInt(100_000, 999_999)}`, city: "الرياض" } });
    expectStatus(r, 201, "tenant");
    t = r.body.id;
    await raiseLimits(t);
    pA = (await post("/t/projects", { code: `LA${randomInt(100, 999)}`, name: "مشروع أ", specialty: "BUILDING" })).id;
    pB = (await post("/t/projects", { code: `LB${randomInt(100, 999)}`, name: "مشروع ب", specialty: "BUILDING" })).id;
    const emp = async (code: string, name: string, basic: number) => (await post("/t/employees", { code, name, gender: "male", nationality: "IN", idType: "iqama",
      idNumber: `2${randomInt(100_000_000, 999_999_999)}`, jobTitle: "عامل", hireDate: "2024-01-01", contractType: "unlimited", pay: { basic, housing: 0, transport: 0 } })).id as string;
    e1 = await emp("W1", "عامل أول", 4_000);
    e2 = await emp("W2", "عامل ثانٍ", 3_000);
    for (const n of [1, 2, 3, 4]) await put("/t/attendance", { date: day(n), rows: [{ employeeId: e1, status: "present", hours: 10, overtimeHours: 0, overtimeAsLeave: false },
      { employeeId: e2, status: "present", hours: 10, overtimeHours: 0, overtimeAsLeave: false }] });
  });
  after(() => stopApp(app));

  it("records a day's hours per project, within 24 hours a day across projects", async () => {
    for (const n of [1, 2]) await put("/t/labor-timesheets", { projectId: pA, workDate: day(n), rows: [{ employeeId: e1, hours: 10 }, { employeeId: e2, hours: 5 }] });
    for (const n of [3, 4]) await put("/t/labor-timesheets", { projectId: pB, workDate: day(n), rows: [{ employeeId: e1, hours: 5 }] });
    await put("/t/labor-timesheets", { projectId: pB, workDate: day(1), rows: [{ employeeId: e1, hours: 15 }] }, 422);
    const sheet = await get(`/t/labor-timesheets?projectId=${pA}&date=${day(1)}`);
    assert.equal(sheet.items.find((x: { employeeId: string }) => x.employeeId === e1).hours, 10);
  });

  it("allocates an approved run to projects by hours; per-project totals only; once per run; the month's hours lock", async () => {
    const run = (await post("/t/payroll/runs", { period })).id;
    const early = await call(app, owner, "POST", `/t/payroll/runs/${run}/allocate-projects`, { tenant: t });
    assert.equal(early.status, 409, "draft run");
    await post(`/t/payroll/runs/${run}/approve`, {}, 200);
    const a = await post(`/t/payroll/runs/${run}/allocate-projects`, {}, 200);
    assert.equal(a.projects, 2);
    assert.ok(a.unallocated > 0, "attendance hours not on projects stay with the employee's cost center");
    assert.equal(JSON.stringify(a).includes(e1), false, "no per-employee figures");
    const s = await get(`/t/labor/summary?period=${period}`);
    const A = s.projects.find((p: { id: string }) => p.id === pA);
    const B = s.projects.find((p: { id: string }) => p.id === pB);
    assert.deepEqual([A.hours, B.hours], [30, 10]);
    // Worker 1: 30 of 40 hours on projects (20 A, 10 B); worker 2: 10 of 40 on A.
    assert.ok(A.amount > B.amount);
    assert.equal(Math.round((A.amount + B.amount) * 100) / 100, a.allocated);
    assert.equal(await ledger("contract_labor"), a.allocated);
    assert.equal(await ledger("labor_allocated"), -a.allocated);
    assert.equal((await call(app, owner, "POST", `/t/payroll/runs/${run}/allocate-projects`, { tenant: t })).body.error?.code, "already_allocated");
    assert.equal((await call(app, owner, "PUT", "/t/labor-timesheets", { tenant: t, body: { projectId: pA, workDate: day(5), rows: [{ employeeId: e1, hours: 1 }] } })).body.error?.code, "labor_locked");
  });
});
