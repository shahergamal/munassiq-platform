import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// scrypt, OWASP-approved parameter set: N=2^16, r=8, p=2 (~64 MiB per hash).
const SCRYPT = { N: 2 ** 16, r: 8, p: 2, keyLen: 64, maxmem: 256 * 1024 * 1024 } as const;

function scryptAsync(password: string, salt: Buffer, opts: { N: number; r: number; p: number; maxmem: number }, keyLen: number) {
  return new Promise<Buffer>((resolve, reject) =>
    scrypt(password.normalize("NFKC"), salt, keyLen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string, overrides?: Partial<typeof SCRYPT>): Promise<string> {
  const p = { ...SCRYPT, ...overrides };
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, p, p.keyLen);
  return ["scrypt", p.N, p.r, p.p, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltB64, keyB64] = stored.split("$");
  if (scheme !== "scrypt" || !n || !r || !p || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64");
  const actual = await scryptAsync(
    password,
    Buffer.from(saltB64, "base64"),
    { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem },
    expected.length,
  );
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A precomputed hash used to keep login timing equal for unknown accounts. */
export const DUMMY_HASH_PROMISE = hashPassword("munassiq-dummy-password");

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function csrfTokenFor(sessionId: string, secret: string): string {
  return createHmac("sha256", secret).update(`csrf:${sessionId}`).digest("base64url");
}

export function verifyCsrf(sessionId: string, provided: string | undefined, secret: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(csrfTokenFor(sessionId, secret));
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

const COMMON = new Set(["password12", "1234567890", "qwertyuiop", "12345678910", "0123456789", "iloveyou12", "administrator"]);

/** Returns an Arabic error message, or null when the password is acceptable. */
export function passwordProblem(password: string, email: string): string | null {
  if (password.length < 10) return "كلمة المرور يجب ألا تقل عن 10 أحرف";
  if (password.length > 128) return "كلمة المرور طويلة جداً";
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  if (local.length >= 4 && password.toLowerCase().includes(local)) return "كلمة المرور لا يجب أن تحتوي على جزء من بريدك";
  if (COMMON.has(password.toLowerCase()) || /^(.)\1+$/.test(password)) return "كلمة المرور شائعة وسهلة التخمين";
  return null;
}
