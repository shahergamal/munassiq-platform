import pg from "pg";
import { config } from "../config.ts";

export type Db = pg.PoolClient;

// Tenant traffic: role munassiq_app. It cannot bypass row-level security.
export const appPool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 20,
  statement_timeout: 15_000,
  idle_in_transaction_session_timeout: 30_000,
});

// Authentication, provisioning and platform admin: role munassiq_system (BYPASSRLS). Used by narrow code paths only.
export const systemPool = new pg.Pool({
  connectionString: config.SYSTEM_DATABASE_URL,
  max: 10,
  statement_timeout: 15_000,
  idle_in_transaction_session_timeout: 30_000,
});

// An idle connection dropped by the server (restart, failover, network) is an 'error' event on the pool; without a
// listener Node treats it as unhandled and the whole process exits. The pool discards that client and opens a new one.
for (const [name, pool] of [["app", appPool], ["system", systemPool]] as const) {
  pool.on("error", (err) => console.error(`[db] idle ${name} connection lost: ${err.message}`));
}

async function run<T>(pool: pg.Pool, fn: (db: Db) => Promise<T>, begin: string, setup?: (db: Db) => Promise<void>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query(begin);
    if (setup) await setup(db);
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (err) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    db.release();
  }
}

export interface TenantCtx {
  tenantId: string;
  userId: string;
}

/** Runs `fn` in one transaction where PostgreSQL RLS sees this tenant. GET handlers pass readOnly. */
export function withTenantTx<T>(ctx: TenantCtx, fn: (db: Db) => Promise<T>, opts: { readOnly?: boolean } = {}): Promise<T> {
  return run(appPool, fn, opts.readOnly ? "BEGIN READ ONLY" : "BEGIN", (db) =>
    db.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [ctx.tenantId, ctx.userId]).then(() => undefined),
  );
}

export function withSystemTx<T>(fn: (db: Db) => Promise<T>, opts: { readOnly?: boolean } = {}): Promise<T> {
  return run(systemPool, fn, opts.readOnly ? "BEGIN READ ONLY" : "BEGIN");
}

export async function closePools(): Promise<void> {
  await Promise.all([appPool.end(), systemPool.end()]);
}
