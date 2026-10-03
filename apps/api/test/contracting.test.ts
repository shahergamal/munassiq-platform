import test from "node:test";
import assert from "node:assert/strict";
import { computeIpc, h, type IpcTerms } from "../src/lib/contracting/ipc.ts";
import { checkVariationCaps } from "../src/lib/contracting/variations.ts";

// C3: the IPC arithmetic against the ZATCA contracting guideline's own examples (May 2026), and the Art. 67 caps.
const terms = (t: Partial<IpcTerms> = {}): IpcTerms => ({ contractValue: h(10_000_000), retentionPct: 0, retentionCapPct: 0, advanceTaxable: 0, advanceRecovered: 0,
  ldRatePerDay: 0, ldCapPct: null, vatRatePct: 15, ...t });
const work = (riyals: number) => [{ kind: "boq" as const, rate: riyals, qtyToDate: 1, previousQty: 0 }];

test("retention does not reduce the VAT base (guideline: 6% on 5,000,000 → VAT 750,000 in full)", () => {
  const r = computeIpc(work(5_000_000), terms({ retentionPct: 6 }), { previousGross: 0, retainedToDate: 0, ldToDate: 0 }, { final: false, ldDays: 0 });
  assert.equal(r.vat, h(750_000));
  assert.equal(r.retention, h(300_000));
  assert.equal(r.net, h(5_750_000 - 300_000));
});

test("delay damages as a price reduction with VAT (guideline: 8,000 × 55 days = 440,000 + 66,000)", () => {
  const r = computeIpc(work(5_000_000), terms({ ldRatePerDay: h(8_000), ldCapPct: 10 }), { previousGross: 0, retainedToDate: 0, ldToDate: 0 }, { final: false, ldDays: 55 });
  assert.deepEqual([r.ld, r.ldVat], [h(440_000), h(66_000)]);
  assert.equal(r.net, h(5_750_000 - 506_000));
  assert.throws(() => computeIpc(work(1), terms({ ldRatePerDay: h(100) }), { previousGross: 0, retainedToDate: 0, ldToDate: 0 }, { final: false, ldDays: 3 }), /ld_cap_unknown/);
});

test("the delay damages cap is cumulative", () => {
  const r = computeIpc(work(1_000_000), terms({ ldRatePerDay: h(50_000), ldCapPct: 20 }), { previousGross: 0, retainedToDate: 0, ldToDate: h(1_900_000) }, { final: false, ldDays: 10 });
  assert.equal(r.ld, h(100_000), "only 100,000 left under 20% of 10,000,000");
  assert.equal(r.ldCapped, true);
});

test("advance 500,000 + 75,000 recovered in the final IPC of 972,000: 472,000 + 70,800 payable (guideline)", () => {
  const r = computeIpc(work(972_000), terms({ contractValue: h(972_000), advanceTaxable: h(500_000) }), { previousGross: 0, retainedToDate: 0, ldToDate: 0 }, { final: true, ldDays: 0 });
  assert.deepEqual([r.advanceRecovery, r.advanceRecoveryVat], [h(500_000), h(75_000)]);
  assert.equal(r.net, h(472_000 + 70_800));
});

test("interim IPCs recover the advance pro rata, and retention stops at its cap", () => {
  const t = terms({ advanceTaxable: h(1_000_000), retentionPct: 10, retentionCapPct: 5 });
  const r1 = computeIpc(work(4_000_000), t, { previousGross: 0, retainedToDate: 0, ldToDate: 0 }, { final: false, ldDays: 0 });
  assert.equal(r1.advanceRecovery, h(400_000), "10% of the period's work");
  assert.equal(r1.retention, h(400_000));
  const r2 = computeIpc(work(8_000_000), { ...t, advanceRecovered: r1.advanceRecovery }, { previousGross: h(4_000_000), retainedToDate: r1.retention, ldToDate: 0 }, { final: false, ldDays: 0 });
  assert.equal(r2.current, h(4_000_000));
  assert.equal(r2.retention, h(100_000), "the cap is 500,000 (5% of 10,000,000)");
});

test("variation caps (Art. 67): new items need consent and stay within 10%, total increase within 20%", () => {
  const caps = { newItemsPct: 10, increaseConsentPct: 10, totalIncreasePct: 20, decreasePct: 20 };
  const base = { contractValue: h(10_000_000), approved: { newItems: 0, increase: 0, decrease: 0 }, caps };
  assert.equal(checkVariationCaps({ ...base, proposed: { newItems: h(500_000), increase: 0, decrease: 0 }, consent: false }).ok, false, "consent needed");
  assert.equal(checkVariationCaps({ ...base, proposed: { newItems: h(500_000), increase: 0, decrease: 0 }, consent: true }).ok, true);
  assert.equal(checkVariationCaps({ ...base, proposed: { newItems: h(1_100_000), increase: 0, decrease: 0 }, consent: true }).ok, false, "over 10%");
  assert.equal(checkVariationCaps({ ...base, proposed: { newItems: 0, increase: h(1_500_000), decrease: 0 }, consent: false }).ok, false, "over 10% without consent");
  const r = checkVariationCaps({ ...base, approved: { newItems: h(1_000_000), increase: h(500_000), decrease: 0 }, proposed: { newItems: 0, increase: h(600_000), decrease: 0 }, consent: true });
  assert.equal(r.ok, false, "2.1M > 20%");
  assert.equal(checkVariationCaps({ ...base, caps: null as never, proposed: { newItems: h(9_000_000), increase: 0, decrease: 0 }, consent: false }).ok, true, "no statutory caps (private)");
});

// C4: the subcontractor's certificate, seen from the main contractor.
import { computeSubIpc } from "../src/lib/contracting/subIpc.ts";
const sub = (t: Partial<Parameters<typeof computeSubIpc>[1]> = {}) => ({ ...terms({ contractValue: h(1_000_000) }), vatMode: "charged" as const, ...t });
const none = { previousGross: 0, retainedToDate: 0, ldToDate: 0 };

test("registered resident subcontractor: its VAT is our input VAT; retention and back-charges are set off", () => {
  const r = computeSubIpc(work(1_000_000), sub({ retentionPct: 10 }), none, { final: false, ldDays: 0, deductions: [{ amount: h(20_000) }] });
  assert.deepEqual([r.vat, r.retention, r.deductions, r.reverseChargeVat, r.net], [h(150_000), h(100_000), h(20_000), 0, h(1_030_000)]);
});

test("non-resident subcontractor: no VAT charged, reverse charge on the net supply; unregistered resident: no VAT at all", () => {
  const r = computeSubIpc(work(500_000), sub({ vatMode: "reverse", advanceTaxable: h(100_000) }), none, { final: false, ldDays: 0, deductions: [] });
  assert.equal(r.vat, 0);
  assert.equal(r.advanceRecovery, h(50_000));
  assert.equal(r.advanceRecoveryVat, 0);
  assert.equal(r.reverseChargeVat, h(67_500), "15% of 450,000");
  assert.equal(r.net, h(450_000));
  const n = computeSubIpc(work(500_000), sub({ vatMode: "none" }), none, { final: false, ldDays: 0, deductions: [] });
  assert.deepEqual([n.vat, n.reverseChargeVat, n.net], [0, 0, h(500_000)]);
});

import { checkSubcontractShare } from "../src/lib/contracting/subcontract.ts";
test("subcontracted share within the form's ceilings (Etimad: approval above 30%, always under 50%)", () => {
  const base = { mainValue: h(10_000_000), otherSubs: h(2_000_000), approvalPct: 30, maxPct: 50, approvalRef: null };
  assert.equal(checkSubcontractShare({ ...base, thisValue: h(500_000) }).ok, true);
  assert.equal(checkSubcontractShare({ ...base, thisValue: h(1_500_000) }).ok, false, "35% needs a documented approval");
  assert.equal(checkSubcontractShare({ ...base, thisValue: h(1_500_000), approvalRef: "خطاب 12/1447" }).ok, true);
  assert.equal(checkSubcontractShare({ ...base, thisValue: h(3_000_000), approvalRef: "خطاب" }).ok, false, "50% is not under 50%");
  assert.equal(checkSubcontractShare({ ...base, thisValue: h(7_000_000), approvalPct: null, maxPct: null }).ok, true, "no ceilings in the form");
});

// C5: revenue over time, the contract asset/liability, onerous contracts.
import { closeLines, computeClose } from "../src/lib/contracting/revenue.ts";
test("input method: revenue by cost incurred; billed ahead is a contract liability", () => {
  const r = computeClose({ method: "input", transactionPrice: h(10_000_000), workValue: h(10_000_000), estimatedCost: h(8_000_000), costToDate: h(2_000_000), certifiedToDate: 0, billedToDate: h(3_000_000) });
  assert.equal(r.pct, 0.25);
  assert.equal(r.revenueToDate, h(2_500_000));
  assert.equal(r.position, -h(500_000), "billed 3.0M for 2.5M of revenue");
  assert.equal(r.provision, 0);
  assert.throws(() => computeClose({ method: "input", transactionPrice: 1, workValue: 1, estimatedCost: null, costToDate: 1, certifiedToDate: 0, billedToDate: 0 }), /estimate_required/);
});

test("output method: revenue by certified work; certified not billed is a contract asset", () => {
  const r = computeClose({ method: "output", transactionPrice: h(10_000_000), workValue: h(10_000_000), estimatedCost: h(8_000_000), costToDate: h(2_000_000), certifiedToDate: h(4_000_000), billedToDate: h(3_000_000) });
  assert.deepEqual([r.pct, r.revenueToDate, r.position], [0.4, h(4_000_000), h(1_000_000)]);
});

test("onerous contract: the whole expected loss at once, the rest as a provision", () => {
  const r = computeClose({ method: "input", transactionPrice: h(1_000_000), workValue: h(1_000_000), estimatedCost: h(1_200_000), costToDate: h(300_000), certifiedToDate: 0, billedToDate: 0 });
  assert.equal(r.expectedLoss, h(200_000));
  assert.equal(r.revenueToDate, h(250_000));
  assert.equal(r.provision, h(150_000), "200,000 expected − 50,000 already in cost over revenue");
});

test("a close entry undoes the previous position and books the new one, balanced", () => {
  const lines = closeLines({ position: h(100), provision: h(50) }, { position: -h(40), provision: h(20) });
  const dr = lines.reduce((a, l) => a + (l.debit ?? 0), 0);
  const cr = lines.reduce((a, l) => a + (l.credit ?? 0), 0);
  assert.equal(dr, cr);
  const net = (k: string) => lines.filter((l) => l.key === k).reduce((a, l) => a + (l.debit ?? 0) - (l.credit ?? 0), 0);
  assert.deepEqual([net("contract_asset"), net("contract_liability"), net("contract_revenue"), net("onerous_provision")], [-h(100), -h(40), h(140), h(30)]);
});

// C6: tender pricing (rate build-up).
import { priceItem, priceTender } from "../src/lib/contracting/tender.ts";
test("rate build-up: resources with waste, then overheads, risk and profit in turn", () => {
  const item = { quantity: 100, resources: [
    { kind: "material" as const, quantity: 1.05, unitCost: h(250), wastePct: 5 },   // concrete per m³ with 5% waste: 275.63
    { kind: "labor" as const, quantity: 0.5, unitCost: h(40), wastePct: 0 },       // 20.00
    { kind: "equipment" as const, quantity: 0.1, unitCost: h(300), wastePct: 0 },  // 30.00
  ] };
  const p = priceItem(item, { overheadPct: 10, riskPct: 5, profitPct: 10 });
  assert.equal(p.direct, h(325.63));
  assert.equal(p.costRate, Math.round(Math.round(h(325.63) * 1.1) * 1.05));
  assert.equal(p.rate, Math.round(p.costRate * 1.1));
  const t = priceTender([item, { quantity: 1, resources: [], directRate: h(50_000) }], { overheadPct: 10, riskPct: 5, profitPct: 10 });
  assert.equal(t.total, p.amount + Math.round(Math.round(Math.round(h(50_000) * 1.1) * 1.05) * 1.1));
  assert.equal(t.margin, t.total - t.cost);
  assert.equal(t.byKind.labor, h(2_000));
});

// C7: equipment charging and material consumption against the BOQ.
import { consumption, equipmentCharge, utilisation } from "../src/lib/contracting/site.ts";
test("equipment: operating hours at the rate, idle at its share, breakdown free; consumption against norms", () => {
  assert.equal(equipmentCharge({ operatingHours: 6, idleHours: 2, hourlyRate: h(250), idleRatePct: 40 }), h(1_700));
  assert.equal(utilisation(6, 2, 2), 60);
  assert.equal(utilisation(0, 0, 0), null);
  assert.deepEqual(consumption({ certifiedQty: 100, normPerUnit: 1.02, issuedQty: 107.1 }), { theoretical: 102, variance: 5.1, wastePct: 5 });
});

// C8: payroll to projects by hours.
import { allocateLabor } from "../src/lib/contracting/labor.ts";
test("labour: each employee's cost shared by project hours over the hours worked; the rest stays put", () => {
  const r = allocateLabor([
    { cost: h(10_000), attendanceHours: 200, projectHours: { A: 120, B: 40 } }, // 80% on projects: 6,000 A + 2,000 B
    { cost: h(6_000), attendanceHours: 0, projectHours: { A: 10 } },            // no attendance: all of it to A
    { cost: h(4_000), attendanceHours: 180, projectHours: {} },                 // office: stays
  ]);
  assert.deepEqual([r.byProject.get("A")!.amount, r.byProject.get("B")!.amount], [h(12_000), h(2_000)]);
  assert.equal(r.allocated, h(14_000));
  assert.equal(r.unallocated, h(6_000));
});

test("review fixes: output progress on the work's value (damages move revenue with it); advance never beyond the period's work", () => {
  // 10M contract, 1M damages already credited, 4.5M certified: 45% of the 9M price = 4.05M revenue, not 4.5M.
  const r = computeClose({ method: "output", transactionPrice: h(9_000_000), workValue: h(10_000_000), estimatedCost: null, costToDate: 0, certifiedToDate: h(4_500_000), billedToDate: h(3_500_000) });
  assert.deepEqual([r.revenueToDate, r.position, r.provision, r.grossProfit], [h(4_050_000), h(550_000), 0, null]);
  // A final IPC with 50,000 of work cannot recover 400,000 of advance: only what its work carries.
  const f = computeIpc(work(50_000), terms({ contractValue: h(1_000_000), advanceTaxable: h(400_000) }), { previousGross: 0, retainedToDate: 0, ldToDate: 0 }, { final: true, ldDays: 0 });
  assert.equal(f.advanceRecovery, h(50_000));
});

// C9: earned value, the S-curve and cash flow.
import { cashFlow, earnedValue, plannedCurve, plannedPct } from "../src/lib/contracting/evm.ts";
test("earned value: PV linear on the baseline, EV by progress, the indices", () => {
  assert.equal(plannedPct({ start: "2026-01-01", finish: "2026-01-10" }, "2026-01-05"), 0.5);
  const acts = [{ start: "2026-01-01", finish: "2026-01-10", budget: h(100_000), pctComplete: 60 }, { start: "2026-01-11", finish: "2026-01-20", budget: h(100_000), pctComplete: 0 }];
  const e = earnedValue(acts, { bac: 0, ac: h(80_000), date: "2026-01-10" });
  assert.deepEqual([e.bac, e.pv, e.ev, e.spi, e.cpi], [h(200_000), h(100_000), h(60_000), 0.6, 0.75]);
  assert.equal(e.eac, Math.round(h(200_000) / 0.75));
  // Without budgets the BAC is spread by duration.
  const d = earnedValue(acts.map((a) => ({ ...a, budget: 0 })), { bac: h(1_000), ac: 0, date: "2026-01-20" });
  assert.equal(d.pv, h(1_000));
  assert.deepEqual(plannedCurve(acts, 0).map((c) => c.pv), [h(200_000)]);
});

test("cash flow: the remaining work on the curve, in after the payment lag, out in the month", () => {
  const curve = [{ period: "2026-01", pv: 0 }, { period: "2026-02", pv: 50 }, { period: "2026-03", pv: 100 }];
  const r = cashFlow({ curve, from: "2026-02", months: 3, remainingRevenue: h(1_000), remainingCost: h(800), retentionPct: 10, advanceToRecover: 0, vatPct: 15, inputVatShare: 0, paymentLagMonths: 1 });
  assert.deepEqual(r.map((m) => [m.inflow, m.outflow]), [[0, h(400)], [h(525), h(400)], [h(525), 0]]);
  assert.equal(r.at(-1)!.cumulative, h(250));
});

import { parseMspdi, parseXer } from "../src/lib/contracting/scheduleImport.ts";
test("programme import: P6 XER (WBS as parents) and MS Project XML (outline as parents)", () => {
  const xer = ["ERMHDR\t21.12", "%T\tPROJWBS", "%F\twbs_id\tparent_wbs_id\twbs_short_name\twbs_name\tproj_node_flag", "%R\t1\t\tP\tالمشروع\tY", "%R\t2\t1\tSTR\tالهيكل\tN",
    "%T\tTASK", "%F\ttask_code\ttask_name\twbs_id\ttarget_start_date\ttarget_end_date\tphys_complete_pct\tact_start_date\tact_end_date",
    "%R\tA100\tحفر\t2\t2026-01-01 08:00\t2026-01-15 17:00\t40\t2026-01-02 08:00\t", "%E"].join("\r\n");
  const x = parseXer(xer);
  assert.deepEqual(x.map((a) => [a.code, a.parentCode, a.isSummary, a.start, a.pctComplete, a.actualStart]),
    [["WBS-STR", null, true, "", 0, null], ["A100", "WBS-STR", false, "2026-01-01", 40, "2026-01-02"]]);
  const xml = `<Project><Tasks><Task><UID>0</UID><OutlineNumber>0</OutlineNumber><Start>2026-01-01T08:00:00</Start><Finish>2026-02-01T17:00:00</Finish></Task>
    <Task><UID>1</UID><Name>الأساسات</Name><WBS>1</WBS><OutlineNumber>1</OutlineNumber><Summary>1</Summary><Start>2026-01-01T08:00:00</Start><Finish>2026-01-20T17:00:00</Finish></Task>
    <Task><UID>2</UID><Name>صب &amp; معالجة</Name><WBS>1.1</WBS><OutlineNumber>1.1</OutlineNumber><Start>2026-01-05T08:00:00</Start><Finish>2026-01-20T17:00:00</Finish><PercentComplete>25</PercentComplete></Task>
  </Tasks></Project>`;
  const m = parseMspdi(xml);
  assert.deepEqual(m.map((a) => [a.code, a.name, a.parentCode, a.isSummary, a.pctComplete]), [["1", "الأساسات", null, true, 0], ["1.1", "صب & معالجة", "1", false, 25]]);
  assert.throws(() => parseXer("nothing"), /xer_no_tasks/);
});

import { daysLate, nextRevision, safetyRates, sniffMime } from "../src/lib/contracting/siteQuality.ts";
test("site: safety rates per man-hours, file types by their bytes, revision codes", () => {
  assert.deepEqual(safetyRates({ manhours: 500_000, lostTime: 1, recordable: 3 }), { ltifr: 2, trir: 1.2 });
  assert.deepEqual(safetyRates({ manhours: 0, lostTime: 1, recordable: 1 }), { ltifr: null, trir: null });
  assert.equal(sniffMime(new TextEncoder().encode("%PDF-1.7\n")), "application/pdf");
  assert.equal(sniffMime(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), "image/png");
  assert.equal(sniffMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffMime(new TextEncoder().encode("AC1032\0\0")), "image/vnd.dwg");
  assert.equal(sniffMime(new TextEncoder().encode("MZ\x90\0 not a drawing")), null);
  assert.deepEqual([nextRevision(null), nextRevision("A"), nextRevision("Z"), nextRevision("AZ"), nextRevision("0"), nextRevision("9")], ["A", "B", "AA", "BA", "1", "10"]);
  assert.deepEqual([daysLate("2026-01-01", "2026-01-11"), daysLate("2026-01-20", "2026-01-11"), daysLate(null, "2026-01-11")], [10, 0, 0]);
});

import { billableShare, canMove, checkTerms, quantitiesToDate } from "../src/lib/contracting/telecom.ts";
test("telecom: the site moves forward only, acceptance in order; milestones bill their share", () => {
  assert.equal(canMove("planned", "installation").ok, true, "steps that do not apply are skipped");
  assert.equal(canMove("civil", "survey").ok, false);
  assert.equal(canMove("installation", "pac").ok, false, "PAC after on air");
  assert.equal(canMove("on_air", "fac").ok, false, "FAC after PAC");
  assert.equal(canMove("on_air", "cancelled").ok, false);
  assert.equal(canMove("fac", "cancelled").ok, false);
  const terms = { on_air: 60, pac: 30, fac: 10 };
  assert.deepEqual([billableShare("installation", terms), billableShare("on_air", terms), billableShare("pac", terms), billableShare("fac", terms), billableShare("cancelled", terms)],
    [0, 0.6, 0.9, 1, 0]);
  assert.equal(checkTerms([{ milestone: "on_air", pct: 60 }, { milestone: "pac", pct: 30 }]), "مجموع النسب 90% ويجب أن يكون 100%");
  assert.equal(checkTerms([{ milestone: "on_air", pct: 70 }, { milestone: "pac", pct: 30 }]), null);
  const q = quantitiesToDate([
    { status: "on_air", items: [{ code: "T1", quantity: 1 }, { code: "T2", quantity: 3 }] },
    { status: "pac", items: [{ code: "T1", quantity: 1 }] },
    { status: "civil", items: [{ code: "T1", quantity: 1 }] }], terms);
  assert.deepEqual([...q.entries()], [["T1", 1.5], ["T2", 1.8]]);
});

import { addMonths, finalAcceptanceBlockers } from "../src/lib/contracting/handover.ts";
test("handover: DLP end by calendar months; what blocks the final acceptance", () => {
  assert.deepEqual([addMonths("2026-01-31", 1), addMonths("2024-01-31", 1), addMonths("2026-03-15", 12), addMonths("2026-11-30", 3), addMonths("2026-05-10", 120)],
    ["2026-02-28", "2024-02-29", "2027-03-15", "2027-02-28", "2036-05-10"]);
  assert.deepEqual(finalAcceptanceBlockers({ openItems: 0, ipcsInProgress: 0, dlpEndsOn: "2026-06-01", date: "2026-06-01", earlyReason: null }), []);
  assert.equal(finalAcceptanceBlockers({ openItems: 2, ipcsInProgress: 1, dlpEndsOn: "2026-06-01", date: "2026-05-01", earlyReason: null }).length, 3);
  assert.equal(finalAcceptanceBlockers({ openItems: 0, ipcsInProgress: 0, dlpEndsOn: "2026-06-01", date: "2026-05-01", earlyReason: "موافقة المالك" }).length, 0);
});
