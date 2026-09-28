import { readFileSync } from "node:fs";

export const AUTH = new URL("./.auth.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
export const tenantId = () => (JSON.parse(readFileSync(new URL("./.state.json", import.meta.url), "utf8")) as { tenantId: string }).tenantId;
