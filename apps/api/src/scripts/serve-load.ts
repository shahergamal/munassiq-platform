// The API for a load test: the same server on another port (default 4100) with the per-IP limit raised, so the
// test measures the server, not the limiter (every client of the test shares one IP). Local use only.
process.env["PORT"] = process.env["LOAD_PORT"] ?? "4100";
process.env["RATE_LIMIT_PER_MINUTE"] = "1000000";
await import("../server.ts");
