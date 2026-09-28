import { execFileSync } from "node:child_process";
import { createHash, randomBytes, verify, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Transport } from "../../src/lib/zatca/service.ts";

/**
 * A stand-in for ZATCA's Fatoora API. It issues real certificates for the device's key (a local test CA through
 * OpenSSL) and independently re-checks every document: the invoice hash recomputed without the signature parts,
 * and the ECDSA signature against the issued certificate. It rejects what does not verify, like ZATCA would.
 */
const CA_KEY = new URL("../fixtures/zatca-test-key.pem", import.meta.url);
const CA_CERT = new URL("../fixtures/zatca-test-cert.pem", import.meta.url);
export function issueCertificate(csrPem: string): string {
  const dir = mkdtempSync(join(tmpdir(), "zatca-"));
  try {
    writeFileSync(join(dir, "req.csr"), csrPem);
    execFileSync("openssl", ["x509", "-req", "-in", join(dir, "req.csr"), "-CA", CA_CERT.pathname.replace(/^\/([A-Za-z]:)/, "$1"), "-CAkey", CA_KEY.pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      "-set_serial", `0x${randomBytes(8).toString("hex")}`, "-days", "30", "-sha256", "-outform", "DER", "-out", join(dir, "cert.der")], { stdio: "pipe" });
    return readFileSync(join(dir, "cert.der")).toString("base64");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** What ZATCA checks: the hash of the document without its signature parts, and the signature over that hash. */
export function check(invoiceB64: string, invoiceHash: string): string[] {
  const xml = Buffer.from(invoiceB64, "base64").toString("utf8");
  const stripped = xml.replace(/^<\?xml[^>]*\?>\n/, "")
    .replace(/<ext:UBLExtensions>[\s\S]*<\/ext:UBLExtensions>/, "")
    .replace(/<cac:AdditionalDocumentReference><cbc:ID>QR<\/cbc:ID>[\s\S]*?<\/cac:AdditionalDocumentReference>/, "")
    .replace(/<cac:Signature>[\s\S]*?<\/cac:Signature>/, "");
  const hash = createHash("sha256").update(stripped, "utf8").digest();
  const errors: string[] = [];
  if (hash.toString("base64") !== invoiceHash) errors.push("INVOICE_HASHING_ERRORS: hash mismatch");
  const cert = /<ds:X509Certificate>([^<]+)</.exec(xml)?.[1];
  const sig = /<ds:SignatureValue>([^<]+)</.exec(xml)?.[1];
  if (!cert || !sig) return [...errors, "signature missing"];
  const key = new X509Certificate(Buffer.from(cert, "base64")).publicKey;
  if (!verify("sha256", hash, { key, dsaEncoding: "der" }, Buffer.from(sig, "base64"))) errors.push("SIGNATURE_ERRORS: signature does not verify");
  if (xml.includes("REJECT-ME")) errors.push("BR-KSA-XX: rejected on purpose");
  return errors;
}

export const zatca = {
  csrs: new Map<string, string>(),
  tokens: new Map<string, "compliance" | "production">(),
  received: [] as { path: string; uuid: string; ok: boolean; xml: string }[],
  networkDown: false,
};
export const ok = (extra: object = {}) => ({ status: 200, body: { validationResults: { status: "PASS", infoMessages: [], warningMessages: [], errorMessages: [] }, ...extra } });
export const transport: Transport = async (_env, _method, path, headers, body: any) => {
  if (zatca.networkDown && path.startsWith("/invoices")) throw new Error("ECONNRESET");
  const auth = headers.Authorization ? Buffer.from(headers.Authorization.replace("Basic ", ""), "base64").toString().split(":")[0]! : null;
  if (path === "/compliance") {
    if (headers.OTP !== "123456") return { status: 400, body: { errors: ["Invalid OTP"] } };
    const csr = Buffer.from(body.csr, "base64").toString("utf8");
    const requestID = String(Date.now());
    zatca.csrs.set(requestID, csr);
    const token = Buffer.from(issueCertificate(csr)).toString("base64");
    zatca.tokens.set(token, "compliance");
    return { status: 200, body: { requestID, dispositionMessage: "ISSUED", binarySecurityToken: token, secret: "compliance-secret" } };
  }
  if (path === "/production/csids") {
    if (!auth || zatca.tokens.get(auth) !== "compliance") return { status: 401, body: null };
    const token = Buffer.from(issueCertificate(zatca.csrs.get(body.compliance_request_id)!)).toString("base64");
    zatca.tokens.set(token, "production");
    return { status: 200, body: { requestID: body.compliance_request_id, binarySecurityToken: token, secret: "production-secret" } };
  }
  const need = path === "/compliance/invoices" ? "compliance" : "production";
  if (!auth || zatca.tokens.get(auth) !== need) return { status: 401, body: null };
  const errors = check(body.invoice, body.invoiceHash);
  zatca.received.push({ path, uuid: body.uuid, ok: !errors.length, xml: Buffer.from(body.invoice, "base64").toString("utf8") });
  if (errors.length) return { status: 400, body: { validationResults: { status: "ERROR", errorMessages: errors.map((m) => ({ type: "ERROR", code: m.split(":")[0], message: m })) } } };
  if (path === "/invoices/clearance/single") {
    const xml = Buffer.from(body.invoice, "base64").toString("utf8").replace(/(<cbc:ID>QR<\/cbc:ID><cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="text\/plain">)[^<]+/, "$1Q0xFQVJFRC1CWS1aQVRDQQ==");
    return ok({ clearanceStatus: "CLEARED", clearedInvoice: Buffer.from(xml).toString("base64") });
  }
  return ok(path === "/compliance/invoices" ? { reportingStatus: "REPORTED", clearanceStatus: "CLEARED" } : { reportingStatus: "REPORTED" });
};
