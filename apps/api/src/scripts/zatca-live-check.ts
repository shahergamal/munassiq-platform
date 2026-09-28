// A live run of onboarding steps 1-2 (compliance CSID and compliance checks) against ZATCA's developer portal
// (the "sandbox" environment), with a throwaway key and a test seller. Nothing is written to the database.
// It is the check the code must pass before any workspace onboards on simulation or production.
//
//   npm run zatca:live-check                 # developer portal, its documented test OTP
//   npm run zatca:live-check -- 123456 1100  # another OTP / invoice types
//
// Needs outbound HTTPS to gw-fatoora.zatca.gov.sa.

import { buildCsr, generateKeys } from "../lib/zatca/csr.ts";
import { runCompliance } from "../lib/zatca/service.ts";

const otp = process.argv[2] ?? "123345";
const types = (process.argv[3] ?? "1100") as "1100" | "0100" | "1000";
const party = { name: "Munassiq Live Check", vatNumber: "399999999900003", idScheme: "CRN", id: "1010010000", street: "King Fahd Rd", buildingNo: "1234",
  district: "Al Olaya", city: "Riyadh", postalCode: "12211", countryCode: "SA" };
const keys = generateKeys();
const csr = buildCsr({ environment: "sandbox", commonName: "MUNASSIQ-LIVE-CHECK", organizationUnit: "Riyadh Branch", organization: party.name, vatNumber: party.vatNumber,
  serialNumber: `1-Munassiq|2-1.0|3-${crypto.randomUUID()}`, invoiceTypes: types, location: "RRRD2929", industry: "Manufacturing" }, keys.privateKeyPem);

const r = await runCompliance("sandbox", otp, csr.pem, types, party, keys.privateKeyPem);
console.log(r.ok ? "compliance CSID issued" : `failed at ${r.stage}: ${r.message}`);
for (const x of r.results) {
  console.log(`${x.ok ? "PASS" : "FAIL"} ${x.status}  ${x.document}`);
  for (const m of [...x.errors, ...x.warnings]) console.log(`      ${m}`);
}
process.exit(r.ok ? 0 : 1);
