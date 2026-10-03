import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// A fresh user, session, factory workspace and contracting workspace for this run, made directly in the test database by the API's
// script (apps/api/src/scripts/e2e-session.ts): the browser gets the session cookie; no password is typed.
export default function globalSetup() {
  const api = fileURLToPath(new URL("../../api", import.meta.url));
  const out = execFileSync("node", ["--env-file=.env", "src/scripts/e2e-session.ts"], { cwd: api, encoding: "utf8" });
  const { token, csrf, tenantId, contractingTenantId } = JSON.parse(out) as { token: string; csrf: string; tenantId: string; contractingTenantId: string };
  writeFileSync(new URL("./.auth.json", import.meta.url), JSON.stringify({
    cookies: [{ name: "mn_sid", value: token, domain: "localhost", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }], origins: [],
  }));
  writeFileSync(new URL("./.state.json", import.meta.url), JSON.stringify({ tenantId, contractingTenantId, csrf }));
}
