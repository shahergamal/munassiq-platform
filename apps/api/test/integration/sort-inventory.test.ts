import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { type Actor, type App, call, code, createIngredient, createTenant, createUser, expectStatus, raiseLimits, receivePo, setupKitchen, startApp, stopApp } from "./helpers.ts";

// Base unit g, bought in kg. Each step is its own request, so every list's default (newest first) order is known.
//   Receipts:   T 10 kg @10 → warehouse · R 5 kg @5 → warehouse · T 1 kg @20 → kitchen · O 2 kg @30 → warehouse
//   Stocktakes: ST1 warehouse R counted 4000 (−5) · ST2 kitchen T counted 1500 (+10) · ST3 warehouse still counting
//   Transfers:  TR1 warehouse→kitchen T 1000 done (10) · TR2 warehouse→kitchen R + O draft (0) · TR3 kitchen→warehouse T 100 done (1.6)
//   Waste:      WS1 warehouse expired T 500 (≈5.03) · WS2 kitchen damaged T 200 (3.2) · WS3 warehouse spoiled O 100 (3)
describe("sorting the inventory lists", () => {
  let app: App;
  let owner: Actor;
  let tenant: string;
  let kitchen: string, warehouse: string;
  let T: string, R: string, O: string;
  const tr: string[] = [], ws: string[] = [], st: string[] = [];

  before(async () => {
    app = await startApp();
    owner = await createUser();
    tenant = await createTenant(app, owner);
    await raiseLimits(tenant);
    const k = await setupKitchen(app, owner, tenant); // "المطبخ الرئيسي" + "طماطم"
    kitchen = k.locationId;
    T = k.ingredientId;
    const wh = await call(app, owner, "POST", "/t/locations", { tenant, body: { code: code("WH"), name: "المستودع", locationType: "warehouse" } });
    expectStatus(wh, 201, "warehouse");
    warehouse = wh.body.id;
    R = await createIngredient(app, owner, tenant, "أرز", "g", "kg");
    O = await createIngredient(app, owner, tenant, "بصل", "g", "kg");

    const receive = (locationId: string, ingredientId: string, quantity: number, unitPrice: number) =>
      receivePo(app, owner, tenant, { supplierId: k.supplierId, locationId, items: [{ ingredientId, quantity, unitPrice }] });
    await receive(warehouse, T, 10, 10);
    await receive(warehouse, R, 5, 5);
    await receive(kitchen, T, 1, 20);
    await receive(warehouse, O, 2, 30);

    const stocktake = async (locationId: string, ingredientId: string, countedQty: number, post: boolean) => {
      const s = await call(app, owner, "POST", "/t/stocktakes", { tenant, body: { locationId } });
      expectStatus(s, 201, "stocktake");
      expectStatus(await call(app, owner, "PUT", `/t/stocktakes/${s.body.id}/counts`, { tenant, body: { items: [{ ingredientId, countedQty }] } }), 200, "counts");
      if (post) expectStatus(await call(app, owner, "POST", `/t/stocktakes/${s.body.id}/post`, { tenant }), 200, "post stocktake");
      st.push(s.body.id);
    };
    await stocktake(warehouse, R, 4000, true);
    await stocktake(kitchen, T, 1500, true);
    await stocktake(warehouse, R, 3000, false);

    const transfer = async (fromLocationId: string, toLocationId: string, items: { ingredientId: string; quantity: number }[], completeNow: boolean) => {
      const r = await call(app, owner, "POST", "/t/transfers", { tenant, idem: true, body: { fromLocationId, toLocationId, items, completeNow } });
      expectStatus(r, 201, "transfer");
      tr.push(r.body.id);
    };
    await transfer(warehouse, kitchen, [{ ingredientId: T, quantity: 1000 }], true);
    await transfer(warehouse, kitchen, [{ ingredientId: R, quantity: 1000 }, { ingredientId: O, quantity: 500 }], false);
    await transfer(kitchen, warehouse, [{ ingredientId: T, quantity: 100 }], true);

    const waste = async (locationId: string, reason: string, ingredientId: string, quantity: number) => {
      const r = await call(app, owner, "POST", "/t/waste", { tenant, idem: true, body: { locationId, reason, items: [{ ingredientId, quantity }] } });
      expectStatus(r, 201, "waste");
      ws.push(r.body.id);
    };
    await waste(warehouse, "expired", T, 500);
    await waste(kitchen, "damaged", T, 200);
    await waste(warehouse, "spoiled", O, 100);
  });
  after(() => stopApp(app));

  const ids = async (url: string) => {
    const r = await call(app, owner, "GET", url, { tenant });
    expectStatus(r, 200, url);
    return (r.body.items as { id: string }[]).map((i) => i.id);
  };
  const place = (i: { name?: string; ingredientName?: string; locationName: string }) => `${i.name ?? i.ingredientName}@${i.locationName === "المستودع" ? "W" : "K"}`;
  const places = async (url: string) => {
    const r = await call(app, owner, "GET", url, { tenant });
    expectStatus(r, 200, url);
    return (r.body.items as { name?: string; ingredientName?: string; locationName: string }[]).map(place);
  };

  it("stock on hand: one column across pages, two levels, and the default order kept otherwise", async () => {
    assert.deepEqual(await places("/t/stock"), ["أرز@W", "بصل@W", "طماطم@W", "طماطم@K"]);
    assert.deepEqual([...await places("/t/stock?sort=quantity:desc&pageSize=2&page=1"), ...await places("/t/stock?sort=quantity:desc&pageSize=2&page=2")],
      ["طماطم@W", "أرز@W", "طماطم@K", "بصل@W"]);
    assert.deepEqual(await places("/t/stock?sort=value:desc"), ["طماطم@W", "بصل@W", "طماطم@K", "أرز@W"]);
    assert.deepEqual(await places("/t/stock?sort=locationName:desc,quantity:asc"), ["طماطم@K", "بصل@W", "أرز@W", "طماطم@W"]);
    assert.deepEqual(await places(`/t/stock?locationId=${warehouse}&sort=avgCost:desc`), ["بصل@W", "طماطم@W", "أرز@W"]);
  });

  it("movement ledger", async () => {
    const base = "/t/stock/movements?type=purchase";
    assert.deepEqual(await places(base), ["بصل@W", "طماطم@K", "أرز@W", "طماطم@W"]);
    assert.deepEqual(await places(`${base}&sort=createdAt:asc`), ["طماطم@W", "أرز@W", "طماطم@K", "بصل@W"]);
    assert.deepEqual(await places(`${base}&sort=quantity:asc`), ["طماطم@K", "بصل@W", "أرز@W", "طماطم@W"]);
    assert.deepEqual(await places(`${base}&sort=value:desc`), ["طماطم@W", "بصل@W", "أرز@W", "طماطم@K"]);
    // Second level against the default tie-breaker: newest first would put the kitchen tomato before the warehouse one.
    assert.deepEqual(await places(`${base}&sort=ingredientName:asc,locationName:asc`), ["أرز@W", "بصل@W", "طماطم@W", "طماطم@K"]);
    // Movement type (an unquoted alias): every type grouped in text order, not the default newest-first mix.
    const r = await call(app, owner, "GET", "/t/stock/movements?sort=type:asc,createdAt:asc&pageSize=100", { tenant });
    expectStatus(r, 200, "movements by type");
    const rows = r.body.items as { type: string; createdAt: string }[];
    const types = rows.map((i) => i.type);
    assert.deepEqual(types, [...types].sort());
    assert.ok(new Set(types).size >= 4);
    // Within each type the second level (oldest first) applies, not the default newest first.
    for (const t of new Set(types)) {
      const times = rows.filter((i) => i.type === t).map((i) => Date.parse(i.createdAt));
      assert.deepEqual(times, [...times].sort((a, b) => a - b), `createdAt ascending within ${t}`);
    }
    assert.ok(rows.filter((i) => i.type === "purchase").length >= 4);
  });

  it("transfers", async () => {
    const [tr1, tr2, tr3] = tr;
    assert.deepEqual(await ids("/t/transfers"), [tr3, tr2, tr1]);
    assert.deepEqual(await ids("/t/transfers?sort=number:asc"), [tr1, tr2, tr3]);
    assert.deepEqual(await ids("/t/transfers?sort=value:desc"), [tr1, tr3, tr2]);
    assert.deepEqual(await ids("/t/transfers?sort=value:asc"), [tr3, tr1, tr2]); // the draft has no value ("—") and stays last
    assert.deepEqual(await ids("/t/transfers?sort=itemsCount:desc,number:asc"), [tr2, tr1, tr3]);
    assert.deepEqual(await ids("/t/transfers?sort=status:asc,value:desc"), [tr1, tr3, tr2]); // completed before draft, highest value first (default would be tr3 first)
    assert.deepEqual(await ids("/t/transfers?sort=fromName:asc"), [tr2, tr1, tr3]); // المستودع before المطبخ, newest first within
    assert.deepEqual(await ids("/t/transfers?status=completed&sort=toName:desc"), [tr1, tr3]);
  });

  it("waste records", async () => {
    const [ws1, ws2, ws3] = ws;
    assert.deepEqual(await ids("/t/waste"), [ws3, ws2, ws1]);
    assert.deepEqual(await ids("/t/waste?sort=totalCost:desc"), [ws1, ws2, ws3]);
    assert.deepEqual(await ids("/t/waste?sort=reason:asc"), [ws2, ws1, ws3]);
    assert.deepEqual(await ids("/t/waste?sort=locationName:asc,totalCost:desc"), [ws1, ws3, ws2]); // default would be ws3 before ws1
    assert.deepEqual(await ids("/t/waste?sort=createdAt:asc&pageSize=2&page=2"), [ws3]);
  });

  it("stocktakes, with a count not yet posted (no variance) always last", async () => {
    const [st1, st2, st3] = st;
    assert.deepEqual(await ids("/t/stocktakes"), [st3, st2, st1]);
    assert.deepEqual(await ids("/t/stocktakes?sort=varianceValue:desc"), [st2, st1, st3]);
    assert.deepEqual(await ids("/t/stocktakes?sort=varianceValue:asc"), [st1, st2, st3]);
    assert.deepEqual(await ids("/t/stocktakes?sort=locationName:asc,number:asc"), [st1, st3, st2]);
    assert.deepEqual(await ids("/t/stocktakes?sort=status:desc,number:asc"), [st1, st2, st3]); // posted before counting
  });

  it("ignores columns that are not offered, and injection attempts, instead of failing", async () => {
    const lists: [string, string[]][] = [
      ["/t/transfers", [tr[2]!, tr[1]!, tr[0]!]],
      ["/t/waste", [ws[2]!, ws[1]!, ws[0]!]],
      ["/t/stocktakes", [st[2]!, st[1]!, st[0]!]],
    ];
    const bad = ["tenant_id:asc", "location_id:desc", "notes:asc", "ingredient_id:asc", `number";DROP TABLE users;--:asc`];
    for (const [url, expected] of lists) {
      for (const sort of bad) {
        const r = await call(app, owner, "GET", `${url}?sort=${encodeURIComponent(sort)}`, { tenant });
        expectStatus(r, 200, `${url} ${sort}`);
        assert.deepEqual((r.body.items as { id: string }[]).map((i) => i.id), expected, `${url} ${sort}`);
      }
    }
    for (const sort of bad) {
      assert.deepEqual(await places(`/t/stock/movements?type=purchase&sort=${encodeURIComponent(sort)}`), ["بصل@W", "طماطم@K", "أرز@W", "طماطم@W"], `movements ${sort}`);
      assert.deepEqual(await places(`/t/stock?sort=${encodeURIComponent(sort)}`), ["أرز@W", "بصل@W", "طماطم@W", "طماطم@K"], `stock ${sort}`);
    }
    // An unknown direction falls back to ascending instead of failing.
    for (const url of ["/t/transfers", "/t/waste", "/t/stocktakes", "/t/stock/movements", "/t/stock"]) expectStatus(await call(app, owner, "GET", `${url}?sort=value:sideways`, { tenant }), 200, `${url} value:sideways`);
    assert.deepEqual(await places("/t/stock?sort=tenant_id:desc,ingredient_id:asc"), ["أرز@W", "بصل@W", "طماطم@W", "طماطم@K"]);
  });
});
