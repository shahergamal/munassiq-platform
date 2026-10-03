import { randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../db/pool.ts";
import { AppError } from "./errors.ts";
import { auditSystem } from "../plugins/auth.ts";

export const MAX_OWNED_TENANTS = 3;
const EXPENSE_CATEGORIES: Record<string, string[]> = {
  restaurants: ["الإيجار", "الرواتب والأجور", "الكهرباء والماء", "الغاز", "الصيانة", "التسويق", "النظافة والمستهلكات", "رسوم حكومية", "عمولات التوصيل", "أخرى"],
  contracting: ["الإيجار", "الرواتب والأجور", "إيجار المعدات", "الوقود والطاقة", "التأمين", "رسوم الضمانات البنكية", "رسوم حكومية وتصاريح", "النقل", "أخرى"],
  manufacturing: ["الإيجار", "الرواتب والأجور", "الكهرباء والماء", "الوقود والطاقة", "صيانة الآلات", "النقل والشحن", "التأمين", "التسويق", "رسوم حكومية", "أخرى"],
};

/** Platform defaults for NEW workspaces (edited in /admin/settings). */
export const generalSettingsSchema = z.object({
  trialDays: z.number().int().min(1, "مدة التجربة يوم واحد على الأقل").max(90, "مدة التجربة 90 يوماً على الأكثر"),
  defaultVatPercent: z.number().min(0).max(100),
  defaultDiscountApprovalPercent: z.number().min(0).max(100),
});
export type GeneralSettings = z.infer<typeof generalSettingsSchema>;
export const defaultGeneralSettings: GeneralSettings = { trialDays: 14, defaultVatPercent: 15, defaultDiscountApprovalPercent: 10 };

export async function readGeneralSettings(db: Pick<Db, "query">): Promise<GeneralSettings> {
  const r = (await db.query<{ value: unknown }>("SELECT value FROM platform_settings WHERE key = 'general'")).rows[0];
  const parsed = generalSettingsSchema.safeParse({ ...defaultGeneralSettings, ...(r?.value as object | undefined) });
  return parsed.success ? parsed.data : defaultGeneralSettings;
}

export interface NewTenant {
  ownerId: string;
  companyName: string;
  sector: string;
  taxId: string;
  city: string | null;
  /** Omitted: the sector's trial plan for the platform's trial length. */
  plan?: { code: string; status: "trial" | "active"; endsAt: string; totalValue: number };
  /**
   * A platform admin may open a workspace in a sector that is not on sale yet: a pilot customer, set up by hand and
   * audited. Self sign-up never can.
   */
  pilot?: boolean;
}

/**
 * The ONE way a workspace is created (self sign-up and platform admin): same checks, same defaults, one audit record.
 * Must run inside a system transaction.
 */
export async function createTenant(db: Db, req: FastifyRequest, t: NewTenant): Promise<string> {
  const sector = await db.query<{ is_available: boolean }>("SELECT is_available FROM sectors WHERE key = $1", [t.sector]);
  if (!sector.rows[0]) throw new AppError(422, "validation_failed", "قطاع غير معروف");
  if (!sector.rows[0].is_available && !t.pilot) throw new AppError(422, "sector_unavailable", "هذا القطاع غير متاح بعد. سجّل اهتمامك وسنبلغك فور إطلاقه");
  const owned = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM tenants WHERE owner_user_id = $1 AND status <> 'archived'", [t.ownerId]);
  if (Number(owned.rows[0]?.n) >= MAX_OWNED_TENANTS) throw new AppError(409, "tenant_limit", "وصلت إلى الحد الأقصى لعدد المنشآت لهذا الحساب");

  const settings = await readGeneralSettings(db);
  const planCode = t.plan?.code ?? `${t.sector}-trial`;
  const plan = (await db.query<{ id: string; sector: string }>("SELECT id, sector FROM plans WHERE code = $1 AND is_active", [planCode])).rows[0];
  if (!plan) {
    if (t.plan) throw new AppError(422, "validation_failed", "الباقة غير موجودة أو موقوفة");
    throw sector.rows[0].is_available ? new AppError(500, "internal", "باقة التجربة غير مهيأة") : new AppError(422, "sector_unavailable", "لا توجد باقات لهذا القطاع بعد");
  }
  if (plan.sector !== t.sector) throw new AppError(422, "validation_failed", "الباقة تخص قطاعاً آخر");

  const slug = `t-${randomBytes(6).toString("hex")}`;
  const tenantId = (await db.query<{ id: string }>(
    "INSERT INTO tenants (company_name, sector, tax_id, city, slug, owner_user_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    [t.companyName, t.sector, t.taxId, t.city, slug, t.ownerId])).rows[0]!.id;
  if (t.plan) {
    await db.query("INSERT INTO subscriptions (tenant_id, plan_id, status, starts_at, ends_at, total_value) VALUES ($1, $2, $3, current_date, $4::date, $5)",
      [tenantId, plan.id, t.plan.status, t.plan.endsAt, t.plan.totalValue]);
  } else {
    await db.query("INSERT INTO subscriptions (tenant_id, plan_id, status, starts_at, ends_at) VALUES ($1, $2, 'trial', current_date, current_date + $3::int)",
      [tenantId, plan.id, settings.trialDays]);
  }
  await db.query("INSERT INTO tenant_settings (tenant_id, vat_rate_percent, discount_approval_percent) VALUES ($1, $2, $3)",
    [tenantId, settings.defaultVatPercent, settings.defaultDiscountApprovalPercent]);
  await db.query("INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')", [tenantId, t.ownerId]);
  await db.query("SELECT seed_units($1, $2)", [tenantId, t.sector]);
  for (const name of EXPENSE_CATEGORIES[t.sector] ?? EXPENSE_CATEGORIES["restaurants"]!) {
    await db.query("INSERT INTO expense_categories (tenant_id, name) VALUES ($1, $2)", [tenantId, name]);
  }
  // Chart of accounts (and the category → account mapping): the ledger posts from the very first sale.
  await db.query("SELECT seed_chart_of_accounts($1)", [tenantId]);
  await db.query("SELECT seed_payment_accounts($1)", [tenantId]);
  await db.query("SELECT seed_withholding_account($1)", [tenantId]);
  await db.query("SELECT seed_leave_types($1)", [tenantId]);
  if (t.sector === "manufacturing") await db.query("SELECT seed_manufacturing_accounts($1)", [tenantId]);
  if (t.sector === "contracting") {
    await db.query("SELECT seed_contracting_accounts($1)", [tenantId]);
    await db.query("SELECT seed_cost_codes($1)", [tenantId]);
  }
  await auditSystem(db, req, tenantId, "tenant.created", "tenant", tenantId, { sector: t.sector, plan: planCode, byAdmin: Boolean(t.plan), pilot: Boolean(t.pilot && !sector.rows[0].is_available) });
  return tenantId;
}
