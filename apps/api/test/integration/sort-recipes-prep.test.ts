import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { type Actor, type App, call, code, createIngredient, createTenant, createUser, expectStatus, type Kitchen, receivePo, setupKitchen, startApp, stopApp, unitId } from "./helpers.ts";

describe("sorting: menu recipes, prep recipes and production runs", () => {
  let app: App;
  let owner: Actor;
  let tenant: string;
  let k: Kitchen;
  const prep: Record<string, string> = {};

  before(async () => {
    app = await startApp();
    owner = await createUser();
    tenant = await createTenant(app, owner);
    k = await setupKitchen(app, owner, tenant);
    await receivePo(app, owner, tenant, { supplierId: k.supplierId, locationId: k.locationId, items: [{ ingredientId: k.ingredientId, quantity: 10, unitPrice: 5 }] });

    // No stock for flour, so a recipe's total cost is its packaging cost alone.
    const flour = await createIngredient(app, owner, tenant, "طحين", "g", "kg");
    for (const [name, priceNet, packagingCost] of [["برجر", 30, 2], ["أرز", 10, 4], ["شاورما", 20, 2], ["تبولة", 20, 1], ["خبز", 0, 0]] as const) {
      const r = await call(app, owner, "POST", "/t/recipes", { tenant, body: { code: code("R"), name, priceNet, packagingCost, items: [{ ingredientId: flour, quantity: 10 }] } });
      expectStatus(r, 201, `recipe ${name}`);
    }

    const g = await unitId(app, owner, tenant, "g");
    for (const [name, batchYield, perBatch] of [["صلصة ثوم", 500, 100], ["عجينة", 2000, 200], ["تتبيلة دجاج", 1000, 100], ["مرق", 1500, 100]] as const) {
      const r = await call(app, owner, "POST", "/t/prep-recipes", { tenant, body: { name, unitId: g, batchYield, items: [{ ingredientId: k.ingredientId, quantity: perBatch }] } });
      expectStatus(r, 201, `prep ${name}`);
      prep[name] = r.body.id;
    }
    const off = await call(app, owner, "PUT", `/t/prep-recipes/${prep["مرق"]}`, { tenant, body: { batchYield: 1500, isActive: false, items: [{ ingredientId: k.ingredientId, quantity: 100 }] } });
    expectStatus(off, 200, "deactivate prep");

    for (const [name, batches] of [["صلصة ثوم", 2], ["عجينة", 1], ["صلصة ثوم", 0.5]] as const) {
      const r = await call(app, owner, "POST", `/t/prep-recipes/${prep[name]}/produce`, { tenant, idem: true, body: { locationId: k.locationId, batches } });
      expectStatus(r, 201, `produce ${name}`);
    }
  });
  after(() => stopApp(app));

  const names = (r: { body: { items: { name: string }[] } }) => r.body.items.map((i) => i.name);
  const runs = (r: { body: { items: { name: string; batches: number }[] } }) => r.body.items.map((i) => `${i.name}:${i.batches}`);

  it("menu recipes sort by price, then by the computed total cost", async () => {
    const byPrice = await call(app, owner, "GET", "/t/recipes?sort=priceNet:desc", { tenant });
    expectStatus(byPrice, 200, "recipes by price");
    assert.deepEqual(names(byPrice), ["برجر", "تبولة", "شاورما", "أرز", "خبز"]);

    const twoLevels = await call(app, owner, "GET", "/t/recipes?sort=priceNet:asc,totalCost:desc", { tenant });
    assert.deepEqual(names(twoLevels), ["خبز", "أرز", "شاورما", "تبولة", "برجر"]); // name alone would put تبولة before شاورما
  });

  it("menu recipes sort by food cost % and margin across all pages, with no-price recipes last", async () => {
    const p1 = await call(app, owner, "GET", "/t/recipes?sort=foodCostPercent:asc&pageSize=2&page=1", { tenant });
    const p2 = await call(app, owner, "GET", "/t/recipes?sort=foodCostPercent:asc&pageSize=2&page=2", { tenant });
    const p3 = await call(app, owner, "GET", "/t/recipes?sort=foodCostPercent:asc&pageSize=2&page=3", { tenant });
    assert.deepEqual([...names(p1), ...names(p2), ...names(p3)], ["تبولة", "برجر", "شاورما", "أرز", "خبز"]);
    const desc = await call(app, owner, "GET", "/t/recipes?sort=foodCostPercent:desc", { tenant });
    assert.deepEqual(names(desc), ["أرز", "شاورما", "برجر", "تبولة", "خبز"]);
    const margin = await call(app, owner, "GET", "/t/recipes?sort=margin:asc", { tenant });
    assert.deepEqual(names(margin), ["خبز", "أرز", "شاورما", "تبولة", "برجر"]);
    assert.deepEqual(margin.body.items.map((r: { margin: number }) => r.margin), [0, 6, 18, 19, 28]);
  });

  it("prep recipes sort by batch yield, and by status then yield", async () => {
    const byYield = await call(app, owner, "GET", "/t/prep-recipes?sort=batchYield:desc", { tenant });
    expectStatus(byYield, 200, "prep by yield");
    assert.deepEqual(names(byYield), ["عجينة", "مرق", "تتبيلة دجاج", "صلصة ثوم"]);

    const twoLevels = await call(app, owner, "GET", "/t/prep-recipes?sort=isActive:asc,batchYield:asc", { tenant });
    assert.deepEqual(names(twoLevels), ["مرق", "صلصة ثوم", "تتبيلة دجاج", "عجينة"]);

    const byStock = await call(app, owner, "GET", "/t/prep-recipes?sort=stockQty:desc", { tenant });
    assert.deepEqual(names(byStock).slice(0, 2), ["عجينة", "صلصة ثوم"]); // 2000 g and 1250 g produced
  });

  it("production runs sort by batches, and by item then batches, instead of newest first", async () => {
    const byBatches = await call(app, owner, "GET", "/t/production-runs?sort=batches:desc", { tenant });
    expectStatus(byBatches, 200, "runs by batches");
    assert.deepEqual(runs(byBatches), ["صلصة ثوم:2", "عجينة:1", "صلصة ثوم:0.5"]);

    const twoLevels = await call(app, owner, "GET", "/t/production-runs?sort=name:asc,batches:desc", { tenant });
    assert.deepEqual(runs(twoLevels), ["صلصة ثوم:2", "صلصة ثوم:0.5", "عجينة:1"]); // newest first would put 0.5 before 2

    const oneRecipe = await call(app, owner, "GET", `/t/production-runs?prepRecipeId=${prep["صلصة ثوم"]}&sort=batches:desc`, { tenant });
    assert.deepEqual(runs(oneRecipe), ["صلصة ثوم:2", "صلصة ثوم:0.5"]);
  });

  it("accepts every column the UI offers, in both directions, and returns that order", async () => {
    const offered: Record<string, string[]> = {
      "/t/recipes": ["name", "code", "priceNet", "totalCost", "margin", "foodCostPercent", "status"],
      "/t/prep-recipes": ["name", "batchYield", "estimatedUnitCost", "stockQty", "isActive"],
      "/t/production-runs": ["createdAt", "name", "locationName", "batches", "outputQuantity", "unitCost", "totalCost"],
    };
    for (const [path, keys] of Object.entries(offered)) {
      for (const key of keys) {
        for (const dir of ["asc", "desc"] as const) {
          const r = await call(app, owner, "GET", `${path}?sort=${key}:${dir}`, { tenant });
          expectStatus(r, 200, `${path} ${key}:${dir}`);
          const vals = (r.body.items as Record<string, unknown>[]).map((i) => i[key]);
          assert.ok(vals.length > 1, `${path} ${key} has rows`);
          const firstNull = vals.findIndex((v) => v === null);
          if (firstNull >= 0) assert.ok(vals.slice(firstNull).every((v) => v === null), `${path} ${key}:${dir} empty values last`);
          // Text follows the database collation, so only numbers, flags and times are compared here.
          const ranks = vals.slice(0, firstNull >= 0 ? firstNull : undefined)
            .map((v) => (typeof v === "number" ? v : typeof v === "boolean" ? Number(v) : key === "createdAt" ? Date.parse(v as string) : NaN));
          if (ranks.some(Number.isNaN)) continue;
          for (let i = 1; i < ranks.length; i++) {
            assert.ok(dir === "asc" ? ranks[i - 1]! <= ranks[i]! : ranks[i - 1]! >= ranks[i]!, `${path} ${key}:${dir} out of order at ${i}: ${JSON.stringify(vals)}`);
          }
        }
      }
    }
  });

  it("ignores columns that are not offered and keeps each list's default order", async () => {
    for (const path of ["/t/recipes", "/t/prep-recipes", "/t/production-runs"]) {
      for (const sort of ["tenant_id:asc", "ingredient_id:desc", `name";DROP TABLE users;--:asc`, "packagingCost:asc"]) {
        expectStatus(await call(app, owner, "GET", `${path}?sort=${encodeURIComponent(sort)}`, { tenant }), 200, `${path} ${sort}`);
      }
    }
    assert.deepEqual(names(await call(app, owner, "GET", "/t/recipes?sort=tenant_id:asc", { tenant })), ["أرز", "برجر", "تبولة", "خبز", "شاورما"]);
    assert.deepEqual(names(await call(app, owner, "GET", "/t/prep-recipes?sort=tenant_id:asc", { tenant })), ["تتبيلة دجاج", "صلصة ثوم", "عجينة", "مرق"]);
    assert.deepEqual(runs(await call(app, owner, "GET", "/t/production-runs?sort=tenant_id:asc", { tenant })), ["صلصة ثوم:0.5", "عجينة:1", "صلصة ثوم:2"]);
  });
});
