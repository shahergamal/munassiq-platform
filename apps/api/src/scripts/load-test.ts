// A read-load test against a running API, with no dependencies: signs in as a demo account (password from the
// git-ignored apps/api/.demo-accounts.local, never printed), then keeps N concurrent clients requesting the pages
// people open most, for D seconds, and reports throughput, latency percentiles and errors per endpoint.
//
//   npm run load:test [-- --email factory.demo@munassiq.local --api http://localhost:4000 --clients 20 --seconds 30]
//
// Reads only: it never writes, so it is safe on a staging copy. The rate limit on login is not exercised.

import { readFileSync } from "node:fs";

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1]! : fallback; };
const email = arg("email", "factory.demo@munassiq.local");
const base = `${arg("api", "http://localhost:4000")}/api/v1`;
const clients = Number(arg("clients", "20"));
const seconds = Number(arg("seconds", "30"));

const line = readFileSync(new URL("../../.demo-accounts.local", import.meta.url), "utf8").split("\n").find((l) => l.startsWith(`${email} `));
if (!line) throw new Error(`no demo account ${email} in .demo-accounts.local (run npm run demo:factory first)`);
const password = line.slice(email.length + 1).trim();

const login = await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
if (!login.ok) throw new Error(`login failed: ${login.status}`);
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
const tenant = ((await login.json()) as { tenants: { id: string }[] }).tenants[0]?.id;
if (!tenant) throw new Error("the account has no workspace");
const tenantId: string = tenant;

const ENDPOINTS = [
  "/t/context", "/t/ingredients?pageSize=25", "/t/stock?pageSize=25", "/t/purchases?pageSize=25", "/t/sales-orders?pageSize=25",
  "/t/manufacturing-orders?pageSize=25", "/t/accounting/trial-balance", "/t/reports/production", "/t/reports/oee", "/t/employees",
];
const stats = new Map<string, { n: number; errors: number; ms: number[] }>(ENDPOINTS.map((e) => [e, { n: 0, errors: 0, ms: [] }]));
const until = Date.now() + seconds * 1000;
let i = 0;
const codes = new Map<string, number>();

async function client() {
  while (Date.now() < until) {
    const path = ENDPOINTS[i++ % ENDPOINTS.length]!;
    const s = stats.get(path)!;
    const t0 = performance.now();
    try {
      const r = await fetch(base + path, { headers: { cookie, "x-tenant-id": tenantId } });
      await r.arrayBuffer();
      codes.set(String(r.status), (codes.get(String(r.status)) ?? 0) + 1);
      if (!r.ok) s.errors++;
    } catch { s.errors++; codes.set("network", (codes.get("network") ?? 0) + 1); }
    s.n++; s.ms.push(performance.now() - t0);
  }
}

console.log(`${clients} clients × ${seconds}s against ${base}`);
await Promise.all(Array.from({ length: clients }, client));
const pct = (xs: number[], p: number) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))]! : 0; };
let total = 0, errors = 0;
const all: number[] = [];
console.log("endpoint".padEnd(40), "req".padStart(6), "err".padStart(5), "p50".padStart(7), "p95".padStart(7), "p99".padStart(7));
for (const [path, s] of stats) {
  total += s.n; errors += s.errors; all.push(...s.ms);
  console.log(path.padEnd(40), String(s.n).padStart(6), String(s.errors).padStart(5), ...[0.5, 0.95, 0.99].map((p) => `${pct(s.ms, p).toFixed(0)}ms`.padStart(7)));
}
console.log(`\ntotal ${total} requests, ${(total / seconds).toFixed(1)} req/s, errors ${errors} (${((errors / Math.max(1, total)) * 100).toFixed(2)}%), p50 ${pct(all, 0.5).toFixed(0)}ms, p95 ${pct(all, 0.95).toFixed(0)}ms, p99 ${pct(all, 0.99).toFixed(0)}ms`);
console.log(`responses: ${[...codes].map(([c, n]) => `${c}×${n}`).join(", ")}`);
process.exit(errors ? 1 : 0);
