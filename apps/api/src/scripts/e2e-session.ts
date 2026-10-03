// For the end-to-end tests (apps/web/e2e): a fresh verified user with a live session, a factory workspace and a
// contracting workspace,
// created directly in the database the way the integration tests do, so no password is ever typed or stored.
// Prints JSON { token, csrf, tenantId, contractingTenantId, email } on stdout. Local and CI databases only (refuses in production).
//
//   node --env-file=.env src/scripts/e2e-session.ts [--api http://localhost:4000]

import { randomInt } from "node:crypto";
import { config } from "../config.ts";
import { closePools, systemPool } from "../db/pool.ts";
import { csrfTokenFor, hashPassword, newToken, sha256Hex } from "../lib/security.ts";

if (config.isProd) throw new Error("e2e-session refuses to run in production");
const i = process.argv.indexOf("--api");
const base = `${i > 0 ? process.argv[i + 1] : "http://localhost:4000"}/api/v1`;

const email = `e2e-${Date.now()}-${randomInt(1e6)}@munassiq.test`;
const u = (await systemPool.query<{ id: string }>(
  "INSERT INTO users (email, password_hash, full_name, email_verified_at) VALUES ($1, $2, 'مستخدم الاختبار الآلي', now()) RETURNING id",
  [email, await hashPassword(newToken(24))])).rows[0]!;
const token = newToken(32);
const s = (await systemPool.query<{ id: string }>(
  "INSERT INTO sessions (user_id, token_hash, idle_expires_at, absolute_expires_at) VALUES ($1, $2, now() + interval '2 hours', now() + interval '1 day') RETURNING id",
  [u.id, sha256Hex(token)])).rows[0]!;
const csrf = csrfTokenFor(s.id, config.SESSION_SECRET);
// A 15-digit VAT number (3…3), unique enough for a test database.
const taxId = `3${String(randomInt(1e12)).padStart(12, "0")}03`;
const workspace = async (companyName: string, sector: string, vat: string) => {
  const r = await fetch(`${base}/tenants`, { method: "POST", headers: { "content-type": "application/json", cookie: `mn_sid=${token}`, "x-csrf-token": csrf, origin: config.APP_URL },
    body: JSON.stringify({ companyName, sector, taxId: vat, city: "الرياض" }) });
  if (r.status !== 201) throw new Error(`create workspace: ${r.status} ${await r.text()}`);
  return ((await r.json()) as { id: string }).id;
};
const tenantId = await workspace("مصنع الاختبار الآلي", "manufacturing", taxId);
const contractingTenantId = await workspace("مقاولات الاختبار الآلي", "contracting", `3${String(randomInt(1e12)).padStart(12, "0")}03`);
process.stdout.write(JSON.stringify({ token, csrf, tenantId, contractingTenantId, email }));
await closePools();
