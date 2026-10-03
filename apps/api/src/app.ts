import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { ZodError } from "zod";
import { config } from "./config.ts";
import { systemPool } from "./db/pool.ts";
import { AppError, fromPgError } from "./lib/errors.ts";
import adminRoutes from "./routes/admin.ts";
import { adminLandingRoutes, publicLandingRoutes } from "./routes/landing.ts";
import paymentsPublicRoutes from "./routes/paymentsPublic.ts";
import adminServerRoutes from "./routes/adminServer.ts";
import adminRegulatoryRoutes from "./routes/adminRegulatory.ts";
import contractingProjectRoutes from "./routes/contracting/projects.ts";
import contractingIpcRoutes from "./routes/contracting/ipcs.ts";
import contractingSubcontractorRoutes from "./routes/contracting/subcontractors.ts";
import contractingRevenueRoutes from "./routes/contracting/revenue.ts";
import contractingTenderRoutes from "./routes/contracting/tenders.ts";
import contractingSiteRoutes from "./routes/contracting/site.ts";
import contractingDashboardRoutes from "./routes/contracting/dashboard.ts";
import contractingLaborRoutes from "./routes/contracting/labor.ts";
import contractingControlRoutes from "./routes/contracting/control.ts";
import contractingQualityRoutes from "./routes/contracting/quality.ts";
import contractingDocumentRoutes from "./routes/contracting/documents.ts";
import contractingTelecomRoutes from "./routes/contracting/telecom.ts";
import contractingHandoverRoutes from "./routes/contracting/handover.ts";
import billingRoutes from "./routes/billing.ts";
import { recordSecurityEvent } from "./lib/ops/service.ts";
import paymentsRoutes from "./routes/restaurants/payments.ts";
import posOnlineRoutes from "./routes/restaurants/posOnline.ts";
import procurementRoutes from "./routes/restaurants/procurement.ts";
import barcodeRoutes from "./routes/restaurants/barcodes.ts";
import reports3Routes from "./routes/restaurants/reports3.ts";
import batchRoutes from "./routes/restaurants/batches.ts";
import posTicketRoutes from "./routes/restaurants/posTickets.ts";
import adminOpsRoutes from "./routes/adminOps.ts";
import adminAssistantRoutes from "./routes/adminAssistant.ts";
import assistantRoutes from "./routes/assistant.ts";
import authRoutes from "./routes/auth.ts";
import mfaRoutes from "./routes/mfa.ts";
import purchasesRoutes from "./routes/restaurants/purchases.ts";
import posRoutes from "./routes/restaurants/pos.ts";
import recipesRoutes from "./routes/restaurants/recipes.ts";
import reportsRoutes from "./routes/restaurants/reports.ts";
import accountingRoutes from "./routes/restaurants/accounting.ts";
import salesRoutes from "./routes/restaurants/sales.ts";
import zatcaRoutes from "./routes/restaurants/zatca.ts";
import { catalogRoutes } from "./routes/restaurants/catalog.ts";
import importRoutes from "./routes/restaurants/import.ts";
import inventoryRoutes from "./routes/restaurants/inventory.ts";
import payablesRoutes from "./routes/restaurants/payables.ts";
import prepRoutes from "./routes/restaurants/prep.ts";
import posSetupRoutes from "./routes/restaurants/possetup.ts";
import reports2Routes from "./routes/restaurants/reports2.ts";
import productionRoutes from "./routes/manufacturing/production.ts";
import planningRoutes from "./routes/manufacturing/planning.ts";
import qualityRoutes from "./routes/manufacturing/quality.ts";
import maintenanceRoutes from "./routes/manufacturing/maintenance.ts";
import employeeRoutes from "./routes/hr/employees.ts";
import hrTimeRoutes from "./routes/hr/time.ts";
import payrollRoutes from "./routes/hr/payroll.ts";
import operationsReportRoutes from "./routes/reports/operations.ts";
import salesOrderRoutes from "./routes/sales/orders.ts";
import priceListRoutes from "./routes/sales/priceLists.ts";
import tenantRoutes from "./routes/tenants.ts";
import workspaceRoutes from "./routes/workspace.ts";

export async function buildApp() {
  const app = Fastify({
    trustProxy: config.isProd,
    bodyLimit: 1_000_000,
    logger: {
      level: config.NODE_ENV === "test" ? "silent" : config.isProd ? "info" : "debug",
      redact: ["req.headers.cookie", "req.headers.authorization", "req.headers['x-csrf-token']", "res.headers['set-cookie']"],
    },
  });

  await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: config.RATE_LIMIT_PER_MINUTE, timeWindow: "1 minute" });
  await app.register(multipart, { limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 5 } });

  // Cross-site request defence, layer 1: browsers always send Origin on unsafe cross-site requests.
  // (Layer 2: SameSite=Lax session cookie. Layer 3: per-session CSRF token on every authenticated unsafe call.)
  app.addHook("onRequest", async (req) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin && origin !== config.appOrigin) {
        recordSecurityEvent(req.ip, "origin_rejected", req.url);
        throw new AppError(403, "origin_not_allowed", "مصدر الطلب غير مسموح");
      }
    }
  });

  // Traffic the admin's "suspicious IPs" list is built from: failed sign-ins and rate limiting.
  app.addHook("onResponse", async (req, reply) => {
    if (reply.statusCode === 429) recordSecurityEvent(req.ip, "rate_limited", req.url);
    else if (reply.statusCode === 401 && req.method === "POST" && req.url.startsWith("/api/v1/auth/login")) recordSecurityEvent(req.ip, "login_failed", req.url);
  });

  // Must be set BEFORE the route plugins are registered: encapsulated plugins inherit the handler at registration time.
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: "not_found", message: "المسار غير موجود" } }));

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      const fields = err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
      return reply.status(422).send({ error: { code: "validation_failed", message: fields[0]?.message ?? "بيانات غير صالحة", details: fields } });
    }
    const pg = fromPgError(err);
    if (pg) return reply.status(pg.status).send({ error: { code: pg.code, message: pg.message, details: pg.details } });

    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429) return reply.status(429).send({ error: { code: "rate_limited", message: "عدد الطلبات كبير. حاول بعد قليل" } });
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: { code: "bad_request", message: "الطلب غير صالح" } });
    }
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send({ error: { code: "internal", message: "حدث خطأ غير متوقع. حاول مرة أخرى، وإذا استمر تواصل مع الدعم" } });
  });

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/readyz", async () => {
    await systemPool.query("SELECT 1");
    return { ok: true };
  });

  const v1 = "/api/v1";
  await app.register(authRoutes, { prefix: `${v1}/auth` });
  await app.register(mfaRoutes, { prefix: `${v1}/auth` });
  await app.register(tenantRoutes, { prefix: v1 });
  await app.register(adminRoutes, { prefix: `${v1}/admin` });
  await app.register(adminLandingRoutes, { prefix: `${v1}/admin` });
  await app.register(adminOpsRoutes, { prefix: `${v1}/admin` });
  await app.register(adminAssistantRoutes, { prefix: `${v1}/admin` });
  await app.register(adminServerRoutes, { prefix: `${v1}/admin` });
  await app.register(adminRegulatoryRoutes, { prefix: `${v1}/admin` });
  await app.register(publicLandingRoutes, { prefix: v1 });
  await app.register(paymentsPublicRoutes, { prefix: v1 });
  await app.register(async (t) => {
    await t.register(workspaceRoutes);
    await t.register(billingRoutes);
    await t.register(catalogRoutes);
    await t.register(productionRoutes);
    await t.register(planningRoutes);
    await t.register(qualityRoutes);
    await t.register(maintenanceRoutes);
    await t.register(employeeRoutes);
    await t.register(hrTimeRoutes);
    await t.register(payrollRoutes);
    await t.register(operationsReportRoutes);
    await t.register(contractingProjectRoutes);
    await t.register(contractingIpcRoutes);
    await t.register(contractingSubcontractorRoutes);
    await t.register(contractingRevenueRoutes);
    await t.register(contractingTenderRoutes);
    await t.register(contractingSiteRoutes);
    await t.register(contractingDashboardRoutes);
    await t.register(contractingLaborRoutes);
    await t.register(contractingControlRoutes);
    await t.register(contractingQualityRoutes);
    await t.register(contractingDocumentRoutes);
    await t.register(contractingTelecomRoutes);
    await t.register(contractingHandoverRoutes);
    await t.register(salesOrderRoutes);
    await t.register(priceListRoutes);
    await t.register(importRoutes);
    await t.register(purchasesRoutes);
    await t.register(inventoryRoutes);
    await t.register(prepRoutes);
    await t.register(payablesRoutes);
    await t.register(posSetupRoutes);
    await t.register(reports2Routes);
    await t.register(recipesRoutes);
    await t.register(posRoutes);
    await t.register(reportsRoutes);
    await t.register(accountingRoutes);
    await t.register(salesRoutes);
    await t.register(zatcaRoutes);
    await t.register(paymentsRoutes);
    await t.register(posOnlineRoutes);
    await t.register(procurementRoutes);
    await t.register(barcodeRoutes);
    await t.register(reports3Routes);
    await t.register(batchRoutes);
    await t.register(posTicketRoutes);
    await t.register(assistantRoutes);
  }, { prefix: `${v1}/t` });

  return app;
}
