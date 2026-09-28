import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { after, before, describe, it } from "node:test";
import { type Actor, type App, addMember, call, createTenant, createUser, ownerPool, startApp, stopApp } from "./helpers.ts";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function multipart(file: Buffer, filename = "ingredients.xlsx") {
  const boundary = `----munassiq${randomUUID()}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${XLSX}\r\n\r\n`),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

async function workbook(rows: (string | number)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("المواد الخام");
  ws.addRow(["الاسم", "الفئة", "وحدة الأساس", "وحدة الشراء", "معامل", "صلاحية", "حد أدنى", "باركود"]);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// Server-side Excel import (exceljs), atomic: one bad row rejects the whole file.
describe("ingredients Excel import", () => {
  let app: App;
  let owner: Actor;
  let tenant: string;

  before(async () => {
    app = await startApp();
    owner = await createUser();
    tenant = await createTenant(app, owner);
  });
  after(() => stopApp(app));

  const upload = (actor: Actor, file: Buffer) => {
    const m = multipart(file);
    return call(app, actor, "POST", "/t/ingredients/import", { tenant, body: m.payload, headers: m.headers });
  };
  const count = async () => (await ownerPool.query("SELECT count(*)::int AS n FROM ingredients WHERE tenant_id = $1", [tenant])).rows[0].n as number;

  it("the downloaded template imports as-is", async () => {
    const res = await app.inject({
      method: "GET", url: "/api/v1/t/ingredients/import-template",
      headers: { cookie: `mn_sid=${owner.token}`, "x-tenant-id": tenant }, remoteAddress: owner.ip,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], XLSX);
    const r = await upload(owner, res.rawPayload);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { imported: 1 });
    const row = await ownerPool.query("SELECT sku, name, purchase_to_base::float8 AS f FROM ingredients WHERE tenant_id = $1", [tenant]);
    assert.deepEqual(row.rows, [{ sku: "ING-000001", name: "طماطم", f: 10 }]);
  });

  it("derives the factor for same-dimension units and imports several rows", async () => {
    const before = await count();
    const r = await upload(owner, await workbook([["دقيق", "مخبوزات", "g", "kg", "", 100, 1000, ""], ["حليب", "", "ml", "l", "", 95, 0, "628100"]]));
    assert.deepEqual(r.body, { imported: 2 });
    assert.equal(await count(), before + 2);
    const f = await ownerPool.query("SELECT purchase_to_base::float8 AS f FROM ingredients WHERE tenant_id = $1 AND name = 'دقيق'", [tenant]);
    assert.equal(f.rows[0].f, 1000);
  });

  it("rejects the whole file when any row is invalid, and reports the rows", async () => {
    const before = await count();
    const r = await upload(owner, await workbook([
      ["سكر", "", "g", "kg", "", 100, 0, ""],
      ["ملح", "", "ton", "kg", "", 100, 0, ""],     // unknown unit
      ["زيت", "", "ml", "carton", "", 100, 0, ""], // different dimensions, no factor
      ["بيض", "", "pcs", "carton", "", 100, 0, ""], // two count units: 1 carton = ? pieces, must be given
    ]));
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, "import_invalid");
    assert.deepEqual(r.body.error.details.errors.map((e: { row: number }) => e.row), [3, 4, 5]);
    assert.equal(await count(), before);
  });

  it("rejects files that are not xlsx, and roles without catalog:write", async () => {
    const r = await upload(owner, Buffer.from("name,unit\nsugar,kg\n"));
    assert.equal(r.status, 422);
    const cashier = await addMember(app, owner, tenant, "cashier");
    assert.equal((await upload(cashier, await workbook([["سكر", "", "g", "kg", "", 100, 0, ""]]))).status, 403);
  });
});
