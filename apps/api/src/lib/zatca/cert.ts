import { createHash, X509Certificate } from "node:crypto";
import { children, read } from "./der.ts";

/**
 * What the signature and the QR need from the CSID certificate. ZATCA returns the certificate as
 * `binarySecurityToken` = base64 of the base64 DER; `certificate` below is that inner base64 DER text.
 */
export function certificateInfo(certificate: string) {
  const der = Buffer.from(certificate, "base64");
  const x = new X509Certificate(der);
  // "CN=..., DC=..., DC=..." — the issuer RDNs from the most specific, as ZATCA's SDK writes X509IssuerName.
  const issuer = x.issuer.split("\n").reverse().join(", ");
  const serial = BigInt(`0x${x.serialNumber}`).toString(10);
  const publicKey = x.publicKey.export({ type: "spki", format: "der" });
  // The certificate's own signature (outer BIT STRING, without its unused-bits byte): QR tag 9 for simplified invoices.
  const top = children(der, read(der, 0));
  const sigBits = top[2]!;
  const signature = der.subarray(sigBits.start + 1, sigBits.end);
  return { issuer, serial, publicKey, signature, validTo: new Date(x.validTo), subject: x.subject };
}

/** base64( hex( SHA-256( certificate base64 text ) ) ) — the xades CertDigest ZATCA expects. */
export const certificateHash = (certificate: string) => Buffer.from(createHash("sha256").update(certificate, "utf8").digest("hex"), "utf8").toString("base64");
