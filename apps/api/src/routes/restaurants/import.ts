import ExcelJS from "exceljs";
import type { FastifyInstance } from "fastify";
import { AppError, badRequest } from "../../lib/errors.ts";
import { auditTenant, requireTenant, tenantTx } from "../../plugins/auth.ts";
import { ingredientSchema, insertIngredient, loadUnits, resolvePurchaseToBase, type IngredientInput } from "./catalog.ts";

const MAX_ROWS = 1000;
const MAX_EXPORT = 5000;
const HEADERS = ["الاسم", "الفئة", "وحدة الأساس (رمز)", "وحدة الشراء (رمز)", "معامل التحويل (اختياري)", "نسبة الصلاحية %", "الحد الأدنى", "الباركود"];
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if ("result" in v && v.result !== undefined) return String(v.result).trim();
    if ("text" in v) return String(v.text).trim();
    if ("richText" in v) return v.richText.map((r) => r.text).join("").trim();
    return "";
  }
  return String(v).trim();
}

// Server-side import with exceljs (replaces the vulnerable client-side `xlsx@0.18` parser). Atomic: one bad row rejects the file.
export default async function importRoutes(app: FastifyInstance) {
  app.get("/ingredients/import-template", { preHandler: requireTenant("ingredients.import") }, async (req, reply) => {
    const units = await tenantTx(req, async (db) => (await db.query<{ code: string; name: string }>("SELECT code, name FROM units ORDER BY dimension, code")).rows, { readOnly: true });
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("المواد الخام", { views: [{ rightToLeft: true }] });
    ws.addRow(HEADERS).font = { bold: true };
    ws.addRow(["طماطم", "خضار", "kg", "carton", 10, 90, 5, ""]);
    ws.columns = HEADERS.map(() => ({ width: 24 }));
    const us = wb.addWorksheet("الوحدات", { views: [{ rightToLeft: true }] });
    us.addRow(["الرمز", "الاسم"]).font = { bold: true };
    for (const u of units) us.addRow([u.code, u.name]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    return reply.header("content-type", XLSX).header("content-disposition", 'attachment; filename="ingredients-template.xlsx"').send(buf);
  });

  // Real .xlsx export built on the server (the old UI renamed an HTML table to .xls). Bounded to MAX_EXPORT rows.
  app.get("/ingredients/export", { preHandler: requireTenant("ingredients.export") }, async (req, reply) => {
    const rows = await tenantTx(req, async (db) => (await db.query<{
      sku: string; name: string; category: string | null; base: string; purchase: string; factor: number; yield: number; min: number; qty: number; cost: number; active: boolean;
    }>(
      `WITH st AS (SELECT ingredient_id, sum(quantity) AS qty,
                          CASE WHEN sum(quantity) > 0 THEN sum(quantity * avg_cost) / sum(quantity) ELSE max(avg_cost) END AS avg_cost
                     FROM stock_levels GROUP BY ingredient_id)
       SELECT i.sku, i.name, i.category, bu.code AS base, pu.code AS purchase, i.purchase_to_base::float8 AS factor,
              i.yield_percentage::float8 AS yield, i.min_stock::float8 AS min, coalesce(st.qty, 0)::float8 AS qty,
              round(coalesce(st.avg_cost, 0), 6)::float8 AS cost, i.is_active AS active
         FROM ingredients i JOIN units bu ON bu.id = i.base_unit_id JOIN units pu ON pu.id = i.purchase_unit_id
         LEFT JOIN st ON st.ingredient_id = i.id ORDER BY i.name LIMIT $1`, [MAX_EXPORT])).rows, { readOnly: true });
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("المواد الخام", { views: [{ rightToLeft: true, state: "frozen", ySplit: 1 }] });
    ws.columns = [
      { header: "الرمز", key: "sku", width: 14 }, { header: "الاسم", key: "name", width: 28 }, { header: "الفئة", key: "category", width: 18 },
      { header: "وحدة الأساس", key: "base", width: 12 }, { header: "وحدة الشراء", key: "purchase", width: 12 },
      { header: "معامل التحويل", key: "factor", width: 14 }, { header: "نسبة الاستفادة %", key: "yield", width: 16 },
      { header: "الحد الأدنى", key: "min", width: 12 }, { header: "الرصيد", key: "qty", width: 14 },
      { header: "متوسط التكلفة المرجح", key: "cost", width: 20 }, { header: "الحالة", key: "active", width: 10 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const r of rows) ws.addRow({ ...r, active: r.active ? "نشط" : "موقوف" });
    ws.getColumn("cost").numFmt = "0.000000";
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    return reply.header("content-type", XLSX).header("content-disposition", 'attachment; filename="ingredients.xlsx"').send(buf);
  });

  app.post("/ingredients/import", { preHandler: requireTenant("ingredients.import") }, async (req) => {
    const over = await tenantTx(req, async (db) => (await db.query<{ over: boolean }>(
      "SELECT limit_mb IS NOT NULL AND used_bytes >= limit_mb::bigint * 1048576 AS over FROM tenant_storage_state(app_tenant_id())")).rows[0]?.over, { readOnly: true });
    if (over) throw new AppError(402, "plan_limit_reached", "استهلكت كامل مساحة التخزين في باقتك. اشترِ مساحة إضافية أو رقِّ الباقة من «الاشتراك والفوترة»", { limit: "storage" });
    const file = await req.file();
    if (!file) throw badRequest("أرفق ملف Excel");
    const buf = await file.toBuffer();
    if (file.file.truncated) throw new AppError(413, "file_too_large", "حجم الملف أكبر من 2 ميجابايت");
    if (buf.subarray(0, 2).toString("latin1") !== "PK") throw badRequest("الملف ليس بصيغة xlsx صحيحة");

    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buf as unknown as ArrayBuffer);
    } catch {
      throw badRequest("تعذر قراءة الملف. تأكد أنه xlsx سليم");
    }
    const ws = wb.worksheets[0];
    if (!ws) throw badRequest("الملف لا يحتوي على أوراق");
    if (ws.rowCount - 1 > MAX_ROWS) throw badRequest(`الحد الأقصى ${MAX_ROWS} صف في الملف الواحد`);

    return tenantTx(req, async (db) => {
      const units = await loadUnits(db);
      const byCode = new Map((await db.query<{ id: string; code: string }>("SELECT id, code FROM units")).rows.map((u) => [u.code.toLowerCase(), u.id]));
      const errors: { row: number; message: string }[] = [];
      const parsed: IngredientInput[] = [];

      for (let r = 2; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const c = (i: number) => cellText(row.getCell(i).value);
        if (!c(1) && !c(3) && !c(4)) continue; // blank line
        const baseUnitId = byCode.get(c(3).toLowerCase());
        const purchaseUnitId = byCode.get(c(4).toLowerCase());
        if (!baseUnitId) { errors.push({ row: r, message: `وحدة الأساس "${c(3)}" غير موجودة` }); continue; }
        if (!purchaseUnitId) { errors.push({ row: r, message: `وحدة الشراء "${c(4)}" غير موجودة` }); continue; }
        const num = (i: number) => (c(i) === "" ? undefined : Number(c(i)));
        const res = ingredientSchema.safeParse({
          name: c(1), category: c(2) || null, baseUnitId, purchaseUnitId,
          purchaseToBase: num(5), yieldPercentage: num(6) ?? 100, minStock: num(7) ?? 0, barcode: c(8) || null,
        });
        if (!res.success) { errors.push({ row: r, message: res.error.issues[0]?.message ?? "بيانات غير صالحة" }); continue; }
        try {
          resolvePurchaseToBase(res.data, units); // same-dimension units derive the factor; otherwise it must be provided
          parsed.push(res.data);
        } catch (e) {
          errors.push({ row: r, message: e instanceof AppError ? e.message : "بيانات غير صالحة" });
        }
      }
      if (errors.length) throw new AppError(422, "import_invalid", `يوجد ${errors.length} صف غير صالح. لم يتم حفظ أي صف`, { errors: errors.slice(0, 100) });
      if (!parsed.length) throw badRequest("الملف لا يحتوي على بيانات");

      for (const item of parsed) await insertIngredient(db, item, units);
      await auditTenant(db, req, "ingredient.imported", "ingredient", "bulk", { count: parsed.length });
      return { imported: parsed.length };
    });
  });
}
