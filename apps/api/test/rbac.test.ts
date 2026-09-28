import test from "node:test";
import assert from "node:assert/strict";
import { can, CATALOG, IMPLIES, inSector, LEGACY_PERMISSIONS, legacyExpansion, normalizePermissions, PERMISSIONS, permissionsOf, ROLES } from "../src/lib/rbac.ts";

test("the catalog is module → page → action, and every permission is page.action", () => {
  assert.ok(CATALOG.length >= 9);
  assert.equal(new Set(PERMISSIONS).size, PERMISSIONS.length, "no duplicates");
  for (const p of PERMISSIONS) assert.match(p, /^[a-z_]+\.[a-z_]+$/);
  assert.ok(PERMISSIONS.includes("ingredients.delete") && PERMISSIONS.includes("purchases.approve") && PERMISSIONS.includes("rep_vat.view"));
});

test("every action needs its page; roles are closed under that", () => {
  assert.deepEqual(IMPLIES["ingredients.delete"], ["ingredients.view"]);
  assert.deepEqual(normalizePermissions(["goods_receipts.create"]), ["purchases.view", "goods_receipts.view", "goods_receipts.create"]);
  assert.deepEqual(normalizePermissions(["root.all", "x"]), [], "unknown names are dropped");
});

test("first-version names still work and open exactly the same pages", () => {
  for (const p of PERMISSIONS) {
    if (p === "roles.manage") continue; // owner-only before, a grantable permission now
    if (!inSector(p, "restaurants")) continue; // factory pages came after the first version
    if (/^(employees|attendance|leaves|payroll|rep_payroll)\./.test(p)) continue; // so did HR (M7)
    assert.ok(LEGACY_PERMISSIONS.some((l) => legacyExpansion(l).includes(p)), `${p} is reachable from an old permission`);
  }
  assert.ok(normalizePermissions(["purchases:approve"]).includes("purchases.approve"));
  assert.ok(!normalizePermissions(["purchases:approve"]).includes("purchases.create"));
});

test("accountant approves purchases but does not create them, sell, or edit the catalog", () => {
  assert.ok(can("accountant", "purchases.view") && can("accountant", "purchases.approve"));
  assert.ok(!can("accountant", "purchases.create") && !can("accountant", "ingredients.edit") && !can("accountant", "pos.sell"));
});

test("cashier is limited to the till", () => {
  assert.ok(can("cashier", "pos.sell") && can("cashier", "kitchen.use") && can("cashier", "customers.create"));
  for (const p of ["orders.refund", "pos.void", "pos.supervise", "pos.discount", "purchases.view", "ingredients.delete"] as const) assert.ok(!can("cashier", p), p);
});

test("support is strictly read-only", () => {
  for (const p of PERMISSIONS) assert.equal(can("support", p), p.endsWith(".view") && !/^(members|roles|billing|employees|attendance|leaves|payroll|rep_payroll)\./.test(p), p);
});

test("HR: personal data and pay stay with the owner; the manager runs attendance and leaves; the accountant pays", () => {
  assert.ok(can("manager", "attendance.record") && can("manager", "leaves.approve") && !can("manager", "employees.view_pay") && !can("manager", "payroll.view"));
  assert.ok(can("accountant", "payroll.pay") && !can("accountant", "payroll.approve") && !can("accountant", "employees.view_pay"));
  for (const r of ["inventory_clerk", "cashier"] as const) assert.ok(!can(r, "employees.view") && !can(r, "payroll.view"), r);
  assert.ok(can("owner", "employees.view_pay") && can("owner", "payroll.approve"));
});

test("only the owner manages members, roles and the workspace settings", () => {
  for (const r of ROLES) {
    for (const p of ["members.invite", "members.edit", "roles.manage", "settings.edit", "billing.pay"] as const) assert.equal(can(r, p), r === "owner", `${r} ${p}`);
  }
  assert.deepEqual(permissionsOf("owner"), PERMISSIONS);
});

test("stock: the clerk moves and counts, but posting a count is for owner, manager or accountant", () => {
  assert.ok(can("inventory_clerk", "transfers.dispatch") && can("inventory_clerk", "stocktakes.count") && can("inventory_clerk", "waste.create"));
  assert.ok(!can("inventory_clerk", "stocktakes.post"));
  assert.ok(can("accountant", "stocktakes.post") && !can("accountant", "stocktakes.count"));
  assert.ok(can("manager", "stocktakes.count") && can("manager", "stocktakes.post"));
  assert.ok(!can("cashier", "waste.create"));
});

test("money out: accountant and manager handle expenses and supplier payments; clerk and cashier do not", () => {
  for (const p of ["expenses.view", "expenses.create", "expenses.approve", "expenses.pay", "payables.pay"] as const) {
    assert.ok(can("accountant", p) && can("manager", p) && can("owner", p), p);
    assert.ok(!can("inventory_clerk", p) && !can("cashier", p), p);
  }
  assert.ok(can("support", "expenses.view") && !can("support", "expenses.create"));
});

test("kitchen screen: cashier, manager and owner; not accountant or clerk", () => {
  assert.ok(can("cashier", "kitchen.use") && can("manager", "kitchen.use") && can("owner", "kitchen.use"));
  assert.ok(!can("accountant", "kitchen.use") && !can("inventory_clerk", "kitchen.use"));
});

test("the web app knows exactly the permissions the server enforces", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../../web/src/api/permissions.ts", import.meta.url), "utf8");
  const web = [...src.matchAll(/"([a-z_]+\.[a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(web, [...PERMISSIONS], "regenerate apps/web/src/api/permissions.ts from lib/rbac.ts");
});

test("production: the manager runs it, the clerk issues and produces, the accountant closes orders; the cashier has none", () => {
  assert.ok(can("manager", "boms.approve") && can("manager", "mos.close") && can("manager", "work_centers.edit"));
  assert.ok(can("inventory_clerk", "mos.issue") && can("inventory_clerk", "mos.produce") && !can("inventory_clerk", "mos.close") && !can("inventory_clerk", "boms.approve"));
  assert.ok(can("accountant", "mos.close") && can("accountant", "boms.view") && !can("accountant", "mos.issue"));
  assert.ok(!can("cashier", "mos.view"));
});
