import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { bits, ctx, int, octets, oid, printable, seq, set, utf8 } from "./der.ts";

/**
 * The e-invoicing device (EGS unit) identity: an ECDSA secp256k1 key pair and the PKCS#10 certificate request that
 * ZATCA signs into a Cryptographic Stamp Identifier (CSID). The request carries the fields ZATCA requires in its
 * subject and in a subjectAltName directory name (serial, VAT number, invoice types, address, industry), plus the
 * certificate-template extension that names the environment.
 */

export type ZatcaEnvironment = "sandbox" | "simulation" | "production";

/** Certificate template name per environment (Microsoft certificate-template OID 1.3.6.1.4.1.311.20.2). */
export const TEMPLATE: Record<ZatcaEnvironment, string> = {
  sandbox: "TSTZATCA-Code-Signing",
  simulation: "PREZATCA-Code-Signing",
  production: "ZATCA-Code-Signing",
};

export interface CsrInput {
  environment: ZatcaEnvironment;
  /** Unique device name, e.g. "MUNASSIQ-<tenant>" (subject CN). */
  commonName: string;
  /** Organization unit: the branch name, or the 10-digit TIN for VAT groups. */
  organizationUnit: string;
  /** Taxpayer name (subject O). */
  organization: string;
  /** 15-digit VAT registration number (SAN UID). */
  vatNumber: string;
  /** "1-<solution>|2-<model or version>|3-<device serial>" (SAN SN). */
  serialNumber: string;
  /** Invoice types this device issues: 4 digits TSCZ — T standard, S simplified, then two reserved zeros ("1100" = both). */
  invoiceTypes: string;
  /** Branch location (SAN registeredAddress). */
  location: string;
  /** Industry / business category (SAN businessCategory). */
  industry: string;
}

export function generateKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  return { privateKeyPem: privateKey.export({ type: "sec1", format: "pem" }).toString(), publicKey };
}

/** The raw (uncompressed, 65-byte) public key point from a key object. */
function publicPoint(pub: KeyObject) {
  const spki = pub.export({ type: "spki", format: "der" });
  return spki.subarray(spki.length - 65);
}

const attr = (type: string, value: Buffer) => set(seq(oid(type), value));

export function buildCsr(input: CsrInput, privateKeyPem: string) {
  const key = createPrivateKey(privateKeyPem);
  const pub = createPublicKey(key);
  const subject = seq(
    attr("2.5.4.6", printable("SA")),
    attr("2.5.4.11", utf8(input.organizationUnit)),
    attr("2.5.4.10", utf8(input.organization)),
    attr("2.5.4.3", utf8(input.commonName)),
  );
  const spki = seq(seq(oid("1.2.840.10045.2.1"), oid("1.3.132.0.10")), bits(publicPoint(pub)));
  const dirName = seq(
    attr("2.5.4.4", utf8(input.serialNumber)), // SN (surname)
    attr("0.9.2342.19200300.100.1.1", utf8(input.vatNumber)), // UID
    attr("2.5.4.12", utf8(input.invoiceTypes)), // title
    attr("2.5.4.26", utf8(input.location)), // registeredAddress
    attr("2.5.4.15", utf8(input.industry)), // businessCategory
  );
  const extensions = seq(
    seq(oid("1.3.6.1.4.1.311.20.2"), octets(printable(TEMPLATE[input.environment]))),
    seq(oid("2.5.29.17"), octets(seq(ctx(4, dirName)))),
  );
  const attributes = ctx(0, seq(oid("1.2.840.113549.1.9.14"), set(extensions)));
  const info = seq(int(0), subject, spki, attributes);
  const signature = sign("sha256", info, { key, dsaEncoding: "der" });
  const der = seq(info, seq(oid("1.2.840.10045.4.3.2")), bits(signature));
  const pem = `-----BEGIN CERTIFICATE REQUEST-----\n${der.toString("base64").replace(/.{1,64}/g, "$&\n")}-----END CERTIFICATE REQUEST-----\n`;
  return { der, pem };
}
