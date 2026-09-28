import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, setCsrfToken, setUnauthorizedHandler } from "../api/client";

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("api client", () => {
  afterEach(() => { vi.unstubAllGlobals(); setCsrfToken(null); });

  it("sends tenant, CSRF and idempotency headers on writes, never on reads", async () => {
    setCsrfToken("csrf-1");
    const f = mockFetch(200, { ok: true });
    await api("POST", "/t/pos/orders", { tenant: "t-1", idempotencyKey: "k-1", body: { a: 1 } });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    const h = init.headers as Record<string, string>;
    expect(url).toBe("/api/v1/t/pos/orders");
    expect(h["x-tenant-id"]).toBe("t-1");
    expect(h["x-csrf-token"]).toBe("csrf-1");
    expect(h["idempotency-key"]).toBe("k-1");
    expect(init.credentials).toBe("same-origin");

    await api("GET", "/t/suppliers", { tenant: "t-1", query: { q: "x", empty: "", none: null } });
    const [url2, init2] = f.mock.calls[1] as unknown as [string, RequestInit];
    expect(url2).toBe("/api/v1/t/suppliers?q=x");
    expect((init2.headers as Record<string, string>)["x-csrf-token"]).toBeUndefined();
  });

  it("turns server errors into ApiError with the server's Arabic message and field errors", async () => {
    mockFetch(422, { error: { code: "validation_failed", message: "أدخل الاسم", details: [{ path: "name", message: "أدخل الاسم" }] } });
    const err = await api("POST", "/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe("أدخل الاسم");
    expect((err as ApiError).fieldErrors).toEqual({ name: "أدخل الاسم" });
  });

  it("never shows raw text for network failures and calls the 401 handler", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const net = (await api("GET", "/x").catch((e: unknown) => e)) as ApiError;
    expect(net.code).toBe("network");
    expect(net.message).not.toMatch(/fetch/i);

    const onUnauth = vi.fn();
    setUnauthorizedHandler(onUnauth);
    mockFetch(401, { error: { code: "unauthenticated", message: "يجب تسجيل الدخول أولاً" } });
    await api("GET", "/t/x").catch(() => undefined);
    expect(onUnauth).toHaveBeenCalledOnce();
  });
});
