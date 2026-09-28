export class AppError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(422, "validation_failed", message, details);
export const unauthorized = (message = "يجب تسجيل الدخول أولاً") => new AppError(401, "unauthenticated", message);
export const forbidden = (message = "لا تملك صلاحية تنفيذ هذا الإجراء") => new AppError(403, "forbidden", message);
export const notFound = (message = "السجل غير موجود") => new AppError(404, "not_found", message);
export const notOperational = () =>
  new AppError(403, "tenant_not_operational", "المنشأة غير مفعّلة: الاشتراك منتهٍ أو الحساب موقوف. يمكنك الاطلاع على البيانات فقط");
export const conflict =(code: string, message: string, details?: unknown) => new AppError(409, code, message, details);

interface PgLikeError {
  code?: string;
  message?: string;
  constraint?: string;
}

/** Translates PostgreSQL errors into safe, specific API errors. Unknown errors stay 500 and are never echoed. */
export function fromPgError(err: unknown): AppError | null {
  const e = err as PgLikeError;
  if (!e || typeof e !== "object" || typeof e.code !== "string") return null;
  switch (e.code) {
    case "23505":
      return conflict("duplicate", "القيمة مسجلة مسبقاً ولا يمكن تكرارها", { constraint: e.constraint });
    case "23503":
      return conflict("reference_conflict", "السجل مرتبط ببيانات أخرى أو يشير إلى سجل غير موجود. يمكنك إيقافه بدلاً من حذفه");
    case "23514":
    case "23502":
    case "22P02":
    case "22003":
      return badRequest("قيمة غير صالحة", { constraint: e.constraint });
    case "42501":
      return notOperational();
    case "40001":
    case "40P01":
      return new AppError(409, "concurrent_update", "تعذر التنفيذ بسبب عملية متزامنة. أعد المحاولة");
    case "P0001": {
      const m = e.message ?? "";
      if (m === "plan_limit_reached:storage") return new AppError(402, "plan_limit_reached", "استهلكت كامل مساحة التخزين في باقتك. اشترِ مساحة إضافية أو رقِّ الباقة من «الاشتراك والفوترة»", { limit: "storage" });
      if (m.startsWith("plan_limit_reached")) return new AppError(402, "plan_limit_reached", "وصلت إلى الحد الأقصى المسموح به في باقتك. رقّ الباقة للمتابعة", { limit: m.split(":")[1] });
      if (m.startsWith("period_locked")) return new AppError(409, "period_locked", `الفترة المحاسبية مقفلة حتى ${m.split(":")[1] ?? ""}. لا يمكن تسجيل عملية بتاريخ داخلها`);
      if (m === "journal_unbalanced") return new AppError(422, "journal_unbalanced", "القيد غير متوازن: مجموع المدين يجب أن يساوي مجموع الدائن");
      if (m === "account_not_postable") return new AppError(422, "account_not_postable", "لا يمكن الترحيل على حساب رئيسي أو موقوف. اختر حساباً فرعياً نشطاً");
      if (m === "no_active_subscription") return new AppError(402, "no_active_subscription", "لا يوجد اشتراك ساري لهذه المنشأة");
      return null;
    }
    default:
      return null;
  }
}
