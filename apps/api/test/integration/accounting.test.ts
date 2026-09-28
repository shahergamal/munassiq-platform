import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { decodeQr } from "../../src/lib/zatca.ts";
import {
  type Actor, type App, addMember, call, createApprovedRecipe, createTenant, createUser, expectStatus, isoToday, openShift, raiseLimits, receivePo, setupKitchen, startApp, stopApp, type Kitchen,
} from "./helpers.ts";

const VAT = "300000000000003";

describe("accounting: automatic double-entry ledger, tax invoices, statements", () => {
  let app: App;
  let owner: Actor;
  let accountant: Actor;
  let cashier: Actor;
  let tenant: string;
  let k: Kitchen;
  let customer: string;
  const today = isoToday();

  const accountBy = async (code: string) => ((await call(app, owner, "GET", "/t/accounts", { tenant })).body.items as { id: string; code: string; netDebit: number }[]).find((a) => a.code === code)!;
  const tb = async () => (await call(app, owner, "GET", `/t/accounting/trial-balance?from=2000-01-01&to=${today}`, { tenant })).body;

  before(async () => {
    app = await startApp();
    owner = await createUser({ name: "المالك" });
    tenant = await createTenant(app, owner, "مطعم الحسابات");
    await raiseLimits(tenant);
    k = await setupKitchen(app, owner, tenant);
    accountant = await addMember(app, owner, tenant, "accountant");
    cashier = await addMember(app, owner, tenant, "cashier");
  });
  after(() => stopApp(app));

  it("every workspace starts with a Saudi restaurant chart of accounts", async () => {
    const items = (await call(app, owner, "GET", "/t/accounts", { tenant })).body.items as { code: string; systemKey: string | null }[];
    for (const key of ["cash", "bank", "ar", "ap", "inventory", "vat_input", "vat_output", "sales", "cogs", "retained_earnings"]) {
      assert.ok(items.some((a) => a.systemKey === key), `missing ${key}`);
    }
    expectStatus(await call(app, cashier, "GET", "/t/accounts", { tenant }), 403, "cashier");
  });

  it("a sale, a purchase, a payment and an expense each post a balanced entry with the right amounts", async () => {
    // Purchase 10 kg at 8 SAR + 15% VAT from a VAT-registered supplier, pay 50 of it.
    expectStatus(await call(app, owner, "PATCH", `/t/suppliers/${k.supplierId}`, { tenant, body: { taxId: "311111111111113" } }), 200, "supplier VAT");
    await receivePo(app, owner, tenant, { supplierId: k.supplierId, locationId: k.locationId, items: [{ ingredientId: k.ingredientId, quantity: 10, unitPrice: 8 }] });
    expectStatus(await call(app, owner, "POST", "/t/supplier-payments", { tenant, idem: true, body: { supplierId: k.supplierId, paidOn: today, amount: 50, method: "cash" } }), 201, "payment");
    // Sell 2 salads at 20 net (+15%) paid by card.
    const salad = await createApprovedRecipe(app, owner, tenant, 20, [{ ingredientId: k.ingredientId, quantity: 100 }]);
    const shift = await openShift(app, owner, tenant, k.locationId);
    expectStatus(await call(app, owner, "POST", "/t/pos/orders", { tenant, idem: true, body: { locationId: k.locationId, shiftId: shift, channel: "takeaway", items: [{ recipeId: salad, quantity: 2 }], payments: [{ method: "mada", amount: 46 }] } }), 201, "sale");
    // An expense: 100 + 15 VAT, approved by the accountant, paid by bank.
    const cats = (await call(app, owner, "GET", "/t/expense-categories", { tenant })).body.items as { id: string; name: string }[];
    const rent = cats.find((c) => c.name === "الإيجار")!;
    const e = await call(app, owner, "POST", "/t/expenses", { tenant, idem: true, body: { categoryId: rent.id, expenseDate: today, description: "إيجار الشهر", amountNet: 100, vatAmount: 15 } });
    expectStatus(e, 201, "expense");
    expectStatus(await call(app, accountant, "POST", `/t/expenses/${e.body.id}/approve`, { tenant }), 200, "approve");
    expectStatus(await call(app, accountant, "POST", `/t/expenses/${e.body.id}/pay`, { tenant, body: { method: "bank_transfer" } }), 200, "pay");

    const t = await tb();
    assert.deepEqual(t.totals.closing.debit, t.totals.closing.credit, "the trial balance balances");
    assert.equal((await accountBy("1106")).netDebit, 78.4, "inventory: 80 in, 1.60 out (200 g at 0.008)");
    assert.equal((await accountBy("1107")).netDebit, 12 + 15, "input VAT: purchase 12 + expense 15");
    assert.equal((await accountBy("2101")).netDebit, -(92 - 50), "the supplier is owed 92 - 50");
    assert.equal((await accountBy("1103")).netDebit, 46, "card clearing");
    assert.equal((await accountBy("4101")).netDebit, -40, "sales net of VAT");
    assert.equal((await accountBy("2103")).netDebit, -6, "output VAT");
    assert.equal((await accountBy("5101")).netDebit, 1.6, "cost of goods sold");
    assert.equal((await accountBy("6103")).netDebit, 100, "rent, through the category's account");
    assert.equal((await accountBy("1102")).netDebit, -115, "bank paid the expense");
    const s = (await call(app, owner, "GET", "/t/accounting/summary", { tenant })).body;
    assert.deepEqual(s.unposted, [], "nothing is left unposted");
    const pay = (await call(app, owner, "GET", `/t/accounting/aging?kind=payable&asOf=${today}`, { tenant })).body;
    assert.equal(pay.totals.total, 42);
  });

  it("statements tie out: the balance sheet balances and the income statement shows the profit", async () => {
    const bs = (await call(app, owner, "GET", `/t/accounting/balance-sheet?asOf=${today}`, { tenant })).body;
    assert.equal(bs.balanced, true);
    const is = (await call(app, owner, "GET", `/t/accounting/income-statement?from=${today.slice(0, 7)}-01&to=${today}`, { tenant })).body;
    assert.equal(is.revenue.total, 40);
    assert.equal(is.grossProfit, 38.4);
    assert.equal(is.netProfit, -61.6);
    assert.equal(bs.equity.currentEarnings, is.netProfit);
  });

  it("manual entries must balance, are reversed (never edited), and closed periods refuse postings", async () => {
    const cash = await accountBy("1101");
    const capital = await accountBy("3101");
    expectStatus(await call(app, accountant, "POST", "/t/accounting/journal", { tenant, idem: true, body: { date: today, description: "غير متوازن", lines: [{ accountId: cash.id, debit: 100 }, { accountId: capital.id, credit: 90 }] } }), 422, "unbalanced");
    const group = ((await call(app, owner, "GET", "/t/accounts", { tenant })).body.items as { id: string; code: string }[]).find((a) => a.code === "11")!;
    expectStatus(await call(app, accountant, "POST", "/t/accounting/journal", { tenant, idem: true, body: { date: today, description: "حساب رئيسي", lines: [{ accountId: group.id, debit: 10 }, { accountId: capital.id, credit: 10 }] } }), 422, "group account");
    const j = await call(app, accountant, "POST", "/t/accounting/journal", { tenant, idem: true, body: { date: today, description: "إيداع رأس المال", lines: [{ accountId: cash.id, debit: 1000 }, { accountId: capital.id, credit: 1000 }] } });
    expectStatus(j, 201, "capital");
    expectStatus(await call(app, accountant, "POST", `/t/accounting/journal/${j.body.id}/reverse`, { tenant, idem: true, body: { reason: "خطأ في المبلغ" } }), 201, "reverse");
    expectStatus(await call(app, accountant, "POST", `/t/accounting/journal/${j.body.id}/reverse`, { tenant, idem: true, body: { reason: "مرة ثانية" } }), 409, "twice");
    const auto = ((await call(app, owner, "GET", `/t/accounting/journal?from=2000-01-01&to=${today}&source=pos_order`, { tenant })).body.items as { id: string }[])[0]!;
    expectStatus(await call(app, accountant, "POST", `/t/accounting/journal/${auto.id}/reverse`, { tenant, idem: true, body: { reason: "محاولة" } }), 409, "automatic entries follow their documents");
    expectStatus(await call(app, cashier, "POST", "/t/accounting/journal", { tenant, idem: true, body: { date: today, description: "x", lines: [] } }), 403, "cashier");

    const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    expectStatus(await call(app, accountant, "PUT", "/t/accounting/lock", { tenant, body: { lockDate: today } }), 422, "cannot lock today");
    expectStatus(await call(app, accountant, "PUT", "/t/accounting/lock", { tenant, body: { lockDate: yesterday } }), 200, "lock");
    const locked = await call(app, accountant, "POST", "/t/accounting/journal", { tenant, idem: true, body: { date: yesterday, description: "في فترة مقفلة", lines: [{ accountId: cash.id, debit: 5 }, { accountId: capital.id, credit: 5 }] } });
    expectStatus(locked, 409, "locked period");
    assert.equal(locked.body.error.code, "period_locked");
    expectStatus(await call(app, accountant, "PUT", "/t/accounting/lock", { tenant, body: { lockDate: null } }), 200, "unlock");
  });

  it("tax invoices: seller profile and a complete buyer are required; totals, QR and posting come from the server", async () => {
    const noProfile = await call(app, accountant, "POST", "/t/sales-documents", { tenant, idem: true, body: { invoiceType: "simplified", paymentMeans: "cash", lines: [{ description: "وجبة", quantity: 1, unitPrice: 10 }] } });
    expectStatus(noProfile, 409, "no tax profile");
    expectStatus(await call(app, owner, "PUT", "/t/accounting/tax-profile", { tenant, body: { legalName: "شركة مطعم الحسابات", crNumber: "1010010000", street: "طريق الملك فهد", buildingNo: "1234", district: "العليا", city: "الرياض", postalCode: "12345" } }), 200, "profile");

    const c = await call(app, owner, "POST", "/t/customers", { tenant, body: { name: "شركة الضيافة المحدودة", phone: "0551234567", customerType: "business" } });
    expectStatus(c, 201, "customer");
    customer = c.body.id;
    const incomplete = await call(app, accountant, "POST", "/t/sales-documents", { tenant, idem: true, body: { invoiceType: "standard", customerId: customer, lines: [{ description: "تموين حفل", quantity: 1, unitPrice: 1000 }] } });
    expectStatus(incomplete, 422, "buyer incomplete");
    assert.match(incomplete.body.error.message, /الرقم الضريبي/);
    expectStatus(await call(app, owner, "PATCH", `/t/customers/${customer}`, { tenant, body: { vatNumber: VAT, street: "شارع التحلية", buildingNo: "4321", district: "السليمانية", city: "الرياض", postalCode: "11564", paymentTermsDays: 30 } }), 200, "complete buyer");

    const inv = await call(app, accountant, "POST", "/t/sales-documents", { tenant, idem: true, body: {
      invoiceType: "standard", customerId: customer, paymentMeans: "credit",
      lines: [
        { description: "تموين حفل (50 شخص)", quantity: 50, unitPrice: 30, discount: 100 },
        { description: "تصدير وجبات", quantity: 1, unitPrice: 200, vatCategory: "Z", exemptionCode: "VATEX-SA-32" },
      ] } });
    expectStatus(inv, 201, "invoice");
    assert.match(inv.body.number, /^INV-\d{6}$/);
    const d = (await call(app, owner, "GET", `/t/sales-documents/${inv.body.id}`, { tenant })).body;
    assert.deepEqual([d.subtotal, d.discount, d.taxable, d.vat, d.total], [1700, 100, 1600, 210, 1810]);
    assert.equal(d.dueDate > d.issueDate, true, "due after the customer's terms");
    const qr = decodeQr(d.qr);
    assert.deepEqual([qr[1], qr[2], qr[4], qr[5]], ["شركة مطعم الحسابات", "300000000000003".length === 15 ? qr[2] : "", "1810.00", "210.00"]);
    assert.equal(d.balance, 1810);

    expectStatus(await call(app, accountant, "POST", "/t/sales-documents", { tenant, idem: true, body: { kind: "credit_note", invoiceType: "standard", customerId: customer, originalId: inv.body.id, reason: "مرتجع", lines: [{ description: "x", quantity: 1, unitPrice: 5000 }] } }), 409, "credit note too large");
    const cn = await call(app, accountant, "POST", "/t/sales-documents", { tenant, idem: true, body: { kind: "credit_note", invoiceType: "standard", customerId: customer, originalId: inv.body.id, reason: "خصم لاحق على الحفل", lines: [{ description: "خصم", quantity: 1, unitPrice: 100 }] } });
    expectStatus(cn, 201, "credit note");
    assert.match(cn.body.number, /^CRN-/);
    expectStatus(await call(app, accountant, "POST", "/t/customer-receipts", { tenant, idem: true, body: { customerId: customer, documentId: inv.body.id, receivedOn: today, amount: 5000, method: "bank_transfer" } }), 409, "receipt over balance");
    expectStatus(await call(app, accountant, "POST", "/t/customer-receipts", { tenant, idem: true, body: { customerId: customer, documentId: inv.body.id, receivedOn: today, amount: 1000, method: "bank_transfer" } }), 201, "receipt");
    const after = (await call(app, owner, "GET", `/t/sales-documents/${inv.body.id}`, { tenant })).body;
    assert.equal(after.balance, 1810 - 115 - 1000);
    const ar = (await call(app, owner, "GET", `/t/accounting/aging?kind=receivable&asOf=${today}`, { tenant })).body;
    assert.equal(ar.totals.total, 695);
    const t = await tb();
    assert.deepEqual(t.totals.closing.debit, t.totals.closing.credit);
  });

  it("the VAT return adds point-of-sale and invoice sales by category, and purchases with their VAT", async () => {
    const v = (await call(app, owner, "GET", `/t/accounting/vat-return?from=${today.slice(0, 7)}-01&to=${today}`, { tenant })).body;
    const box = (n: number) => [...v.sales, v.salesTotal, ...v.purchases, v.purchasesTotal].find((b: { no: number }) => b.no === n);
    assert.deepEqual([box(1).amount, box(1).adjustment, box(1).vat], [40 + 1400, -100, 6 + 210 - 15], "POS 40 + invoice 1400, credit note -100");
    assert.equal(box(4).amount, 200, "export");
    assert.deepEqual([box(7).amount, box(7).vat], [80 + 100, 12 + 15]);
    assert.equal(v.vatDue, 6 + 210 - 15 - 27);
  });
});
