import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { setGatewayTransport, type Transport } from "../../src/lib/payments/gateways.ts";
import { type Actor, type App, addMember, call, createTenant, createUser, expectStatus, isoToday, ownerPool, raiseLimits, startApp, stopApp } from "./helpers.ts";

const VAT = "300000000000003";
const MOYASAR_KEY = "sk_test_moyasarKey1234567890";
const TAP_KEY = "sk_test_tapKey0987654321";

/** Stand-ins for Moyasar and Tap: they know one secret key each and keep the pages they opened. */
const gw = {
  pages: new Map<string, { provider: string; amount: number; status: string; body: any }>(),
  seq: 0,
  down: false,
};
const transport: Transport = async (provider, method, path, key, body: any) => {
  if (gw.down) throw new Error("ECONNRESET");
  if (key !== (provider === "moyasar" ? MOYASAR_KEY : TAP_KEY)) return { status: 401, body: { message: "Invalid authorization credentials" } };
  if (provider === "moyasar") {
    if (method === "GET" && path.startsWith("/invoices?")) return { status: 200, body: { invoices: [] } };
    if (method === "POST" && path === "/invoices") {
      const id = `inv_${++gw.seq}${crypto.randomUUID().replace(/-/g, "")}`;
      gw.pages.set(id, { provider, amount: body.amount, status: "initiated", body });
      return { status: 201, body: { id, status: "initiated", amount: body.amount, currency: body.currency, url: `https://checkout.moyasar.com/invoices/${id}` } };
    }
    const p = gw.pages.get(path.replace("/invoices/", ""));
    if (!p) return { status: 404, body: { message: "Object not found" } };
    return { status: 200, body: { id: path.slice(10), status: p.status, amount: p.amount, currency: "SAR", payments: p.status === "paid" ? [{ id: "pay_abc123", status: "paid" }] : [] } };
  }
  if (method === "POST" && path === "/charges/list") return { status: 200, body: { charges: [] } };
  if (method === "POST" && path === "/charges") {
    if (!body.customer?.first_name || !body.customer?.phone?.number) return { status: 400, body: { errors: [{ code: "1108", description: "Customer info is required" }] } };
    const id = `chg_TS${++gw.seq}${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    gw.pages.set(id, { provider, amount: Math.round(body.amount * 100), status: "INITIATED", body });
    return { status: 200, body: { id, status: "INITIATED", amount: body.amount, currency: "SAR", transaction: { url: `https://checkout.payments.tap.company/?mode=page&token=${id}` } } };
  }
  const p = gw.pages.get(path.replace("/charges/", ""));
  if (!p) return { status: 404, body: { errors: [{ description: "Charge not found" }] } };
  return { status: 200, body: { id: path.slice(9), status: p.status, amount: p.amount / 100, currency: "SAR", reference: { payment: "5226123456" } } };
};

describe("payment gateways: the workspace connects Moyasar / Tap itself; paid links become receipts", () => {
  let app: App;
  let owner: Actor;
  let accountant: Actor;
  let tenant: string;
  let invoice: string;
  let customer: string;
  const balance = async () => (await call(app, owner, "GET", `/t/sales-documents/${invoice}`, { tenant })).body.balance as number;

  before(async () => {
    setGatewayTransport(transport);
    app = await startApp();
    owner = await createUser({ name: "المالك" });
    tenant = await createTenant(app, owner, "مطعم الدفع الإلكتروني");
    await raiseLimits(tenant);
    accountant = await addMember(app, owner, tenant, "accountant");
    expectStatus(await call(app, owner, "PUT", "/t/accounting/tax-profile", { tenant, body: { legalName: "شركة مطعم الدفع", crNumber: "1010010001", street: "طريق الملك فهد", buildingNo: "1234", district: "العليا", city: "الرياض", postalCode: "12345" } }), 200, "profile");
    const c = await call(app, owner, "POST", "/t/customers", { tenant, body: { name: "شركة الضيافة", phone: "0551234500", customerType: "business" } });
    customer = c.body.id;
    expectStatus(await call(app, owner, "PATCH", `/t/customers/${customer}`, { tenant, body: { vatNumber: VAT, street: "شارع التحلية", buildingNo: "4321", district: "السليمانية", city: "الرياض", postalCode: "11564" } }), 200, "buyer");
    const inv = await call(app, accountant, "POST", "/t/sales-documents", { tenant, idem: true, body: {
      invoiceType: "standard", customerId: customer, paymentMeans: "credit", lines: [{ description: "تموين", quantity: 1, unitPrice: 1000 }] } });
    expectStatus(inv, 201, "invoice");
    invoice = inv.body.id;
  });
  after(async () => { setGatewayTransport(null); await stopApp(app); });

  it("connecting: only the owner, only secret keys, and the key is checked with the gateway and never returned", async () => {
    expectStatus(await call(app, accountant, "PUT", "/t/payments/connections/moyasar", { tenant, body: { secretKey: MOYASAR_KEY } }), 403, "accountant cannot connect");
    const pk = await call(app, owner, "PUT", "/t/payments/connections/moyasar", { tenant, body: { secretKey: "pk_test_abcdefghijklmnop" } });
    expectStatus(pk, 422, "publishable key refused");
    const wrong = await call(app, owner, "PUT", "/t/payments/connections/moyasar", { tenant, body: { secretKey: "sk_test_wrongwrongwrong" } });
    expectStatus(wrong, 422, "wrong key refused");
    assert.match(wrong.body.error.message, /رفضت بوابة الدفع المفتاح/);

    const noLink = await call(app, accountant, "POST", `/t/sales-documents/${invoice}/payment-links`, { tenant, idem: true, body: { provider: "moyasar" } });
    expectStatus(noLink, 409, "not connected yet");
    assert.equal(noLink.body.error.code, "gateway_not_connected");

    expectStatus(await call(app, owner, "PUT", "/t/payments/connections/moyasar", { tenant, body: { secretKey: MOYASAR_KEY } }), 200, "moyasar");
    expectStatus(await call(app, owner, "PUT", "/t/payments/connections/tap", { tenant, body: { secretKey: TAP_KEY } }), 200, "tap");
    const list = await call(app, accountant, "GET", "/t/payments/connections", { tenant });
    expectStatus(list, 200, "list");
    assert.deepEqual(list.body.items.map((i: any) => [i.provider, i.connected, i.mode, i.keyHint]), [["moyasar", true, "test", "7890"], ["tap", true, "test", "4321"]]);
    assert.doesNotMatch(JSON.stringify(list.body), /sk_test|webhookToken/, "no secret or token in the response");
    const stored = (await ownerPool.query("SELECT secret_enc FROM payment_connections WHERE tenant_id = $1", [tenant])).rows;
    assert.ok(stored.every((r) => r.secret_enc.startsWith("v1.") && !r.secret_enc.includes("sk_test")), "encrypted at rest");
  });

  it("Moyasar: a link for the balance, reused while open; paid only when the gateway says so", async () => {
    const idem = crypto.randomUUID();
    const l = await call(app, accountant, "POST", `/t/sales-documents/${invoice}/payment-links`, { tenant, idem, body: { provider: "moyasar" } });
    expectStatus(l, 201, "link");
    assert.equal(l.body.amount, 1150);
    assert.match(l.body.url, /^https:\/\/checkout\.moyasar\.com\//);
    const page = [...gw.pages.values()].at(-1)!;
    assert.equal(page.amount, 115000, "Moyasar gets halalas");
    expectStatus(await call(app, accountant, "POST", `/t/sales-documents/${invoice}/payment-links`, { tenant, idem, body: { provider: "moyasar" } }), 200, "same key replays");
    const again = await call(app, accountant, "POST", `/t/sales-documents/${invoice}/payment-links`, { tenant, idem: true, body: { provider: "moyasar" } });
    assert.equal(again.body.id, l.body.id, "an open link is reused");

    const unpaid = await call(app, accountant, "POST", `/t/payments/links/${l.body.id}/check`, { tenant });
    expectStatus(unpaid, 200, "check");
    assert.equal(unpaid.body.status, "pending");
    assert.equal(await balance(), 1150);

    // The customer pays; the webhook only names the invoice, the server reads the rest from Moyasar.
    const ref = [...gw.pages.keys()].at(-1)!;
    gw.pages.get(ref)!.status = "paid";
    const token = (await ownerPool.query("SELECT webhook_token FROM payment_connections WHERE tenant_id = $1 AND provider = 'moyasar'", [tenant])).rows[0].webhook_token;
    const bad = await app.inject({ method: "POST", url: `/api/v1/webhooks/payments/${tenant}/moyasar/${"x".repeat(32)}`, payload: { id: ref, status: "paid" } });
    assert.equal(bad.statusCode, 404, "wrong token");
    assert.equal(await balance(), 1150);
    const hook = await app.inject({ method: "POST", url: `/api/v1/webhooks/payments/${tenant}/moyasar/${token}`, payload: { id: ref, status: "paid" } });
    assert.equal(hook.statusCode, 200, hook.body);
    const hook2 = await app.inject({ method: "POST", url: `/api/v1/webhooks/payments/${tenant}/moyasar/${token}`, payload: { id: ref, status: "paid" } });
    assert.equal(hook2.statusCode, 200, "delivered twice");
    assert.equal(await balance(), 0, "paid once");

    const receipts = (await call(app, owner, "GET", `/t/customer-receipts?customerId=${customer}`, { tenant })).body.items;
    assert.equal(receipts.length, 1, "one receipt despite two deliveries");
    assert.deepEqual([receipts[0].method, receipts[0].amount, receipts[0].reference], ["online", 1150, "Moyasar pay_abc123"]);
    const links = (await call(app, owner, "GET", `/t/payments/links?documentId=${invoice}`, { tenant })).body.items;
    assert.equal(links[0].status, "paid");
    const accounts = (await call(app, owner, "GET", "/t/accounts", { tenant })).body.items as { systemKey: string; netDebit: number }[];
    assert.equal(accounts.find((a) => a.systemKey === "gateway_clearing")!.netDebit, 1150, "Dr gateway clearing");

    const paidOff = await call(app, accountant, "POST", `/t/sales-documents/${invoice}/payment-links`, { tenant, idem: true, body: { provider: "tap" } });
    expectStatus(paidOff, 409, "nothing left to collect");
  });

  it("Tap: charge in riyals with the customer's phone; a mismatched amount is never booked", async () => {
    const inv = await call(app, accountant, "POST", "/t/sales-documents", { tenant, idem: true, body: {
      invoiceType: "standard", customerId: customer, paymentMeans: "credit", lines: [{ description: "تموين", quantity: 2, unitPrice: 100 }] } });
    invoice = inv.body.id;
    const l = await call(app, accountant, "POST", `/t/sales-documents/${invoice}/payment-links`, { tenant, idem: true, body: { provider: "tap" } });
    expectStatus(l, 201, "tap link");
    const [ref, page] = [...gw.pages.entries()].at(-1)!;
    assert.equal(page.body.amount, 230, "Tap gets riyals");
    assert.deepEqual(page.body.customer.phone, { country_code: "966", number: "551234500" });
    assert.equal(page.body.source.id, "src_all");

    page.status = "CAPTURED";
    page.amount = 100; // paid a different amount
    const mismatch = await call(app, accountant, "POST", `/t/payments/links/${l.body.id}/check`, { tenant });
    assert.equal(mismatch.body.status, "pending");
    assert.equal(await balance(), 230, "not booked");

    page.amount = 23000;
    gw.down = true;
    const down = await call(app, accountant, "POST", `/t/payments/links/${l.body.id}/check`, { tenant });
    expectStatus(down, 502, "gateway unreachable");
    gw.down = false;
    const ok = await call(app, accountant, "POST", `/t/payments/links/${l.body.id}/check`, { tenant });
    assert.equal(ok.body.status, "paid", JSON.stringify(ok.body));
    assert.equal(await balance(), 0);
    assert.ok(ref.startsWith("chg_"));
  });

  it("disconnecting removes the key; the ledger still balances", async () => {
    expectStatus(await call(app, accountant, "DELETE", "/t/payments/connections/tap", { tenant }), 403, "accountant cannot disconnect");
    expectStatus(await call(app, owner, "DELETE", "/t/payments/connections/tap", { tenant }), 204, "disconnect");
    const n = (await ownerPool.query("SELECT count(*)::int AS n FROM payment_connections WHERE tenant_id = $1 AND provider = 'tap'", [tenant])).rows[0].n;
    assert.equal(n, 0);
    const tb = (await call(app, owner, "GET", `/t/accounting/trial-balance?from=2000-01-01&to=${isoToday()}`, { tenant })).body;
    assert.deepEqual(tb.totals.closing.debit, tb.totals.closing.credit);
  });
});
