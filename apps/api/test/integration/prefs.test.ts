import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { type Actor, type App, call, createUser, expectStatus, ownerPool, startApp, stopApp } from "./helpers.ts";

describe("per-user UI preferences on the server", () => {
  let app: App;
  let a: Actor;
  let b: Actor;
  const layout = { sort: [{ key: "total", dir: "desc" }, { key: "name", dir: "asc" }], hidden: ["note"] };

  before(async () => {
    app = await startApp();
    [a, b] = await Promise.all([createUser(), createUser()]);
  });
  after(() => stopApp(app));

  it("saves a table layout and returns it on any later request (any device)", async () => {
    expectStatus(await call(app, a, "PUT", `/auth/prefs/${encodeURIComponent("table.أوامر الشراء")}`, { body: layout }), 200, "save");
    const r = await call(app, a, "GET", "/auth/prefs");
    assert.deepEqual(r.body.items["table.أوامر الشراء"], layout);
  });

  it("replaces on save and deletes on reset", async () => {
    expectStatus(await call(app, a, "PUT", "/auth/prefs/table.x", { body: layout }), 200);
    expectStatus(await call(app, a, "PUT", "/auth/prefs/table.x", { body: { sort: [], hidden: [] } }), 200);
    assert.deepEqual((await call(app, a, "GET", "/auth/prefs")).body.items["table.x"], { sort: [], hidden: [] });
    expectStatus(await call(app, a, "DELETE", "/auth/prefs/table.x"), 200);
    assert.equal((await call(app, a, "GET", "/auth/prefs")).body.items["table.x"], undefined);
  });

  it("keeps each user's layouts apart", async () => {
    const r = await call(app, b, "GET", "/auth/prefs");
    assert.deepEqual(r.body.items, {});
  });

  it("accepts only the table layout shape, and needs a signed-in user", async () => {
    for (const body of [
      { sort: [1, 2, 3, 4].map((i) => ({ key: `c${i}`, dir: "asc" })), hidden: [] },
      { sort: [{ key: "a", dir: "up" }], hidden: [] },
      { sort: [], hidden: [], script: "<x>" },
    ]) expectStatus(await call(app, a, "PUT", "/auth/prefs/table.y", { body }), 422, JSON.stringify(body));
    expectStatus(await call(app, null, "GET", "/auth/prefs"), 401, "anonymous");
  });

  it("caps how many layouts one user can store", async () => {
    await ownerPool.query(
      "INSERT INTO user_ui_prefs (user_id, pref_key, value) SELECT $1, 'bulk.' || g, '{\"sort\":[],\"hidden\":[]}' FROM generate_series(1, 300) g", [b.id]);
    expectStatus(await call(app, b, "PUT", "/auth/prefs/table.new", { body: layout }), 422, "over the cap");
    expectStatus(await call(app, b, "PUT", "/auth/prefs/bulk.1", { body: layout }), 200, "replacing is still allowed");
  });
});
