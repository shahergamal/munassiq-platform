export const ROLES = ["owner", "manager", "accountant", "inventory_clerk", "cashier"] as const;
export type Role = (typeof ROLES)[number];
/** A membership holds a built-in role, or `custom` with a workspace-defined permission list (tenant_roles). */
export type MemberRole = Role | "custom";
/** `support` is virtual: a platform admin inside a time-boxed, audited support session. Read-only. */
export type EffectiveRole = MemberRole | "support";

/**
 * The permission catalog: module → page → action. A permission is `page.action` (ingredients.delete,
 * purchases.approve). Every endpoint asks for one (or any of a few) of these; the role editor shows this tree.
 */
interface ActionOpts { hint?: string; sensitive?: boolean }

/** The business a workspace runs (tenants.sector). A page without `sectors` belongs to every sector. */
export const SECTORS = ["restaurants", "manufacturing", "contracting"] as const;
export type Sector = (typeof SECTORS)[number];
const REST = ["restaurants"] as const;
const MFG = ["manufacturing"] as const;
const CON = ["contracting"] as const;
const act = <K extends string>(key: K, label: string, opts: ActionOpts = {}) => ({ key, label, ...opts });
const view = (hint?: string) => act("view", "عرض", { hint });
const create = (hint?: string) => act("create", "إضافة", { hint });
const edit = (hint?: string) => act("edit", "تعديل", { hint });
const del = (hint?: string) => act("delete", "حذف", { hint, sensitive: true });

export const CATALOG = [
  { key: "basic", label: "البيانات الأساسية", pages: [
    { key: "ingredients", label: "المواد الخام", labels: { manufacturing: "الأصناف", contracting: "المواد والأصناف" }, actions: [view("القائمة والأرصدة والتكلفة"), create(), edit("والباركودات"), del(), act("import", "استيراد Excel"), act("export", "تصدير Excel")] },
    { key: "suppliers", label: "الموردون", actions: [view(), create(), edit(), del()] },
    { key: "branches", label: "الفروع", actions: [view(), create(), edit(), del()] },
    { key: "locations", label: "المطابخ والمستودعات", labels: { manufacturing: "المستودعات ومواقع الإنتاج", contracting: "المستودعات ومخازن المواقع" }, actions: [view(), create(), edit(), del()] },
    { key: "units", label: "وحدات القياس", actions: [view()] },
    { key: "dining", sectors: REST, label: "الصالات والطاولات", actions: [view(), create(), edit()] },
    { key: "platforms", sectors: REST, label: "تطبيقات التوصيل", actions: [view(), create(), edit()] },
  ] },
  { key: "purchasing", label: "المشتريات", pages: [
    { key: "requisitions", label: "طلبات الشراء", actions: [view(), create("طلب داخلي من موقع"), act("approve", "اعتماد ورفض", { hint: "لا يعتمد طلباً قدّمه بنفسه، عدا المالك" }), act("convert", "تحويل لأوامر شراء"), act("cancel", "إلغاء")] },
    { key: "purchases", label: "أوامر الشراء", actions: [view(), create("تُحفظ مسودة"), act("approve", "اعتماد", { hint: "فوق حد الاعتماد للمالك فقط" }), act("cancel", "إلغاء", { sensitive: true }), act("close", "إغلاق المتبقي")] },
    { key: "goods_receipts", label: "سندات الاستلام", actions: [view(), act("create", "استلام البضاعة", { hint: "يُدخل المخزون ويُنشئ مستحق المورد" })] },
    { key: "purchase_returns", label: "مرتجعات المشتريات", actions: [view(), create()] },
  ] },
  { key: "inventory", label: "المخزون", pages: [
    { key: "stock", label: "رصيد المخزون", actions: [view()] },
    { key: "batches", sectors: [...REST, ...MFG], label: "الصلاحية والدفعات", actions: [view(), act("create", "تسجيل تاريخ لرصيد قائم")] },
    { key: "transfers", label: "التحويلات بين المواقع", actions: [view(), create(), act("dispatch", "إرسال"), act("receive", "استلام وتسجيل العجز"), act("cancel", "إلغاء")] },
    { key: "waste", label: "الهدر والتلف", labels: { manufacturing: "التالف والإتلاف", contracting: "التالف والإتلاف" }, actions: [view(), act("create", "تسجيل هدر وإتلاف", { hint: "يخرج من المخزون ويُرحَّل مصروفاً" })] },
    { key: "stocktakes", label: "الجرد الفعلي", actions: [view(), act("count", "بدء الجرد والعدّ"), act("post", "ترحيل الفروقات", { hint: "يعدّل المخزون والتكلفة. الأفضل ألا يملكه من يعدّ", sensitive: true })] },
    { key: "movements", label: "حركة المواد", labels: { manufacturing: "حركة الأصناف" }, actions: [view()] },
  ] },
  { key: "recipes", label: "الوصفات", pages: [
    { key: "recipes", sectors: REST, label: "وصفات المنيو", actions: [view("المكونات والتكلفة"), create(), edit("المكونات والسعر والإضافات"), del(), act("approve", "اعتماد للبيع وإيقاف")] },
    { key: "prep_recipes", sectors: REST, label: "الوصفات التحضيرية والإنتاج", actions: [view(), create(), edit(), act("produce", "تشغيل دفعة إنتاج")] },
    { key: "modifiers", sectors: REST, label: "الإضافات والخيارات", actions: [view(), create(), edit()] },
  ] },
  { key: "manufacturing", label: "التصنيع", pages: [
    { key: "work_centers", sectors: MFG, label: "مراكز العمل", actions: [view("والطاقة وأسعار الساعة"), create(), edit()] },
    { key: "boms", sectors: MFG, label: "قوائم المواد", actions: [view("والتكلفة المعيارية"), create("مسودة أو إصدار جديد"), edit("المسودات فقط"), del("المسودات فقط"),
      act("approve", "اعتماد الإصدار", { hint: "يصبح الإصدار الساري لأوامر التشغيل الجديدة", sensitive: true })] },
    { key: "mos", sectors: MFG, label: "أوامر التشغيل", actions: [view("والتكلفة الفعلية والانحرافات"), create("مسودة"), act("confirm", "تأكيد الأمر", { hint: "يجمّد القائمة والتكلفة المعيارية" }),
      act("issue", "صرف المواد وإرجاعها"), act("labor", "تسجيل ساعات التشغيل"), act("produce", "تسجيل الإنتاج والهالك"),
      act("close", "إقفال الأمر", { hint: "يرحّل الانحراف ويصفّر الإنتاج تحت التشغيل", sensitive: true }), act("cancel", "إلغاء أمر لم يبدأ")] },
    { key: "mrp", sectors: MFG, label: "تخطيط الاحتياجات والجدولة", actions: [view("المقترحات وجدول مراكز العمل"), act("run", "تشغيل التخطيط"),
      act("convert", "تحويل المقترحات إلى أوامر", { hint: "ينشئ أوامر تشغيل وأوامر شراء مسودة" })] },
  ] },
  { key: "quality", label: "الجودة", pages: [
    { key: "qc_plans", sectors: MFG, label: "خطط الفحص", actions: [view("الخصائص وحدود القبول لكل صنف"), create(), edit()] },
    { key: "qc_inspections", sectors: MFG, label: "الفحوصات", actions: [view("والتشغيلات المحجوزة"), act("create", "تسجيل الفحص والقرار", { hint: "المرفوض والمعلّق يُنقل إلى حجر الجودة" }),
      act("release", "الإفراج عن المحجوز", { hint: "يعيد التشغيلة من الحجر إلى المخزون", sensitive: true })] },
    { key: "ncrs", sectors: MFG, label: "تقارير عدم المطابقة", actions: [view(), create(), act("close", "إقفال بالقرار والإجراء التصحيحي")] },
    { key: "trace", sectors: MFG, label: "تتبع التشغيلات", actions: [view("من المورد إلى العميل وبالعكس")] },
  ] },
  { key: "maintenance", label: "الصيانة", pages: [
    { key: "machines", sectors: [...MFG, ...CON], label: "الآلات وخطط الصيانة", actions: [view(), create(), edit("والعدّاد والخطط")] },
    { key: "maintenance", sectors: [...MFG, ...CON], label: "أوامر الصيانة", actions: [view("ومؤشرات MTBF وMTTR"), create("وقائية أو إصلاح عطل"),
      act("complete", "إنجاز الأمر وصرف قطع الغيار", { hint: "يُخرج القطع من المخزون إلى مصروف الصيانة" }), act("cancel", "إلغاء")] },
  ] },
  { key: "sales", label: "المبيعات", pages: [
    { key: "pos", sectors: REST, label: "شاشة الكاشير", actions: [act("sell", "البيع", { hint: "فتح شفته، والطلبات المفتوحة، والدفع" }), act("discount", "خصم فوق الحد المسموح"),
      act("void", "إلغاء ما وصل للمطبخ", { hint: "تقليل صنف أو إلغاء طلب أُرسل للمطبخ", sensitive: true }), act("supervise", "إشراف الشفتات", { hint: "إغلاق شفت كاشير آخر ورؤية النقد المتوقع", sensitive: true })] },
    { key: "kitchen", sectors: REST, label: "شاشة المطبخ", actions: [act("use", "استخدام الشاشة")] },
    { key: "customers", label: "العملاء", actions: [view(), create(), edit()] },
    { key: "price_lists", sectors: MFG, label: "قوائم أسعار العملاء", actions: [view(), create(), edit("الأسعار والتفعيل")] },
    { key: "sales_orders", sectors: MFG, label: "عروض الأسعار وأوامر البيع", actions: [view("والتسليمات والفواتير المرتبطة"), create("عرض سعر وتعديله"),
      act("confirm", "تأكيد أمر البيع", { hint: "يحجز المخزون ويتحقق من حد الائتمان" }), act("deliver", "التسليم ومرتجعات العملاء", { hint: "يُخرج المخزون ويقيد تكلفة المبيعات" }),
      act("invoice", "إصدار فاتورة الأمر", { hint: "فاتورة ضريبية بما سُلّم، تُرسل للهيئة", sensitive: true }), act("cancel", "إلغاء وإقفال الأوامر")] },
    { key: "shifts", sectors: REST, label: "الشفتات", actions: [view()] },
    { key: "orders", sectors: REST, label: "الطلبات والمرتجعات", actions: [view(), act("refund", "استرجاع", { hint: "إشعار دائن ورد المبلغ", sensitive: true })] },
  ] },
  { key: "finance", label: "المالية", pages: [
    { key: "payables", label: "مستحقات الموردين", actions: [view("الأرصدة وكشوف الحساب"), act("pay", "تسجيل دفعة لمورد", { sensitive: true })] },
    { key: "expenses", label: "المصروفات", actions: [view(), create("تُسجَّل معلّقة"), act("approve", "اعتماد", { hint: "لا يعتمد مصروفاً سجّله بنفسه، عدا المالك" }), act("pay", "سداد", { sensitive: true }), act("cancel", "إلغاء"), act("categories", "إدارة التصنيفات")] },
  ] },
  { key: "contracting", label: "المقاولات", pages: [
    { key: "projects", sectors: CON, label: "المشاريع", actions: [view("وWBS والتصاريح"), create(), edit()] },
    { key: "contracts", sectors: CON, label: "العقود", actions: [view("والشروط والسقوف النظامية"), create(), edit("قبل التفعيل"),
      act("activate", "تفعيل العقد", { hint: "يثبت جدول الكميات ويطبق السقوف النظامية الموثقة", sensitive: true })] },
    { key: "boq", sectors: CON, label: "جداول الكميات", actions: [view(), edit("البنود وWBS"), act("import", "استيراد وتصدير Excel")] },
    { key: "guarantees", sectors: CON, label: "الضمانات البنكية", actions: [view("وتنبيهات الانتهاء"), create("ورسومها"), edit("الإفراج والتمديد")] },
    { key: "ipcs", sectors: CON, label: "المستخلصات", actions: [view(), create("إعداد وتقديم"), act("certify", "اعتماد الاستشاري (الكميات المعتمدة)"),
      act("approve", "اعتماد العميل", { sensitive: true }), act("invoice", "إصدار الفاتورة والدفعة المقدمة", { hint: "فاتورة زاتكا من المستخلص المعتمد", sensitive: true })] },
    { key: "variations", sectors: CON, label: "أوامر التغيير", actions: [view(), create(), act("approve", "اعتماد أو رفض", { hint: "بالتحقق من سقوف المادة 67", sensitive: true })] },
    { key: "claims", sectors: CON, label: "المطالبات", actions: [view("ومهل الإخطار"), create(), edit("الحالة والتقييم"),
      act("agree", "اعتماد الاتفاق على مطالبة", { hint: "يدخل سعر المعاملة والإيراد", sensitive: true })] },
    { key: "subcontractors", sectors: CON, label: "مقاولو الباطن", actions: [view("والتأهيل والتصنيف"), create(), edit("التأهيل والتقييم"),
      act("approve", "اعتماد التأهيل أو إيقافه", { hint: "لا يُسند عقد باطن لمقاول غير معتمد", sensitive: true })] },
    { key: "tenders", sectors: CON, label: "العطاءات والتسعير", actions: [view("وتحليل الأسعار"), create(), edit("البنود والتسعير والتقديم والنتيجة"),
      act("convert", "تحويل العطاء الفائز إلى عقد", { sensitive: true })] },
    { key: "cost_control", sectors: CON, label: "الجدولة والتحكم في التكلفة", actions: [view("والقيمة المكتسبة والتدفق النقدي"),
      act("schedule", "استيراد البرنامج الزمني وتحديث الإنجاز"), act("budget", "موازنة المشروع"), act("snapshot", "تثبيت القيمة المكتسبة الشهرية")] },
    { key: "revenue", sectors: CON, label: "الإيراد والأعمال تحت التنفيذ", actions: [view("جدول الأعمال تحت التنفيذ"), act("estimate", "تقدير التكلفة الكلية للعقد"),
      act("close", "الإقفال الشهري", { hint: "يرحّل أصل/التزام العقد ومخصص العقود المثقلة", sensitive: true }),
      act("settings", "سياسة قياس الإنجاز", { hint: "المخرجات (المعتمد) أو المدخلات (التكلفة)", sensitive: true })] },
    { key: "site_stores", sectors: CON, label: "مخازن المواقع والمواد", actions: [view("والاستهلاك والمحتوى المحلي"), act("issue", "صرف وإرجاع المواد للمشاريع"),
      edit("المعدلات النظرية والمحتوى المحلي للأصناف")] },
    { key: "labor", sectors: CON, label: "العمالة على المشاريع", actions: [view("الساعات والتحميل"), act("record", "تسجيل ساعات العمالة على المشاريع"),
      act("allocate", "تحميل مسير الرواتب على المشاريع", { hint: "بالإجماليات لكل مشروع؛ رواتب الأفراد تبقى مختومة", sensitive: true })] },
    { key: "equipment", sectors: CON, label: "المعدات على المشاريع", actions: [view("والاستغلال"), create("ساعات التشغيل اليومية"), edit("الملكية والسعر الداخلي")] },
    { key: "quality", sectors: CON, label: "الجودة: الفحص وعدم المطابقة والاستفسارات", actions: [view("طلبات الفحص وتقارير عدم المطابقة والاستفسارات"),
      act("plan", "خطة الفحص والاختبار ITP"), act("record", "طلب فحص، فتح تقرير عدم مطابقة، استفسار فني"),
      act("respond", "تسجيل نتيجة الاستشاري والرد على الاستفسار"), act("close", "إغلاق تقرير عدم المطابقة", { hint: "بعد المعالجة والإجراء التصحيحي" })] },
    { key: "hse", sectors: CON, label: "السلامة والصحة المهنية", actions: [view("الحوادث والتصاريح والمؤشرات"), act("record", "تسجيل الحوادث والتحقيق فيها"), act("permits", "تصاريح العمل")] },
    { key: "documents", sectors: CON, label: "ضبط الوثائق", actions: [view("السجل والإصدارات والملفات"), act("upload", "تسجيل الوثائق ورفع الإصدارات"),
      act("review", "تسجيل مراجعة الاستشاري (A–D)"), act("transmit", "خطابات الإرسال")] },
    { key: "con_reports", sectors: CON, label: "تقارير الإدارة للمقاولات", actions: [view("محفظة المشاريع والهوامش والتدفق النقدي المجمع"), act("export", "تصدير المحفظة إلى Excel")] },
    { key: "handover", sectors: CON, label: "الاستلام وفترة الضمان", actions: [view("الاستلام والعيوب والمسؤولية العشرية"), act("record", "تسجيل الملاحظات والعيوب وإصلاحها"),
      act("accept", "الاستلام الابتدائي والنهائي وإقفال العقد", { hint: "يبدأ فترة الضمان، ويُكمل العقد", sensitive: true })] },
    { key: "telecom_sites", sectors: CON, label: "مواقع الاتصالات", actions: [view("حالة المواقع وقيمتها والقابل للفوترة"), create("المواقع ونطاقها والاستيراد"),
      act("advance", "نقل حالة الموقع", { hint: "الاستلام الابتدائي والنهائي بأرقام الشهادات" }),
      act("terms", "شروط الفوترة بالمراحل", { hint: "نسبة قيمة الموقع عند التركيب والتشغيل والاستلام", sensitive: true })] },
    { key: "daily_reports", sectors: CON, label: "التقارير اليومية للموقع", actions: [view(), act("write", "كتابة التقرير اليومي"), act("submit", "تقديم التقرير", { hint: "يصبح نهائياً لا يُعدَّل" })] },
    { key: "retention", sectors: CON, label: "المحتجزات", actions: [view("وأعمارها"), act("release", "تسجيل الإفراج", { hint: "قبض محتجز العميل أو استحقاق محتجز مقاول الباطن", sensitive: true })] },
  ] },
  { key: "hr", label: "الموارد البشرية", pages: [
    { key: "employees", label: "الموظفون", actions: [view("البيانات الوظيفية والوثائق وتنبيهات الانتهاء"),
      act("view_pay", "رؤية الرواتب والهوية والآيبان", { hint: "بيانات مشفرة لا تظهر لغير هذه الصلاحية", sensitive: true }), create(), edit("والراتب"),
      act("terminate", "إنهاء الخدمة والمخالصة", { hint: "يحسب مكافأة نهاية الخدمة ويقيدها", sensitive: true })] },
    { key: "attendance", label: "الحضور والعمل الإضافي", actions: [view(), act("record", "تسجيل الحضور")] },
    { key: "leaves", label: "الإجازات", actions: [view("والأرصدة"), act("request", "تقديم طلب"), act("approve", "اعتماد أو رفض")] },
    { key: "payroll", label: "مسير الرواتب", actions: [view(), act("run", "إعداد المسير والتعديلات"), act("approve", "اعتماد المسير وقيده", { sensitive: true }),
      act("pay", "صرف الرواتب", { sensitive: true }), act("export", "ملف حماية الأجور (مُدد) وملف البنك", { sensitive: true })] },
  ] },
  { key: "accounting", label: "الحسابات", pages: [
    { key: "acc_overview", label: "لوحة الحسابات", actions: [view()] },
    { key: "acc_invoices", label: "الفواتير الضريبية", actions: [view(), act("create", "إصدار فاتورة وإشعار", { sensitive: true })] },
    { key: "acc_receipts", label: "سندات القبض", actions: [view(), create()] },
    { key: "acc_journal", label: "القيود اليومية", actions: [view(), act("create", "قيد يدوي", { sensitive: true }), act("reverse", "عكس قيد", { sensitive: true })] },
    { key: "acc_accounts", label: "دليل الحسابات", actions: [view(), create(), edit()] },
    { key: "cost_centers", label: "مراكز التكلفة", actions: [view("وتحليل الإيرادات والمصروفات بها"), create(), edit()] },
    { key: "acc_reports", label: "التقارير المالية", actions: [view("الميزان وقائمة الدخل والمركز المالي والأستاذ")] },
    { key: "zatca", label: "الربط مع الهيئة (فاتورة)", actions: [view(), act("submit", "إرسال المستندات"), act("onboard", "تسجيل الجهاز", { sensitive: true })] },
    { key: "gateways", label: "بوابات الدفع", actions: [view(), act("manage", "ربط المفاتيح وفصلها", { sensitive: true })] },
    { key: "acc_settings", label: "إعدادات المحاسبة", actions: [view(), act("manage", "إقفال الفترات والسنة وتسوية الضريبة", { sensitive: true }), act("tax_profile", "الملف الضريبي", { sensitive: true })] },
  ] },
  { key: "reports", label: "التقارير", pages: [
    { key: "rep_daily_sales", sectors: REST, label: "المبيعات اليومية", actions: [view()] },
    { key: "rep_sales_channel", sectors: REST, label: "المبيعات حسب القناة", actions: [view()] },
    { key: "rep_cashier", sectors: REST, label: "تسوية الكاشير", actions: [view()] },
    { key: "rep_vat", sectors: REST, label: "ضريبة القيمة المضافة", actions: [view()] },
    { key: "rep_ideal_actual", sectors: REST, label: "المثالي مقابل الفعلي", actions: [view()] },
    { key: "rep_menu_profit", sectors: REST, label: "ربحية المنيو", actions: [view()] },
    { key: "rep_menu_eng", sectors: REST, label: "هندسة المنيو", actions: [view()] },
    { key: "rep_stock_turnover", label: "دوران المخزون والراكد", actions: [view()] },
    { key: "rep_supplier_perf", label: "تقييم الموردين", actions: [view()] },
    { key: "rep_recipe_explosion", sectors: REST, label: "تفجير تكلفة الوصفة", actions: [view()] },
    { key: "rep_purchase_prices", label: "أسعار الشراء وتغيّرها", actions: [view()] },
    { key: "rep_stock_valuation", label: "تقييم المخزون", actions: [view()] },
    { key: "rep_waste", label: "تحليل الهدر", labels: { manufacturing: "تحليل التالف", contracting: "تحليل التالف" }, actions: [view()] },
    { key: "rep_stock_variance", label: "انحرافات الجرد", actions: [view()] },
    { key: "rep_expenses", label: "المصروفات", actions: [view()] },
    { key: "rep_purchase_match", label: "مطابقة فواتير الموردين", actions: [view("أمر الشراء مقابل الاستلام مقابل الفاتورة")] },
    { key: "rep_production", sectors: MFG, label: "الإنتاج والتكاليف", actions: [view("المخطط مقابل المنتج، الهالك، التكلفة المعيارية مقابل الفعلية وانحرافاتها")] },
    { key: "rep_oee", sectors: MFG, label: "كفاءة المعدات (OEE)", actions: [view("الجاهزية والأداء والجودة لكل مركز عمل")] },
    { key: "rep_payroll", label: "الرواتب والتأمينات", actions: [view("مجاميع المسيرات حسب مركز التكلفة وتقرير التأمينات الشهري")] },
    { key: "rep_withholding", label: "ضريبة الاستقطاع", actions: [view("الإقرار الشهري لما استُقطع من الموردين غير المقيمين")] },
  ] },
  { key: "system", label: "الإدارة", pages: [
    { key: "assistant", label: "المساعد الذكي", actions: [act("use", "الاستخدام", { hint: "يجيب فقط من البيانات التي تسمح بها باقي صلاحيات الدور" })] },
    { key: "settings", label: "المنشأة والضريبة", actions: [view(), act("edit", "تعديل حدود البيع والشراء", { sensitive: true })] },
    { key: "members", label: "الأعضاء", actions: [view(), act("invite", "إضافة عضو", { sensitive: true }), act("edit", "تغيير الدور والإيقاف", { sensitive: true })] },
    { key: "roles", label: "الأدوار والصلاحيات", actions: [view(), act("manage", "إنشاء الأدوار وتعديلها", { hint: "لا يمنح غير المالك صلاحية لا يملكها", sensitive: true })] },
    { key: "billing", label: "الاشتراك والفوترة", actions: [view(), act("pay", "الدفع والترقية", { sensitive: true })] },
  ] },
] as const;

type PageOf<M> = M extends { pages: readonly (infer P)[] } ? P : never;
type PermOfPage<P> = P extends { key: infer K extends string; actions: readonly (infer A)[] } ? `${K}.${A extends { key: infer AK extends string } ? AK : never}` : never;
export type Permission = PermOfPage<PageOf<(typeof CATALOG)[number]>>;

export const PERMISSIONS = CATALOG.flatMap((m) => m.pages.flatMap((p) => p.actions.map((a) => `${p.key}.${a.key}`))) as Permission[];
export const isPermission = (p: string): p is Permission => (PERMISSIONS as readonly string[]).includes(p);

interface PageMeta { sectors?: readonly string[]; labels?: Partial<Record<Sector, string>> }
const PAGE_META = new Map<string, PageMeta>(CATALOG.flatMap((m) => m.pages.map((p) => [p.key, p as PageMeta] as const)));
/** Whether a permission's page exists in this sector (a factory has no cashier screen, a restaurant no production orders). */
export function inSector(p: Permission, sector: string): boolean {
  const s = PAGE_META.get(p.slice(0, p.indexOf(".")))?.sectors;
  return !s || s.includes(sector);
}
export const sectorPermissions = (perms: readonly Permission[], sector: string): Permission[] => perms.filter((p) => inSector(p, sector));
/** The role editor's tree for one sector: its pages only, under the sector's own names. */
export function catalogFor(sector: string) {
  return CATALOG.map((m) => ({
    ...m,
    pages: m.pages.filter((p) => !("sectors" in p) || (p.sectors as readonly string[]).includes(sector))
      .map((p) => ({ ...p, label: ("labels" in p ? (p.labels as Partial<Record<string, string>>)[sector] : undefined) ?? p.label })),
  })).filter((m) => m.pages.length);
}

/**
 * What a permission cannot work without. Every action on a page needs the page itself (its `view`, when the
 * page has one); the pairs below add the cross-page needs. Roles are closed under this map.
 */
const EXTRA_IMPLIES: Partial<Record<Permission, readonly Permission[]>> = {
  "goods_receipts.create": ["purchases.view"],
  "requisitions.convert": ["purchases.view"],
  "purchase_returns.create": ["purchases.view"],
  "pos.discount": ["pos.sell"], "pos.void": ["pos.sell"], "pos.supervise": ["pos.sell", "shifts.view"],
  "stocktakes.post": ["stocktakes.view"],
  "roles.manage": ["members.view"],
  "mos.create": ["boms.view"], "mrp.convert": ["mrp.view"], "mrp.run": ["mrp.view"], "sales_orders.create": ["customers.view"], "boms.create": ["work_centers.view"], "boms.edit": ["work_centers.view"],
};
export const IMPLIES: Partial<Record<Permission, readonly Permission[]>> = Object.fromEntries(PERMISSIONS.flatMap((p) => {
  const [page, action] = p.split(".") as [string, string];
  const needs = [...(action !== "view" && isPermission(`${page}.view`) ? [`${page}.view` as Permission] : []), ...(EXTRA_IMPLIES[p] ?? [])];
  return needs.length ? [[p, needs]] : [];
}));

/**
 * The permissions of the first version (one per module), kept so older roles and API clients keep working: each
 * grants exactly the pages and actions it used to open. Built-in roles are still defined in these terms.
 */
const LEGACY: Record<string, readonly Permission[]> = {
  "catalog:read": ["ingredients.view", "ingredients.export", "suppliers.view", "branches.view", "locations.view", "units.view", "settings.view"],
  "catalog:write": ["ingredients.create", "ingredients.edit", "ingredients.delete", "ingredients.import", "suppliers.create", "suppliers.edit", "suppliers.delete",
    "branches.create", "branches.edit", "branches.delete", "locations.create", "locations.edit", "locations.delete", "dining.create", "dining.edit", "platforms.create", "platforms.edit"],
  "stock:read": ["stock.view", "batches.view", "transfers.view", "waste.view", "stocktakes.view", "movements.view"],
  "stock:adjust": ["batches.create", "transfers.create", "transfers.dispatch", "transfers.receive", "transfers.cancel", "waste.create", "stocktakes.count", "prep_recipes.produce"],
  "stock:post_count": ["stocktakes.post"],
  "purchases:read": ["requisitions.view", "purchases.view", "goods_receipts.view", "purchase_returns.view", "payables.view"],
  "purchases:write": ["requisitions.create", "requisitions.cancel", "requisitions.convert", "purchases.create"],
  "purchases:approve": ["requisitions.approve", "purchases.approve", "purchases.cancel", "purchases.close"],
  "purchases:receive": ["goods_receipts.create", "purchase_returns.create"],
  "payables:write": ["payables.pay", "expenses.pay"],
  "recipes:read": ["recipes.view", "prep_recipes.view", "modifiers.view"],
  "recipes:write": ["recipes.create", "recipes.edit", "recipes.delete", "recipes.approve", "prep_recipes.create", "prep_recipes.edit", "modifiers.create", "modifiers.edit"],
  "pos:read": ["customers.view", "shifts.view", "orders.view", "dining.view", "platforms.view"],
  "pos:operate": ["pos.sell", "customers.create", "customers.edit"],
  "pos:refund": ["orders.refund", "pos.void", "pos.supervise"],
  "pos:discount_override": ["pos.discount"],
  "pos:kitchen": ["kitchen.use"],
  // Salary totals are not a general report: rep_payroll is granted on its own.
  "reports:read": PERMISSIONS.filter((p) => p.startsWith("rep_") && p !== "rep_payroll.view"),
  "expenses:read": ["expenses.view"],
  "expenses:write": ["expenses.create", "expenses.cancel", "expenses.categories"],
  "expenses:approve": ["expenses.approve"],
  "members:manage": ["members.view", "members.invite", "members.edit", "roles.view"],
  "settings:manage": ["settings.edit", "billing.view", "billing.pay", "zatca.onboard", "gateways.manage", "acc_settings.tax_profile"],
  "assistant:use": ["assistant.use"],
  "accounting:read": ["acc_overview.view", "acc_invoices.view", "acc_receipts.view", "acc_journal.view", "acc_accounts.view", "acc_reports.view", "zatca.view", "gateways.view", "acc_settings.view", "cost_centers.view"],
  "accounting:write": ["acc_invoices.create", "acc_receipts.create", "acc_journal.create", "acc_journal.reverse", "zatca.submit"],
  "accounting:manage": ["acc_accounts.create", "acc_accounts.edit", "acc_settings.manage", "cost_centers.create", "cost_centers.edit"],
};
export const LEGACY_PERMISSIONS = Object.keys(LEGACY);
export const legacyExpansion = (p: string): readonly Permission[] => LEGACY[p] ?? [];

/** How the first version closed a list: each level brought its module's read, and base data was always readable. */
const LEGACY_IMPLIES: Record<string, readonly string[]> = {
  "catalog:write": ["catalog:read"], "stock:adjust": ["stock:read"], "stock:post_count": ["stock:read"],
  "purchases:write": ["purchases:read"], "purchases:approve": ["purchases:read"], "purchases:receive": ["purchases:read"], "payables:write": ["purchases:read"],
  "recipes:write": ["recipes:read"], "pos:operate": ["pos:read"], "pos:refund": ["pos:read"], "pos:discount_override": ["pos:read"], "pos:kitchen": ["pos:read"],
  "expenses:write": ["expenses:read"], "expenses:approve": ["expenses:read"], "accounting:write": ["accounting:read"], "accounting:manage": ["accounting:read"],
};

/** Close a hand-picked list (new names, or first-version names) under IMPLIES, in the catalog's order. */
export function normalizePermissions(picked: readonly string[]): Permission[] {
  const set = new Set<Permission>();
  const add = (p: Permission) => { if (set.has(p)) return; set.add(p); for (const q of IMPLIES[p] ?? []) add(q); };
  const legacy = picked.filter((p) => LEGACY[p]);
  // A list in first-version names means what it meant then (so older clients and roles see no change).
  const closed = legacy.length ? new Set([...legacy, ...legacy.flatMap((p) => LEGACY_IMPLIES[p] ?? []), "catalog:read"]) : new Set<string>();
  for (const p of picked) if (isPermission(p)) add(p);
  for (const p of closed) for (const q of LEGACY[p] ?? []) add(q);
  return PERMISSIONS.filter((p) => set.has(p));
}

/** Factory pages (added after the first version, so not in LEGACY): who of the built-in roles works with them. */
const PRODUCTION = {
  manager: PERMISSIONS.filter((p) => ["work_centers.", "boms.", "mos.", "sales_orders.", "price_lists.", "mrp.", "qc_", "ncrs.", "trace.", "machines.", "maintenance.", "rep_production.", "rep_oee."].some((x) => p.startsWith(x))),
  accountant: ["work_centers.view", "boms.view", "mos.view", "mos.close", "sales_orders.view", "sales_orders.invoice", "price_lists.view", "mrp.view", "trace.view", "maintenance.view", "rep_production.view"] as Permission[],
  inventory_clerk: ["work_centers.view", "boms.view", "mos.view", "mos.issue", "mos.produce", "sales_orders.view", "sales_orders.deliver", "mrp.view", "qc_inspections.view", "qc_inspections.create", "ncrs.view", "trace.view", "maintenance.view"] as Permission[],
};

/** Contracting pages (after the first version): the manager runs projects; the accountant invoices and guarantees. */
const CONTRACTING = {
  manager: PERMISSIONS.filter((p) => ["projects.", "contracts.", "boq.", "guarantees.", "ipcs.", "variations.", "claims.", "subcontractors.", "retention.view", "revenue.view", "revenue.estimate", "tenders.", "site_stores.", "equipment.", "machines.", "maintenance.", "labor.view", "labor.record", "cost_control.", "quality.", "hse.", "documents.", "daily_reports.", "telecom_sites.view", "telecom_sites.create", "telecom_sites.advance", "handover.view", "handover.record", "con_reports."].some((x) => p.startsWith(x))
    && !["ipcs.invoice", "contracts.activate", "ipcs.approve", "claims.agree"].includes(p)),
  accountant: ["projects.view", "contracts.view", "boq.view", "guarantees.view", "guarantees.create", "guarantees.edit", "ipcs.view", "ipcs.invoice", "variations.view", "claims.view",
    "subcontractors.view", "retention.view", "retention.release", "revenue.view", "revenue.estimate", "revenue.close", "revenue.settings", "tenders.view", "site_stores.view", "equipment.view", "labor.view", "labor.allocate", "cost_control.view", "cost_control.budget", "cost_control.snapshot", "quality.view", "hse.view", "daily_reports.view", "telecom_sites.view", "telecom_sites.terms", "handover.view", "con_reports.view", "con_reports.export"] as Permission[],
  // The site storekeeper: projects to issue to, the site stores, equipment days and labour hours.
  inventory_clerk: ["projects.view", "quality.view", "quality.record", "documents.view", "daily_reports.view", "daily_reports.write", "site_stores.view", "site_stores.issue", "equipment.view", "equipment.create", "labor.view", "labor.record", "machines.view", "maintenance.view"] as Permission[],
};

/** HR pages (every sector): the manager runs attendance and leaves; pay stays with the owner (and custom roles). */
const HR = {
  manager: ["employees.view", "attendance.view", "attendance.record", "leaves.view", "leaves.request", "leaves.approve"] as Permission[],
  accountant: ["employees.view", "payroll.view", "payroll.pay"] as Permission[],
};

const MATRIX: Record<Role | "support", readonly Permission[]> = {
  owner: PERMISSIONS,
  manager: normalizePermissions([...Object.keys(LEGACY).filter((p) => p !== "members:manage" && p !== "settings:manage"), ...PRODUCTION.manager, ...HR.manager, ...CONTRACTING.manager]),
  // The clerk counts and moves stock; posting a count (which writes off value) needs someone else: owner, manager or accountant.
  accountant: normalizePermissions(["catalog:read", "stock:read", "stock:post_count", "purchases:read", "purchases:approve", "recipes:read", "pos:read", "reports:read",
    "expenses:read", "expenses:write", "expenses:approve", "payables:write", "assistant:use", "accounting:read", "accounting:write", "accounting:manage", ...PRODUCTION.accountant, ...HR.accountant, ...CONTRACTING.accountant]),
  inventory_clerk: normalizePermissions(["catalog:read", "catalog:write", "stock:read", "stock:adjust", "purchases:read", "purchases:write", "purchases:receive", "recipes:read", "assistant:use", ...PRODUCTION.inventory_clerk, ...CONTRACTING.inventory_clerk]),
  // Kitchen staff use the cashier role on the kitchen screen; there is no separate kitchen role yet.
  cashier: normalizePermissions(["catalog:read", "recipes:read", "pos:read", "pos:operate", "pos:kitchen", "assistant:use"]),
  // A platform admin in a support session: the business pages read-only; never the people, their roles or billing.
  // Personal data (PDPL): no HR page, not even to read.
  support: PERMISSIONS.filter((p) => p.endsWith(".view") && !["members.", "roles.", "billing.", "employees.", "attendance.", "leaves.", "payroll.", "rep_payroll."].some((x) => p.startsWith(x))),
};

export function can(role: Role | "support", permission: Permission): boolean {
  return MATRIX[role].includes(permission);
}

export function permissionsOf(role: Role | "support"): readonly Permission[] {
  return MATRIX[role];
}
