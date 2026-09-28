import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildCsr, generateKeys } from "../src/lib/zatca/csr.ts";
import { certificateHash, certificateInfo } from "../src/lib/zatca/cert.ts";
import { INITIAL_PIH, signDocument } from "../src/lib/zatca/sign.ts";
import type { UblDocument } from "../src/lib/zatca/ubl.ts";
import { open, seal } from "../src/lib/zatca/vault.ts";

// A local self-signed secp256k1 certificate (NOT issued by ZATCA): exercises parsing, signing and the QR offline.
const keyPem = readFileSync(new URL("./fixtures/zatca-test-key.pem", import.meta.url), "utf8");
const certB64 = readFileSync(new URL("./fixtures/zatca-test-cert.pem", import.meta.url), "utf8").replace(/-----[^-]+-----|\s/g, "");

const doc = (over: Partial<UblDocument> = {}): UblDocument => ({
  kind: "invoice", invoiceType: "simplified", number: "POS-000001", uuid: "3cf5ee18-ee25-44ea-a444-2c37ba7f28be",
  issuedAt: new Date("2026-09-25T10:45:10Z"), icv: 1, pih: INITIAL_PIH, paymentMeans: "cash",
  seller: { name: "مطعم المثال | Example", vatNumber: "399999999900003", idScheme: "CRN", id: "1010010000", street: "الأمير سلطان", buildingNo: "2322", district: "المربع", city: "الرياض", postalCode: "12345", countryCode: "SA" },
  buyer: { name: "عميل نقدي" },
  lines: [
    { id: 1, name: "برجر & بطاطس <كبير>", quantity: 2, unitPrice: 2000, lineExtension: 4000, category: "S", rate: 15, vat: 600 },
    { id: 2, name: "ماء", quantity: 1, unitPrice: 200, lineExtension: 200, category: "S", rate: 15, vat: 30 },
  ],
  allowances: [],
  subtotals: [{ category: "S", rate: 15, taxable: 4200, vat: 630 }],
  totals: { lineExtension: 4200, allowance: 0, taxExclusive: 4200, vat: 630, taxInclusive: 4830, payable: 4830 },
  ...over,
});

const decodeTlv = (b64: string) => {
  const buf = Buffer.from(b64, "base64");
  const out = new Map<number, Buffer>();
  for (let p = 0; p < buf.length;) { out.set(buf[p]!, buf.subarray(p + 2, p + 2 + buf[p + 1]!)); p += 2 + buf[p + 1]!; }
  return out;
};

test("the initial previous-invoice hash is base64 of the hex text of SHA-256('0')", () => {
  assert.equal(INITIAL_PIH, Buffer.from(createHash("sha256").update("0").digest("hex")).toString("base64"));
});

test("the device key is secp256k1 and the certificate request is a signed PKCS#10 with ZATCA's fields", () => {
  const k = generateKeys();
  assert.match(k.privateKeyPem, /BEGIN EC PRIVATE KEY/);
  const { pem, der } = buildCsr({ environment: "simulation", commonName: "MUNASSIQ-1", organizationUnit: "Riyadh", organization: "مطعم", vatNumber: "399999999900003", serialNumber: "1-Munassiq|2-1.0|3-abc", invoiceTypes: "1100", location: "RRRD2929", industry: "Restaurants" }, k.privateKeyPem);
  assert.match(pem, /^-----BEGIN CERTIFICATE REQUEST-----\n/);
  const text = der.toString("latin1");
  for (const s of ["PREZATCA-Code-Signing", "399999999900003", "1-Munassiq|2-1.0|3-abc", "1100", "RRRD2929", "Restaurants"]) assert.ok(text.includes(s), s);
});

test("certificate facts: issuer in reverse order, decimal serial, digest of the base64 text", () => {
  const c = certificateInfo(certB64);
  assert.equal(c.issuer, "CN=TEST-ONLY-NOT-ZATCA-CA, DC=extgazt, DC=gov, DC=local");
  assert.match(c.serial, /^\d+$/);
  assert.equal(c.publicKey.length, 88);
  assert.equal(certificateHash(certB64), Buffer.from(createHash("sha256").update(certB64).digest("hex")).toString("base64"));
});

test("the stamp: hash of the document without the signature parts, ECDSA over the raw hash, 9-tag QR", () => {
  const s = signDocument(doc(), certB64, keyPem, new Date("2026-09-25T10:45:12Z"));
  // Removing the three parts from the final bytes gives exactly the text that was hashed.
  const stripped = s.xml
    .replace(/^<\?xml[^>]*\?>\n/, "")
    .replace(/<ext:UBLExtensions>[\s\S]*<\/ext:UBLExtensions>/, "")
    .replace(/<cac:AdditionalDocumentReference><cbc:ID>QR<\/cbc:ID>[\s\S]*?<\/cac:AdditionalDocumentReference>/, "")
    .replace(/<cac:Signature>[\s\S]*?<\/cac:Signature>/, "");
  const hash = createHash("sha256").update(stripped, "utf8").digest();
  assert.equal(s.invoiceHash, hash.toString("base64"));
  const publicKey = createPublicKey({ key: certificateInfo(certB64).publicKey, format: "der", type: "spki" });
  assert.ok(verify("sha256", hash, { key: publicKey, dsaEncoding: "der" }, Buffer.from(s.signature, "base64")), "the signature verifies over the raw hash");
  assert.ok(s.xml.includes(`<ds:DigestValue>${s.invoiceHash}</ds:DigestValue>`));
  assert.ok(s.xml.includes("&amp;") && s.xml.includes("&lt;كبير&gt;"), "text is escaped");

  const q = decodeTlv(s.qr);
  assert.equal(q.get(1)!.toString(), "مطعم المثال | Example");
  assert.equal(q.get(3)!.toString(), "2026-09-25T13:45:10", "issue date and time in Riyadh, as in the XML");
  assert.deepEqual([q.get(4)!.toString(), q.get(5)!.toString()], ["48.30", "6.30"]);
  assert.equal(q.get(6)!.toString(), s.invoiceHash);
  assert.equal(q.get(7)!.toString(), s.signature);
  assert.equal(q.get(8)!.length, 88);
  assert.ok(q.get(9), "simplified documents carry the certificate signature");
  assert.ok(Buffer.from(s.qr, "base64").length <= 700);
  assert.ok(!decodeTlv(signDocument(doc({ invoiceType: "standard" }), certB64, keyPem).qr).has(9), "standard documents do not");
});

test("the embedded SignedProperties keeps the hashed form's inner whitespace", () => {
  const s = signDocument(doc(), certB64, keyPem, new Date("2026-09-25T10:45:12Z"));
  const embedded = /<xades:SignedProperties Id="xadesSignedProperties">[\s\S]*?<\/xades:SignedProperties>/.exec(s.xml)![0];
  const hashedForm = embedded
    .replace('<xades:SignedProperties Id=', '<xades:SignedProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Id=')
    .replace(/<ds:(DigestMethod|DigestValue|X509IssuerName|X509SerialNumber)/g, '<ds:$1 xmlns:ds="http://www.w3.org/2000/09/xmldsig#"');
  const digest = Buffer.from(createHash("sha256").update(hashedForm).digest("hex")).toString("base64");
  const refs = [...s.xml.matchAll(/<ds:DigestValue>([^<]+)<\/ds:DigestValue>/g)].map((m) => m[1]);
  assert.equal(refs[1], digest, "the second reference is the SignedProperties digest");
  assert.match(embedded, /<xades:SigningTime>2026-09-25T10:45:12<\/xades:SigningTime>/);
});

test("device secrets are sealed with AES-256-GCM and never stored in clear", () => {
  const secret = "x".repeat(40);
  const sealed = seal(keyPem, secret);
  assert.ok(!sealed.includes("PRIVATE KEY"));
  assert.equal(open(sealed, secret), keyPem);
  const tampered = sealed.slice(0, -4) + (sealed.endsWith("AAAA") ? "BBBB" : "AAAA");
  assert.throws(() => open(tampered, secret));
  assert.throws(() => open(sealed, "y".repeat(40)), "another server secret cannot open it");
});
