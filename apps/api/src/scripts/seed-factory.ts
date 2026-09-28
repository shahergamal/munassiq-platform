// A factory demo account for trying the manufacturing sector locally (dev only, never production).
//   npm run demo:factory [-- --email factory.demo@munassiq.local] [--api http://localhost:4000]
// Creates a verified user and a pilot manufacturing workspace (the sector is not on sale yet), then fills it with
// demo data THROUGH THE API so every rule, RLS policy and posting applies. The password is generated once and
// written to apps/api/.demo-accounts.local (git-ignored), never printed.
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
const email = arg("email", "factory.demo@munassiq.local").toLowerCase();
const base = `${arg("api", "http://localhost:4000")}/api/v1`;
const file = new URL("../../.demo-accounts.local", import.meta.url);

// One password per demo e-mail, kept in the local file so re-running the script keeps working.
const saved = existsSync(file) ? readFileSync(file, "utf8") : "";
const line = saved.split("\n").find((l) => l.startsWith(`${email} `));
const password = line ? line.slice(email.length + 1).trim() : `Fx-${randomBytes(9).toString("base64url")}`;
if (!line) writeFileSync(file, `${saved}${saved && !saved.endsWith("\n") ? "\n" : ""}${email} ${password}\n`);

const tenantId = await withSystemTx(async (db) => {
  const hash = await hashPassword(password);
  const u = (await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, email_verified_at) VALUES ($1, $2, 'مدير المصنع التجريبي', now())
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`, [email, hash])).rows[0]!; // an existing account keeps its password (and sessions)
  const existing = (await db.query<{ id: string }>("SELECT id FROM tenants WHERE owner_user_id = $1 AND sector = 'manufacturing' AND status <> 'archived'", [u.id])).rows[0];
  if (existing) return existing.id;
  const req = { ip: "127.0.0.1", auth: { id: u.id } } as unknown as FastifyRequest;
  return createTenant(db, req, { ownerId: u.id, companyName: "مصنع الريادة للأغذية (تجريبي)", sector: "manufacturing", taxId: "3101234567", city: "الرياض", pilot: true });
});
await closePools();

// ── Demo data through the API ─────────────────────────────────────────────────────────────────
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
const login = await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
if (!login.ok) throw new Error(`login failed: ${login.status} ${await login.text()}`);
cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
csrf = ((await login.json()) as { csrfToken: string }).csrfToken;

if ((await call<{ meta: { total: number } }>("GET", "/t/locations?pageSize=1")).meta.total > 0) {
  await production();
  await sales();
  await planning();
  await quality();
  await maintenance();
  await prepayment();
  await hr();
  console.log(`ready (data already present): ${email} — password in apps/api/.demo-accounts.local`);
  process.exit(0);
}

const units = new Map((await call<{ items: { id: string; code: string }[] }>("GET", "/t/units")).items.map((u) => [u.code, u.id]));
const u = (c: string) => units.get(c)!;
const rawWh = (await call("POST", "/t/locations", { code: "WH-RM", name: "مستودع الخامات", locationType: "warehouse" })).id as string;
const floor = (await call("POST", "/t/locations", { code: "PROD-1", name: "صالة الإنتاج", locationType: "kitchen" })).id as string;
await call("POST", "/t/locations", { code: "WH-FG", name: "مستودع المنتج التام", locationType: "warehouse" });
const mill = (await call("POST", "/t/suppliers", { code: "SUP-MILL", name: "شركة المطاحن الأولى", phone: "0501112233", paymentTermsDays: 30 })).id as string;
const pack = (await call("POST", "/t/suppliers", { code: "SUP-PACK", name: "مصنع الكرتون الحديث", phone: "0504445566", paymentTermsDays: 15 })).id as string;

const item = async (name: string, nameEn: string, itemType: string, category: string, baseUnit: string, purchase: string, extra: object = {}) =>
  (await call("POST", "/t/ingredients", { name, nameEn, itemType, category, baseUnitId: u(baseUnit), purchaseUnitId: u(purchase), ...extra })).id as string;
const flour = await item("دقيق قمح فاخر", "Premium wheat flour", "raw", "حبوب", "kg", "ton", { minStock: 500 });
const sugar = await item("سكر ناعم", "Fine sugar", "raw", "محليات", "kg", "bag", { purchaseToBase: 50, minStock: 200 });
const oil = await item("زيت نخيل", "Palm oil", "raw", "زيوت", "l", "drum", { purchaseToBase: 200, minStock: 100, trackExpiry: true, shelfLifeDays: 180 });
const carton = await item("كرتون شحن 24 عبوة", "Shipping carton (24)", "packaging", "تعبئة", "pcs", "pallet", { purchaseToBase: 500, minStock: 300 });
const film = await item("فيلم تغليف مطبوع", "Printed wrapping film", "packaging", "تعبئة", "pcs", "roll", { purchaseToBase: 1000, minStock: 2000 });
await item("عجينة بسكويت", "Biscuit dough", "semi_finished", "إنتاج", "kg", "kg", { trackExpiry: true, shelfLifeDays: 2 });
await item("بسكويت بالزبدة 200 جم", "Butter biscuits 200 g", "finished", "منتجات", "pcs", "carton", { purchaseToBase: 24, minStock: 480, trackExpiry: true, shelfLifeDays: 270 });
await item("سير ناقل للفرن", "Oven conveyor belt", "spare_part", "قطع غيار", "pcs", "pcs", { minStock: 1 });
await item("زيت تشحيم الآلات", "Machine lubricant", "consumable", "صيانة", "l", "l", { minStock: 20 });

const receive = async (supplierId: string, locationId: string, items: { ingredientId: string; quantity: number; unitPrice: number }[], extra: object = {}) => {
  const po = await call("POST", "/t/purchases", { supplierId, locationId, items, ...extra }, { "idempotency-key": randomUUID() });
  await call("POST", `/t/purchases/${po.id}/approve`);
  await call("POST", `/t/purchases/${po.id}/receive`);
};
await receive(mill, rawWh, [{ ingredientId: flour, quantity: 3, unitPrice: 1450 }, { ingredientId: sugar, quantity: 20, unitPrice: 115 }], { shipping: 350, supplierInvoice: "ML-2231" });
await receive(pack, rawWh, [{ ingredientId: carton, quantity: 2, unitPrice: 900 }, { ingredientId: film, quantity: 5, unitPrice: 320 }]);
await receive(mill, floor, [{ ingredientId: oil, quantity: 2, unitPrice: 1100 }]);

await call("POST", "/t/cost-centers", { code: "LINE-1", name: "خط البسكويت", kind: "production" });
await call("POST", "/t/cost-centers", { code: "MAINT", name: "الصيانة", kind: "service" });
await call("POST", "/t/cost-centers", { code: "ADMIN", name: "الإدارة العامة", kind: "department" });

await production();
await sales();
await planning();
await quality();
await maintenance();
await prepayment();
await hr();
console.log(`ready: ${email} — password in apps/api/.demo-accounts.local`);

/** Work centers, the biscuit line's BOMs (dough as a sub-assembly) and one order in progress. Once only. */
async function production() {
  if ((await call<{ items: unknown[] }>("GET", "/t/work-centers")).items.length) return;
  const find = async (q: string) => (await call<{ items: { id: string }[] }>("GET", `/t/ingredients?q=${encodeURIComponent(q)}&pageSize=1`)).items[0]!.id;
  const locs = (await call<{ items: { id: string; code: string }[] }>("GET", "/t/locations?pageSize=50")).items;
  const floorId = locs.find((l) => l.code === "PROD-1")!.id;
  const fgId = locs.find((l) => l.code === "WH-FG")!.id;
  const rawId = locs.find((l) => l.code === "WH-RM")!.id;
  const [flourId, sugarId, oilId, cartonId, filmId, doughId, biscuitId] = await Promise.all(
    ["دقيق قمح فاخر", "سكر ناعم", "زيت نخيل", "كرتون شحن", "فيلم تغليف", "عجينة بسكويت", "بسكويت بالزبدة"].map(find));
  const line = (await call<{ items: { id: string; code: string }[] }>("GET", "/t/cost-centers")).items.find((c) => c.code === "LINE-1")?.id ?? null;
  const mixer = (await call("POST", "/t/work-centers", { code: "MIX-1", name: "خلاط العجين", locationId: floorId, costCenterId: line, hoursPerDay: 16, laborRate: 45, overheadRate: 25 })).id as string;
  const oven = (await call("POST", "/t/work-centers", { code: "OVEN-1", name: "الفرن النفقي", locationId: floorId, costCenterId: line, hoursPerDay: 16, laborRate: 60, overheadRate: 85 })).id as string;
  const pack = (await call("POST", "/t/work-centers", { code: "PACK-1", name: "خط التغليف", locationId: floorId, costCenterId: line, hoursPerDay: 8, laborRate: 40, overheadRate: 20 })).id as string;
  // Stock the production floor from the raw-material store.
  const tr = await call("POST", "/t/transfers", { fromLocationId: rawId, toLocationId: floorId, items: [
    { ingredientId: flourId, quantity: 1500 }, { ingredientId: sugarId, quantity: 400 }, { ingredientId: cartonId, quantity: 400 }, { ingredientId: filmId, quantity: 4000 }] },
    { "idempotency-key": randomUUID() });
  await call("POST", `/t/transfers/${tr.id}/complete`);
  const dough = (await call("POST", "/t/boms", { itemId: doughId, quantity: 100, notes: "عجينة أساسية لكل منتجات البسكويت",
    lines: [{ componentId: flourId, quantity: 70, scrapPercent: 2 }, { componentId: sugarId, quantity: 18 }, { componentId: oilId, quantity: 12 }],
    operations: [{ name: "خلط وعجن", workCenterId: mixer, setupMinutes: 15, runMinutes: 40 }] })).id as string;
  await call("POST", `/t/boms/${dough}/activate`);
  const biscuits = (await call("POST", "/t/boms", { itemId: biscuitId, quantity: 1000,
    lines: [{ componentId: doughId, quantity: 210, scrapPercent: 3, phantom: true }, { componentId: filmId, quantity: 1000 }, { componentId: cartonId, quantity: 42 }],
    operations: [{ name: "خبز", workCenterId: oven, setupMinutes: 30, runMinutes: 150 }, { name: "تغليف وتعبئة", workCenterId: pack, setupMinutes: 10, runMinutes: 120 }] })).id as string;
  await call("POST", `/t/boms/${biscuits}/activate`);
  const mo = (await call("POST", "/t/manufacturing-orders", { itemId: biscuitId, quantity: 2000, locationId: floorId, outputLocationId: fgId, dueDate: addDays(7) },
    { "idempotency-key": randomUUID() })).id as string;
  await call("POST", `/t/manufacturing-orders/${mo}/confirm`);
  await call("POST", `/t/manufacturing-orders/${mo}/issue`, { remaining: true }, { "idempotency-key": randomUUID() });
  await call("POST", `/t/manufacturing-orders/${mo}/labor`, { seq: 1, minutes: 330 }, { "idempotency-key": randomUUID() });
  await call("POST", `/t/manufacturing-orders/${mo}/produce`, { quantity: 1200, scrapQuantity: 15, scrapReason: "كسر أثناء التبريد" }, { "idempotency-key": randomUUID() });
  await call("POST", "/t/manufacturing-orders", { itemId: biscuitId, quantity: 3000, locationId: floorId, outputLocationId: fgId, dueDate: addDays(14) }, { "idempotency-key": randomUUID() });
}
function addDays(n: number) { return new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10); }


/** The seller's tax profile, two customers and orders at different stages. Once only. */
async function sales() {
  if ((await call<{ items: unknown[] }>("GET", "/t/sales-orders?status=")).items.length) return;
  const find = async (q: string) => (await call<{ items: { id: string }[] }>("GET", `/t/ingredients?q=${encodeURIComponent(q)}&pageSize=1`)).items[0]!.id;
  const biscuitId = await find("بسكويت بالزبدة");
  await call("PATCH", `/t/ingredients/${biscuitId}`, { salePrice: 2.75 });
  await call("PUT", "/t/accounting/tax-profile", { legalName: "مصنع الريادة للأغذية", crNumber: "1010123456", street: "طريق الخرج", buildingNo: "7421",
    additionalNo: "3120", district: "المصانع الثانية", city: "الرياض", postalCode: "14331" });
  const fgId = (await call<{ items: { id: string; code: string }[] }>("GET", "/t/locations?pageSize=50")).items.find((l) => l.code === "WH-FG")!.id;
  const dist = (await call("POST", "/t/customers", { name: "شركة التوزيع الوطنية", phone: "0551234001", customerType: "business", vatNumber: "311234567800003",
    street: "طريق الملك عبدالعزيز", buildingNo: "2345", district: "الملقا", city: "الرياض", postalCode: "13521", paymentTermsDays: 30, creditLimit: 50000 })).id as string;
  const market = (await call("POST", "/t/customers", { name: "أسواق الحي", phone: "0551234002", customerType: "business", vatNumber: "312345678900003",
    street: "شارع التحلية", buildingNo: "8765", district: "الروضة", city: "جدة", postalCode: "23435", paymentTermsDays: 15, creditLimit: 10000 })).id as string;
  const so = (await call("POST", "/t/sales-orders", { customerId: dist, locationId: fgId, customerRef: "PO-8812", deliveryDate: addDays(3),
    lines: [{ itemId: biscuitId, quantity: 960, discount: 50 }] }, { "idempotency-key": randomUUID() })).id as string;
  await call("POST", `/t/sales-orders/${so}/confirm`, {});
  await call("POST", `/t/sales-orders/${so}/deliver`, { driver: "سالم العتيبي" }, { "idempotency-key": randomUUID() });
  await call("POST", `/t/sales-orders/${so}/invoice`, {}, { "idempotency-key": randomUUID() });
  await call("POST", "/t/sales-orders", { customerId: market, locationId: fgId, validUntil: addDays(10), notes: "الأسعار تشمل التوصيل داخل جدة",
    lines: [{ itemId: biscuitId, quantity: 480, unitPrice: 2.6 }] }, { "idempotency-key": randomUUID() });
}

/** Lead times, a large order the stock cannot cover, and one MRP run, so planning has something to show. Once only. */
async function planning() {
  if ((await call<{ run: unknown }>("GET", "/t/mrp/runs/latest")).run) return;
  const find = async (q: string) => (await call<{ items: { id: string }[] }>("GET", `/t/ingredients?q=${encodeURIComponent(q)}&pageSize=1`)).items[0]!.id;
  const lead: [string, number][] = [["دقيق قمح فاخر", 7], ["سكر ناعم", 5], ["زيت نخيل", 10], ["كرتون شحن", 4], ["فيلم تغليف", 6], ["عجينة بسكويت", 0], ["بسكويت بالزبدة", 2]];
  for (const [name, days] of lead) await call("PATCH", `/t/ingredients/${await find(name)}`, { leadTimeDays: days });
  const biscuitId = await find("بسكويت بالزبدة");
  const fgId = (await call<{ items: { id: string; code: string }[] }>("GET", "/t/locations?pageSize=50")).items.find((l) => l.code === "WH-FG")!.id;
  const dist = (await call<{ items: { id: string; name: string }[] }>("GET", "/t/customers?q=" + encodeURIComponent("التوزيع"))).items[0]!.id;
  const so = (await call("POST", "/t/sales-orders", { customerId: dist, locationId: fgId, customerRef: "PO-9001", deliveryDate: addDays(21),
    lines: [{ itemId: biscuitId, quantity: 12000 }] }, { "idempotency-key": randomUUID() })).id as string;
  await call("POST", `/t/sales-orders/${so}/confirm`, { backorder: true });
  await call("POST", "/t/mrp/runs", { horizonDays: 90, safetyStock: true });
}

function idem() { return { "idempotency-key": randomUUID() }; }
async function ids() {
  const find = async (q: string) => (await call<{ items: { id: string }[] }>("GET", `/t/ingredients?q=${encodeURIComponent(q)}&pageSize=1`)).items[0]!.id;
  const locs = (await call<{ items: { id: string; code: string }[] }>("GET", "/t/locations?pageSize=50")).items;
  const sups = (await call<{ items: { id: string; code: string }[] }>("GET", "/t/suppliers?pageSize=50")).items;
  return { find, loc: (c: string) => locs.find((l) => l.code === c)!.id, sup: (c: string) => sups.find((x) => x.code === c)!.id };
}

/** Inspection plans, a new flour lot waiting, an oil lot on hold, the biscuit output accepted, one complaint. Once only. */
async function quality() {
  if ((await call<{ items: unknown[] }>("GET", "/t/qc/inspections")).items.length) return;
  const { find, loc, sup } = await ids();
  const [flourId, oilId, biscuitId] = await Promise.all(["دقيق قمح فاخر", "زيت نخيل", "بسكويت بالزبدة"].map(find)) as [string, string, string];
  if (!(await call<{ items: unknown[] }>("GET", "/t/qc/plans")).items.length) {
    await call("POST", "/t/qc/plans", { itemId: flourId, stage: "receipt", name: "فحص استلام الدقيق", characteristics: [
      { name: "الرطوبة", kind: "numeric", max: 14, unit: "%" }, { name: "البروتين", kind: "numeric", min: 10, max: 13, unit: "%" }, { name: "خلوه من الحشرات", kind: "check" }] });
    await call("POST", "/t/qc/plans", { itemId: oilId, stage: "receipt", name: "فحص استلام الزيت", characteristics: [
      { name: "الحموضة الحرة", kind: "numeric", max: 0.1, unit: "%" }, { name: "سلامة البراميل", kind: "check" }] });
    await call("POST", "/t/qc/plans", { itemId: biscuitId, stage: "production", name: "فحص خروج البسكويت", characteristics: [
      { name: "وزن العبوة", kind: "numeric", min: 198, max: 210, unit: "جم" }, { name: "اللون والقرمشة", kind: "check" }, { name: "إحكام الغلق", kind: "check" }] });
  }
  const receipt = async (supplierId: string, locationId: string, ingredientId: string, quantity: number, unitPrice: number, batchNo: string, extra: object = {}) => {
    const po = await call("POST", "/t/purchases", { supplierId, locationId, items: [{ ingredientId, quantity, unitPrice }] }, idem());
    await call("POST", `/t/purchases/${po.id}/approve`);
    await call("POST", `/t/purchases/${po.id}/receipts`, { items: [{ ingredientId, quantity, batchNo, ...extra }] }, idem());
  };
  await receipt(sup("SUP-MILL"), loc("WH-RM"), flourId, 2, 1450, "ML-7781");
  await receipt(sup("SUP-MILL"), loc("PROD-1"), oilId, 1, 1100, "PO-OIL-332", { expiryDate: addDays(150) });
  const pending = (await call<{ items: { batchId: string; itemId: string }[] }>("GET", "/t/qc/pending")).items;
  const oilLot = pending.find((x) => x.itemId === oilId);
  if (oilLot) await call("POST", "/t/qc/inspections", { batchId: oilLot.batchId, values: { "الحموضة الحرة": 0.24, "سلامة البراميل": true }, notes: "رائحة تزنخ خفيفة؛ يُعاد التحليل في المختبر" }, idem());
  const fgLot = pending.find((x) => x.itemId === biscuitId);
  if (fgLot) await call("POST", "/t/qc/inspections", { batchId: fgLot.batchId, values: { "وزن العبوة": 203, "اللون والقرمشة": true, "إحكام الغلق": true } }, idem());
  await call("POST", "/t/ncrs", { itemId: biscuitId, quantity: 24, description: "شكوى من أسواق الحي: كسر في 24 عبوة من شحنة الأسبوع الماضي" });
}

/** Two machines with plans, spare parts in stock, one due order and two past breakdowns. Once only. */
async function maintenance() {
  if ((await call<{ items: unknown[] }>("GET", "/t/machines")).items.length) return;
  const { find, loc, sup } = await ids();
  const [lubeId, beltId] = await Promise.all(["زيت تشحيم", "سير ناقل"].map(find)) as [string, string];
  const wcs = (await call<{ items: { id: string; code: string }[] }>("GET", "/t/work-centers")).items;
  const wc = (c: string) => wcs.find((w) => w.code === c)?.id ?? null;
  const po = await call("POST", "/t/purchases", { supplierId: sup("SUP-PACK"), locationId: loc("WH-RM"), items: [{ ingredientId: lubeId, quantity: 40, unitPrice: 28 }, { ingredientId: beltId, quantity: 3, unitPrice: 2400 }] }, idem());
  await call("POST", `/t/purchases/${po.id}/approve`);
  await call("POST", `/t/purchases/${po.id}/receive`);
  const oven = (await call("POST", "/t/machines", { code: "M-OVEN-1", name: "الفرن النفقي", workCenterId: wc("OVEN-1"), serialNo: "TN-2019-0442", meterUnit: "ساعة تشغيل" })).id as string;
  const packer = (await call("POST", "/t/machines", { code: "M-PACK-1", name: "آلة التغليف الأفقية", workCenterId: wc("PACK-1"), serialNo: "FW-880-17" })).id as string;
  await call("POST", "/t/maintenance/plans", { machineId: oven, name: "تشحيم السلاسل والمحامل", triggerKind: "days", intervalValue: 30, plannedMinutes: 90,
    tasks: "إيقاف الفرن وتبريده، تشحيم سلاسل السير والمحامل، فحص الشد", parts: [{ itemId: lubeId, quantity: 2 }], lastDoneOn: addDays(-33) });
  await call("POST", "/t/maintenance/plans", { machineId: oven, name: "فحص السير الناقل والحراقات", triggerKind: "meter", intervalValue: 2000, plannedMinutes: 240 });
  await call("POST", "/t/maintenance/plans", { machineId: packer, name: "تنظيف فكوك اللحام", triggerKind: "days", intervalValue: 7, plannedMinutes: 30, lastDoneOn: addDays(-3) });
  await call("POST", `/t/machines/${oven}/meter`, { reading: 1850 });
  const ago = (days: number, minutes = 0) => new Date(Date.now() - days * 86_400_000 + minutes * 60_000).toISOString();
  const wo1 = (await call("POST", "/t/maintenance/orders", { machineId: oven, kind: "corrective", description: "انقطاع السير الناقل أثناء الخبز", failedAt: ago(20) }, idem())).id as string;
  await call("POST", `/t/maintenance/orders/${wo1}/complete`, { completedAt: ago(20, 180), findings: "تمزق في وصلة السير؛ استُبدل بالكامل", locationId: loc("WH-RM"),
    parts: [{ itemId: beltId, quantity: 1 }] }, idem());
  const wo2 = (await call("POST", "/t/maintenance/orders", { machineId: packer, kind: "corrective", description: "تعثر في سحب الفيلم", failedAt: ago(3) }, idem())).id as string;
  await call("POST", `/t/maintenance/orders/${wo2}/complete`, { completedAt: ago(3, 55), findings: "تنظيف البكرات وضبط الحساس", locationId: loc("WH-RM"), parts: [{ itemId: lubeId, quantity: 1 }] }, idem());
  await call("POST", "/t/maintenance/generate", {});
}

/** An advance on the large distributor order (PO-9001), as a prepayment invoice. Once only. */
async function prepayment() {
  if ((await call<{ items: unknown[] }>("GET", "/t/sales-documents?kind=prepayment")).items.length) return;
  const orders = (await call<{ items: { id: string; status: string; customerRef: string | null }[] }>("GET", "/t/sales-orders?status=confirmed&pageSize=50")).items;
  const big = orders.find((o) => o.customerRef === "PO-9001");
  if (big) await call("POST", `/t/sales-orders/${big.id}/prepayments`, { amount: 5000, paymentMeans: "bank_transfer" }, idem());
}

/** Five employees (Saudis on the old and new GOSI systems, expatriates), last month's attendance and payroll. Once only. */
async function hr() {
  if ((await call<{ items: unknown[] }>("GET", "/t/employees?status=all")).items.length) return;
  const wcs = (await call<{ items: { id: string; code: string }[] }>("GET", "/t/work-centers")).items;
  const cc = (await call<{ items: { id: string; code: string }[] }>("GET", "/t/cost-centers")).items;
  const line = cc.find((c) => c.code === "LINE-1")?.id ?? null;
  const admin = cc.find((c) => c.code === "ADMIN")?.id ?? null;
  const soon = addDays(40);
  const people = [
    { code: "E-101", name: "فهد العتيبي", nationality: "SA", idType: "national_id", idNumber: "1023456789", jobTitle: "مدير المصنع", hireDate: "2018-03-01", gosiFirstRegistered: "2018-03-01",
      costCenterId: admin, iban: "SA0380000000608010167519", pay: { basic: 14000, housing: 3500, transport: 1000, other: 500, gosiRegisteredWage: 17500 } },
    { code: "E-102", name: "نورة القحطاني", gender: "female", nationality: "SA", idType: "national_id", idNumber: "1034567890", jobTitle: "محاسبة", hireDate: "2024-09-15", gosiFirstRegistered: "2024-09-15",
      costCenterId: admin, pay: { basic: 8000, housing: 2000, transport: 700 } },
    { code: "E-103", name: "محمد عبد الرحمن", nationality: "EG", idType: "iqama", idNumber: "2145678901", idExpiry: soon, jobTitle: "مشرف خط الإنتاج", hireDate: "2021-06-01",
      costCenterId: line, workCenterId: wcs.find((w) => w.code === "OVEN-1")?.id ?? null, iban: "SA0380000000608010167519", pay: { basic: 5000, housing: 1250, transport: 400 } },
    { code: "E-104", name: "راجيش كومار", nationality: "IN", idType: "iqama", idNumber: "2156789012", jobTitle: "عامل تغليف", hireDate: "2023-02-01", contractType: "fixed", contractEnd: addDays(55),
      costCenterId: line, workCenterId: wcs.find((w) => w.code === "PACK-1")?.id ?? null, pay: { basic: 2200, housing: 0, housingInKind: true, transport: 200 } },
    { code: "E-105", name: "سلطان الشمري", nationality: "SA", idType: "national_id", idNumber: "1045678901", jobTitle: "فني صيانة", hireDate: "2025-11-01", gosiFirstRegistered: "2025-11-01",
      costCenterId: line, pay: { basic: 6000, housing: 1500, transport: 500 } },
  ];
  const ids: string[] = [];
  for (const p of people) ids.push((await call("POST", "/t/employees", { gender: "male", contractType: "unlimited", ...p })).id as string);
  const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1);
  const period = d.toISOString().slice(0, 7);
  for (const dayNo of [5, 6, 7, 12, 13]) {
    const date = `${period}-${String(dayNo).padStart(2, "0")}`;
    await call("PUT", "/t/attendance", { date, rows: ids.map((id, i) => i === 3 && dayNo === 13 ? { employeeId: id, status: "absent" }
      : { employeeId: id, status: "present", hours: 8, overtimeHours: i === 2 ? 2 : 0, overtimeAsLeave: false }) });
  }
  const types = (await call<{ items: { id: string; code: string }[] }>("GET", "/t/leave-types")).items;
  const leave = await call("POST", "/t/leaves", { employeeId: ids[1], leaveTypeId: types.find((t) => t.code === "annual")!.id, startDate: `${period}-20`, endDate: `${period}-22` });
  await call("POST", `/t/leaves/${leave.id}/approve`);
  await call("POST", "/t/payroll/adjustments", { employeeId: ids[2], period, kind: "bonus", amount: 750, note: "مكافأة تحقيق خطة الإنتاج" });
  const run = await call("POST", "/t/payroll/runs", { period });
  await call("POST", `/t/payroll/runs/${run.id}/approve`);
}
