import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, csrfTokenFor, verifyCsrf, passwordProblem, newToken, sha256Hex } from "../src/lib/security.ts";
import { parsePage, likePattern, pageMeta, sortSql } from "../src/lib/pagination.ts";

test("password hashing round-trip (fast params for the test)", async () => {
  const h = await hashPassword("correct horse battery", { N: 2 ** 12 });
  assert.ok(h.startsWith("scrypt$4096$"));
  assert.ok(await verifyPassword("correct horse battery", h));
  assert.ok(!(await verifyPassword("wrong", h)));
  assert.ok(!(await verifyPassword("x", "garbage")));
});

test("csrf token is bound to the session", () => {
  const s = "a".repeat(32);
  const t = csrfTokenFor("session-1", s);
  assert.ok(verifyCsrf("session-1", t, s));
  assert.ok(!verifyCsrf("session-2", t, s));
  assert.ok(!verifyCsrf("session-1", undefined, s));
  assert.ok(!verifyCsrf("session-1", t + "x", s));
});

test("password policy", () => {
  assert.ok(passwordProblem("short", "a@b.com"));
  assert.ok(passwordProblem("ahmedsaleh2026", "ahmedsaleh@x.com"));
  assert.ok(passwordProblem("aaaaaaaaaaaa", "a@b.com"));
  assert.equal(passwordProblem("مطعم-النخبة-2026!", "a@b.com"), null);
});

test("tokens are unique and hashing is stable", () => {
  assert.notEqual(newToken(), newToken());
  assert.equal(sha256Hex("x"), sha256Hex("x"));
});

test("pagination clamps and LIKE input is escaped", () => {
  assert.deepEqual(parsePage({ page: "0", pageSize: "9999" }), { page: 1, pageSize: 100, offset: 0 });
  assert.equal(parsePage({ page: 3, pageSize: 10 }).offset, 20);
  assert.equal(likePattern("50%_off"), "%50\\%\\_off%");
  assert.equal(pageMeta({ page: 1, pageSize: 25, offset: 0 }, 51).totalPages, 3);
});

test("multi-column sort accepts only the endpoint's own columns, up to three levels", () => {
  const allowed = ["name", "total", "createdAt", "status"];
  assert.equal(sortSql("total:desc,name:asc", allowed), `"total" DESC NULLS LAST, "name" ASC NULLS LAST, `);
  assert.equal(sortSql(`name:asc,password_hash:asc,"x";drop table users:asc,total`, allowed), `"name" ASC NULLS LAST, "total" ASC NULLS LAST, `);
  assert.equal(sortSql("name:desc,name:asc", allowed), `"name" DESC NULLS LAST, `);
  assert.equal(sortSql("name,total,createdAt,status", allowed).split(",").filter((s) => s.trim()).length, 3);
  assert.equal(sortSql(undefined, allowed), "");
  assert.equal(sortSql(["name:asc"], allowed), "");
});
