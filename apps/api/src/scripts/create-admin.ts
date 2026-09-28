import { createInterface } from "node:readline/promises";
import pg from "pg";
import { hashPassword, passwordProblem } from "../lib/security.ts";

// The first platform admin is created from the server console, never through the web app.
//   npm run admin:create -- --email you@company.com --name "Your Name"     (password is prompted; or ADMIN_PASSWORD env)
const args = process.argv.slice(2);
const arg = (n: string) => args[args.indexOf(`--${n}`) + 1];
const email = arg("email")?.trim().toLowerCase();
const name = arg("name")?.trim();
if (!email || !name) {
  console.error('Usage: npm run admin:create -- --email you@company.com --name "Full Name"');
  process.exit(1);
}
let password = process.env["ADMIN_PASSWORD"];
if (!password) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  password = await rl.question("Password (min 10 chars, visible while typing): ");
  rl.close();
}
const problem = passwordProblem(password, email);
if (problem) {
  console.error(problem);
  process.exit(1);
}
const url = process.env["SYSTEM_DATABASE_URL"];
if (!url) {
  console.error("SYSTEM_DATABASE_URL is required");
  process.exit(1);
}
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const hash = await hashPassword(password);
  await client.query("BEGIN");
  const r = await client.query(
    `INSERT INTO users (email, password_hash, full_name, email_verified_at, is_platform_admin) VALUES ($1, $2, $3, now(), true)
     ON CONFLICT (email) DO UPDATE SET is_platform_admin = true, password_hash = EXCLUDED.password_hash, email_verified_at = coalesce(users.email_verified_at, now())
     RETURNING id`, [email, hash, name]);
  await client.query("INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id) VALUES ($1, 'admin.bootstrapped', 'user', $2)", [r.rows[0].id, r.rows[0].id]);
  await client.query("COMMIT");
  console.log(`Platform admin ready: ${email}`);
} catch (err) {
  await client.query("ROLLBACK");
  throw err;
} finally {
  await client.end();
}
