import Anthropic from "@anthropic-ai/sdk";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.ts";
import { allowedTools, claudeModel, scopeAreas, runTurn, type AssistantEvent, type AssistantMessage, type BuiltFile, type ModelClient } from "../lib/assistant/engine.ts";
import { localModel } from "../lib/assistant/local.ts";
import { AppError, notFound } from "../lib/errors.ts";
import type { Permission } from "../lib/rbac.ts";
import { auditTenant, isUuid, requireTenant, tenantTx } from "../plugins/auth.ts";

// The model is created lazily from config; tests swap in a scripted one.
let modelOverride: ModelClient | null | undefined;
export function setAssistantModel(m: ModelClient | null | undefined) { modelOverride = m; }
export function model(): ModelClient | null {
  if (modelOverride !== undefined) return modelOverride;
  // Without a Claude key the free built-in engine answers: same tools, same permission checks.
  return config.ANTHROPIC_API_KEY ? claudeModel(config.ANTHROPIC_API_KEY, config.ASSISTANT_MODEL) : localModel();
}
export const engineName = () => (modelOverride !== undefined ? "custom" : config.ANTHROPIC_API_KEY ? "claude" : "local");

const ROLE_AR: Record<string, string> = { owner: "المالك", manager: "مدير", accountant: "محاسب", inventory_clerk: "أمين مخزن", cashier: "كاشير" };
const MAX_HISTORY = 40;
export const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh" }).format(new Date());

/** Starting prompts that match what the user can actually reach. */
const SUGGESTIONS: [string, string][] = [
  ["rep_menu_profit.view", "ما أهم ثلاث مشاكل في تكاليف مطعمي هذا الشهر وكيف أعالجها؟"],
  ["rep_daily_sales.view", "قارن مبيعات آخر 7 أيام بالأسبوع الذي قبله"],
  ["rep_menu_profit.view", "أي أصناف المنيو أقل ربحية؟"],
  ["ingredients.view", "ما المواد تحت الحد الأدنى وكم أحتاج لإعادة الطلب؟"],
  ["batches.view", "ما المواد التي تنتهي صلاحيتها هذا الأسبوع؟"],
  ["waste.view", "أين يذهب الهدر في آخر 30 يوماً؟"],
  ["payables.view", "كم أستحق لكل مورد وأيها متأخر؟"],
  ["purchases.view", "صدّر أوامر الشراء المعتمدة غير المستلمة إلى Excel"],
  ["recipes.view", "ما الوصفات التي تتجاوز نسبة تكلفتها 35%؟"],
  ["rep_sales_channel.view", "ملخص مبيعات اليوم حسب القناة"],
  ["expenses.view", "ما المصروفات بانتظار الاعتماد؟"],
  ["ingredients.view", "اعرض المواد الخام التي نفد رصيدها"],
];

/** Bounded history that always starts on a real user question (never an orphaned tool result). */
export function trimHistory(messages: AssistantMessage[]): AssistantMessage[] {
  if (messages.length <= MAX_HISTORY) return messages;
  let start = messages.length - MAX_HISTORY;
  while (start < messages.length && !(messages[start]!.role === "user" && typeof messages[start]!.content === "string")) start++;
  return messages.slice(start);
}

/** Questions per member per day: the platform admin's setting for this workspace, else the server default. */
async function dailyLimit(db: { query: (sql: string) => Promise<{ rows: { n: number | null }[] }> }): Promise<number> {
  return (await db.query("SELECT tenant_assistant_turns() AS n")).rows[0]?.n ?? config.ASSISTANT_DAILY_TURNS;
}

/** Stored history keeps questions, answers and file results; large data results are dropped (tools can re-read them). */
export function compact(messages: AssistantMessage[]): AssistantMessage[] {
  return messages.map((m) => (m.role === "user" && Array.isArray(m.content)
    ? { ...m, content: m.content.map((b) => (b.type === "tool_result" && typeof b.content === "string" && b.content.length > 8000 ? { ...b, content: "{\"omitted\":\"large result, read again if needed\"}" } : b)) }
    : m));
}

/** What the chat UI shows for a stored transcript: questions, answers and the files produced. */
export function toDisplay(messages: AssistantMessage[]) {
  const out: { role: "user" | "assistant"; text: string; files: { id: string; filename: string; format: string; rows: number }[] }[] = [];
  for (const m of messages) {
    if (m.role === "user" && typeof m.content === "string") { out.push({ role: "user", text: m.content, files: [] }); continue; }
    let last = out[out.length - 1];
    if (!last || last.role !== "assistant") { last = { role: "assistant", text: "", files: [] }; out.push(last); }
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content) if (b.type === "text") last.text += (last.text ? "\n\n" : "") + b.text;
    } else if (m.role === "user" && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type !== "tool_result" || typeof b.content !== "string") continue;
        try { const r = JSON.parse(b.content) as { fileId?: string; filename?: string; format?: string; rows?: number }; if (r.fileId) last.files.push({ id: r.fileId, filename: r.filename ?? "", format: r.format ?? "", rows: r.rows ?? 0 }); } catch { /* data result */ }
      }
    }
  }
  return out;
}

export default async function assistantRoutes(app: FastifyInstance) {
  app.get("/assistant/status", { preHandler: requireTenant("assistant.use") }, async (req) => {
    const perms = req.tenant!.permissions;
    const { used, limit } = await tenantTx(req, async (db) => ({
      used: (await db.query<{ turns: number }>("SELECT turns FROM assistant_usage WHERE day = $1::date AND user_id = app_user_id()", [today()])).rows[0]?.turns ?? 0,
      limit: await dailyLimit(db),
    }), { readOnly: true });
    return {
      configured: model() !== null,
      engine: engineName(),
      usedToday: used, dailyLimit: limit,
      scope: scopeAreas(perms),
      suggestions: SUGGESTIONS.filter(([p]) => perms.includes(p as never)).map(([, s]) => s).slice(0, 4),
    };
  });

  app.get("/assistant/conversations", { preHandler: requireTenant("assistant.use") }, async (req) =>
    tenantTx(req, async (db) => ({
      items: (await db.query(`SELECT id, title, updated_at AS "updatedAt" FROM assistant_conversations ORDER BY updated_at DESC LIMIT 50`)).rows,
    }), { readOnly: true }));

  app.get("/assistant/conversations/:id", { preHandler: requireTenant("assistant.use") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const c = (await db.query<{ id: string; title: string; messages: AssistantMessage[] }>("SELECT id, title, messages FROM assistant_conversations WHERE id = $1", [id])).rows[0];
      if (!c) throw notFound("المحادثة غير موجودة");
      return { id: c.id, title: c.title, messages: toDisplay(c.messages) };
    }, { readOnly: true });
  });

  app.delete("/assistant/conversations/:id", { preHandler: requireTenant("assistant.use") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    await tenantTx(req, async (db) => {
      const r = await db.query("DELETE FROM assistant_conversations WHERE id = $1", [id]);
      if (!r.rowCount) throw notFound("المحادثة غير موجودة");
    });
    return { ok: true };
  });

  app.get("/assistant/exports/:id", { preHandler: requireTenant("assistant.use") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const f = await tenantTx(req, async (db) =>
      (await db.query<{ filename: string; mime: string; content: Buffer }>("SELECT filename, mime, content FROM assistant_exports WHERE id = $1 AND expires_at > now()", [id])).rows[0],
    { readOnly: true });
    if (!f) throw notFound("الملف غير موجود أو انتهت صلاحيته. اطلبه من المساعد مرة أخرى");
    return reply
      .header("content-type", f.mime)
      .header("content-disposition", `attachment; filename="report"; filename*=UTF-8''${encodeURIComponent(f.filename)}`)
      .header("cache-control", "private, no-store")
      .send(f.content);
  });

  app.post("/assistant/chat", { preHandler: requireTenant("assistant.use"), config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = z.object({
      conversationId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
      message: z.string().trim().min(1, "اكتب سؤالك").max(4000, "السؤال طويل جداً"),
    }).parse(req.body);
    const m = model();
    if (!m) throw new AppError(503, "assistant_not_configured", "المساعد الذكي غير مفعّل بعد. يلزم إعداد مفتاح Claude API على الخادم");

    // Quota first (also fails for a non-operational workspace: every write does). The limit is the platform
    // admin's per-workspace setting, or the server default.
    const { turns, limit } = await tenantTx(req, async (db) => {
      const limit = await dailyLimit(db);
      if (limit === 0) return { turns: 0, limit };
      const turns = (await db.query<{ turns: number }>(
        `INSERT INTO assistant_usage (tenant_id, user_id, day, turns) VALUES (app_tenant_id(), app_user_id(), $1::date, 1)
         ON CONFLICT (tenant_id, user_id, day) DO UPDATE SET turns = assistant_usage.turns + 1 RETURNING turns`, [today()])).rows[0]!.turns;
      return { turns, limit };
    });
    if (limit === 0) throw new AppError(403, "assistant_disabled", "المساعد الذكي موقوف لهذه المنشأة من إدارة المنصة");
    if (turns > limit) {
      await tenantTx(req, (db) => db.query("UPDATE assistant_usage SET turns = turns - 1 WHERE day = $1::date AND user_id = app_user_id()", [today()]));
      throw new AppError(429, "assistant_quota", `وصلت إلى الحد اليومي للمساعد (${limit} سؤالاً). يتجدد غداً`);
    }

    const { history, companyName } = await tenantTx(req, async (db) => {
      const company = (await db.query<{ company_name: string }>("SELECT company_name FROM tenants")).rows[0]?.company_name ?? "";
      if (!body.conversationId) return { history: [] as AssistantMessage[], companyName: company };
      const c = (await db.query<{ messages: AssistantMessage[] }>("SELECT messages FROM assistant_conversations WHERE id = $1", [body.conversationId])).rows[0];
      if (!c) throw notFound("المحادثة غير موجودة");
      return { history: c.messages, companyName: company };
    }, { readOnly: true });

    // From here the response is a server-sent event stream.
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    const send = (e: AssistantEvent | { type: "done"; conversationId: string; title: string } | { type: "error"; message: string }) => {
      if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    const abort = new AbortController();
    req.raw.on("close", () => { if (!reply.raw.writableEnded) abort.abort(); });

    try {
      const tenant = req.tenant!;
      const result = await runTurn({
        app, req, model: m, companyName, audience: "tenant",
        tools: allowedTools(tenant.permissions), allowed: (d) => tenant.permissions.includes(d.permission as Permission), headers: { "x-tenant-id": tenant.id },
        userName: req.auth!.fullName, roleLabel: tenant.role === "custom" ? tenant.roleName ?? "دور مخصص" : ROLE_AR[tenant.role] ?? tenant.role,
        today: today(), history, userText: body.message, emit: send, signal: abort.signal,
        saveExport: (f: BuiltFile) => tenantTx(req, async (db) => (await db.query<{ id: string }>(
          `INSERT INTO assistant_exports (tenant_id, user_id, filename, mime, content, row_count) VALUES (app_tenant_id(), app_user_id(), $1, $2, $3, $4) RETURNING id`,
          [f.filename, f.mime, f.content, f.rows])).rows[0]!.id),
      });
      const saved = await tenantTx(req, async (db) => {
        const messages = JSON.stringify(compact(trimHistory(result.messages)));
        const title = body.message.replace(/\s+/g, " ").slice(0, 60);
        const row = body.conversationId
          ? (await db.query<{ id: string; title: string }>("UPDATE assistant_conversations SET messages = $2 WHERE id = $1 RETURNING id, title", [body.conversationId, messages])).rows[0]!
          : (await db.query<{ id: string; title: string }>(
              "INSERT INTO assistant_conversations (tenant_id, user_id, title, messages) VALUES (app_tenant_id(), app_user_id(), $1, $2) RETURNING id, title", [title, messages])).rows[0]!;
        await db.query("UPDATE assistant_usage SET tool_calls = tool_calls + $2, input_tokens = input_tokens + $3, output_tokens = output_tokens + $4 WHERE day = $1::date AND user_id = app_user_id()",
          [today(), result.usage.toolCalls, result.usage.input, result.usage.output]);
        await auditTenant(db, req, "assistant.turn", "assistant_conversation", row.id, { tools: result.used });
        return row;
      });
      send({ type: "done", conversationId: saved.id, title: saved.title });
    } catch (err) {
      req.log.warn({ err }, "assistant turn failed");
      send({ type: "error", message: errorMessage(err, abort.signal.aborted) });
    } finally {
      reply.raw.end();
    }
  });
}

export function errorMessage(err: unknown, aborted: boolean): string {
  if (aborted) return "أُوقف الرد.";
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return "مفتاح Claude API على الخادم غير صالح. تواصل مع مدير المنصة.";
  if (err instanceof Anthropic.RateLimitError) return "المساعد مشغول الآن. حاول بعد دقيقة.";
  if (err instanceof Anthropic.APIConnectionError) return "تعذر الاتصال بخدمة المساعد. تحقق من الاتصال وحاول مرة أخرى.";
  if (err instanceof Anthropic.APIError) return "تعذر إكمال الرد من خدمة المساعد. حاول مرة أخرى.";
  if (err instanceof AppError) return err.message;
  return "حدث خطأ أثناء إعداد الرد. حاول مرة أخرى.";
}
