import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { after, before, describe, it } from "node:test";
import { call, createUser, expectStatus, ownerPool, raiseLimits, startApp, stopApp, type Actor, type App } from "./helpers.ts";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
function multipart(file: Buffer) {
  const boundary = `----munassiq${randomUUID()}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="boq.xlsx"\r\nContent-Type: ${XLSX}\r\n\r\n`), file, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return { payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}
async function workbook(rows: (string | number)[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("BOQ");
  ws.addRow(["الرمز", "الأب", "الوصف", "الوحدة", "الكمية", "السعر", "قسم", "احتياطي", "المواصفة"]);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// Contracting C1–C3 (docs/contracting/ARCHITECTURE.md): a contract whose statutory caps come only from values the
// platform admin verified; the BOQ from Excel; the advance (386); IPCs to a 388 invoice where retention does not
// reduce VAT and the advance is recovered pro rata; delay damages as a 381 credit note; Art. 67 variation caps; claims.
// The statutory values here are the test's own rows on a random day before the seeded periods, removed afterwards.
describe("contracting: contract → BOQ → advance → IPCs → variations", () => {
  let app: App;
  let admin: Actor;
  let owner: Actor;
  let t: string;
  let project: string;
  let contract: string;
  let customer: string;
  const day = new Date(Date.UTC(1950 + randomInt(0, 60), randomInt(0, 12), randomInt(1, 28))).toISOString().slice(0, 10);
  const paramIds: string[] = [];

  const post = async (url: string, body: object = {}, status = 201) => {
    const r = await call(app, owner, "POST", url, { tenant: t, idem: true, body });
    expectStatus(r, status, url);
    return r.body;
  };
  const get = async (url: string) => { const r = await call(app, owner, "GET", url, { tenant: t }); expectStatus(r, 200, url); return r.body; };
  const ledger = async (key: string) => Number((await ownerPool.query<{ b: string }>(
    `SELECT coalesce(sum(l.debit - l.credit), 0)::text AS b FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.tenant_id = $1 AND a.system_key = $2`, [t, key])).rows[0]!.b);

  before(async () => {
    app = await startApp();
    admin = await createUser({ admin: true });
    owner = await createUser();
    const r = await call(app, owner, "POST", "/tenants", { body: { companyName: "مقاولات الاختبار", sector: "contracting", taxId: `3${randomInt(10_000_000, 99_999_999)}${randomInt(100_000, 999_999)}`, city: "الرياض" } });
    expectStatus(r, 201, "contracting tenant");
    t = r.body.id;
    await raiseLimits(t);
    await ownerPool.query("UPDATE tenants SET tax_id = '399999999900003' WHERE id = $1", [t]);
    expectStatus(await call(app, owner, "PUT", "/t/accounting/tax-profile", { tenant: t, body: {
      legalName: "مقاولات الاختبار", crNumber: "1010010000", street: "طريق الملك فهد", buildingNo: "1234", district: "العليا", city: "الرياض", postalCode: "12345" } }), 200, "profile");
    customer = (await post("/t/customers", { name: "وزارة الاختبار", phone: `05${randomInt(10_000_000, 99_999_999)}`, customerType: "business",
      vatNumber: "310123456700003", street: "شارع العليا", buildingNo: "4321", district: "الملز", city: "الرياض", postalCode: "11564" })).id;
    // The statutory values of this test's own "law day", as drafts: the admin verifies them below.
    for (const [key, value] of [["delay_penalty_cap_other", 10], ["vo_new_items_cap_pct", 10], ["vo_increase_consent_pct", 10], ["vo_total_increase_cap_pct", 20], ["vo_decrease_cap_pct", 20]] as const) {
      const p = await call(app, admin, "POST", "/admin/regulatory-parameters", { body: { key, regime: "GTPL_1440", value, unit: "percent", label: `اختبار ${key}`,
        legalBasis: "مادة اختبار", sourceTitle: "مصدر اختبار", confidence: "official", effectiveFrom: day, effectiveTo: day } });
      expectStatus(p, 201, `param ${key}`);
      paramIds.push(p.body.id);
    }
  });
  after(async () => {
    const c = await ownerPool.connect();
    try {
      await c.query("SET session_replication_role = replica"); // test rows only; the guard trigger protects real verified values
      await c.query("DELETE FROM regulatory_parameters WHERE id = ANY($1::uuid[])", [paramIds]);
    } finally { await c.query("SET session_replication_role = DEFAULT"); c.release(); }
    await stopApp(app);
  });

  it("only the platform admin manages statutory values; a draft overlapping another is refused", async () => {
    expectStatus(await call(app, owner, "GET", "/admin/regulatory-parameters"), 403, "owner is not admin");
    const list = await call(app, admin, "GET", "/admin/regulatory-parameters?status=draft");
    assert.ok(list.body.items.some((p: { id: string }) => p.id === paramIds[0]));
    const dup = await call(app, admin, "POST", "/admin/regulatory-parameters", { body: { key: "delay_penalty_cap_other", regime: "GTPL_1440", value: 12, unit: "percent",
      label: "مكرر", legalBasis: "مادة", sourceTitle: "مصدر", confidence: "official", effectiveFrom: day, effectiveTo: day } });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error?.code, "parameter_overlap");
  });

  it("creates the project (its own cost center), the contract, and imports the BOQ from Excel", async () => {
    const acc = (await ownerPool.query("SELECT code, system_key FROM accounts WHERE tenant_id = $1 AND system_key IN ('contract_revenue', 'retention_receivable', 'customer_advances', 'bank_fees') ORDER BY code", [t])).rows;
    assert.deepEqual(acc.map((a: { code: string }) => a.code), ["1118", "2108", "4104", "6110"], "a new contracting workspace has its accounts from provisioning");
    project = (await post("/t/projects", { code: `P${randomInt(1000, 9999)}`, name: "مبنى إداري", specialty: "BUILDING", clientId: customer })).id;
    const p = await get(`/t/projects/${project}`);
    assert.ok(p.costCenterId);
    contract = (await post("/t/contracts", { projectId: project, number: `C-${randomInt(1000, 9999)}`, title: "إنشاء المبنى", customerId: customer, profile: "CUSTOM",
      pricingModel: "UNIT_PRICE", governingRegime: "GTPL_1440", governmentClient: true, tenderDate: day, value: 1_000_000,
      advancePct: 10, retentionPct: 10, retentionCapPct: 10, ldRatePerDay: 1000 })).id;
    const bad = multipart(await workbook([["A", "", "أعمال خرسانة", "", "", "", "نعم"], ["A1", "A", "خرسانة", "لتر", 10, 5, "لا"]]));
    const rb = await call(app, owner, "POST", `/t/contracts/${contract}/boq/import`, { tenant: t, body: bad.payload, headers: bad.headers });
    assert.equal(rb.status, 422, "unit outside the specialty's dictionary");
    const good = multipart(await workbook([
      ["A", "", "الأعمال الإنشائية", "", "", "", "نعم"],
      ["A1", "A", "خرسانة مسلحة للأساسات", "m3", 1000, 500, "لا"],
      ["A2", "A", "لياسة", "m2", 2000, 250, "لا"],
    ]));
    const r = await call(app, owner, "POST", `/t/contracts/${contract}/boq/import`, { tenant: t, body: good.payload, headers: good.headers });
    expectStatus(r, 200, "boq import");
    assert.equal(r.body.total, 1_000_000);
  });

  it("activation applies only verified statutory values, and freezes the BOQ", async () => {
    const r1 = await call(app, owner, "POST", `/t/contracts/${contract}/activate`, { tenant: t, body: {} });
    assert.equal(r1.status, 422);
    assert.equal(r1.body.error?.code, "param_unverified");
    for (const id of paramIds) expectStatus(await call(app, admin, "POST", `/admin/regulatory-parameters/${id}/verify`, { body: {} }), 200, "verify");
    const edit = await call(app, admin, "PUT", `/admin/regulatory-parameters/${paramIds[0]}`, { body: { key: "delay_penalty_cap_other", regime: "GTPL_1440", value: 50, unit: "percent",
      label: "اختبار", legalBasis: "مادة اختبار", sourceTitle: "مصدر اختبار", confidence: "official", effectiveFrom: day, effectiveTo: day } });
    assert.equal(edit.body.error?.code, "parameter_verified", "a verified value is not edited");
    const r2 = await post(`/t/contracts/${contract}/activate`, {}, 200);
    assert.equal(r2.appliedParams.delay_penalty_cap_other.value, 10);
    const c = await get(`/t/contracts/${contract}`);
    assert.equal(c.status, "active");
    assert.equal(c.ldCapPct, 10);
    const add = await call(app, owner, "POST", `/t/contracts/${contract}/boq/items`, { tenant: t, body: { code: "A3", description: "بند", unit: "m2", quantity: 1, rate: 1 } });
    assert.equal(add.body.error?.code, "boq_frozen");
  });

  it("the advance is a prepayment invoice within the agreed percentage", async () => {
    const over = await call(app, owner, "POST", `/t/contracts/${contract}/advance`, { tenant: t, idem: true, body: { amount: 100_001 } });
    assert.equal(over.body.error?.code, "advance_exceeds_contract");
    const a = await post(`/t/contracts/${contract}/advance`, {});
    const d = (await ownerPool.query("SELECT kind, taxable::float8 AS taxable, vat::float8 AS vat, contract_id FROM sales_documents WHERE id = $1", [a.id])).rows[0];
    assert.deepEqual([d.kind, d.taxable, d.vat, d.contract_id], ["prepayment", 100_000, 15_000, contract]);
  });

  let ipc1: string;
  it("IPC 1: submitted, certified lower, approved; retention and pro-rata advance recovery, full VAT", async () => {
    ipc1 = (await post(`/t/contracts/${contract}/ipcs`, { periodFrom: "2025-01-01", periodTo: "2025-01-31" })).id;
    const open = await call(app, owner, "POST", `/t/contracts/${contract}/ipcs`, { tenant: t, body: { periodFrom: "2025-02-01", periodTo: "2025-02-28" } });
    assert.equal(open.body.error?.code, "ipc_open", "one open IPC at a time");
    let i = await get(`/t/ipcs/${ipc1}`);
    const line = (c: string) => i.lines.find((l: { code: string }) => l.code === c);
    expectStatus(await call(app, owner, "PUT", `/t/ipcs/${ipc1}/quantities`, { tenant: t, body: { lines: [{ id: line("A1").id, quantity: 400 }] } }), 200, "qty");
    await post(`/t/ipcs/${ipc1}/submit`, {}, 200);
    i = await get(`/t/ipcs/${ipc1}`);
    await post(`/t/ipcs/${ipc1}/certify`, { lines: [{ id: line("A1").id, quantity: 380 }] }, 200);
    const inv0 = await call(app, owner, "POST", `/t/ipcs/${ipc1}/invoice`, { tenant: t, idem: true, body: {} });
    assert.equal(inv0.status, 409, "invoice needs the client's approval");
    const ap = await post(`/t/ipcs/${ipc1}/approve`, {}, 200);
    assert.deepEqual([ap.totals.currentGross, ap.totals.retention, ap.totals.advanceRecovery, ap.totals.advanceRecoveryVat, ap.totals.vat, ap.totals.netPayable],
      [190_000, 19_000, 19_000, 2_850, 28_500, 190_000 + 28_500 - 19_000 - 19_000 - 2_850]);
  });

  it("the IPC's tax invoice: government client needs the payment order date; retention booked apart; advance deducted", async () => {
    const noOrder = await call(app, owner, "POST", `/t/ipcs/${ipc1}/invoice`, { tenant: t, idem: true, body: {} });
    assert.equal(noOrder.body.error?.code, "payment_order_required");
    const key = randomUUID();
    const inv = await call(app, owner, "POST", `/t/ipcs/${ipc1}/invoice`, { tenant: t, idem: key, body: { paymentOrderDate: "2025-02-10" } });
    expectStatus(inv, 201, "invoice");
    const again = await call(app, owner, "POST", `/t/ipcs/${ipc1}/invoice`, { tenant: t, idem: key, body: { paymentOrderDate: "2025-02-10" } });
    assert.equal(again.body.id, inv.body.id, "replay returns the same invoice");
    const d = (await ownerPool.query("SELECT kind, taxable::float8 AS taxable, vat::float8 AS vat, retention_amount::float8 AS retention, prepaid_amount::float8 AS prepaid FROM sales_documents WHERE id = $1",
      [inv.body.id])).rows[0];
    assert.equal(d.kind, "invoice");
    assert.equal(d.retention, 19_000);
    assert.equal(d.prepaid, 21_850, "the recovered share of the advance, with its VAT");
    const doc = await get(`/t/sales-documents/${inv.body.id}`);
    assert.equal(doc.balance, 177_650, "what the client owes now");
    assert.equal(await ledger("retention_receivable"), 19_000);
    const cc = (await ownerPool.query("SELECT count(*)::int AS n FROM journal_lines l JOIN projects p ON p.cost_center_id = l.cost_center_id WHERE p.id = $1", [project])).rows[0].n;
    assert.ok(cc > 0, "the invoice's postings carry the project's cost center");
    const list = await get(`/t/contracts/${contract}/ipcs`);
    assert.equal(list.items[0].status, "invoiced");
  });

  it("final IPC with delay damages: capped, as a credit note with VAT; the rest of the advance is recovered", async () => {
    const id = (await post(`/t/contracts/${contract}/ipcs`, { periodFrom: "2025-02-01", periodTo: "2025-03-31", kind: "final" })).id;
    const i = await get(`/t/ipcs/${id}`);
    assert.equal(i.lines.find((l: { code: string }) => l.code === "A1").previousQty, 380);
    const lines = i.lines.filter((l: { kind: string }) => l.kind === "boq").map((l: { id: string; code: string }) => ({ id: l.id, quantity: l.code === "A1" ? 1000 : 2000 }));
    expectStatus(await call(app, owner, "PUT", `/t/ipcs/${id}/quantities`, { tenant: t, body: { lines } }), 200, "qty");
    await post(`/t/ipcs/${id}/submit`, { ldDays: 5 }, 200);
    const ap = await post(`/t/ipcs/${id}/approve`, {}, 200);
    assert.deepEqual([ap.totals.currentGross, ap.totals.retention, ap.totals.advanceRecovery, ap.totals.ld, ap.totals.ldVat], [810_000, 81_000, 81_000, 5_000, 750]);
    const inv = await post(`/t/ipcs/${id}/invoice`, { paymentOrderDate: "2025-04-05" });
    assert.ok(inv.creditNote);
    const n = (await ownerPool.query("SELECT kind, taxable::float8 AS taxable, vat::float8 AS vat, original_id, contract_id FROM sales_documents WHERE id = $1", [inv.creditNote.id])).rows[0];
    assert.deepEqual([n.kind, n.taxable, n.vat, n.original_id, n.contract_id], ["credit_note", 5_000, 750, inv.id, contract]);
    const c = await get(`/t/contracts/${contract}`);
    assert.equal(c.figures.advanceRecovered, 100_000);
    assert.equal(c.figures.retentionHeld, 100_000);
    const more = await call(app, owner, "POST", `/t/contracts/${contract}/ipcs`, { tenant: t, body: { periodFrom: "2025-05-01", periodTo: "2025-05-31" } });
    assert.equal(more.status, 409, "no IPC after the final one");
  });

  it("variation orders respect the Art. 67 caps resolved at activation", async () => {
    const vo = (amount: number) => post(`/t/contracts/${contract}/variations`, { title: "بنود إضافية", source: "client_request",
      lines: [{ kind: "new_item", code: `N${randomInt(100, 999)}`, description: "بند جديد", unit: "no", quantity: 1, rate: amount }] });
    const v1 = (await vo(60_000)).id;
    const noConsent = await call(app, owner, "POST", `/t/variations/${v1}/approve`, { tenant: t, body: {} });
    assert.equal(noConsent.body.error?.code, "variation_cap");
    const ok = await post(`/t/variations/${v1}/approve`, { contractorConsent: true }, 200);
    assert.equal(ok.capCheck.remaining.newItems, 40_000);
    const v2 = (await vo(50_000)).id;
    const over = await call(app, owner, "POST", `/t/variations/${v2}/approve`, { tenant: t, body: { contractorConsent: true } });
    assert.equal(over.body.error?.code, "variation_cap", "new items above 10% of the contract");
    await post(`/t/variations/${v2}/reject`, {}, 200);
    const list = await get(`/t/contracts/${contract}/variations`);
    assert.deepEqual(list.items.map((v: { status: string }) => v.status), ["rejected", "approved"]);
  });

  it("the client releases retention: money in, the receivable goes down", async () => {
    const noMethod = await call(app, owner, "POST", `/t/contracts/${contract}/retention-release`, { tenant: t, idem: true, body: { amount: 40_000, reason: "الاستلام الابتدائي" } });
    assert.equal(noMethod.status, 422);
    await post(`/t/contracts/${contract}/retention-release`, { amount: 40_000, method: "bank_transfer", reason: "الاستلام الابتدائي" });
    assert.equal(await ledger("retention_receivable"), 100_000 - 40_000);
    assert.equal((await get("/t/contracting/retention")).totals.receivable, 60_000);
  });

  it("the VAT return's box 1 agrees with the output VAT ledger (an advance deducted by an invoice is not declared twice)", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const v = await get(`/t/accounting/vat-return?from=${today.slice(0, 8)}01&to=${today}`);
    const box1 = v.sales.find((x: { no: number }) => x.no === 1);
    assert.equal(box1.vat, -(await ledger("vat_output")));
  });

  it("claims carry their notice deadline from the contract", async () => {
    const ev = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    await post(`/t/contracts/${contract}/claims`, { title: "تأخر تسليم الموقع", kind: "time", eventDate: ev, description: "تأخر العميل في تسليم الموقع", daysClaimed: 20 });
    const c = (await get(`/t/contracts/${contract}/claims`)).items[0];
    assert.equal(c.noticeDeadline, new Date(Date.parse(ev) + 30 * 86_400_000).toISOString().slice(0, 10));
    assert.equal(c.noticeMissed, false);
    const bad = await call(app, owner, "PUT", `/t/claims/${c.id}`, { tenant: t, body: { status: "notified" } });
    assert.equal(bad.status, 422, "a notice needs its date");
    expectStatus(await call(app, owner, "PUT", `/t/claims/${c.id}`, { tenant: t, body: { status: "notified", noticeDate: ev } }), 200, "notify");
  });
});
