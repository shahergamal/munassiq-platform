import test from "node:test";
import assert from "node:assert/strict";
import { buildQrBase64, decodeQr, integrityHash, GENESIS_HASH } from "../src/lib/zatca.ts";

test("QR TLV round-trips with Arabic seller names", () => {
  const qr = buildQrBase64({
    sellerName: "مطعم النخبة", vatNumber: "300000000000003",
    issuedAt: new Date("2026-09-24T10:30:00.123Z"), totalWithVat: "115.00", vatAmount: "15.00",
  });
  assert.deepEqual(decodeQr(qr), {
    1: "مطعم النخبة", 2: "300000000000003", 3: "2026-09-24T10:30:00Z", 4: "115.00", 5: "15.00",
  });
});

test("QR rejects oversized values", () => {
  assert.throws(() => buildQrBase64({ sellerName: "x".repeat(300), vatNumber: "1", issuedAt: new Date(), totalWithVat: "1", vatAmount: "0" }));
});

test("integrity hash chains and detects tampering", () => {
  const a = integrityHash(GENESIS_HASH, { icv: 1, total: "115.00" });
  const b = integrityHash(a, { icv: 2, total: "10.00" });
  assert.notEqual(a, b);
  assert.equal(integrityHash(GENESIS_HASH, { total: "115.00", icv: 1 }), a); // key order independent
  assert.notEqual(integrityHash(GENESIS_HASH, { icv: 1, total: "116.00" }), a);
});
