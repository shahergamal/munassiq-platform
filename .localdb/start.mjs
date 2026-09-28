// Local PostgreSQL 16 for machines without Docker. Mirrors docker-compose.yml + db/bootstrap-roles.sh:
// owner munassiq_owner, database munassiq, roles munassiq_app (RLS enforced) and munassiq_system (BYPASSRLS), port 5432.
// Usage: node .localdb/start.mjs        (keeps running; Ctrl+C stops it)
//        node .localdb/start.mjs --reset (wipes the data directory first)
import EmbeddedPostgres from "embedded-postgres";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const dataDir = join(import.meta.dirname, "data");
if (process.argv.includes("--reset")) rmSync(dataDir, { recursive: true, force: true });
const fresh = !existsSync(dataDir);

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: "munassiq_owner",
  password: "change-me-owner",
  port: 5432,
  persistent: true,
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  postgresFlags: ["-c", "listen_addresses=127.0.0.1", "-c", "max_connections=200"],
});

if (fresh) await pg.initialise();
await pg.start();
if (fresh) {
  await pg.createDatabase("munassiq");
  const c = pg.getPgClient("munassiq");
  await c.connect();
  await c.query("CREATE ROLE munassiq_app LOGIN PASSWORD 'change-me-app' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS");
  await c.query("CREATE ROLE munassiq_system LOGIN PASSWORD 'change-me-system' NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS");
  await c.query('GRANT CONNECT ON DATABASE "munassiq" TO munassiq_app, munassiq_system; GRANT USAGE ON SCHEMA public TO munassiq_app, munassiq_system;');
  await c.end();
}
const c = pg.getPgClient("munassiq");
await c.connect();
console.log("ready:", (await c.query("select version()")).rows[0].version);
await c.end();

const stop = async () => { await pg.stop(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30);
