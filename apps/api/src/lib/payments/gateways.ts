/**
 * Moyasar and Tap, behind one small interface: check a key, open a hosted payment page for an amount, and read a
 * payment back. Amounts cross this boundary in halalas. Nothing here touches the database.
 *
 *   Moyasar: https://api.moyasar.com/v1, HTTP Basic (secret key as the user name), Invoices API (amount in halalas).
 *   Tap:     https://api.tap.company/v2, Bearer secret key, Charges API with source src_all (amount in riyals).
 */

export type Provider = "moyasar" | "tap";
export const PROVIDERS: Provider[] = ["moyasar", "tap"];
export type Mode = "test" | "live";
export type LinkStatus = "pending" | "paid" | "failed" | "expired" | "canceled";

export interface GatewayReply { status: number; body: any }
export type Transport = (provider: Provider, method: "GET" | "POST", path: string, secretKey: string, body?: unknown) => Promise<GatewayReply>;

const BASE: Record<Provider, string> = { moyasar: "https://api.moyasar.com/v1", tap: "https://api.tap.company/v2" };

const httpTransport: Transport = async (provider, method, path, secretKey, body) => {
  const auth = provider === "moyasar" ? `Basic ${Buffer.from(`${secretKey}:`, "utf8").toString("base64")}` : `Bearer ${secretKey}`;
  const r = await fetch(BASE[provider] + path, {
    method,
    headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: auth, lang_code: "ar" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { message: text.slice(0, 300) }; }
  return { status: r.status, body: parsed };
};

let transport: Transport = httpTransport;
/** Tests replace the network with a stand-in gateway. */
export function setGatewayTransport(t: Transport | null) { transport = t ?? httpTransport; }

export class GatewayError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** `sk_test_…` / `sk_live_…`: both gateways use the same key shape. Publishable keys (pk_…) are refused. */
export function keyMode(key: string): Mode | null {
  const m = /^sk_(test|live)_[A-Za-z0-9]{8,120}$/.exec(key);
  return m ? (m[1] as Mode) : null;
}

/** The gateway's own error text, for the owner. */
function messageOf(body: any): string {
  if (!body) return "";
  if (typeof body.message === "string") {
    const errs = body.errors && typeof body.errors === "object" ? Object.entries(body.errors).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join("، ") : v}`) : [];
    return [body.message, ...errs].join(" — ").slice(0, 400);
  }
  if (Array.isArray(body.errors)) return body.errors.map((e: any) => e?.description ?? e?.message ?? e?.code).filter(Boolean).join(" — ").slice(0, 400);
  return "";
}

async function call(provider: Provider, method: "GET" | "POST", path: string, key: string, body?: unknown): Promise<any> {
  let r: GatewayReply;
  try {
    r = await transport(provider, method, path, key, body);
  } catch {
    throw new GatewayError(0, "تعذر الاتصال ببوابة الدفع. تحقق من الاتصال وأعد المحاولة");
  }
  if (r.status === 401 || r.status === 403) throw new GatewayError(r.status, "رفضت بوابة الدفع المفتاح. تأكد أنه المفتاح السري الصحيح وأنه مفعّل");
  if (r.status < 200 || r.status >= 300) throw new GatewayError(r.status, `رفضت بوابة الدفع الطلب${messageOf(r.body) ? `: ${messageOf(r.body)}` : ""}`);
  return r.body;
}

/** Proves the key works. Only an authentication failure counts against it (the probe itself may be refused for other reasons). */
export async function verifyKey(provider: Provider, key: string): Promise<void> {
  try {
    if (provider === "moyasar") await call(provider, "GET", "/invoices?page=1", key);
    else await call(provider, "POST", "/charges/list", key, { limit: 1 });
  } catch (err) {
    if (err instanceof GatewayError && (err.status === 0 || err.status === 401 || err.status === 403 || err.status >= 500)) throw err;
  }
}

export interface Payer { name: string; phone: string | null; email: string | null }
export interface OpenInput {
  linkId: string;
  amount: number; // halalas
  description: string;
  documentNumber: string;
  payer: Payer;
  /** Where the gateway notifies us (omitted when the server has no public https address). */
  webhookUrl: string | null;
  returnUrl: string;
}
export interface Opened { ref: string; url: string; providerStatus: string }

/** Saudi numbers as Tap wants them: country code + national number without the leading 0. */
export function splitPhone(phone: string): { country_code: string; number: string } {
  const d = phone.replace(/\D/g, "");
  if (d.startsWith("966")) return { country_code: "966", number: d.slice(3).replace(/^0/, "") };
  if (d.startsWith("00")) return { country_code: d.slice(2, 5), number: d.slice(5) };
  return { country_code: "966", number: d.replace(/^0/, "") };
}

export async function openPayment(provider: Provider, key: string, x: OpenInput): Promise<Opened> {
  if (provider === "moyasar") {
    const b = await call(provider, "POST", "/invoices", key, {
      amount: x.amount,
      currency: "SAR",
      description: x.description.slice(0, 255),
      ...(x.webhookUrl ? { callback_url: x.webhookUrl } : {}),
      success_url: x.returnUrl,
      back_url: x.returnUrl,
      metadata: { link_id: x.linkId, document: x.documentNumber },
    });
    if (typeof b?.id !== "string" || typeof b?.url !== "string") throw new GatewayError(502, "ردّ بوابة الدفع غير مكتمل (لا يوجد رابط)");
    return { ref: b.id, url: b.url, providerStatus: String(b.status ?? "initiated") };
  }
  const [first, ...rest] = x.payer.name.trim().split(/\s+/);
  const b = await call(provider, "POST", "/charges", key, {
    amount: x.amount / 100,
    currency: "SAR",
    customer_initiated: true,
    threeDSecure: true,
    save_card: false,
    description: x.description.slice(0, 255),
    metadata: { udf1: x.linkId, udf2: x.documentNumber },
    reference: { transaction: x.linkId, order: x.documentNumber },
    customer: {
      first_name: first ?? x.payer.name,
      ...(rest.length ? { last_name: rest.join(" ") } : {}),
      ...(x.payer.email ? { email: x.payer.email } : {}),
      ...(x.payer.phone ? { phone: splitPhone(x.payer.phone) } : {}),
    },
    source: { id: "src_all" },
    ...(x.webhookUrl ? { post: { url: x.webhookUrl } } : {}),
    redirect: { url: x.returnUrl },
  });
  const url = b?.transaction?.url;
  if (typeof b?.id !== "string" || typeof url !== "string") throw new GatewayError(502, `ردّ بوابة الدفع غير مكتمل (لا يوجد رابط)${messageOf(b?.response) ? `: ${messageOf(b.response)}` : ""}`);
  return { ref: b.id, url, providerStatus: String(b.status ?? "INITIATED") };
}

export interface Fetched {
  status: LinkStatus;
  providerStatus: string;
  amount: number; // halalas
  currency: string;
  paymentRef: string | null;
}

export async function fetchPayment(provider: Provider, key: string, ref: string): Promise<Fetched> {
  const id = encodeURIComponent(ref);
  if (provider === "moyasar") {
    const b = await call(provider, "GET", `/invoices/${id}`, key);
    const s = String(b?.status ?? "");
    const paid = Array.isArray(b?.payments) ? b.payments.find((p: any) => p?.status === "paid") : null;
    return {
      status: s === "paid" ? "paid" : s === "expired" ? "expired" : s === "canceled" || s === "voided" ? "canceled" : "pending",
      providerStatus: s,
      amount: Number(b?.amount),
      currency: String(b?.currency ?? ""),
      paymentRef: paid?.id ? String(paid.id) : null,
    };
  }
  const b = await call(provider, "GET", `/charges/${id}`, key);
  const s = String(b?.status ?? "").toUpperCase();
  const status: LinkStatus = s === "CAPTURED" ? "paid"
    : ["INITIATED", "IN_PROGRESS", "PENDING", "AUTHORIZED"].includes(s) ? "pending"
    : ["ABANDONED", "CANCELLED", "VOID"].includes(s) ? "canceled"
    : "failed";
  return {
    status,
    providerStatus: s,
    amount: Math.round(Number(b?.amount) * 100),
    currency: String(b?.currency ?? ""),
    paymentRef: b?.reference?.payment ? String(b.reference.payment) : b?.receipt?.id ? String(b.receipt.id) : null,
  };
}

/** The gateway object id a webhook refers to (the payment itself is always re-read from the gateway). */
export function webhookRef(provider: Provider, body: any): string | null {
  const pick = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9_-]{3,100}$/.test(v) ? v : null);
  if (provider === "tap") return pick(body?.id);
  // Invoice callback: the invoice itself. Account webhooks: a payment carrying its invoice_id.
  return pick(body?.data?.invoice_id) ?? pick(body?.invoice_id) ?? (body?.data ? null : pick(body?.id));
}
