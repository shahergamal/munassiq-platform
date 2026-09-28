import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { INITIAL_PIH } from "../../src/lib/zatca/sign.ts";
import { setZatcaTransport } from "../../src/lib/zatca/service.ts";
import { transport, zatca } from "./zatca-sim.ts";
import {
  type Actor, type App, addMember, call, createApprovedRecipe, createTenant, createUser, expectStatus, openShift, ownerPool, raiseLimits, receivePo, setupKitchen, startApp, stopApp, type Kitchen,
} from "./helpers.ts";

const tlvTags = (b64: string) => { const b = Buffer.from(b64, "base64"); const t: number[] = []; for (let p = 0; p < b.length; p += 2 + b[p + 1]!) t.push(b[p]!); return t; };

describe("ZATCA Phase 2: the workspace onboards its own device; every document is stamped, chained and sent", () => {
  let app: App;
  let owner: Actor;
  let accountant: Actor;
  let tenant: string;
  let k: Kitchen;
  let salad: string;
  let shift: string;
  const onboardBody = { environment: "simulation", otp: "123456", invoiceTypes: "1100", organizationUnit: "الفرع الرئيسي", location: "RRRD2929", industry: "Restaurants" };
  const submissions = async () => (await ownerPool.query<{ outcome: string; mode: string }>(
    "SELECT s.outcome, s.mode FROM zatca_submissions s WHERE s.tenant_id = $1 ORDER BY s.created_at", [tenant])).rows;
  const waitFor = async (n: number) => { for (let i = 0; i < 60; i++) { if ((await submissions()).length >= n) return; await new Promise((r) => setTimeout(r, 50)); } };
  const sell = () => call(app, owner, "POST", "/t/pos/orders", { tenant, idem: true, body: { locationId: k.locationId, shiftId: shift, channel: "takeaway", items: [{ recipeId: salad, quantity: 1 }], payments: [{ method: "cash", amount: 23 }] } });

  before(async () => {
    setZatcaTransport(transport);
    app = await startApp();
    owner = await createUser({ name: "المالك" });
    tenant = await createTenant(app, owner, "مطعم الفوترة");
    // ZATCA's test VAT number (15 digits, 3…3); set directly because verified tax ids are unique across workspaces.
    await ownerPool.query("UPDATE tenants SET tax_id = '399999999900003' WHERE id = $1", [tenant]);
    await raiseLimits(tenant);
    k = await setupKitchen(app, owner, tenant);
    await receivePo(app, owner, tenant, { supplierId: k.supplierId, locationId: k.locationId, items: [{ ingredientId: k.ingredientId, quantity: 10, unitPrice: 5 }] });
    salad = await createApprovedRecipe(app, owner, tenant, 20, [{ ingredientId: k.ingredientId, quantity: 100 }]);
    shift = await openShift(app, owner, tenant, k.locationId);
    accountant = await addMember(app, owner, tenant, "accountant");
  });
  after(async () => { setZatcaTransport(null); await new Promise((r) => setTimeout(r, 200)); await stopApp(app); });

  it("says what is missing before onboarding, and only the owner's settings role may onboard", async () => {
    const s = (await call(app, owner, "GET", "/t/zatca/status", { tenant })).body;
    assert.equal(s.readiness.ready, false);
    assert.equal(s.device, null);
    expectStatus(await call(app, owner, "POST", "/t/zatca/onboard", { tenant, body: onboardBody }), 409, "no tax profile");
    expectStatus(await call(app, owner, "PUT", "/t/accounting/tax-profile", { tenant, body: { legalName: "شركة مطعم الفوترة", crNumber: "1010010000", street: "طريق الملك فهد", buildingNo: "1234", district: "العليا", city: "الرياض", postalCode: "12345" } }), 200, "profile");
    expectStatus(await call(app, accountant, "POST", "/t/zatca/onboard", { tenant, body: onboardBody }), 403, "accountant");
    expectStatus(await call(app, owner, "POST", "/t/zatca/onboard", { tenant, body: { ...onboardBody, location: "RRRD_29" } }), 422, "forbidden character");
  });

  it("a wrong OTP fails cleanly; the right one runs compliance checks and activates the device", async () => {
    const bad = await call(app, owner, "POST", "/t/zatca/onboard", { tenant, body: { ...onboardBody, otp: "000000" } });
    expectStatus(bad, 422, "wrong otp");
    assert.match(bad.body.error.message, /رفضت الهيئة/);
    const r = await call(app, owner, "POST", "/t/zatca/onboard", { tenant, body: onboardBody });
    expectStatus(r, 200, "onboard");
    assert.equal(r.body.results.length, 6, "standard + simplified: invoice, credit and debit note each");
    assert.ok(r.body.results.every((x: { ok: boolean }) => x.ok), JSON.stringify(r.body.results));
    const s = (await call(app, owner, "GET", "/t/zatca/status", { tenant })).body;
    assert.equal(s.device.status, "active");
    assert.equal(s.device.environment, "simulation");
    assert.equal(JSON.stringify(s).includes("PRIVATE KEY"), false);
    const stored = (await ownerPool.query<{ k: string; s: string }>("SELECT private_key_enc AS k, production_secret_enc AS s FROM zatca_devices WHERE tenant_id = $1 AND status = 'active'", [tenant])).rows[0]!;
    assert.ok(!stored.k.includes("PRIVATE KEY") && !stored.s.includes("production-secret"), "secrets are encrypted at rest");
  });

  it("a sale is stamped in its own transaction (9-tag QR on the receipt) and reported without making the till wait", async () => {
    const r = await sell();
    expectStatus(r, 201, "sale");
    assert.deepEqual(tlvTags(r.body.qr), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await waitFor(1);
    assert.deepEqual(await submissions(), [{ outcome: "accepted", mode: "reporting" }]);
  });

  it("refunds become credit notes; documents form one unbroken chain (ICV + previous hash)", async () => {
    const r = await sell();
    expectStatus(await call(app, owner, "POST", `/t/pos/orders/${r.body.id}/refund`, { tenant, idem: true, body: { shiftId: shift, amount: 10, method: "cash", reason: "طلب خاطئ" } }), 201, "refund");
    await waitFor(3);
    const docs = (await ownerPool.query<{ icv: string; pih: string; invoice_hash: string; kind: string; doc_number: string }>(
      "SELECT icv::text, pih, invoice_hash, kind, doc_number FROM zatca_documents WHERE tenant_id = $1 ORDER BY icv", [tenant])).rows;
    assert.deepEqual(docs.map((d) => Number(d.icv)), [1, 2, 3]);
    assert.equal(docs[0]!.pih, INITIAL_PIH);
    for (let i = 1; i < docs.length; i++) assert.equal(docs[i]!.pih, docs[i - 1]!.invoice_hash, `document ${i + 1} chains to ${i}`);
    assert.equal(docs[2]!.kind, "credit_note");
    assert.match(docs[2]!.doc_number, /^PCN-\d{6}$/);
    assert.ok((await submissions()).every((s) => s.outcome === "accepted"));
  });

  it("a standard (B2B) invoice is cleared before it is returned, and prints ZATCA's QR", async () => {
    const c = await call(app, owner, "POST", "/t/customers", { tenant, body: { name: "شركة العميل", phone: "0559876543", customerType: "business", vatNumber: "399999999800003", street: "التحلية", buildingNo: "1111", district: "السليمانية", city: "الرياض", postalCode: "12222" } });
    expectStatus(c, 201, "customer");
    const inv = await call(app, owner, "POST", "/t/sales-documents", { tenant, idem: true, body: { invoiceType: "standard", customerId: c.body.id, paymentMeans: "credit",
      lines: [{ description: "تموين", quantity: 2, unitPrice: 500, discount: 50 }, { description: "تصدير", quantity: 1, unitPrice: 100, vatCategory: "Z", exemptionCode: "VATEX-SA-32" }] } });
    expectStatus(inv, 201, "invoice");
    assert.equal(inv.body.zatca.outcome, "accepted");
    assert.equal(inv.body.zatca.mode, "clearance");
    const d = (await call(app, owner, "GET", `/t/sales-documents/${inv.body.id}`, { tenant })).body;
    assert.equal(d.zatca.outcome, "accepted");
    assert.equal(d.zatca.clearedQr, "Q0xFQVJFRC1CWS1aQVRDQQ==", "the QR from ZATCA's cleared copy");
    const xml = await app.inject({ method: "GET", url: `/api/v1/t/zatca/documents/${d.zatca.documentId}/xml`, headers: { cookie: `mn_sid=${owner.token}`, "x-tenant-id": tenant } });
    assert.equal(xml.statusCode, 200);
    assert.match(String(xml.headers["content-disposition"]), /399999999900003_\d{8}T\d{6}_INV-\d{6}\.xml/);
    assert.match(xml.body, /Q0xFQVJFRC1CWS1aQVRDQQ==/);
  });

  it("a rejected document stays in the chain; network failures stay pending and are resent", async () => {
    const before = (await ownerPool.query<{ n: string }>("SELECT max(icv)::text AS n FROM zatca_documents WHERE tenant_id = $1", [tenant])).rows[0]!.n;
    zatca.networkDown = true;
    await sell();
    await new Promise((r) => setTimeout(r, 300));
    const pending = (await call(app, owner, "GET", "/t/zatca/status", { tenant })).body.counts.pending;
    assert.equal(pending, 1);
    zatca.networkDown = false;
    const resend = await call(app, accountant, "POST", "/t/zatca/submit-pending", { tenant });
    expectStatus(resend, 200, "resend");
    assert.equal(resend.body.accepted, 1);
    // A document ZATCA refuses is kept (never deleted, counter never reused); the next one continues the chain.
    const c = await call(app, owner, "POST", "/t/customers", { tenant, body: { name: "REJECT-ME", phone: "0551112222" } });
    const rej = await call(app, owner, "POST", "/t/sales-documents", { tenant, idem: true, body: { invoiceType: "simplified", customerId: c.body.id, paymentMeans: "cash", lines: [{ description: "x", quantity: 1, unitPrice: 10 }] } });
    expectStatus(rej, 201, "simplified with a buyer ZATCA rejects");
    await waitFor(6);
    const s = (await call(app, owner, "GET", "/t/zatca/status", { tenant })).body.counts;
    assert.equal(s.rejected, 1);
    const list = (await call(app, owner, "GET", "/t/zatca/documents?status=rejected", { tenant })).body.items;
    assert.match(list[0].errors[0], /rejected on purpose/);
    await sell();
    const icvs = (await ownerPool.query<{ icv: string }>("SELECT icv::text FROM zatca_documents WHERE tenant_id = $1 ORDER BY icv", [tenant])).rows.map((r) => Number(r.icv));
    assert.deepEqual(icvs.slice(Number(before)), [Number(before) + 1, Number(before) + 2, Number(before) + 3]);
  });

  it("the chain cannot be rewound or skipped, even by a direct database update", async () => {
    await assert.rejects(ownerPool.query("UPDATE zatca_devices SET last_icv = last_icv - 1 WHERE tenant_id = $1 AND status = 'active'", [tenant]), /zatca_chain_violation/);
    await assert.rejects(ownerPool.query("UPDATE zatca_devices SET last_icv = last_icv + 5 WHERE tenant_id = $1 AND status = 'active'", [tenant]), /zatca_chain_violation/);
    await assert.rejects(ownerPool.query("UPDATE zatca_documents SET xml = 'x' WHERE tenant_id = $1", [tenant]), /immutable|not allowed|append/i);
  });
});
