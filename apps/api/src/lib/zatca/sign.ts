import { createHash, createPrivateKey, sign } from "node:crypto";
import { certificateHash, certificateInfo } from "./cert.ts";
import { assemble, buildUbl, unsignedForHash, type UblDocument } from "./ubl.ts";

/**
 * The cryptographic stamp, as ZATCA's SDK computes it:
 *   invoice hash = base64(SHA-256(C14N(document without UBLExtensions, QR reference, cac:Signature)))
 *   signature    = ECDSA secp256k1 / SHA-256 over the RAW 32-byte invoice hash (DER, base64)
 *   cert digest  = base64(hex(SHA-256(certificate base64 text)))
 *   props digest = base64(hex(SHA-256(the SignedProperties string below, byte for byte)))
 * The SignedProperties template (indentation, per-element xmlns:ds, self-closing DigestMethod) is the one
 * production-tested implementations use; the copy embedded in the document keeps the same inner whitespace.
 */

const INITIAL_PIH = "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==";
export { INITIAL_PIH };

const DS = 'xmlns:ds="http://www.w3.org/2000/09/xmldsig#"';
const pad = (n: number) => " ".repeat(n);

/** The SignedProperties element; `inlineDs` adds xmlns:ds on each ds:* element (the hashed form). */
function signedProperties(v: { time: string; certHash: string; issuer: string; serial: string }, inlineDs: boolean) {
  const ds = inlineDs ? ` ${DS}` : "";
  const xades = inlineDs ? ' xmlns:xades="http://uri.etsi.org/01903/v1.3.2#"' : "";
  return [
    `<xades:SignedProperties${xades} Id="xadesSignedProperties">`,
    `${pad(32)}<xades:SignedSignatureProperties>`,
    `${pad(36)}<xades:SigningTime>${v.time}</xades:SigningTime>`,
    `${pad(36)}<xades:SigningCertificate>`,
    `${pad(40)}<xades:Cert>`,
    `${pad(44)}<xades:CertDigest>`,
    `${pad(48)}<ds:DigestMethod${ds} Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>`,
    `${pad(48)}<ds:DigestValue${ds}>${v.certHash}</ds:DigestValue>`,
    `${pad(44)}</xades:CertDigest>`,
    `${pad(44)}<xades:IssuerSerial>`,
    `${pad(48)}<ds:X509IssuerName${ds}>${xmlText(v.issuer)}</ds:X509IssuerName>`,
    `${pad(48)}<ds:X509SerialNumber${ds}>${v.serial}</ds:X509SerialNumber>`,
    `${pad(44)}</xades:IssuerSerial>`,
    `${pad(40)}</xades:Cert>`,
    `${pad(36)}</xades:SigningCertificate>`,
    `${pad(32)}</xades:SignedSignatureProperties>`,
    `${pad(28)}</xades:SignedProperties>`,
  ].join("\n");
}

const xmlText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const hexB64 = (data: string) => Buffer.from(createHash("sha256").update(data, "utf8").digest("hex"), "utf8").toString("base64");

function extensions(v: { invoiceHash: string; propsHash: string; signature: string; certificate: string; props: string }) {
  return `<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionURI>urn:oasis:names:specification:ubl:dsig:enveloped:xades</ext:ExtensionURI><ext:ExtensionContent>` +
    `<sig:UBLDocumentSignatures xmlns:sig="urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2" xmlns:sac="urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2" xmlns:sbc="urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2">` +
    `<sac:SignatureInformation><cbc:ID>urn:oasis:names:specification:ubl:signature:1</cbc:ID><sbc:ReferencedSignatureID>urn:oasis:names:specification:ubl:signature:Invoice</sbc:ReferencedSignatureID>` +
    `<ds:Signature ${DS} Id="signature"><ds:SignedInfo>` +
    `<ds:CanonicalizationMethod Algorithm="http://www.w3.org/2006/12/xml-c14n11"/><ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256"/>` +
    `<ds:Reference Id="invoiceSignedData" URI=""><ds:Transforms>` +
    `<ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116"><ds:XPath>not(//ancestor-or-self::ext:UBLExtensions)</ds:XPath></ds:Transform>` +
    `<ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116"><ds:XPath>not(//ancestor-or-self::cac:Signature)</ds:XPath></ds:Transform>` +
    `<ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116"><ds:XPath>not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])</ds:XPath></ds:Transform>` +
    `<ds:Transform Algorithm="http://www.w3.org/2006/12/xml-c14n11"/></ds:Transforms>` +
    `<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><ds:DigestValue>${v.invoiceHash}</ds:DigestValue></ds:Reference>` +
    `<ds:Reference Type="http://www.w3.org/2000/09/xmldsig#SignatureProperties" URI="#xadesSignedProperties">` +
    `<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><ds:DigestValue>${v.propsHash}</ds:DigestValue></ds:Reference>` +
    `</ds:SignedInfo><ds:SignatureValue>${v.signature}</ds:SignatureValue>` +
    `<ds:KeyInfo><ds:X509Data><ds:X509Certificate>${v.certificate}</ds:X509Certificate></ds:X509Data></ds:KeyInfo>` +
    `<ds:Object><xades:QualifyingProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Target="signature">${v.props}</xades:QualifyingProperties></ds:Object>` +
    `</ds:Signature></sac:SignatureInformation></sig:UBLDocumentSignatures></ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions>`;
}

/** TLV with one-byte tag and length; values over 255 bytes are refused (ZATCA's limit). */
function tlv(tag: number, value: Buffer) {
  if (value.length > 255) throw new RangeError(`QR tag ${tag} is longer than 255 bytes`);
  return Buffer.concat([Buffer.from([tag, value.length]), value]);
}

export interface SignedDocument {
  xml: string;
  invoiceHash: string;
  qr: string;
  signature: string;
}

/**
 * Builds, hashes, signs and assembles one document. `certificate` is the base64 DER of the device's CSID
 * certificate; `privateKeyPem` its secp256k1 key. `now` is the signing time (the server clock, never the client's).
 */
export function signDocument(d: UblDocument, certificate: string, privateKeyPem: string, now = new Date()): SignedDocument {
  const parts = buildUbl(d);
  const hashBytes = createHash("sha256").update(unsignedForHash(parts), "utf8").digest();
  const invoiceHash = hashBytes.toString("base64");
  const signature = sign("sha256", hashBytes, { key: createPrivateKey(privateKeyPem), dsaEncoding: "der" }).toString("base64");
  const cert = certificateInfo(certificate);
  const time = now.toISOString().slice(0, 19); // UTC, no fraction, no "Z" (SDK style)
  const props = { time, certHash: certificateHash(certificate), issuer: cert.issuer, serial: cert.serial };
  const propsHash = hexB64(signedProperties(props, true));

  const issueDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh" }).format(d.issuedAt);
  const issueTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Riyadh", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(d.issuedAt);
  const t = d.totals;
  const qr = Buffer.concat([
    tlv(1, Buffer.from(d.seller.name, "utf8")),
    tlv(2, Buffer.from(d.seller.vatNumber ?? "", "utf8")),
    tlv(3, Buffer.from(`${issueDate}T${issueTime}`, "utf8")),
    tlv(4, Buffer.from((t.taxInclusive / 100).toFixed(2), "utf8")),
    tlv(5, Buffer.from((t.vat / 100).toFixed(2), "utf8")),
    tlv(6, Buffer.from(invoiceHash, "utf8")),
    tlv(7, Buffer.from(signature, "utf8")),
    tlv(8, cert.publicKey),
    ...(d.invoiceType === "simplified" ? [tlv(9, cert.signature)] : []),
  ]).toString("base64");

  const xml = assemble(parts, extensions({ invoiceHash, propsHash, signature, certificate, props: signedProperties(props, false) }), qr);
  return { xml, invoiceHash, qr, signature };
}
