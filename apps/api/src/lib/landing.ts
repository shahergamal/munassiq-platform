import { z } from "zod";

// Public landing page content. The platform admin edits it; the page reads it (merged over these defaults).
// Every string is bounded and every link is restricted to safe schemes, because the page renders them as hrefs.

const text = (max: number) => z.string().trim().max(max);
const line = text(160);
const para = text(600);
const url = z.string().trim().max(300).refine(
  (v) => v === "" || /^(#[\w-]*|\/[\w\-/]*|https:\/\/[^\s"'<>]+|mailto:[^\s"'<>]+|tel:\+?[\d\s-]+)$/.test(v),
  "رابط غير صالح: استخدم #قسم أو /صفحة أو https:// أو mailto: أو tel:",
);
const item = z.object({ title: line, description: para });
const link = z.object({ label: text(60), url });
const policy = z.object({ title: line, summary: para, body: text(20000) });

export const landingSchema = z.object({
  // The bar above the header (an offer or news). An empty title hides it.
  announcement: z.object({ title: line, text: text(200), action: text(40), url }),
  navigation: z.object({ features: text(40), why: text(40), useCases: text(40), pricing: text(40), faq: text(40), signIn: text(40), trial: text(60) }),
  hero: z.object({ badge: text(80), title: line, highlight: line, description: para, primaryAction: text(60), secondaryAction: text(60), trustItems: z.array(text(60)).max(6), note: text(120) }),
  // The moving strip under the hero: what the product works with (never customer logos we have no permission for).
  integrations: z.object({ title: line, items: z.array(text(40)).max(24) }),
  sectors: z.object({
    eyebrow: text(80), title: line, description: para, availableLabel: text(40), comingSoonLabel: text(40), waitlistAction: text(60),
    items: z.array(z.object({ id: z.enum(["restaurants", "manufacturing", "contracting"]), label: line, description: para })).max(3),
  }),
  preview: z.object({
    title: line, note: text(120),
    metrics: z.array(z.object({ label: text(60), value: text(40) })).max(4),
    listTitle: text(80),
    list: z.array(z.object({ label: text(60), meta: text(80), tag: text(30) })).max(5),
  }),
  features: z.object({ eyebrow: text(80), title: line, description: para, items: z.array(item).max(8) }),
  // The phone section: the app as it looks on a phone, next to these points.
  mobileApp: z.object({ eyebrow: text(80), title: line, description: para, points: z.array(text(80)).max(6) }),
  why: z.object({ eyebrow: text(80), title: line, description: para, items: z.array(item).max(6) }),
  useCases: z.object({ eyebrow: text(80), title: line, items: z.array(item).max(6) }),
  pricing: z.object({ eyebrow: text(80), title: line, description: para, note: para, monthly: text(30), yearly: text(30), empty: para }),
  faq: z.object({ eyebrow: text(80), title: line, description: para, items: z.array(z.object({ question: line, answer: text(1200) })).max(20) }),
  cta: z.object({ eyebrow: text(80), title: line, description: para }),
  footer: z.object({
    description: para, exploreTitle: text(40), exploreLinks: z.array(link).max(8), sectorsTitle: text(40), sectorLinks: z.array(link).max(8),
    contactTitle: text(40), phone: text(30), email: text(120), address: text(160), linkedin: url, instagram: url, whatsapp: url, copyright: text(120),
  }),
  policies: z.object({ privacy: policy, terms: policy, security: policy }),
});
export type LandingContent = z.infer<typeof landingSchema>;

export const defaultLanding: LandingContent = {
  announcement: { title: "جديد: قطاع المقاولات", text: "المشاريع والعقود وجداول الكميات، والمستخلصات بفاتورتها الإلكترونية مع المحتجزات واسترداد الدفعة المقدمة وغرامات التأخير، وأوامر التغيير والضمانات البنكية.", action: "اعرف أكثر", url: "#sectors" },
  navigation: { features: "المميزات", why: "لماذا مُنَسِّق", useCases: "حالات الاستخدام", pricing: "الباقات", faq: "الأسئلة الشائعة", signIn: "تسجيل الدخول", trial: "ابدأ تجربتك المجانية" },
  hero: {
    badge: "جاهز للمرحلة الثانية للفوترة الإلكترونية، اضغط لمعرفة المزيد", title: "نظام تكاليف ومحاسبة وفوترة إلكترونية", highlight: "للمطاعم والمصانع والمقاولات في السعودية",
    description: "منصة عربية واحدة للمشتريات والمخزون والتكاليف والحسابات والرواتب: تكلفة كل طبق في مطعمك، وتكلفة كل منتج وأمر إنتاج في مصنعك، وربحية كل مشروع ومستخلص في شركة المقاولات، بقيود محاسبية تلقائية وفوترة إلكترونية مبنية وفق مواصفات هيئة الزكاة والضريبة والجمارك.",
    primaryAction: "ابدأ الآن مجاناً", secondaryAction: "شاهد الباقات", trustItems: ["فوترة إلكترونية بالمرحلتين", "قيود محاسبية تلقائية", "رواتب وتأمينات اجتماعية", "بيانات كل منشأة معزولة", "عربية بالكامل"],
    note: "تجربة مجانية كاملة المزايا - بدون بطاقة ائتمان",
  },
  integrations: {
    title: "يعمل مع أدوات عملك اليومية",
    items: ["منصة فاتورة (ZATCA)", "مدى", "Apple Pay", "فيزا وماستركارد", "ميسّر", "تاب", "Excel", "أجهزة الباركود", "تطبيقات التوصيل", "طابعات الكاشير", "رمز QR الضريبي", "المساعد الذكي", "التقارير المالية", "ملفات الرواتب البنكية", "جداول الكميات من Excel"],
  },
  sectors: {
    eyebrow: "اختر مجال عملك", title: "نظام يتكيف مع قطاعك",
    description: "كل قطاع يرى صفحاته وحساباته ومصطلحاته فقط: المطعم لا يرى أوامر الإنتاج، والمصنع لا يرى شاشة الكاشير، والمقاول يرى مشاريعه ومستخلصاته. والقطاعات الثلاثة متاحة للتسجيل الآن.",
    availableLabel: "متاح الآن", comingSoonLabel: "قريباً", waitlistAction: "سجّل اهتمامك",
    items: [
      { id: "restaurants", label: "إدارة تكاليف المطاعم", description: "الوصفات والهدر والمشتريات والمخزون والكاشير وشاشة المطبخ، وربحية كل وجبة." },
      { id: "manufacturing", label: "إدارة تكاليف التصنيع", description: "قوائم المواد وأوامر الإنتاج بتكلفتها الفعلية، وتخطيط الاحتياجات وجدولة الإنتاج، والجودة وتتبع التشغيلات، والصيانة وكفاءة المعدات، وعروض الأسعار وأوامر البيع." },
      { id: "contracting", label: "إدارة تكاليف المقاولات", description: "المشاريع والعقود وجداول الكميات، والمستخلصات بفاتورتها الإلكترونية مع المحتجزات واسترداد الدفعة المقدمة، وأوامر التغيير والمطالبات والضمانات البنكية، وكل مشروع مركز تكلفة." },
    ],
  },
  preview: {
    title: "لوحة المتابعة", note: "صورة توضيحية بأرقام افتراضية",
    metrics: [{ label: "مبيعات الشهر", value: "418,420.00" }, { label: "قيمة المخزون", value: "126,265.40" }, { label: "مجمل الربح", value: "31.6%" }],
    listTitle: "آخر العمليات",
    list: [{ label: "استلام #GRN-218", meta: "10:40 ص · 6 أصناف", tag: "خامات" }, { label: "تحويل #TR-093", meta: "11:15 ص · إلى صالة الإنتاج", tag: "مخزون" }, { label: "فاتورة #INV-1042", meta: "12:25 م · عميل منشأة", tag: "ضريبية" }],
  },
  features: {
    eyebrow: "من الرقم إلى القرار", title: "دقة محاسبية تمتد لكل عملية",
    description: "المشتريات والمخزون والإنتاج والمبيعات تتجمع في مصدر واحد، وكل عملية ترحّل قيدها في اللحظة نفسها، فتبقى النتيجة دقيقة مهما تعددت الفروع والمستودعات.",
    items: [
      { title: "تكلفة محسوبة في الخادم", description: "متوسط مرجح وتكلفة واصلة (شحن ورسوم) وضريبة تُحسب مركزياً، لا في المتصفح." },
      { title: "مخزون لكل نوع في حسابه", description: "الخامات ونصف المصنّع والمنتج التام ومواد التعبئة وقطع الغيار، كلٌّ في حساب مخزونه في الميزانية." },
      { title: "مراكز تكلفة وسنة مالية مرنة", description: "حلّل الإيرادات والمصروفات بخط الإنتاج أو القسم، وابدأ سنتك المالية في أي شهر." },
      { title: "تشغيلات وصلاحية", description: "رقم التشغيلة وتاريخ الانتهاء لكل استلام، ويُصرف الأقرب انتهاءً أولاً تلقائياً." },
      { title: "رواتب وتأمينات اجتماعية", description: "الموظفون والحضور والإجازات، ومسير رواتب بالتأمينات ومكافأة نهاية الخدمة، يُرحّل قيده على مراكز التكلفة." },
      { title: "عزل كامل للبيانات", description: "كل منشأة ترى بياناتها فقط، بطبقتي حماية في قاعدة البيانات." },
      { title: "سجل لا يُعدَّل", description: "كل حركة مالية ومخزنية مسجلة للإضافة فقط، والتصحيح بقيد عكسي، للمراجعة والتدقيق." },
    ],
  },
  mobileApp: {
    eyebrow: "على جوالك", title: "منشأتك في جيبك أينما كنت",
    description: "نفس النظام يعمل على الجوال بتصميم مخصص له: تتابع يومك، وتعتمد الطلبات والمصروفات، وتسأل المساعد الذكي، من أي مكان وبدون تثبيت أي تطبيق.",
    points: ["المبيعات والمخزون ومجمل الربح لحظة بلحظة", "اعتماد طلبات الشراء والمصروفات من الجوال", "جرد واستلام بكاميرا الجوال أو جهاز الباركود", "المساعد الذكي بسؤال واحد"],
  },
  why: {
    eyebrow: "لماذا مُنَسِّق", title: "تشغيل أدق، وقرار أسرع",
    description: "بدلاً من الجداول المتفرقة والتقارير المتأخرة، يعمل فريقك على مصدر واحد للحقيقة من أول فاتورة شراء حتى آخر فاتورة بيع.",
    items: [
      { title: "رؤية لحظية", description: "المبيعات والربح وقيمة المخزون وما تحت الحد وما قارب انتهاء صلاحيته، في لوحة واحدة." },
      { title: "عمليات مترابطة", description: "طلب الشراء يصبح أمراً، والأمر يصبح استلاماً بقيده، والمخزون يصبح تكلفة معروفة لكل منتج." },
      { title: "صلاحيات دقيقة", description: "لكل صفحة إجراءاتها: عرض وإضافة وتعديل وحذف واعتماد، في أدوار جاهزة أو مخصصة." },
    ],
  },
  useCases: {
    eyebrow: "حالات الاستخدام", title: "ما يحله مُنَسِّق لمنشأتك",
    items: [
      { title: "اعرف تكلفة كل طبق", description: "للمطاعم: وصفات بتكلفة حية تتغير مع كل استلام، ونسبة تكلفة الطعام لكل صنف." },
      { title: "اضبط مخزون المصنع", description: "للمصانع: الخامات والإنتاج التام في مستودعات وحسابات منفصلة، مع تشغيلات وصلاحية وجرد بالباركود." },
      { title: "حلّل كل خط إنتاج", description: "مراكز تكلفة على المصروفات والقيود، وقائمة دخل لكل خط أو قسم." },
      { title: "فوتر مستخلصاتك بلا أخطاء", description: "للمقاولات: المستخلص يصدر فاتورته الإلكترونية بالضريبة كاملة رغم المحتجز، ويسترد الدفعة المقدمة بنسبتها، ويخصم غرامة التأخير بإشعار دائن." },
      { title: "أوقف الهدر الخفي", description: "تحليل التالف وانحرافات الجرد بالقيمة، مع السبب والمسؤول." },
    ],
  },
  pricing: {
    eyebrow: "باقات مرنة", title: "ابدأ بما يناسب حجم منشأتك",
    description: "كل الأسعار بالريال السعودي ولا تشمل ضريبة القيمة المضافة.", note: "يمكنك الترقية في أي وقت دون فقدان بياناتك.",
    monthly: "شهرياً", yearly: "سنوياً", empty: "تواصل معنا لتجهيز عرض يناسب احتياجات قطاعك.",
  },
  faq: {
    eyebrow: "الأسئلة الشائعة", title: "قبل أن تبدأ", description: "إجابات مباشرة عن التجربة والحساب والبيانات.",
    items: [
      { question: "هل أحتاج بطاقة ائتمانية؟", answer: "لا. تبدأ التجربة المجانية دون بطاقة ائتمانية أو التزام." },
      { question: "متى تصبح مساحة العمل جاهزة؟", answer: "بعد تفعيل بريدك وإنشاء منشأتك مباشرة، وتبدأ بإضافة أصنافك أو استيرادها من Excel." },
      { question: "هل يناسب مصنعي؟", answer: "نعم. قطاع التصنيع متاح للتسجيل: قوائم المواد متعددة المستويات، وأوامر الإنتاج بتكلفة المواد والعمالة والتحميل، وتخطيط الاحتياجات والجدولة، والجودة والتتبع، والصيانة وكفاءة المعدات، والمبيعات بالفاتورة الإلكترونية، والرواتب." },
      { question: "هل يناسب شركة المقاولات؟", answer: "نعم. قطاع المقاولات متاح للتسجيل: المشاريع والعقود وجداول الكميات (مع الاستيراد من Excel)، ومستخلصات العميل بفاتورتها الإلكترونية والمحتجزات والدفعة المقدمة وغرامات التأخير، وأوامر التغيير والمطالبات والضمانات البنكية. السقوف النظامية تُطبق بحسب نظام العقد وتاريخ طرحه. مستخلصات مقاولي الباطن والإيراد بنسبة الإنجاز في المرحلة التالية." },
      { question: "هل فيه رواتب؟", answer: "نعم، لكل القطاعات: ملفات الموظفين، والحضور والعمل الإضافي، والإجازات، ومسير الرواتب بالتأمينات الاجتماعية، والمخالصة النهائية ومكافأة نهاية الخدمة، مع قيد تلقائي على مراكز التكلفة." },
      { question: "هل بيانات منشأتي منفصلة؟", answer: "نعم. لكل منشأة مساحة وصلاحيات مستقلة، ولا تظهر بياناتها لأي عميل آخر." },
      { question: "هل يدعم الفاتورة الإلكترونية؟", answer: "نعم، بالمرحلتين. تسجّل منشأتك جهاز الفوترة بنفسها برمز التحقق من بوابة فاتورة، فتُختم كل فاتورة وتُرسل للهيئة تلقائياً: الضريبية تُعتمد قبل تسليمها، والمبسطة تُبلَّغ خلال 24 ساعة." },
    ],
  },
  cta: { eyebrow: "جاهز للانطلاق؟", title: "ابدأ ضبط تكاليف منشأتك اليوم", description: "أنشئ حسابك في دقيقة، وأضف أول مورد وصنف، وشاهد التكلفة تُحسب مع أول استلام." },
  footer: {
    description: "منصة سعودية للمطاعم والمصانع وشركات المقاولات تربط التكلفة والمخزون والتشغيل والربحية، لتمنح إدارتك قراراً أسرع وأدق.",
    exploreTitle: "استكشف",
    exploreLinks: [{ label: "المميزات", url: "#features" }, { label: "لماذا مُنَسِّق", url: "#why" }, { label: "الباقات", url: "#pricing" }, { label: "الأسئلة الشائعة", url: "#faq" }],
    sectorsTitle: "الحساب",
    sectorLinks: [{ label: "تسجيل الدخول", url: "/login" }, { label: "إنشاء حساب", url: "/register" }],
    contactTitle: "تواصل معنا", phone: "+966500000000", email: "hello@munassiq.sa", address: "الرياض، المملكة العربية السعودية",
    linkedin: "", instagram: "", whatsapp: "", copyright: "© 2026 مُنَسِّق. جميع الحقوق محفوظة.",
  },
  policies: {
    privacy: { title: "سياسة الخصوصية", summary: "كيف نحمي بياناتك ونستخدمها.", body: "اكتب نص سياسة الخصوصية الكامل من لوحة إدارة المنصة." },
    terms: { title: "الشروط والأحكام", summary: "الشروط المنظمة لاستخدام منصة مُنَسِّق.", body: "اكتب نص الشروط والأحكام الكامل من لوحة إدارة المنصة." },
    security: { title: "أمن المعلومات", summary: "الضوابط المتبعة لحماية معلومات منشأتك.", body: "اكتب تفاصيل سياسة أمن المعلومات من لوحة إدارة المنصة." },
  },
};

/** Stored content over the defaults, section by section, so a new field never renders empty. Invalid stored data falls back. */
export function mergeLanding(stored: unknown): LandingContent {
  if (!stored || typeof stored !== "object") return defaultLanding;
  const s = stored as Record<string, unknown>;
  const merged = Object.fromEntries(Object.entries(defaultLanding).map(([k, v]) => [k, { ...v, ...(typeof s[k] === "object" && s[k] ? s[k] as object : {}) }])) as Record<string, unknown>;
  merged.policies = Object.fromEntries(Object.entries(defaultLanding.policies).map(([k, v]) => [k, { ...v, ...((s.policies as Record<string, object> | undefined)?.[k] ?? {}) }]));
  const parsed = landingSchema.safeParse(merged);
  return parsed.success ? parsed.data : defaultLanding;
}
