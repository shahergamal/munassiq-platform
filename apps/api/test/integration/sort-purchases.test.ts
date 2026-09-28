import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { type Actor, type App, call, code, createIngredient, createTenant, createUser, expectStatus, startApp, stopApp } from "./helpers.ts";

describe("sorting the purchase orders list", () => {
  let app: App;
  let owner: Actor;
  let tenant: string;
  // Created oldest first, so the default (newest first) order is [p4, p3, p2, p1].
  let p1: string, p2: string, p3: string, p4: string;

  before(async () => {
    app = await startApp();
    owner = await createUser();
    tenant = await createTenant(app, owner);
    const loc = await call(app, owner, "POST", "/t/locations", { tenant, body: { code: code("K"), name: "المطبخ الرئيسي", locationType: "kitchen" } });
    expectStatus(loc, 201, "location");
    const supplier = async (name: string) => {
      const r = await call(app, owner, "POST", "/t/suppliers", { tenant, body: { code: code("S"), name } });
      expectStatus(r, 201, "supplier");
      return r.body.id as string;
    };
    const a = await supplier("مورد أ");
    const b = await supplier("مورد ب");
    const ingredientId = await createIngredient(app, owner, tenant, "طماطم", "g", "kg");
    const po = async (supplierId: string, unitPrice: number) => {
      const r = await call(app, owner, "POST", "/t/purchases", { tenant, idem: true, body: { supplierId, locationId: loc.body.id, items: [{ ingredientId, quantity: 1, unitPrice }] } });
      expectStatus(r, 201, "create PO");
      return r.body.id as string;
    };
    p1 = await po(b, 100);
    p2 = await po(a, 300);
    p3 = await po(b, 200);
    p4 = await po(a, 50);
    for (const id of [p1, p3]) expectStatus(await call(app, owner, "POST", `/t/purchases/${id}/approve`, { tenant }), 200, "approve");
  });
  after(() => stopApp(app));

  const list = async (qs: string) => {
    const r = await call(app, owner, "GET", `/t/purchases${qs}`, { tenant });
    expectStatus(r, 200, qs);
    return (r.body.items as { id: string }[]).map((i) => i.id);
  };

  it("keeps newest first without a sort", async () => {
    assert.deepEqual(await list(""), [p4, p3, p2, p1]);
  });

  it("sorts by one column across pages", async () => {
    assert.deepEqual([...await list("?sort=grandTotal:desc&pageSize=2&page=1"), ...await list("?sort=grandTotal:desc&pageSize=2&page=2")], [p2, p3, p1, p4]);
    assert.deepEqual(await list("?sort=number:asc"), [p1, p2, p3, p4]);
  });

  it("applies two levels in order", async () => {
    assert.deepEqual(await list("?sort=supplierName:asc,grandTotal:desc"), [p2, p4, p3, p1]);
    assert.deepEqual(await list("?sort=status:asc,number:asc"), [p1, p3, p2, p4]); // approved before draft
  });

  it("accepts every offered column in both directions", async () => {
    for (const key of ["number", "supplierName", "locationName", "supplierInvoice", "createdAt", "grandTotal", "status"]) {
      for (const dir of ["asc", "desc"]) assert.equal((await list(`?sort=${key}:${dir}`)).length, 4, `${key}:${dir}`);
    }
    assert.deepEqual(await list("?sort=createdAt:asc"), [p1, p2, p3, p4]);
  });

  it("combines with the status filter", async () => {
    assert.deepEqual(await list("?status=draft&sort=grandTotal:desc"), [p2, p4]);
  });

  it("ignores columns that are not offered instead of failing", async () => {
    for (const sort of ["tenant_id:asc", "supplier_id:desc", "total:asc", `number";DROP TABLE users;--:asc`]) {
      assert.deepEqual(await list(`?sort=${encodeURIComponent(sort)}`), [p4, p3, p2, p1], sort);
    }
  });
});
