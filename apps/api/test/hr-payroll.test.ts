import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  annualLeaveAccrued, endOfService, gosiBase, gosiContribution, gosiScheme, ibanInfo, overtimePay, payMonth, sickLeaveUnpaidDays, type GosiRate, type Pay,
} from "../src/lib/hr/payroll.ts";

// M7: case tables for GOSI (old / new / non-Saudi / above the ceiling / housing in kind), end of service
// (termination / resignation bands / Article 87 / fractions), overtime, sick leave, annual leave and IBAN.
const OLD: GosiRate = { employeePension: 9, employerPension: 9, employeeSaned: 0.75, employerSaned: 0.75, employerHazard: 2, wageCeiling: 45000 };
const NEW_2026: GosiRate = { ...OLD, employeePension: 10, employerPension: 10 };
const NON_SAUDI: GosiRate = { employeePension: 0, employerPension: 0, employeeSaned: 0, employerSaned: 0, employerHazard: 2, wageCeiling: 45000 };
const pay = (basic: number, housing = 0, extra: Partial<Pay> = {}): Pay => ({ basic, housing, housingInKind: false, transport: 0, other: 0, ...extra });

describe("GOSI", () => {
  it("scheme from nationality and first registration", () => {
    assert.equal(gosiScheme("SA", "2020-01-01"), "old");
    assert.equal(gosiScheme("SA", null), "old");
    assert.equal(gosiScheme("SA", "2024-07-03"), "new");
    assert.equal(gosiScheme("EG", "2025-01-01"), "non_saudi");
  });
  it("case table", () => {
    const cases: [string, Pay, GosiRate, number, number][] = [
      // base 10,000: employee 9.75% = 975; employer 11.75% = 1,175
      ["old system", pay(8000, 2000), OLD, 97500, 117500],
      // new system from July 2026: employee 10.75% = 1,075; employer 12.75% = 1,275
      ["new system 2026", pay(8000, 2000), NEW_2026, 107500, 127500],
      // non-Saudi: hazard 2% on the employer only
      ["non-Saudi", pay(4000, 1000), NON_SAUDI, 0, 10000],
      // 50,000 + 10,000 caps at 45,000: 45,000 × 9.75% = 4,387.50
      ["above the ceiling", pay(50000, 10000), OLD, 438750, 528750],
      // housing in kind = two months' basic a year: 12,000 + 2,000 = 14,000 × 9.75% = 1,365
      ["housing in kind", pay(12000, 3000, { housingInKind: true }), OLD, 136500, 164500],
    ];
    for (const [name, p, r, emp, er] of cases) {
      const c = gosiContribution(gosiBase(p, r.wageCeiling), r);
      assert.deepEqual([c.employee, c.employer], [emp, er], name);
    }
  });
  it("transport and other allowances are not in the base", () => {
    assert.equal(gosiBase(pay(5000, 1250, { transport: 500, other: 300 }), 45000), 625000);
  });
});

describe("end of service", () => {
  const wage = 1000000; // 10,000 a month
  it("Article 84: half a month for each of the first five years, a month after, fractions pro rata", () => {
    assert.equal(endOfService(wage, "2020-01-01", "2024-12-29", "termination").award, 2500000, "5 years × ½");
    assert.equal(endOfService(wage, "2015-01-01", "2024-12-28", "termination").award, 7500000, "10 years: 2.5 + 5");
    const frac = endOfService(wage, "2023-01-01", "2024-07-01", "contract_end"); // 548 days
    assert.equal(frac.award, Math.round(wage * 0.5 * 548 / 365));
  });
  it("Article 85: resignation bands", () => {
    assert.equal(endOfService(wage, "2023-06-01", "2024-12-31", "resignation").award, 0, "under two years");
    const three = endOfService(wage, "2021-01-01", "2023-12-31", "resignation");
    assert.equal(three.factor, 1 / 3);
    assert.equal(three.award, Math.round(three.full / 3));
    assert.equal(endOfService(wage, "2016-01-01", "2022-12-31", "resignation").factor, 2 / 3);
    assert.equal(endOfService(wage, "2010-01-01", "2022-12-31", "resignation").factor, 1);
  });
  it("Article 87 pays in full despite resigning; Article 80 pays nothing", () => {
    const r = endOfService(wage, "2023-06-01", "2024-12-31", "article_87");
    assert.equal(r.award, r.full);
    assert.equal(endOfService(wage, "2010-01-01", "2022-12-31", "article_80").award, 0);
  });
});

describe("month", () => {
  it("overtime is the hourly wage plus half the hourly basic", () => {
    // wage 6,000 (basic 4,000): hourly 25, basic hourly 16.667 → 33.33 an hour × 10
    assert.equal(overtimePay(pay(4000, 1000, { transport: 1000 }), 10), 33333);
  });
  it("sick leave: 30 days full, 60 at 75%, 30 unpaid", () => {
    assert.equal(sickLeaveUnpaidDays(0, 30), 0);
    assert.equal(sickLeaveUnpaidDays(25, 10), 1.25, "5 days in the 75% band");
    assert.equal(sickLeaveUnpaidDays(88, 5), 0.5 + 3);
  });
  it("annual leave: 21 days a year, 30 after five years", () => {
    assert.equal(annualLeaveAccrued("2024-01-01", "2024-12-30"), 21);
    assert.equal(annualLeaveAccrued("2014-01-03", "2024-12-31"), Math.round((5 * 21 + (4016 / 365 - 5) * 30) * 100) / 100);
  });
  it("a partial month, absence, bonus and advance recovery", () => {
    const m = payMonth({ pay: pay(6000, 1500, { transport: 500 }), rate: OLD, employedDays: 15, monthDays: 30, overtimeHours: 0, absentDays: 1, unpaidLeaveDays: 0,
      sickUnpaidDays: 0, bonus: 20000, advanceRecovery: 50000, penalty: 0, eosEntitlement: 150000, eosProvisioned: 0 });
    // half month: 3,000 + 750 + 250 = 4,000; − 1 day (8,000/30 = 266.67) + 200 bonus = 3,933.33
    assert.equal(m.gross, 393333);
    // GOSI on half the base (3,750 × 9.75% = 365.63)
    assert.equal(m.gosiEmployee, 36563);
    assert.equal(m.net, 393333 - 36563 - 50000);
    assert.equal(m.eosAccrual, 150000);
  });
});

describe("IBAN", () => {
  it("checks the mod-97 digits and reads the bank code", () => {
    assert.deepEqual(ibanInfo("SA03 8000 0000 6080 1016 7519"), { iban: "SA0380000000608010167519", bankCode: "80" });
    assert.equal(ibanInfo("SA0380000000608010167518"), null);
    assert.equal(ibanInfo("AE070331234567890123456"), null);
  });
});
