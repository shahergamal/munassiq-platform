import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { systemPool, withSystemTx } from "../db/pool.ts";
import { AppError, forbidden } from "../lib/errors.ts";
import { createTenant } from "../lib/tenancy.ts";
import { requireUser } from "../plugins/auth.ts";

export default async function tenantRoutes(app: FastifyInstance) {
  // Public: the sector list the sign-up form uses. Sectors that are not built yet are shown as "coming soon".
  app.get("/sectors", async () => {
    const { rows } = await systemPool.query('SELECT key, name_ar AS "nameAr", is_available AS "isAvailable" FROM sectors ORDER BY is_available DESC, key');
    return rows;
  });

  app.post("/waitlist", { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } }, async (req, reply) => {
    const body = z.object({
      email: z.string().trim().toLowerCase().email().max(255),
      companyName: z.string().trim().min(2).max(180),
      sector: z.string().trim().min(2).max(40),
      phone: z.string().trim().regex(/^\+?[0-9]{9,15}$/).optional(),
    }).parse(req.body);
    await systemPool.query(
      `INSERT INTO waitlist (email, company_name, sector, phone)
       SELECT $1, $2, s.key, $4 FROM sectors s WHERE s.key = $3 AND NOT s.is_available
       ON CONFLICT (email, sector) DO NOTHING`,
      [body.email, body.companyName, body.sector, body.phone ?? null],
    );
    return reply.status(202).send({ ok: true });
  });

  // Create a workspace. Requires a VERIFIED account; the owner e-mail is the account e-mail, never a typed value.
  app.post("/tenants", { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } }, async (req, reply) => {
    const user = await requireUser(req);
    if (!user.emailVerified) throw forbidden("فعّل بريدك الإلكتروني قبل إنشاء منشأة");
    const body = z.object({
      companyName: z.string().trim().min(2, "أدخل اسم المنشأة").max(180),
      sector: z.string().trim().min(2).max(40),
      taxId: z.string().trim().regex(/^[0-9]{10,15}$/, "أدخل رقماً ضريبياً أو سجلاً تجارياً صحيحاً (10 إلى 15 رقماً)"),
      city: z.string().trim().max(100).optional(),
    }).parse(req.body);

    const id = await withSystemTx((db) => createTenant(db, req, { ownerId: user.id, companyName: body.companyName, sector: body.sector, taxId: body.taxId, city: body.city ?? null }));
    return reply.status(201).send({ id });
  });
}
