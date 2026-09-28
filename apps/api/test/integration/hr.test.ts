import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { addMember, call, createTenant, createUser, expectStatus, isoToday, ownerPool, raiseLimits, startApp, stopApp, type Actor, type App } from "./helpers.ts";

// M7 (docs/manufacturing/ARCHITECTURE.md): employees with sealed personal data, attendance and leaves feeding a
// payroll whose GOSI comes from the dated rates table, the posted run, the Mudad file and a final settlement.
// A restaurant workspace: HR belongs to every sector.
describe("HR and payroll", () => {
  let app: App;
  let owner: Actor;
  let accountant: Actor;
  let t: string;
  let A: string; let B: string; let C: string;
  let run: string;

  const today = isoToday();
  const lastMonth = (() => { const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); })();
  const inMonth = (day: number) => `${lastMonth}-${String(day).padStart(2, "0")}`;
  const newRate = lastMonth >= "2028-07" ? 11 : lastMonth >= "2027-07" ? 10.5 : lastMonth >= "2026-07" ? 10 : 9.5;

  const post = async (url: string, body: object = {}, status = 201, who = owner) => {
    const r = await call(app, who, "POST", url, { tenant: t, idem: true, body });
    expectStatus(r, status, url);
    return r.body;
  };
  const get = async (url: string, who = owner) => { const r = await call(app, who, "GET", url, { tenant: t }); expectStatus(r, 200, url); return r.body; };
  const ledger = async (key: string) => Number((await ownerPool.query<{ b: string }>(
    `SELECT coalesce(sum(l.debit - l.credit), 0)::text AS b FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.tenant_id = $1 AND a.system_key = $2`, [t, key])).rows[0]!.b);
  const person = (code: string, name: string, extra: object) => ({ code, name, gender: "male", jobTitle: "فني", idType: "national_id", contractType: "unlimited", ...extra });

  before(async () => {
    app = await startApp();
    owner = await createUser();
    t = await createTenant(app, owner, "مطعم الموارد");
    await raiseLimits(t);
    accountant = await addMember(app, owner, t, "accountant");
    A = (await post("/t/employees", person("E-1", "أحمد", { nationality: "SA", idNumber: "1012345678", hireDate: "2020-01-01", gosiFirstRegistered: "2020-01-01",
      iban: "SA03 8000 0000 6080 1016 7519", pay: { basic: 8000, housing: 2000 } }))).id;
    B = (await post("/t/employees", person("E-2", "بدر", { nationality: "SA", idNumber: "1098765432", hireDate: "2025-01-01", gosiFirstRegistered: "2025-01-01",
      pay: { basic: 6000, housing: 1500, transport: 500, gosiRegisteredWage: 7000 } }))).id;
    C = (await post("/t/employees", person("E-3", "كريم", { nationality: "EG", idType: "iqama", idNumber: "2123456789", hireDate: "2023-03-01",
      iban: "SA0380000000608010167519", pay: { basic: 4000, housing: 1000 } }))).id;
  });
  after(() => stopApp(app));

  it("personal data is sealed at rest and shown only with the pay permission", async () => {
    const raw = (await ownerPool.query<{ pay_enc: string; id_number_enc: string; iban_enc: string }>("SELECT pay_enc, id_number_enc, iban_enc FROM employees WHERE id = $1", [A])).rows[0]!;
    assert.ok(!raw.pay_enc.includes("8000") && !raw.id_number_enc.includes("1012345678") && !raw.iban_enc.includes("SA03"), "no clear text");
    const full = await get(`/t/employees/${A}`);
    assert.equal(full.idNumber, "1012345678");
    assert.equal(full.iban, "SA0380000000608010167519");
    assert.equal(full.pay.basic, 8000);
    assert.equal(full.gosiScheme, "old");
    const limited = await get(`/t/employees/${A}`, accountant);
    assert.equal(limited.pay, undefined);
    assert.equal(limited.idNumber, undefined);
    const edit = await call(app, accountant, "PUT", `/t/employees/${A}`, { tenant: t, body: person("E-1", "أحمد", { nationality: "SA", hireDate: "2020-01-01", pay: { basic: 1 } }) });
    assert.equal(edit.status, 403);
    const bad = await call(app, owner, "POST", "/t/employees", { tenant: t, body: person("E-9", "خطأ", { nationality: "SA", idNumber: "1000000000", hireDate: "2024-01-01", iban: "SA0380000000608010167518", pay: { basic: 5000 } }) });
    assert.equal(bad.status, 422, "IBAN check digits");
  });

  it("attendance and leaves: overtime, absence, sick leave within full pay, and the annual balance", async () => {
    expectStatus(await call(app, owner, "PUT", "/t/attendance", { tenant: t, body: { date: inMonth(10), rows: [
      { employeeId: A, status: "present", hours: 8, overtimeHours: 10 }, { employeeId: B, status: "absent" }, { employeeId: C, status: "present", hours: 8 }] } }), 200, "attendance");
    const types = (await get("/t/leave-types")).items as { id: string; code: string }[];
    const type = (c: string) => types.find((x) => x.code === c)!.id;
    const sick = await post("/t/leaves", { employeeId: C, leaveTypeId: type("sick"), startDate: inMonth(12), endDate: inMonth(16) });
    await post(`/t/leaves/${sick.id}/approve`, {}, 200);
    const tooLong = await call(app, owner, "POST", "/t/leaves", { tenant: t, body: { employeeId: B, leaveTypeId: type("annual"), startDate: inMonth(20), endDate: `${today.slice(0, 7)}-28` } });
    assert.ok([409].includes(tooLong.status) || tooLong.body.error.code === "leave_balance");
    const maternity = await call(app, owner, "POST", "/t/leaves", { tenant: t, body: { employeeId: A, leaveTypeId: type("maternity"), startDate: inMonth(1), endDate: inMonth(2) } });
    assert.equal(maternity.status, 422, "maternity leave is for women");
  });

  it("the payroll computes GOSI from the dated table, overtime, absence, bonus and recoveries", async () => {
    await post("/t/payroll/adjustments", { employeeId: A, period: lastMonth, kind: "bonus", amount: 500, note: "مكافأة أداء" });
    await post("/t/payroll/adjustments", { employeeId: C, period: lastMonth, kind: "advance_recovery", amount: 300, note: "قسط سلفة" });
    run = (await post("/t/payroll/runs", { period: lastMonth })).id;
    const d = await get(`/t/payroll/runs/${run}`);
    const line = (id: string) => d.lines.find((l: { employeeId: string }) => l.employeeId === id);
    // A (old system): 10,000 + overtime 10 h × (41.67 + 8,000/240/2) = 583.33 + bonus 500; GOSI 9.75% of 10,000.
    assert.deepEqual([line(A).gross, line(A).gosiEmployee, line(A).gosiEmployer, line(A).net], [11083.33, 975, 1175, 10108.33]);
    // B (new system): base 7,500 (transport excluded); one day absent (8,000 / 30).
    const ee = Math.round(7500 * (newRate + 0.75)) / 100;
    assert.equal(line(B).gross, 7733.33);
    assert.equal(line(B).gosiEmployee, ee);
    assert.equal(line(B).gosiEmployer, Math.round(7500 * (newRate + 0.75 + 2)) / 100);
    // C (non-Saudi): hazard 2% on the employer only; five sick days at full pay; the advance recovered.
    assert.deepEqual([line(C).gross, line(C).gosiEmployee, line(C).gosiEmployer, line(C).net], [5000, 0, 100, 4700]);
    assert.ok(line(A).eosAccrual > 0, "end-of-service provision accrues");
  });

  it("approval posts the run and closes the month; payment clears net pay", async () => {
    const d0 = await get(`/t/payroll/runs/${run}`);
    const sum = (k: string) => Math.round(d0.lines.reduce((a: number, l: Record<string, number>) => a + l[k]!, 0) * 100) / 100;
    assert.equal((await call(app, accountant, "POST", `/t/payroll/runs/${run}/approve`, { tenant: t })).status, 403, "approval is the owner's");
    await post(`/t/payroll/runs/${run}/approve`, {}, 200);
    assert.equal(await ledger("salaries_expense"), sum("gross"));
    assert.equal(await ledger("salaries_payable"), -sum("net"));
    assert.equal(await ledger("gosi_payable"), -Math.round((sum("gosiEmployee") + sum("gosiEmployer")) * 100) / 100);
    assert.equal(await ledger("employee_advances"), -300);
    assert.equal(await ledger("eos_provision"), -sum("eosAccrual"));
    const late = await call(app, owner, "PUT", "/t/attendance", { tenant: t, body: { date: inMonth(11), rows: [{ employeeId: A, status: "absent" }] } });
    assert.equal(late.body.error.code, "payroll_period_closed");

    const check = await get(`/t/payroll/runs/${run}/wps-check`);
    assert.ok(check.issues.some((i: { code: string; problem: string }) => i.code === "E-2" && /آيبان/.test(i.problem)), "B has no IBAN");
    assert.ok(check.issues.some((i: { code: string; problem: string }) => i.code === "E-2" && /التأمينات/.test(i.problem)), "B's GOSI wage 7,000 ≠ 7,500");
    const file = await call(app, owner, "GET", `/t/payroll/runs/${run}/file/mudad`, { tenant: t });
    expectStatus(file, 200, "mudad file");
    assert.match(String(file.headers["content-type"]), /spreadsheetml/);

    await post(`/t/payroll/runs/${run}/pay`, { method: "bank_transfer" }, 200, accountant);
    assert.equal(await ledger("salaries_payable"), 0);
  });

  it("a resignation after six years pays two thirds of the award (Article 85) against the provision", async () => {
    const prev = await get(`/t/employees/${A}/settlement-preview?lastDay=${today}&reason=resignation`);
    assert.equal(prev.factor, 2 / 3);
    assert.equal(prev.award, Math.round(prev.fullAward * 2 / 3 * 100) / 100);
    const before = await ledger("eos_provision");
    await post(`/t/employees/${A}/terminate`, { lastDay: today, reason: "resignation", paymentMethod: "bank_transfer" });
    const e = await get(`/t/employees/${A}`);
    assert.equal(e.status, "terminated");
    assert.ok(e.settlement);
    assert.equal(Math.round((await ledger("eos_provision") - before) * 100) / 100, prev.provision, "A's provision is released");
    expectStatus(await call(app, owner, "POST", `/t/employees/${A}/terminate`, { tenant: t, idem: true, body: { lastDay: today, reason: "termination", paymentMethod: "cash" } }), 409, "once");
  });

  it("the payroll report totals the approved run and splits GOSI by scheme and branch of contribution", async () => {
    const r = await get(`/t/reports/payroll?from=${lastMonth}&to=${lastMonth}`);
    const d = await get(`/t/payroll/runs/${run}`);
    assert.equal(r.months[0].gross, d.gross);
    assert.equal(r.months[0].headcount, 3);
    const old = r.gosi.find((g: { scheme: string }) => g.scheme === "old");
    assert.deepEqual([old.base, old.employeePension, old.employeeSaned, old.employerHazard], [10000, 900, 75, 200]);
    assert.equal(r.gosi.find((g: { scheme: string }) => g.scheme === "non_saudi").employerHazard, 100);
    assert.equal((await call(app, accountant, "GET", "/t/reports/payroll", { tenant: t })).status, 403, "the payroll report is the owner's");
  });

  it("the overview: document alerts and the Saudization ratio", async () => {
    const soon = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    const e = await get(`/t/employees/${C}`);
    expectStatus(await call(app, owner, "PUT", `/t/employees/${C}`, { tenant: t, body: person("E-3", "كريم", { nationality: "EG", idType: "iqama", hireDate: e.hireDate, idExpiry: soon }) }), 200, "iqama expiry");
    const o = await get("/t/hr/overview");
    assert.ok(o.alerts.some((a: { code: string; kind: string }) => a.code === "E-3" && a.kind === "id"));
    assert.deepEqual([o.saudization.saudi, o.saudization.total], [1, 2], "A left: B is the only Saudi of two");
    assert.equal(o.wps.period, lastMonth);
  });
});
