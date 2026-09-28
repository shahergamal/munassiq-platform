import { defineConfig, devices } from "@playwright/test";

// End-to-end tests against the running app (web on 5173 proxying the API on 4000). Locally: start both dev servers
// (npm --prefix apps/api run dev, npm --prefix apps/web run dev), then `npm run e2e`. CI starts them itself.
export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? [["github"], ["html", { open: "never" }]] : "list",
  globalSetup: "./e2e/global-setup.ts",
  use: { baseURL: "http://localhost:5173", locale: "ar-SA", timezoneId: "Asia/Riyadh", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: process.env["CI"] ? [
    { command: "npm --prefix ../api run dev", url: "http://localhost:4000/healthz", reuseExistingServer: false, timeout: 60_000 },
    { command: "npm run dev", url: "http://localhost:5173", reuseExistingServer: false, timeout: 60_000 },
  ] : undefined,
});
