import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { setAssistantModel } from "../../src/routes/assistant.ts";
import type { ModelClient } from "../../src/lib/assistant/engine.ts";
import {
  type Actor, type App, addMember, call, createTenant, createUser, expectStatus, ownerPool, raiseLimits, receivePo, setupKitchen, startApp, stopApp, type Kitchen,
} from "./helpers.ts";

type Req = Parameters<ModelClient["run"]>[0];
type Block = Record<string, unknown>;
const text = (t: string): Block => ({ type: "text", text: t, citations: null });
const use = (name: string, input: unknown, id = `tu_${name}`): Block => ({ type: "tool_use", id, name, input });
const reply = (content: Block[], stop = "end_turn") =>
  ({ id: "msg_test", type: "message", role: "assistant", model: "scripted", content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }) as unknown as Anthropic.Beta.BetaMessage;

/** A model that plays a fixed script and records exactly what the server offered it and sent back. */
function scripted(steps: ((req: Req) => Anthropic.Beta.BetaMessage)[]) {
  const seen: { tools: string[]; system: string; messages: Req["messages"] }[] = [];
  const model: ModelClient = {
    async run(req, onText) {
      seen.push({ tools: req.tools.map((t) => t.name), system: req.system.map((s) => s.text).join("\n"), messages: structuredClone(req.messages) });
      const m = steps[Math.min(seen.length - 1, steps.length - 1)]!(req);
      for (const b of m.content) if (b.type === "text") onText(b.text);
      return m;
    },
  };
  return { model, seen };
}
/** tool_result blocks the server sent back on the given model call. */
const resultsOf = (req: { messages: Req["messages"] }) => {
  const last = req.messages[req.messages.length - 1]!;
  return (Array.isArray(last.content) ? last.content : []) as { type: string; content: string; is_error?: boolean; tool_use_id: string }[];
};
const events = (body: unknown) => String(body).split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)) as Record<string, any>);

describe("AI assistant: permission-scoped, tenant-isolated, grounded in real data", () => {
  let app: App;
  let owner: Actor;
  let clerk: Actor;
  let cashier: Actor;
  let tenant: string;
  let k: Kitchen;
  let po: string;
  let otherTenant: string;
  let otherPo: string;

  const ask = (actor: Actor, message: string, conversationId?: string) =>
    call(app, actor, "POST", "/t/assistant/chat", { tenant, body: { message, conversationId } });

  before(async () => {
    app = await startApp();
    owner = await createUser({ name: "خالد المالك" });
    tenant = await createTenant(app, owner, "مطعم المساعد");
    await raiseLimits(tenant);
    k = await setupKitchen(app, owner, tenant);
    po = await receivePo(app, owner, tenant, { supplierId: k.supplierId, locationId: k.locationId, items: [{ ingredientId: k.ingredientId, quantity: 5, unitPrice: 8 }] });
    clerk = await addMember(app, owner, tenant, "inventory_clerk");
    cashier = await addMember(app, owner, tenant, "cashier");
    const other = await createUser();
    otherTenant = await createTenant(app, other, "مطعم آخر");
    const k2 = await setupKitchen(app, other, otherTenant);
    otherPo = await receivePo(app, other, otherTenant, { supplierId: k2.supplierId, locationId: k2.locationId, items: [{ ingredientId: k2.ingredientId, quantity: 1, unitPrice: 999 }] });
  });
  after(async () => { setAssistantModel(undefined); await stopApp(app); });

  it("says clearly when no model is configured", async () => {
    setAssistantModel(null);
    const s = await call(app, owner, "GET", "/t/assistant/status", { tenant });
    assert.equal(s.body.configured, false);
    const clerkScope = (await call(app, clerk, "GET", "/t/assistant/status", { tenant })).body.scope as string[];
    assert.ok(clerkScope.includes("المخزون والجرد والصلاحية"));
    assert.ok(!clerkScope.includes("التقارير التحليلية") && !clerkScope.includes("المبيعات والطلبات والشفتات"));
    expectStatus(await ask(owner, "مرحبا"), 503, "not configured");
  });

  it("offers each role only the tools its permissions allow — the model never learns the rest exist", async () => {
    const s = scripted([() => reply([text("تم")])]);
    setAssistantModel(s.model);
    for (const actor of [owner, clerk, cashier]) expectStatus(await ask(actor, "ما لديك؟"), 200, "ask");
    const [ownerTools, clerkTools, cashierTools] = s.seen.map((x) => new Set(x.tools));
    assert.ok(ownerTools!.has("report_daily_sales") && ownerTools!.has("list_expenses") && ownerTools!.has("stock_levels"));
    // Warehouse clerk: stock and purchasing, never sales, reports or expenses.
    assert.ok(clerkTools!.has("stock_levels") && clerkTools!.has("list_purchase_orders"));
    for (const n of ["report_daily_sales", "list_orders", "list_expenses", "report_vat", "list_shifts"]) assert.ok(!clerkTools!.has(n), `clerk must not get ${n}`);
    // Cashier: sales only.
    assert.ok(cashierTools!.has("list_orders"));
    for (const n of ["stock_levels", "list_purchase_orders", "report_daily_sales", "supplier_balances"]) assert.ok(!cashierTools!.has(n), `cashier must not get ${n}`);
    assert.match(s.seen[1]!.system, /stock/);
    assert.doesNotMatch(s.seen[1]!.system, /analytical reports/);
  });

  it("refuses a tool the user was not offered, even if the model calls it anyway", async () => {
    const s = scripted([() => reply([use("report_daily_sales", {}), use("list_expenses", {}, "tu_2")], "tool_use"), () => reply([text("خارج صلاحياتك")])]);
    setAssistantModel(s.model);
    const r = await ask(clerk, "كم مبيعات اليوم؟");
    expectStatus(r, 200);
    const results = resultsOf(s.seen[1]!);
    assert.equal(results.length, 2);
    for (const x of results) { assert.equal(x.is_error, true); assert.match(x.content, /outside the user's permissions/); }
  });

  it("reads real data as the user, through the same endpoint and RLS as the screens", async () => {
    const s = scripted([() => reply([text("سأتحقق. "), use("stock_levels", {})], "tool_use"), () => reply([text("لديك 5 كجم طماطم.")])]);
    setAssistantModel(s.model);
    const r = await ask(clerk, "كم رصيد الطماطم؟");
    const ev = events(r.body);
    assert.deepEqual(ev.filter((e) => e.type === "tool").map((e) => e.status), ["start", "done"]);
    assert.equal(ev.filter((e) => e.type === "text").map((e) => e.delta).join(""), "سأتحقق. لديك 5 كجم طماطم.");
    const data = resultsOf(s.seen[1]!)[0]!;
    assert.ok(!data.is_error);
    assert.match(data.content, /طماطم/);
    assert.match(data.content, /5000/); // 5 kg in base grams, straight from the stock table
    const done = ev.find((e) => e.type === "done")!;
    const conv = await call(app, clerk, "GET", `/t/assistant/conversations/${done.conversationId}`, { tenant });
    assert.deepEqual(conv.body.messages.map((m: { role: string }) => m.role), ["user", "assistant"]);
  });

  it("cannot reach another workspace's record even with its real id", async () => {
    const s = scripted([() => reply([use("purchase_order_detail", { id: otherPo })], "tool_use"), () => reply([text("غير موجود")])]);
    setAssistantModel(s.model);
    await ask(owner, "افتح أمر الشراء هذا");
    const x = resultsOf(s.seen[1]!)[0]!;
    assert.equal(x.is_error, true);
    assert.doesNotMatch(x.content, /999/);
    // …while its own purchase order is readable.
    const own = scripted([() => reply([use("purchase_order_detail", { id: po })], "tool_use"), () => reply([text("ok")])]);
    setAssistantModel(own.model);
    await ask(owner, "افتح أمر الشراء");
    assert.ok(!resultsOf(own.seen[1]!)[0]!.is_error);
  });

  it("rejects smuggled parameters instead of passing them to the endpoint", async () => {
    const s = scripted([() => reply([use("stock_levels", { q: "طماطم", tenantId: otherTenant, sort: "x;drop" })], "tool_use"), () => reply([text("ok")])]);
    setAssistantModel(s.model);
    await ask(owner, "المخزون");
    const x = resultsOf(s.seen[1]!)[0]!;
    assert.equal(x.is_error, true);
    assert.match(x.content, /Invalid input/);
  });

  it("builds files from the database (not the model's numbers), downloadable only by their owner", async () => {
    const s = scripted([
      () => reply([use("create_file", { source: "list_purchase_orders", input: { status: "received" }, format: "xlsx", title: "أوامر الشراء المستلمة", columns: [{ key: "supplierName", label: "المورد" }, { key: "grandTotal", label: "الإجمالي" }, { key: "invented", label: "رقم مخترع" }] })], "tool_use"),
      () => reply([text("الملف جاهز.")]),
    ]);
    setAssistantModel(s.model);
    const ev = events((await ask(owner, "صدّر أوامر الشراء المستلمة Excel")).body);
    const file = ev.find((e) => e.type === "export")!;
    assert.equal(file.rows, 1);
    assert.match(file.filename, /\.xlsx$/);
    const dl = await app.inject({ method: "GET", url: `/api/v1/t/assistant/exports/${file.id}`, headers: { cookie: `mn_sid=${owner.token}`, "x-tenant-id": tenant } });
    assert.equal(dl.statusCode, 200);
    assert.match(String(dl.headers["content-type"]), /spreadsheetml/);
    // Same workspace, different member: not theirs. Other workspace: invisible.
    expectStatus(await call(app, clerk, "GET", `/t/assistant/exports/${file.id}`, { tenant }), 404, "colleague");
    const saved = (await ownerPool.query("SELECT content FROM assistant_exports WHERE id = $1", [file.id])).rows[0].content as Buffer;
    assert.ok(!saved.toString("latin1").includes("رقم مخترع"), "unknown columns are dropped, never invented");
    // A file from a source outside the user's scope is refused.
    const bad = scripted([() => reply([use("create_file", { source: "report_daily_sales", format: "csv", title: "x" })], "tool_use"), () => reply([text("لا")])]);
    setAssistantModel(bad.model);
    await ask(clerk, "صدّر المبيعات");
    assert.equal(resultsOf(bad.seen[1]!)[0]!.is_error, true);
  });

  it("keeps each member's conversations private, even inside the same workspace", async () => {
    const s = scripted([() => reply([text("سرّي")])]);
    setAssistantModel(s.model);
    const done = events((await ask(owner, "سؤال المالك")).body).find((e) => e.type === "done")!;
    expectStatus(await call(app, clerk, "GET", `/t/assistant/conversations/${done.conversationId}`, { tenant }), 404, "colleague read");
    const list = await call(app, clerk, "GET", "/t/assistant/conversations", { tenant });
    assert.ok(!list.body.items.some((c: { id: string }) => c.id === done.conversationId));
    // Continuing someone else's conversation is refused too.
    expectStatus(await ask(clerk, "تابع", done.conversationId), 404, "colleague continue");
  });

  it("continues a conversation with its history, and enforces the daily quota", async () => {
    const s = scripted([() => reply([text("أولى")]), () => reply([text("ثانية")])]);
    setAssistantModel(s.model);
    const first = events((await ask(cashier, "سؤال 1")).body).find((e) => e.type === "done")!;
    await ask(cashier, "سؤال 2", first.conversationId);
    const replayed = s.seen[1]!.messages.map((m) => (typeof m.content === "string" ? m.content : m.role));
    assert.deepEqual(replayed, ["سؤال 1", "assistant", "سؤال 2"]);
    await ownerPool.query("UPDATE assistant_usage SET turns = 50 WHERE tenant_id = $1 AND user_id = $2", [tenant, cashier.id]);
    expectStatus(await ask(cashier, "سؤال 3"), 429, "quota");
  });

  it("a role without assistant:use cannot use it at all", async () => {
    const role = await call(app, owner, "POST", "/t/roles", { tenant, body: { name: "بدون مساعد", permissions: ["stock:read"] } });
    expectStatus(role, 201, "role");
    const u = await createUser();
    expectStatus(await call(app, owner, "POST", "/t/members", { tenant, body: { email: u.email, role: "custom", customRoleId: role.body.id } }), 201, "member");
    expectStatus(await ask(u, "مرحبا"), 403, "no permission");
    expectStatus(await call(app, u, "GET", "/t/assistant/status", { tenant }), 403, "status");
  });
});
