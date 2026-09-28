// Fills a workspace with realistic demo data THROUGH THE API (so every business rule, RLS policy and audit applies).
//   npm run demo:seed -- --email you@x.com --password "..." [--api http://localhost:4000]
// Uses the first workspace of that account. Skips if the workspace already has locations.
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const arg = (n: string, d?: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const base = `${arg("api", "http://localhost:4000")}/api/v1`;
const email = arg("email");
const password = arg("password");
if (!email || !password) {
  console.error('Usage: npm run demo:seed -- --email you@x.com --password "..."');
  process.exit(1);
}

let cookie = "";
let csrf = "";
let tenant = "";

async function call<T = any>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), cookie, "x-csrf-token": csrf, ...(tenant ? { "x-tenant-id": tenant } : {}), ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

const login = await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
if (!login.ok) throw new Error(`login failed: ${login.status} ${await login.text()}`);
cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
const me = (await login.json()) as { csrfToken: string; tenants: { id: string; companyName: string }[] };
csrf = me.csrfToken;
if (!me.tenants[0]) throw new Error("this account has no workspace; create one first");
tenant = me.tenants[0].id;
console.log(`workspace: ${me.tenants[0].companyName}`);

const existing = await call<{ meta: { total: number } }>("GET", "/t/locations?pageSize=1");
if (existing.meta.total > 0) {
  console.log("base data already present");
  await extras();
  await extras3();
  process.exit(0);
}

const units = new Map((await call<{ items: { id: string; code: string }[] }>("GET", "/t/units")).items.map((u) => [u.code, u.id]));
const u = (c: string) => units.get(c) as string;

const kitchen = (await call("POST", "/t/locations", { code: "KIT-01", name: "المطبخ الرئيسي", locationType: "kitchen" })).id as string;
const warehouse = (await call("POST", "/t/locations", { code: "WH-01", name: "المستودع المركزي", locationType: "warehouse" })).id as string;
const veg = (await call("POST", "/t/suppliers", { code: "SUP-VEG", name: "مؤسسة الخضار الطازجة", phone: "0501112233", paymentTermsDays: 0 })).id as string;
const meat = (await call("POST", "/t/suppliers", { code: "SUP-MEAT", name: "شركة اللحوم الوطنية", phone: "0504445566", paymentTermsDays: 30 })).id as string;

const ing = async (name: string, category: string, base: string, purchase: string, extra: object = {}) =>
  (await call("POST", "/t/ingredients", { name, category, baseUnitId: u(base), purchaseUnitId: u(purchase), ...extra })).id as string;
const chicken = await ing("صدور دجاج", "لحوم ودواجن", "g", "kg", { yieldPercentage: 92, minStock: 5000 });
const beef = await ing("لحم بقري مفروم", "لحوم ودواجن", "g", "kg", { minStock: 3000 });
const tomato = await ing("طماطم", "خضار", "g", "kg", { yieldPercentage: 90, minStock: 2000 });
const onion = await ing("بصل", "خضار", "g", "kg", { yieldPercentage: 88, minStock: 2000 });
const garlic = await ing("ثوم", "خضار", "g", "kg", { yieldPercentage: 85, minStock: 500 });
const bread = await ing("خبز صاج", "مخبوزات", "pcs", "pack", { purchaseToBase: 20, minStock: 100 });
const tahini = await ing("طحينة", "صلصات", "g", "kg", { minStock: 1000 });
const oil = await ing("زيت طبخ", "زيوت", "ml", "l", { minStock: 2000 });

const receive = async (supplierId: string, locationId: string, items: { ingredientId: string; quantity: number; unitPrice: number }[], extra: object = {}) => {
  const po = await call("POST", "/t/purchases", { supplierId, locationId, items, ...extra }, { "idempotency-key": randomUUID() });
  await call("POST", `/t/purchases/${po.id}/approve`);
  await call("POST", `/t/purchases/${po.id}/receive`);
};
await receive(meat, warehouse, [{ ingredientId: chicken, quantity: 40, unitPrice: 24 }, { ingredientId: beef, quantity: 20, unitPrice: 42 }], { shipping: 60, supplierInvoice: "INV-7781" });
await receive(veg, warehouse, [{ ingredientId: tomato, quantity: 25, unitPrice: 4.5 }, { ingredientId: onion, quantity: 20, unitPrice: 3 }, { ingredientId: garlic, quantity: 3, unitPrice: 14 }]);
await receive(veg, kitchen, [{ ingredientId: chicken, quantity: 10, unitPrice: 25 }, { ingredientId: tomato, quantity: 5, unitPrice: 4.8 }, { ingredientId: onion, quantity: 4, unitPrice: 3.2 },
  { ingredientId: bread, quantity: 15, unitPrice: 18 }, { ingredientId: tahini, quantity: 5, unitPrice: 22 }, { ingredientId: oil, quantity: 10, unitPrice: 9 }, { ingredientId: garlic, quantity: 1, unitPrice: 15 }]);

const recipe = async (code: string, name: string, category: string, priceNet: number, items: { ingredientId: string; quantity: number }[], packagingCost = 0) => {
  const r = await call("POST", "/t/recipes", { code, name, category, priceNet, packagingCost, items });
  await call("POST", `/t/recipes/${r.id}/status`, { status: "approved" });
};
await recipe("SHW-CH", "شاورما دجاج صاج", "شاورما", 13.04, [{ ingredientId: chicken, quantity: 150 }, { ingredientId: bread, quantity: 1 }, { ingredientId: garlic, quantity: 15 }, { ingredientId: oil, quantity: 10 }], 0.35);
await recipe("SHW-BF", "شاورما لحم", "شاورما", 15.65, [{ ingredientId: beef, quantity: 140 }, { ingredientId: bread, quantity: 1 }, { ingredientId: tahini, quantity: 25 }, { ingredientId: onion, quantity: 20 }], 0.35);
await recipe("PLT-CH", "صحن شاورما دجاج", "أطباق", 26.09, [{ ingredientId: chicken, quantity: 250 }, { ingredientId: tomato, quantity: 60 }, { ingredientId: garlic, quantity: 30 }, { ingredientId: bread, quantity: 2 }], 1.2);
await recipe("SLD-TM", "سلطة طماطم", "مقبلات", 8.7, [{ ingredientId: tomato, quantity: 120 }, { ingredientId: onion, quantity: 30 }, { ingredientId: oil, quantity: 10 }]);

console.log("demo data ready: 2 locations, 2 suppliers, 8 ingredients, 3 received purchase orders, 4 approved recipes");
await extras();
await extras3();

/** Stage-2 data (prep recipe + production, return, payment, expenses). Added only if missing, so it can run on an older demo workspace. */
async function extras() {
  const prep = await call<{ meta: { total: number } }>("GET", "/t/prep-recipes?pageSize=1");
  if (prep.meta.total > 0) { console.log("stage-2 demo data already present"); return; }
  const units2 = new Map((await call<{ items: { id: string; code: string }[] }>("GET", "/t/units")).items.map((x) => [x.code, x.id]));
  const ings = (await call<{ items: { id: string; name: string }[] }>("GET", "/t/ingredients?pageSize=100")).items;
  const byName = (n: string) => ings.find((i) => i.name === n)?.id as string;
  const locs = (await call<{ items: { id: string; locationType: string }[] }>("GET", "/t/locations?pageSize=100")).items;
  const kitchenId = locs.find((l) => l.locationType === "kitchen")!.id;
  const warehouseId = locs.find((l) => l.locationType === "warehouse")!.id;
  const sups = (await call<{ items: { id: string; code: string }[] }>("GET", "/t/suppliers?pageSize=100")).items;

  const garlicSauce = await call("POST", "/t/prep-recipes", { name: "صلصة ثوم (تومية)", category: "صلصات", unitId: units2.get("g"), batchYield: 1500,
    notes: "يُخفق الثوم مع الزيت تدريجياً حتى يتماسك.", items: [{ ingredientId: byName("ثوم"), quantity: 300 }, { ingredientId: byName("زيت طبخ"), quantity: 1200 }] });
  await call("POST", `/t/prep-recipes/${garlicSauce.id}/produce`, { locationId: kitchenId, batches: 1 }, { "idempotency-key": randomUUID() });

  const veg = sups.find((x) => x.code === "SUP-VEG")!.id;
  const meat = sups.find((x) => x.code === "SUP-MEAT")!.id;
  await call("POST", "/t/purchase-returns", { supplierId: veg, locationId: warehouseId, reason: "طماطم طرية تالفة من شحنة الأمس",
    items: [{ ingredientId: byName("طماطم"), quantity: 2000 }] }, { "idempotency-key": randomUUID() });
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh" }).format(new Date());
  await call("POST", "/t/supplier-payments", { supplierId: meat, paidOn: today, amount: 1000, method: "bank_transfer", reference: "TRX-55821" }, { "idempotency-key": randomUUID() });

  const cats = (await call<{ items: { id: string; name: string }[] }>("GET", "/t/expense-categories")).items;
  const cat = (n: string) => cats.find((c) => c.name === n)!.id;
  await call("POST", "/t/expenses", { categoryId: cat("الإيجار"), expenseDate: today, description: "إيجار المحل لشهر سبتمبر", amountNet: 8000, vatAmount: 1200, reference: "RENT-09" }, { "idempotency-key": randomUUID() });
  await call("POST", "/t/expenses", { categoryId: cat("الكهرباء والماء"), expenseDate: today, description: "فاتورة الكهرباء", amountNet: 1450, vatAmount: 217.5 }, { "idempotency-key": randomUUID() });
  console.log("stage-2 demo data ready: 1 prep recipe + production, 1 purchase return, 1 supplier payment, 2 pending expenses");
}

/** Stage-2 batch-3 data: modifiers on shawarma, a dining hall with tables, delivery platforms, a customer. Added only if missing. */
async function extras3() {
  const groups = await call<{ items: unknown[] }>("GET", "/t/modifier-groups");
  if (groups.items.length > 0) { console.log("batch-3 demo data already present"); return; }
  const ings = (await call<{ items: { id: string; name: string }[] }>("GET", "/t/ingredients?pageSize=100")).items;
  const byName = (n: string) => ings.find((i) => i.name === n)?.id as string;
  const size = await call("POST", "/t/modifier-groups", { name: "حجم الساندويتش", minSelect: 1, maxSelect: 1, options: [{ name: "عادي", priceNet: 0 }, { name: "كبير", priceNet: 3.48 }] });
  const extra = await call("POST", "/t/modifier-groups", { name: "إضافات", minSelect: 0, maxSelect: 3, options: [
    { name: "ثوم إضافي", priceNet: 0.87, ingredientId: byName("صلصة ثوم (تومية)") ?? null, ingredientQty: byName("صلصة ثوم (تومية)") ? 30 : null },
    { name: "طحينة إضافية", priceNet: 0.87, ingredientId: byName("طحينة"), ingredientQty: 25 },
    { name: "بدون بصل", priceNet: 0 }, { name: "بدون مخلل", priceNet: 0 }] });
  const recipes = (await call<{ items: { id: string; code: string }[] }>("GET", "/t/recipes?pageSize=100")).items;
  for (const code of ["SHW-CH", "SHW-BF"]) {
    const r = recipes.find((x) => x.code === code);
    if (r) await call("PUT", `/t/recipes/${r.id}/modifier-groups`, { groupIds: [size.id, extra.id] });
  }
  const locs = (await call<{ items: { id: string; locationType: string }[] }>("GET", "/t/locations?pageSize=100")).items;
  const kitchenId = locs.find((l) => l.locationType === "kitchen")!.id;
  const hall = await call("POST", "/t/dining-areas", { locationId: kitchenId, name: "الصالة الرئيسية" });
  for (const [n, seats] of [["1", 4], ["2", 4], ["3", 2], ["4", 6], ["5", 4], ["6", 8]] as const) await call("POST", "/t/dining-tables", { areaId: hall.id, name: n, seats });
  const family = await call("POST", "/t/dining-areas", { locationId: kitchenId, name: "قسم العائلات", sortOrder: 1 });
  for (const n of ["ع1", "ع2", "ع3"]) await call("POST", "/t/dining-tables", { areaId: family.id, name: n, seats: 6 });
  await call("POST", "/t/delivery-platforms", { name: "هنقرستيشن", commissionPercent: 22 });
  await call("POST", "/t/delivery-platforms", { name: "جاهز", commissionPercent: 20 });
  await call("POST", "/t/customers", { name: "عبدالله القحطاني", phone: "0551234567", notes: "يفضّل الشاورما بدون مخلل" });
  console.log("batch-3 demo data ready: 2 modifier groups on shawarma, 2 dining areas with 9 tables, 2 delivery platforms, 1 customer");
}
