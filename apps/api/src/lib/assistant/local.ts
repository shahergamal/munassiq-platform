import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { AssistantMessage, ModelClient } from "./engine.ts";
import { buildPlatformInsights, PLATFORM_INTENTS, type Helpers } from "./local-platform.ts";
import { bare, defaultPeriod, fmt, has, hasFuzzy, normalize, parsePeriod, shiftDays, table, text, variants, type Period, type Text } from "./arabic.ts";

/**
 * The built-in assistant engine: free, runs inside the API, no external model. It plays the same role as Claude
 * in the engine loop, so it gets exactly the same guarantees: it can only call the tools the member's
 * permissions offer, every call is re-checked and run AS the member (RLS, tenant header), and files are built
 * by the server from the database. What it adds is Arabic understanding: intent scoring over a domain lexicon,
 * periods, entities, statuses and export formats, then answers and a rule-based diagnosis written from the data.
 */

type Data = any; // a tool's JSON result, as the endpoint returned it
type ExportFormat = "xlsx" | "csv" | "pdf" | "doc";
interface Call { name: string; input: Record<string, unknown> }
interface Result { name: string; input: Record<string, unknown>; ok: boolean; data: Data; error?: string }
interface Env { company: string; user: string; role: string; today: string }

interface Q {
  t: Text;
  /** The platform administrator's assistant (admin tools offered) rather than a workspace member's. */
  platform: boolean;
  /** A file format the engine cannot produce (PowerPoint, image...). */
  unsupported: string | null;
  env: Env;
  offered: Set<string>;
  period: Period | null;
  /** The period to use: the one asked for, or the last 30 days. */
  p: Period;
  format: ExportFormat | null;
  entity: string;
  /** The name as typed, articles kept ("مطعم الاختبار"): searched first, since stored names keep them too. */
  entityRaw: string;
  number: string | null;
  threshold: number | null;
  topN: number | null;
}

interface Plan {
  /** Stage 0 is the first set of reads; later stages may depend on earlier results (look up a name, then its detail). */
  stages: ((r: Result[]) => Call[])[];
  answer: (r: Result[]) => string;
  /** The list read a file can be built from, when the member asks for Excel/CSV/PDF. */
  file?: { source: string; input: Record<string, unknown>; title: string };
  /** Title for a file made from the answer itself (reports, diagnosis). */
  title?: string;
}

type Area = "general" | "catalog" | "stock" | "purchases" | "recipes" | "sales" | "expenses" | "contracting" | "platform";
interface Intent {
  id: string;
  area: Area;
  /** Arabic name of the data, for "outside your permissions". */
  what: string;
  words: [string, number][];
  /** A generic intent steps aside when a more specific one of the same area is also asked. */
  weak?: boolean;
  build: (q: Q) => Plan | null;
  example?: string;
}

// ── Engine ────────────────────────────────────────────────────────────────────────────────────
const MAX_STAGES = 5;

export function localModel(): ModelClient {
  return {
    // Results stay inside the server, so the engine reads whole pages rather than the model-sized cut.
    limits: { rows: 100, chars: 600_000 },
    documents: true,
    async run(req, onText) {
      const offered = new Set(req.tools.map((t) => t.name));
      const env = readEnv(req.system.map((b) => b.text).join("\n"));
      const msgs = req.messages;
      let i = msgs.length - 1;
      while (i >= 0 && !(msgs[i]!.role === "user" && typeof msgs[i]!.content === "string")) i--;
      const question = i >= 0 ? (msgs[i]!.content as string) : "";
      const { results, lastStage } = collect(msgs.slice(i + 1));
      const turn = decide(question, msgs.slice(0, Math.max(i, 0)), env, offered);
      if ("reply" in turn) return say(turn.reply, onText);
      // Stages that need nothing (the first spelling already matched) are skipped.
      for (let stage = lastStage + 1; stage < Math.min(turn.stages.length, MAX_STAGES); stage++) {
        const calls = turn.stages[stage]!(results);
        if (calls.length) return useTools(calls, stage);
      }
      return say(turn.answer(results) + fileNote(results), onText);
    },
  };
}

function readEnv(system: string): Env {
  const today = /Today \(Riyadh\): (\d{4}-\d{2}-\d{2})/.exec(system)?.[1] ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh" }).format(new Date());
  const who = /User: (.+?) \(role: (.+?)\)/.exec(system);
  return { company: /Workspace: (.+)/.exec(system)?.[1]?.trim() ?? "منشأتك", user: who?.[1] ?? "", role: who?.[2] ?? "", today };
}

const message = (content: object[], stop: "end_turn" | "tool_use") =>
  ({ id: `msg_local_${randomUUID()}`, type: "message", role: "assistant", model: "munassiq-local", content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }) as unknown as Anthropic.Beta.BetaMessage;

function say(answer: string, onText: (d: string) => void) {
  onText(answer);
  return message([{ type: "text", text: answer, citations: null }], "end_turn");
}
function useTools(calls: Call[], stage: number) {
  return message(calls.map((c) => ({ type: "tool_use", id: `toolu_local_s${stage}_${randomUUID().replace(/-/g, "").slice(0, 16)}`, name: c.name, input: c.input })), "tool_use");
}

/** Pairs each tool call of this turn with its result. */
function collect(after: AssistantMessage[]) {
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  const results: Result[] = [];
  let lastStage = -1;
  for (const m of after) {
    if (!Array.isArray(m.content)) continue;
    if (m.role === "assistant") {
      for (const b of m.content) {
        if (b.type !== "tool_use") continue;
        calls.set(b.id, { name: b.name, input: (b.input ?? {}) as Record<string, unknown> });
        lastStage = Math.max(lastStage, Number(/^toolu_local_s(\d+)_/.exec(b.id)?.[1] ?? lastStage + 1));
      }
    } else {
      for (const b of m.content) {
        if (b.type !== "tool_result") continue;
        const call = calls.get(b.tool_use_id);
        if (!call) continue;
        const raw = typeof b.content === "string" ? b.content : "";
        if (b.is_error) { results.push({ ...call, ok: false, data: null, error: arabicError(raw) }); continue; }
        try { results.push({ ...call, ok: true, data: JSON.parse(raw) }); } catch { results.push({ ...call, ok: false, data: null, error: "النتيجة أكبر من المسموح. اطلب فترة أقصر." }); }
      }
    }
  }
  return { results, lastStage };
}

const arabicError = (e: string) =>
  /permission/i.test(e) ? "خارج صلاحياتك" : /not found/i.test(e) ? "غير موجود" : /invalid/i.test(e) ? "طلب غير صالح" : e;

function fileNote(results: Result[]) {
  const f = results.filter((r) => r.name === "create_file" || r.name === "create_document");
  if (!f.length) return "";
  return f.map((r) => r.ok && r.data?.fileId
    ? `\n\nجهّزت الملف **${r.data.filename}** (${r.data.rows} صف) من قاعدة البيانات مباشرة. تجده أسفل هذه الرسالة.`
    : `\n\nتعذّر تجهيز الملف: ${r.error ?? "خطأ غير متوقع"}.`).join("");
}

// ── Understanding the question ────────────────────────────────────────────────────────────────
const STOP = new Set([
  "كم", "كام", "بكام", "ما", "ماذا", "ماهو", "ماهي", "هو", "هي", "ايه", "ايش", "وش", "شو", "هل", "في", "فى", "من", "منين", "الي", "الى", "لي", "على", "علي", "عن", "عند", "عندي", "عندنا", "لدي", "لدينا", "لنا",
  "انا", "احنا", "نحن", "انت", "هذا", "هذه", "هذي", "ده", "دي", "دا", "اللي", "الي", "الذي", "التي", "الذين", "هات", "اعطني", "اديني", "عاوز", "عايز", "اريد", "ابغي", "ابغى", "ابي", "بدي", "ممكن", "لو",
  "سمحت", "فضلك", "رجاء", "قولي", "قلي", "اعرف", "اعرض", "اظهر", "وريني", "ورني", "شوف", "كيف", "ازاي", "ليه", "لماذا", "مع", "او", "ثم", "كل", "جميع", "اي", "اى", "حاليا", "الان", "دلوقتي",
  "كده", "كذا", "بتاع", "بتاعه", "بتاعت", "تبع", "الخاص", "الخاصه", "قد", "رقم", "تقرير", "تقارير", "بيانات", "معلومات", "تفاصيل", "قائمه", "ليست", "اجمالي", "مجموع", "عدد", "ملخص", "لخص",
  "موجود", "موجوده", "متوفر", "يوجد", "فيه", "فيها", "كان", "كانت", "يكون", "تكون", "صار", "بقي", "بقى", "مازال", "لسه", "لسا", "طيب", "تمام", "اوك", "لو", "يا", "ياريت", "اهم", "افضل", "اكثر", "اقل",
  "حسب", "بحسب", "لكل", "كلها", "كله", "بس", "فقط", "ايضا", "كمان", "برضه", "نفس", "ماذا", "بخصوص", "بالنسبه", "حول", "تاني", "اخري", "اخرى", "جديد", "قديم", "المطعم", "مطعمي", "مطعمنا", "شركتي",
  "شركتنا", "المنشاه", "ايها", "ايهم", "ايهما", "منها", "منهم", "حساب", "مواد", "ماده", "خام", "خامات", "تتجاوز", "تزيد", "تتعدي", "فوق", "اكبر", "اعلي", "نسبه", "نسبتها", "نسبته", "تكلفه", "تكلفتها", "تكلفته", "التي", "الي", "منشاتي", "محلي", "المحل", "محلنا", "الشركه", "احتاج", "محتاج", "نحتاج", "يحتاج", "اطلب", "لاعاده", "اعاده", "صار", "حصل", "يعني", "جدا", "كثير", "قليل", "مره",
]);

const FORMAT_RE: [RegExp, ExportFormat][] = [
  [/(csv|سي اس في)/, "csv"],
  [/(pdf|بي دي اف|بي دي ف|طباعه|اطبع|للطباعه|مطبوع)/, "pdf"],
  [/(^| )(word|وورد|ورد|docx|doc|مستند)( |$)/, "doc"],
  [/(اكسل|اكسيل|excel|xlsx|شيت|sheet|جدول بيانات)/, "xlsx"],
];
const UNSUPPORTED_RE = /(^| )(باوربوينت|بوربوينت|بور بوينت|powerpoint|pptx|صوره|png|jpg|jpeg)( |$)/;
/** Words that only ask for a file ("export it", "send it to me"): never part of a name. */
const EXPORT_WORD = /^(صدر|صدره|صدرها|صدرلي|صدرهولي|صدرهالي|تصدير|نزل|نزله|نزلها|نزللي|نزلهولي|تنزيل|حمل|حمله|حملها|حمللي|تحميل|ملف|ملفات|ابعت|ابعته|ابعتها|ابعتلي|ابعتهولي|ابعتهالي|ارسل|ارسله|ارسلها|ارسلي|حوله|حولها|حولهولي|حولها لي|اطبع|اطبعه|اطبعها|اطبعلي|اعمل|اعملي|اعمللي|اعملهولي|جهز|جهزلي|جهزه|حضر|حضرلي|طلع|طلعلي|طلعه|اطلع|اطلعه|بصيغه|صيغه|بصيغة|نسخه|export|download|اكسل|اكسيل|excel|xlsx|csv|pdf|شيت|sheet|word|وورد|ورد|docx|doc|مستند|بي|دي|اف|سي|اس|طباعه|للطباعه)$/;
const EXPORT_VERBS = /(^| )(صدر|صدره|صدرها|صدرلي|صدرهولي|صدرهالي|تصدير|نزل|نزله|نزلها|نزللي|نزلهولي|تنزيل|حمل|حمله|حملها|حمللي|تحميل|ملف|ابعت|ابعته|ابعتها|ابعتلي|ابعتهولي|ابعتهالي|ارسل|ارسله|ارسلها|حوله|حولها|حولهولي|export|download)( |$)/;

function makeQ(raw: string, env: Env, offered: Set<string>): Q {
  const t = text(raw);
  const period = parsePeriod(t, env.today);
  let format: ExportFormat | null = null;
  for (const [re, f] of FORMAT_RE) if (re.test(t.norm)) { format = f; break; }
  const named = format !== null;
  if (!format && EXPORT_VERBS.test(t.norm)) format = "xlsx";
  const platform = [...offered].some((n) => n.startsWith("platform_"));
  // "export it as PowerPoint": say so, rather than quietly sending Excel. A named supported format wins.
  const unsupported = named ? null : UNSUPPORTED_RE.exec(t.norm)?.[2] ?? null;
  const pct = /(\d+(?:\.\d+)?)\s*%|(\d+(?:\.\d+)?)\s*(بالمي|في الميه|بالمئه|في المئه)/.exec(t.norm);
  const top = /(اهم|افضل|اعلي|اكثر|اقل|اسوا|اول)\s*(\d+|ثلاث|ثلاثه|تلات|تلاته|خمس|خمسه|عشر|عشره)/.exec(t.norm);
  const words: Record<string, number> = { "ثلاث": 3, "ثلاثه": 3, "تلات": 3, "تلاته": 3, "خمس": 5, "خمسه": 5, "عشر": 10, "عشره": 10 };
  return {
    t, env, offered, platform, unsupported, period, p: period ?? defaultPeriod(env.today), format,
    entity: entityOf(raw),
    entityRaw: entityOf(raw, true),
    number: /(?:رقم|#|no\.?)\s*(\d{1,10})/i.exec(normalize(raw))?.[1] ?? null,
    threshold: pct ? Number(pct[1] ?? pct[2]) : null,
    topN: top ? Number(top[2]) || words[top[2]!] || null : null,
  };
}

let KEYWORDS: string[] = [];
const isKeyword = (w: string) => variants(w).some((v) => STOP.has(v) || KEYWORDS.some((k) => (k.length >= 3 ? v.startsWith(k) : v === k)));
/** A word the engine already understands as written: it is never "corrected" into another keyword. */
const isKnownWord = (w: string) => isKeyword(w) || TIME_WORDS.has(w);

/** What the question names (an ingredient, supplier, recipe…): the words left after intent, time and filler words. */
function entityOf(raw: string, keepArticle = false): string {
  const out: string[] = [];
  for (const tok of raw.split(/[\s،,؟?!.:;()«»"']+/)) {
    const n = normalize(tok);
    if (n.length < 2 || /^\d/.test(n) || isKeyword(n) || TIME_WORDS.has(n) || variants(n).some((v) => EXPORT_WORD.test(v))) continue;
    const word = keepArticle ? tok.replace(/^(و|ب|ف|ك)(?=ال\S{2,})/, "") : tok.replace(/^(وبال|وال|بال|فال|كال|لل|ال)(?=\S{2,})/, "");
    out.push(word.replace(/^[ً-ٟ]+|[ً-ٟ]+$/g, ""));
  }
  return out.join(" ").slice(0, 60).trim();
}
const TIME_WORDS = new Set(["اليوم", "النهارده", "انهارده", "امس", "امبارح", "البارحه", "اسبوع", "الاسبوع", "شهر", "الشهر", "سنه", "السنه", "العام", "يوم", "ايام", "اسابيع", "شهور", "اشهر",
  "الماضي", "الماضيه", "فات", "فاتت", "السابق", "السابقه", "الحالي", "الحاليه", "اخر", "خلال", "يومين", "اسبوعين", "شهرين", "يناير", "فبراير", "مارس", "ابريل", "مايو", "يونيو", "يوليو", "اغسطس",
  "سبتمبر", "اكتوبر", "نوفمبر", "ديسمبر", "قبله", "قبلها", "بعده", "الفايت", "هذا", "ده"]);

/** Sum of matched keyword weights; a keyword contained in a longer matched one ("مبيع" in "مبيعات") counts once. */
function score(it: Intent, t: Text) {
  const hit = new Map<string, number>();
  for (const [w, n] of it.words) {
    // An exact word counts fully; a one-letter slip ("مبيغات") counts a little less, so a correct word always wins.
    const weight = has(t, w) ? n : hasFuzzy(t, w, isKnownWord) ? Math.max(1, n - 1) : 0;
    if (weight) { const k = normalize(w).split(" ").map(bare).join(" "); hit.set(k, Math.max(weight, hit.get(k) ?? 0)); }
  }
  return [...hit].filter(([w]) => ![...hit.keys()].some((o) => o !== w && o.includes(w))).reduce((s, [, n]) => s + n, 0);
}

/** A file title from the question, without the words that only asked for the file. */
function titleOf(question: string) {
  const words = question.split(/[\s،,؟?!.:;]+/).filter((w) => w && !variants(normalize(w)).some((v) => EXPORT_WORD.test(v) || STOP.has(v)));
  return words.join(" ").slice(0, 60) || "تقرير";
}

function decide(question: string, history: AssistantMessage[], env: Env, offered: Set<string>): Plan | { reply: string } {
  const q = makeQ(question, env, offered);
  if (q.unsupported) return { reply: `لا أستطيع إنشاء ملف بصيغة ${q.unsupported}. أستطيع تجهيز التقارير بصيغة Excel أو CSV أو PDF أو Word. اطلب مثلاً: «صدّر مستحقات الموردين PDF».` };
  let picked = pick(q);
  if (!picked.plans.length && !picked.denied.length) {
    // A follow-up: "and last month?", "export it", "and the onions?" reuses the previous question's subject.
    const prev = previousQuestion(history);
    const followUp = q.period || q.format || (q.entity && /^(و|طيب|بالنسبه|وماذا|وايه|وايش|وكم|وكام)/.test(q.t.norm));
    if (prev && followUp) {
      const pq = makeQ(prev, env, offered);
      const merged = { ...pq, period: q.period ?? pq.period, p: q.period ?? pq.p, format: q.format, entity: q.entity && !q.format ? q.entity : pq.entity, entityRaw: q.entity && !q.format ? q.entityRaw : pq.entityRaw, number: q.number ?? pq.number, threshold: q.threshold ?? pq.threshold };
      picked = { ...pick(merged), format: q.format };
      question = prev;
    }
  }
  if (!picked.plans.length) {
    if (picked.denied.length) return { reply: deniedReply(picked.denied, env, q.platform) };
    return { reply: didYouMean(q) ?? offTopicReply(q) };
  }
  const plans = picked.plans;
  const deniedNote = picked.denied.length ? `\n\n> ملاحظة: ${[...new Set(picked.denied.map((d) => d.what))].join("، ")} خارج صلاحيات دورك، فلم أطّلع عليها.` : "";
  const fmtAsked = q.format ?? picked.format ?? null;
  const withFile = (p: Plan): Plan => {
    if (!fmtAsked) return p;
    const format = fmtAsked;
    if (!p.file || !offered.has("create_file") || !offered.has(p.file.source)) {
      // Reports, statements and the diagnosis: the file is the answer itself, which the server computed from the data.
      if (!offered.has("create_document")) return { ...p, answer: (r) => `${p.answer(r)}\n\nهذا التقرير يُعرض هنا فقط ولا يُصدَّر كملف.` };
      const title = (p.title ?? titleOf(question)).slice(0, 100);
      return { ...p, stages: [...p.stages, (r) => [{ name: "create_document", input: { title, format, content: p.answer(r) } }]] };
    }
    const f = p.file;
    const fileStage = (r: Result[]): Call[] => {
      const src = get(r, f.source);
      return src?.ok && rowsOf(src.data).length ? [{ name: "create_file", input: { source: f.source, input: src.input, format, title: f.title.slice(0, 100) } }] : [];
    };
    return { ...p, stages: [...p.stages, fileStage], answer: (r) => p.answer(r) + (get(r, "create_file") ? "" : "\n\nلا توجد بيانات لتصديرها، فلم أجهّز ملفاً.") };
  };
  if (plans.length === 1) { const p = withFile(plans[0]!); return { ...p, answer: (r) => p.answer(r) + deniedNote }; }
  // Several subjects in one question ("sales and expenses this month"): one round of reads, answers in order.
  const merged = plans.map(withFile);
  const depth = Math.max(...merged.map((p) => p.stages.length));
  return {
    stages: Array.from({ length: depth }, (_, k) => (r: Result[]) => merged.flatMap((p) => p.stages[k]?.(r) ?? [])),
    answer: (r) => merged.map((p) => p.answer(r)).join("\n\n---\n\n") + deniedNote,
  };
}

/** The last earlier question that was about some data (greetings and thanks don't count). */
function previousQuestion(history: AssistantMessage[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role !== "user" || typeof m.content !== "string") continue;
    const t = text(m.content);
    if (ALL_INTENTS.some((it) => it.id !== "help" && it.id !== "thanks" && score(it, t) >= 2)) return m.content;
  }
  return null;
}

function pick(q: Q): { plans: Plan[]; denied: Intent[]; format?: ExportFormat | null } {
  // A member never gets platform intents; the admin gets workspace intents only to explain they need a support session.
  let scored = ALL_INTENTS.filter((it) => q.platform || it.area !== "platform")
    .map((it, order) => ({ it, s: score(it, q.t), order })).filter((x) => x.s >= 2).sort((a, b) => b.s - a.s || a.order - b.order);
  if (q.platform && scored.some((x) => x.it.area === "platform" || x.it.area === "general")) scored = scored.filter((x) => x.it.area === "platform" || x.it.area === "general");
  if (!scored.length) return { plans: [], denied: [] };
  const best = scored[0]!.s;
  let chosen = scored.filter((x, i) => i === 0 || x.s >= Math.max(3, best * 0.75)).slice(0, 3).map((x) => x.it);
  if (chosen.length > 1) chosen = chosen.filter((it) => it.id !== "help" && it.id !== "thanks");
  chosen = chosen.filter((it) => !it.weak || !chosen.some((o) => o !== it && !o.weak && o.area === it.area));
  // A diagnosis question absorbs the areas it mentions ("مشاكل المخزون" = the diagnosis, focused on stock).
  const diag = chosen.find((it) => it.id === "insights");
  const focus = new Set(chosen.filter((it) => it.id !== "insights").map((it) => it.area));
  if (diag) chosen = [diag];
  const plans: Plan[] = [];
  const denied: Intent[] = [];
  for (const it of chosen) {
    const p = it.id === "insights" ? (q.platform ? buildPlatformInsights(q, HELPERS) : buildInsights(q, focus)) : it.build(q);
    if (p) plans.push(p); else denied.push(it);
  }
  const multiStage = plans.some((p) => p.stages.length > 1);
  return { plans: multiStage ? plans.slice(0, 1) : plans, denied };
}

function deniedReply(denied: Intent[], env: Env, platform = false) {
  if (platform) return "بيانات المنشآت الداخلية (المبيعات والمخزون والتكاليف والمشتريات) لا يطّلع عليها مدير المنصة من المساعد.\n\nإن احتجتها لدعم عميل، ابدأ جلسة دعم مؤقتة ومدققة من صفحة المنشأة في إدارة المنصة. أما هنا فأجيبك عن المنشآت والاشتراكات والباقات والمستخدمين والإيرادات والتقارير التشغيلية.";
  const what = [...new Set(denied.map((d) => d.what))].join("، ");
  return `${what} خارج صلاحيات دورك${env.role ? ` (${env.role})` : ""}، فلا أستطيع الاطلاع عليها أو الإجابة عنها.\n\nإن كنت تحتاجها في عملك، اطلب من مالك المنشأة إضافة الصلاحية لدورك.`;
}

/**
 * Close to a subject but not clear enough to act on ("الفلوس", "الناقص"): offer the likely subjects as questions
 * the member can copy, instead of refusing.
 */
/** Vague words that point at several subjects: offered as choices, never acted on alone. */
const VAGUE: [string[], string[]][] = [
  [["فلوس", "الفلوس", "مال", "الكاش", "النقديه"], ["sales", "balances", "expenses"]],
  [["حساب", "الحساب", "حسابات", "الحسابات"], ["balances", "statement", "expenses"]],
  [["اكل", "الاكل", "مطبخ", "المطبخ"], ["menu", "recipes", "stock"]],
  [["الناس", "الموظفين", "العمال", "الكاشير"], ["recon", "shifts"]],
  [["الوضع", "الحال", "الدنيا", "الامور", "ماشيه"], ["insights", "sales"]],
];
function didYouMean(q: Q): string | null {
  const hinted = new Set(VAGUE.filter(([ws]) => ws.some((w) => has(q.t, w))).flatMap(([, ids]) => ids));
  const near = ALL_INTENTS.filter((it) => it.id !== "help" && it.id !== "thanks" && (q.platform ? it.area === "platform" || it.area === "general" : it.area !== "platform"))
    .map((it, order) => ({ it, s: score(it, q.t) + (hinted.has(it.id) ? 1 : 0), order })).filter((x) => x.s >= 1).sort((a, b) => b.s - a.s || a.order - b.order);
  const usable = near.filter((x) => (x.it.id === "insights" ? (q.platform ? true : buildInsights(q, new Set())) : x.it.build(q)) !== null);
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const { it } of usable) {
    const label = it.what || "بيانات منشأتك";
    if (seen.has(label)) continue;
    seen.add(label);
    lines.push(`- **${label}**${it.example ? `: مثلاً «${it.example}»` : ""}`);
    if (lines.length === 3) break;
  }
  if (!lines.length) return null;
  return `لم أتأكد تماماً مما تقصد. هل تسأل عن:\n${lines.join("\n")}\n\nأعد صياغة سؤالك باسم الموضوع أو الفترة (اليوم، أمس، هذا الشهر…)، أو انسخ أحد الأمثلة.`;
}

function offTopicReply(q: Q) {
  if (q.platform) return `أنا مساعد إدارة المنصة، وأجيب عن بيانات المنصة فقط ضمن صلاحياتك. لا أجيب عن الأسئلة العامة.\n\nجرّب مثلاً:\n${PLATFORM_INTENTS.filter((i) => i.example).slice(0, 5).map((i) => `- ${i.example}`).join("\n")}`;
  const examples = INTENTS.filter((it) => it.example && (it.id === "insights" ? buildInsights(q, new Set()) : it.build(q))).map((it) => `- ${it.example}`).slice(0, 5);
  return `أنا مساعد «${q.env.company}»، وأجيب فقط عن بيانات منشأتك وتقاريرها ضمن صلاحياتك. لا أجيب عن الأسئلة العامة خارج ذلك.\n\n${examples.length ? `جرّب مثلاً:\n${examples.join("\n")}` : ""}`;
}

// ── Reading results ───────────────────────────────────────────────────────────────────────────
const arr = (v: Data): Data[] => (Array.isArray(v) ? v : v && Array.isArray(v.shown) ? v.shown : []);
const rowsOf = (d: Data): Data[] => (Array.isArray(d) ? d : arr(d?.items));
const totalOf = (d: Data) => (typeof d?.meta?.total === "number" ? d.meta.total : rowsOf(d).length);
const get = (r: Result[], name: string, pred?: (i: Record<string, unknown>) => boolean) => [...r].reverse().find((x) => x.name === name && (!pred || pred(x.input)));
const sum = (rows: Data[], key: string) => rows.reduce((s, x) => s + (typeof x?.[key] === "number" ? x[key] : 0), 0);
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const has1 = (q: Q, tool: string) => q.offered.has(tool);
const range = (q: Q) => ({ from: q.p.from, to: q.p.to });
const failed = (res: Result | undefined, what: string) => (!res ? `لم أتمكن من قراءة ${what}.` : !res.ok ? `تعذّرت قراءة ${what}: ${res.error}.` : null);
const same = (a: string, b: string) => normalize(a).includes(normalize(b)) || normalize(b).includes(normalize(a));

const STATUS: Record<string, string> = {
  draft: "مسودة", approved: "معتمد", received: "مستلم", cancelled: "ملغي", counting: "قيد العد", posted: "مرحّل", completed: "مكتمل", open: "مفتوح", closed: "مغلق",
  pending: "بانتظار الاعتماد", paid: "مدفوع", refunded: "مسترجع", partially_refunded: "مسترجع جزئياً", archived: "مؤرشف", active: "نشط", trial: "تجربة", expired: "منتهٍ", suspended: "موقوف",
};
const CHANNEL: Record<string, string> = { dine_in: "محلي", takeaway: "سفري", delivery: "توصيل", app: "تطبيق توصيل", drive_thru: "من السيارة" };
const REASON: Record<string, string> = { expired: "منتهي الصلاحية", spoiled: "تالف", damaged: "متضرر", prep_error: "خطأ تحضير", overproduction: "إنتاج زائد", other: "أخرى" };
const MOVE: Record<string, string> = { purchase: "شراء", sale: "بيع", refund_return: "إرجاع مبيعات", transfer_out: "تحويل صادر", transfer_in: "تحويل وارد", waste: "هدر", count_adjustment: "تسوية جرد", production_in: "إنتاج وارد", production_out: "استهلاك إنتاج", purchase_return: "مرتجع مشتريات" };
const KIND: Record<string, string> = { purchase: "مشتريات", payment: "دفعة", return: "مرتجع", purchase_return: "مرتجع", opening: "رصيد افتتاحي" };
const tr = (map: Record<string, string>, v: unknown) => (typeof v === "string" ? map[v] ?? v : "—");

type Col = [label: string, key: string | string[], f?: (v: Data, row: Data) => string];
function cell(v: Data, key: string): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "نعم" : "لا";
  if (typeof v === "number") return /total|value|amount|cost|price|balance|sales|revenue|vat|profit|purchases|payments|returns|commission|cash|float/i.test(key) ? fmt.money(v) : fmt.num(v);
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return fmt.date(v);
  if (key === "status") return tr(STATUS, v);
  if (key === "channel") return tr(CHANNEL, v);
  if (key === "reason") return tr(REASON, v);
  if (key === "type") return tr(MOVE, v);
  return String(v);
}
function renderTable(rows: Data[], cols: Col[], limit = 10): string {
  const first = rows[0] ?? {};
  const live = cols.map(([label, key, f]) => [label, (Array.isArray(key) ? key : [key]).find((k) => k in first), f] as const).filter(([, k]) => k !== undefined);
  return table(live.map(([l]) => l), rows.slice(0, limit).map((row) => live.map(([, k, f]) => (f ? f(row[k!], row) : cell(row[k!], k!)))));
}
function listAnswer(title: string, res: Result | undefined, cols: Col[], opts: { empty: string; limit?: number; exportable?: boolean; lead?: (rows: Data[], d: Data) => string } ) {
  const bad = failed(res, title);
  if (bad) return bad;
  const d = res!.data;
  const rows = rowsOf(d);
  if (!rows.length) return opts.empty;
  const total = totalOf(d);
  const limit = opts.limit ?? 10;
  const lead = opts.lead ? opts.lead(rows, d) : `**${title}:** ${fmt.num(total)} ${total === 1 ? "سجل" : "سجلات"}.`;
  const more = total > Math.min(limit, rows.length) ? `\n\nأعرض أول ${Math.min(limit, rows.length)} من ${fmt.num(total)}.${opts.exportable !== false ? " للقائمة كاملة قل: «صدّرها Excel»." : ""}` : "";
  return `${lead}\n\n${renderTable(rows, cols, limit)}${more}`;
}

// ── Intents ───────────────────────────────────────────────────────────────────────────────────
const one = (calls: Call[], answer: (r: Result[]) => string, file?: Plan["file"]): Plan => ({ stages: [() => calls], answer, ...(file ? { file } : {}) });

/** Search by name, trying the common Arabic spelling variants if the first search finds nothing. */
function spellings(e: string): string[] {
  const out = [e];
  if (/ة$/.test(e)) out.push(e.replace(/ة$/, "ه")); else if (/ه$/.test(e)) out.push(e.replace(/ه$/, "ة"));
  if (/^ا/.test(e)) out.push(e.replace(/^ا/, "أ"), e.replace(/^ا/, "إ"));
  if (/^[أإآ]/.test(e)) out.push(e.replace(/^[أإآ]/, "ا"));
  if (e.includes(" ")) out.push(e.split(" ")[0]!);
  return [...new Set(out)].filter((s) => s.length >= 2);
}
/** Names to search, most exact first: as typed, without articles, then spelling variants. */
const candidates = (q: { entity: string; entityRaw: string }) => [...new Set([q.entityRaw, ...spellings(q.entity)].filter((s) => s.length >= 2))].slice(0, 5);

/**
 * The row whose name matches what the user typed best: most of the typed words, then fewest extra words.
 * Null when nothing contains most of the words, so a detail is never shown for the wrong customer or supplier.
 */
function bestMatch(rows: Data[], entity: string, key = "name"): Data | null {
  const words = (s: string) => normalize(s).split(" ").map(bare).filter((w) => w.length >= 2);
  const want = words(entity);
  if (!want.length) return null;
  const need = Math.max(1, Math.ceil(want.length * 0.6));
  const scored = rows.map((r) => {
    const name = words(String(r?.[key] ?? ""));
    const hit = want.filter((w) => name.some((n) => n === w || (w.length >= 3 && n.startsWith(w)))).length;
    return { r, hit, extra: Math.abs(name.length - want.length) };
  }).filter((x) => x.hit >= need).sort((a, b) => b.hit - a.hit || a.extra - b.extra);
  return scored[0]?.r ?? null;
}

function searchStages(tool: string, key: string, base: Record<string, unknown>, entity: string | string[]): ((r: Result[]) => Call[])[] {
  const tries = Array.isArray(entity) ? entity : spellings(entity);
  return tries.map((v, i) => (r: Result[]) => {
    if (i > 0) { const last = get(r, tool); if (!last?.ok || rowsOf(last.data).length) return []; }
    return [{ name: tool, input: { ...base, [key]: v } }];
  });
}

function stockIntent(q: Q): Plan | null {
  if (!has1(q, "stock_levels")) {
    if (!has1(q, "search_ingredients")) return null;
    const stages = q.entity ? searchStages("search_ingredients", "q", {}, candidates(q)) : [() => [{ name: "search_ingredients", input: {} }]];
    return { stages, answer: (r) => ingredientsAnswer(q, get(r, "search_ingredients")), file: { source: "search_ingredients", input: q.entity ? { q: q.entity } : {}, title: "المواد الخام" } };
  }
  const stages = q.entity ? searchStages("stock_levels", "q", {}, candidates(q)) : [() => [{ name: "stock_levels", input: {} }]];
  return { stages, answer: (r) => stockAnswer(q, get(r, "stock_levels")), file: { source: "stock_levels", input: q.entity ? { q: q.entity } : {}, title: q.entity ? `رصيد ${q.entity}` : "رصيد المخزون" } };
}
function stockAnswer(q: Q, res: Result | undefined) {
  const bad = failed(res, "رصيد المخزون");
  if (bad) return bad;
  const rows = rowsOf(res!.data);
  if (q.entity) {
    if (!rows.length) return `لم أجد مادة باسم «${q.entity}» في مخزون ${q.env.company}. تأكد من الاسم، أو اسأل «ما رصيد المخزون؟» لعرض كل المواد.`;
    const names = [...new Set(rows.map((x) => x.name as string))];
    return names.slice(0, 5).map((name) => {
      const lines = rows.filter((x) => x.name === name);
      const unit = lines[0].baseUnit;
      const qty = sum(lines, "quantity");
      const value = sum(lines, "value");
      const low = lines.some((x) => x.belowMin) ? "\n\n⚠️ الرصيد تحت الحد الأدنى في موقع واحد على الأقل. فكّر في طلب شراء." : "";
      if (lines.length === 1) return `رصيد **${name}** في ${lines[0].locationName}: **${fmt.qty(qty, unit)}** بقيمة ${fmt.money(value)} (متوسط التكلفة ${fmt.unitCost(lines[0].avgCost, unit)}).${low}`;
      return `رصيد **${name}**: **${fmt.qty(qty, unit)}** بقيمة ${fmt.money(value)} موزعة على ${lines.length} مواقع:\n\n${table(["الموقع", "الكمية", "القيمة"], lines.map((x) => [x.locationName, fmt.qty(x.quantity, unit), fmt.money(x.value)]))}${low}`;
    }).join("\n\n") + (names.length > 5 ? `\n\nووجدت ${names.length - 5} مواد أخرى تطابق «${q.entity}». اكتب الاسم كاملاً للتحديد.` : "");
  }
  const total = totalOf(res!.data);
  const value = sum(rows, "value");
  const low = rows.filter((x) => x.belowMin).length;
  const sorted = [...rows].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const partial = total > rows.length ? ` (محسوبة على أول ${rows.length} سطر)` : "";
  return `في المخزون **${fmt.num(total)}** سطر (مادة × موقع) بقيمة **${fmt.money(value)}**${partial}.${low ? ` منها **${low}** تحت الحد الأدنى.` : ""}\n\nأعلى المواد قيمة:\n\n${table(["المادة", "الموقع", "الكمية", "القيمة"], sorted.slice(0, 10).map((x) => [x.name, x.locationName, fmt.qty(x.quantity, x.baseUnit), fmt.money(x.value)]))}`;
}
function ingredientsAnswer(q: Q, res: Result | undefined) {
  return listAnswer("المواد الخام", res, [["المادة", "name"], ["الرصيد", "stockQty", (v, row) => fmt.qty(v, row.baseUnit)], ["الحد الأدنى", "minStock", (v, row) => fmt.qty(v, row.baseUnit)], ["متوسط التكلفة", "avgCost", (v, row) => fmt.unitCost(v, row.baseUnit)]],
    { empty: q.entity ? `لم أجد مادة باسم «${q.entity}».` : "لا توجد مواد خام مسجلة بعد." });
}

function lowStockIntent(q: Q): Plan | null {
  if (!has1(q, "search_ingredients")) return null;
  const zero = /(نفد|نفذ|نفدت|خلص|خلصت|خلصان|صفر|منتهي الرصيد|مش موجود|غير متوفر)/.test(q.t.norm) && !/(تحت الحد|الحد الادني|قارب|قربت|ناقص)/.test(q.t.norm);
  const input = { stock: zero ? "zero" : "low" };
  return one([{ name: "search_ingredients", input }], (r) => {
    const res = get(r, "search_ingredients");
    const bad = failed(res, "المواد الخام");
    if (bad) return bad;
    const rows = rowsOf(res!.data);
    if (!rows.length) return zero ? "لا توجد مواد نفد رصيدها. ✅" : "لا توجد مواد تحت الحد الأدنى حالياً. ✅\n\n(المواد التي لم يُحدَّد لها حد أدنى لا تدخل في هذا الفحص.)";
    const total = totalOf(res!.data);
    const head = zero ? `**${total}** مادة نفد رصيدها:` : `**${total}** مادة تحت الحد الأدنى:`;
    const t = table(["المادة", "الرصيد", "الحد الأدنى", "المطلوب للوصول للحد"], rows.slice(0, 15).map((x) => [x.name, fmt.qty(x.stockQty, x.baseUnit), fmt.qty(x.minStock, x.baseUnit), fmt.qty(Math.max(0, (x.minStock ?? 0) - (x.stockQty ?? 0)), x.baseUnit)]));
    return `${head}\n\n${t}\n\nالكمية المقترحة هي الفرق عن الحد الأدنى فقط. أضف فوقها استهلاك فترة التوريد. يمكنك إنشاء أمر شراء من شاشة المشتريات.`;
  }, { source: "search_ingredients", input, title: zero ? "مواد نفد رصيدها" : "مواد تحت الحد الأدنى" });
}

function expiryIntent(q: Q): Plan | null {
  if (!has1(q, "expiry_summary")) return null;
  const expired = /(منتهي|انتهت|خربان|فاسد|expired)/.test(q.t.norm) && !/(قريب|قربت|هتنتهي|تنتهي)/.test(q.t.norm);
  const listInput = { status: expired ? "expired" : "expiring", days: 7 };
  return one([{ name: "expiry_summary", input: { days: 7 } }, ...(has1(q, "list_batches") ? [{ name: "list_batches", input: listInput }] : [])], (r) => {
    const sum = get(r, "expiry_summary");
    const bad = failed(sum, "ملخص الصلاحية");
    if (bad) return bad;
    const d = sum!.data;
    const head = `المنتهي الصلاحية: **${fmt.num(d.expired.count)}** دفعة بقيمة **${fmt.money(d.expired.value)}**. ينتهي خلال 7 أيام: **${fmt.num(d.expiring.count)}** دفعة بقيمة **${fmt.money(d.expiring.value)}**.`;
    const rows = rowsOf(get(r, "list_batches")?.data);
    const t = rows.length ? `\n\n${table(["المادة", "التشغيلة", "الموقع", "ينتهي", "المتبقي", "القيمة"], rows.slice(0, 15).map((x) => [x.ingredientName, x.batchNo, x.locationName, x.expiryDate ?? "—", fmt.qty(x.remaining, x.unit), fmt.money(x.value)]))}` : "";
    const unb = (d.unbatched ?? []).length ? `\n\nمواد تتتبع الصلاحية وعندها رصيد بلا تاريخ: **${fmt.num(d.unbatched.length)}**. سجّل تواريخها من «الصلاحية والدفعات».` : "";
    const tip = d.expired.count ? "\n\nالمنتهي يُتلف ويُسجَّل هدراً من «الصلاحية والدفعات ← إتلاف» حتى لا يُباع ويظهر أثره في التكلفة." : d.expiring.count ? "\n\nاصرف القريب أولاً (النظام يصرفه تلقائياً في البيع والتحويل)، ويمكن عرضه عرضاً خاصاً اليوم." : "";
    return `${head}${t}${unb}${tip}`;
  }, { source: "list_batches", input: listInput, title: expired ? "دفعات منتهية الصلاحية" : "دفعات تنتهي قريباً" });
}

function stockValueIntent(q: Q): Plan | null {
  if (has1(q, "report_stock_valuation")) return one([{ name: "report_stock_valuation", input: {} }], (r) => {
    const res = get(r, "report_stock_valuation");
    const bad = failed(res, "تقييم المخزون");
    if (bad) return bad;
    const d = res!.data;
    const rows = rowsOf(d);
    return `قيمة المخزون الحالية **${fmt.money(d.total)}** بمتوسط التكلفة المرجّح.\n\n${table(["الموقع", "عدد المواد", "القيمة", "تحت الحد"], rows.map((x) => [x.locationName, fmt.num(x.items), fmt.money(x.value), fmt.num(x.belowMin)]))}`;
  }, { source: "report_stock_valuation", input: {}, title: "تقييم المخزون" });
  return stockIntent({ ...q, entity: "" });
}

function movementsIntent(q: Q): Plan | null {
  if (!has1(q, "stock_movements")) return null;
  const n = q.t.norm;
  const type = /هدر|تالف/.test(n) ? "waste" : /مرتجع/.test(n) && /شراء|مورد/.test(n) ? "purchase_return" : /شراء|مشتريات|وارد/.test(n) ? "purchase" : /بيع|مبيعات|صادر/.test(n) ? "sale" : /تحويل/.test(n) ? (/وارد/.test(n) ? "transfer_in" : "transfer_out") : /جرد|تسويه/.test(n) ? "count_adjustment" : /انتاج/.test(n) ? "production_in" : undefined;
  const input = { ...range(q), ...(type ? { type } : {}) };
  return one([{ name: "stock_movements", input }], (r) => listAnswer("حركة المواد", get(r, "stock_movements"), [["التاريخ", "createdAt"], ["النوع", "type"], ["المادة", "ingredientName"], ["الكمية", "quantity", (v, row) => fmt.qty(v, row.unit)], ["القيمة", "value"], ["الموقع", "locationName"]],
    { empty: `لا توجد حركات مخزون ${q.p.label}.`, lead: (rows, d) => {
      const by = new Map<string, number>();
      for (const x of rows) by.set(x.type, (by.get(x.type) ?? 0) + (x.value ?? 0));
      return `**${fmt.num(totalOf(d))}** حركة ${q.p.label}. القيمة حسب النوع: ${[...by].map(([k, v]) => `${tr(MOVE, k)} ${fmt.money(v)}`).join("، ")}.`;
    } }), { source: "stock_movements", input, title: `حركة المواد ${q.p.label}` });
}

function simpleList(tool: string, title: string, cols: Col[], empty: string, input: (q: Q) => Record<string, unknown> = () => ({})) {
  return (q: Q): Plan | null => {
    if (!has1(q, tool)) return null;
    const i = input(q);
    return one([{ name: tool, input: i }], (r) => listAnswer(title, get(r, tool), cols, { empty }), { source: tool, input: i, title });
  };
}

/** What to do about each cause of waste (the first thing a cost controller checks). */
const WASTE_ADVICE: Record<string, string> = {
  expired: "اضبط كميات الطلب على الاستهلاك الفعلي، وفعّل «تتبع الصلاحية» للمواد القابلة للتلف ليُصرف الأقرب انتهاءً أولاً، وراجع «الصلاحية والدفعات» يومياً.",
  spoiled: "راجع درجات حرارة الثلاجات والتخزين، وطبّق الأول دخولاً أول خروجاً على الرفوف.",
  damaged: "ارفض التالف عند الاستلام وسجّل سببه في سند الاستلام، وراجع طريقة التخزين والنقل.",
  prep_error: "وحّد الوصفات وأدوات القياس، ودرّب الفريق على الوصفة المعتمدة.",
  overproduction: "اربط كميات التحضير بمبيعات نفس اليوم من الأسبوع الماضي بدل التقدير.",
  other: "سجّل السبب الحقيقي لكل هدر حتى يظهر مصدره.",
};

function wasteIntent(q: Q): Plan | null {
  if (has1(q, "report_waste_analysis") && !q.format) {
    const days = Math.round((Date.parse(q.p.to) - Date.parse(q.p.from)) / 86_400_000) + 1;
    const prev = { from: shiftDays(q.p.from, -days), to: shiftDays(q.p.from, -1) };
    const calls: Call[] = [{ name: "report_waste_analysis", input: range(q) }, { name: "report_waste_analysis", input: prev }];
    if (has1(q, "report_daily_sales")) calls.push({ name: "report_daily_sales", input: range(q) });
    return one(calls, (r) => {
      const res = get(r, "report_waste_analysis", (i) => i.from === q.p.from);
      const bad = failed(res, "تحليل الهدر");
      if (bad) return bad;
      const d = res!.data;
      const reasons = arr(d.byReason).sort((a: Data, b: Data) => b.value - a.value);
      const items = arr(d.byIngredient).sort((a: Data, b: Data) => b.value - a.value);
      if (!d.total) return `لا يوجد هدر مسجل ${q.p.label}. ✅`;
      const before = get(r, "report_waste_analysis", (i) => i.from === prev.from)?.data?.total;
      const change = typeof before === "number" && before > 0 ? ((d.total - before) / before) * 100 : null;
      const net = sum(rowsOf(get(r, "report_daily_sales")?.data), "netSales");
      const ratio = net > 0 ? (d.total / net) * 100 : null;
      const lines = [`إجمالي الهدر ${q.p.label}: **${fmt.money(d.total)}**${change !== null ? ` (${change >= 0 ? "▲" : "▼"} ${fmt.pct(Math.abs(change))} عن الفترة السابقة المماثلة، ${fmt.money(before)})` : ""}.`];
      if (ratio !== null) lines.push(`يعادل **${fmt.pct(ratio)}** من صافي المبيعات (${fmt.money(net)}). ${ratio > 4 ? "⚠️ أعلى من المعدل المقبول في المطاعم (2% إلى 4%)." : ratio > 2 ? "ضمن المعدل المقبول (2% إلى 4%)، ويمكن خفضه." : "ممتاز، أقل من 2%."}`);
      const top = reasons[0];
      const topItemShare = items.slice(0, 3).reduce((a: number, x: Data) => a + x.value, 0) / d.total * 100;
      return `${lines.join("\n")}

### حسب السبب
${table(["السبب", "السجلات", "القيمة", "النسبة"], reasons.map((x: Data) => [tr(REASON, x.reason), fmt.num(x.records), fmt.money(x.value), fmt.pct((x.value / d.total) * 100)]))}`
        + `

### أكثر المواد هدراً
${table(["المادة", "الكمية", "القيمة"], items.slice(0, 8).map((x: Data) => [x.name, fmt.qty(x.quantity, x.unit), fmt.money(x.value)]))}`
        + `

### ماذا تفعل
- السبب الأكبر **${tr(REASON, top?.reason)}** (${fmt.pct((top?.value ?? 0) / d.total * 100)}): ${WASTE_ADVICE[top?.reason] ?? WASTE_ADVICE.other}`
        + (items.length >= 3 ? `
- أول 3 مواد تمثل ${fmt.pct(topItemShare)} من الهدر: ركّز عليها أولاً (${items.slice(0, 3).map((x: Data) => x.name).join("، ")}).` : "");
    }, { source: "list_waste", input: range(q), title: `تحليل الهدر ${q.p.label}` });
  }
  if (!has1(q, "list_waste")) return null;
  return one([{ name: "list_waste", input: range(q) }], (r) => listAnswer("سجلات الهدر", get(r, "list_waste"), [["التاريخ", "createdAt"], ["السبب", "reason"], ["الموقع", "locationName"], ["المواد", "summary"], ["التكلفة", "totalCost"]],
    { empty: `لا يوجد هدر مسجل ${q.p.label}. ✅`, lead: (rows, d) => `**${fmt.num(totalOf(d))}** سجل هدر ${q.p.label} بتكلفة ${fmt.money(sum(rows, "totalCost"))}.` }), { source: "list_waste", input: range(q), title: `سجلات الهدر ${q.p.label}` });
}

function varianceIntent(q: Q): Plan | null {
  if (!has1(q, "report_stock_variance")) return null;
  return one([{ name: "report_stock_variance", input: range(q) }], (r) => listAnswer("فروقات الجرد", get(r, "report_stock_variance"), [["المادة", ["name", "ingredientName"]], ["الكمية", ["quantity", "varianceQty"], (v, row) => fmt.qty(v, row.unit)], ["القيمة", ["value", "varianceValue"]]],
    { empty: `لا توجد فروقات جرد مرحّلة ${q.p.label}.`, lead: (_rows, d) => `صافي فروقات الجرد ${q.p.label}: **${fmt.money(d.total)}** (السالب عجز).` }), { source: "report_stock_variance", input: range(q), title: `فروقات الجرد ${q.p.label}` });
}

function purchaseOrdersIntent(q: Q): Plan | null {
  if (!has1(q, "list_purchase_orders")) return null;
  const n = q.t.norm;
  const status = /(غير المستلم|غير مستلم|لم تستلم|لم يستلم|مش مستلم|بانتظار الاستلام|لسه ما|لم تصل|ما وصل)/.test(n) ? "approved"
    : /(بانتظار الاعتماد|غير معتمد|لم تعتمد|مسود|معلق)/.test(n) ? "draft" : /معتمد/.test(n) ? "approved" : /مستلم|وصلت|استلمت/.test(n) ? "received" : /ملغ/.test(n) ? "cancelled" : undefined;
  const input: Record<string, unknown> = { ...(status ? { status } : {}), ...(q.number ? { q: q.number } : {}) };
  const title = `أوامر الشراء${status ? ` (${STATUS[status]})` : ""}`;
  if (q.number && has1(q, "purchase_order_detail")) {
    return {
      stages: [() => [{ name: "list_purchase_orders", input }], (r) => {
        const hit = rowsOf(get(r, "list_purchase_orders")?.data).find((x) => String(x.number) === q.number);
        return hit ? [{ name: "purchase_order_detail", input: { id: hit.id } }] : [];
      }],
      answer: (r) => {
        const d = get(r, "purchase_order_detail");
        if (!d?.ok) return `لم أجد أمر شراء رقم ${q.number}.`;
        const po = d.data;
        return `**أمر الشراء رقم ${po.number}** من ${po.supplierName} إلى ${po.locationName}، الحالة: ${tr(STATUS, po.status)}.\n\n${table(["المادة", "الكمية", "سعر الوحدة", "الإجمالي"], arr(po.items).map((x: Data) => [x.name, `${fmt.num(x.quantity)} ${x.purchaseUnit ?? ""}`, fmt.money(x.unitPrice), fmt.money(x.lineTotal)]))}\n\nالصافي ${fmt.money(po.total)}، الضريبة ${fmt.money(po.vatAmount)}، **الإجمالي ${fmt.money(po.grandTotal)}**.`;
      },
    };
  }
  return one([{ name: "list_purchase_orders", input }], (r) => listAnswer(title, get(r, "list_purchase_orders"), [["الرقم", "number"], ["المورد", "supplierName"], ["الموقع", "locationName"], ["الحالة", "status"], ["الإجمالي", "grandTotal"], ["التاريخ", "createdAt"]],
    { empty: `لا توجد ${title}.`, lead: (rows, d) => `**${fmt.num(totalOf(d))}** ${title}، إجماليها ${fmt.money(sum(rows, "grandTotal"))}${totalOf(d) > rows.length ? ` (لأول ${rows.length})` : ""}.` }), { source: "list_purchase_orders", input, title });
}

function balancesIntent(q: Q): Plan | null {
  if (!has1(q, "supplier_balances")) return null;
  return one([{ name: "supplier_balances", input: { onlyOpen: "true" } }], (r) => {
    const res = get(r, "supplier_balances");
    const bad = failed(res, "مستحقات الموردين");
    if (bad) return bad;
    let rows = rowsOf(res!.data).filter((x) => (x.balance ?? 0) > 0);
    const named = q.entity ? rows.filter((x) => same(x.name, q.entity)) : [];
    if (named.length) rows = named;
    if (!rows.length) return "لا توجد مستحقات مفتوحة للموردين. ✅";
    rows.sort((a, b) => b.balance - a.balance);
    const overdue = rows.filter((x) => isOverdue(x, q.env.today));
    const total = named.length ? sum(rows, "balance") : res!.data.totalOwed ?? sum(rows, "balance");
    return `إجمالي المستحق للموردين: **${fmt.money(total)}** (شامل الضريبة).\n\n${table(["المورد", "المشتريات", "المدفوع", "المستحق", "آخر دفعة", "المهلة"], rows.slice(0, 15).map((x) => [x.name, fmt.money(x.purchases), fmt.money(x.payments), fmt.money(x.balance), x.lastPaymentOn ? fmt.date(x.lastPaymentOn) : "لا يوجد", `${fmt.num(x.paymentTermsDays ?? 0)} يوم`]))}${overdue.length ? `\n\n⚠️ **يُرجَّح تأخرها:** ${overdue.slice(0, 5).map((x) => x.name).join("، ")}. (آخر دفعة أقدم من مهلة السداد، أو لا توجد دفعة. راجع كشف الحساب للتأكد.)` : ""}`;
  }, { source: "supplier_balances", input: { onlyOpen: "true" }, title: "مستحقات الموردين" });
}
function isOverdue(x: Data, today: string) {
  if (!(x.balance > 0)) return false;
  if (!x.lastPaymentOn) return true;
  const days = (Date.parse(`${today}T00:00:00Z`) - Date.parse(String(x.lastPaymentOn).slice(0, 10) + "T00:00:00Z")) / 86_400_000;
  return days > Math.max(Number(x.paymentTermsDays) || 0, 30);
}

function statementIntent(q: Q): Plan | null {
  if (!has1(q, "supplier_statement") || !has1(q, "list_suppliers")) return null;
  if (!q.entity) return balancesIntent(q);
  return {
    stages: [...searchStages("list_suppliers", "q", {}, candidates(q)), (r) => {
      const s = bestMatch(rowsOf(get(r, "list_suppliers")?.data), q.entity);
      return s ? [{ name: "supplier_statement", input: { id: s.id, ...range(q) } }] : [];
    }],
    answer: (r) => {
      const res = get(r, "supplier_statement");
      if (!res) return `لم أجد مورداً باسم «${q.entity}».`;
      const bad = failed(res, "كشف الحساب");
      if (bad) return bad;
      const d = res.data;
      const lines = arr(d.lines);
      return `**كشف حساب ${d.supplier?.name}** ${q.p.label}: الرصيد الافتتاحي ${fmt.money(d.openingBalance)}، **الرصيد الختامي ${fmt.money(d.closingBalance)}**.\n\n${lines.length ? table(["التاريخ", "البيان", "المرجع", "مدين", "دائن", "الرصيد"], lines.slice(-15).map((x: Data) => [fmt.date(x.d), tr(KIND, x.kind), x.refNumber ?? "—", fmt.money(x.debit), fmt.money(x.credit), fmt.money(x.balance)])) : "لا توجد حركات في الفترة."}`;
    },
  };
}

function recipesIntent(q: Q): Plan | null {
  if (!has1(q, "list_recipes")) return null;
  const wantsLines = /(مكونات|تفجير|تتكون|يتكون|فيها ايه|محتويات)/.test(q.t.norm) || (q.entity && /تكلف/.test(q.t.norm));
  const comparative = q.threshold !== null || /(تتجاوز|تزيد|فوق|اكبر من|اعلي من|مرتفع|عالي)/.test(q.t.norm);
  if (q.entity && !comparative) {
    const stages = searchStages("list_recipes", "q", {}, candidates(q));
    const detail = has1(q, "report_recipe_explosion") ? "report_recipe_explosion" : has1(q, "recipe_detail") ? "recipe_detail" : null;
    if (wantsLines && detail) stages.push((r) => {
      const hit = bestMatch(rowsOf(get(r, "list_recipes")?.data), q.entity);
      return hit ? [{ name: detail, input: detail === "report_recipe_explosion" ? { recipeId: hit.id } : { id: hit.id } }] : [];
    });
    return {
      stages,
      answer: (r) => {
        const res = get(r, "list_recipes");
        const bad = failed(res, "الوصفات");
        if (bad) return bad;
        const rows = rowsOf(res!.data);
        if (!rows.length) return `لم أجد وصفة باسم «${q.entity}».`;
        const head = rows.slice(0, 3).map((x) => `**${x.name}**: سعر البيع ${fmt.money(x.priceNet)} قبل الضريبة، التكلفة ${fmt.money(x.totalCost)}، **نسبة تكلفة الطعام ${fmt.pct(x.foodCostPercent)}**، الهامش ${fmt.money(x.margin)}.${x.missingCost > 0 ? " ⚠️ بعض مكوناتها بلا تكلفة بعد، فالنسبة أقل من الحقيقة." : ""}`).join("\n\n");
        const ex = get(r, "report_recipe_explosion");
        const dt = get(r, "recipe_detail");
        const lines = ex?.ok ? `\n\n${table(["المكوّن", "الكمية", "التكلفة", "الحصة"], arr(ex.data.lines).map((x: Data) => [x.name + (x.viaPrep ? ` (عبر ${x.viaPrep})` : ""), fmt.qty(x.rawQty, x.unit), fmt.money(x.cost), fmt.pct(x.sharePercent)]))}`
          : dt?.ok ? `\n\n${table(["المكوّن", "الكمية", "نسبة الصافي"], arr(dt.data.items).map((x: Data) => [x.name, fmt.qty(x.quantity, x.baseUnit), fmt.pct(x.yieldPercentage)]))}` : "";
        return head + lines;
      },
    };
  }
  const input = /مسود/.test(q.t.norm) ? { status: "draft" } : {};
  return one([{ name: "list_recipes", input }], (r) => {
    const res = get(r, "list_recipes");
    const bad = failed(res, "الوصفات");
    if (bad) return bad;
    let rows = rowsOf(res!.data);
    if (!rows.length) return "لا توجد وصفات بعد.";
    const priced = rows.filter((x) => x.priceNet > 0);
    const avg = priced.length ? priced.reduce((s, x) => s + x.foodCostPercent, 0) / priced.length : 0;
    const limit = q.threshold ?? (/(تتجاوز|اعلي|فوق|اكبر|مرتفع|عالي)/.test(q.t.norm) ? 35 : null);
    if (limit !== null) rows = priced.filter((x) => x.foodCostPercent > limit);
    rows.sort((a, b) => b.foodCostPercent - a.foodCostPercent);
    const lead = limit !== null ? `**${rows.length}** وصفة نسبة تكلفتها فوق ${limit}% (متوسط الوصفات المسعّرة ${fmt.pct(avg)}).` : `**${fmt.num(totalOf(res!.data))}** وصفة، متوسط نسبة تكلفة الطعام ${fmt.pct(avg)}. الأعلى تكلفة:`;
    if (!rows.length) return `${lead}\n\nلا توجد وصفات فوق هذا الحد. ✅`;
    return `${lead}\n\n${table(["الوصفة", "سعر البيع", "التكلفة", "النسبة", "الهامش"], rows.slice(0, 12).map((x) => [x.name, fmt.money(x.priceNet), fmt.money(x.totalCost), fmt.pct(x.foodCostPercent), fmt.money(x.margin)]))}${limit !== null ? "\n\nلخفض النسبة: راجع الكميات في الوصفة، أو أسعار الموردين لأغلى مكوّن، أو سعر البيع." : ""}`;
  }, { source: "list_recipes", input, title: "الوصفات وتكلفتها" });
}

function salesIntent(q: Q): Plan | null {
  const compare = /(قارن|مقارنه|مقابل|بالاسبوع|عن الاسبوع|بالشهر|عن الشهر|نمو|تغير|زادت|قلت|نقصت|الذي قبله|اللي قبله|السابق له)/.test(q.t.norm);
  const p = q.period ?? (compare ? { from: shiftDays(q.env.today, -6), to: q.env.today, label: "آخر 7 أيام" } : { from: q.env.today, to: q.env.today, label: "اليوم" });
  const days = Math.round((Date.parse(p.to) - Date.parse(p.from)) / 86_400_000) + 1;
  const prevFrom = shiftDays(p.from, -days);
  if (has1(q, "report_daily_sales")) {
    const input = { from: compare ? prevFrom : p.from, to: p.to };
    return one([{ name: "report_daily_sales", input }], (r) => {
      const res = get(r, "report_daily_sales");
      const bad = failed(res, "المبيعات");
      if (bad) return bad;
      const all = rowsOf(res!.data);
      const cur = all.filter((x) => x.day >= p.from);
      const s = totals(cur);
      let out = s.orders ? `**المبيعات ${p.label}:** ${fmt.num(s.orders)} طلب، صافي **${fmt.money(s.netSales)}**، الضريبة ${fmt.money(s.vat)}، الإجمالي ${fmt.money(s.total)}.\nتكلفة المكونات ${fmt.money(s.cost)}، **مجمل الربح ${fmt.money(s.grossProfit)}** (${fmt.pct(s.netSales ? (s.grossProfit / s.netSales) * 100 : 0)})${s.refunds ? `، والمرتجعات ${fmt.money(s.refunds)}` : ""}.`
        : `لا توجد مبيعات ${p.label}.`;
      if (compare) {
        const prev = totals(all.filter((x) => x.day < p.from));
        const ch = (a: number, b: number) => (b ? `${a >= b ? "▲" : "▼"} ${fmt.pct(Math.abs(((a - b) / b) * 100))}` : "—");
        out += `\n\n**المقارنة بالفترة السابقة (${prevFrom} إلى ${shiftDays(p.from, -1)}):**\n\n${table(["المؤشر", p.label, "الفترة السابقة", "التغير"], [
          ["الطلبات", fmt.num(s.orders), fmt.num(prev.orders), ch(s.orders, prev.orders)],
          ["صافي المبيعات", fmt.money(s.netSales), fmt.money(prev.netSales), ch(s.netSales, prev.netSales)],
          ["مجمل الربح", fmt.money(s.grossProfit), fmt.money(prev.grossProfit), ch(s.grossProfit, prev.grossProfit)],
          ["متوسط الطلب", fmt.money(s.orders ? s.netSales / s.orders : 0), fmt.money(prev.orders ? prev.netSales / prev.orders : 0), ch(s.orders ? s.netSales / s.orders : 0, prev.orders ? prev.netSales / prev.orders : 0)],
        ])}`;
      } else if (cur.length > 1) {
        const best = [...cur].sort((a, b) => b.netSales - a.netSales)[0];
        out += `\n\nمتوسط اليوم ${fmt.money(s.netSales / cur.length)}، وأفضل يوم ${best.day} بصافي ${fmt.money(best.netSales)}.\n\n${table(["اليوم", "الطلبات", "الصافي", "مجمل الربح"], cur.slice(-14).map((x) => [x.day, fmt.num(x.orders), fmt.money(x.netSales), fmt.money(x.grossProfit)]))}`;
      }
      return out;
    }, { source: "report_daily_sales", input: { from: p.from, to: p.to }, title: `المبيعات اليومية ${p.label}` });
  }
  if (!has1(q, "list_orders")) return null;
  return one([{ name: "list_orders", input: { from: p.from, to: p.to } }], (r) => ordersSummary(get(r, "list_orders"), p), { source: "list_orders", input: { from: p.from, to: p.to }, title: `الطلبات ${p.label}` });
}
const totals = (rows: Data[]) => ({ orders: sum(rows, "orders"), netSales: sum(rows, "netSales"), vat: sum(rows, "vat"), total: sum(rows, "total"), cost: sum(rows, "cost"), grossProfit: sum(rows, "grossProfit"), refunds: sum(rows, "refunds") });

function ordersSummary(res: Result | undefined, p: Period) {
  const bad = failed(res, "الطلبات");
  if (bad) return bad;
  const rows = rowsOf(res!.data);
  const count = totalOf(res!.data);
  if (!count) return `لا توجد طلبات ${p.label}.`;
  const valid = rows.filter((x) => x.status !== "refunded");
  const by = new Map<string, { n: number; v: number }>();
  for (const x of valid) { const k = x.platformName ?? tr(CHANNEL, x.channel); const e = by.get(k) ?? { n: 0, v: 0 }; e.n++; e.v += x.total ?? 0; by.set(k, e); }
  const partial = count > rows.length ? `\n\n(الأرقام محسوبة على أول ${rows.length} طلب من ${count}.)` : "";
  return `**${fmt.num(count)}** طلب ${p.label} بإجمالي **${fmt.money(sum(valid, "total"))}** شامل الضريبة (${fmt.money(sum(valid, "vat"))} ضريبة).\n\n${table(["القناة", "الطلبات", "الإجمالي"], [...by].map(([k, e]) => [k, fmt.num(e.n), fmt.money(e.v)]))}${partial}`;
}

function channelIntent(q: Q): Plan | null {
  const p = q.period ?? { from: q.env.today, to: q.env.today, label: "اليوم" };
  if (!has1(q, "report_sales_by_channel")) {
    if (!has1(q, "list_orders")) return null;
    return one([{ name: "list_orders", input: { from: p.from, to: p.to } }], (r) => ordersSummary(get(r, "list_orders"), p));
  }
  return one([{ name: "report_sales_by_channel", input: { from: p.from, to: p.to } }], (r) => {
    const res = get(r, "report_sales_by_channel");
    const bad = failed(res, "المبيعات حسب القناة");
    if (bad) return bad;
    const rows = rowsOf(res!.data);
    if (!rows.length) return `لا توجد مبيعات ${p.label}.`;
    const net = sum(rows, "netSales");
    const commission = sum(rows, "commission");
    return `المبيعات ${p.label} حسب القناة (صافي ${fmt.money(net)}):\n\n${table(["القناة", "الطلبات", "الصافي", "الحصة", "العمولة", "الصافي بعد العمولة"], rows.sort((a, b) => b.netSales - a.netSales).map((x) => [x.platformName ?? tr(CHANNEL, x.channel), fmt.num(x.orders), fmt.money(x.netSales), fmt.pct(net ? (x.netSales / net) * 100 : 0), fmt.money(x.commission), fmt.money(x.netAfterCommission)]))}${commission ? `\n\nعمولات التطبيقات ${fmt.money(commission)} (${fmt.pct(net ? (commission / net) * 100 : 0)} من الصافي).` : ""}`;
  }, { source: "report_sales_by_channel", input: { from: p.from, to: p.to }, title: `المبيعات حسب القناة ${p.label}` });
}

function menuIntent(q: Q): Plan | null {
  if (!has1(q, "report_menu_profitability")) return has1(q, "list_recipes") ? recipesIntent({ ...q, entity: "" }) : null;
  return one([{ name: "report_menu_profitability", input: range(q) }], (r) => {
    const res = get(r, "report_menu_profitability");
    const bad = failed(res, "ربحية المنيو");
    if (bad) return bad;
    const rows = rowsOf(res!.data);
    if (!rows.length) return "لا توجد أصناف في المنيو بعد.";
    const n = q.topN ?? 5;
    const low = /(اقل|اسوا|خسر|ضعيف)/.test(q.t.norm);
    const sold = rows.filter((x) => x.qtySold > 0);
    const byRevenue = [...sold].sort((a, b) => b.revenue - a.revenue);
    const byMargin = [...rows].filter((x) => x.priceNet > 0).sort((a, b) => (low ? b.foodCostPercent - a.foodCostPercent : a.foodCostPercent - b.foodCostPercent));
    const unsold = rows.filter((x) => !x.qtySold && x.status === "approved");
    const head = `ربحية المنيو ${q.p.label}: ${sold.length} صنف بيع منه ${fmt.num(sum(sold, "qtySold"))} وحدة بإيراد ${fmt.money(sum(sold, "revenue"))}.`;
    const bestTable = `### ${low ? "الأقل ربحية (أعلى نسبة تكلفة)" : "الأعلى ربحية (أقل نسبة تكلفة)"}\n${table(["الصنف", "السعر", "نسبة التكلفة", "الهامش", "المباع"], byMargin.slice(0, n).map((x) => [x.name, fmt.money(x.priceNet), fmt.pct(x.foodCostPercent), fmt.money(x.idealMargin), fmt.num(x.qtySold)]))}`;
    const sellers = byRevenue.length ? `\n\n### الأكثر مبيعاً\n${table(["الصنف", "المباع", "الإيراد"], byRevenue.slice(0, n).map((x) => [x.name, fmt.num(x.qtySold), fmt.money(x.revenue)]))}` : "";
    return `${head}\n\n${bestTable}${sellers}${unsold.length ? `\n\n${unsold.length} صنف معتمد لم يُبع في الفترة: ${unsold.slice(0, 5).map((x) => x.name).join("، ")}.` : ""}`;
  }, { source: "report_menu_profitability", input: range(q), title: `ربحية المنيو ${q.p.label}` });
}

function idealIntent(q: Q): Plan | null {
  if (!has1(q, "report_ideal_vs_actual")) return null;
  return one([{ name: "report_ideal_vs_actual", input: range(q) }], (r) => {
    const res = get(r, "report_ideal_vs_actual");
    const bad = failed(res, "المثالي مقابل الفعلي");
    if (bad) return bad;
    const d = res!.data;
    const t = d.totals ?? {};
    const rows = rowsOf(d).filter((x) => x.varianceValue > 0).sort((a, b) => b.varianceValue - a.varianceValue);
    const gap = (t.actualFoodCostPercent ?? 0) - (t.idealFoodCostPercent ?? 0);
    return `${q.p.label}: نسبة تكلفة الطعام **المثالية ${fmt.pct(t.idealFoodCostPercent)}** و**الفعلية ${fmt.pct(t.actualFoodCostPercent)}** (فرق ${fmt.num(round(gap, 2))} نقطة) على صافي مبيعات ${fmt.money(t.netSales)}.\nالاستهلاك المثالي ${fmt.money(t.idealValue)}، والفعلي ${fmt.money(t.actualValue)}، منه هدر ${fmt.money(t.wasteValue)} وفروقات جرد ${fmt.money(t.countValue)}.${rows.length ? `\n\n### أكبر الفروقات\n${table(["المادة", "المثالي", "الفعلي", "الفرق", "٪"], rows.slice(0, 8).map((x) => [x.name, fmt.money(x.idealValue), fmt.money(x.actualValue), fmt.money(x.varianceValue), fmt.pct(x.variancePercent)]))}` : ""}`;
  }, { source: "report_ideal_vs_actual", input: range(q), title: `المثالي مقابل الفعلي ${q.p.label}` });
}

function pricesIntent(q: Q): Plan | null {
  if (!has1(q, "report_purchase_prices")) return null;
  return one([{ name: "report_purchase_prices", input: range(q) }], (r) => {
    const res = get(r, "report_purchase_prices");
    const bad = failed(res, "أسعار الشراء");
    if (bad) return bad;
    const rows = rowsOf(res!.data);
    if (!rows.length) return `لا توجد استلامات مشتريات ${q.p.label}.`;
    const up = rows.filter((x) => x.changePercent > 0).sort((a, b) => b.changePercent - a.changePercent);
    const down = rows.filter((x) => x.changePercent < 0).sort((a, b) => a.changePercent - b.changePercent);
    return `أسعار الشراء ${q.p.label} (${rows.length} مادة مستلمة):${up.length ? `\n\n### ارتفعت\n${table(["المادة", "أول سعر", "آخر سعر", "التغير", "آخر مورد"], up.slice(0, 10).map((x) => [x.name, fmt.unitCost(x.firstCost, x.unit), fmt.unitCost(x.lastCost, x.unit), `▲ ${fmt.pct(x.changePercent)}`, x.lastSupplier ?? "—"]))}` : "\n\nلم يرتفع سعر أي مادة في الفترة. ✅"}${down.length ? `\n\n### انخفضت\n${down.slice(0, 5).map((x) => `- ${x.name}: ▼ ${fmt.pct(Math.abs(x.changePercent))}`).join("\n")}` : ""}`;
  }, { source: "report_purchase_prices", input: range(q), title: `أسعار الشراء ${q.p.label}` });
}

function expensesIntent(q: Q): Plan | null {
  const n = q.t.norm;
  const status = /(بانتظار الاعتماد|معلق|غير معتمد|لم تعتمد)/.test(n) ? "pending" : /(غير مدفوع|لم تدفع|مش مدفوع)/.test(n) ? "approved" : /مدفوع/.test(n) ? "paid" : undefined;
  const byCategory = /(فئه|تصنيف|بند|بنود|نسبه|حسب)/.test(n);
  if (byCategory && has1(q, "report_expenses") && !status) return one([{ name: "report_expenses", input: range(q) }], (r) => {
    const res = get(r, "report_expenses");
    const bad = failed(res, "تقرير المصروفات");
    if (bad) return bad;
    const d = res!.data;
    const cats = arr(d.byCategory);
    return `المصروفات ${q.p.label}: **${fmt.money(d.totalNet)}** قبل الضريبة، أي **${fmt.pct(d.expenseRatio)}** من صافي المبيعات (${fmt.money(d.netSales)}).${cats.length ? `\n\n${renderTable(cats, [["الفئة", ["categoryName", "name", "category"]], ["المبلغ", ["amount", "totalNet", "total", "value"]], ["النسبة", ["percent", "share", "ratio"], (v) => fmt.pct(v)]], 15)}` : ""}`;
  });
  if (!has1(q, "list_expenses")) return null;
  const input = { ...(status === "pending" ? { from: shiftDays(q.env.today, -365), to: q.env.today } : range(q)), ...(status ? { status } : {}) };
  const title = `المصروفات${status ? ` (${STATUS[status] ?? status})` : ""}`;
  return one([{ name: "list_expenses", input }], (r) => listAnswer(title, get(r, "list_expenses"), [["التاريخ", ["expenseDate", "date", "createdAt"]], ["الفئة", ["categoryName", "category"]], ["الوصف", ["description", "notes"]], ["الإجمالي", ["total", "amount", "amountNet"]], ["الحالة", "status"]],
    { empty: status === "pending" ? "لا توجد مصروفات بانتظار الاعتماد. ✅" : `لا توجد مصروفات ${q.p.label}.`, lead: (rows, d) => `**${fmt.num(totalOf(d))}** ${title} ${status === "pending" ? "" : q.p.label} بإجمالي ${fmt.money(typeof d.summary?.total === "number" && !status ? d.summary.total : sum(rows, "total"))}.` }), { source: "list_expenses", input, title });
}

function vatIntent(q: Q): Plan | null {
  if (!has1(q, "report_vat")) return null;
  return one([{ name: "report_vat", input: range(q) }], (r) => {
    const res = get(r, "report_vat");
    const bad = failed(res, "تقرير الضريبة");
    if (bad) return bad;
    const s = res!.data.summary ?? {};
    return `ضريبة القيمة المضافة ${q.p.label}:\n\n${table(["البند", "المبلغ"], [
      ["المبيعات الخاضعة", fmt.money(s.taxableSales)], ["ضريبة المخرجات", fmt.money(s.outputVat)], ["ضريبة المشتريات", fmt.money(s.inputVatPurchases)],
      ["ضريبة مرتجعات المشتريات", fmt.money(s.returnsVat)], ["ضريبة المصروفات", fmt.money(s.inputVatExpenses)], ["**صافي الضريبة المستحقة**", `**${fmt.money(s.netVat)}**`],
    ])}\n\nهذا تقدير داخلي للمتابعة وليس إقراراً رسمياً.`;
  });
}

const PORTFOLIO_FLAG: Record<string, string> = { loss: "خسارة متوقعة", behind: "متأخر عن البرنامج", over_cost: "تجاوز التكلفة", lti: "إصابة مضيعة للوقت", no_estimate: "بلا تقدير للتكلفة" };
function portfolioIntent(q: Q): Plan | null {
  if (!has1(q, "contracting_portfolio")) return null;
  return one([{ name: "contracting_portfolio", input: {} }], (r) => {
    const res = get(r, "contracting_portfolio");
    const bad = failed(res, "محفظة المشاريع");
    if (bad) return bad;
    const d = res!.data;
    const items = arr(d.items);
    if (!items.length) return "لا مشاريع مفتوحة بعد.";
    const t = d.totals ?? {};
    const flagged = items.filter((x) => arr(x.flags).length);
    const lines = items.map((x) => [String(x.code), fmt.money(x.contractValue), fmt.pct(x.progressPct), x.eac === null ? "غير مقدَّرة" : fmt.money(x.eac),
      x.margin === null ? "—" : `${fmt.money(x.margin)} (${fmt.pct(x.marginPct)})`, arr(x.flags).map((f) => PORTFOLIO_FLAG[String(f)] ?? String(f)).join("، ") || "—"]);
    return `محفظة المشاريع: **${fmt.num(items.length)}** مشروعاً بقيمة **${fmt.money(t.contractValue)}**، اعتُمد منها ${fmt.money(t.certified)} والمتبقي ${fmt.money(t.backlog)}.`
      + ` الهامش المتوقع للمشاريع المقدّرة **${fmt.money(t.margin)}** من ${fmt.money(t.marginOf)}${t.unknownMargin ? `، و${fmt.num(t.unknownMargin)} مشروع بلا تقدير للتكلفة فلا يُحسب هامشه` : ""}.`
      + `\n\n${table(["المشروع", "القيمة", "الإنجاز", "التكلفة المتوقعة", "الهامش", "تنبيهات"], lines.slice(0, 20))}`
      + (flagged.length ? `\n\nتحتاج متابعة: ${flagged.map((x) => `${x.code} (${arr(x.flags).map((f) => PORTFOLIO_FLAG[String(f)] ?? String(f)).join("، ")})`).join("؛ ")}.` : "");
  }, { source: "contracting_portfolio", input: {}, title: "محفظة المشاريع" });
}

function overviewIntent(q: Q): Plan | null {
  if (!has1(q, "workspace_overview")) return null;
  return one([{ name: "workspace_overview", input: {} }], (r) => {
    const res = get(r, "workspace_overview");
    const bad = failed(res, "بيانات المنشأة");
    if (bad) return bad;
    const d = res!.data;
    const lim = d.limits ?? {};
    return `**${d.tenant?.companyName}**${d.tenant?.city ? ` (${d.tenant.city})` : ""}\n\n${table(["البند", "القيمة"], [
      ["الاشتراك", `${d.subscription?.planName ?? "—"} (${tr(STATUS, d.subscription?.status)})`], ["ينتهي في", d.subscription?.endsAt ?? "—"],
      ["الفروع", lim.branches ? `${lim.branches.used} من ${lim.branches.limit}` : "—"], ["المستخدمون", lim.users ? `${lim.users.used} من ${lim.users.limit}` : "—"],
      ["نسبة الضريبة", fmt.pct(d.settings?.vatRatePercent)], ["حد الخصم دون موافقة", fmt.pct(d.settings?.discountApprovalPercent)],
    ])}`;
  });
}

function helpReply(q: Q): Plan {
  return { stages: [() => []], answer: () => {
    if (q.platform) return `أهلاً${q.env.user ? ` ${q.env.user.split(" ")[0]}` : ""}! أنا مساعد إدارة المنصة. أجيب عن المنشآت والاشتراكات والباقات والمستخدمين والإيرادات واستهلاك الحدود وسجل التدقيق وقائمة الانتظار، وأحلل وضع المنصة، وأجهّز أي تقرير Excel أو CSV أو PDF أو Word.\n\nأمثلة:\n- ما أهم المشاكل والفرص في المنصة الآن؟\n${PLATFORM_INTENTS.filter((i) => i.example).map((i) => `- ${i.example}`).join("\n")}\n\nلا أطّلع على بيانات المنشآت الداخلية. ذلك عبر جلسة دعم فقط.`;
    const lines = INTENTS.filter((it) => it.example && (it.id === "insights" ? buildInsights(q, new Set()) : it.build(q))).map((it) => `- ${it.example}`);
    return `أهلاً${q.env.user ? ` ${q.env.user.split(" ")[0]}` : ""}! أنا مساعد «${q.env.company}». أجيب من بيانات منشأتك ضمن صلاحياتك، وأجهّز التقارير Excel أو CSV أو PDF، وأحلل الأداء وأقترح تحسينات.\n\nأمثلة لما يمكنك سؤاله:\n${lines.slice(0, 8).join("\n")}\n\nويمكنك تحديد الفترة: «اليوم»، «أمس»، «هذا الأسبوع»، «الشهر الماضي»، «آخر 10 أيام»، أو تاريخ مثل 2026-09-01.`;
  } };
}

const INTENTS: Intent[] = [
  { id: "insights", area: "general", what: "التحليل", words: [["مشاكل", 4], ["مشكله", 4], ["عيوب", 4], ["عيب", 3], ["ضعف", 3], ["تحسين", 4], ["احسن", 2], ["نصائح", 4], ["نصيحه", 4], ["توصيات", 4], ["توصيه", 4], ["اداء", 3], ["وضع الشركه", 4], ["وضع المطعم", 4], ["وضعنا", 3], ["غلط", 3], ["خلل", 4], ["تطوير", 4], ["اطور", 4], ["اعالج", 3], ["توفير", 3], ["اوفر", 3], ["تقليل التكاليف", 4], ["تقليل التكلفه", 4], ["خسائر", 3], ["فحص شامل", 4], ["تشخيص", 4], ["حلل", 3]], build: () => null,
    example: "ما أهم المشاكل في منشأتي هذا الشهر وكيف أعالجها؟" },
  { id: "low_stock", area: "stock", what: "المخزون", words: [["تحت الحد", 5], ["الحد الادني", 5], ["حد ادني", 5], ["ناقص", 3], ["نواقص", 4], ["قارب", 3], ["قربت تخلص", 5], ["نفد", 5], ["نفذ", 4], ["نفاد", 4], ["خلص", 3], ["خلصان", 4], ["اعاده الطلب", 4], ["اعاده طلب", 4], ["رصيد صفر", 5], ["low stock", 5], ["reorder", 4]], build: lowStockIntent,
    example: "ما المواد تحت الحد الأدنى؟" },
  { id: "expiry", area: "stock", what: "الصلاحية", words: [["صلاحيه", 6], ["الصلاحيه", 6], ["تاريخ الانتهاء", 6], ["منتهي الصلاحيه", 7], ["هتنتهي", 5], ["قربت تنتهي", 6], ["تنتهي قريبا", 6], ["دفعات", 4], ["تشغيله", 4], ["تشغيلات", 4], ["expiry", 5], ["expired", 5], ["fefo", 5]], build: expiryIntent,
    example: "ما المواد التي تنتهي صلاحيتها هذا الأسبوع؟" },
  { id: "stock_value", area: "stock", what: "المخزون", words: [["قيمه المخزون", 6], ["تقييم المخزون", 6], ["قيمه البضاعه", 5], ["المخزون بكام", 5], ["قيمه الموجود", 4]], build: stockValueIntent },
  { id: "movements", area: "stock", what: "حركة المخزون", words: [["حركه", 4], ["حركات", 4], ["سجل المخزون", 4], ["وارد", 2], ["صادر", 2], ["دخل وخرج", 3]], build: movementsIntent },
  { id: "variance", area: "stock", what: "فروقات الجرد", words: [["فروقات الجرد", 6], ["فرق الجرد", 6], ["فروق الجرد", 6], ["انحراف", 4], ["عجز الجرد", 6], ["عجز المخزون", 5], ["variance", 4]], build: varianceIntent },
  { id: "waste", area: "stock", what: "الهدر", words: [["هدر", 5], ["هالك", 4], ["تالف", 4], ["فاقد", 4], ["اتلاف", 4], ["منتهي الصلاحيه", 4], ["مرمي", 3], ["رمينا", 3], ["waste", 4]], build: wasteIntent,
    example: "أين يذهب الهدر في آخر 30 يوماً؟" },
  { id: "stocktakes", area: "stock", what: "الجرد", words: [["جرد", 4], ["عد المخزون", 4], ["stocktake", 4]], build: simpleList("list_stocktakes", "عمليات الجرد", [["الرقم", "number"], ["الموقع", "locationName"], ["الحالة", "status"], ["المعدود", "countedCount"], ["المواد", "itemsCount"], ["الفرق", "varianceValue"], ["التاريخ", "createdAt"]], "لا توجد عمليات جرد.", (q) => (/(مفتوح|جاري|قيد)/.test(q.t.norm) ? { status: "counting" } : {})) },
  { id: "transfers", area: "stock", what: "التحويلات", words: [["تحويل", 4], ["تحويلات", 4], ["نقل بين", 4], ["بين المواقع", 4]], build: simpleList("list_transfers", "التحويلات", [["الرقم", "number"], ["من", ["fromLocationName", "fromName"]], ["إلى", ["toLocationName", "toName"]], ["الحالة", "status"], ["القيمة", ["totalValue", "value"]], ["التاريخ", "createdAt"]], "لا توجد تحويلات.") },
  { id: "production", area: "stock", what: "الإنتاج", words: [["انتاج", 4], ["دفعات الانتاج", 5], ["دفعه تحضير", 4]], build: simpleList("production_runs", "دفعات الإنتاج", [["الصنف", ["prepName", "name"]], ["الكمية", ["quantity", "outputQty"]], ["التكلفة", ["totalCost", "cost"]], ["الموقع", "locationName"], ["التاريخ", "createdAt"]], "لا توجد دفعات إنتاج.") },
  { id: "stock", area: "stock", what: "المخزون", weak: true, words: [["رصيد", 3], ["مخزون", 3], ["كميه", 2], ["متبقي", 2], ["باقي", 2], ["عندنا كام", 3], ["كم عندي", 3], ["مستودع", 2], ["المخزن", 3], ["stock", 3]], build: stockIntent,
    example: "كم رصيد الطماطم؟" },

  { id: "prices", area: "purchases", what: "أسعار الشراء", words: [["اسعار الشراء", 6], ["سعر الشراء", 5], ["ارتفاع الاسعار", 6], ["ارتفاع اسعار", 6], ["غلاء", 4], ["زياده الاسعار", 5], ["زياده اسعار", 5], ["الاسعار زادت", 5], ["تغير الاسعار", 5], ["اسعار الموردين", 5], ["اسعار الخامات", 5]], build: pricesIntent,
    example: "ما المواد التي ارتفع سعر شرائها هذا الشهر؟" },
  { id: "statement", area: "purchases", what: "حسابات الموردين", words: [["كشف حساب", 6], ["كشف", 3], ["statement", 4]], build: statementIntent },
  { id: "balances", area: "purchases", what: "مستحقات الموردين", words: [["مستحق", 5], ["مستحقات", 5], ["استحق", 4], ["مديونيه", 5], ["ديون", 4], ["ندين", 4], ["علينا فلوس", 5], ["رصيد مورد", 5], ["ارصده الموردين", 6], ["متاخر", 2], ["سداد", 3], ["payables", 4]], build: balancesIntent,
    example: "كم أستحق لكل مورد وأيها متأخر؟" },
  { id: "purchase_returns", area: "purchases", what: "مرتجعات المشتريات", words: [["مرتجعات المشتريات", 6], ["مرتجع مشتريات", 6], ["مرتجعات الموردين", 6], ["مرتجع للمورد", 5], ["ارجاع للمورد", 5]], build: simpleList("list_purchase_returns", "مرتجعات المشتريات", [["الرقم", "number"], ["المورد", "supplierName"], ["الحالة", "status"], ["الإجمالي", ["grandTotal", "total"]], ["التاريخ", "createdAt"]], "لا توجد مرتجعات مشتريات.") },
  { id: "purchase_orders", area: "purchases", what: "المشتريات", words: [["امر شراء", 6], ["اوامر الشراء", 6], ["اوامر شراء", 6], ["مشتريات", 4], ["فواتير الشراء", 5], ["فاتوره شراء", 5], ["شراء", 2], ["اشترينا", 4], ["po", 3]], build: purchaseOrdersIntent,
    example: "صدّر أوامر الشراء المعتمدة غير المستلمة إلى Excel" },
  { id: "suppliers", area: "purchases", what: "الموردين", weak: true, words: [["مورد", 3], ["موردين", 3], ["جوال المورد", 4], ["رقم المورد", 4]], build: simpleList("list_suppliers", "الموردون", [["المورد", "name"], ["الرمز", "code"], ["الجوال", "phone"], ["البريد", "email"], ["مهلة السداد", "paymentTermsDays", (v) => `${fmt.num(v ?? 0)} يوم`]], "لا يوجد موردون بعد.", (q) => (q.entity ? { q: q.entity } : {})) },

  { id: "ideal", area: "recipes", what: "تحليل التكلفة", words: [["المثالي", 5], ["مثالي", 5], ["الفعلي", 3], ["استهلاك", 3], ["food cost", 4], ["فود كوست", 4], ["نسبه تكلفه الطعام", 5]], build: idealIntent,
    example: "قارن الاستهلاك المثالي بالفعلي هذا الشهر" },
  { id: "menu", area: "sales", what: "ربحية المنيو", words: [["ربحيه", 6], ["اكثر مبيعا", 6], ["الاكثر مبيعا", 6], ["اقل ربح", 6], ["اقل ربحيه", 6], ["افضل صنف", 5], ["افضل الاصناف", 5], ["اكثر صنف", 5], ["اقل صنف", 5], ["مبيعات الاصناف", 5], ["هندسه المنيو", 6], ["مربح", 4], ["اصناف المنيو", 3]], build: menuIntent,
    example: "أي أصناف المنيو أقل ربحية؟" },
  { id: "prep", area: "recipes", what: "الوصفات", words: [["تحضيري", 5], ["تحضيريه", 5], ["نصف مصنع", 5], ["صوصات", 3]], build: simpleList("list_prep_recipes", "الوصفات التحضيرية", [["الصنف", "name"], ["الوحدة", ["unit", "outputUnit"]], ["تكلفة الوحدة", ["unitCost", "estimatedUnitCost"]]], "لا توجد وصفات تحضيرية.") },
  { id: "recipes", area: "recipes", what: "الوصفات", weak: true, words: [["وصفه", 4], ["وصفات", 4], ["مكونات", 4], ["تكلفه الصنف", 5], ["تكلفه الطبق", 5], ["تكلفه الوجبه", 5], ["تكلفه ساندويتش", 5], ["المنيو", 2], ["اصناف", 2], ["هامش", 2], ["تفجير", 4], ["recipe", 4]], build: recipesIntent,
    example: "ما الوصفات التي تتجاوز نسبة تكلفتها 35%؟" },

  { id: "channels", area: "sales", what: "المبيعات", words: [["قناه", 5], ["قنوات", 5], ["توصيل", 3], ["تطبيقات التوصيل", 5], ["هنقرستيشن", 4], ["جاهز", 2], ["مرسول", 3], ["كيتا", 3], ["سفري", 3], ["عموله", 4], ["عمولات", 4]], build: channelIntent,
    example: "ملخص مبيعات اليوم حسب القناة" },
  { id: "recon", area: "sales", what: "تسوية الكاشير", words: [["تسويه الكاشير", 6], ["تسويه", 3], ["عجز الكاشير", 6], ["زياده الكاشير", 6], ["فرق الصندوق", 6], ["عجز الصندوق", 6], ["العجز والزياده", 6]], build: simpleList("report_cashier_reconciliation", "تسوية الكاشير", [["الكاشير", ["cashierName", "name", "userName"]], ["الشفتات", ["shifts", "shiftsCount"]], ["المبيعات", ["salesTotal", "sales"]], ["العجز/الزيادة", ["overShort", "totalOverShort"]]], "لا توجد شفتات مغلقة في الفترة.", (q) => range(q)) },
  { id: "shifts", area: "sales", what: "الشفتات", words: [["شفت", 5], ["شفتات", 5], ["ورديه", 5], ["ورديات", 5], ["shift", 4]], build: simpleList("list_shifts", "الشفتات", [["الكاشير", "openedByName"], ["الموقع", "locationName"], ["الحالة", "status"], ["الطلبات", "ordersCount"], ["المبيعات", "salesTotal"], ["العجز/الزيادة", "overShort"], ["الفتح", "openedAt"]], "لا توجد شفتات.", (q) => (/مفتوح/.test(q.t.norm) ? { status: "open" } : /(مغلق|مقفول)/.test(q.t.norm) ? { status: "closed" } : {})) },
  { id: "sales", area: "sales", what: "المبيعات", weak: true, words: [["مبيعات", 5], ["مبيع", 4], ["ايرادات", 5], ["ايراد", 4], ["دخل", 3], ["بعنا", 5], ["بيعنا", 5], ["sales", 4], ["ارباح", 4], ["ربح", 3], ["كسبنا", 4], ["الدخل", 3]], build: salesIntent,
    example: "كم مبيعات اليوم؟ أو قارن مبيعات آخر 7 أيام بالأسبوع الذي قبله" },
  { id: "orders", area: "sales", what: "الطلبات", weak: true, words: [["طلبات", 4], ["طلب", 3], ["اوردر", 4], ["اوردرات", 4], ["فواتير البيع", 5], ["فاتوره", 2]], build: (q) => {
    if (!has1(q, "list_orders")) return null;
    const p = q.period ?? { from: q.env.today, to: q.env.today, label: "اليوم" };
    return one([{ name: "list_orders", input: { from: p.from, to: p.to } }], (r) => ordersSummary(get(r, "list_orders"), p), { source: "list_orders", input: { from: p.from, to: p.to }, title: `الطلبات ${p.label}` });
  } },
  { id: "customers", area: "sales", what: "العملاء", words: [["عملاء", 5], ["عميل", 4], ["زبون", 4], ["زبائن", 5], ["customers", 4]], build: simpleList("list_customers", "العملاء", [["العميل", ["fullName", "name"]], ["الجوال", "phone"], ["الطلبات", ["ordersCount", "orders"]], ["إجمالي الإنفاق", ["totalSpent", "spend", "total"]]], "لا يوجد عملاء مسجلون.", (q) => (q.entity ? { q: q.entity } : {})) },

  { id: "expenses", area: "expenses", what: "المصروفات", words: [["مصروف", 5], ["مصروفات", 5], ["مصاريف", 5], ["نفقات", 5], ["ايجار", 3], ["رواتب", 3], ["كهرباء", 3], ["expenses", 4]], build: expensesIntent,
    example: "ما المصروفات بانتظار الاعتماد؟" },
  { id: "portfolio", area: "contracting", what: "محفظة المشاريع", words: [["محفظه", 5], ["المحفظه", 5], ["هامش المشاريع", 7], ["هوامش", 5], ["ربحيه المشاريع", 7], ["المشاريع الخاسره", 7], ["مشاريع خاسره", 7], ["تكلفه المشاريع", 5], ["مشاريعي", 4], ["المشاريع", 3], ["مشروع", 2]],
    build: portfolioIntent, example: "ما هامش مشاريعي وأيها خاسر؟" },
  { id: "vat", area: "sales", what: "تقرير الضريبة", words: [["ضريبه", 4], ["القيمه المضافه", 6], ["vat", 5], ["اقرار", 3]], build: vatIntent },
  { id: "overview", area: "catalog", what: "بيانات المنشأة", words: [["اشتراك", 5], ["باقه", 5], ["باقتي", 5], ["حدود الباقه", 6], ["بيانات المنشاه", 5], ["اعدادات", 4], ["حد الخصم", 5], ["نسبه الضريبه", 7], ["عدد المستخدمين", 5]], build: overviewIntent },
  { id: "locations", area: "catalog", what: "المواقع", weak: true, words: [["مواقع", 4], ["مطابخ", 4], ["مستودعات", 4], ["المستودعات", 4]], build: simpleList("list_locations", "المطابخ والمستودعات", [["الموقع", "name"], ["الرمز", "code"], ["النوع", "locationType", (v) => (v === "kitchen" ? "مطبخ" : v === "warehouse" ? "مستودع" : String(v ?? "—"))], ["نشط", "isActive"]], "لا توجد مواقع بعد.") },
  { id: "branches", area: "catalog", what: "الفروع", words: [["فروع", 5], ["فرع", 4], ["branches", 4]], build: simpleList("list_branches", "الفروع", [["الفرع", "name"], ["الرمز", "code"], ["المدينة", "city"], ["نشط", "isActive"]], "لا توجد فروع مسجلة.") },
  { id: "ingredients", area: "stock", what: "المواد الخام", weak: true, words: [["مواد خام", 5], ["المواد الخام", 5], ["خامات", 4], ["مكون", 2]], build: (q) => (has1(q, "search_ingredients") ? { stages: [() => [{ name: "search_ingredients", input: q.entity ? { q: q.entity } : {} }]], answer: (r) => ingredientsAnswer(q, get(r, "search_ingredients")), file: { source: "search_ingredients", input: q.entity ? { q: q.entity } : {}, title: "المواد الخام" } } : null) },

  { id: "help", area: "general", what: "", words: [["مرحبا", 3], ["السلام عليكم", 3], ["اهلا", 3], ["هلا", 2], ["هاي", 2], ["صباح الخير", 3], ["مساء الخير", 3], ["ازيك", 3], ["كيف حالك", 3], ["من انت", 4], ["مين انت", 4], ["تقدر تعمل", 4], ["تستطيع", 3], ["ايش تقدر", 4], ["مساعده", 2], ["ساعدني", 2], ["help", 3]], build: helpReply },
  { id: "thanks", area: "general", what: "", words: [["شكرا", 4], ["متشكر", 4], ["تسلم", 3], ["يعطيك العافيه", 4], ["جزاك", 3], ["ممتاز", 2]], build: () => ({ stages: [() => []], answer: () => "العفو! أنا هنا متى احتجت أي رقم أو تقرير عن منشأتك." }) },
];
/** Everything the engine can recognise: workspace intents, then the platform administrator's. */
const HELPERS: Helpers = { get, rowsOf, totalOf, arr, failed, listAnswer, searchStages, bestMatch, candidates };
const ALL_INTENTS: Intent[] = [...INTENTS, ...PLATFORM_INTENTS.map((pi): Intent => ({ id: pi.id, area: "platform", what: "بيانات المنصة", words: pi.words, weak: pi.weak, example: pi.example, build: (q) => pi.build(q, HELPERS) }))];
KEYWORDS = [...new Set(ALL_INTENTS.flatMap((it) => it.words.map(([w]) => normalize(w)).filter((w) => !w.includes(" "))))];

// ── Diagnosis ─────────────────────────────────────────────────────────────────────────────────
interface Finding { sev: 1 | 2 | 3; title: string; detail: string; action: string }

/** Every check the member's permissions allow, over the period, then prioritised findings with actions. */
function buildInsights(q: Q, focus: Set<Area>): Plan | null {
  const want = (area: Area) => !focus.size || focus.has(area) || focus.has("general");
  const calls: Call[] = [];
  const add = (area: Area, name: string, input: Record<string, unknown> = {}) => { if (want(area) && has1(q, name)) calls.push({ name, input }); };
  const r30 = range(q);
  add("stock", "search_ingredients", { stock: "low" });
  add("recipes", "report_ideal_vs_actual", r30);
  add("sales", "report_menu_profitability", r30);
  if (!has1(q, "report_menu_profitability")) add("recipes", "list_recipes");
  add("stock", "report_waste_analysis", r30);
  if (!has1(q, "report_waste_analysis")) add("stock", "list_waste", r30);
  add("purchases", "report_purchase_prices", r30);
  add("stock", "report_stock_variance", r30);
  add("purchases", "supplier_balances", { onlyOpen: "true" });
  add("purchases", "list_purchase_orders", { status: "approved" });
  add("purchases", "list_purchase_orders", { status: "draft" });
  add("expenses", "list_expenses", { status: "pending", from: shiftDays(q.env.today, -365), to: q.env.today });
  add("expenses", "report_expenses", r30);
  add("sales", "report_cashier_reconciliation", r30);
  add("sales", "report_daily_sales", { from: shiftDays(q.env.today, -13), to: q.env.today });
  add("stock", "list_stocktakes", { status: "counting" });
  add("sales", "list_shifts", { status: "open" });
  if (!calls.length) return null;
  return { stages: [() => calls], answer: (r) => insightsAnswer(q, r), title: `تحليل ${q.env.company} ${q.p.label}` };
}

function insightsAnswer(q: Q, r: Result[]): string {
  const F: Finding[] = [];
  const good: string[] = [];
  const ok = (name: string, pred?: (i: Record<string, unknown>) => boolean) => { const x = get(r, name, pred); return x?.ok ? x.data : null; };
  const names = (rows: Data[], n = 3) => rows.slice(0, n).map((x) => x.name).join("، ");

  const low = ok("search_ingredients");
  if (low) {
    const rows = rowsOf(low);
    const zero = rows.filter((x) => (x.stockQty ?? 0) <= 0);
    if (rows.length) F.push({ sev: zero.length ? 3 : 2, title: zero.length ? `${zero.length} مادة نفد رصيدها و${rows.length - zero.length} تحت الحد الأدنى` : `${rows.length} مادة تحت الحد الأدنى`, detail: `منها: ${names(zero.length ? zero : rows, 4)}.`, action: "أنشئ أوامر شراء لها اليوم. نفاد مادة يوقف أصنافاً من المنيو." });
    else good.push("لا توجد مواد تحت الحد الأدنى.");
  }

  const iva = ok("report_ideal_vs_actual");
  if (iva?.totals?.netSales > 0) {
    const t = iva.totals;
    const gap = (t.actualFoodCostPercent ?? 0) - (t.idealFoodCostPercent ?? 0);
    const top = rowsOf(iva).filter((x) => x.varianceValue > 0).sort((a, b) => b.varianceValue - a.varianceValue);
    if (gap >= 2) F.push({ sev: gap >= 5 ? 3 : 2, title: `تكلفة الطعام الفعلية ${fmt.pct(t.actualFoodCostPercent)} مقابل المثالية ${fmt.pct(t.idealFoodCostPercent)}`, detail: `فجوة ${fmt.num(round(gap))} نقطة تعادل تقريباً ${fmt.money(t.actualValue - t.idealValue)}. أكبر الفروقات: ${top.slice(0, 3).map((x) => `${x.name} (${fmt.money(x.varianceValue)})`).join("، ") || "—"}.`, action: "راجع التزام المطبخ بكميات الوصفة لهذه المواد، وسجّل الهدر فور حدوثه، واعمل جرداً لها هذا الأسبوع." });
    else good.push(`تكلفة الطعام الفعلية (${fmt.pct(t.actualFoodCostPercent)}) قريبة من المثالية.`);
    if ((t.actualFoodCostPercent ?? 0) > 35) F.push({ sev: 3, title: `نسبة تكلفة الطعام مرتفعة (${fmt.pct(t.actualFoodCostPercent)})`, detail: "المعدل الصحي للمطاعم عادة بين 28% و35% من صافي المبيعات.", action: "ابدأ بالأصناف الأعلى نسبة تكلفة والأكثر مبيعاً: عدّل الكمية أو السعر أو المورد." });
  }

  const menu = ok("report_menu_profitability");
  const recipes = menu ? rowsOf(menu) : rowsOf(ok("list_recipes"));
  if (recipes.length) {
    const high = recipes.filter((x) => x.priceNet > 0 && x.foodCostPercent >= 35).sort((a, b) => b.foodCostPercent - a.foodCostPercent);
    const missing = recipes.filter((x) => x.missingCost > 0);
    const unsold = menu ? recipes.filter((x) => x.status === "approved" && !x.qtySold) : [];
    if (high.length) F.push({ sev: high[0].foodCostPercent >= 45 ? 3 : 2, title: `${high.length} صنف نسبة تكلفته 35% أو أكثر`, detail: high.slice(0, 3).map((x) => `${x.name} ${fmt.pct(x.foodCostPercent)}`).join("، ") + ".", action: "ارفع السعر، أو قلّل الكمية، أو استبدل أغلى مكوّن. اسألني «ما مكونات <اسم الصنف>؟» لترى أين تذهب التكلفة." });
    else good.push("لا توجد أصناف بنسبة تكلفة مرتفعة.");
    if (missing.length) F.push({ sev: 2, title: `${missing.length} وصفة فيها مكوّنات بلا تكلفة`, detail: `مثل: ${names(missing)}. نسبة تكلفتها المعروضة أقل من الحقيقة.`, action: "استلم مشتريات هذه المواد أو أدخل تكلفتها، حتى تكون الربحية صحيحة." });
    if (unsold.length) F.push({ sev: 1, title: `${unsold.length} صنف لم يُبع خلال ${q.p.label}`, detail: `مثل: ${names(unsold)}.`, action: "راجع وجودها في المنيو: الأصناف الراكدة تزيد الهدر والتعقيد." });
  }

  const waste = ok("report_waste_analysis");
  const sales = iva?.totals?.netSales ?? sum(rowsOf(ok("report_daily_sales")), "netSales");
  if (waste && waste.total > 0) {
    const pct = sales > 0 ? (waste.total / sales) * 100 : null;
    const reason = arr(waste.byReason).sort((a: Data, b: Data) => b.value - a.value)[0];
    const item = arr(waste.byIngredient).sort((a: Data, b: Data) => b.value - a.value)[0];
    F.push({ sev: pct !== null && pct >= 4 ? 3 : pct !== null && pct >= 2 ? 2 : 1, title: `هدر بقيمة ${fmt.money(waste.total)}${pct !== null ? ` (${fmt.pct(pct)} من المبيعات)` : ""}`, detail: `أكبر سبب: ${tr(REASON, reason?.reason)} (${fmt.money(reason?.value)})، وأكثر مادة: ${item?.name ?? "—"} (${fmt.money(item?.value)}).`, action: reason?.reason === "expired" ? "طبّق «الوارد أولاً يصرف أولاً»، وقلّل كميات الطلب لهذه المادة." : reason?.reason === "overproduction" ? "اربط كميات التحضير بمتوسط مبيعات اليوم نفسه من الأسبوع." : "درّب الفريق على السبب الأعلى، وتابعه أسبوعياً." });
  } else if (waste) good.push("لا يوجد هدر مسجل في الفترة. تأكد أن الفريق يسجّله فعلاً.");
  const wasteList = ok("list_waste");
  if (!waste && wasteList && rowsOf(wasteList).length) F.push({ sev: 1, title: `${totalOf(wasteList)} سجل هدر بتكلفة ${fmt.money(sum(rowsOf(wasteList), "totalCost"))}`, detail: "خلال الفترة.", action: "تابع الأسباب المتكررة واطلب تحليل الهدر من المسؤول." });

  const prices = ok("report_purchase_prices");
  if (prices) {
    const up = rowsOf(prices).filter((x) => x.changePercent >= 10).sort((a, b) => b.changePercent - a.changePercent);
    if (up.length) F.push({ sev: up[0].changePercent >= 25 ? 3 : 2, title: `ارتفاع أسعار ${up.length} مادة 10% أو أكثر`, detail: up.slice(0, 3).map((x) => `${x.name} ▲${fmt.pct(x.changePercent)} (${x.lastSupplier ?? "—"})`).join("، ") + ".", action: "فاوض المورد أو اطلب عروضاً من موردين آخرين، وراجع أسعار الأصناف التي تستخدم هذه المواد." });
    else if (rowsOf(prices).length) good.push("لا ارتفاعات كبيرة في أسعار الشراء.");
  }

  const variance = ok("report_stock_variance");
  if (variance && Math.abs(variance.total ?? 0) > 0) F.push({ sev: variance.total < 0 ? 2 : 1, title: `فروقات جرد صافيها ${fmt.money(variance.total)}`, detail: variance.total < 0 ? "عجز: كميات فعلية أقل من المسجلة." : "زيادة: غالباً استلام أو هدر لم يُسجَّل بدقة.", action: "راجع الاستلام والهدر للمواد ذات الفرق الأكبر، واجعل الجرد دورياً للمواد الغالية." });

  const pay = ok("supplier_balances");
  if (pay) {
    const open = rowsOf(pay).filter((x) => x.balance > 0);
    const late = open.filter((x) => isOverdue(x, q.env.today));
    if (late.length) F.push({ sev: 2, title: `${late.length} مورد يُرجَّح تأخر سداده`, detail: `المستحق الإجمالي ${fmt.money(pay.totalOwed)}. منهم: ${names(late)}.`, action: "جدول الدفعات حسب المهلة. التأخر يضعف موقفك في التفاوض على الأسعار." });
    else if (open.length) good.push(`مستحقات الموردين ${fmt.money(pay.totalOwed)} ضمن المهلة.`);
  }
  const approved = ok("list_purchase_orders", (i) => i.status === "approved");
  if (approved && totalOf(approved)) F.push({ sev: 1, title: `${totalOf(approved)} أمر شراء معتمد لم يُستلم`, detail: `بقيمة ${fmt.money(sum(rowsOf(approved), "grandTotal"))}.`, action: "تابع التوريد مع الموردين، واستلم ما وصل حتى يظهر في المخزون والتكلفة." });
  const drafts = ok("list_purchase_orders", (i) => i.status === "draft");
  if (drafts && totalOf(drafts)) F.push({ sev: 1, title: `${totalOf(drafts)} أمر شراء بانتظار الاعتماد`, detail: "", action: "اعتمدها أو ألغها حتى لا يتأخر التوريد." });

  const pendingExp = ok("list_expenses");
  if (pendingExp && totalOf(pendingExp)) F.push({ sev: 1, title: `${totalOf(pendingExp)} مصروف بانتظار الاعتماد`, detail: `بقيمة ${fmt.money(sum(rowsOf(pendingExp), "total"))}.`, action: "اعتمد المصروفات الصحيحة ليظهر صافي الربح الحقيقي." });
  const expRep = ok("report_expenses");
  if (expRep && expRep.netSales > 0 && expRep.expenseRatio >= 30) F.push({ sev: 2, title: `المصروفات التشغيلية ${fmt.pct(expRep.expenseRatio)} من المبيعات`, detail: `${fmt.money(expRep.totalNet)} مقابل مبيعات ${fmt.money(expRep.netSales)}.`, action: "اطلب «المصروفات حسب الفئة» وابدأ بأكبر بند." });

  const recon = ok("report_cashier_reconciliation");
  if (recon) {
    const rows = rowsOf(recon);
    const key = rows[0] && ["overShort", "totalOverShort"].find((k) => k in rows[0]);
    const short = key ? rows.filter((x) => x[key] < 0) : [];
    if (short.length) F.push({ sev: 2, title: `عجز في صندوق ${short.length} كاشير`, detail: `إجمالي العجز ${fmt.money(sum(short, key!))}.`, action: "راجع شفتاتهم ومرتجعاتهم، واطلب عدّ الصندوق في منتصف الشفت." });
  }
  const shifts = ok("list_shifts");
  if (shifts) {
    const old = rowsOf(shifts).filter((x) => x.openedAt && Date.now() - Date.parse(x.openedAt) > 16 * 3_600_000);
    if (old.length) F.push({ sev: 2, title: `${old.length} شفت مفتوح منذ أكثر من 16 ساعة`, detail: `الكاشير: ${old.slice(0, 3).map((x) => x.openedByName).join("، ")}.`, action: "أغلق الشفتات يومياً حتى تكون تسوية النقد دقيقة." });
  }
  const counts = ok("list_stocktakes");
  if (counts) {
    const old = rowsOf(counts).filter((x) => x.createdAt && Date.now() - Date.parse(x.createdAt) > 2 * 86_400_000);
    if (old.length) F.push({ sev: 1, title: `${old.length} جرد مفتوح منذ أكثر من يومين`, detail: "", action: "رحّله أو ألغه. الجرد المعلّق لا يصحح المخزون." });
  }
  const daily = ok("report_daily_sales");
  if (daily) {
    const rows = rowsOf(daily);
    const mid = shiftDays(q.env.today, -6);
    const cur = sum(rows.filter((x) => x.day >= mid), "netSales");
    const prev = sum(rows.filter((x) => x.day < mid), "netSales");
    if (prev > 0) {
      const ch = ((cur - prev) / prev) * 100;
      if (ch <= -10) F.push({ sev: 2, title: `المبيعات انخفضت ${fmt.pct(Math.abs(ch))} عن الأسبوع السابق`, detail: `${fmt.money(cur)} مقابل ${fmt.money(prev)}.`, action: "اطلب «المبيعات حسب القناة» لمعرفة أي قناة تراجعت." });
      else if (ch >= 10) good.push(`المبيعات ارتفعت ${fmt.pct(ch)} عن الأسبوع السابق.`);
    }
  }

  const unread = r.filter((x) => !x.ok).length;
  const n = q.topN ?? 7;
  F.sort((a, b) => b.sev - a.sev);
  const icon = { 3: "🔴", 2: "🟠", 1: "🟡" } as const;
  const body = F.length
    ? `### أهم ما وجدته (مرتب حسب الأولوية)\n${F.slice(0, n).map((f, i) => `${i + 1}. ${icon[f.sev]} **${f.title}**${f.detail ? `: ${f.detail}` : ""}\n   **الإجراء:** ${f.action}`).join("\n")}`
    : "لم أجد مشاكل واضحة في البيانات التي أستطيع الاطلاع عليها. ✅";
  const scope = [...new Set(r.map((x) => TOOL_AREA[x.name]).filter(Boolean))].join("، ");
  return `## تحليل «${q.env.company}» (${q.p.label})\nراجعت ${r.length} مصدر بيانات ضمن صلاحياتك: ${scope}.\n\n${body}${good.length ? `\n\n### نقاط جيدة\n${good.map((g) => `- ${g}`).join("\n")}` : ""}${F.length > n ? `\n\nوهناك ${F.length - n} ملاحظة أخرى أقل أولوية.` : ""}${unread ? `\n\n(تعذّرت قراءة ${unread} مصدر.)` : ""}`;
}

const TOOL_AREA: Record<string, string> = {
  search_ingredients: "المخزون", report_ideal_vs_actual: "تكلفة الطعام", report_menu_profitability: "ربحية المنيو", list_recipes: "الوصفات", report_waste_analysis: "الهدر", list_waste: "الهدر",
  report_purchase_prices: "أسعار الشراء", report_stock_variance: "الجرد", supplier_balances: "الموردون", list_purchase_orders: "المشتريات", list_expenses: "المصروفات", report_expenses: "المصروفات",
  report_cashier_reconciliation: "الكاشير", report_daily_sales: "المبيعات", list_stocktakes: "الجرد", list_shifts: "الشفتات",
};
