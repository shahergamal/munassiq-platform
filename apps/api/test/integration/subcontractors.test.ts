import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { call, createUser, expectStatus, ownerPool, raiseLimits, startApp, stopApp, type Actor, type App } from "./helpers.ts";

// Contracting C4 (docs/contracting/ARCHITECTURE.md): subcontractor qualification, the subcontracted share within the
// main form's ceilings (Etimad: 30% with approval, under 50%), an advance paid to a subcontractor, its IPC with
// retention payable, advance recovery and set-off, a non-resident's reverse charge (VAT return box 9), retention
// release and aging.
describe("contracting: subcontractors", () => {
  let app: App;
  let owner: Actor;
  let t: string;
  let project: string;
  let main: string;
  let resident: string;
  let foreign: string;
  let sub1: string;
  let sub2: string;
  const ym = new Date().toISOString().slice(0, 7);

  const post = async (url: string, body: object = {}, status = 201) => {
    const r = await call(app, owner, "POST", url, { tenant: t, idem: true, body });
    expectStatus(r, status, url);
    return r.body;
  };
  const get = async (url: string) => { const r = await call(app, owner, "GET", url, { tenant: t }); expectStatus(r, 200, url); return r.body; };
  const ledger = async (key: string) => Number((await ownerPool.query<{ b: string }>(
    `SELECT coalesce(sum(l.debit - l.credit), 0)::text AS b FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.tenant_id = $1 AND a.system_key = $2`, [t, key])).rows[0]!.b);
  const owed = async (supplierId: string) => (await get(`/t/suppliers/${supplierId}/statement`)).closingBalance as number;
  const contract = async (body: object, boq: number) => {
    const id = (await post("/t/contracts", { projectId: project, profile: "CUSTOM", pricingModel: "LUMP_SUM", governingRegime: "PRIVATE", ...body })).id as string;
    await post(`/t/contracts/${id}/boq/items`, { code: "L1", description: "الأعمال", unit: "ls", quantity: 1, rate: boq });
    return id;
  };
  const ipc = async (contractId: string, qty: number, deductions: object[] = []) => {
    const id = (await post(`/t/contracts/${contractId}/ipcs`, { periodFrom: `${ym}-01`, periodTo: `${ym}-28` })).id as string;
    const d = await get(`/t/ipcs/${id}`);
    const line = d.lines.find((l: { kind: string }) => l.kind === "boq");
    expectStatus(await call(app, owner, "PUT", `/t/ipcs/${id}/quantities`, { tenant: t, body: { lines: [{ id: line.id, quantity: qty }] } }), 200, "qty");
    if (deductions.length) expectStatus(await call(app, owner, "PUT", `/t/ipcs/${id}/deductions`, { tenant: t, body: { items: deductions } }), 200, "deductions");
    await post(`/t/ipcs/${id}/submit`, {}, 200);
    return { id, totals: (await post(`/t/ipcs/${id}/approve`, {}, 200)).totals };
  };

  before(async () => {
    app = await startApp();
    owner = await createUser();
    const r = await call(app, owner, "POST", "/tenants", { body: { companyName: "مقاولات الباطن", sector: "contracting", taxId: `3${randomInt(10_000_000, 99_999_999)}${randomInt(100_000, 999_999)}`, city: "الرياض" } });
    expectStatus(r, 201, "tenant");
    t = r.body.id;
    await raiseLimits(t);
    const client = (await post("/t/customers", { name: "مطور", phone: `05${randomInt(10_000_000, 99_999_999)}`, customerType: "business", vatNumber: "310123456700003",
      street: "العليا", buildingNo: "4321", district: "الملز", city: "الرياض", postalCode: "11564" })).id;
    project = (await post("/t/projects", { code: `S${randomInt(1000, 9999)}`, name: "برج", specialty: "BUILDING", clientId: client })).id;
    // The main contract on the Etimad form: its ceilings (30% / under 50%) govern the subcontracts.
    main = (await post("/t/contracts", { projectId: project, number: `M-${randomInt(1000, 9999)}`, title: "الرئيسي", customerId: client, profile: "ETIMAD_GC_2020",
      pricingModel: "LUMP_SUM", governingRegime: "PRIVATE", value: 10_000_000 })).id;
    await post(`/t/contracts/${main}/boq/items`, { code: "M1", description: "الأعمال", unit: "ls", quantity: 1, rate: 10_000_000 });
    await post(`/t/contracts/${main}/activate`, {}, 200);
    resident = (await post("/t/suppliers", { code: `R${randomInt(100, 999)}`, name: "مؤسسة الكهرباء", taxId: "300000000000003" })).id;
    foreign = (await post("/t/suppliers", { code: `F${randomInt(100, 999)}`, name: "Foreign MEP Ltd", residency: "non_resident" })).id;
  });
  after(() => stopApp(app));

  it("a subcontract needs an approved, classified subcontractor; no subcontract of a subcontract", async () => {
    sub1 = await contract({ role: "SUB", number: `B1-${randomInt(1000, 9999)}`, title: "أعمال الكهرباء", supplierId: resident, parentContractId: main, value: 2_500_000,
      advancePct: 10, retentionPct: 10 }, 2_500_000);
    const r = await call(app, owner, "POST", `/t/contracts/${sub1}/activate`, { tenant: t, body: {} });
    assert.equal(r.body.error?.code, "subcontractor_not_approved");
    expectStatus(await call(app, owner, "PUT", `/t/subcontractors/${resident}`, { tenant: t, body: { crNumber: "1010101010" } }), 200, "profile");
    assert.equal((await call(app, owner, "POST", `/t/subcontractors/${resident}/approve`, { tenant: t, body: {} })).status, 422, "classification needed");
    expectStatus(await call(app, owner, "PUT", `/t/subcontractors/${resident}`, { tenant: t, body: { crNumber: "1010101010", classificationField: "الكهرباء",
      classificationGrade: "3", classificationExpiry: "2099-12-31" } }), 200, "profile");
    await post(`/t/subcontractors/${resident}/approve`, {}, 200);
    await post(`/t/contracts/${sub1}/activate`, {}, 200);
    const nested = await call(app, owner, "POST", "/t/contracts", { tenant: t, body: { projectId: project, role: "SUB", number: "X-1", title: "باطن الباطن", supplierId: foreign,
      parentContractId: sub1, profile: "CUSTOM", pricingModel: "LUMP_SUM", governingRegime: "PRIVATE", value: 1 } });
    assert.equal(nested.body.error?.code, "sub_of_sub");
  });

  it("the subcontracted share above 30% needs a documented approval, and stays under 50%", async () => {
    expectStatus(await call(app, owner, "PUT", `/t/subcontractors/${foreign}`, { tenant: t, body: {} }), 200, "profile");
    await post(`/t/subcontractors/${foreign}/approve`, {}, 200);
    sub2 = await contract({ role: "SUB", number: `B2-${randomInt(1000, 9999)}`, title: "أنظمة التكييف", supplierId: foreign, parentContractId: main, value: 1_000_000, retentionPct: 5 }, 1_000_000);
    const r = await call(app, owner, "POST", `/t/contracts/${sub2}/activate`, { tenant: t, body: {} });
    assert.equal(r.body.error?.code, "subcontract_share", "35% without approval");
    await ownerPool.query("UPDATE contracts SET subcontract_approval_ref = 'خطاب الجهة 12/1447' WHERE id = $1", [sub2]);
    await post(`/t/contracts/${sub2}/activate`, {}, 200);
    const big = await contract({ role: "SUB", number: `B3-${randomInt(1000, 9999)}`, title: "تشطيبات", supplierId: resident, parentContractId: main, value: 1_500_000,
      subcontractApprovalRef: "خطاب" }, 1_500_000);
    assert.equal((await call(app, owner, "POST", `/t/contracts/${big}/activate`, { tenant: t, body: {} })).body.error?.code, "subcontract_share", "50% is not under 50%");
  });

  it("an advance to a registered subcontractor needs its invoice; it is an asset and a payable", async () => {
    const no = await call(app, owner, "POST", `/t/contracts/${sub1}/subcontract-advance`, { tenant: t, idem: true, body: {} });
    assert.equal(no.body.error?.code, "supplier_invoice_required");
    await post(`/t/contracts/${sub1}/subcontract-advance`, { supplierInvoice: "EL-ADV-1" });
    assert.equal(await ledger("subcontractor_advances"), 250_000);
    assert.equal(await owed(resident), 287_500);
  });

  let ipc1: string;
  it("the resident's IPC: retention payable, advance recovered, back-charge set off, input VAT", async () => {
    const r = await ipc(sub1, 0.4, [{ kind: "damages", description: "إصلاح أضرار سببها في الموقع", amount: 20_000 }]);
    ipc1 = r.id;
    assert.deepEqual([r.totals.currentGross, r.totals.retention, r.totals.advanceRecovery, r.totals.advanceRecoveryVat, r.totals.vat, r.totals.deductions, r.totals.netPayable],
      [1_000_000, 100_000, 100_000, 15_000, 150_000, 20_000, 915_000]);
    assert.equal((await call(app, owner, "POST", `/t/ipcs/${ipc1}/record`, { tenant: t, body: {} })).body.error?.code, "supplier_invoice_required");
    await post(`/t/ipcs/${ipc1}/record`, { supplierInvoice: "EL-INV-7" }, 200);
    assert.equal(await ledger("subcontract_cost"), 980_000, "the cost less the back-charge");
    assert.equal(await ledger("retention_payable"), -100_000);
    assert.equal(await ledger("subcontractor_advances"), 150_000);
    assert.equal(await ledger("vat_input"), 37_500 + 135_000);
    assert.equal(await owed(resident), 287_500 + 915_000);
    const cc = (await ownerPool.query("SELECT count(*)::int AS n FROM journal_lines l JOIN cost_codes c ON c.id = l.cost_code_id WHERE l.tenant_id = $1 AND c.code = 'SUB'", [t])).rows[0].n;
    assert.ok(cc > 0, "the cost carries the SUB cost code");
  });

  it("a non-resident's IPC: no VAT charged, reverse charge in box 9 of the VAT return", async () => {
    const r = await ipc(sub2, 0.5);
    assert.deepEqual([r.totals.vat, r.totals.reverseChargeVat, r.totals.retention, r.totals.netPayable], [0, 75_000, 25_000, 475_000]);
    await post(`/t/ipcs/${r.id}/record`, {}, 200);
    const v = await get(`/t/accounting/vat-return?from=${ym}-01&to=${ym}-28`);
    const box9 = v.purchases.find((b: { no: number }) => b.no === 9);
    assert.deepEqual([box9.amount, box9.vat], [500_000, 75_000]);
    assert.equal(await owed(foreign), 475_000);
  });

  it("retention is released to the subcontractor (it becomes payable), within what is held; aging shows the rest", async () => {
    const over = await call(app, owner, "POST", `/t/contracts/${sub1}/retention-release`, { tenant: t, idem: true, body: { amount: 100_001, reason: "الاستلام الابتدائي" } });
    assert.equal(over.body.error?.code, "exceeds_retention");
    await post(`/t/contracts/${sub1}/retention-release`, { amount: 50_000, reason: "الاستلام الابتدائي" });
    assert.equal(await ledger("retention_payable"), -75_000);
    assert.equal(await owed(resident), 287_500 + 915_000 + 50_000);
    const aging = await get("/t/contracting/retention");
    assert.equal(aging.totals.payable, 75_000);
    const s = (await get("/t/subcontractors")).items.find((x: { supplierId: string }) => x.supplierId === resident);
    assert.equal(s.retentionHeld, 50_000);
  });
});
