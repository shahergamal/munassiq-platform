import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { config } from "../../src/config.ts";
import { setAssistantModel } from "../../src/routes/assistant.ts";
import { type Actor, type App, call, createTenant, createUser, expectStatus, raiseLimits, receivePo, setupKitchen, startApp, stopApp } from "./helpers.ts";

const events = (body: unknown) => String(body).split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)) as Record<string, any>);
const turn = (res: { body: unknown }) => {
  const ev = events(res.body);
  return {
    text: ev.filter((e) => e.type === "text").map((e) => e.delta).join(""),
    tools: [...new Set(ev.filter((e) => e.type === "tool" && e.status === "start").map((e) => e.name as string))],
    files: ev.filter((e) => e.type === "export"),
    error: ev.find((e) => e.type === "error")?.message as string | undefined,
    conversationId: ev.find((e) => e.type === "done")?.conversationId as string,
  };
};

describe("assistant: admin-controlled limits, the platform admin's assistant, and exports in every format", () => {
  let app: App;
  let admin: Actor;
  let admin2: Actor;
  let owner: Actor;
  let tenant: string;

  const member = (actor: Actor, message: string, conversationId?: string) => call(app, actor, "POST", "/t/assistant/chat", { tenant, body: { message, conversationId } });
  const platform = async (actor: Actor, message: string, conversationId?: string) => {
    const res = await call(app, actor, "POST", "/admin/assistant/chat", { body: { message, conversationId } });
    expectStatus(res, 200, message);
    const t = turn(res);
    assert.equal(t.error, undefined, `turn failed: ${t.error}`);
    return t;
  };
  const setLimit = (n: number | null | undefined) =>
    call(app, admin, "PUT", `/admin/tenants/${tenant}/limits`, { body: { branchesLimit: null, usersLimit: null, ...(n === undefined ? {} : { assistantDailyTurns: n }) } });

  before(async () => {
    setAssistantModel(undefined);
    app = await startApp();
    [admin, admin2] = await Promise.all([createUser({ admin: true, name: "مدير المنصة" }), createUser({ admin: true })]);
    owner = await createUser({ name: "سارة المالكة" });
    tenant = await createTenant(app, owner, "مطعم الاختبار الإداري");
    await raiseLimits(tenant);
    const k = await setupKitchen(app, owner, tenant);
    await receivePo(app, owner, tenant, { supplierId: k.supplierId, locationId: k.locationId, items: [{ ingredientId: k.ingredientId, quantity: 2, unitPrice: 10 }] });
  });
  after(async () => { await setLimit(null); await stopApp(app); });

  it("the platform admin sets a workspace's daily limit; members get it, 0 switches the assistant off", async () => {
    expectStatus(await setLimit(1), 200, "limit 1");
    assert.equal((await call(app, owner, "GET", "/t/assistant/status", { tenant })).body.dailyLimit, 1);
    expectStatus(await member(owner, "مرحبا"), 200, "first question");
    expectStatus(await member(owner, "مرحبا"), 429, "over the limit");
    const detail = (await call(app, admin, "GET", `/admin/tenants/${tenant}`)).body;
    assert.equal(detail.assistantOverride, 1);
    assert.ok(detail.assistantTurnsToday >= 1);

    expectStatus(await setLimit(0), 200, "off");
    assert.equal((await call(app, owner, "GET", "/t/assistant/status", { tenant })).body.dailyLimit, 0);
    const off = await member(owner, "مرحبا");
    expectStatus(off, 403, "disabled");
    assert.equal(off.body.error.code, "assistant_disabled");

    expectStatus(await setLimit(undefined), 200, "limits saved without the assistant field");
    assert.equal((await call(app, admin, "GET", `/admin/tenants/${tenant}`)).body.assistantOverride, 0, "omitted = unchanged");
    expectStatus(await setLimit(null), 200, "back to default");
    assert.equal((await call(app, owner, "GET", "/t/assistant/status", { tenant })).body.dailyLimit, config.ASSISTANT_DAILY_TURNS);
    expectStatus(await setLimit(-1), 422, "negative");
    expectStatus(await call(app, owner, "PUT", `/admin/tenants/${tenant}/limits`, { body: { branchesLimit: null, usersLimit: null, assistantDailyTurns: 500 } }), 403, "a member cannot raise it");
  });

  it("members export any answer: reports as PDF, lists as Word, and are told which formats exist", async () => {
    const vat = turn(await member(owner, "تقرير الضريبة pdf"));
    assert.equal(vat.files[0]?.format, "pdf");
    const doc = turn(await member(owner, "صدر الموردين word"));
    assert.equal(doc.files[0]?.format, "doc");
    const dl = await app.inject({ method: "GET", url: `/api/v1/t/assistant/exports/${doc.files[0]!.id}`, headers: { cookie: `mn_sid=${owner.token}`, "x-tenant-id": tenant } });
    assert.equal(dl.headers["content-type"], "application/msword");
    const pdf = await app.inject({ method: "GET", url: `/api/v1/t/assistant/exports/${vat.files[0]!.id}`, headers: { cookie: `mn_sid=${owner.token}`, "x-tenant-id": tenant } });
    assert.match(pdf.body, /print\(\)/, "the PDF page opens the print dialog");
    assert.match(pdf.body, /ضريبة المخرجات/);
    const diag = turn(await member(owner, "ايه المشاكل في شركتي"));
    const diagFile = turn(await member(owner, "صدره اكسل", diag.conversationId));
    assert.equal(diagFile.files[0]?.format, "xlsx", "the diagnosis itself becomes a file");
    const ppt = turn(await member(owner, "صدر المبيعات باوربوينت"));
    assert.equal(ppt.files.length, 0);
    assert.match(ppt.text, /Excel أو CSV أو PDF أو Word/);
  });

  it("the platform admin's assistant answers from platform data", async () => {
    const stats = await platform(admin, "أعطني ملخص المنصة");
    assert.deepEqual(stats.tools, ["platform_stats"]);
    assert.match(stats.text, /منشآت نشطة/);
    const subs = await platform(admin, "ما الاشتراكات التي تنتهي خلال 30 يوماً؟");
    assert.deepEqual(subs.tools, ["platform_subscriptions"]);
    const one = await platform(admin, "تفاصيل منشأة مطعم الاختبار الإداري");
    assert.deepEqual(one.tools, ["platform_tenants", "platform_tenant_detail"]);
    assert.match(one.text, /مطعم الاختبار الإداري/);
    assert.match(one.text, /حد المساعد اليومي/);
    const diag = await platform(admin, "ايه المشاكل والفرص في المنصة؟");
    assert.match(diag.text, /تحليل المنصة/);
    for (const t of diag.tools) assert.match(t, /^platform_/);
  });

  it("the platform admin cannot reach a workspace's internal data through the assistant", async () => {
    const a = await platform(admin, "كم مبيعات مطعم الاختبار الإداري اليوم وكم رصيد الطماطم؟");
    assert.deepEqual(a.tools, [], "nothing is read");
    assert.match(a.text, /جلسة دعم/);
  });

  it("admin files and conversations belong to that admin; members and other admins are refused", async () => {
    const f = await platform(admin, "صدر الباقات Excel");
    assert.equal(f.files[0]?.format, "xlsx");
    const url = `/admin/assistant/exports/${f.files[0]!.id}`;
    expectStatus(await call(app, admin, "GET", url), 200, "own file");
    expectStatus(await call(app, admin2, "GET", url), 404, "another admin");
    expectStatus(await call(app, admin2, "GET", `/admin/assistant/conversations/${f.conversationId}`), 404, "another admin's chat");
    expectStatus(await call(app, owner, "GET", url), 403, "a member");
    expectStatus(await call(app, owner, "POST", "/admin/assistant/chat", { body: { message: "كم عميل" } }), 403, "a member cannot chat");
    const word = await platform(admin, "صدره word", f.conversationId);
    assert.equal(word.files[0]?.format, "doc", "follow-up export in another format");
  });
});
