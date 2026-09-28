// The only way the browser talks to the backend: same-origin /api/v1 (proxied by Vite in development).
// The browser never reaches the database, never computes prices, and never decides permissions.

export interface ApiErrorBody {
  error?: { code?: string; message?: string; details?: unknown };
}

export class ApiError extends Error {
  status: number;
  code: string;
  details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
  /** Field-level validation issues from the server (zod paths), if any. */
  get fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    if (this.code === "validation_failed" && Array.isArray(this.details)) {
      for (const d of this.details as { path?: string; message?: string }[]) {
        if (d.path && d.message && !out[d.path]) out[d.path] = d.message;
      }
    }
    return out;
  }
}

// Fallbacks when the server did not send an Arabic message (network, proxy, unexpected status).
const FALLBACK: Record<string, string> = {
  network: "تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة",
  internal: "حدث خطأ غير متوقع في الخادم. أعد المحاولة، وإذا استمر تواصل مع الدعم",
  unauthenticated: "انتهت الجلسة. سجّل الدخول مرة أخرى",
  forbidden: "لا تملك صلاحية تنفيذ هذا الإجراء",
  not_found: "السجل غير موجود أو حُذف",
  rate_limited: "عدد الطلبات كبير. انتظر قليلاً ثم أعد المحاولة",
};

let csrfToken: string | null = null;
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/** Called on 401 with the error code: "mfa_required" means signed in, the authenticator code still due. */
type Unauthorized = (code?: string) => void;
let onUnauthorized: Unauthorized = () => undefined;
export function setUnauthorizedHandler(fn: Unauthorized): void {
  onUnauthorized = fn;
}

export interface RequestOptions {
  body?: unknown;
  tenant?: string;
  /** Idempotency-Key for financial writes. Create it ONCE per operation (useIdempotencyKey), not per click. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  query?: Record<string, string | number | boolean | null | undefined>;
}

function buildUrl(path: string, query?: RequestOptions["query"]): string {
  const url = `/api/v1${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

async function send(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { accept: "application/json" };
  const isForm = typeof FormData !== "undefined" && opts.body instanceof FormData;
  if (opts.body !== undefined && !isForm) headers["content-type"] = "application/json";
  if (method !== "GET" && csrfToken) headers["x-csrf-token"] = csrfToken;
  if (opts.tenant) headers["x-tenant-id"] = opts.tenant;
  if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;

  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method,
      headers,
      credentials: "same-origin",
      signal: opts.signal,
      body: opts.body === undefined ? undefined : isForm ? (opts.body as FormData) : JSON.stringify(opts.body),
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError(0, "network", FALLBACK["network"] as string);
  }
  if (res.ok) return res;

  let body: ApiErrorBody = {};
  try {
    body = (await res.json()) as ApiErrorBody;
  } catch {
    /* non-JSON error page from a proxy */
  }
  const code = body.error?.code ?? (res.status >= 500 ? "internal" : "bad_request");
  const message = body.error?.message ?? FALLBACK[code] ?? FALLBACK["internal"] as string;
  if (res.status === 401) onUnauthorized(code);
  throw new ApiError(res.status, code, message, body.error?.details);
}

/** The raw response, for streams (the assistant's server-sent events). Errors still throw ApiError. */
export const request = (method: string, path: string, opts: RequestOptions = {}) => send(method, path, opts);

export async function api<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await send(method, path, opts);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Downloads a server-generated file (xlsx) without building it in the browser. */
export async function download(path: string, tenant: string | undefined, fallbackName: string): Promise<void> {
  const res = await send("GET", path, { tenant });
  const blob = await res.blob();
  const cd = res.headers.get("content-disposition") ?? "";
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(cd)?.[1];
  let name = /filename="([^"]+)"/.exec(cd)?.[1] ?? fallbackName;
  try { if (encoded) name = decodeURIComponent(encoded); } catch { /* keep the plain name */ }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return FALLBACK["internal"] as string;
}

export interface Page<T> {
  items: T[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}
