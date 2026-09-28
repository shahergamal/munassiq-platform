import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildUbl, documentProblems, typeName, unsignedForHash, type UblDocument } from "../src/lib/zatca/ubl.ts";

// M6: the KSA-2 transaction flags, the prepayment (386) document and the final invoice that deducts prepayments.
const base: UblDocument = {
  kind: "invoice", invoiceType: "standard", number: "INV-1", uuid: "3cf5ee18-ee25-44ea-a444-2c37ba7f28be", issuedAt: new Date("2026-09-28T09:00:00Z"),
  icv: 2, pih: "x", seller: { name: "مصنع", vatNumber: "399999999900003", countryCode: "SA" }, buyer: { name: "Buyer", countryCode: "AE" },
  paymentMeans: "credit", allowances: [],
  lines: [{ id: 1, name: "كرتون", quantity: 10, unitPrice: 10000, lineExtension: 100000, category: "S", rate: 15, vat: 15000 }],
  subtotals: [{ category: "S", rate: 15, taxable: 100000, vat: 15000 }],
  totals: { lineExtension: 100000, allowance: 0, taxExclusive: 100000, vat: 15000, taxInclusive: 115000, payable: 115000 },
};

describe("ZATCA M6 UBL", () => {
  it("KSA-2 is 01/02 then one digit per flag: third party, nominal, exports, summary, self-billed", () => {
    assert.equal(typeName({ invoiceType: "standard" }), "0100000");
    assert.equal(typeName({ invoiceType: "simplified" }), "0200000");
    assert.equal(typeName({ invoiceType: "standard", flags: { exports: true } }), "0100100");
    assert.equal(typeName({ invoiceType: "standard", flags: { thirdParty: true, selfBilled: true } }), "0110001");
  });

  it("refuses flag combinations ZATCA rejects", () => {
    assert.deepEqual(documentProblems({ ...base, flags: { exports: true }, lines: [{ ...base.lines[0]!, category: "Z", rate: 0, vat: 0 }] }), []);
    assert.equal(documentProblems({ ...base, flags: { exports: true } }).length, 1, "a standard-rated line");
    assert.equal(documentProblems({ ...base, invoiceType: "simplified", flags: { exports: true }, lines: [{ ...base.lines[0]!, category: "Z" }] }).length, 1);
    assert.equal(documentProblems({ ...base, buyer: { name: "محلي", countryCode: "SA" }, flags: { exports: true }, lines: [{ ...base.lines[0]!, category: "Z" }] }).length, 1);
    assert.equal(documentProblems({ ...base, kind: "credit_note", prepayments: [{ number: "PRE-1", issuedAt: new Date(), category: "S", rate: 15, taxable: 1, vat: 0 }] }).length, 1);
  });

  it("a prepayment is type 386", () => {
    const x = unsignedForHash(buildUbl({ ...base, kind: "prepayment" }));
    assert.match(x, /<cbc:InvoiceTypeCode name="0100000">386<\/cbc:InvoiceTypeCode>/);
    assert.match(x, /<cbc:PrepaidAmount currencyID="SAR">0.00<\/cbc:PrepaidAmount>/);
  });

  it("the final invoice adds one zero line per prepayment and the PrepaidAmount", () => {
    const x = unsignedForHash(buildUbl({ ...base, prepayments: [{ number: "PRE-000001", issuedAt: new Date("2026-09-20T07:30:00Z"), category: "S", rate: 15, taxable: 40000, vat: 6000 }],
      totals: { ...base.totals, payable: 115000 - 46000 } }));
    assert.match(x, /<cac:InvoiceLine><cbc:ID>2<\/cbc:ID><cbc:InvoicedQuantity unitCode="PCE">0.000000<\/cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="SAR">0.00<\/cbc:LineExtensionAmount>/);
    assert.match(x, /<cac:DocumentReference><cbc:ID>PRE-000001<\/cbc:ID><cbc:IssueDate>2026-09-20<\/cbc:IssueDate><cbc:IssueTime>10:30:00<\/cbc:IssueTime><cbc:DocumentTypeCode>386<\/cbc:DocumentTypeCode><\/cac:DocumentReference>/, "Riyadh time");
    assert.match(x, /<cbc:PrepaidAmount currencyID="SAR">460.00<\/cbc:PrepaidAmount><cbc:PayableAmount currencyID="SAR">690.00<\/cbc:PayableAmount>/);
    // The document-level VAT stays the full invoice's (BR-CO-15); the prepaid VAT is in the line's KSA-32.
    assert.match(x, /<cac:TaxTotal><cbc:TaxAmount currencyID="SAR">150.00<\/cbc:TaxAmount><\/cac:TaxTotal>/);
  });
});
