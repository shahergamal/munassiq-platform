import test from "node:test";
import assert from "node:assert/strict";
import { base32Decode, base32Encode, hashRecovery, recoveryCodes, totpAt, verifyTotp } from "../src/lib/auth/totp.ts";

// RFC 6238 appendix B vectors (SHA-1, secret "12345678901234567890"), last 6 digits.
test("TOTP matches the RFC 6238 test vectors", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  assert.equal(secret, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  for (const [t, code] of [[59, "287082"], [1111111109, "081804"], [1111111111, "050471"], [1234567890, "005924"], [2000000000, "279037"]] as const) {
    assert.equal(totpAt(secret, Math.floor(t / 30)), code, `t=${t}`);
  }
  assert.deepEqual(base32Decode(secret), Buffer.from("12345678901234567890"));
});

test("a code is accepted within one step of drift, and only once", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  const now = 1111111111 * 1000;
  const step = Math.floor(now / 30000);
  assert.equal(verifyTotp(secret, totpAt(secret, step), null, now), step);
  assert.equal(verifyTotp(secret, totpAt(secret, step - 1), null, now), step - 1, "30 s late is fine");
  assert.equal(verifyTotp(secret, totpAt(secret, step - 2), null, now), null, "60 s late is not");
  assert.equal(verifyTotp(secret, totpAt(secret, step), step, now), null, "replay refused");
  assert.equal(verifyTotp(secret, "12345", null, now), null);
});

test("recovery codes are random and stored hashed", () => {
  const r = recoveryCodes();
  assert.equal(new Set(r.codes).size, 10);
  assert.match(r.codes[0]!, /^[a-z2-7]{5}-[a-z2-7]{5}$/);
  assert.equal(r.hashes[3], hashRecovery(r.codes[3]!.toUpperCase()));
});
