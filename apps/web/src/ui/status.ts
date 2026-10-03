// Central status dictionary: every enum the API returns is translated and coloured HERE, keyed by the enum
// (the old UI keyed colours by Arabic words, so "متوقف" vs "موقوف" silently fell back to grey).
export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

const DICT = {
  purchase: { draft: ["مسودة", "neutral"], approved: ["معتمد", "info"], partially_received: ["مستلم جزئياً", "warning"], received: ["مستلم", "success"], closed: ["مغلق", "neutral"], cancelled: ["ملغي", "danger"] },
  requisition: { submitted: ["بانتظار الاعتماد", "info"], approved: ["معتمد", "success"], rejected: ["مرفوض", "danger"], converted: ["حُوّل لأوامر شراء", "neutral"], cancelled: ["ملغي", "neutral"] },
  recipe: { draft: ["مسودة", "neutral"], approved: ["معتمدة", "success"], archived: ["مؤرشفة", "warning"] },
  order: { paid: ["مدفوع", "success"], partially_refunded: ["مسترجع جزئياً", "warning"], refunded: ["مسترجع", "danger"] },
  shift: { open: ["مفتوح", "info"], closed: ["مغلق", "neutral"] },
  active: { true: ["نشط", "success"], false: ["موقوف", "neutral"] },
  tenant: { active: ["نشطة", "success"], blocked: ["موقوفة", "danger"], archived: ["مؤرشفة", "neutral"] },
  subscription: { trial: ["تجريبي", "info"], active: ["ساري", "success"], expired: ["منتهٍ", "danger"], suspended: ["معلّق", "warning"] },
  user: { active: ["نشط", "success"], suspended: ["موقوف", "danger"] },
  transfer: { draft: ["مسودة", "neutral"], in_transit: ["في الطريق", "info"], completed: ["مستلم", "success"], cancelled: ["ملغي", "danger"] },
  expense: { pending: ["بانتظار الاعتماد", "warning"], approved: ["معتمد", "info"], paid: ["مدفوع", "success"], cancelled: ["ملغي", "danger"] },
  stocktake: { counting: ["قيد العد", "info"], posted: ["مُرحَّل", "success"], cancelled: ["ملغي", "danger"] },
  docKind: { invoice: ["فاتورة", "info"], credit_note: ["إشعار دائن", "warning"], debit_note: ["إشعار مدين", "neutral"], prepayment: ["دفعة مقدمة", "success"] },
} as const satisfies Record<string, Record<string, readonly [string, Tone]>>;

export type StatusKind = keyof typeof DICT;

export function status(kind: StatusKind, value: string | boolean | null | undefined): { label: string; tone: Tone } {
  const entry = (DICT[kind] as Record<string, readonly [string, Tone]>)[String(value)];
  return entry ? { label: entry[0], tone: entry[1] } : { label: value === null || value === undefined ? "—" : String(value), tone: "neutral" };
}

export const ROLE_LABELS: Record<string, string> = {
  owner: "المالك",
  manager: "مدير",
  accountant: "محاسب",
  inventory_clerk: "أمين مخزن",
  cashier: "كاشير",
  support: "دعم المنصة (قراءة فقط)",
};

export const CHANNEL_LABELS: Record<string, string> = { dine_in: "محلي", takeaway: "سفري", delivery: "توصيل" };
export const METHOD_LABELS: Record<string, string> = { cash: "نقدي", mada: "مدى", visa: "فيزا", mastercard: "ماستركارد", platform: "عبر تطبيق التوصيل", online: "دفع إلكتروني" };
export const DIMENSION_LABELS: Record<string, string> = { mass: "وزن", volume: "حجم", count: "عدد", length: "طول", area: "مساحة" };
/** Item types of a factory's item master; each is valued in its own inventory account. */
export const ITEM_TYPE_LABELS: Record<string, string> = {
  raw: "مادة خام", semi_finished: "نصف مصنّع", finished: "منتج تام", packaging: "مواد تعبئة وتغليف", consumable: "مواد مستهلكة", spare_part: "قطع غيار",
};
export const LOCATION_TYPE_LABELS: Record<string, string> = { kitchen: "مطبخ", warehouse: "مستودع", store: "مخزن فرعي" };

export const AUDIT_LABELS: Record<string, string> = {
  "auth.login": "تسجيل دخول",
  "user.registered": "تسجيل حساب",
  "tenant.created": "إنشاء منشأة",
  "tenant.status_changed": "تغيير حالة المنشأة",
  "tenant.tax_id_verified": "توثيق الرقم الضريبي",
  "subscription.updated": "تحديث الاشتراك",
  "limits.updated": "تعديل حدود الباقة",
  "support.started": "بدء جلسة دعم",
  "support.ended": "إنهاء جلسة دعم",
  "member.added": "إضافة عضو",
  "member.updated": "تعديل عضو",
  "role.created": "إنشاء دور",
  "role.updated": "تعديل صلاحيات دور",
  "role.deleted": "حذف دور",
  "user.suspended": "إيقاف مستخدم",
  "user.restored": "إعادة تفعيل مستخدم",
  "purchase.created": "إنشاء أمر شراء",
  "purchase.approved": "اعتماد أمر شراء",
  "purchase.received": "استلام أمر شراء",
  "purchase.cancelled": "إلغاء أمر شراء",
  "order.completed": "بيع",
  "order.refunded": "استرجاع",
  "shift.opened": "فتح شفت",
  "shift.closed": "إغلاق شفت",
  "transfer.created": "إنشاء تحويل",
  "transfer.completed": "تنفيذ تحويل",
  "transfer.cancelled": "إلغاء تحويل",
  "waste.recorded": "تسجيل هدر",
  "stocktake.started": "بدء جرد",
  "stocktake.posted": "ترحيل جرد",
  "stocktake.cancelled": "إلغاء جرد",
  "prep_recipe.created": "إنشاء وصفة تحضيرية",
  "prep_recipe.updated": "تعديل وصفة تحضيرية",
  "production.completed": "إنتاج",
  "purchase_return.created": "مرتجع مشتريات",
  "supplier_payment.created": "دفعة لمورد",
  "expense_category.created": "إضافة فئة مصروف",
  "expense.created": "تسجيل مصروف",
  "expense.approved": "اعتماد مصروف",
  "expense.paid": "سداد مصروف",
  "expense.cancelled": "إلغاء مصروف",
  "dining_area.created": "إضافة صالة",
  "modifier_group.created": "إنشاء مجموعة إضافات",
  "modifier_group.updated": "تعديل مجموعة إضافات",
  "recipe.modifiers_updated": "ربط إضافات بصنف",
  "platform.updated": "تعديل تطبيق توصيل",
  "plan.created": "إنشاء باقة",
  "plan.updated": "تعديل باقة",
};

export const MOVEMENT_LABELS: Record<string, string> = {
  purchase: "استلام شراء", sale: "بيع", refund_return: "إرجاع من مرتجع", transfer_out: "تحويل صادر",
  transfer_in: "تحويل وارد", waste: "هدر", count_adjustment: "تسوية جرد",
  production_out: "صرف للإنتاج", production_in: "ناتج إنتاج", purchase_return: "مرتجع لمورد", site_issue: "صرف لمشروع", site_return: "إرجاع من مشروع",
};
export const WASTE_REASON_LABELS: Record<string, string> = {
  expired: "انتهاء الصلاحية", spoiled: "تلف في التخزين", damaged: "كسر أو تلف مادي", prep_error: "خطأ في التحضير", overproduction: "فائض إنتاج", other: "أخرى",
};
/** The reasons that make sense in each sector (a contractor does not prepare food nor overproduce). */
export function wasteReasons(sector: string): Record<string, string> {
  if (sector === "restaurants") return WASTE_REASON_LABELS;
  const { prep_error: _p, overproduction: _o, ...rest } = WASTE_REASON_LABELS;
  if (sector === "contracting") { const { expired: _e, ...site } = rest; return { ...site, damaged: "كسر أو تلف في الموقع", spoiled: "تلف في التخزين أو بالعوامل الجوية" }; }
  return rest;
}
export const PAY_METHOD_LABELS: Record<string, string> = { bank_transfer: "تحويل بنكي", cash: "نقدي", cheque: "شيك", card: "بطاقة" };
/** For showing receipts: also the ones a payment gateway recorded (never picked by hand). */
export const RECEIPT_METHOD_LABELS: Record<string, string> = { ...PAY_METHOD_LABELS, online: "دفع إلكتروني" };
export const LEDGER_KIND_LABELS: Record<string, string> = { purchase: "استلام أمر شراء", return: "مرتجع", payment: "دفعة", sub_ipc: "مستخلص مقاول باطن", sub_advance: "دفعة مقدمة لمقاول باطن", retention_release: "إفراج عن محتجزات" };

// ── Accounting ──
export const ACCOUNT_TYPE_LABELS: Record<string, string> = { asset: "أصول", liability: "خصوم", equity: "حقوق ملكية", revenue: "إيرادات", expense: "مصروفات" };
export const INVOICE_TYPE_LABELS: Record<string, string> = { standard: "ضريبية (لمنشأة)", simplified: "مبسطة" };
export const PAYMENT_MEANS_LABELS: Record<string, string> = { cash: "نقدي", card: "بطاقة", bank_transfer: "تحويل بنكي", credit: "آجل" };
export const VAT_CATEGORY_LABELS: Record<string, string> = { S: "خاضع للنسبة الأساسية", Z: "خاضع للنسبة الصفرية", E: "معفى", O: "خارج نطاق الضريبة" };
/** Buyer identifier schemes of the ZATCA data dictionary. */
export const ID_SCHEME_LABELS: Record<string, string> = {
  CRN: "سجل تجاري", NAT: "هوية وطنية", IQA: "إقامة", PAS: "جواز سفر", GCC: "هوية خليجية", MOM: "ترخيص وزارة الموارد البشرية",
  MLS: "ترخيص وزارة الشؤون البلدية", "700": "الرقم الموحد 700", SAG: "ترخيص الاستثمار", TIN: "رقم ضريبي أجنبي", OTH: "أخرى",
};
/** Where a journal entry comes from (same keys as the server's source_type). */
export const JOURNAL_SOURCE_LABELS: Record<string, string> = {
  manual: "قيد يدوي", opening: "قيد افتتاحي", reversal: "قيد عكسي", year_close: "إقفال السنة", vat_settlement: "تسوية الضريبة",
  pos_order: "مبيعات نقاط البيع", pos_refund: "مرتجع مبيعات", shift_close: "إغلاق شفت", purchase_receipt: "استلام مشتريات", purchase_return: "مرتجع مشتريات",
  supplier_payment: "دفعة مورد", expense: "مصروف", expense_payment: "سداد مصروف", waste: "هدر", stocktake: "تسوية جرد",
  sales_document: "فاتورة / إشعار", customer_receipt: "سند قبض",
};
