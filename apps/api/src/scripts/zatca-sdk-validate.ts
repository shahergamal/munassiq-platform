// Validates what we generate with ZATCA's official SDK (the "fatoora" CLI): one signed document of every kind and
// flag we issue, written to a folder and passed to `fatoora -validate`. Run in CI (.github/workflows/zatca-sdk.yml).
//
//   ZATCA_SDK_HOME=/path/to/zatca-einvoicing-sdk npm run zatca:sdk-validate
//
// With the SDK present, the samples are signed with the SDK's own test certificate and key (Data/Certificates), so
// the SDK's certificate checks apply as they do to its bundled samples. Without it, the samples are only written
// (signed with the test fixture key) and the script exits 0 with a note, or 1 with --require.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { INITIAL_PIH, signDocument } from "../lib/zatca/sign.ts";
import type { UblDocument } from "../lib/zatca/ubl.ts";

const sdk = process.env["ZATCA_SDK_HOME"];
const out = resolve(process.argv.find((a) => a.startsWith("--out="))?.slice(6) ?? "zatca-samples");
const requireSdk = process.argv.includes("--require");
mkdirSync(out, { recursive: true });

const pemBody = (pem: string) => pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
const fixture = (f: string) => readFileSync(new URL(`../../test/fixtures/${f}`, import.meta.url), "utf8");
const certPem = sdk ? readFileSync(join(sdk, "Data", "Certificates", "cert.pem"), "utf8") : fixture("zatca-test-cert.pem");
const keyPem = sdk ? readFileSync(join(sdk, "Data", "Certificates", "ec-secp256k1-priv-key.pem"), "utf8") : fixture("zatca-test-key.pem");
// The SDK's key file is the bare base64 of the key; PEM armour is added when missing.
const key = keyPem.includes("BEGIN") ? keyPem : `-----BEGIN EC PRIVATE KEY-----\n${keyPem.trim()}\n-----END EC PRIVATE KEY-----\n`;

const seller = { name: "مصنع التحقق للأغذية", vatNumber: "399999999900003", idScheme: "CRN", id: "1010010000", street: "طريق الملك فهد", buildingNo: "1234",
  district: "العليا", city: "الرياض", postalCode: "12211", countryCode: "SA" };
const buyer = { name: "شركة المشتري", vatNumber: "399999999800003", street: "شارع العليا", buildingNo: "4321", district: "الملز", city: "الرياض", postalCode: "11564", countryCode: "SA" };
const foreign = { name: "Gulf Trading LLC", street: "Sheikh Zayed Rd", buildingNo: "1", city: "Dubai", postalCode: "00000", countryCode: "AE" };
const now = new Date();
const line = (net: number, category: "S" | "Z" = "S") => ({ id: 1, name: "كرتون عصير", quantity: 1, unitPrice: net, lineExtension: net, category, rate: category === "S" ? 15 : 0, vat: category === "S" ? net * 15 / 100 : 0 });
const doc = (kind: UblDocument["kind"], invoiceType: UblDocument["invoiceType"], n: number, extra: Partial<UblDocument> = {}): UblDocument => {
  const l = extra.lines?.[0] ?? line(100000);
  const vat = l.vat;
  return {
    kind, invoiceType, number: `SDK-${n}`, uuid: randomUUID(), issuedAt: now, supplyDate: now.toISOString().slice(0, 10), icv: n, pih: INITIAL_PIH, seller,
    buyer: invoiceType === "standard" ? buyer : { name: "عميل نقدي" }, paymentMeans: "cash", allowances: [], lines: [l],
    billingReference: kind === "credit_note" || kind === "debit_note" ? "SDK-1" : null, reason: kind === "credit_note" || kind === "debit_note" ? "تعديل الكمية" : null,
    subtotals: [{ category: l.category, rate: l.rate, taxable: l.lineExtension, vat, ...(l.category === "Z" ? { exemptionCode: "VATEX-SA-32", exemptionReason: "Export of goods" } : {}) }],
    totals: { lineExtension: l.lineExtension, allowance: 0, taxExclusive: l.lineExtension, vat, taxInclusive: l.lineExtension + vat, payable: l.lineExtension + vat },
    ...extra,
  };
};
const prepaid = { number: "SDK-7", issuedAt: now, category: "S" as const, rate: 15, taxable: 40000, vat: 6000 };
const samples: [string, UblDocument][] = [
  ["standard-invoice", doc("invoice", "standard", 1)],
  ["standard-credit-note", doc("credit_note", "standard", 2)],
  ["standard-debit-note", doc("debit_note", "standard", 3)],
  ["simplified-invoice", doc("invoice", "simplified", 4)],
  ["simplified-credit-note", doc("credit_note", "simplified", 5)],
  ["simplified-debit-note", doc("debit_note", "simplified", 6)],
  ["standard-prepayment-386", doc("prepayment", "standard", 7, { lines: [line(40000)] })],
  ["standard-invoice-deducting-prepayment", (() => { const d = doc("invoice", "standard", 8); return { ...d, prepayments: [prepaid], totals: { ...d.totals, payable: d.totals.payable - 46000 } }; })()],
  ["standard-export-invoice", doc("invoice", "standard", 9, { buyer: foreign, flags: { exports: true }, lines: [line(100000, "Z")] })],
];

for (const [name, d] of samples) writeFileSync(join(out, `${name}.xml`), signDocument(d, pemBody(certPem), key).xml);
console.log(`wrote ${samples.length} signed samples to ${out}`);

if (!sdk) {
  console.log("ZATCA_SDK_HOME is not set: the samples were not validated. Download the SDK from ZATCA's developer portal and set it.");
  process.exit(requireSdk ? 1 : 0);
}
const cli = [join(sdk, "Apps", process.platform === "win32" ? "fatoora.bat" : "fatoora"), join(sdk, "Apps", "fatoora")].find(existsSync);
if (!cli) { console.error(`fatoora CLI not found under ${sdk}/Apps (run the SDK's install script first)`); process.exit(1); }
let failed = 0;
for (const [name] of samples) {
  let text = "";
  try {
    text = execFileSync(cli, ["-validate", "-invoice", join(out, `${name}.xml`)], { encoding: "utf8", stdio: "pipe", shell: process.platform === "win32" });
  } catch (e) {
    text = String((e as { stdout?: string }).stdout ?? "") + String((e as { stderr?: string }).stderr ?? "");
  }
  const passed = /GLOBAL VALIDATION RESULT\s*=\s*PASSED/i.test(text);
  if (!passed) failed++;
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}`);
  if (!passed) console.log(text.split("\n").filter((l) => /ERROR|WARNING|FAILED/i.test(l)).map((l) => `      ${l.trim()}`).join("\n"));
}
process.exit(failed ? 1 : 0);
