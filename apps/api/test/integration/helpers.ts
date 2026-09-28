import "./env.ts";
import { randomInt, randomUUID } from "node:crypto";
import pg from "pg";
import { buildApp } from "../../src/app.ts";
import { config } from "../../src/config.ts";
import { closePools, systemPool } from "../../src/db/pool.ts";
import { csrfTokenFor, hashPassword, newToken, sha256Hex } from "../../src/lib/security.ts";

// Integration tests run against a REAL PostgreSQL (docker compose, or .localdb/start.mjs) with migrations applied.
// Every test creates its own users and tenants with random identifiers, so files can run in parallel.

/** Table owner (superuser in dev): used only to arrange state (expire a subscription) and to inspect results. */
export const ownerPool = new pg.Pool({ connectionString: process.env["MIGRATE_DATABASE_URL"], max: 5 });
/** The tenant-traffic role, used directly to prove what the database itself refuses. */
export const rawAppPool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 5 });

export type App = Awaited<ReturnType<typeof buildApp>>;

export interface Actor {
  id: string;
  email: string;
  token: string;
  csrf: string;
  ip: string;
}

export const PASSWORD = "Integration-Pass-123";
// Cheap scrypt cost for fixtures only; verifyPassword reads the parameters from the stored hash.
const FIXTURE_HASH = hashPassword(PASSWORD, { N: 1024 });

// Rate limits are per IP, so every actor gets its own address.
const ipBase = `10.${randomInt(0, 255)}.${randomInt(0, 255)}`;
let ipSeq = 0;
export const nextIp = () => `${ipBase}.${(ipSeq++ % 250) + 1}`;

export const uniqueEmail = (tag = "u") => `${tag}-${randomUUID().slice(0, 12)}@test.munassiq.local`;

export async function startApp(): Promise<App> {
  const app = await buildApp();
  await app.ready();
  return app;
}

export async function stopApp(app: App): Promise<void> {
  await app.close();
  await closePools();
  await ownerPool.end();
  await rawAppPool.end();
}

/** A verified user with a live session, created directly (the register/login flow has its own test). */
export async function createUser(opts: { admin?: boolean; name?: string } = {}): Promise<Actor> {
  const email = uniqueEmail(opts.admin ? "admin" : "u");
  const u = await systemPool.query<{ id: string }>(
    "INSERT INTO users (email, password_hash, full_name, email_verified_at, is_platform_admin) VALUES ($1, $2, $3, now(), $4) RETURNING id",
    [email, await FIXTURE_HASH, opts.name ?? "مستخدم اختبار", opts.admin ?? false],
  );
  const id = (u.rows[0] as { id: string }).id;
  const token = newToken(32);
  const s = await systemPool.query<{ id: string }>(
    `INSERT INTO sessions (user_id, token_hash, idle_expires_at, absolute_expires_at)
     VALUES ($1, $2, now() + interval '1 hour', now() + interval '1 day') RETURNING id`,
    [id, sha256Hex(token)],
  );
  const sessionId = (s.rows[0] as { id: string }).id;
  return { id, email, token, csrf: csrfTokenFor(sessionId, config.SESSION_SECRET), ip: nextIp() };
}

export interface Res<T = any> {
  status: number;
  body: T;
  headers: Record<string, unknown>;
}

export interface CallOpts {
  body?: unknown;
  tenant?: string;
  idem?: string | true;
  csrf?: string | false;
  headers?: Record<string, string>;
}

export async function call<T = any>(app: App, actor: Actor | null, method: string, url: string, opts: CallOpts = {}): Promise<Res<T>> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (actor) {
    headers["cookie"] = `mn_sid=${actor.token}`;
    if (opts.csrf !== false) headers["x-csrf-token"] = opts.csrf ?? actor.csrf;
  }
  if (opts.tenant) headers["x-tenant-id"] = opts.tenant;
  if (opts.idem) headers["idempotency-key"] = opts.idem === true ? randomUUID() : opts.idem;
  const res = await app.inject({
    method: method as "GET",
    url: `/api/v1${url}`,
    headers,
    remoteAddress: actor?.ip ?? nextIp(),
    ...(opts.body !== undefined ? { payload: opts.body as object } : {}),
  });
  let body: unknown = null;
  try {
    body = res.body ? JSON.parse(res.body) : null;
  } catch {
    body = res.body;
  }
  return { status: res.statusCode, body: body as T, headers: res.headers };
}

/** Fails with the response body in the message, which makes a broken fixture obvious. */
export function expectStatus(res: Res, status: number, what = "request"): void {
  if (res.status !== status) throw new Error(`${what}: expected ${status}, got ${res.status} ${JSON.stringify(res.body)}`);
}

const taxId = () => String(randomInt(1_000_000_000, 9_999_999_999)) + String(randomInt(10, 99));

export async function createTenant(app: App, owner: Actor, name = "مطعم الاختبار"): Promise<string> {
  const r = await call(app, owner, "POST", "/tenants", { body: { companyName: name, sector: "restaurants", taxId: taxId(), city: "الرياض" } });
  expectStatus(r, 201, "create tenant");
  return r.body.id as string;
}

let pilotAdmin: Actor | null = null;
/** A factory workspace. Until the sector is on sale it is a pilot the platform admin opens for the owner. */
export async function createFactory(app: App, owner: Actor, name = "مصنع الاختبار"): Promise<string> {
  const open = await call(app, owner, "POST", "/tenants", { body: { companyName: name, sector: "manufacturing", taxId: taxId(), city: "الرياض" } });
  if (open.status === 201) return open.body.id as string;
  pilotAdmin ??= await createUser({ admin: true });
  const r = await call(app, pilotAdmin, "POST", "/admin/tenants", { body: { ownerEmail: owner.email, companyName: name, sector: "manufacturing", taxId: taxId(), city: "الرياض" } });
  expectStatus(r, 201, "create factory");
  return r.body.id as string;
}

/** Adds a verified user to a tenant (the plan's user limit trigger still applies). */
export async function addMember(app: App, owner: Actor, tenant: string, role: "manager" | "accountant" | "inventory_clerk" | "cashier"): Promise<Actor> {
  const user = await createUser();
  const r = await call(app, owner, "POST", "/t/members", { tenant, body: { email: user.email, role } });
  expectStatus(r, 201, `add ${role}`);
  return user;
}

export async function unitId(app: App, actor: Actor, tenant: string, code: string): Promise<string> {
  const r = await call(app, actor, "GET", "/t/units", { tenant });
  expectStatus(r, 200, "units");
  const u = (r.body.items as { id: string; code: string }[]).find((x) => x.code === code);
  if (!u) throw new Error(`unit ${code} missing`);
  return u.id;
}

let codeSeq = 0;
export const code = (p: string) => `${p}${++codeSeq}${randomInt(100, 999)}`;

export interface Kitchen {
  locationId: string;
  supplierId: string;
  ingredientId: string; // base g, purchased in kg (1 kg = 1000 g)
}

/** A location, a supplier and one ingredient (tomatoes: base unit g, purchase unit kg). */
export async function setupKitchen(app: App, actor: Actor, tenant: string): Promise<Kitchen> {
  const loc = await call(app, actor, "POST", "/t/locations", { tenant, body: { code: code("K"), name: "المطبخ الرئيسي", locationType: "kitchen" } });
  expectStatus(loc, 201, "location");
  const sup = await call(app, actor, "POST", "/t/suppliers", { tenant, body: { code: code("S"), name: "مورد الخضار" } });
  expectStatus(sup, 201, "supplier");
  const ingredientId = await createIngredient(app, actor, tenant, "طماطم", "g", "kg");
  return { locationId: loc.body.id, supplierId: sup.body.id, ingredientId };
}

export async function createIngredient(app: App, actor: Actor, tenant: string, name: string, base: string, purchase: string, extra: object = {}): Promise<string> {
  const r = await call(app, actor, "POST", "/t/ingredients", {
    tenant,
    body: { name, baseUnitId: await unitId(app, actor, tenant, base), purchaseUnitId: await unitId(app, actor, tenant, purchase), ...extra },
  });
  expectStatus(r, 201, `ingredient ${name}`);
  return r.body.id as string;
}

export interface PoInput {
  supplierId: string;
  locationId: string;
  items: { ingredientId: string; quantity: number; unitPrice: number }[];
  discount?: number;
  shipping?: number;
  fees?: number;
}

export async function createApprovedPo(app: App, actor: Actor, tenant: string, po: PoInput): Promise<string> {
  const c = await call(app, actor, "POST", "/t/purchases", { tenant, idem: true, body: po });
  expectStatus(c, 201, "create PO");
  const a = await call(app, actor, "POST", `/t/purchases/${c.body.id}/approve`, { tenant });
  expectStatus(a, 200, "approve PO");
  return c.body.id as string;
}

export async function receivePo(app: App, actor: Actor, tenant: string, po: PoInput): Promise<string> {
  const id = await createApprovedPo(app, actor, tenant, po);
  const r = await call(app, actor, "POST", `/t/purchases/${id}/receive`, { tenant });
  expectStatus(r, 200, "receive PO");
  return id;
}

export async function createApprovedRecipe(app: App, actor: Actor, tenant: string, priceNet: number, items: { ingredientId: string; quantity: number }[]): Promise<string> {
  const r = await call(app, actor, "POST", "/t/recipes", { tenant, body: { code: code("R"), name: "سلطة", priceNet, items } });
  expectStatus(r, 201, "recipe");
  const s = await call(app, actor, "POST", `/t/recipes/${r.body.id}/status`, { tenant, body: { status: "approved" } });
  expectStatus(s, 200, "approve recipe");
  return r.body.id as string;
}

export async function openShift(app: App, actor: Actor, tenant: string, locationId: string): Promise<string> {
  const r = await call(app, actor, "POST", "/t/pos/shifts/open", { tenant, idem: true, body: { locationId, openingFloat: 100 } });
  expectStatus(r, 201, "open shift");
  return r.body.id as string;
}

export async function stockOf(tenant: string, locationId: string, ingredientId: string): Promise<{ quantity: number; avgCost: number }> {
  const r = await ownerPool.query<{ quantity: number; avg_cost: number }>(
    "SELECT quantity::float8 AS quantity, avg_cost::float8 AS avg_cost FROM stock_levels WHERE tenant_id = $1 AND location_id = $2 AND ingredient_id = $3",
    [tenant, locationId, ingredientId],
  );
  const row = r.rows[0];
  return { quantity: row?.quantity ?? 0, avgCost: row?.avg_cost ?? 0 };
}

/** Lifts the trial plan's 3-user / 1-branch caps for fixtures that need a full team. */
export async function raiseLimits(tenant: string): Promise<void> {
  await ownerPool.query(
    "INSERT INTO tenant_limit_overrides (tenant_id, branches_limit, users_limit) VALUES ($1, 10, 20) ON CONFLICT (tenant_id) DO UPDATE SET branches_limit = 10, users_limit = 20",
    [tenant],
  );
}

/** Moves a tenant's subscription into the past, keeping or changing its status. */
export async function expireSubscription(tenant: string, status: "trial" | "expired" = "expired"): Promise<void> {
  await ownerPool.query(
    "UPDATE subscriptions SET status = $2, starts_at = current_date - 30, ends_at = current_date - 1 WHERE tenant_id = $1",
    [tenant, status],
  );
}

/** Sets the subscription status and a future end date (e.g. suspended but not expired), or restores a trial. */
export async function setSubscriptionStatus(tenant: string, status: "trial" | "active" | "suspended"): Promise<void> {
  await ownerPool.query(
    "UPDATE subscriptions SET status = $2, starts_at = current_date - 1, ends_at = current_date + 14 WHERE tenant_id = $1",
    [tenant, status],
  );
}

/** Today's date in Riyadh (YYYY-MM-DD), the zone the API uses for business dates. */
export const isoToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh" }).format(new Date());
