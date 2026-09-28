import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { systemPool, withSystemTx } from "../db/pool.ts";
import { ADMIN_TOOLS } from "../lib/assistant/admin-tools.ts";
import { runTurn, type AssistantEvent, type AssistantMessage, type BuiltFile } from "../lib/assistant/engine.ts";
import { AppError, notFound } from "../lib/errors.ts";
import { auditSystem, isUuid, requireAdmin } from "../plugins/auth.ts";
import { compact, engineName, errorMessage, model, today, toDisplay, trimHistory } from "./assistant.ts";

const SUGGESTIONS = [
  "ما أهم المشاكل والفرص في المنصة الآن؟",
  "ما الاشتراكات التي تنتهي خلال 30 يوماً؟",
  "ما الإيراد الشهري المتكرر وتوزيعه على الباقات؟",
  "ما المنشآت القريبة من حدود باقتها؟",
];

/**
 * The platform administrator's assistant. Same engine and guarantees as the workspace assistant, with the admin
 * API as its only reach: every read runs as this admin through requireAdmin. Conversations and files belong to
 * the admin who created them; no workspace's internal data is reachable (support sessions remain the only way).
 */
export default async function adminAssistantRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAdmin);

  app.get("/assistant/status", async () => ({
    configured: model() !== null,
    engine: engineName(),
    usedToday: 0, dailyLimit: null,
    scope: ["المنشآت والاشتراكات", "الباقات والقطاعات", "المستخدمون", "استهلاك الحدود", "التقارير المالية والتشغيلية", "سجل التدقيق", "قائمة الانتظار"],
    suggestions: SUGGESTIONS,
  }));

  app.get("/assistant/conversations", async (req) => ({
    items: (await systemPool.query(`SELECT id, title, updated_at AS "updatedAt" FROM admin_assistant_conversations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 50`, [req.auth!.id])).rows,
  }));

  app.get("/assistant/conversations/:id", async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const c = (await systemPool.query<{ id: string; title: string; messages: AssistantMessage[] }>(
      "SELECT id, title, messages FROM admin_assistant_conversations WHERE id = $1 AND user_id = $2", [id, req.auth!.id])).rows[0];
    if (!c) throw notFound("المحادثة غير موجودة");
    return { id: c.id, title: c.title, messages: toDisplay(c.messages) };
  });

  app.delete("/assistant/conversations/:id", async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const r = await systemPool.query("DELETE FROM admin_assistant_conversations WHERE id = $1 AND user_id = $2", [id, req.auth!.id]);
    if (!r.rowCount) throw notFound("المحادثة غير موجودة");
    return { ok: true };
  });

  app.get("/assistant/exports/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const f = (await systemPool.query<{ filename: string; mime: string; content: Buffer }>(
      "SELECT filename, mime, content FROM admin_assistant_exports WHERE id = $1 AND user_id = $2 AND expires_at > now()", [id, req.auth!.id])).rows[0];
    if (!f) throw notFound("الملف غير موجود أو انتهت صلاحيته. اطلبه من المساعد مرة أخرى");
    return reply
      .header("content-type", f.mime)
      .header("content-disposition", `attachment; filename="report"; filename*=UTF-8''${encodeURIComponent(f.filename)}`)
      .header("cache-control", "private, no-store")
      .send(f.content);
  });

  app.post("/assistant/chat", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = z.object({
      conversationId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
      message: z.string().trim().min(1, "اكتب سؤالك").max(4000, "السؤال طويل جداً"),
    }).parse(req.body);
    const m = model();
    if (!m) throw new AppError(503, "assistant_not_configured", "المساعد الذكي غير مفعّل بعد");
    const admin = req.auth!;
    let history: AssistantMessage[] = [];
    if (body.conversationId) {
      const c = (await systemPool.query<{ messages: AssistantMessage[] }>(
        "SELECT messages FROM admin_assistant_conversations WHERE id = $1 AND user_id = $2", [body.conversationId, admin.id])).rows[0];
      if (!c) throw notFound("المحادثة غير موجودة");
      history = c.messages;
    }

    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    const send = (e: AssistantEvent | { type: "done"; conversationId: string; title: string } | { type: "error"; message: string }) => {
      if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    const abort = new AbortController();
    req.raw.on("close", () => { if (!reply.raw.writableEnded) abort.abort(); });

    try {
      const result = await runTurn({
        app, req, model: m, audience: "platform", companyName: "منصة مُنَسِّق",
        // Re-checked on every call: the account must still be a platform admin.
        tools: ADMIN_TOOLS, allowed: () => admin.isPlatformAdmin === true, headers: {},
        userName: admin.fullName, roleLabel: "مدير المنصة",
        today: today(), history, userText: body.message, emit: send, signal: abort.signal,
        saveExport: async (f: BuiltFile) => (await systemPool.query<{ id: string }>(
          "INSERT INTO admin_assistant_exports (user_id, filename, mime, content, row_count) VALUES ($1, $2, $3, $4, $5) RETURNING id",
          [admin.id, f.filename, f.mime, f.content, f.rows])).rows[0]!.id,
      });
      const saved = await withSystemTx(async (db) => {
        const messages = JSON.stringify(compact(trimHistory(result.messages)));
        const title = body.message.replace(/\s+/g, " ").slice(0, 60);
        const row = body.conversationId
          ? (await db.query<{ id: string; title: string }>("UPDATE admin_assistant_conversations SET messages = $3 WHERE id = $1 AND user_id = $2 RETURNING id, title", [body.conversationId, admin.id, messages])).rows[0]!
          : (await db.query<{ id: string; title: string }>("INSERT INTO admin_assistant_conversations (user_id, title, messages) VALUES ($1, $2, $3) RETURNING id, title", [admin.id, title, messages])).rows[0]!;
        await auditSystem(db, req, null, "assistant.turn", "admin_assistant_conversation", row.id, { tools: result.used });
        return row;
      });
      send({ type: "done", conversationId: saved.id, title: saved.title });
    } catch (err) {
      req.log.warn({ err }, "admin assistant turn failed");
      send({ type: "error", message: errorMessage(err, abort.signal.aborted) });
    } finally {
      reply.raw.end();
    }
  });
}
