import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { setAssistantModel } from "../../src/routes/assistant.ts";
import {
  type Actor, type App, addMember, call, createApprovedRecipe, createTenant, createUser, expectStatus, openShift, raiseLimits, receivePo, setupKitchen, startApp, stopApp,
} from "./helpers.ts";

const events = (body: unknown) => String(body).split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)) as Record<string, any>);
const REPORT_OR_SALES = /^(report_|list_orders|order_detail|list_shifts|list_customers|list_expenses)/;

describe("built-in assistant engine (free, no external model)", () => {
  let app: App;
  let owner: Actor;
  let clerk: Actor;
  let cashier: Actor;
  let tenant: string;

  /** One question → { answer text, tools read, files, conversation id }. */
  async function ask(actor: Actor, message: string, conversationId?: string) {
    const res = await call(app, actor, "POST", "/t/assistant/chat", { tenant, body: { message, conversationId } });
    expectStatus(res, 200, message);
    const ev = events(res.body);
    const err = ev.find((e) => e.type === "error");
    assert.equal(err, undefined, `turn failed: ${err?.message}`);
    return {
      text: ev.filter((e) => e.type === "text").map((e) => e.delta).join(""),
      tools: [...new Set(ev.filter((e) => e.type === "tool" && e.status === "start").map((e) => e.name as string))],
      files: ev.filter((e) => e.type === "export"),
      conversationId: ev.find((e) => e.type === "done")?.conversationId as string,
    };
  }

  before(async () => {
    setAssistantModel(undefined); // the default: no Claude key → the built-in engine
    app = await startApp();
    owner = await createUser({ name: "خالد المالك" });
    tenant = await createTenant(app, owner, "مطعم البيت");
    await raiseLimits(tenant);
    const k = await setupKitchen(app, owner, tenant);
    await receivePo(app, owner, tenant, { supplierId: k.supplierId, locationId: k.locationId, items: [{ ingredientId: k.ingredientId, quantity: 5, unitPrice: 8 }] });
    const salad = await createApprovedRecipe(app, owner, tenant, 20, [{ ingredientId: k.ingredientId, quantity: 100 }]);
    const shift = await openShift(app, owner, tenant, k.locationId);
    expectStatus(await call(app, owner, "POST", "/t/pos/orders", { tenant, idem: true, body: { locationId: k.locationId, shiftId: shift, channel: "takeaway", items: [{ recipeId: salad, quantity: 3 }], payments: [{ method: "cash", amount: 69 }] } }), 201, "sale");
    expectStatus(await call(app, owner, "POST", "/t/waste", { tenant, idem: true, body: { locationId: k.locationId, reason: "spoiled", items: [{ ingredientId: k.ingredientId, quantity: 200 }] } }), 201, "waste");
    clerk = await addMember(app, owner, tenant, "inventory_clerk");
    cashier = await addMember(app, owner, tenant, "cashier");
  });
  after(async () => { await stopApp(app); });

  it("is available without any API key", async () => {
    const s = await call(app, clerk, "GET", "/t/assistant/status", { tenant });
    assert.equal(s.body.configured, true);
    assert.equal(s.body.engine, "local");
  });

  it("answers a warehouse question from live stock, in kilos, in Egyptian or standard Arabic", async () => {
    // 5 kg received − 300 g sold − 200 g wasted = 4.5 kg
    const a = await ask(clerk, "كم رصيد الطماطم؟");
    assert.deepEqual(a.tools, ["stock_levels"]);
    assert.match(a.text, /طماطم/);
    assert.match(a.text, /4\.5 كجم/);
    const b = await ask(clerk, "عاوز اعرف عندنا كام طماطم في المخزن");
    assert.match(b.text, /4\.5 كجم/);
  });

  it("understands shop-floor dialect: الغلة، باظ، علينا كام للتجار", async () => {
    assert.ok((await ask(owner, "الغلة النهاردة كام؟")).tools.includes("report_daily_sales"), "الغلة = sales");
    const waste = await ask(owner, "ايه اللي باظ واترمى الشهر ده؟");
    assert.ok(waste.tools.some((t) => /waste/.test(t)), `waste: ${waste.tools}`);
    assert.ok((await ask(owner, "علينا كام للتجار؟")).tools.includes("supplier_balances"), "payables");
    assert.ok((await ask(owner, "الشيفتات المفتوحة")).tools.includes("list_shifts"), "الشيفت = shift");
  });

  it("forgives a typo, but never bends a real word into another subject", async () => {
    assert.ok((await ask(owner, "المبيغات امبارح")).tools.includes("report_daily_sales"), "مبيغات → مبيعات");
    const analysis = await ask(owner, "تحليل الاداء والمشاكل الشهر ده");
    assert.ok(!analysis.tools.includes("list_transfers"), "تحليل is not تحويل");
  });

  it("offers the likely subjects instead of refusing a vague question", async () => {
    assert.ok((await ask(owner, "عايز اعرف الصرف الشهر ده")).tools.includes("list_expenses"), "الصرف = expenses");
    const a = await ask(owner, "الفلوس فين؟");
    assert.match(a.text, /هل تسأل عن/);
    assert.match(a.text, /المبيعات/);
    assert.match(a.text, /مستحقات الموردين/);
  });

  it("answers what is about to expire, from the batches", async () => {
    const a = await ask(clerk, "ايه المواد اللي صلاحيتها هتنتهي الاسبوع ده؟");
    assert.ok(a.tools.includes("expiry_summary"), `tools: ${a.tools}`);
    assert.match(a.text, /ينتهي خلال 7 أيام/);
  });

  it("a warehouse clerk cannot get sales, even by asking directly", async () => {
    const a = await ask(clerk, "كم مبيعات اليوم؟");
    assert.deepEqual(a.tools, [], "nothing is read");
    assert.match(a.text, /خارج صلاحيات دورك/);
    assert.doesNotMatch(a.text, /69|60\.00/);
  });

  it("each role answers the same question from what it may see", async () => {
    const owner1 = await ask(owner, "كم مبيعات اليوم؟");
    assert.deepEqual(owner1.tools, ["report_daily_sales"]);
    assert.match(owner1.text, /\u20C1\u00A060\.00/);
    const cashier1 = await ask(cashier, "كم مبيعات اليوم؟");
    assert.deepEqual(cashier1.tools, ["list_orders"], "the cashier has no reports, so it reads orders");
    assert.match(cashier1.text, /\u20C1\u00A069\.00/);
  });

  it("refuses general questions outside the company's data", async () => {
    const a = await ask(owner, "ما هي عاصمة فرنسا؟");
    assert.deepEqual(a.tools, []);
    assert.match(a.text, /لا أجيب عن الأسئلة العامة/);
  });

  it("builds a requested file from the database, and exports a previous answer on follow-up", async () => {
    const a = await ask(owner, "صدّر أوامر الشراء المستلمة Excel");
    assert.equal(a.files.length, 1);
    assert.equal(a.files[0]!.format, "xlsx");
    assert.equal(a.files[0]!.rows, 1);
    const first = await ask(clerk, "كم رصيد الطماطم؟");
    const follow = await ask(clerk, "صدّره PDF", first.conversationId);
    assert.equal(follow.files.length, 1);
    assert.equal(follow.files[0]!.format, "pdf");
  });

  it("diagnoses problems within the member's scope only", async () => {
    const o = await ask(owner, "ايه المشاكل والعيوب في شركتي؟");
    assert.match(o.text, /تحليل/);
    assert.match(o.text, /هدر/);
    assert.ok(o.tools.some((t) => t.startsWith("report_")), "the owner's diagnosis uses reports");
    const c = await ask(clerk, "ايه المشاكل والعيوب في شركتي؟");
    assert.ok(c.tools.length > 0);
    for (const t of c.tools) assert.doesNotMatch(t, REPORT_OR_SALES, `clerk diagnosis must not read ${t}`);
    assert.doesNotMatch(c.text, /المبيعات انخفضت|نسبة تكلفة الطعام/);
  });

  it("routes phrasing to the right report, with names, thresholds and follow-ups", async () => {
    assert.deepEqual((await ask(owner, "ملخص مبيعات اليوم حسب القناة")).tools, ["report_sales_by_channel"]);
    const fc = await ask(owner, "ما الوصفات التي تتجاوز نسبة تكلفتها 35%؟");
    assert.deepEqual(fc.tools, ["list_recipes"]);
    assert.match(fc.text, /فوق 35%/);
    const st = await ask(owner, "كشف حساب مورد الخضار");
    assert.deepEqual(st.tools, ["list_suppliers", "supplier_statement"]);
    assert.match(st.text, /الرصيد الختامي \u2066\u20C1\u00A040\.00/);
    const pay = await ask(owner, "كم أستحق لكل مورد وأيها متأخر؟");
    assert.match(pay.text, /\u20C1\u00A040\.00/);
    assert.deepEqual((await ask(owner, "اعرض المواد الخام التي نفد رصيدها")).text.includes("لا توجد مواد نفد رصيدها"), true);
    const empty = await ask(owner, "صدّر أوامر الشراء المعتمدة غير المستلمة إلى Excel");
    assert.equal(empty.files.length, 0, "no empty file");
    const first = await ask(clerk, "كم رصيد الطماطم؟");
    const next = await ask(clerk, "والهدر الشهر ده؟", first.conversationId);
    assert.ok(next.tools.includes("list_waste"));
  });

  it("greets with examples that match the role", async () => {
    const c = await ask(clerk, "مرحبا");
    assert.match(c.text, /رصيد الطماطم/);
    assert.doesNotMatch(c.text, /مبيعات اليوم/);
  });
});
