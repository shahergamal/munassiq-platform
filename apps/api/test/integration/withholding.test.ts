import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { call, code, createTenant, createUser, expectStatus, isoToday, ownerPool, receivePo, setupKitchen, startApp, stopApp, type Actor, type App } from "./helpers.ts";

// Withholding tax (M3): a payment to a non-resident supplier settles the whole amount owed, pays the net, and keeps
// the tax as a liability to ZATCA; the monthly report lists it by payment type.
describe("withholding tax", () => {
  let app: App;
  let owner: Actor;
  let t: string;
  let foreign: string;
  let local: string;

  const ledger = async (key: string) => Number((await ownerPool.query<{ b: string }>(
    `SELECT coalesce(sum(l.debit - l.credit), 0)::text AS b FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.tenant_id = $1 AND a.system_key = $2`, [t, key])).rows[0]!.b);
  const pay = (supplierId: string, amount: number, withholdingCode?: string) =>
    call(app, owner, "POST", "/t/supplier-payments", { tenant: t, idem: true, body: { supplierId, amount, method: "bank_transfer", paidOn: isoToday(), ...(withholdingCode ? { withholdingCode } : {}) } });

  before(async () => {
    app = await startApp();
    owner = await createUser();
    t = await createTenant(app, owner);
    const k = await setupKitchen(app, owner, t);
    local = k.supplierId;
    const f = await call(app, owner, "POST", "/t/suppliers", { tenant: t, body: { code: code("F"), name: "استشاري من الخارج", residency: "non_resident" } });
    expectStatus(f, 201, "foreign supplier");
    foreign = f.body.id;
    await receivePo(app, owner, t, { supplierId: foreign, locationId: k.locationId, items: [{ ingredientId: k.ingredientId, quantity: 100, unitPrice: 20 }] });
  });
  after(() => stopApp(app));

  it("a non-resident payment withholds by payment type; the balance is settled in full", async () => {
    const missing = await pay(foreign, 1000);
    assert.equal(missing.status, 422);
    assert.equal(missing.body.error.code, "withholding_required");
    const r = await pay(foreign, 1000, "technical_services");
    expectStatus(r, 201, "pay");
    const p = (await ownerPool.query<{ rate: string; amt: string }>("SELECT withholding_rate::text AS rate, withholding_amount::text AS amt FROM supplier_payments WHERE id = $1", [r.body.id])).rows[0]!;
    assert.deepEqual([Number(p.rate), Number(p.amt)], [5, 50]);
    assert.equal(await ledger("withholding_payable"), -50);
    assert.equal(await ledger("bank"), -950, "the bank pays the net");
    const royalty = await pay(foreign, 200, "royalties");
    expectStatus(royalty, 201, "royalty");
    assert.equal(await ledger("withholding_payable"), -80);
    // Goods bought from abroad are not subject to it.
    expectStatus(await pay(foreign, 100, "none"), 201, "none");
    assert.equal(await ledger("withholding_payable"), -80);
    const payables = await call(app, owner, "GET", "/t/payables", { tenant: t });
    const bal = payables.body.items.find((x: { supplierId: string }) => x.supplierId === foreign);
    assert.equal(bal.payments, 1300, "the supplier's balance goes down by the gross amounts");
    assert.equal(bal.balance, bal.purchases - 1300);
  });

  it("a resident supplier is paid in full, whatever is sent", async () => {
    expectStatus(await pay(local, 10, "royalties"), 201, "resident");
    const last = (await ownerPool.query<{ amt: string }>("SELECT withholding_amount::text AS amt FROM supplier_payments WHERE tenant_id = $1 AND supplier_id = $2", [t, local])).rows[0]!;
    assert.equal(Number(last.amt), 0);
  });

  it("the monthly return lists the tax by type and its due date", async () => {
    const r = await call(app, owner, "GET", `/t/reports/withholding?month=${isoToday().slice(0, 7)}`, { tenant: t });
    expectStatus(r, 200, "report");
    assert.equal(r.body.total, 80);
    assert.deepEqual(r.body.rows.map((x: { code: string; tax: number }) => [x.code, x.tax]), [["technical_services", 50], ["royalties", 30]]);
    assert.equal(r.body.dueDate.slice(8), "10");
    assert.equal(r.body.payableBalance, 80);
  });
});
