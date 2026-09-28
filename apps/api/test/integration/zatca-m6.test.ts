import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { setZatcaTransport } from "../../src/lib/zatca/service.ts";
import { sweepZatca } from "../../src/lib/zatca/worker.ts";
import { call, code, createFactory, createIngredient, createUser, expectStatus, ownerPool, raiseLimits, receivePo, startApp, stopApp, type Actor, type App } from "./helpers.ts";
import { transport, zatca } from "./zatca-sim.ts";

// Manufacturing M6 (docs/manufacturing/ARCHITECTURE.md): a device per branch, prepayment invoices (386) deducted by
// the final invoice, the export flag (KSA-2), and the durable reporting worker. The simulator re-checks every
// document's hash and signature, as ZATCA does.
describe("ZATCA for factories", () => {
  let app: App;
  let owner: Actor;
  let t: string;
  let b1: string; let b2: string;
  let store1: string; let store2: string;
  let F: string;
  let buyer: string;

  const post = async (url: string, body: object = {}, status = 201) => {
    const r = await call(app, owner, "POST", url, { tenant: t, idem: true, body });
    expectStatus(r, status, url);
    return r.body;
  };
  const get = async (url: string) => (await call(app, owner, "GET", url, { tenant: t })).body;
  const ledger = async (key: string) => Number((await ownerPool.query<{ b: string }>(
    `SELECT coalesce(sum(l.debit - l.credit), 0)::text AS b FROM journal_lines l JOIN accounts a ON a.id = l.account_id
      WHERE a.tenant_id = $1 AND a.system_key = $2`, [t, key])).rows[0]!.b);
  const zdoc = async (sourceId: string) => (await ownerPool.query<{ kind: string; xml: string; branch_id: string | null }>(
    "SELECT d.kind, d.xml, v.branch_id FROM zatca_documents d JOIN zatca_devices v ON v.id = d.device_id WHERE d.source_id = $1", [sourceId])).rows[0]!;
  const order = async (locationId: string, customerId: string, lines: object[]) => {
    const id = (await post("/t/sales-orders", { customerId, locationId, lines })).id as string;
    await post(`/t/sales-orders/${id}/confirm`, {}, 200);
    return id;
  };
  const onboard = { environment: "simulation", otp: "123456", invoiceTypes: "1100", organizationUnit: "المصنع", location: "RRRD2929", industry: "Manufacturing" };

  before(async () => {
    setZatcaTransport(transport);
    app = await startApp();
    owner = await createUser();
    t = await createFactory(app, owner);
    await raiseLimits(t);
    await ownerPool.query("UPDATE tenants SET tax_id = '399999999900003' WHERE id = $1", [t]);
    expectStatus(await call(app, owner, "PUT", "/t/accounting/tax-profile", { tenant: t, body: {
      legalName: "مصنع الاختبار", crNumber: "1010010000", street: "طريق الملك فهد", buildingNo: "1234", district: "العليا", city: "الرياض", postalCode: "12345" } }), 200, "profile");
    b1 = (await post("/t/branches", { code: code("B"), name: "مصنع الرياض" })).id;
    b2 = (await post("/t/branches", { code: code("B"), name: "مستودع جدة" })).id;
    store1 = (await post("/t/locations", { code: code("W"), name: "مستودع الرياض", locationType: "warehouse", branchId: b1 })).id;
    store2 = (await post("/t/locations", { code: code("W"), name: "مستودع جدة", locationType: "warehouse", branchId: b2 })).id;
    const sup = (await post("/t/suppliers", { code: code("S"), name: "مورد" })).id;
    F = await createIngredient(app, owner, t, "كرتون عصير", "pcs", "pcs", { itemType: "finished", salePrice: 100 });
    await receivePo(app, owner, t, { supplierId: sup, locationId: store1, items: [{ ingredientId: F, quantity: 50, unitPrice: 40 }] });
    await receivePo(app, owner, t, { supplierId: sup, locationId: store2, items: [{ ingredientId: F, quantity: 50, unitPrice: 40 }] });
    buyer = (await post("/t/customers", { name: "شركة الجملة", phone: `05${Math.floor(10000000 + Math.random() * 89999999)}`, customerType: "business",
      vatNumber: "310123456700003", street: "شارع العليا", buildingNo: "4321", district: "الملز", city: "الرياض", postalCode: "11564" })).id;
  });
  after(async () => { setZatcaTransport(null); await new Promise((r) => setTimeout(r, 200)); await stopApp(app); });

  it("a branch onboards its own device; a branch without one uses the workspace-wide device", async () => {
    expectStatus(await call(app, owner, "POST", "/t/zatca/onboard", { tenant: t, body: onboard }), 200, "workspace device");
    expectStatus(await call(app, owner, "POST", "/t/zatca/onboard", { tenant: t, body: { ...onboard, organizationUnit: "فرع الرياض", branchId: b1 } }), 200, "branch device");
    const s = await get("/t/zatca/status");
    assert.deepEqual(s.devices.map((d: { branchName: string | null; status: string }) => [d.branchName, d.status]).sort(), [[null, "active"], ["مصنع الرياض", "active"]]);
    // Re-onboarding the branch retires only the branch's previous device.
    expectStatus(await call(app, owner, "POST", "/t/zatca/onboard", { tenant: t, body: { ...onboard, organizationUnit: "فرع الرياض", branchId: b1 } }), 200, "again");
    const active = (await ownerPool.query<{ branch_id: string | null }>("SELECT branch_id FROM zatca_devices WHERE tenant_id = $1 AND status = 'active'", [t])).rows;
    assert.equal(active.length, 2);
  });

  let so: string;
  let pre: string;

  it("a prepayment invoice (386) on a confirmed order: VAT due now, the amount held as a customer advance", async () => {
    so = await order(store1, buyer, [{ itemId: F, quantity: 10 }]); // 1,000 + 150 VAT = 1,150
    const p = await post(`/t/sales-orders/${so}/prepayments`, { amount: 460, paymentMeans: "bank_transfer" });
    pre = p.id;
    assert.match(p.number, /^PRE-/);
    assert.equal(p.zatca.outcome, "accepted", "cleared like any standard document");
    const z = await zdoc(pre);
    assert.equal(z.kind, "prepayment");
    assert.equal(z.branch_id, b1, "signed by the branch's own device");
    assert.match(z.xml, /<cbc:InvoiceTypeCode name="0100000">386<\/cbc:InvoiceTypeCode>/);
    assert.equal(await ledger("customer_advances"), -400);
    assert.equal(await ledger("vat_output"), -60);
    const over = await call(app, owner, "POST", `/t/sales-orders/${so}/prepayments`, { tenant: t, idem: true, body: { amount: 800, paymentMeans: "cash" } });
    assert.equal(over.body.error.code, "prepayment_exceeds_order", "1,150 − 460 = 690 left");
    const cancel = await call(app, owner, "POST", `/t/sales-orders/${so}/cancel`, { tenant: t, body: { reason: "تجربة" } });
    assert.equal(cancel.body.error.code, "prepayment_open");
    assert.deepEqual((await get(`/t/sales-orders/${so}`)).unappliedPrepayments.map((x: { remaining: number }) => x.remaining), [460]);
  });

  it("the final invoice deducts the advance: prepayment line, PrepaidAmount, and only the rest is owed", async () => {
    const line = (await get(`/t/sales-orders/${so}`)).lines[0].id;
    await post(`/t/sales-orders/${so}/deliver`, { lines: [{ lineId: line, quantity: 10 }] });
    const inv = await post(`/t/sales-orders/${so}/invoice`, {});
    assert.equal(inv.prepaid, 460);
    assert.equal(inv.zatca.outcome, "accepted", `hash and signature verify: ${JSON.stringify(inv.zatca)}`);
    const xml = (await zdoc(inv.id)).xml;
    assert.match(xml, /<cbc:PrepaidAmount currencyID="SAR">460.00<\/cbc:PrepaidAmount><cbc:PayableAmount currencyID="SAR">690.00<\/cbc:PayableAmount>/);
    assert.match(xml, /<cac:DocumentReference><cbc:ID>PRE-\d+<\/cbc:ID><cbc:IssueDate>[\d-]+<\/cbc:IssueDate><cbc:IssueTime>[\d:]+<\/cbc:IssueTime><cbc:DocumentTypeCode>386<\/cbc:DocumentTypeCode><\/cac:DocumentReference>/);
    assert.match(xml, /<cbc:TaxableAmount currencyID="SAR">400.00<\/cbc:TaxableAmount><cbc:TaxAmount currencyID="SAR">60.00<\/cbc:TaxAmount>/, "KSA-31/32 on the prepayment line");
    const d = await get(`/t/sales-documents/${inv.id}`);
    assert.equal(d.balance, 690);
    assert.equal(d.prepayments.length, 1);
    // The advance and its VAT leave; output VAT is the invoice's 150 in total; the customer owes 690.
    assert.equal(await ledger("customer_advances"), 0);
    assert.equal(await ledger("vat_output"), -150);
    assert.equal(await ledger("ar"), 690);
    assert.equal((await get(`/t/sales-orders/${so}`)).unappliedPrepayments.length, 0);
  });

  it("an advance nothing deducted is refunded by a credit note on the prepayment; then the order can be cancelled", async () => {
    const o2 = await order(store1, buyer, [{ itemId: F, quantity: 2 }]);
    const p = await post(`/t/sales-orders/${o2}/prepayments`, { amount: 115, paymentMeans: "cash" });
    const tooMuch = await call(app, owner, "POST", `/t/sales-orders/${o2}/prepayments/${p.id}/refund`, { tenant: t, idem: true, body: { amount: 200, paymentMeans: "cash", reason: "إلغاء الطلب" } });
    assert.equal(tooMuch.status, 409);
    const cn = await post(`/t/sales-orders/${o2}/prepayments/${p.id}/refund`, { amount: 115, paymentMeans: "cash", reason: "إلغاء الطلب" });
    assert.match(cn.number, /^CRN-/);
    assert.equal(cn.zatca.outcome, "accepted");
    assert.match((await zdoc(cn.id)).xml, /<cbc:InvoiceTypeCode name="0100000">381<\/cbc:InvoiceTypeCode>/);
    assert.equal(await ledger("customer_advances"), 0);
    await post(`/t/sales-orders/${o2}/cancel`, { reason: "ألغى العميل" }, 200);
  });

  it("an export invoice carries the KSA-2 export flag; standard-rated lines cannot be exported", async () => {
    const foreign = (await post("/t/customers", { name: "Gulf Trading LLC", phone: `05${Math.floor(10000000 + Math.random() * 89999999)}`, customerType: "business",
      countryCode: "AE", city: "Dubai", street: "Sheikh Zayed Rd" })).id;
    const ex = await order(store2, foreign, [{ itemId: F, quantity: 5, vatCategory: "Z", exemptionCode: "VATEX-SA-32" }]);
    const line = (await get(`/t/sales-orders/${ex}`)).lines[0].id;
    await post(`/t/sales-orders/${ex}/deliver`, { lines: [{ lineId: line, quantity: 5 }] });
    const inv = await post(`/t/sales-orders/${ex}/invoice`, { isExport: true });
    const z = await zdoc(inv.id);
    assert.match(z.xml, /<cbc:InvoiceTypeCode name="0100100">388<\/cbc:InvoiceTypeCode>/);
    assert.equal(z.branch_id, null, "the Jeddah branch has no device: the workspace-wide one signs");
    assert.equal(inv.zatca.outcome, "accepted");

    const local = await order(store2, buyer, [{ itemId: F, quantity: 1 }]);
    const l2 = (await get(`/t/sales-orders/${local}`)).lines[0].id;
    await post(`/t/sales-orders/${local}/deliver`, { lines: [{ lineId: l2, quantity: 1 }] });
    const bad = await call(app, owner, "POST", `/t/sales-orders/${local}/invoice`, { tenant: t, idem: true, body: { isExport: true } });
    assert.equal(bad.status, 422, "a Saudi buyer and a standard-rated line are not an export");
  });

  it("the worker resends what the network lost, and the page shows it", async () => {
    zatca.networkDown = true;
    const doc = await post("/t/sales-documents", { invoiceType: "simplified", paymentMeans: "cash", branchId: b1,
      lines: [{ description: "بيع نقدي", quantity: 1, unitPrice: 50 }] });
    await new Promise((r) => setTimeout(r, 300));
    const outcome = async () => (await ownerPool.query<{ o: string }>(
      "SELECT s.outcome AS o FROM zatca_submissions s JOIN zatca_documents d ON d.id = s.document_id WHERE d.source_id = $1 ORDER BY s.created_at DESC LIMIT 1", [doc.id])).rows[0]?.o;
    assert.equal(await outcome(), "error", "reported right away, and failed");
    let s = await get("/t/zatca/status");
    assert.ok(s.counts.pending >= 1);
    assert.ok(s.oldestPendingAt);
    // The retry waits a minute after a failure: age the failed attempt instead of waiting.
    const c = await ownerPool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      await c.query("UPDATE zatca_submissions SET created_at = created_at - interval '2 minutes' WHERE tenant_id = $1", [t]);
      await c.query("COMMIT");
    } finally { c.release(); }
    zatca.networkDown = false;
    const run = await sweepZatca(500);
    assert.ok(run, "this process holds the worker lock");
    assert.equal(await outcome(), "accepted");
    s = await get("/t/zatca/status");
    assert.equal(s.counts.pending, 0);
    assert.ok(s.worker?.at);
  });
});
