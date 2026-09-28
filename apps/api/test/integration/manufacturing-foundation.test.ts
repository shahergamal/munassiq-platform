import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  call, code, createFactory, createIngredient, createTenant, createUser, expectStatus, ownerPool, receivePo, setupKitchen, startApp, stopApp,
  type Actor, type App,
} from "./helpers.ts";

// Manufacturing M1 (docs/manufacturing/ARCHITECTURE.md): a factory workspace sees its own pages only, values each
// item type in its own inventory account, and analyses by cost center and fiscal year.
describe("manufacturing foundation", () => {
  let app: App;
  let owner: Actor;
  let factory: string;

  before(async () => {
    app = await startApp();
    owner = await createUser();
    factory = await createFactory(app, owner);
  });
  after(() => stopApp(app));

  const accountLines = async (tenant: string, sourceType: string) =>
    (await ownerPool.query<{ key: string | null; code: string; debit: number; credit: number; cc: string | null }>(
      `SELECT a.system_key AS key, a.code, l.debit::float8 AS debit, l.credit::float8 AS credit, l.cost_center_id AS cc
         FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
        WHERE e.tenant_id = $1 AND e.source_type = $2 ORDER BY a.code`, [tenant, sourceType])).rows;

  it("is seeded as a factory: plans, units, chart of accounts, expense categories", async () => {
    const ctx = await call(app, owner, "GET", "/t/context", { tenant: factory });
    expectStatus(ctx, 200, "context");
    assert.equal(ctx.body.tenant.sector, "manufacturing");
    const units = await call(app, owner, "GET", "/t/units", { tenant: factory });
    assert.ok(units.body.items.some((u: { code: string }) => u.code === "ton"), "factory units");
    const acc = (await ownerPool.query<{ system_key: string; code: string; name: string }>(
      "SELECT system_key, code, name FROM accounts WHERE tenant_id = $1 AND system_key IS NOT NULL", [factory])).rows;
    const byKey = new Map(acc.map((a) => [a.system_key, a]));
    for (const k of ["wip", "inventory_semi", "inventory_finished", "inventory_packaging", "inventory_consumable", "inventory_spare", "applied_overhead", "applied_labor", "production_variance", "abnormal_scrap"]) {
      assert.ok(byKey.has(k), `account ${k}`);
    }
    assert.equal(byKey.get("inventory")?.name, "مخزون المواد الخام");
    const cats = (await ownerPool.query<{ name: string; code: string | null }>(
      "SELECT c.name, a.code FROM expense_categories c LEFT JOIN accounts a ON a.id = c.account_id WHERE c.tenant_id = $1", [factory])).rows;
    assert.equal(cats.find((c) => c.name === "صيانة الآلات")?.code, "6107");
    assert.ok(!cats.some((c) => c.name === "عمولات التوصيل"), "no restaurant categories");
  });

  it("hides the restaurant pages: permissions, endpoints and the role editor", async () => {
    const ctx = await call(app, owner, "GET", "/t/context", { tenant: factory });
    const perms: string[] = ctx.body.permissions;
    assert.ok(perms.includes("ingredients.create") && perms.includes("acc_journal.create"));
    for (const p of ["pos.sell", "kitchen.use", "dining.view", "recipes.view", "prep_recipes.view", "rep_menu_eng.view"]) assert.ok(!perms.includes(p), p);
    // A restaurant page does not exist here (404), whatever the role.
    const pos = await call(app, owner, "GET", "/t/pos/tickets", { tenant: factory });
    assert.equal(pos.status, 404);
    assert.equal((await call(app, owner, "GET", "/t/dining-areas", { tenant: factory })).status, 404);
    const roles = await call(app, owner, "GET", "/t/roles", { tenant: factory });
    expectStatus(roles, 200, "roles");
    const pages = (roles.body.catalog as { pages: { key: string; label: string }[] }[]).flatMap((m) => m.pages);
    assert.ok(!pages.some((p) => p.key === "pos" || p.key === "dining"), "no restaurant pages in the editor");
    assert.equal(pages.find((p) => p.key === "ingredients")?.label, "الأصناف");
    assert.ok(!(roles.body.permissions as string[]).includes("pos.sell"));
    // A role made only of restaurant pages is empty here.
    const bad = await call(app, owner, "POST", "/t/roles", { tenant: factory, body: { name: "كاشير", permissions: ["pos.sell"] } });
    assert.equal(bad.status, 422);
    const ok = await call(app, owner, "POST", "/t/roles", { tenant: factory, body: { name: code("مخطط"), permissions: ["pos.sell", "stock.view"] } });
    expectStatus(ok, 201, "role");
    assert.deepEqual(ok.body.permissions, ["stock.view"]);
  });

  it("a restaurant keeps its pages and its single inventory account", async () => {
    const o = await createUser();
    const r = await createTenant(app, o);
    const ctx = await call(app, o, "GET", "/t/context", { tenant: r });
    assert.ok((ctx.body.permissions as string[]).includes("pos.sell"));
    expectStatus(await call(app, o, "GET", "/t/dining-areas", { tenant: r }), 200, "dining in a restaurant");
    const k = await setupKitchen(app, o, r);
    await receivePo(app, o, r, { supplierId: k.supplierId, locationId: k.locationId, items: [{ ingredientId: k.ingredientId, quantity: 2, unitPrice: 10 }] });
    const lines = await accountLines(r, "goods_receipt");
    assert.deepEqual(lines.filter((l) => l.debit > 0 && l.key?.startsWith("inventory")).map((l) => [l.key, l.debit]), [["inventory", 20]]);
  });

  it("values each item type in its own account and locks the type once stock moved", async () => {
    const k = await setupKitchen(app, owner, factory);
    const finished = await createIngredient(app, owner, factory, "منتج تام", "pcs", "pcs", { itemType: "finished", nameEn: "Finished product" });
    const packaging = await createIngredient(app, owner, factory, "كرتون تعبئة", "pcs", "pcs", { itemType: "packaging" });
    await receivePo(app, owner, factory, {
      supplierId: k.supplierId, locationId: k.locationId,
      items: [{ ingredientId: k.ingredientId, quantity: 3, unitPrice: 10 }, { ingredientId: finished, quantity: 5, unitPrice: 7 }, { ingredientId: packaging, quantity: 10, unitPrice: 1.5 }],
    });
    const lines = await accountLines(factory, "goods_receipt");
    const dr = Object.fromEntries(lines.filter((l) => l.debit > 0 && l.key !== "vat_input").map((l) => [l.key, l.debit]));
    assert.deepEqual(dr, { inventory: 30, inventory_finished: 35, inventory_packaging: 15 });
    const ap = lines.find((l) => l.key === "ap")!;
    assert.equal(ap.credit, lines.filter((l) => l.debit > 0).reduce((a, l) => a + l.debit, 0), "balanced");

    const list = await call(app, owner, "GET", "/t/ingredients?type=finished,packaging", { tenant: factory });
    assert.deepEqual(list.body.items.map((i: { itemType: string }) => i.itemType).sort(), ["finished", "packaging"]);
    assert.equal(list.body.items.find((i: { id: string }) => i.id === finished).nameEn, "Finished product");
    const locked = await call(app, owner, "PATCH", `/t/ingredients/${finished}`, { tenant: factory, body: { itemType: "raw" } });
    assert.equal(locked.status, 409);
    assert.equal(locked.body.error.code, "type_locked");
    const summary = await call(app, owner, "GET", "/t/accounting/summary", { tenant: factory });
    assert.equal(summary.body.inventory, 80, "all inventory accounts on the dashboard");
  });

  it("cost centers tag entries and expenses and filter the income statement", async () => {
    const cc = await call(app, owner, "POST", "/t/cost-centers", { tenant: factory, body: { code: "line-1", name: "خط الإنتاج الأول", kind: "production" } });
    expectStatus(cc, 201, "cost center");
    expectStatus(await call(app, owner, "POST", "/t/cost-centers", { tenant: factory, body: { code: "LINE-1", name: "مكرر" } }), 409, "duplicate code");
    const accounts = (await call(app, owner, "GET", "/t/accounts", { tenant: factory })).body.items as { id: string; code: string }[];
    const acc = (c: string) => accounts.find((a) => a.code === c)!.id;
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh" }).format(new Date());
    const je = await call(app, owner, "POST", "/t/accounting/journal", {
      tenant: factory, idem: true,
      body: { date: today, description: "صيانة خط الإنتاج", lines: [{ accountId: acc("6107"), debit: 400, costCenterId: cc.body.id }, { accountId: acc("1101"), credit: 400 }] },
    });
    expectStatus(je, 201, "journal");
    const cats = (await ownerPool.query<{ id: string }>("SELECT id FROM expense_categories WHERE tenant_id = $1 AND name = 'الإيجار'", [factory])).rows;
    const ex = await call(app, owner, "POST", "/t/expenses", { tenant: factory, idem: true, body: { categoryId: cats[0]!.id, expenseDate: today, description: "إيجار العنبر", amountNet: 1000, costCenterId: cc.body.id } });
    expectStatus(ex, 201, "expense");
    expectStatus(await call(app, owner, "POST", `/t/expenses/${ex.body.id}/approve`, { tenant: factory }), 200, "approve expense");
    const exLines = await accountLines(factory, "expense");
    assert.equal(exLines.find((l) => l.debit === 1000)?.cc, cc.body.id);
    // Another manual entry without a cost center does not appear in the center's statement.
    await call(app, owner, "POST", "/t/accounting/journal", { tenant: factory, idem: true, body: { date: today, description: "مصروف عام", lines: [{ accountId: acc("6199"), debit: 50 }, { accountId: acc("1101"), credit: 50 }] } });
    const is = await call(app, owner, "GET", `/t/accounting/income-statement?costCenterId=${cc.body.id}&from=${today.slice(0, 8)}01&to=${today}`, { tenant: factory });
    expectStatus(is, 200, "income statement");
    assert.equal(is.body.expenses.total, 1400);
    const all = await call(app, owner, "GET", `/t/accounting/income-statement?from=${today.slice(0, 8)}01&to=${today}`, { tenant: factory });
    assert.equal(all.body.expenses.total, 1450);
    expectStatus(await call(app, owner, "PATCH", `/t/cost-centers/${cc.body.id}`, { tenant: factory, body: { isActive: false } }), 200, "stop");
    const stopped = await call(app, owner, "POST", "/t/accounting/journal", {
      tenant: factory, idem: true, body: { date: today, description: "على مركز موقوف", lines: [{ accountId: acc("6107"), debit: 1, costCenterId: cc.body.id }, { accountId: acc("1101"), credit: 1 }] },
    });
    assert.equal(stopped.status, 422);
  });

  it("a fiscal year may start in any month; closing it fixes the start", async () => {
    expectStatus(await call(app, owner, "PUT", "/t/accounting/fiscal", { tenant: factory, body: { startMonth: 7 } }), 200, "start in July");
    const fy = await call(app, owner, "GET", "/t/accounting/fiscal?year=2025", { tenant: factory });
    expectStatus(fy, 200, "fiscal");
    assert.deepEqual([fy.body.from, fy.body.to], ["2024-07-01", "2025-06-30"]);
    assert.equal(fy.body.periods.length, 12);
    assert.deepEqual([fy.body.periods[0].from, fy.body.periods[11].to], ["2024-07-01", "2025-06-30"]);
    const close = await call(app, owner, "POST", "/t/accounting/close-year", { tenant: factory, body: { year: 2025 } });
    expectStatus(close, 201, "close fiscal 2025");
    assert.equal(close.body.lockDate, "2025-06-30");
    const after = await call(app, owner, "GET", "/t/accounting/fiscal?year=2025", { tenant: factory });
    assert.ok(after.body.yearClosed);
    assert.ok(after.body.periods.every((p: { status: string }) => p.status === "closed"));
    const moved = await call(app, owner, "PUT", "/t/accounting/fiscal", { tenant: factory, body: { startMonth: 1 } });
    assert.equal(moved.status, 409);
  });
});
