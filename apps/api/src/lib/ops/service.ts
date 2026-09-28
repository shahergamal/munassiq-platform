import { statfs } from "node:fs/promises";
import { isIP } from "node:net";
import os from "node:os";
import { config } from "../../config.ts";
import { appPool, systemPool } from "../../db/pool.ts";
import { AppError } from "../errors.ts";

/**
 * The admin's operations screen: this server's health, the hosting platform's deploy hook, a graceful restart, and
 * Cloudflare (cache purge, IP blocks). Every external call goes through `transport`, replaced in tests.
 */

export interface OpsReply { status: number; body: any }
export type OpsTransport = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<OpsReply>;
const http: OpsTransport = async (url, init) => {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const text = await r.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { message: text.slice(0, 300) }; }
  return { status: r.status, body };
};
let transport: OpsTransport = http;
export function setOpsTransport(t: OpsTransport | null) { transport = t ?? http; }

export const features = () => ({
  cloudflare: Boolean(config.CLOUDFLARE_API_TOKEN && config.CLOUDFLARE_ZONE_ID),
  deploy: Boolean(config.DEPLOY_HOOK_URL),
  restart: config.SERVER_RESTART_ENABLED === "true",
});

// ── Server health ─────────────────────────────────────────────────────────────────
export async function serverStats() {
  const mem = process.memoryUsage();
  let disk: { totalBytes: number; freeBytes: number } | null = null;
  try {
    const s = await statfs(process.cwd());
    disk = { totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize };
  } catch { /* not available on this platform */ }
  const db = (await systemPool.query<{ size: string; connections: number; version: string }>(
    `SELECT pg_database_size(current_database())::text AS size,
            (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS connections,
            current_setting('server_version') AS version`)).rows[0]!;
  const pool = (p: typeof appPool) => ({ total: p.totalCount, idle: p.idleCount, waiting: p.waitingCount });
  const [l1, l5, l15] = os.loadavg();
  return {
    host: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    node: process.version,
    commit: config.SOURCE_COMMIT ?? null,
    environment: config.NODE_ENV,
    uptime: { server: Math.round(os.uptime()), process: Math.round(process.uptime()) },
    cpu: { cores: os.cpus().length, load: [l1, l5, l15].map((x) => Math.round((x ?? 0) * 100) / 100), model: os.cpus()[0]?.model ?? "" },
    memory: { totalBytes: os.totalmem(), freeBytes: os.freemem(), processRss: mem.rss, heapUsed: mem.heapUsed },
    disk,
    database: { sizeBytes: Number(db.size), connections: db.connections, version: db.version, appPool: pool(appPool), systemPool: pool(systemPool) },
    features: features(),
  };
}

// ── Deploy (the hosting platform builds and switches; this server only asks it to) ─────
export async function triggerDeploy() {
  if (!config.DEPLOY_HOOK_URL) throw new AppError(409, "not_configured", "زر النشر غير مربوط. ضع DEPLOY_HOOK_URL من منصة الاستضافة في متغيرات البيئة");
  let r: OpsReply;
  try {
    r = await transport(config.DEPLOY_HOOK_URL, { method: "POST", headers: { Accept: "application/json", ...(config.DEPLOY_HOOK_TOKEN ? { Authorization: `Bearer ${config.DEPLOY_HOOK_TOKEN}` } : {}) } });
  } catch {
    throw new AppError(502, "deploy_unreachable", "تعذر الوصول لمنصة الاستضافة. تحقق من الرابط والاتصال");
  }
  if (r.status === 401 || r.status === 403) throw new AppError(502, "deploy_rejected", "رفضت منصة الاستضافة الطلب: تحقق من DEPLOY_HOOK_TOKEN");
  if (r.status < 200 || r.status >= 300) throw new AppError(502, "deploy_rejected", `ردت منصة الاستضافة بالرمز ${r.status}`);
  return { accepted: true, status: r.status };
}

// ── Cloudflare ─────────────────────────────────────────────────────────────────────
const CF = "https://api.cloudflare.com/client/v4";
async function cf(method: string, path: string, body?: unknown) {
  if (!config.CLOUDFLARE_API_TOKEN || !config.CLOUDFLARE_ZONE_ID) {
    throw new AppError(409, "not_configured", "Cloudflare غير مربوط. ضع CLOUDFLARE_API_TOKEN وCLOUDFLARE_ZONE_ID في متغيرات البيئة");
  }
  let r: OpsReply;
  try {
    r = await transport(`${CF}/zones/${config.CLOUDFLARE_ZONE_ID}${path}`, {
      method, headers: { Authorization: `Bearer ${config.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json", Accept: "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new AppError(502, "cloudflare_unreachable", "تعذر الوصول إلى Cloudflare. أعد المحاولة");
  }
  if (!r.body?.success) {
    const msg = Array.isArray(r.body?.errors) ? r.body.errors.map((e: any) => e?.message).filter(Boolean).join(" — ") : "";
    throw new AppError(502, "cloudflare_error", `رفض Cloudflare الطلب${msg ? `: ${msg.slice(0, 300)}` : ` (${r.status})`}`);
  }
  return r.body.result;
}

export async function purgeCache(files: string[] | null) {
  await cf("POST", "/purge_cache", files?.length ? { files } : { purge_everything: true });
  return { purged: files?.length ? files.length : "everything" };
}

/** IPv4, IPv6, or a CIDR range; the Cloudflare target type follows. */
export function ipTarget(value: string): { target: "ip" | "ip6" | "ip_range"; value: string } | null {
  const v = value.trim();
  const [addr, bits, ...rest] = v.split("/");
  if (rest.length || !addr) return null;
  const kind = isIP(addr);
  if (!kind) return null;
  if (bits === undefined) return { target: kind === 4 ? "ip" : "ip6", value: addr };
  const n = Number(bits);
  if (!/^\d+$/.test(bits) || (kind === 4 ? n < 16 || n > 32 : n < 32 || n > 128)) return null;
  return { target: "ip_range", value: `${addr}/${n}` };
}

export async function listBlocks() {
  const result = await cf("GET", "/firewall/access_rules/rules?mode=block&per_page=100&page=1");
  return (Array.isArray(result) ? result : []).map((r: any) => ({
    id: String(r.id), value: String(r.configuration?.value ?? ""), target: String(r.configuration?.target ?? ""), notes: r.notes ? String(r.notes) : null, createdAt: r.created_on ?? null,
  }));
}

export async function blockIp(value: string, note: string, adminIp: string | null) {
  const t = ipTarget(value);
  if (!t) throw new AppError(422, "validation_failed", "عنوان IP غير صحيح. مثال: 203.0.113.7 أو 203.0.113.0/24");
  if (adminIp && (t.value === adminIp || (t.target === "ip_range" && inRange(adminIp, t.value)))) {
    throw new AppError(409, "self_block", "هذا عنوانك الحالي: حظره يقفل عليك لوحة التحكم");
  }
  const r = await cf("POST", "/firewall/access_rules/rules", { mode: "block", configuration: t, notes: `مُنَسِّق: ${note}`.slice(0, 500) });
  return { id: String(r?.id ?? ""), ...t };
}

export async function unblock(id: string) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new AppError(404, "not_found", "القاعدة غير موجودة");
  await cf("DELETE", `/firewall/access_rules/rules/${id}`);
}

function inRange(ip: string, cidr: string) {
  const [base, bits] = cidr.split("/");
  if (isIP(ip) !== 4 || isIP(base!) !== 4) return false;
  const n = (s: string) => s.split(".").reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
  const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (n(ip) & mask) === (n(base!) & mask);
}

// ── Suspicious traffic (recorded by the security hook in app.ts) ───────────────────
export type SecurityKind = "login_failed" | "rate_limited" | "origin_rejected" | "unauthorized";
export function recordSecurityEvent(ip: string | undefined, kind: SecurityKind, path: string) {
  if (!ip || !isIP(ip)) return;
  void systemPool.query("INSERT INTO security_events (ip, kind, path) VALUES ($1, $2, $3)", [ip, kind, path.split("?")[0]!.slice(0, 200)]).catch(() => undefined);
}

export async function suspiciousIps(hours: number, minEvents: number) {
  const { rows } = await systemPool.query(
    `SELECT host(ip) AS ip, count(*)::int AS events,
            count(*) FILTER (WHERE kind = 'login_failed')::int AS "loginFailed",
            count(*) FILTER (WHERE kind = 'rate_limited')::int AS "rateLimited",
            count(*) FILTER (WHERE kind IN ('origin_rejected', 'unauthorized'))::int AS other,
            min(at) AS "firstAt", max(at) AS "lastAt"
       FROM security_events WHERE at > now() - make_interval(hours => $1)
      GROUP BY ip HAVING count(*) >= $2 ORDER BY events DESC LIMIT 100`, [hours, minEvents]);
  return rows;
}

export function pruneSecurityEvents() {
  return systemPool.query("DELETE FROM security_events WHERE at < now() - interval '30 days'");
}
