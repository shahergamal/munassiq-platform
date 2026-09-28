import { appPool } from "../../db/pool.ts";
import { submitPending } from "./service.ts";

/**
 * The durable reporting worker. Documents are reported right after issue (submitSoon); anything that did not get
 * through (network down, ZATCA unavailable, server restarted before the send) is retried here, oldest first, with a
 * growing wait between attempts (1, 5, 15, then 60 minutes), so the 24-hour reporting window holds without trading.
 *
 * Which workspaces have work comes from `zatca_pending_work()`, which returns identifiers and counts only; each
 * workspace is then served inside its own RLS. One server at a time sweeps (a session advisory lock), so several
 * instances do not resend in parallel. Sending the same document twice is harmless anyway (ZATCA answers 409).
 */

const LOCK = 7_310_001; // pg_try_advisory_lock key reserved for this worker
export interface WorkerRun { at: string; tenants: number; attempted: number; accepted: number; rejected: number; errors: number }
let last: WorkerRun | null = null;
/** The last sweep of this server process (the ZATCA page shows it). */
export const lastWorkerRun = () => last;

export async function sweepZatca(limitTenants = 50): Promise<WorkerRun | null> {
  const client = await appPool.connect();
  try {
    const got = (await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [LOCK])).rows[0]!.ok;
    if (!got) return null;
    try {
      const work = (await client.query<{ tenant_id: string; user_id: string }>("SELECT tenant_id, user_id FROM zatca_pending_work($1)", [limitTenants])).rows;
      const run: WorkerRun = { at: new Date().toISOString(), tenants: work.length, attempted: 0, accepted: 0, rejected: 0, errors: 0 };
      for (const w of work) {
        try {
          const r = await submitPending({ tenantId: w.tenant_id, userId: w.user_id }, 25);
          run.attempted += r.attempted;
          run.accepted += r.accepted + r.accepted_with_warnings;
          run.rejected += r.rejected;
          run.errors += r.error;
        } catch {
          run.errors++;
        }
      }
      last = run;
      return run;
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [LOCK]);
    }
  } finally {
    client.release();
  }
}

export function startZatcaWorker(log: (err: unknown) => void, everyMs = 60_000) {
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    sweepZatca().catch(log).finally(() => { busy = false; });
  };
  const first = setTimeout(tick, 15_000);
  const every = setInterval(tick, everyMs);
  first.unref(); every.unref();
}
