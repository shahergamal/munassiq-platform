import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Encryption at rest for the e-invoicing device's private key and CSID secrets (AES-256-GCM, key derived from
 * `secret`: ZATCA_KEY_SECRET, or SESSION_SECRET when that is not set). Changing the secret makes stored devices
 * unusable: they would have to be onboarded again with a new OTP.
 */
/** `purpose` separates the keys of different integrations (ZATCA devices, payment gateways) derived from one secret. */
const key = (secret: string, purpose: string) => Buffer.from(hkdfSync("sha256", secret, "munassiq", purpose, 32));
const ZATCA = "zatca/device-secrets/v1";

export function seal(plain: string, secret: string, purpose = ZATCA): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(secret, purpose), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1.${Buffer.concat([iv, c.getAuthTag(), body]).toString("base64")}`;
}

export function open(sealed: string, secret: string, purpose = ZATCA): string {
  if (!sealed.startsWith("v1.")) throw new Error("unknown sealed format");
  const raw = Buffer.from(sealed.slice(3), "base64");
  const d = createDecipheriv("aes-256-gcm", key(secret, purpose), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}
