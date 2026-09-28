import { createHash } from "node:crypto";

/**
 * ZATCA e-invoicing — Phase 1 (generation) only.
 * This produces the mandatory simplified-invoice QR (TLV, tags 1-5). It does NOT
 * implement Phase 2 (UBL 2.1 XML, cryptographic stamp, CSID onboarding, clearance/reporting).
 */

function tlv(tag: number, value: string): Buffer {
  const body = Buffer.from(value, "utf8");
  if (body.length > 255) throw new RangeError("tlv_value_too_long");
  return Buffer.concat([Buffer.from([tag, body.length]), body]);
}

export interface QrInput {
  sellerName: string;
  vatNumber: string;
  issuedAt: Date;
  totalWithVat: string; // "115.00"
  vatAmount: string; // "15.00"
}

export function buildQrBase64(i: QrInput): string {
  return Buffer.concat([
    tlv(1, i.sellerName),
    tlv(2, i.vatNumber),
    tlv(3, i.issuedAt.toISOString().replace(/\.\d{3}Z$/, "Z")),
    tlv(4, i.totalWithVat),
    tlv(5, i.vatAmount),
  ]).toString("base64");
}

export function decodeQr(base64: string): Record<number, string> {
  const buf = Buffer.from(base64, "base64");
  const out: Record<number, string> = {};
  for (let p = 0; p < buf.length; ) {
    const tag = buf[p] as number;
    const len = buf[p + 1] as number;
    out[tag] = buf.subarray(p + 2, p + 2 + len).toString("utf8");
    p += 2 + len;
  }
  return out;
}

/** Tamper-evidence chain (NOT the ZATCA Phase-2 invoice hash). */
export function integrityHash(previousHash: string, payload: Record<string, string | number>): string {
  const canonical = JSON.stringify(Object.keys(payload).sort().map((k) => [k, payload[k]]));
  return createHash("sha256").update(`${previousHash}|${canonical}`).digest("hex");
}

export const GENESIS_HASH = "0".repeat(64);
