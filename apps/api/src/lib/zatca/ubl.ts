/**
 * UBL 2.1 invoice / credit note / debit note XML as ZATCA's XML Implementation Standard requires.
 *
 * The XML is written compact (no whitespace between elements) and already in canonical form (C14N: attributes
 * sorted by name — schemeAgencyID before schemeID —, no XML declaration, explicit end tags, canonical escaping). ZATCA computes the invoice hash
 * over the document WITHOUT ext:UBLExtensions, cac:Signature and the QR reference, canonicalized; because those
 * three parts are separate strings here and nothing surrounds them, the text hashed by `unsignedForHash()` is
 * exactly what ZATCA's canonicalization yields.
 */

export interface Party {
  name: string;
  vatNumber?: string | null;
  /** Other identifier (seller: CRN...; buyer when no VAT number: CRN, NAT, IQA...). */
  idScheme?: string | null;
  id?: string | null;
  street?: string | null;
  buildingNo?: string | null;
  additionalNo?: string | null;
  district?: string | null;
  city?: string | null;
  postalCode?: string | null;
  countryCode?: string | null;
}

export interface UblLine {
  id: number;
  name: string;
  quantity: number;
  /** Unit price excluding VAT (halalas). */
  unitPrice: number;
  /** quantity × unitPrice, VAT excluded (halalas). */
  lineExtension: number;
  category: "S" | "Z" | "E" | "O";
  rate: number;
  /** Line VAT on its line extension amount (halalas). */
  vat: number;
}

/** KSA-2 transaction flags (positions 3-7 of the InvoiceTypeCode name). */
export type UblFlag = "thirdParty" | "nominal" | "exports" | "summary" | "selfBilled";
const FLAG_ORDER: UblFlag[] = ["thirdParty", "nominal", "exports", "summary", "selfBilled"];

/** A prepayment (386) an invoice deducts: the reference and the VAT breakdown it carried (KSA-31/KSA-32). */
export interface UblPrepayment { number: string; issuedAt: Date; category: "S" | "Z" | "E" | "O"; rate: number; taxable: number; vat: number }

export interface UblDocument {
  kind: "invoice" | "credit_note" | "debit_note" | "prepayment";
  invoiceType: "standard" | "simplified";
  number: string;
  uuid: string;
  issuedAt: Date;
  supplyDate?: string | null;
  icv: number;
  pih: string;
  seller: Party;
  buyer?: Party | null;
  /** For notes: the original invoice number and the reason (KSA-10 / instruction note). */
  billingReference?: string | null;
  reason?: string | null;
  paymentMeans: "cash" | "card" | "bank_transfer" | "credit" | "other";
  lines: UblLine[];
  /** Document-level discount per VAT category (halalas), subtracted from the line total. */
  allowances: { category: "S" | "Z" | "E" | "O"; rate: number; amount: number; exemptionCode?: string | null; exemptionReason?: string | null }[];
  /** Per category: taxable amount and VAT (halalas), with the exemption reason for Z/E/O. */
  subtotals: { category: "S" | "Z" | "E" | "O"; rate: number; taxable: number; vat: number; exemptionCode?: string | null; exemptionReason?: string | null }[];
  flags?: Partial<Record<UblFlag, boolean>>;
  /** Final invoice only: prepayments deducted. Their total (taxable + VAT) is the PrepaidAmount. */
  prepayments?: UblPrepayment[];
  /** payable = taxInclusive − prepaid + rounding; rounding (0 or a halala) bridges a VAT-inclusive amount with no exact split. */
  totals: { lineExtension: number; allowance: number; taxExclusive: number; vat: number; taxInclusive: number; rounding?: number; payable: number };
}

const NS = 'xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"';

/** Canonical text escaping (C14N): & < > and CR. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r/g, "&#xD;");
const amount = (halalas: number) => (halalas / 100).toFixed(2);
const el = (name: string, value: string | null | undefined, attrs = "") => (value === null || value === undefined || value === "" ? "" : `<${name}${attrs}>${esc(value)}</${name}>`);
const money = (name: string, halalas: number) => `<${name} currencyID="SAR">${amount(halalas)}</${name}>`;

const TYPE_CODE = { invoice: "388", credit_note: "381", debit_note: "383", prepayment: "386" } as const;

/** The KSA-2 code: 01 standard / 02 simplified, then one digit per flag. */
export const typeName = (d: Pick<UblDocument, "invoiceType" | "flags">) =>
  (d.invoiceType === "standard" ? "01" : "02") + FLAG_ORDER.map((f) => (d.flags?.[f] ? "1" : "0")).join("");

/** ZATCA's rules on the flags and prepayments this builder can express; the issuing code checks before stamping. */
export function documentProblems(d: Pick<UblDocument, "invoiceType" | "kind" | "flags" | "buyer" | "lines" | "prepayments">): string[] {
  const out: string[] = [];
  const f = d.flags ?? {};
  if (d.invoiceType === "simplified" && (f.exports || f.selfBilled)) out.push("علامة التصدير أو الفوترة الذاتية للفواتير الضريبية (بين المنشآت) فقط");
  if (f.exports && f.selfBilled) out.push("لا تجتمع علامة التصدير مع الفوترة الذاتية");
  if (f.exports) {
    if (!d.buyer?.countryCode || d.buyer.countryCode === "SA") out.push("فاتورة التصدير لمشترٍ خارج المملكة");
    if (d.lines.some((l) => l.category !== "Z")) out.push("بنود فاتورة التصدير صفرية النسبة (صادرات)");
  }
  if (d.prepayments?.length && d.kind !== "invoice") out.push("تُخصم الدفعات المقدمة في فاتورة فقط");
  return out;
}
const MEANS = { cash: "10", card: "48", bank_transfer: "42", credit: "30", other: "1" } as const;

function party(p: Party, supplier: boolean) {
  const idPart = p.id && p.idScheme ? `<cac:PartyIdentification><cbc:ID schemeID="${esc(p.idScheme)}">${esc(p.id)}</cbc:ID></cac:PartyIdentification>` : "";
  const address = p.street || p.city || p.postalCode
    ? `<cac:PostalAddress>${el("cbc:StreetName", p.street)}${el("cbc:BuildingNumber", p.buildingNo)}${el("cbc:PlotIdentification", p.additionalNo)}${el("cbc:CitySubdivisionName", p.district)}${el("cbc:CityName", p.city)}${el("cbc:PostalZone", p.postalCode)}<cac:Country><cbc:IdentificationCode>${esc(p.countryCode ?? "SA")}</cbc:IdentificationCode></cac:Country></cac:PostalAddress>`
    : "";
  const tax = p.vatNumber
    ? `<cac:PartyTaxScheme><cbc:CompanyID>${esc(p.vatNumber)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>`
    : supplier ? "" : "<cac:PartyTaxScheme><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>";
  return `<cac:Party>${idPart}${address}${tax}<cac:PartyLegalEntity><cbc:RegistrationName>${esc(p.name)}</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party>`;
}

function taxCategory(tag: "cac:TaxCategory" | "cac:ClassifiedTaxCategory", c: { category: string; rate: number; exemptionCode?: string | null; exemptionReason?: string | null }, withScheme: boolean) {
  const id = withScheme ? `<cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">${c.category}</cbc:ID>` : `<cbc:ID>${c.category}</cbc:ID>`;
  const reason = c.category !== "S" && c.exemptionCode ? `${el("cbc:TaxExemptionReasonCode", c.exemptionCode)}${el("cbc:TaxExemptionReason", c.exemptionReason)}` : "";
  const scheme = withScheme ? '<cac:TaxScheme><cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5153">VAT</cbc:ID></cac:TaxScheme>' : "<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>";
  return `<${tag}>${id}<cbc:Percent>${c.rate.toFixed(2)}</cbc:Percent>${reason}${scheme}</${tag}>`;
}

export interface UblParts {
  /** Everything before ext:UBLExtensions: "<Invoice ...>". */
  open: string;
  /** Between ext:UBLExtensions and the QR reference. */
  head: string;
  /** From the supplier party to the end. */
  tail: string;
}

export function buildUbl(d: UblDocument): UblParts {
  const issueDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh" }).format(d.issuedAt);
  const issueTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Riyadh", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(d.issuedAt);
  const name = typeName(d);
  const billing = d.kind !== "invoice" && d.billingReference
    ? `<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${esc(d.billingReference)}</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>` : "";
  const head =
    "<cbc:ProfileID>reporting:1.0</cbc:ProfileID>" +
    el("cbc:ID", d.number) + el("cbc:UUID", d.uuid) + el("cbc:IssueDate", issueDate) + el("cbc:IssueTime", issueTime) +
    `<cbc:InvoiceTypeCode name="${name}">${TYPE_CODE[d.kind]}</cbc:InvoiceTypeCode>` +
    "<cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode><cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>" +
    billing +
    `<cac:AdditionalDocumentReference><cbc:ID>ICV</cbc:ID><cbc:UUID>${d.icv}</cbc:UUID></cac:AdditionalDocumentReference>` +
    `<cac:AdditionalDocumentReference><cbc:ID>PIH</cbc:ID><cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${esc(d.pih)}</cbc:EmbeddedDocumentBinaryObject></cac:Attachment></cac:AdditionalDocumentReference>`;

  const buyer = d.buyer ? `<cac:AccountingCustomerParty>${party(d.buyer, false)}</cac:AccountingCustomerParty>` : "<cac:AccountingCustomerParty></cac:AccountingCustomerParty>";
  const delivery = d.supplyDate ? `<cac:Delivery><cbc:ActualDeliveryDate>${esc(d.supplyDate)}</cbc:ActualDeliveryDate></cac:Delivery>` : "";
  const payment = `<cac:PaymentMeans><cbc:PaymentMeansCode>${MEANS[d.paymentMeans]}</cbc:PaymentMeansCode>${d.kind !== "invoice" ? el("cbc:InstructionNote", d.reason) : ""}</cac:PaymentMeans>`;
  const allowances = d.allowances.filter((a) => a.amount > 0).map((a) =>
    `<cac:AllowanceCharge><cbc:ChargeIndicator>false</cbc:ChargeIndicator><cbc:AllowanceChargeReason>discount</cbc:AllowanceChargeReason>${money("cbc:Amount", a.amount)}${taxCategory("cac:TaxCategory", a, true)}</cac:AllowanceCharge>`).join("");
  const taxTotals =
    `<cac:TaxTotal>${money("cbc:TaxAmount", d.totals.vat)}</cac:TaxTotal>` +
    `<cac:TaxTotal>${money("cbc:TaxAmount", d.totals.vat)}${d.subtotals.map((s) => `<cac:TaxSubtotal>${money("cbc:TaxableAmount", s.taxable)}${money("cbc:TaxAmount", s.vat)}${taxCategory("cac:TaxCategory", s, true)}</cac:TaxSubtotal>`).join("")}</cac:TaxTotal>`;
  const t = d.totals;
  const prepaid = (d.prepayments ?? []).reduce((a, p) => a + p.taxable + p.vat, 0);
  const legal = `<cac:LegalMonetaryTotal>${money("cbc:LineExtensionAmount", t.lineExtension)}${money("cbc:TaxExclusiveAmount", t.taxExclusive)}${money("cbc:TaxInclusiveAmount", t.taxInclusive)}${money("cbc:AllowanceTotalAmount", t.allowance)}${money("cbc:PrepaidAmount", prepaid)}${t.rounding ? money("cbc:PayableRoundingAmount", t.rounding) : ""}${money("cbc:PayableAmount", t.payable)}</cac:LegalMonetaryTotal>`;
  const lines = d.lines.map((l) =>
    `<cac:InvoiceLine><cbc:ID>${l.id}</cbc:ID><cbc:InvoicedQuantity unitCode="PCE">${qty(l.quantity)}</cbc:InvoicedQuantity>${money("cbc:LineExtensionAmount", l.lineExtension)}` +
    `<cac:TaxTotal>${money("cbc:TaxAmount", l.vat)}${money("cbc:RoundingAmount", l.lineExtension + l.vat)}</cac:TaxTotal>` +
    `<cac:Item><cbc:Name>${esc(l.name)}</cbc:Name>${taxCategory("cac:ClassifiedTaxCategory", l, false)}</cac:Item>` +
    `<cac:Price>${money("cbc:PriceAmount", l.unitPrice)}</cac:Price></cac:InvoiceLine>`).join("") + prepaymentLines(d);
  const tail = `<cac:AccountingSupplierParty>${party(d.seller, true)}</cac:AccountingSupplierParty>${buyer}${delivery}${payment}${allowances}${taxTotals}${legal}${lines}</Invoice>`;
  return { open: `<Invoice ${NS}>`, head, tail };
}

const qty = (q: number) => q.toFixed(6);

/**
 * One zero-amount line per deducted prepayment: the 386 reference (number, date, time, type) and, in the line's
 * tax subtotal, the taxable amount and VAT it carried. Riyadh time, as the prepayment itself was stamped.
 */
function prepaymentLines(d: UblDocument) {
  const first = d.lines.length + 1;
  return (d.prepayments ?? []).map((p, i) => {
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh" }).format(p.issuedAt);
    const time = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Riyadh", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(p.issuedAt);
    return `<cac:InvoiceLine><cbc:ID>${first + i}</cbc:ID><cbc:InvoicedQuantity unitCode="PCE">${qty(0)}</cbc:InvoicedQuantity>${money("cbc:LineExtensionAmount", 0)}` +
      `<cac:DocumentReference>${el("cbc:ID", p.number)}${el("cbc:IssueDate", date)}${el("cbc:IssueTime", time)}<cbc:DocumentTypeCode>386</cbc:DocumentTypeCode></cac:DocumentReference>` +
      `<cac:TaxTotal>${money("cbc:TaxAmount", 0)}${money("cbc:RoundingAmount", 0)}<cac:TaxSubtotal>${money("cbc:TaxableAmount", p.taxable)}${money("cbc:TaxAmount", p.vat)}${taxCategory("cac:TaxCategory", p, true)}</cac:TaxSubtotal></cac:TaxTotal>` +
      `<cac:Item><cbc:Name>${esc(`خصم دفعة مقدمة ${p.number} / Prepayment adjustment`)}</cbc:Name>${taxCategory("cac:ClassifiedTaxCategory", p, false)}</cac:Item>` +
      `<cac:Price>${money("cbc:PriceAmount", 0)}</cac:Price></cac:InvoiceLine>`;
  }).join("");
}

/** The document as ZATCA hashes it: no UBLExtensions, no QR reference, no cac:Signature. */
export const unsignedForHash = (p: UblParts) => p.open + p.head + p.tail;

export const SIGNATURE_REF = '<cac:Signature><cbc:ID>urn:oasis:names:specification:ubl:signature:Invoice</cbc:ID><cbc:SignatureMethod>urn:oasis:names:specification:ubl:dsig:enveloped:xades</cbc:SignatureMethod></cac:Signature>';

export const qrReference = (qr: string) =>
  `<cac:AdditionalDocumentReference><cbc:ID>QR</cbc:ID><cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${esc(qr)}</cbc:EmbeddedDocumentBinaryObject></cac:Attachment></cac:AdditionalDocumentReference>`;

/** The signed document: extensions first, then the header, the QR reference and the signature reference. */
export const assemble = (p: UblParts, extensions: string, qr: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n${p.open}${extensions}${p.head}${qrReference(qr)}${SIGNATURE_REF}${p.tail}`;
