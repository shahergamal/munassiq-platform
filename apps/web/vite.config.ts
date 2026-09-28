import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Same-origin in development: the browser talks to /api, Vite proxies it to the API. No CORS, SameSite=Lax cookie works.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: "http://localhost:4000", changeOrigin: false } },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
