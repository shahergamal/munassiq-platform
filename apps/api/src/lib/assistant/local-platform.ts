import { fmt, shiftDays, table } from "./arabic.ts";

/**
 * The built-in engine's platform-administration vocabulary: intents over the admin API tools (platform_*) and a
 * rule-based diagnosis of the platform (renewals at risk, trials, dormant customers, upsell, demand).
 * Shapes and helpers are passed in by local.ts so both files share one engine.
 */

type Data = any;
interface Call { name: string; input: Record<string, unknown> }
interface Result { name: string; input: Record<string, unknown>; ok: boolean; data: Data; error?: string }
interface Plan { stages: ((r: Result[]) => Call[])[]; answer: (r: Result[]) => string; file?: { source: string; input: Record<string, unknown>; title: string }; title?: string }
interface Q { t: { norm: string }; offered: Set<string>; entity: string; entityRaw: string; p: { from: string; to: string; label: string }; period: unknown; env: { today: string }; topN: number | null }
export interface Helpers {
  get: (r: Result[], name: string, pred?: (i: Record<string, unknown>) => boolean) => Result | undefined;
  rowsOf: (d: Data) => Data[];
  totalOf: (d: Data) => number;
  arr: (v: Data) => Data[];
  failed: (res: Result | undefined, what: string) => string | null;
  listAnswer: (title: string, res: Result | undefined, cols: [string, string | string[], ((v: Data, row: Data) => string)?][], opts: { empty: string; limit?: number; lead?: (rows: Data[], d: Data) => string }) => string;
  searchStages: (tool: string, key: string, base: Record<string, unknown>, entity: string | string[]) => ((r: Result[]) => Call[])[];
  bestMatch: (rows: Data[], entity: string, key?: string) => Data | null;
  candidates: (q: { entity: string; entityRaw: string }) => string[];
}

const SUB: Record<string, string> = { trial: "تجربة", active: "نشط", expired: "منتهٍ", suspended: "معلّق" };
const TENANT: Record<string, string> = { active: "نشطة", blocked: "موقوفة", archived: "مؤرشفة" };
const USER: Record<string, string> = { active: "نشط", suspended: "موقوف", pending: "بانتظار التفعيل" };
const ROLE: Record<string, string> = { owner: "المالك", manager: "مدير", accountant: "محاسب", inventory_clerk: "أمين مخزن", cashier: "كاشير", custom: "دور مخصص" };
const tr = (m: Record<string, string>, v: unknown) => (typeof v === "string" ? m[v] ?? v : "—");
const has = (q: Q, tool: string) => q.offered.has(tool);
const one = (calls: Call[], answer: (r: Result[]) => string, file?: Plan["file"]): Plan => ({ stages: [() => calls], answer, ...(file ? { file } : {}) });

export interface PlatformIntent { id: string; words: [string, number][]; weak?: boolean; example?: string; build: (q: Q, h: Helpers) => Plan | null }

export const PLATFORM_INTENTS: PlatformIntent[] = [
  { id: "p_stats", example: "أعطني ملخص المنصة", words: [["ملخص المنصه", 6], ["احصائيات", 5], ["نظره عامه", 5], ["كم عميل", 5], ["عدد العملاء", 5], ["عدد المنشات", 5], ["كم منشاه", 5], ["وضع المنصه", 5], ["المنصه", 2]],
    build: (q, h) => (has(q, "platform_stats") ? one([{ name: "platform_stats", input: {} }], (r) => {
      const res = h.get(r, "platform_stats");
      const bad = h.failed(res, "ملخص المنصة");
      if (bad) return bad;
      const s = res!.data;
      return `**ملخص المنصة الآن:**\n\n${table(["المؤشر", "العدد"], [
        ["منشآت نشطة", fmt.num(s.activeTenants)], ["منشآت موقوفة", fmt.num(s.blockedTenants)], ["المستخدمون", fmt.num(s.users)],
        ["اشتراكات مدفوعة سارية", fmt.num(s.paidActive)], ["تجارب جارية", fmt.num(s.runningTrials)], ["تنتهي خلال 7 أيام", fmt.num(s.expiringSoon)], ["قائمة الانتظار", fmt.num(s.waitlist)],
      ])}`;
    }) : null) },

  { id: "p_subs", example: "ما الاشتراكات التي تنتهي خلال 30 يوماً؟", words: [["اشتراك", 4], ["اشتراكات", 5], ["تنتهي", 4], ["ينتهي", 4], ["انتهاء", 4], ["تجديد", 4], ["تجارب", 3], ["تجريبي", 3], ["منتهيه", 3], ["هتخلص", 4]],
    build: (q, h) => {
      if (!has(q, "platform_subscriptions")) return null;
      const n = q.t.norm;
      const expiring = /(تنتهي|ينتهي|انتهاء|قرب|تجديد|هتخلص|هيخلص|قريبا)/.test(n);
      const status = /تجرب|تجريبي/.test(n) ? "trial" : !expiring && /منتهي/.test(n) ? "expired" : /(معلق|موقوف)/.test(n) ? "suspended" : undefined;
      const input: Record<string, unknown> = { ...(expiring ? { expiring: "true" } : {}), ...(status ? { status } : {}), ...(q.entity ? { q: q.entity } : {}) };
      const title = expiring ? "اشتراكات تنتهي خلال 30 يوماً" : `الاشتراكات${status ? ` (${SUB[status]})` : ""}`;
      return one([{ name: "platform_subscriptions", input }], (r) => h.listAnswer(title, h.get(r, "platform_subscriptions"),
        [["المنشأة", "companyName"], ["الباقة", "planName"], ["الحالة", "status", (v) => tr(SUB, v)], ["ينتهي", "endsAt"], ["متبقٍ", "daysLeft", (v) => `${fmt.num(v)} يوم`], ["القيمة", "totalValue", (v) => fmt.money(v)]],
        { empty: expiring ? "لا توجد اشتراكات تنتهي خلال 30 يوماً. ✅" : "لا توجد اشتراكات مطابقة.", limit: 15, lead: (_rows, d) => {
          const s = d.summary ?? {};
          return `**${title}:** ${fmt.num(h.totalOf(d))}.\nعلى مستوى المنصة: ${fmt.num(s.active)} مدفوع ساري، ${fmt.num(s.trial)} تجربة، ${fmt.num(s.expiring)} ينتهي خلال 30 يوماً، ${fmt.num(s.lapsed)} متوقف أو منتهٍ.`;
        } }), { source: "platform_subscriptions", input, title });
    } },

  { id: "p_financial", example: "ما الإيراد الشهري المتكرر وتوزيعه على الباقات؟", words: [["ايراد", 5], ["ايرادات", 5], ["mrr", 6], ["مالي", 4], ["التقرير المالي", 6], ["فلوس", 3], ["دخل المنصه", 5], ["عقود", 4], ["مبيعات الاشتراكات", 6]],
    build: (q, h) => (has(q, "platform_financial") ? one([{ name: "platform_financial", input: { from: q.p.from, to: q.p.to } }], (r) => {
      const res = h.get(r, "platform_financial");
      const bad = h.failed(res, "التقرير المالي");
      if (bad) return bad;
      const d = res!.data;
      const s = d.summary ?? {};
      const plans = h.arr(d.byPlan).filter((x: Data) => x.active || x.trials);
      return `**الإيراد الشهري المتكرر (MRR): ${fmt.money(s.mrr)}** من ${fmt.num(s.activePaid)} اشتراك مدفوع، و${fmt.num(s.runningTrials)} تجربة جارية.\nتجديدات مستحقة خلال 30 يوماً: ${fmt.num(s.renewalsDue)} بقيمة ${fmt.money(s.renewalsMrr)} شهرياً.\nعقود ${q.p.label}: ${fmt.num(s.contracts)} بقيمة ${fmt.money(s.contractsValue)}.${plans.length ? `\n\n${table(["الباقة", "القطاع", "السعر الشهري", "مدفوع", "تجارب", "MRR"], plans.map((x: Data) => [x.planName, x.sectorName, fmt.money(x.monthlyPrice), fmt.num(x.active), fmt.num(x.trials), fmt.money(x.mrr)]))}` : ""}`;
    }) : null) },

  { id: "p_operations", example: "ما المنشآت الخاملة ونسبة التحويل من التجربة؟", words: [["تشغيلي", 5], ["التقرير التشغيلي", 6], ["خامل", 5], ["خاملين", 5], ["خامله", 5], ["نسبه التحويل", 6], ["تحويل", 3], ["مستخدمين جدد", 5], ["منشات جديده", 5], ["عملاء جدد", 5], ["جلسات الدعم", 5], ["نمو", 3]],
    build: (q, h) => (has(q, "platform_operations") ? one([{ name: "platform_operations", input: { from: q.p.from, to: q.p.to } }], (r) => {
      const res = h.get(r, "platform_operations");
      const bad = h.failed(res, "التقرير التشغيلي");
      if (bad) return bad;
      const s = res!.data.summary ?? {};
      const days = h.arr(res!.data.daily).filter((x: Data) => x.tenants || x.users).slice(0, 10);
      const conv = s.trialsStarted ? (s.converted / s.trialsStarted) * 100 : null;
      return `**التقرير التشغيلي ${q.p.label}:**\n\n${table(["المؤشر", "العدد"], [
        ["منشآت جديدة", fmt.num(s.newTenants)], ["تجارب بدأت", fmt.num(s.trialsStarted)], ["تحولت لاشتراك مدفوع", `${fmt.num(s.converted)}${conv !== null ? ` (${fmt.pct(conv)})` : ""}`],
        ["منشآت نشطة", fmt.num(s.activeTenants)], ["منشآت خاملة (بلا دخول 14 يوماً)", fmt.num(s.dormantTenants)], ["منشآت موقوفة", fmt.num(s.blockedTenants)],
        ["مستخدمون جدد", fmt.num(s.newUsers)], ["مستخدمون نشطون (14 يوماً)", fmt.num(s.activeUsers14)], ["مستخدمون موقوفون", fmt.num(s.suspendedUsers)],
        ["جلسات دعم", fmt.num(s.supportSessions)], ["تسجيلات قائمة الانتظار", fmt.num(s.waitlist)],
      ])}${days.length ? `\n\n### أيام النشاط\n${table(["اليوم", "منشآت جديدة", "مستخدمون جدد"], days.map((x: Data) => [x.day, fmt.num(x.tenants), fmt.num(x.users)]))}` : ""}`;
    }) : null) },

  { id: "p_usage", example: "ما المنشآت القريبة من حدود باقتها؟", words: [["استهلاك", 5], ["حدود الباقه", 6], ["الحدود", 4], ["قريب من الحد", 6], ["قريبه من الحد", 6], ["تجاوز", 3], ["ترقيه", 4], ["upsell", 4]],
    build: (q, h) => {
      if (!has(q, "platform_usage")) return null;
      const near = /(قريب|تجاوز|وصل|ترقيه|upsell|80)/.test(q.t.norm);
      const input: Record<string, unknown> = { ...(near ? { near: "true" } : {}), ...(q.entity ? { q: q.entity } : {}) };
      return one([{ name: "platform_usage", input }], (r) => h.listAnswer(near ? "منشآت عند 80% من حدودها أو أكثر" : "استهلاك الحدود", h.get(r, "platform_usage"),
        [["المنشأة", "companyName"], ["الباقة", "planName"], ["الفروع", "branchesUsed", (v, x) => `${fmt.num(v)} من ${fmt.num(x.branchesLimit)}`], ["المستخدمون", "usersUsed", (v, x) => `${fmt.num(v)} من ${fmt.num(x.usersLimit)}`], ["المواقع", "locations"], ["الذروة", "peak", (v) => fmt.pct(v)]],
        { empty: near ? "لا توجد منشآت قريبة من حدودها. ✅" : "لا توجد منشآت.", limit: 15 }), { source: "platform_usage", input, title: "استهلاك الحدود" });
    } },

  { id: "p_users", weak: true, example: "ابحث عن مستخدم بالبريد", words: [["مستخدمين", 5], ["مستخدم", 4], ["حسابات", 4], ["يوزر", 4], ["users", 4]],
    build: (q, h) => {
      if (!has(q, "platform_users")) return null;
      const input = q.entity ? { q: q.entity } : {};
      return one([{ name: "platform_users", input }], (r) => h.listAnswer("المستخدمون", h.get(r, "platform_users"),
        [["الاسم", "fullName"], ["البريد", "email"], ["الحالة", "status", (v) => tr(USER, v)], ["آخر دخول", "lastLoginAt", (v) => (v ? fmt.date(v) : "لم يدخل")], ["المنشآت", "tenantsCount"], ["مدير منصة", "isPlatformAdmin", (v) => (v ? "نعم" : "—")]],
        { empty: q.entity ? `لا يوجد مستخدم يطابق «${q.entity}».` : "لا يوجد مستخدمون.", limit: 15 }), { source: "platform_users", input, title: "المستخدمون" });
    } },

  { id: "p_plans", example: "ما الباقات وكم منشأة على كل باقة؟", words: [["باقات", 5], ["باقه", 4], ["اسعار الباقات", 6], ["خطط الاشتراك", 5]],
    build: (q, h) => (has(q, "platform_plans") ? one([{ name: "platform_plans", input: {} }], (r) => h.listAnswer("الباقات", h.get(r, "platform_plans"),
      [["الباقة", "nameAr"], ["القطاع", "sectorName"], ["شهري", "monthlyPrice", (v) => fmt.money(v)], ["سنوي", "annualPrice", (v) => (v ? fmt.money(v) : "—")], ["الفروع", "branchesLimit"], ["المستخدمون", "usersLimit"], ["المنشآت", "tenantsCount"], ["منشورة", "isPublic", (v) => (v ? "نعم" : "لا")]],
      { empty: "لا توجد باقات.", limit: 20 }), { source: "platform_plans", input: {}, title: "الباقات" }) : null) },

  { id: "p_sectors", words: [["قطاعات", 5], ["قطاع", 4]],
    build: (q, h) => (has(q, "platform_sectors") ? one([{ name: "platform_sectors", input: {} }], (r) => h.listAnswer("القطاعات", h.get(r, "platform_sectors"),
      [["القطاع", "nameAr"], ["متاح", "isAvailable", (v) => (v ? "نعم" : "قريباً")], ["منشآت نشطة", "activeTenants"], ["الباقات", "plans"], ["قائمة الانتظار", "waitlist"], ["آخر 30 يوماً", "waitlist30"]],
      { empty: "لا توجد قطاعات." }), { source: "platform_sectors", input: {}, title: "القطاعات" }) : null) },

  { id: "p_audit", example: "ما آخر العمليات في سجل التدقيق؟", words: [["سجل التدقيق", 6], ["تدقيق", 5], ["audit", 5], ["سجل العمليات", 5], ["اخر العمليات", 5], ["مين عمل", 4], ["مين غير", 4]],
    build: (q, h) => (has(q, "platform_audit") ? one([{ name: "platform_audit", input: {} }], (r) => h.listAnswer("سجل التدقيق", h.get(r, "platform_audit"),
      [["الوقت", "at", (v) => (v ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh", dateStyle: "short", timeStyle: "short" }).format(new Date(v)) : "—")], ["العملية", "action"], ["النوع", "entityType"], ["المنفّذ", "actorEmail"]],
      { empty: "سجل التدقيق فارغ.", limit: 20 }), { source: "platform_audit", input: {}, title: "سجل التدقيق" }) : null) },

  { id: "p_waitlist", example: "من في قائمة الانتظار؟", words: [["قائمه الانتظار", 6], ["انتظار", 4], ["مهتمين", 4], ["waitlist", 5]],
    build: (q, h) => (has(q, "platform_waitlist") ? one([{ name: "platform_waitlist", input: {} }], (r) => h.listAnswer("قائمة الانتظار", h.get(r, "platform_waitlist"),
      [["الشركة", "companyName"], ["القطاع", "sector"], ["البريد", "email"], ["الجوال", "phone"], ["التاريخ", "createdAt"]],
      { empty: "قائمة الانتظار فارغة.", limit: 15 }), { source: "platform_waitlist", input: {}, title: "قائمة الانتظار" }) : null) },

  { id: "p_settings", words: [["اعدادات المنصه", 6], ["مده التجربه", 6], ["الضريبه الافتراضيه", 6], ["الاعدادات", 3]],
    build: (q, h) => (has(q, "platform_settings") ? one([{ name: "platform_settings", input: {} }], (r) => {
      const res = h.get(r, "platform_settings");
      const bad = h.failed(res, "إعدادات المنصة");
      if (bad) return bad;
      const s = res!.data.settings ?? {};
      return `**إعدادات المنصة للمنشآت الجديدة:**\n\n${table(["الإعداد", "القيمة"], [["مدة التجربة", `${fmt.num(s.trialDays)} يوم`], ["نسبة الضريبة الافتراضية", fmt.pct(s.defaultVatPercent)], ["حد الخصم الافتراضي", fmt.pct(s.defaultDiscountApprovalPercent)]])}${res!.data.updatedBy ? `\n\nآخر تعديل بواسطة ${res!.data.updatedBy}.` : ""}`;
    }) : null) },

  { id: "p_tenants", weak: true, example: "تفاصيل منشأة مطعم البيت", words: [["منشات", 4], ["منشاه", 3], ["عملاء", 4], ["عميل", 3], ["مشتركين", 4], ["شركات", 3], ["موقوفه", 3], ["محظور", 3]],
    build: (q, h) => {
      if (!has(q, "platform_tenants")) return null;
      const n = q.t.norm;
      const status = /(موقوف|محظور|مقفول|ايقاف|بلوك)/.test(n) ? "blocked" : /مؤرشف|مارشف/.test(n) ? "archived" : undefined;
      if (q.entity && has(q, "platform_tenant_detail")) {
        return {
          stages: [...h.searchStages("platform_tenants", "q", {}, h.candidates(q)), (r) => {
            const hit = h.bestMatch(h.rowsOf(h.get(r, "platform_tenants")?.data), q.entity, "companyName");
            return hit ? [{ name: "platform_tenant_detail", input: { id: hit.id } }] : [];
          }],
          answer: (r) => tenantDetail(q, h, r),
          title: `منشأة ${q.entity}`,
        };
      }
      const input = status ? { status } : {};
      const title = `المنشآت${status ? ` (${TENANT[status]})` : ""}`;
      return one([{ name: "platform_tenants", input }], (r) => h.listAnswer(title, h.get(r, "platform_tenants"),
        [["المنشأة", "companyName"], ["المالك", "ownerEmail"], ["الباقة", "planName"], ["الاشتراك", "subscriptionStatus", (v) => tr(SUB, v)], ["ينتهي", "endsAt"], ["الحالة", "status", (v) => tr(TENANT, v)]],
        { empty: "لا توجد منشآت مطابقة.", limit: 15 }), { source: "platform_tenants", input, title });
    } },
];

function tenantDetail(q: Q, h: Helpers, r: Result[]) {
  const res = h.get(r, "platform_tenant_detail");
  if (!res) return `لم أجد منشأة تطابق «${q.entity}».`;
  const bad = h.failed(res, "تفاصيل المنشأة");
  if (bad) return bad;
  const t = res.data;
  const limit = t.assistantOverride ?? t.assistantDefault;
  const members = h.arr(t.members);
  return `**${t.companyName}** (${tr(TENANT, t.status)})${t.city ? `، ${t.city}` : ""}\n\n${table(["البند", "القيمة"], [
    ["المالك", `${t.ownerName ?? ""} ${t.ownerEmail ? `(${t.ownerEmail})` : ""}`.trim()], ["الرقم الضريبي", `${t.taxId ?? "—"}${t.taxIdVerified ? " (موثّق)" : ""}`],
    ["الباقة", t.planName ?? "—"], ["الاشتراك", `${tr(SUB, t.subscriptionStatus)} من ${t.startsAt ?? "—"} إلى ${t.endsAt ?? "—"}`], ["قيمة العقد", fmt.money(t.totalValue)],
    ["الفروع", `${fmt.num(t.branchesUsed)} من ${fmt.num(t.branchesLimit)}`], ["المستخدمون", `${fmt.num(t.usersUsed)} من ${fmt.num(t.usersLimit)}`],
    ["حد المساعد اليومي لكل عضو", limit === 0 ? "موقوف" : `${fmt.num(limit)}${t.assistantOverride === null || t.assistantOverride === undefined ? " (الافتراضي)" : ""}`],
    ["أسئلة المساعد اليوم / آخر 30 يوماً", `${fmt.num(t.assistantTurnsToday)} / ${fmt.num(t.assistantTurns30)}`],
    ...(t.blockedReason ? [["سبب الإيقاف", t.blockedReason]] : []),
  ])}${members.length ? `\n\n### الأعضاء (${members.length})\n${table(["الاسم", "البريد", "الدور", "نشط"], members.map((m: Data) => [m.fullName, m.email, m.roleName ?? tr(ROLE, m.role), m.isActive ? "نعم" : "لا"]))}` : ""}\n\nلا أطّلع على بيانات المنشأة الداخلية (المبيعات والمخزون والتكاليف). تحتاج لذلك جلسة دعم مؤقتة ومدققة من صفحة المنشأة.`;
}

// ── Platform diagnosis ───────────────────────────────────────────────────────────────────────
export function buildPlatformInsights(q: Q, h: Helpers): Plan | null {
  const calls: Call[] = [];
  const add = (name: string, input: Record<string, unknown> = {}) => { if (has(q, name)) calls.push({ name, input }); };
  add("platform_stats");
  add("platform_subscriptions", { expiring: "true" });
  add("platform_usage", { near: "true" });
  add("platform_operations", { from: q.p.from, to: q.p.to });
  add("platform_financial", { from: q.p.from, to: q.p.to });
  add("platform_sectors");
  if (!calls.length) return null;
  return { stages: [() => calls], title: "تحليل المنصة", answer: (r) => {
    const F: { sev: 1 | 2 | 3; title: string; detail: string; action: string }[] = [];
    const good: string[] = [];
    const ok = (name: string) => { const x = h.get(r, name); return x?.ok ? x.data : null; };

    const subs = ok("platform_subscriptions");
    if (subs) {
      const rows = h.rowsOf(subs);
      const week = rows.filter((x) => x.daysLeft <= 7);
      const trials = rows.filter((x) => x.status === "trial");
      if (week.length) F.push({ sev: 3, title: `${week.length} اشتراك ينتهي خلال 7 أيام`, detail: week.slice(0, 4).map((x) => `${x.companyName} (${fmt.num(x.daysLeft)} يوم)`).join("، ") + ".", action: "تواصل معهم اليوم للتجديد، وابدأ بالمدفوعين قبل التجارب." });
      if (trials.length) F.push({ sev: 2, title: `${trials.length} تجربة تنتهي خلال 30 يوماً`, detail: trials.slice(0, 4).map((x) => x.companyName).join("، ") + ".", action: "اعرض عليهم مكالمة تهيئة وعرض تحويل قبل نهاية التجربة." });
      if (!rows.length) good.push("لا اشتراكات تنتهي خلال 30 يوماً.");
    }
    const fin = ok("platform_financial");
    if (fin?.summary) {
      const s = fin.summary;
      if (s.renewalsMrr > 0) F.push({ sev: 2, title: `إيراد شهري ${fmt.money(s.renewalsMrr)} على المحك`, detail: `${fmt.num(s.renewalsDue)} اشتراك مدفوع يستحق التجديد خلال 30 يوماً من أصل MRR ${fmt.money(s.mrr)}.`, action: "جهّز حملة تجديد مبكر، مع خصم للدفع السنوي." });
      if (s.mrr > 0) good.push(`الإيراد الشهري المتكرر ${fmt.money(s.mrr)} من ${fmt.num(s.activePaid)} اشتراك مدفوع.`);
    }
    const ops = ok("platform_operations");
    if (ops?.summary) {
      const s = ops.summary;
      if (s.dormantTenants > 0) F.push({ sev: 2, title: `${fmt.num(s.dormantTenants)} منشأة خاملة (بلا دخول 14 يوماً)`, detail: "المنشأة التي لا تستخدم النظام لا تجدد غالباً.", action: "اطلب قائمتها من شاشة المنشآت، وتواصل معها بمكالمة نجاح عملاء." });
      if (s.trialsStarted >= 3) {
        const conv = (s.converted / s.trialsStarted) * 100;
        if (conv < 20) F.push({ sev: 2, title: `نسبة التحويل من التجربة ${fmt.pct(conv)}`, detail: `${fmt.num(s.converted)} تحول من ${fmt.num(s.trialsStarted)} تجربة ${q.p.label}.`, action: "راجع أول تجربة للعميل: الاستيراد من Excel، ومكالمة ترحيب في اليوم الثاني." });
        else good.push(`نسبة التحويل من التجربة ${fmt.pct(conv)}.`);
      }
      if (s.suspendedUsers > 0) F.push({ sev: 1, title: `${fmt.num(s.suspendedUsers)} مستخدم موقوف`, detail: "", action: "راجع أسباب الإيقاف وأعد تفعيل من انتهت مشكلته." });
      if (s.blockedTenants > 0) F.push({ sev: 1, title: `${fmt.num(s.blockedTenants)} منشأة موقوفة`, detail: "", action: "راجع أسباب الإيقاف: السداد المتأخر يُحل بتجديد، والمخالفة تبقى موقوفة." });
    }
    const usage = ok("platform_usage");
    if (usage) {
      const rows = h.rowsOf(usage);
      if (rows.length) F.push({ sev: 1, title: `${rows.length} منشأة عند 80% من حدود باقتها`, detail: rows.slice(0, 4).map((x) => `${x.companyName} (${fmt.pct(x.peak)})`).join("، ") + ".", action: "فرصة ترقية: اعرض عليها الباقة الأعلى قبل أن يوقفها الحد." });
    }
    const sectors = ok("platform_sectors");
    if (sectors) {
      const demand = h.rowsOf(sectors).filter((x) => !x.isAvailable && x.waitlist30 >= 3).sort((a, b) => b.waitlist30 - a.waitlist30);
      if (demand.length) F.push({ sev: 1, title: `طلب على قطاعات غير متاحة`, detail: demand.slice(0, 3).map((x) => `${x.nameAr}: ${fmt.num(x.waitlist30)} تسجيل آخر 30 يوماً`).join("، ") + ".", action: "قدّم أولوية تطوير القطاع الأعلى طلباً." });
    }
    const n = q.topN ?? 7;
    F.sort((a, b) => b.sev - a.sev);
    const icon = { 3: "🔴", 2: "🟠", 1: "🟡" } as const;
    const body = F.length ? `### أهم ما وجدته (مرتب حسب الأولوية)\n${F.slice(0, n).map((f, i) => `${i + 1}. ${icon[f.sev]} **${f.title}**${f.detail ? `: ${f.detail}` : ""}\n   **الإجراء:** ${f.action}`).join("\n")}` : "لا توجد مشاكل واضحة في المنصة الآن. ✅";
    return `## تحليل المنصة (${q.p.label})\n\n${body}${good.length ? `\n\n### نقاط جيدة\n${good.map((g) => `- ${g}`).join("\n")}` : ""}`;
  } };
}

export const platformExamples = () => PLATFORM_INTENTS.filter((i) => i.example).map((i) => i.example!);
