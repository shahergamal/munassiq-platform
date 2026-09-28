import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { type Actor, type App, call, code, createIngredient, createTenant, createUser, expectStatus, isoToday, receivePo, setupKitchen, startApp, stopApp, type Kitchen } from "./helpers.ts";

const daysAgo = (n: number) => new Date(Date.parse(isoToday()) - n * 86_400_000).toISOString().slice(0, 10);

// Suppliers A/B/C (أ/ب/ج), tomatoes at 10.00/kg and rice at 4.00/kg, no VAT (unregistered suppliers).
// Payables: A 120 − returns 44 − paid 50 = 26 · B 300 − 30 = 270 · C 200 − 20 − paid 100 = 80.
describe("sorting finance lists: purchase returns, payables, expenses", () => {
  let app: App;
  let owner: Actor;
  let tenant: string;
  let k: Kitchen;
  const sup: Record<"A" | "B" | "C", string> = { A: "", B: "", C: "" };
  const ret: string[] = []; // creation order: C 20, A 14 (rice + tomatoes), B 30, A 30
  const exp: string[] = [];

  before(async () => {
    app = await startApp();
    owner = await createUser();
    tenant = await createTenant(app, owner);
    k = await setupKitchen(app, owner, tenant);
    const rice = await createIngredient(app, owner, tenant, "أرز", "g", "kg");
    for (const [key, name, terms] of [["A", "مورد أ", 30], ["B", "مورد ب", 0], ["C", "مورد ج", 30]] as const) {
      const s = await call(app, owner, "POST", "/t/suppliers", { tenant, body: { code: code("S"), name, paymentTermsDays: terms } });
      expectStatus(s, 201, "supplier");
      sup[key] = s.body.id;
    }
    const tomato = (kg: number) => ({ ingredientId: k.ingredientId, quantity: kg, unitPrice: 10 });
    await receivePo(app, owner, tenant, { supplierId: sup.A, locationId: k.locationId, items: [tomato(10), { ingredientId: rice, quantity: 5, unitPrice: 4 }] });
    await receivePo(app, owner, tenant, { supplierId: sup.B, locationId: k.locationId, items: [tomato(30)] });
    await receivePo(app, owner, tenant, { supplierId: sup.C, locationId: k.locationId, items: [tomato(20)] });

    const returns: [string, { ingredientId: string; quantity: number }[]][] = [
      [sup.C, [{ ingredientId: k.ingredientId, quantity: 2000 }]],
      [sup.A, [{ ingredientId: rice, quantity: 1000 }, { ingredientId: k.ingredientId, quantity: 1000 }]],
      [sup.B, [{ ingredientId: k.ingredientId, quantity: 3000 }]],
      [sup.A, [{ ingredientId: k.ingredientId, quantity: 3000 }]],
    ];
    for (const [supplierId, items] of returns) {
      const r = await call(app, owner, "POST", "/t/purchase-returns", { tenant, idem: true, body: { supplierId, locationId: k.locationId, reason: "تالف عند الاستلام", items } });
      expectStatus(r, 201, "return");
      ret.push(r.body.id);
    }
    for (const [supplierId, amount] of [[sup.A, 50], [sup.C, 100]] as const) {
      expectStatus(await call(app, owner, "POST", "/t/supplier-payments", { tenant, idem: true, body: { supplierId, paidOn: isoToday(), amount, method: "cash" } }), 201, "payment");
    }

    const cat: Record<string, string> = {};
    for (const name of ["فئة أ", "فئة ب"]) {
      const c = await call(app, owner, "POST", "/t/expense-categories", { tenant, body: { name } });
      expectStatus(c, 201, "category");
      cat[name] = c.body.id;
    }
    // 0: 2 days ago, فئة ب, «ب», 100 · 1: today, فئة أ, «أ», 345 · 2: yesterday, فئة ب, «ج», 230
    const expenses = [
      { categoryId: cat["فئة ب"], expenseDate: daysAgo(2), description: "ب مصروف", amountNet: 100, vatAmount: 0 },
      { categoryId: cat["فئة أ"], expenseDate: isoToday(), description: "أ مصروف", amountNet: 300, vatAmount: 45 },
      { categoryId: cat["فئة ب"], expenseDate: daysAgo(1), description: "ج مصروف", amountNet: 200, vatAmount: 30 },
    ];
    for (const body of expenses) {
      const e = await call(app, owner, "POST", "/t/expenses", { tenant, idem: true, body });
      expectStatus(e, 201, "expense");
      exp.push(e.body.id);
    }
    for (const i of [0, 2]) expectStatus(await call(app, owner, "POST", `/t/expenses/${exp[i]}/approve`, { tenant }), 200, "approve");
  });
  after(() => stopApp(app));

  const ids = (r: { body: { items: { id: string }[] } }) => r.body.items.map((i) => i.id);
  const suppliers = (r: { body: { items: { supplierId: string }[] } }) => r.body.items.map((i) => i.supplierId);

  describe("purchase returns", () => {
    const get = async (sort?: string) => {
      const r = await call(app, owner, "GET", `/t/purchase-returns${sort ? `?sort=${encodeURIComponent(sort)}` : ""}`, { tenant });
      expectStatus(r, 200, sort);
      return ids(r);
    };

    it("defaults to newest first", async () => {
      assert.deepEqual(await get(), [ret[3], ret[2], ret[1], ret[0]]);
    });

    it("sorts by value, ties keeping newest first", async () => {
      assert.deepEqual(await get("totalValue:asc"), [ret[1], ret[0], ret[3], ret[2]]);
    });

    it("applies two levels: supplier descending, then value ascending", async () => {
      assert.deepEqual(await get("supplierName:desc,totalValue:asc"), [ret[0], ret[2], ret[1], ret[3]]);
    });

    it("sorts by the materials summary", async () => {
      assert.deepEqual(await get("summary:asc"), [ret[1], ret[3], ret[2], ret[0]]); // «أرز، طماطم» before «طماطم»
    });

    it("ignores columns that are not offered", async () => {
      for (const sort of ["tenant_id:asc", "locationName:asc", "supplier_id:desc"]) {
        assert.deepEqual(await get(sort), [ret[3], ret[2], ret[1], ret[0]], sort);
      }
    });
  });

  describe("payables", () => {
    const get = async (sort?: string) => {
      const r = await call(app, owner, "GET", `/t/payables${sort ? `?sort=${encodeURIComponent(sort)}` : ""}`, { tenant });
      expectStatus(r, 200, sort);
      return r;
    };

    it("defaults to the largest balance first", async () => {
      const r = await get();
      assert.deepEqual(suppliers(r), [sup.B, sup.C, sup.A]);
      assert.deepEqual(r.body.items.map((i: { balance: number }) => i.balance), [270, 80, 26]);
    });

    it("sorts by supplier name", async () => {
      assert.deepEqual(suppliers(await get("name:asc")), [sup.A, sup.B, sup.C]);
    });

    it("applies two levels: payment terms descending, then balance ascending", async () => {
      assert.deepEqual(suppliers(await get("paymentTermsDays:desc,balance:asc")), [sup.A, sup.C, sup.B]);
    });

    it("puts suppliers never paid last", async () => {
      // A and C paid on the same day: name ascending puts A first, unlike the balance-desc default (C 80 before A 26)
      assert.deepEqual(suppliers(await get("lastPaymentOn:asc,name:asc")), [sup.A, sup.C, sup.B]);
    });

    it("ignores columns that are not offered", async () => {
      for (const sort of ["tenant_id:asc", "supplierId:asc", "payment_terms_days:asc"]) {
        assert.deepEqual(suppliers(await get(sort)), [sup.B, sup.C, sup.A], sort);
      }
    });
  });

  describe("expenses", () => {
    const get = async (sort?: string) => {
      const r = await call(app, owner, "GET", `/t/expenses?from=${daysAgo(7)}&to=${isoToday()}${sort ? `&sort=${encodeURIComponent(sort)}` : ""}`, { tenant });
      expectStatus(r, 200, sort);
      return ids(r);
    };

    it("defaults to the latest date first", async () => {
      assert.deepEqual(await get(), [exp[1], exp[2], exp[0]]);
    });

    it("sorts by total and by description", async () => {
      assert.deepEqual(await get("total:asc"), [exp[0], exp[2], exp[1]]);
      assert.deepEqual(await get("description:asc"), [exp[1], exp[0], exp[2]]);
    });

    it("applies two levels: status, then total ascending", async () => {
      // approved before pending; within approved, 100 (2 days ago) before 230 (yesterday), unlike the date-desc default
      assert.deepEqual(await get("status:asc,total:asc"), [exp[0], exp[2], exp[1]]);
    });

    it("applies two levels: category descending, then date ascending", async () => {
      assert.deepEqual(await get("categoryName:desc,expenseDate:asc"), [exp[0], exp[2], exp[1]]);
    });

    it("ignores columns that are not offered, including hidden ones", async () => {
      for (const sort of ["tenant_id:asc", "createdBy:asc", "isMine:desc"]) {
        assert.deepEqual(await get(sort), [exp[1], exp[2], exp[0]], sort);
      }
    });
  });
});
