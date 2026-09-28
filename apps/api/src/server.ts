import { buildApp } from "./app.ts";
import { config } from "./config.ts";
import { closePools } from "./db/pool.ts";
import { startStorageMeter } from "./lib/billing/storage.ts";
import { pruneSecurityEvents } from "./lib/ops/service.ts";
import { startZatcaWorker } from "./lib/zatca/worker.ts";

const app = await buildApp();

async function shutdown(signal: string) {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await closePools();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ port: config.PORT, host: config.HOST });

startStorageMeter((err) => app.log.warn({ err }, "storage measurement failed"));
startZatcaWorker((err) => app.log.warn({ err }, "zatca reporting sweep failed"));
setInterval(() => void pruneSecurityEvents().catch((err) => app.log.warn({ err }, "security events pruning failed")), 24 * 60 * 60_000).unref();
