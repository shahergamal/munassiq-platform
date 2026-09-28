import { FROM, p, TO, type ToolDef } from "./tools.ts";

/**
 * The platform administrator's assistant reads ONLY the admin API (/api/v1/admin), as the admin, through the
 * same requireAdmin check as the admin screens. No workspace's internal data (sales, stock, costs) is reachable:
 * that stays behind a temporary, audited, read-only support session, exactly as for the admin in person.
 */
const a = (d: Omit<ToolDef, "permission" | "base">): ToolDef => ({ ...d, permission: "platform:admin", base: "admin" });

export const ADMIN_TOOLS: ToolDef[] = [
  a({ name: "platform_stats", label: "ملخص المنصة", params: {}, path: () => "/stats",
    description: "Platform counts: active and blocked workspaces, users, running trials, subscriptions expiring within 7 days, paid active subscriptions, waitlist." }),
  a({ name: "platform_tenants", label: "المنشآت", list: true, params: { q: p.text("Company name, owner email or tax id contains"), status: p.oneOf(["active", "blocked", "archived"], "Workspace status") },
    description: "Workspaces (customers) with owner email, plan, subscription status and end date.", path: () => "/tenants", query: ["q", "status"] }),
  a({ name: "platform_tenant_detail", label: "تفاصيل منشأة", params: { id: p.id("Workspace id", true) }, required: ["id"],
    description: "One workspace: owner, subscription, plan, limits and usage, assistant limit, members and their roles.", path: (i) => `/tenants/${i.id}` }),
  a({ name: "platform_subscriptions", label: "الاشتراكات", list: true,
    params: { q: p.text("Company or owner email contains"), status: p.oneOf(["trial", "active", "expired", "suspended"], "Subscription status"), expiring: p.oneOf(["true", "false"], "true = ending within 30 days") },
    description: "Subscriptions with days left and contract value, plus totals (active, trial, expiring, lapsed).", path: () => "/subscriptions", query: ["q", "status", "expiring"] }),
  a({ name: "platform_users", label: "المستخدمون", list: true, params: { q: p.text("Email or name contains") },
    description: "User accounts: status, platform admin flag, email verified, last login, number of workspaces.", path: () => "/users", query: ["q"] }),
  a({ name: "platform_usage", label: "استهلاك الحدود", list: true, params: { q: p.text("Company contains"), near: p.oneOf(["true", "false"], "true = at 80% of a limit or more") },
    description: "Per workspace: branches and users used vs plan limits, locations, peak usage %.", path: () => "/usage", query: ["q", "near"] }),
  a({ name: "platform_plans", label: "الباقات", params: {}, path: () => "/plans",
    description: "Plans per sector: monthly and annual price, limits, public/featured, number of workspaces on each." }),
  a({ name: "platform_sectors", label: "القطاعات", params: {}, path: () => "/sectors",
    description: "Sectors: availability, workspaces, plans, waitlist size (and last 30 days)." }),
  a({ name: "platform_financial", label: "التقرير المالي", params: { from: FROM, to: TO }, path: () => "/reports/financial", query: ["from", "to"],
    description: "MRR, paid and trial counts, renewals due in 30 days, contracts in the period and their value, MRR by plan." }),
  a({ name: "platform_operations", label: "التقرير التشغيلي", params: { from: FROM, to: TO }, path: () => "/reports/operations", query: ["from", "to"],
    description: "New workspaces and users, trials started, conversions, dormant workspaces (no login in 14 days), suspended users, support sessions, waitlist; daily trend." }),
  a({ name: "platform_audit", label: "سجل التدقيق", list: true, params: {}, path: () => "/audit",
    description: "Latest audit log entries: time, action, entity, actor email." }),
  a({ name: "platform_waitlist", label: "قائمة الانتظار", list: true, params: {}, path: () => "/waitlist",
    description: "Waitlist sign-ups for sectors not yet available: company, sector, email, phone, date." }),
  a({ name: "platform_settings", label: "إعدادات المنصة", params: {}, path: () => "/settings",
    description: "Platform defaults for new workspaces: trial length, VAT rate, discount limit." }),
];
