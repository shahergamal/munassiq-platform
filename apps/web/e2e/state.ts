import { readFileSync } from "node:fs";

export const AUTH = new URL("./.auth.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const state = () => JSON.parse(readFileSync(new URL("./.state.json", import.meta.url), "utf8")) as { tenantId: string; contractingTenantId: string; csrf: string };
export const tenantId = () => state().tenantId;
export const contractingTenantId = () => state().contractingTenantId;
/** For seeding through the API from a test (the session cookie comes from the storage state). */
export const csrf = () => state().csrf;
