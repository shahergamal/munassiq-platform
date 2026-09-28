import { systemPool } from "../../db/pool.ts";

/**
 * Storage usage per workspace (its rows in every tenant-scoped table, as PostgreSQL stores them). Measuring is a
 * scan, so it runs in the background every hour and on demand (admin "recalculate", after a storage purchase);
 * limits are checked against the last measurement.
 */
export async function measureTenant(tenantId: string) {
  await systemPool.query(
    `INSERT INTO tenant_storage (tenant_id, used_bytes, measured_at) VALUES ($1, tenant_storage_bytes($1), now())
     ON CONFLICT (tenant_id) DO UPDATE SET used_bytes = EXCLUDED.used_bytes, measured_at = EXCLUDED.measured_at`, [tenantId]);
}

export async function measureAll(log: (err: unknown) => void = () => undefined) {
  const ids = (await systemPool.query<{ id: string }>("SELECT id FROM tenants WHERE status <> 'archived'")).rows;
  for (const { id } of ids) await measureTenant(id).catch(log);
  return ids.length;
}

export function startStorageMeter(log: (err: unknown) => void) {
  const run = () => void measureAll(log).catch(log);
  const first = setTimeout(run, 30_000);
  const every = setInterval(run, 60 * 60_000);
  first.unref(); every.unref();
}

export const mb = (bytes: number) => Math.round((bytes / 1048576) * 10) / 10;
