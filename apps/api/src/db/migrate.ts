import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

// Single source of truth for the schema: db/migrations/*.sql, applied in order, checksummed, one transaction each.
const url = process.env["MIGRATE_DATABASE_URL"];
if (!url) {
  console.error("MIGRATE_DATABASE_URL is required");
  process.exit(1);
}
const dir = join(import.meta.dirname, "..", "..", "..", "..", "db", "migrations");
const client = new pg.Client({ connectionString: url });

async function main() {
  await client.connect();
  await client.query("SELECT pg_advisory_lock(727001)");
  await client.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const applied = new Map<string, string>(
    (await client.query<{ name: string; checksum: string }>("SELECT name, checksum FROM schema_migrations")).rows.map((r) => [r.name, r.checksum]),
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = await readFile(join(dir, file), "utf8");
    // Line endings do not change a migration: a Windows checkout (CRLF) and the CI one (LF) are the same file. The
    // checksum is of the LF form; one recorded from a CRLF checkout before this rule is still recognised.
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    const lf = sql.replace(/\r\n/g, "\n");
    const checksum = sha(lf);
    const previous = applied.get(file);
    if (previous) {
      if (previous !== checksum && previous !== sha(lf.replace(/\n/g, "\r\n"))) {
        throw new Error(`Migration ${file} was modified after being applied. Create a new migration instead.`);
      }
      continue;
    }
    console.log(`applying ${file}`);
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [file, checksum]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  }
  console.log("database is up to date");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => client.end());
