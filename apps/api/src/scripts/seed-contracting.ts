// A contracting demo account for trying the sector locally (dev only, never production).
//   npm run demo:contracting [-- --email contracting.demo@munassiq.local] [--api http://localhost:4000]
// Creates a verified user and a contracting workspace, then fills it THROUGH THE API so every rule, RLS policy and
// posting applies. The password is generated once and written to apps/api/.demo-accounts.local (git-ignored).
// The private contract runs end to end (advance, IPCs, invoice, variation, claim, guarantee). The government contract
// stays a draft: its statutory caps apply only once the platform admin verifies them, and this script never does that.
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { FastifyRequest } from "fastify";
import { closePools, withSystemTx } from "../db/pool.ts";
import { hashPassword } from "../lib/security.ts";
import { createTenant } from "../lib/tenancy.ts";

if (process.env["NODE_ENV"] === "production") {
  console.error("demo accounts are for development only");
  process.exit(1);
}
const args = process.argv.slice(2);
const arg = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1]! : d; };
const email = arg("email", "contracting.demo@munassiq.local").toLowerCase();
const base = `${arg("api", "http://localhost:4000")}/api/v1`;
const file = new URL("../../.demo-accounts.local", import.meta.url);

const saved = existsSync(file) ? readFileSync(file, "utf8") : "";
const line = saved.split("\n").find((l) => l.startsWith(`${email} `));
const password = line ? line.slice(email.length + 1).trim() : `Cn-${randomBytes(9).toString("base64url")}`;
if (!line) writeFileSync(file, `${saved}${saved && !saved.endsWith("\n") ? "\n" : ""}${email} ${password}\n`);

const tenantId = await withSystemTx(async (db) => {
  const hash = await hashPassword(password);
  const u = (await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, email_verified_at) VALUES ($1, $2, 'مدير المشاريع التجريبي', now())
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`, [email, hash])).rows[0]!;
  const existing = (await db.query<{ id: string }>("SELECT id FROM tenants WHERE owner_user_id = $1 AND sector = 'contracting' AND status <> 'archived'", [u.id])).rows[0];
  if (existing) return existing.id;
  const req = { ip: "127.0.0.1", auth: { id: u.id } } as unknown as FastifyRequest;
  return createTenant(db, req, { ownerId: u.id, companyName: "شركة البنيان للمقاولات (تجريبي)", sector: "contracting", taxId: "3109876543", city: "الرياض" });
});
await closePools();

let cookie = "";
let csrf = "";
async function call<T = any>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), cookie, "x-csrf-token": csrf, "x-tenant-id": tenantId, ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}
const idem = () => ({ "idempotency-key": randomUUID() });
const login = await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
if (!login.ok) throw new Error(`login failed: ${login.status} ${await login.text()}`);
cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
csrf = ((await login.json()) as { csrfToken: string }).csrfToken;

// Resumable: a run that stopped part-way picks up from what exists.
const existing = (await call<{ items: { id: string; code: string }[] }>("GET", "/t/projects")).items;
if (existing.some((p) => p.code === "PRJ-RD7")) {
  await subcontracting();
  console.log(`ready (data already present): ${email} — password in apps/api/.demo-accounts.local`);
  process.exit(0);
}
const customer = async (name: string, body: object) =>
  (await call<{ items: { id: string; name: string }[] }>("GET", `/t/customers?q=${encodeURIComponent(name)}&pageSize=5`)).items.find((c) => c.name === name)?.id
  ?? (await call("POST", "/t/customers", { name, ...body })).id as string;

await call("PUT", "/t/accounting/tax-profile", { legalName: "شركة البنيان للمقاولات", crNumber: "1010456789", street: "طريق الملك عبدالعزيز", buildingNo: "7788",
  district: "الربوة", city: "الرياض", postalCode: "12814" });
const developer = await customer("شركة الأفق للتطوير العقاري", { phone: "0501234567", customerType: "business", vatNumber: "310555666700003",
  street: "طريق الملك فهد", buildingNo: "2121", district: "العليا", city: "الرياض", postalCode: "12211" });
const ministry = await customer("أمانة منطقة الرياض (تجريبي)", { phone: "0112223344", customerType: "business", vatNumber: "300000000000003",
  street: "شارع الأمير سلطان", buildingNo: "1000", district: "الملز", city: "الرياض", postalCode: "11564" });

// ── A private building contract, running ──────────────────────────────────────────────────────
let tower = existing.find((p) => p.code === "PRJ-TWR")?.id;
if (!tower) {
  tower = (await call("POST", "/t/projects", { code: "PRJ-TWR", name: "برج الأفق الإداري", specialty: "BUILDING", clientId: developer, location: "الرياض، حي الملقا" })).id as string;
  for (const [code, name] of [["B1", "المبنى الرئيسي"], ["B1-SUB", "الهيكل الإنشائي"], ["B1-FIN", "التشطيبات"]]) {
    const parent = code === "B1" ? null : (await call<{ wbs: { id: string; code: string }[] }>("GET", `/t/projects/${tower}`)).wbs.find((w) => w.code === "B1")!.id;
    await call("POST", `/t/projects/${tower}/wbs`, { code, name, parentId: parent });
  }
  await call("POST", `/t/projects/${tower}/permits`, { kind: "رخصة بناء", number: "4419-1447", issuer: "أمانة الرياض", expiresOn: addDays(45) });
}
const main = (await call<{ contracts: { id: string; number: string }[] }>("GET", `/t/projects/${tower}`)).contracts.find((c) => c.number === "AFQ-2026-01")?.id
  ?? (await call("POST", "/t/contracts", { projectId: tower, number: "AFQ-2026-01", title: "الأعمال الإنشائية والتشطيبات", customerId: developer, profile: "FIDIC_RED_2017",
  pricingModel: "UNIT_PRICE", governingRegime: "PRIVATE", signDate: addDays(-120), value: 4_800_000, advancePct: 10, retentionPct: 10, retentionCapPct: 5,
  ldRatePerDay: 2000, ldCapPct: 10 })).id as string;
if ((await call<{ status: string }>("GET", `/t/contracts/${main}`)).status === "draft") await runMain();

async function runMain() {
  // A half-built draft BOQ starts over (a section's delete takes its items with it).
  for (const top of (await call<{ items: { id: string; parentId: string | null }[] }>("GET", `/t/contracts/${main}/boq`)).items.filter((i) => !i.parentId)) {
    await call("DELETE", `/t/boq-items/${top.id}`);
}
const items: [string, string | null, string, string | null, number, number][] = [
  ["1", null, "الأعمال الخرسانية", null, 0, 0],
  ["1.1", "1", "خرسانة عادية تحت الأساسات", "m3", 250, 380],
  ["1.2", "1", "خرسانة مسلحة للأساسات والأعمدة", "m3", 1800, 950],
  ["1.3", "1", "حديد تسليح", "ton", 320, 3400],
  ["2", null, "أعمال المباني والتشطيبات", null, 0, 0],
  ["2.1", "2", "بلوك أسمنتي معزول", "m2", 6000, 85],
  ["2.2", "2", "لياسة داخلية وخارجية", "m2", 14000, 38],
  ["2.3", "2", "أرضيات بورسلان", "m2", 5200, 125],
  ["3", null, "أعمال متفرقة", null, 0, 0],
  ["3.1", "3", "تجهيز الموقع وإدارته", "ls", 1, 215_000],
];
const ids = new Map<string, string>();
for (const [code, parent, description, unit, quantity, rate] of items) {
  ids.set(code, (await call("POST", `/t/contracts/${main}/boq/items`, { code, description, parentId: parent ? ids.get(parent) : null, isSection: !unit, unit, quantity, rate })).id);
}
await call("POST", `/t/contracts/${main}/activate`);
await call("POST", `/t/contracts/${main}/guarantees`, { kind: "performance", number: "LG-88213", bank: "البنك الأهلي السعودي", amount: 240_000, issuedOn: addDays(-110),
  expiresOn: addDays(50), fee: 1800, feePaidFrom: "bank_transfer" });
await call("POST", `/t/contracts/${main}/guarantees`, { kind: "advance", number: "LG-88214", bank: "البنك الأهلي السعودي", amount: 480_000, issuedOn: addDays(-110),
  expiresOn: addDays(250), fee: 3600, feePaidFrom: "bank_transfer" });
await call("POST", `/t/contracts/${main}/advance`, { paymentMeans: "bank_transfer" }, idem());

// IPC 1: certified, approved and invoiced. IPC 2: submitted, waiting for the consultant.
const month = (back: number) => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - back); return d.toISOString().slice(0, 7); };
const lastDay = (ym: string) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).toISOString().slice(0, 10);
const ipc = async (ym: string, qty: Record<string, number>) => {
  const id = (await call("POST", `/t/contracts/${main}/ipcs`, { periodFrom: `${ym}-01`, periodTo: lastDay(ym) })).id as string;
  const d = await call<{ lines: { id: string; code: string | null }[] }>("GET", `/t/ipcs/${id}`);
  await call("PUT", `/t/ipcs/${id}/quantities`, { lines: d.lines.filter((l) => l.code && qty[l.code] !== undefined).map((l) => ({ id: l.id, quantity: qty[l.code!] })) });
  await call("POST", `/t/ipcs/${id}/submit`, {});
  return { id, lines: d.lines };
};
const one = await ipc(month(2), { "1.1": 250, "1.2": 600, "1.3": 90, "3.1": 0.25 });
await call("POST", `/t/ipcs/${one.id}/certify`, { lines: one.lines.filter((l) => l.code === "1.2").map((l) => ({ id: l.id, quantity: 560 })) });
await call("POST", `/t/ipcs/${one.id}/approve`);
await call("POST", `/t/ipcs/${one.id}/invoice`, {}, idem());
await ipc(month(1), { "1.1": 250, "1.2": 1250, "1.3": 210, "2.1": 1500, "3.1": 0.5 });

const vo = (await call("POST", `/t/contracts/${main}/variations`, { title: "إضافة مظلات مواقف السيارات", source: "client_request", timeImpactDays: 14,
  lines: [{ kind: "new_item", code: "V1.1", description: "مظلات مواقف سيارات حديد وقماش PVC", unit: "m2", quantity: 900, rate: 210 }] })).id as string;
await call("POST", `/t/variations/${vo}/approve`, { contractorConsent: true });
await call("POST", `/t/contracts/${main}/variations`, { title: "زيادة كميات البلوك بعد تعديل المخططات", source: "design_change",
  lines: [{ kind: "change_qty", boqItemId: ids.get("2.1"), code: "2.1", description: "بلوك أسمنتي معزول", unit: "m2", quantity: 450, rate: 85 }] });
await call("POST", `/t/contracts/${main}/claims`, { title: "تأخر تسليم المخططات المعتمدة للدور الثالث", kind: "time_cost", eventDate: addDays(-12),
  description: "تأخر الاستشاري في اعتماد مخططات الدور الثالث 21 يوماً، مما أوقف أعمال الصب.", amountClaimed: 64_000, daysClaimed: 21 });
}

// ── A government road contract, left as a draft ───────────────────────────────────────────────
const road = (await call("POST", "/t/projects", { code: "PRJ-RD7", name: "تطوير طريق الخدمة الشرقي", specialty: "LINEAR", clientId: ministry, location: "الرياض" })).id as string;
const gov = (await call("POST", "/t/contracts", { projectId: road, number: "AMN-1447-332", title: "سفلتة وإنارة طريق الخدمة", customerId: ministry, profile: "ETIMAD_GC_2020",
  pricingModel: "UNIT_PRICE", governingRegime: "GTPL_1440", governmentClient: true, tenderDate: "2025-11-20", value: 0, ldRatePerDay: 1500 })).id as string;
void gov;
await subcontracting();

console.log(`ready: ${email} — password in apps/api/.demo-accounts.local`);

/** C4: two subcontractors on the tower (a registered resident and a non-resident), once only. */
async function subcontracting() {
  if ((await call<{ items: unknown[] }>("GET", "/t/subcontractors")).items.length) return;
  const towerId = (await call<{ items: { id: string; code: string }[] }>("GET", "/t/projects")).items.find((p) => p.code === "PRJ-TWR")!.id;
  const mainId = (await call<{ contracts: { id: string; number: string }[] }>("GET", `/t/projects/${towerId}`)).contracts.find((c) => c.number === "AFQ-2026-01")!.id;
  const elec = (await call("POST", "/t/suppliers", { code: "SUB-ELEC", name: "مؤسسة الإتقان للكهرباء", taxId: "310777888900003", phone: "0507778889", paymentTermsDays: 30 })).id as string;
  const hvac = (await call("POST", "/t/suppliers", { code: "SUB-HVAC", name: "Gulf HVAC Systems FZE", residency: "non_resident", paymentTermsDays: 45 })).id as string;
  await call("PUT", `/t/subcontractors/${elec}`, { crNumber: "1010778899", classificationField: "الأعمال الكهربائية", classificationGrade: "الثالثة", classificationExpiry: addDays(400),
    zakatCertExpiry: addDays(120), gosiCertExpiry: addDays(35), insuranceExpiry: addDays(200), specialties: "تمديدات وإنارة ولوحات", rating: 4 });
  await call("PUT", `/t/subcontractors/${hvac}`, { specialties: "تكييف مركزي", insuranceExpiry: addDays(300), rating: 5 });
  await call("POST", `/t/subcontractors/${elec}/approve`);
  await call("POST", `/t/subcontractors/${hvac}/approve`);
  const sub = async (supplierId: string, number: string, title: string, value: number, extra: object) => {
    const id = (await call("POST", "/t/contracts", { projectId: towerId, role: "SUB", number, title, supplierId, parentContractId: mainId, profile: "CUSTOM",
      pricingModel: "LUMP_SUM", governingRegime: "PRIVATE", value, ...extra })).id as string;
    await call("POST", `/t/contracts/${id}/boq/items`, { code: "S1", description: title, unit: "ls", quantity: 1, rate: value });
    await call("POST", `/t/contracts/${id}/activate`);
    return id;
  };
  const e = await sub(elec, "SUB-2026-01", "الأعمال الكهربائية للبرج", 900_000, { advancePct: 10, retentionPct: 10, retentionCapPct: 5 });
  const hv = await sub(hvac, "SUB-2026-02", "توريد وتركيب التكييف المركزي", 600_000, { retentionPct: 5, subcontractApprovalRef: "موافقة المالك 44/2026" });
  await call("POST", `/t/contracts/${e}/subcontract-advance`, { supplierInvoice: "ITQ-ADV-001", advanceDate: addDays(-40) }, idem());
  const ym = new Date().toISOString().slice(0, 7);
  const ipcOf = async (contractId: string, qty: number) => {
    const id = (await call("POST", `/t/contracts/${contractId}/ipcs`, { periodFrom: `${ym}-01`, periodTo: `${ym}-${String(new Date().getUTCDate()).padStart(2, "0")}` })).id as string;
    const line = (await call<{ lines: { id: string; kind: string }[] }>("GET", `/t/ipcs/${id}`)).lines.find((l) => l.kind === "boq")!;
    await call("PUT", `/t/ipcs/${id}/quantities`, { lines: [{ id: line.id, quantity: qty }] });
    return id;
  };
  const i1 = await ipcOf(e, 0.35);
  await call("PUT", `/t/ipcs/${i1}/deductions`, { items: [{ kind: "damages", description: "إصلاح تلف في تمديدات الدور الثاني", amount: 8_500 }] });
  await call("POST", `/t/ipcs/${i1}/submit`, {});
  await call("POST", `/t/ipcs/${i1}/approve`);
  await call("POST", `/t/ipcs/${i1}/record`, { supplierInvoice: "ITQ-INV-014" });
  const i2 = await ipcOf(hv, 0.4);
  await call("POST", `/t/ipcs/${i2}/submit`, {});
}

function addDays(n: number) { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
