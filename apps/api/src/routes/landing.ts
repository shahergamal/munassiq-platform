import type { FastifyInstance } from "fastify";
import { systemPool, withSystemTx } from "../db/pool.ts";
import { defaultLanding, landingSchema, mergeLanding } from "../lib/landing.ts";
import { auditSystem, requireAdmin } from "../plugins/auth.ts";

const KEY = "landing_content";

async function readStored(): Promise<{ value: unknown; updatedAt: Date | null; updatedBy: string | null }> {
  const r = (await systemPool.query<{ value: unknown; updated_at: Date; name: string | null }>(
    `SELECT s.value, s.updated_at, u.full_name AS name FROM platform_settings s LEFT JOIN users u ON u.id = s.updated_by WHERE s.key = $1`, [KEY])).rows[0];
  return { value: r?.value ?? null, updatedAt: r?.updated_at ?? null, updatedBy: r?.name ?? null };
}

/** Public landing page data: content, sectors and the plans marked public. No auth, no side effects. */
export async function publicLandingRoutes(app: FastifyInstance) {
  app.get("/public/landing", async (_req, reply) => {
    const [stored, sectors, plans] = await Promise.all([
      readStored(),
      systemPool.query('SELECT key, name_ar AS "nameAr", is_available AS "isAvailable" FROM sectors ORDER BY is_available DESC, key'),
      systemPool.query(
        `SELECT p.code, p.sector, p.name_ar AS "nameAr", p.description, p.features, p.badge, p.is_featured AS "isFeatured",
                p.monthly_price::float8 AS "monthlyPrice", p.annual_price::float8 AS "annualPrice",
                p.branches_limit AS "branchesLimit", p.users_limit AS "usersLimit"
           FROM plans p JOIN sectors s ON s.key = p.sector
          WHERE p.is_active AND p.is_public AND s.is_available
          ORDER BY p.sector, p.sort_order, p.monthly_price`),
    ]);
    reply.header("cache-control", "public, max-age=60");
    return { content: mergeLanding(stored.value), sectors: sectors.rows, plans: plans.rows };
  });
}

/** Platform admin: read, replace or reset the landing content. Every change is audited. */
export async function adminLandingRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAdmin);

  app.get("/landing-content", async () => {
    const s = await readStored();
    return { content: mergeLanding(s.value), defaults: defaultLanding, customized: s.value !== null, updatedAt: s.updatedAt, updatedBy: s.updatedBy };
  });

  app.put("/landing-content", async (req) => {
    const content = landingSchema.parse(req.body);
    await withSystemTx(async (db) => {
      await db.query(
        `INSERT INTO platform_settings (key, value, updated_by) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [KEY, JSON.stringify(content), req.auth!.id]);
      await auditSystem(db, req, null, "landing.updated", "platform_settings", KEY, {});
    });
    return { ok: true };
  });

  app.delete("/landing-content", async (req) => {
    await withSystemTx(async (db) => {
      await db.query("DELETE FROM platform_settings WHERE key = $1", [KEY]);
      await auditSystem(db, req, null, "landing.reset", "platform_settings", KEY, {});
    });
    return { ok: true };
  });
}
