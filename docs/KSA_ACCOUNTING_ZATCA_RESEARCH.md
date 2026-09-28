# KSA accounting + e-invoicing (ZATCA / FATOORA) — implementation research

Researched 2026-09-25 for Munassiq (Node.js/TypeScript + PostgreSQL, multi-tenant restaurant SaaS).

**Confidence legend**
- **[P]** Primary source (ZATCA PDF, ZATCA portal/forum staff answer, or an official law text) that was read during this research.
- **[OSS]** Confirmed in production-tested open-source code that was read during this research.
- **[S]** Secondary source, such as vendor docs, a news site or Microsoft Learn.
- **[K]** From background knowledge; not re-verified in this session. **Verify before relying on it.**

---

## 0. Sources used (read in this session)

| # | Source | URL | Notes |
|---|---|---|---|
| S1 | ZATCA *Electronic Invoice XML Implementation Standard* v1.2 (2023-05-19, track-changes copy) | https://zatca.gov.sa/ar/E-Invoicing/SystemsDevelopers/Documents/20230519_ZATCA_Electronic_Invoice_XML_Implementation_Standard_%20vTrack.pdf (clean copy: `..._%20vF.pdf`) | This is the source of the BR-KSA rules, code lists, rounding and file naming. |
| S2 | ZATCA *Security Features Implementation Standards* v1.2 (2023-05-19) | https://zatca.gov.sa/ar/E-Invoicing/SystemsDevelopers/Documents/20230519_ZATCA_Electronic_Invoice_Security_Features_Implementation_Standards_vF.pdf | Covers the CSR/cert profile, XAdES, PIH, QR and Basic auth. |
| S3 | ZATCA *Detailed Guidelines for E-Invoicing* v2 (May 2023) | https://zatca.gov.sa/en/E-Invoicing/Introduction/Guidelines/Documents/E-Invoicing_Detailed__Guideline.pdf | Covers phases, prohibited functions, storage and the 24h rule. |
| S4 | ZATCA *E-Invoice Data Dictionary* v1.1 (2022-06-24) | copy at https://raw.githubusercontent.com/wes4m/zatca-xml-js/main/docs/EInvoice_Data_Dictionary.xlsx | Gives the field-by-field M/O/C status per document type. |
| S5 | ZATCA *Developer Portal User Manual* v3 (Nov 2022) | https://zatca.gov.sa/en/E-Invoicing/Introduction/Guidelines/Documents/DEVELOPER-PORTAL-MANUAL.pdf | Covers the sandbox, auth and CSR fields. |
| S6 | ZATCA *FATOORA Portal User Manual* v3 (May 2023) | https://zatca.gov.sa/en/E-Invoicing/Introduction/Guidelines/Documents/Fatoora_Portal_User_Manual_English.pdf | Covers OTP, renewal, revocation and endpoints. |
| S7 | Fatoora Developer Community: "E-Invoicing API endpoints" | https://zatca1.discourse.group/t/e-invoicing-api-endpoints/487 | |
| S8 | Fatoora Developer Community: 409 duplicate (ZATCA staff answers) | https://zatca1.discourse.group/t/409-status-code-duplicate-invoice-error/3932?page=3 | |
| S9 | Fatoora Developer Community: rounding / BR-CO-15 | https://zatca1.discourse.group/t/rounding-issue-causes-br-co-15-violation/1151 | |
| S10 | Microsoft Learn: D365 Saudi onboarding (updated 2026-09-01) | https://learn.microsoft.com/en-us/dynamics365/finance/localizations/mea/gs-e-invoicing-sa-onboarding | Includes the CSR config, the rule on which documents need compliance checks, and a PowerShell script. |
| S11 | OSS `wes4m/zatca-xml-js` (TypeScript) | https://github.com/wes4m/zatca-xml-js, files `src/zatca/signing/index.ts`, `src/zatca/qr/index.ts`, `src/zatca/api/index.ts`, `src/zatca/templates/*.ts` | Simplified invoices only. Older, and uses the old base URL. |
| S12 | OSS `Saleh7/php-zatca-xml` ("production tested 2026-03-31", aligned to ZATCA Java SDK R3.4.8) | https://github.com/Saleh7/php-zatca-xml, files `src/InvoiceSigner.php`, `src/Helpers/InvoiceSignatureBuilder.php`, `src/Helpers/Certificate.php`, `src/Helpers/InvoiceExtension.php`, `src/Tag.php`, `src/ZatcaAPI.php`, `src/CertificateBuilder.php`, `src/Api/*.php`, `examples/Certificates/ComplianceCheck.php` | **This is the best reference for byte-exact behaviour.** |
| S13 | Law of Commercial Books (Royal Decree M/61, last updated 2022-06-16), official English | https://misa.gov.sa/app/uploads/2025/07/Law-of-Commercial-Books.pdf and https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/05690bd6-2c75-4b65-a148-a9a700f1bccf/1 | |
| S14 | ZATCA news, Wave 24 | https://zatca.gov.sa/en/Pages/news_1426.aspx | |
| S15 | Wave table (secondary) | https://www.jaicome.sa/en/blog/zatca-integration-wave-deadlines/ | |
| S16 | Wave 25 (secondary) | https://www.vatupdate.com/2026/07/27/zatca-announces-wave-25-of-e-invoicing-threshold-halved-to-sar-187500-integration-deadline-1-february-2027/ | |
| S17 | VAT IR Art. 66 (record keeping) | https://www.gccfintax.com/law/records-9713.asp ; https://zatca.gov.sa/en/RulesRegulations/Taxes/Pages/VATImplementingRegulations.aspx | |
| S18 | EY: 2025 amendments to the VAT Implementing Regulations | https://www.ey.com/en_gl/technical/tax-alerts/saudi-arabia-approves-amendments-to-vat-implementing-regulations | |
| S19 | VAT return boxes (secondary) | https://www.cleartax.com/sa/vat-return-filing-saudi-arabia ; ZATCA e-service https://zatca.gov.sa/en/eServices/Pages/eservices-009.aspx | |
| S20 | Zakat Implementing Regulation 1445H (2024) | https://zatca.gov.sa/en/RulesRegulations/Documents/ZAKAT%20COLLECTION.pdf ; KPMG summary https://kpmg.com/sa/en/insights/tax-insights/tax-alert-saudi-minister-of-finance-approves-new-zakat-implementing-regulation.html | |
| S21 | IFRS Foundation jurisdiction profile, Saudi Arabia | https://www.ifrs.org/use-around-the-world/use-of-ifrs-standards-by-jurisdiction/view-jurisdiction/saudi-arabia/ | |
| S22 | ZATCA FAQ: "Are listed providers certified?" and the Solution Providers Directory | https://zatca.gov.sa/en/E-Invoicing/Introduction/FAQ/Pages/FAQ_037.aspx ; https://zatca.gov.sa/en/E-Invoicing/SolutionProviders/Pages/SolutionProvidersDirectory.aspx | |

Where these sources disagree, the conflict is noted in place (search for **CONFLICT**).

---

## 1. E-invoicing Phase 1 (Generation) vs Phase 2 (Integration)

### 1.1 Scope and dates

- **Phase 1 "Generation"** has been effective since **4 December 2021** [P S3]. Every VAT-registered resident taxpayer, and any third party issuing invoices on their behalf, must *generate and store* invoices and notes electronically through a compliant solution. There is no mandated XML format in Phase 1 [P S3 §6.6]. Simplified invoices must carry a **QR code with 5 TLV tags** (tags 1–5, see §2d) [P S2 §4.1].
- **Phase 2 "Integration"** started on **1 January 2023** and rolls out in waves [P S3]. Taxpayers are notified at least 6 months ahead. In Phase 2 the invoice must be UBL 2.1 XML (or PDF/A-3 with the XML embedded) and must carry a UUID, a hash chain (PIH), an ICV, a cryptographic stamp and a QR code with tags 1–9. Invoices are sent through the API:
  - **Standard (B2B/B2G) documents are cleared.** Each one must be sent to ZATCA and cleared **before** it is shared with the buyer [P S3 §6.5]. ZATCA returns the document with its own stamp and QR.
  - **Simplified (B2C) documents are reported.** They are shared with the customer immediately and **reported within 24 hours** of issuance [P S3 §6.5–6.6, §7.2].
- **Waves** [S S15, P S14 for wave 24, S S16 for wave 25]:

| Wave | Threshold (VAT-able revenue) | Reference years | Deadline |
|---|---|---|---|
| 1 | > SAR 3bn | 2021 | 2023-06-30 |
| 2 | SAR 500m–3bn | 2021 | 2023-12-31 |
| 3 | > SAR 250m | 2021–22 | 2024-01-31 |
| 4 | > SAR 150m | 2021–22 | 2024-02-29 |
| 5 | > SAR 100m | 2021–22 | 2024-03-31 |
| 6 | > SAR 70m | 2021–22 | 2024-04-30 |
| 7 | > SAR 50m | 2021–22 | 2024-05-31 |
| 8 | > SAR 40m | 2021–22 | 2024-06-30 |
| 9 | > SAR 30m | 2021–22 | 2024-09-30 |
| 10–23 | stepped down from SAR 25m | 2022–24 | various (2024–2026) |
| 24 | > SAR 375,000 | 2022, 2023 or 2024 | **2026-06-30** [P S14] |
| 25 | > SAR 187,500 (equal to the voluntary-registration threshold) | 2022–2025 | **2027-02-01** [S S16, announced 2026-07-24] |

  **Implication for Munassiq:** in practice every VAT-registered restaurant customer is in Phase 2 by Feb 2027, so the product needs Phase 2 from day one. A tenant that has not yet been notified may run in Phase 1 mode (generation + QR only). Build a per-tenant flag `zatca_phase` with values `1 | 2`.

### 1.2 Documents

| Document | UBL root | `InvoiceTypeCode` | `@name` (KSA-2) starts with | Flow |
|---|---|---|---|---|
| Standard tax invoice (B2B/B2G) | `Invoice` | 388 | `01` | Clearance |
| Standard debit note | `Invoice` (**not** `DebitNote`) | 383 | `01` | Clearance |
| Standard credit note | `Invoice` (**not** `CreditNote`) | 381 | `01` | Clearance |
| Simplified tax invoice (B2C) | `Invoice` | 388 | `02` | Reporting ≤ 24h |
| Simplified debit note | `Invoice` | 383 | `02` | Reporting |
| Simplified credit note | `Invoice` | 381 | `02` | Reporting |
| Prepayment invoice (standard or simplified) | `Invoice` | 386 | `01`/`02` | as above (added in v1.2) |

[P S1 §11.2.1] states: "The UBL Message type is "Invoice" for all document types." A credit or debit note "is subject to the same issuing requirements as the type of invoice on which it is based" [P S1 §5.2]. A restaurant issues simplified documents almost exclusively. It needs standard ones for catering and corporate customers that ask for a tax invoice with their VAT number.

**When a simplified invoice is allowed** [K, VAT IR Art. 53(7)]: the supply is below SAR 1,000, or the customer is not VAT-registered. B2B customers with a VAT number, and any supply of SAR 1,000 or more to a registered customer, need a standard tax invoice. Verify the exact wording in VAT IR Art. 53.

### 1.3 Required fields

The full field matrix comes from the Data Dictionary [P S4]. Status order in the table is Tax invoice / Tax debit note / Tax credit note / Simplified invoice / Simplified debit note / Simplified credit note. M = mandatory, O = optional, C = conditional, NA = not applicable.

| Term | Name | UBL path | Status (T/TD/TC/S/SD/SC) | Format / rule |
|---|---|---|---|---|
| BT-23 | Business process | `cbc:ProfileID` | M all | must be `reporting:1.0` (BR-KSA-EN16931-01) |
| BT-1 | Invoice number | `cbc:ID` | M all | free, sequential per business (e.g. `INV-2026-000123`). Printed. |
| KSA-1 | UUID | `cbc:UUID` | M all | letters, digits, dashes only (BR-KSA-03) |
| BT-2 | Issue date | `cbc:IssueDate` | M | `YYYY-MM-DD`, ≤ today (BR-KSA-04, F-01) |
| KSA-25 | Issue time | `cbc:IssueTime` | M | `HH:mm:ss` (KSA local) or `HH:mm:ssZ` (UTC) (BR-KSA-70) |
| BT-3 | Type code | `cbc:InvoiceTypeCode` | M | 388/383/381/386 |
| KSA-2 | Transaction code | `cbc:InvoiceTypeCode/@name` | M | `NNPNESB` (see §2a) |
| BT-22 | Note | `cbc:Note` | O | |
| BT-5 | Currency | `cbc:DocumentCurrencyCode` | M | ISO 4217 |
| BT-6 | Tax currency | `cbc:TaxCurrencyCode` | M | must be `SAR` (BR-KSA-68, EN16931-02) |
| BT-13 | PO number | `cac:OrderReference/cbc:ID` | O | |
| BT-25 | Billing reference (original invoice no.) | `cac:BillingReference/cac:InvoiceDocumentReference/cbc:ID` | NA/M/M/NA/M/M | mandatory on 381/383 (BR-KSA-56) |
| BT-12 | Contract ID | `cac:ContractDocumentReference/cbc:ID` | O | |
| KSA-16 | ICV | `cac:AdditionalDocumentReference[cbc:ID='ICV']/cbc:UUID` | M | digits only (BR-KSA-33/34) |
| KSA-13 | PIH | `cac:AdditionalDocumentReference[cbc:ID='PIH']/cac:Attachment/cbc:EmbeddedDocumentBinaryObject[@mimeCode='text/plain']` | M | base64 SHA-256 (BR-KSA-26/61) |
| KSA-14 | QR | `cac:AdditionalDocumentReference[cbc:ID='QR']/...EmbeddedDocumentBinaryObject[@mimeCode='text/plain']` | M | base64 TLV (BR-KSA-27) |
| KSA-15 | Cryptographic stamp | `ext:UBLExtensions/...` + `cac:Signature` | M (mandatory on simplified: BR-KSA-60) | |
| BT-29 / BT-29-1 | Seller other ID | `cac:AccountingSupplierParty/cac:Party/cac:PartyIdentification/cbc:ID/@schemeID` | C | exactly **once**; schemeID ∈ `CRN, MOM, MLS, 700, SAG, OTH`; alphanumeric only (BR-KSA-08) |
| BT-35 | Seller street | `.../cac:PostalAddress/cbc:StreetName` | M | |
| BT-36 | Seller additional street | `cbc:AdditionalStreetName` | O | |
| KSA-17 | Seller building no. | `cbc:BuildingNumber` | M | **4 digits** (BR-KSA-37) |
| KSA-23 | Seller additional no. | `cbc:PlotIdentification` | O (see BR-KSA-64) | 4 digits |
| KSA-3 | Seller district | `cbc:CitySubdivisionName` | M | |
| BT-37 | Seller city | `cbc:CityName` | M | |
| BT-38 | Seller postal code | `cbc:PostalZone` | M | **5 digits** (BR-KSA-66) |
| BT-39 | Seller province | `cbc:CountrySubentity` | O | |
| BT-40 | Seller country | `cac:Country/cbc:IdentificationCode` | M | `SA` |
| BT-31 | Seller VAT no. | `cac:PartyTaxScheme/cbc:CompanyID` (+ `cac:TaxScheme/cbc:ID`=`VAT`) | M | **15 digits, first and last = `3`** (BR-KSA-39/40) |
| BT-27 | Seller name | `cac:PartyLegalEntity/cbc:RegistrationName` | M | |
| BT-46 / BT-46-1 | Buyer other ID | `cac:AccountingCustomerParty/cac:Party/cac:PartyIdentification/cbc:ID/@schemeID` | C | schemeID ∈ `TIN, CRN, MOM, MLS, 700, SAG, NAT, GCC, IQA, PAS, OTH` (BR-KSA-14). **Required on standard documents when the buyer VAT number is absent** (BR-KSA-81). |
| BT-50, KSA-18, KSA-4, BT-52, BT-53, BT-55 | Buyer street, building, district, city, postal code, country | same paths under the customer party | M/M/M/O/O/O | BR-KSA-10. If buyer country = `SA`, all six are mandatory, building has 4 digits and postal code has 5 (BR-KSA-63/67). |
| KSA-19 | Buyer additional no. | `cbc:PlotIdentification` | O | 4 digits if present (BR-KSA-65) |
| BT-48 | Buyer VAT no. | customer `cac:PartyTaxScheme/cbc:CompanyID` | C/C/C/O/O/O | 15 digits with 3…3 (BR-KSA-44), except on exports where it must be absent (BR-KSA-46) |
| BT-44 | Buyer name | customer `cac:PartyLegalEntity/cbc:RegistrationName` | M/M/M/C/C/C | mandatory on standard documents (BR-KSA-42). On simplified documents it is mandatory for summary invoices (BR-KSA-71) and for EDU/HEA exemptions (BR-KSA-25). |
| KSA-5 | Supply date | `cac:Delivery/cbc:ActualDeliveryDate` | C | **mandatory on a standard 388** (BR-KSA-15) |
| KSA-24 | Supply end date | `cac:Delivery/cbc:LatestDeliveryDate` | C | must be ≥ supply date (BR-KSA-35/36/72) |
| BT-81 | Payment means | `cac:PaymentMeans/cbc:PaymentMeansCode` | O | 10 cash, 30 credit, 42 bank account, 48 bank card, 1 not defined |
| KSA-10 | Credit/debit note reason | `cac:PaymentMeans/cbc:InstructionNote` | NA/M/M/NA/M/M | mandatory on 381/383 (BR-KSA-17) |
| BT-106…BT-115 | Totals | `cac:LegalMonetaryTotal/*` | M | see §2a |
| BT-110 | Total VAT | `cac:TaxTotal/cbc:TaxAmount` | M | |
| BG-23 | VAT breakdown | `cac:TaxTotal/cac:TaxSubtotal` | M | ≥ 1 (BR-CO-18) |
| KSA-11 | Line VAT | `cac:InvoiceLine/cac:TaxTotal/cbc:TaxAmount` | M/M/M/O/O/O | = line net × rate/100 (BR-KSA-50) |
| KSA-12 | Line amount incl. VAT | `cac:InvoiceLine/cac:TaxTotal/cbc:RoundingAmount` | M/M/M/O/O/O | = line net + line VAT (BR-KSA-51) |

**Seller ID scheme meanings** [P S1 BR-KSA-08]:
- CRN: Commercial Registration number.
- MOM: MOMRAH licence (municipal/Balady).
- MLS: MHRSD licence.
- 700: "700 Number".
- SAG: MISA licence.
- OTH: other ID.

With multiple CRs, use the CR of the branch that issues the invoice. When several IDs exist, choose the first available in the listed sequence.

**Buyer ID schemes** add TIN, NAT (national ID), GCC (GCC ID), IQA (Iqama) and PAS (passport). BR-KSA-49: when the exemption is VATEX-SA-EDU or VATEX-SA-HEA, the buyer ID must be NAT.

**Numbers:** Western Arabic numerals (`0-9`) are required in the XML. The printed invoice may *additionally* show Eastern Arabic-Indic numerals [P S1 §7.3; P S3].

**Amounts:** use up to 2 decimals. Unit price (BT-146), quantity and percentage have no decimal limit, except that VAT rates and allowance percentages allow at most 2 decimals (BR-KSA-DEC-01/02) [P S1 §7.3]. All amounts and quantities must be **positive**; a credit note carries positive amounts (BR-KSA-F-04). The document **must not contain empty elements** (BR-KSA-F-03).

### 1.4 Invoice number, UUID, ICV and PIH

- **Invoice number (BT-1):** chosen by the seller, printed on the invoice, and sequential under the VAT IR. The guideline requires it to be "sequential"; the XML only requires presence. Use a gap-free sequence per tenant, per EGS unit and per document series.
- **UUID (KSA-1):** globally unique per document, generated by the EGS. It is sent in the API body too.
- **ICV (Invoice Counter Value, KSA-16):** a **monotonic counter per EGS unit** covering *all* document types. It must never be reset: "Resetting the invoice counter should not be a function available" [P S3 §6.8].
- **PIH (Previous Invoice Hash, KSA-13):** the invoice hash of the previous document issued **by the same EGS unit**. This forms one chain per unit [P S3 §6.7]. "The solution unit must not generate more than one sequence". Separate units such as branches or POS terminals each keep their own chain and do not coordinate.
- **Initial PIH** for the first document of a unit is `NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==` [P S1 BR-KSA-26]. **Careful:** this value is `base64(ASCII hex string of SHA256("0"))`, *not* `base64(raw digest)`. Verified in this session: `sha256("0")` = `5feceb66…57e9`, and base64 of that 64-char hex text gives exactly the value above. Regular invoice hashes are base64 of the raw 32-byte digest, which is 44 chars.
- **Invalid documents:** "A solution might at times generate invalid E-invoice or associated Note documents. Such documents should remain and not be deleted to preserve the continuity of the E-invoice document order" [P S3 §6.7]. **Never roll back ICV or PIH after a rejection.** The rejected document stays in the chain. Fix the issue with a new document; for a rejected simplified invoice, issue a new corrected invoice.

**DB design implication:** keep a table `egs_units(tenant_id, id, last_icv, last_invoice_hash, …)`. Allocate the ICV and PIH with `SELECT … FOR UPDATE` in the same transaction that writes the append-only `e_invoices` row. The counter never decreases.

### 1.5 Currency and rounding

- The invoice currency may be any currency, but `TaxCurrencyCode` must be `SAR`. When the invoice currency is not SAR, a second `cac:TaxTotal` with **only** `cbc:TaxAmount currencyID="SAR"` (BT-111) is needed [P S1 §9.1, BR-53, BR-KSA-EN16931-09]. A restaurant invoices in SAR, so both TaxTotals are in SAR (see §2a for why there are two).
- **Rounding is half-up.** Document totals are rounded to 2 decimals. "Rounding shall be done on the final calculation results not on any intermediate results". The VAT category tax amount is rounded at document level, **not** as a sum of rounded line VAT amounts [P S1 §10].
- **Validation formulas:**
  - BR-CO-10: sum of line nets = BT-106.
  - BR-CO-13: BT-109 = BT-106 − BT-107 + BT-108.
  - BR-CO-14: BT-110 = Σ BT-117.
  - BR-CO-15: BT-112 = BT-109 + BT-110.
  - BR-CO-16: BT-115 = BT-112 − BT-113 + BT-114.
  - BR-CO-17: BT-117 = round2(BT-116 × BT-119 / 100).
  - BR-KSA-50: line VAT = line net × rate / 100.
  - BR-KSA-51: `RoundingAmount` = line net + line VAT.
  - BR-KSA-EN16931-11: line net = qty × (net price / base qty) + line charges − line allowances [P S1].

### 1.6 VAT categories and exemption reason codes

Categories come from UNCL 5305 [P S1 §11.2.4]:

| Code | Meaning | Rate | Exemption reason code (BT-121) + text (BT-120) required? |
|---|---|---|---|
| `S` | Standard rate (التوريدات الخاضعة للضريبة) | 15 | **must not** have them (BR-S-10) |
| `Z` | Zero rated (التوريدات الخاضعة لنسبة الصفر) | 0 | **required** (BR-KSA-69, CL-04/05, BR-KSA-83) |
| `E` | Exempt (التوريدات المعفاة) | 0 | **required** (BR-KSA-23) |
| `O` | Out of scope / not subject to VAT (التوريدات غير الخاضعة للضريبة) | 0 or omitted | **required** (BR-KSA-24) |

The exemption reason code/text list follows [P S1 §11.2.4]. Arabic was extracted from the PDF and re-ordered from its visual order. Use the texts **verbatim**, because BR-KSA-CL-05 / BR-KSA-83 require a text from this list.

| Category | Code | English text | Arabic text |
|---|---|---|---|
| E | `VATEX-SA-29` | Financial services mentioned in Article 29 of the VAT Regulations | الخدمات المالية |
| E | `VATEX-SA-29-7` | Life insurance services mentioned in Article 29 of the VAT Regulations | عقد تأمين على الحياة |
| E | `VATEX-SA-30` | Real estate transactions mentioned in Article 30 of the VAT Regulations | التوريدات العقارية المعفاة من الضريبة |
| Z | `VATEX-SA-32` | Export of goods | صادرات السلع من المملكة |
| Z | `VATEX-SA-33` | Export of services | صادرات الخدمات من المملكة |
| Z | `VATEX-SA-34-1` | The international transport of Goods | النقل الدولي للسلع |
| Z | `VATEX-SA-34-2` | international transport of passengers | النقل الدولي للركاب |
| Z | `VATEX-SA-34-3` | services directly connected and incidental to a Supply of international passenger transport | الخدمات المرتبطة مباشرة أو عرضياً بتوريد النقل الدولي للركاب |
| Z | `VATEX-SA-34-4` | Supply of a qualifying means of transport | توريد وسائل النقل المؤهلة |
| Z | `VATEX-SA-34-5` | Any services relating to Goods or passenger transportation, as defined in article twenty five of these Regulations | الخدمات ذات الصلة بنقل السلع أو الركاب، وفقاً للتعريف الوارد بالمادة الخامسة والعشرين من اللائحة التنفيذية لنظام ضريبة القيمة المضافة |
| Z | `VATEX-SA-35` | Medicines and medical equipment | الأدوية والمعدات الطبية |
| Z | `VATEX-SA-36` | Qualifying metals | المعادن المؤهلة |
| Z | `VATEX-SA-EDU` | Private education to citizen | الخدمات التعليمية الخاصة للمواطنين |
| Z | `VATEX-SA-HEA` | Private healthcare to citizen | الخدمات الصحية الخاصة للمواطنين |
| Z | `VATEX-SA-MLTRY` | supply of qualified military goods | توريد السلع العسكرية المؤهلة |
| O | `VATEX-SA-OOS` | Reason is free text, to be provided by the taxpayer on case to case basis. | السبب يتم تزويده من قبل المكلف على أساس كل حالة على حدة |

Notes on the list:
- The PDF misspells the Arabic of 34-5 as "ضريبة القيامة". The corrected spelling is used above. Compare with the SDK's Schematron code list if strict matching becomes an issue.
- The table placement of EDU/HEA is ambiguous in the PDF layout. VAT law zero-rates private healthcare and education to citizens (the state bears the VAT). Treat them as `Z` as shown; **verify against the SDK Schematron.**

**Restaurant reality:** almost everything is `S` 15%. Keep the full list anyway, because accounting needs `E`/`O` for items such as tips, deposits or government fees passed through.

### 1.7 Credit and debit notes

- `InvoiceTypeCode` is 381 (credit) or 383 (debit), with the same subtype as the original (`01…` or `02…`).
- **BillingReference is mandatory** (BR-KSA-56):
  ```xml
  <cac:BillingReference>
      <cac:InvoiceDocumentReference>
          <cbc:ID>SME00001</cbc:ID>   <!-- original invoice number (BT-1 of original) -->
      </cac:InvoiceDocumentReference>
  </cac:BillingReference>
  ```
  The guideline says a note "should refer to the sequential number of the original e-Invoice and the date of supply" [P S3 §4.x]. `cac:InvoiceDocumentReference` may also carry `cbc:IssueDate` (BR-KSA-F-01 lists that path), which is recommended.
- **The reason is mandatory** (BR-KSA-17) in `cac:PaymentMeans/cbc:InstructionNote` (KSA-10). The data dictionary shows it as *Required* on the printed simplified note. Saleh7 [OSS S12] uses the value `CANCELLATION_OR_TERMINATION`. The data dictionary example is "Cancellation or suspension of the supplies…" Free text is accepted; offer a pick-list in Arabic/English. A `cac:PaymentMeans` with `PaymentMeansCode` must be present to carry the note.
- **"Cancelling" an invoice is only possible through a credit note** [P S3 §6.7].
- **Timing:** the 2025 VAT IR amendments say credit and debit notes must be issued within **15 days from the end of the month** in which the event occurred. The amendments were effective 2025-10-15 [S S18].
- Do **not** issue a credit note for goodwill credits unrelated to a supply [P S3 example].

### 1.8 Time limits, storage, retention, language

- **Standard documents:** cleared before sharing. **Simplified documents:** reported within 24 hours [P S3].
- **ZATCA offline guidance** [K]: when ZATCA is unavailable, clearance may fall back. The 303 response means clearance is currently disabled and the standard document must be sent to the reporting API [P S5]. Queue and retry reporting; never skip.
- **Storage** [P S3 §6.9]:
  - Storage may be on-prem in KSA or in the cloud. Cloud storage must be "accessible through a direct link that can be made available to the Authority".
  - The system must allow export to an external archive.
  - The file naming convention is `VATNumber_YYYYMMDDTHHMMSS_InvoiceNumber.xml`, where non-alphanumerics in the invoice number become `-`. Example: `3xxxxxxxxx1xxx3_20210526T132400_2021-05-26-23555.xml` [P S1 §14].
- **Retention:**
  - VAT IR Art. 66: invoices, books, records and accounting documents for **≥ 6 years** from the end of the tax period. Capital-asset records are kept for the adjustment period + 5 years, i.e. 11 years for normal capital assets and 15 for real estate [S S17; the 6/10-year adjustment periods are K].
  - Law of Commercial Books Art. 8: books, correspondence and documents for **≥ 10 years** [P S13].
  - **Use 10 years** as the product default.
- **Language:**
  - Tax invoices and records must be in **Arabic**, optionally with other languages as translation [S S17; P S3: "human readable format can be presented provided that it is in Arabic (in addition to any other language)"].
  - Commercial books must be in Arabic [P S13 Art. 1].
  - The XML may contain bilingual values such as `الرياض | Riyadh`, as the SDK samples do [K].

### 1.9 Prohibited functions and anti-tampering

These come from [P S3 §6.7–6.8], decoded from the PDF.

| Function (must NOT exist) | Enforced from | Requirement |
|---|---|---|
| Anonymous access | Phase 1 | Unique login + password or biometrics |
| Operating with a default password | Phase 1 | Force a password reset on first use |
| Absence of user session management | Phase 1 | Log all user activities from login onward |
| Alteration or deletion of generated e-invoices or notes | Phase 1 | Cancel only through a credit note |
| Log modification or deletion | Phase 1 | System logs are immutable |
| Generation with inaccurate timestamps | Phase 1 | No time or date manipulation that yields false info |
| Non-sequential log generation | Phase 1 | Log entries are time-stamped and linked with the previous hash so their order cannot change |
| Invoice counter reset | Phase 1 | No reset feature; counter access is protected from users |
| More than one invoice sequence per unit at a time | Phase 1 | One PIH chain per unit |
| Export of stamping keys | Phase 2 | Private key is non-exportable (software or hardware key vault) |
| Time changes | Phase 2 | Users cannot change the system date/time |

Also required:
- Least-privilege, role-based access to functions.
- Encrypted and protected storage.
- The ability to "save Electronic Invoices and Electronic Notes and archive them in XML format without an Internet connection".

**Mapping to Munassiq:**
- `e_invoices` and `audit_log` are already append-only.
- The ICV/PIH counters must be updatable only by a SECURITY DEFINER function or trigger, never by the app role directly.
- The server clock is the source of time; never accept a client timestamp for `IssueDate`/`IssueTime`.
- Keep private keys encrypted at rest with a KMS-held key, and never return them through the API.

### 1.10 Glossary

- **Cryptographic stamp:** "an electronic stamp which is created via cryptographic algorithms to ensure authenticity of origin and integrity of content" [P S3]. It is an XAdES-B-B **enveloped** signature using ECDSA P-256k1/SHA-256 [P S2 §2.2.1 #10–16], placed in `ext:UBLExtensions`.
- **CSID (Cryptographic Stamp Identifier):** the X.509 certificate issued by ZATCA's CA to one EGS unit. A **Compliance CSID (CCSID)** is used only to run compliance checks. A **Production CSID (PCSID)** is used for real reporting and clearance.
- **EGS unit:** one invoice-generating unit with its own key, certificate, ICV and PIH chain, e.g. a POS terminal, a branch or a cloud "device" [P S3].
- **ICV, PIH, UUID:** see §1.4.

---

## 2. Phase 2 technical details

### 2a. UBL 2.1 structure

Namespaces on the root element, with the exact prefixes the SDK uses [P S1 §12, OSS S11/S12]:

```
xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"
```

Inside the signature: `sig` = `urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2`, `sac` = `urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2`, `sbc` = `urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2`, `ds` = `http://www.w3.org/2000/09/xmldsig#` and `xades` = `http://uri.etsi.org/01903/v1.3.2#`.

**Element order matters.** Syntax validation checks the UBL 2.1 sequence [P S1 §4]. The order below is the UBL 2.1 XSD order restricted to the elements KSA uses [K from the UBL 2.1 XSD, consistent with S4's order, which follows the XML order]:

```
Invoice
  ext:UBLExtensions                         (signature; see 2c)
  cbc:ProfileID                             reporting:1.0
  cbc:ID                                    invoice number
  cbc:UUID
  cbc:IssueDate
  cbc:IssueTime
  cbc:InvoiceTypeCode @name                 388|383|381|386, name=NNPNESB
  cbc:Note (0..n, @languageID optional)
  cbc:DocumentCurrencyCode                  SAR
  cbc:TaxCurrencyCode                       SAR
  cac:OrderReference/cbc:ID                 (optional)
  cac:BillingReference/cac:InvoiceDocumentReference/cbc:ID   (381/383)
  cac:ContractDocumentReference/cbc:ID      (optional)
  cac:AdditionalDocumentReference  ICV      (cbc:ID=ICV, cbc:UUID=<counter>)
  cac:AdditionalDocumentReference  PIH      (cbc:ID=PIH, cac:Attachment/cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain")
  cac:AdditionalDocumentReference  QR       (cbc:ID=QR,  same attachment structure)
  cac:Signature                             (cbc:ID urn:oasis:names:specification:ubl:signature:Invoice,
                                             cbc:SignatureMethod urn:oasis:names:specification:ubl:dsig:enveloped:xades)
  cac:AccountingSupplierParty/cac:Party
      cac:PartyIdentification/cbc:ID @schemeID
      cac:PostalAddress
          cbc:StreetName
          cbc:AdditionalStreetName          (opt)
          cbc:BuildingNumber                4 digits
          cbc:PlotIdentification            additional number, 4 digits (opt)
          cbc:CitySubdivisionName           district
          cbc:CityName
          cbc:PostalZone                    5 digits
          cbc:CountrySubentity              region (opt)
          cac:Country/cbc:IdentificationCode  SA
      cac:PartyTaxScheme
          cbc:CompanyID                     VAT 15 digits
          cac:TaxScheme/cbc:ID              VAT
      cac:PartyLegalEntity/cbc:RegistrationName
  cac:AccountingCustomerParty/cac:Party     (same structure; may be <cac:Party/>-less on simplified; see pitfall F-03)
  cac:Delivery
      cbc:ActualDeliveryDate                supply date (mandatory on standard 388)
      cbc:LatestDeliveryDate                supply end date (opt)
  cac:PaymentMeans
      cbc:PaymentMeansCode                  10|30|42|48|1
      cbc:InstructionNote                   reason (381/383)
      cac:PayeeFinancialAccount/cbc:ID      IBAN (opt)
  cac:AllowanceCharge (0..n, document level)
      cbc:ChargeIndicator                   false (allowance) / true (charge)
      cbc:AllowanceChargeReasonCode         UNTDID 5189 (allowance) / 7161 (charge) — charges MUST have code (BR-KSA-19)
      cbc:AllowanceChargeReason             text (charges MUST have text, BR-KSA-21)
      cbc:MultiplierFactorNumeric           % (opt; if present BaseAmount required)
      cbc:Amount @currencyID
      cbc:BaseAmount @currencyID            (opt)
      cac:TaxCategory
          cbc:ID                            S|Z|E|O
          cbc:Percent                       15
          cac:TaxScheme/cbc:ID              VAT
  cac:TaxTotal                              #1: ONLY cbc:TaxAmount (in SAR = BT-111)
      cbc:TaxAmount @currencyID="SAR"
  cac:TaxTotal                              #2: with breakdown (BT-110 + BG-23)
      cbc:TaxAmount @currencyID
      cac:TaxSubtotal (one per category+rate)
          cbc:TaxableAmount
          cbc:TaxAmount
          cac:TaxCategory
              cbc:ID
              cbc:Percent
              cbc:TaxExemptionReasonCode    (Z/E/O only)
              cbc:TaxExemptionReason        (Z/E/O only)
              cac:TaxScheme/cbc:ID          VAT
  cac:LegalMonetaryTotal
      cbc:LineExtensionAmount               BT-106 Σ line nets
      cbc:TaxExclusiveAmount                BT-109
      cbc:TaxInclusiveAmount                BT-112
      cbc:AllowanceTotalAmount              BT-107 (opt)
      cbc:ChargeTotalAmount                 BT-108 (opt)
      cbc:PrepaidAmount                     BT-113 (opt)
      cbc:PayableRoundingAmount             BT-114 (opt)
      cbc:PayableAmount                     BT-115
  cac:InvoiceLine (1..n)
      cbc:ID
      cbc:InvoicedQuantity @unitCode        (PCE recommended; UN/ECE Rec 20)
      cbc:LineExtensionAmount               BT-131 net, 2 decimals
      cac:DocumentReference                 (prepayment lines only, 386)
      cac:AllowanceCharge                   (line-level allowance/charge, opt)
      cac:TaxTotal
          cbc:TaxAmount                     KSA-11 line VAT
          cbc:RoundingAmount                KSA-12 line net + VAT
      cac:Item
          cbc:Name
          cac:SellersItemIdentification/cbc:ID  (opt)
          cac:ClassifiedTaxCategory
              cbc:ID                        S|Z|E|O
              cbc:Percent                   15.00
              cac:TaxScheme/cbc:ID          VAT
      cac:Price
          cbc:PriceAmount                   BT-146 net unit price (may have >2 decimals)
          cbc:BaseQuantity @unitCode        (opt, >0)
          cac:AllowanceCharge               price discount: ChargeIndicator, AllowanceChargeReason, Amount (BT-147), BaseAmount (BT-148 gross)
```

**Why two `cac:TaxTotal` elements:**
- BR-KSA-EN16931-08: "Only one tax total (BG-22) with tax subtotals must be provided".
- BR-KSA-EN16931-09: "Only one tax total (BG-22) without tax subtotals must be provided when tax currency code is provided".
- `TaxCurrencyCode` is always present (BR-KSA-68), so you **always emit two TaxTotal elements**: one with only `TaxAmount`, one with the subtotals [P S1]. The SDK samples put the one without subtotals first [K; S12 examples generate the same]. QR tag 5 reads the value from the first `cac:TaxTotal/cbc:TaxAmount` [OSS S11, S12].

**`@name` (KSA-2) = `NNPNESB`** [P S1 BR-KSA-06]:
- pos 1–2 `NN`: `01` = tax invoice (standard), `02` = simplified.
- pos 3 `P`: third-party invoice (0/1).
- pos 4 `N`: nominal supply (0/1).
- pos 5 `E`: export (0/1). Only allowed on `01`. Self-billing is not allowed on exports (BR-KSA-07).
- pos 6 `S`: summary invoice (0/1).
- pos 7 `B`: self-billed (0/1).
- For simplified documents only P, N and S may be 1 (BR-KSA-31).
- Normal restaurant sale: `0200000`. B2B catering invoice: `0100000`.

**Line price discount:** a price-level `cac:AllowanceCharge` inside `cac:Price` with `ChargeIndicator=false`. Then BT-146 = BT-148 (gross, `BaseAmount`) − BT-147 (`Amount`) (BR-KSA-EN16931-07). Note that the SDK sample includes a price AllowanceCharge with `ChargeIndicator` **true** and amount 0.00. BR-KSA-EN16931-06 says "Charge on price level (BG-29) is allowed. The value of Indicator should be 'True'". **CONFLICT/ambiguity** with the data dictionary, which says price allowance indicator "Fixed value false". **Recommendation:** do not emit a price-level AllowanceCharge at all. Put discounts in the net price, or use a document-level allowance.

#### Minimal simplified invoice (signed layout, placeholders in `{{…}}`)

This follows the SDK sample structure [K], cross-checked with S11 and S12.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
    <ext:UBLExtensions>
        <ext:UBLExtension>
            <ext:ExtensionURI>urn:oasis:names:specification:ubl:dsig:enveloped:xades</ext:ExtensionURI>
            <ext:ExtensionContent>
                <sig:UBLDocumentSignatures xmlns:sig="urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2" xmlns:sac="urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2" xmlns:sbc="urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2">
                    <sac:SignatureInformation>
                        <cbc:ID>urn:oasis:names:specification:ubl:signature:1</cbc:ID>
                        <sbc:ReferencedSignatureID>urn:oasis:names:specification:ubl:signature:Invoice</sbc:ReferencedSignatureID>
                        <ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Id="signature">
                            <!-- see §2c for full content -->
                        </ds:Signature>
                    </sac:SignatureInformation>
                </sig:UBLDocumentSignatures>
            </ext:ExtensionContent>
        </ext:UBLExtension>
    </ext:UBLExtensions>
    <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
    <cbc:ID>POS1-2026-000123</cbc:ID>
    <cbc:UUID>3cf5ee18-ee25-44ea-a444-2c37ba7f28be</cbc:UUID>
    <cbc:IssueDate>2026-09-25</cbc:IssueDate>
    <cbc:IssueTime>13:45:10</cbc:IssueTime>
    <cbc:InvoiceTypeCode name="0200000">388</cbc:InvoiceTypeCode>
    <cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode>
    <cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>
    <cac:AdditionalDocumentReference>
        <cbc:ID>ICV</cbc:ID>
        <cbc:UUID>123</cbc:UUID>
    </cac:AdditionalDocumentReference>
    <cac:AdditionalDocumentReference>
        <cbc:ID>PIH</cbc:ID>
        <cac:Attachment>
            <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">{{PREVIOUS_INVOICE_HASH}}</cbc:EmbeddedDocumentBinaryObject>
        </cac:Attachment>
    </cac:AdditionalDocumentReference>
    <cac:AdditionalDocumentReference>
        <cbc:ID>QR</cbc:ID>
        <cac:Attachment>
            <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">{{QR_BASE64}}</cbc:EmbeddedDocumentBinaryObject>
        </cac:Attachment>
    </cac:AdditionalDocumentReference>
    <cac:Signature>
        <cbc:ID>urn:oasis:names:specification:ubl:signature:Invoice</cbc:ID>
        <cbc:SignatureMethod>urn:oasis:names:specification:ubl:dsig:enveloped:xades</cbc:SignatureMethod>
    </cac:Signature>
    <cac:AccountingSupplierParty>
        <cac:Party>
            <cac:PartyIdentification>
                <cbc:ID schemeID="CRN">1010010000</cbc:ID>
            </cac:PartyIdentification>
            <cac:PostalAddress>
                <cbc:StreetName>الأمير سلطان | Prince Sultan</cbc:StreetName>
                <cbc:BuildingNumber>2322</cbc:BuildingNumber>
                <cbc:PlotIdentification>1234</cbc:PlotIdentification>
                <cbc:CitySubdivisionName>المربع | Al-Murabba</cbc:CitySubdivisionName>
                <cbc:CityName>الرياض | Riyadh</cbc:CityName>
                <cbc:PostalZone>12345</cbc:PostalZone>
                <cac:Country>
                    <cbc:IdentificationCode>SA</cbc:IdentificationCode>
                </cac:Country>
            </cac:PostalAddress>
            <cac:PartyTaxScheme>
                <cbc:CompanyID>399999999900003</cbc:CompanyID>
                <cac:TaxScheme>
                    <cbc:ID>VAT</cbc:ID>
                </cac:TaxScheme>
            </cac:PartyTaxScheme>
            <cac:PartyLegalEntity>
                <cbc:RegistrationName>مطعم المثال | Example Restaurant</cbc:RegistrationName>
            </cac:PartyLegalEntity>
        </cac:Party>
    </cac:AccountingSupplierParty>
    <cac:AccountingCustomerParty>
        <cac:Party>
            <cac:PartyLegalEntity>
                <cbc:RegistrationName>عميل نقدي</cbc:RegistrationName>
            </cac:PartyLegalEntity>
        </cac:Party>
    </cac:AccountingCustomerParty>
    <cac:PaymentMeans>
        <cbc:PaymentMeansCode>10</cbc:PaymentMeansCode>
    </cac:PaymentMeans>
    <cac:TaxTotal>
        <cbc:TaxAmount currencyID="SAR">6.30</cbc:TaxAmount>
    </cac:TaxTotal>
    <cac:TaxTotal>
        <cbc:TaxAmount currencyID="SAR">6.30</cbc:TaxAmount>
        <cac:TaxSubtotal>
            <cbc:TaxableAmount currencyID="SAR">42.00</cbc:TaxableAmount>
            <cbc:TaxAmount currencyID="SAR">6.30</cbc:TaxAmount>
            <cac:TaxCategory>
                <cbc:ID>S</cbc:ID>
                <cbc:Percent>15.00</cbc:Percent>
                <cac:TaxScheme>
                    <cbc:ID>VAT</cbc:ID>
                </cac:TaxScheme>
            </cac:TaxCategory>
        </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:LegalMonetaryTotal>
        <cbc:LineExtensionAmount currencyID="SAR">42.00</cbc:LineExtensionAmount>
        <cbc:TaxExclusiveAmount currencyID="SAR">42.00</cbc:TaxExclusiveAmount>
        <cbc:TaxInclusiveAmount currencyID="SAR">48.30</cbc:TaxInclusiveAmount>
        <cbc:AllowanceTotalAmount currencyID="SAR">0.00</cbc:AllowanceTotalAmount>
        <cbc:PrepaidAmount currencyID="SAR">0.00</cbc:PrepaidAmount>
        <cbc:PayableAmount currencyID="SAR">48.30</cbc:PayableAmount>
    </cac:LegalMonetaryTotal>
    <cac:InvoiceLine>
        <cbc:ID>1</cbc:ID>
        <cbc:InvoicedQuantity unitCode="PCE">2.000000</cbc:InvoicedQuantity>
        <cbc:LineExtensionAmount currencyID="SAR">40.00</cbc:LineExtensionAmount>
        <cac:TaxTotal>
            <cbc:TaxAmount currencyID="SAR">6.00</cbc:TaxAmount>
            <cbc:RoundingAmount currencyID="SAR">46.00</cbc:RoundingAmount>
        </cac:TaxTotal>
        <cac:Item>
            <cbc:Name>برجر لحم | Beef Burger</cbc:Name>
            <cac:ClassifiedTaxCategory>
                <cbc:ID>S</cbc:ID>
                <cbc:Percent>15.00</cbc:Percent>
                <cac:TaxScheme>
                    <cbc:ID>VAT</cbc:ID>
                </cac:TaxScheme>
            </cac:ClassifiedTaxCategory>
        </cac:Item>
        <cac:Price>
            <cbc:PriceAmount currencyID="SAR">20.00</cbc:PriceAmount>
        </cac:Price>
    </cac:InvoiceLine>
    <cac:InvoiceLine>
        <cbc:ID>2</cbc:ID>
        <cbc:InvoicedQuantity unitCode="PCE">1.000000</cbc:InvoicedQuantity>
        <cbc:LineExtensionAmount currencyID="SAR">2.00</cbc:LineExtensionAmount>
        <cac:TaxTotal>
            <cbc:TaxAmount currencyID="SAR">0.30</cbc:TaxAmount>
            <cbc:RoundingAmount currencyID="SAR">2.30</cbc:RoundingAmount>
        </cac:TaxTotal>
        <cac:Item>
            <cbc:Name>ماء | Water</cbc:Name>
            <cac:ClassifiedTaxCategory>
                <cbc:ID>S</cbc:ID>
                <cbc:Percent>15.00</cbc:Percent>
                <cac:TaxScheme>
                    <cbc:ID>VAT</cbc:ID>
                </cac:TaxScheme>
            </cac:ClassifiedTaxCategory>
        </cac:Item>
        <cac:Price>
            <cbc:PriceAmount currencyID="SAR">2.00</cbc:PriceAmount>
        </cac:Price>
    </cac:InvoiceLine>
</Invoice>
```

Notes on the simplified sample:
- `AccountingCustomerParty` may be empty on simplified invoices. wes4m emits `<cac:AccountingCustomerParty></cac:AccountingCustomerParty>` [OSS S11]. BR-KSA-F-03 ("must not contain empty elements") has an XPath of `//*[not(*) and not(normalize-space())]`, so an element with no children and no text violates it. The safe choice is either to omit it or to fill it with a buyer name. **Test with the SDK.** In recent SDKs an empty customer party is tolerated, possibly with a warning [K].
- Simplified documents are signed by the EGS. The QR has 9 tags.

#### Standard invoice: differences from the simplified sample

```xml
    <cbc:InvoiceTypeCode name="0100000">388</cbc:InvoiceTypeCode>
    ...
    <cac:AccountingCustomerParty>
        <cac:Party>
            <cac:PostalAddress>
                <cbc:StreetName>صلاح الدين | Salah Al-Din</cbc:StreetName>
                <cbc:BuildingNumber>1111</cbc:BuildingNumber>
                <cbc:CitySubdivisionName>المروج | Al-Murooj</cbc:CitySubdivisionName>
                <cbc:CityName>الرياض | Riyadh</cbc:CityName>
                <cbc:PostalZone>12222</cbc:PostalZone>
                <cac:Country>
                    <cbc:IdentificationCode>SA</cbc:IdentificationCode>
                </cac:Country>
            </cac:PostalAddress>
            <cac:PartyTaxScheme>
                <cbc:CompanyID>399999999800003</cbc:CompanyID>
                <cac:TaxScheme>
                    <cbc:ID>VAT</cbc:ID>
                </cac:TaxScheme>
            </cac:PartyTaxScheme>
            <cac:PartyLegalEntity>
                <cbc:RegistrationName>شركة العميل المحدودة | Customer Co. LTD</cbc:RegistrationName>
            </cac:PartyLegalEntity>
        </cac:Party>
    </cac:AccountingCustomerParty>
    <cac:Delivery>
        <cbc:ActualDeliveryDate>2026-09-25</cbc:ActualDeliveryDate>
    </cac:Delivery>
    <cac:PaymentMeans>
        <cbc:PaymentMeansCode>30</cbc:PaymentMeansCode>
    </cac:PaymentMeans>
```

- If the buyer has no VAT number, add `<cac:PartyIdentification><cbc:ID schemeID="CRN">…</cbc:ID></cac:PartyIdentification>` as the first child of `cac:Party` (BR-KSA-81).
- Line `TaxTotal/TaxAmount` and `RoundingAmount` are **mandatory** on standard documents (BR-KSA-52/53).
- The EGS also signs standard invoices in the SDK samples. ZATCA's clearance then adds its own stamp and QR and returns `clearedInvoice`. **Store and share the cleared XML, and print the QR from it.**

#### Credit note: differences

```xml
    <cbc:InvoiceTypeCode name="0200000">381</cbc:InvoiceTypeCode>
    <cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode>
    <cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>
    <cac:BillingReference>
        <cac:InvoiceDocumentReference>
            <cbc:ID>POS1-2026-000123</cbc:ID>
        </cac:InvoiceDocumentReference>
    </cac:BillingReference>
    <cac:AdditionalDocumentReference> ICV ... </cac:AdditionalDocumentReference>
    ...
    <cac:PaymentMeans>
        <cbc:PaymentMeansCode>10</cbc:PaymentMeansCode>
        <cbc:InstructionNote>إرجاع طلب | Order returned</cbc:InstructionNote>
    </cac:PaymentMeans>
```

All amounts in a credit note are **positive**.

### 2b. Invoice hash

**Spec** [P S1 BR-KSA-26; P S2 §2.3.3 and §3]:
1. Remove `Invoice/ext:UBLExtensions`.
2. Remove `Invoice/cac:AdditionalDocumentReference` where `cbc:ID = 'QR'`.
3. Remove `Invoice/cac:Signature`.
4. Canonicalize with **C14N 1.1** (`http://www.w3.org/2006/12/xml-c14n11`).
5. SHA-256 the result to raw bytes.
6. Base64 the bytes (44 chars). This value goes in the first `ds:Reference/ds:DigestValue`, in the API body `invoiceHash`, in QR tag 6, and becomes the next document's PIH.

The signature transforms list the same XPaths:
- `not(//ancestor-or-self::ext:UBLExtensions)`
- `not(//ancestor-or-self::cac:Signature)`
- `not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])`
- then C14N 1.1.

**How the open-source implementations do it:**
- **S12 PHP (production tested):** loads the XML into a DOM, removes the three nodes, calls `DOMNode::C14N(false,false)` (inclusive C14N 1.0 without comments), then runs `hash('sha256', …, true)` and `base64_encode`.
- **S11 TS:** deletes the nodes, canonicalizes with `xmldsigjs XmlCanonicalizer(false,false)`, and then applies a string hack: `replace("<cbc:ProfileID>", "\n    <cbc:ProfileID>")` and `replace("<cac:AccountingSupplierParty>", "\n    \n    <cac:AccountingSupplierParty>")`. The comment reads "A dumb workaround … without it the hash is incorrect".

**Whitespace pitfalls:**
- **What the hack shows:** ZATCA's validator removes the elements, but the **whitespace text nodes around them stay** (the SDK does the removal with XSLT). The canonical form therefore contains the indentation that surrounded the removed elements. The hash is recomputed by ZATCA from the bytes you send, so the only thing that matters is this: *after removing those 3 elements from the exact document you submit, keeping all other whitespace text nodes, C14N must reproduce the bytes you hashed.*
- **Robust approach:** build the **final** document layout first, with the UBLExtensions, QR and cac:Signature elements present and dummy content allowed. Compute the hash by removing those elements from that exact string with a DOM or XSLT that preserves whitespace text nodes, then canonicalize. Then fill in the real signature and QR. Removed content never affects the hash, so filling them in afterwards is safe.
- **Do not pretty-print after hashing.** Do not let the XML library reformat. Submit exactly the bytes you hashed, with the removed parts reinserted.
- **Do not include the XML declaration** in the hash input. C14N drops it anyway.
- **Line endings:** XML parsers normalize CRLF to LF. Generate LF only. Saleh7 had to add a "Windows CRLF fix".
- **C14N 1.0 vs 1.1:** for UBL invoices without `xml:id`/`xml:base`, inclusive C14N 1.0 output is identical to C14N 1.1. Saleh7 uses 1.0 and passes production. In Node, `xml-crypto`'s `c14n` (inclusive, `http://www.w3.org/TR/2001/REC-xml-c14n-20010315`) or `xmldsigjs` can be used. C14N expands `<a/>` to `<a></a>`, sorts attributes, and keeps namespace declarations on the root.
- A **409** response means the hash was already submitted (see §2f). Any change to the invoice means a new hash.

### 2c. Digital signature (XAdES) — exact recipe

Confirmed identically in S11 (TS) and S12 (PHP, aligned with Java SDK R3.4.8).

1. **What is signed:** the **raw 32-byte invoice hash** (base64-decoded), signed with **ECDSA secp256k1 + SHA-256**, i.e. Java `SHA256withECDSA` or Node `crypto.sign('sha256', hashBytes, privateKey)`. The signature is effectively over `SHA256(hashBytes)` (double hash). Output is the **DER-encoded** ECDSA signature (~70–72 bytes), base64-encoded, and goes in `ds:SignatureValue`.
   - S11: `createSign('sha256').update(Buffer.from(invoice_hash,'base64')).sign(key)`.
   - S12: `$privateKey->sign($invoiceHashBinary)`.
   - **Quirk:** this is **not** standard XMLDSig, where one would sign the canonical `ds:SignedInfo`. ZATCA signs the invoice hash itself.
2. **Certificate hash (CertDigest):** `base64( hex( SHA256( <certificate base64 text, no PEM headers, no newlines> ) ) )`. It is the SHA-256 **of the base64 string**, not of the DER bytes, rendered as a **lowercase hex string**, and that hex string is then base64-encoded (88 chars) [OSS S11 `getCertificateHash`, S12 `getCertHash`]. Worked example: the ZATCA simulation test certificate in S12's example gives `ZDMwMmI0MTE1NzVjOTU2NTk4YzVlODhhYmI0ODU2NDUyNTU2YTVhYjhhMDFmN2FjYjk1YTA2OWQ0NjY2MjQ4NQ==` (computed in this session).
3. **X509IssuerName:** take the issuer RDNs in reverse (most specific first), joined with `", "`. Example (simulation CA): `CN=PRZEINVOICESCA4-CA, DC=extgazt, DC=gov, DC=local`. In Node: `new X509Certificate(pem).issuer.split('\n').reverse().join(', ')` (verified: Node returns `DC=local\nDC=gov\nDC=extgazt\nCN=PRZEINVOICESCA4-CA`).
4. **X509SerialNumber:** the certificate serial as a **decimal** string, e.g. `BigInt('0x'+x509.serialNumber).toString(10)`. Example: hex `1100003803C5F74023B3FC5C5F000100003803` = `379112742831380471835263969587287663520528387`.
5. **SigningTime:** `YYYY-MM-DDTHH:mm:ss`.
   - S12 (prod-tested 2026) uses local server time **without** `Z`.
   - S11 appends `Z`.
   - **CONFLICT.** Both are reported to work. Use **UTC with no fractional seconds, without `Z`** to match the Java SDK sample style (`2022-09-15T00:41:21`) [K]. Whatever you choose, the value in the hashed SignedProperties string and in the embedded XML **must be byte-identical**.
6. **SignedProperties digest:** `base64( hex( SHA256( signedPropertiesString ) ) )`, again base64 of the hex text [OSS S11, S12]. The string must be **exactly** as below, including indentation, `\n` line endings and an `xmlns:ds` declaration on each `ds:*` element. This is how the validator serializes the node: a non-canonical DOM serialization with self-closing empty elements. This is the template from S12 (prod-tested). The first line is not indented; each subsequent line has the exact number of leading spaces shown (32/36/40/44/48):

```
<xades:SignedProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Id="xadesSignedProperties">
                                <xades:SignedSignatureProperties>
                                    <xades:SigningTime>{SIGNING_TIME}</xades:SigningTime>
                                    <xades:SigningCertificate>
                                        <xades:Cert>
                                            <xades:CertDigest>
                                                <ds:DigestMethod xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
                                                <ds:DigestValue xmlns:ds="http://www.w3.org/2000/09/xmldsig#">{CERT_HASH}</ds:DigestValue>
                                            </xades:CertDigest>
                                            <xades:IssuerSerial>
                                                <ds:X509IssuerName xmlns:ds="http://www.w3.org/2000/09/xmldsig#">{ISSUER}</ds:X509IssuerName>
                                                <ds:X509SerialNumber xmlns:ds="http://www.w3.org/2000/09/xmldsig#">{SERIAL_DECIMAL}</ds:X509SerialNumber>
                                            </xades:IssuerSerial>
                                        </xades:Cert>
                                    </xades:SigningCertificate>
                                </xades:SignedSignatureProperties>
                            </xades:SignedProperties>
```

   - The **embedded** copy inside `ds:Object/xades:QualifyingProperties` must have the **same inner whitespace**. It is written *without* the per-element `xmlns:ds`, because `ds` is declared on `ds:Signature`, and it may use `<ds:DigestMethod …></ds:DigestMethod>` (S11 does this).
   - wes4m's `signedPropertiesIndentationFix` exists solely to make the embedded copy's indentation equal the hashed string.
   - **Strong recommendation:** port S12's `InvoiceSignatureBuilder` output byte-for-byte, and add a CI test that runs the ZATCA SDK `fatoora -validate` on the output (see pitfalls).

7. **Full `ext:UBLExtension` block** [P S2 §2.3.3, OSS S11/S12]. The second Reference `Type` differs between sources:
   - S2 text says `http://uri.etsi.org/01903#SignedProperties`.
   - S11 and S12 (and the SDK samples [K]) use `http://www.w3.org/2000/09/xmldsig#SignatureProperties`.
   - **CONFLICT.** Use the value the SDK and working implementations use: `http://www.w3.org/2000/09/xmldsig#SignatureProperties`.

```xml
<ext:UBLExtension>
    <ext:ExtensionURI>urn:oasis:names:specification:ubl:dsig:enveloped:xades</ext:ExtensionURI>
    <ext:ExtensionContent>
        <sig:UBLDocumentSignatures xmlns:sig="urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2" xmlns:sac="urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2" xmlns:sbc="urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2">
            <sac:SignatureInformation>
                <cbc:ID>urn:oasis:names:specification:ubl:signature:1</cbc:ID>
                <sbc:ReferencedSignatureID>urn:oasis:names:specification:ubl:signature:Invoice</sbc:ReferencedSignatureID>
                <ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Id="signature">
                    <ds:SignedInfo>
                        <ds:CanonicalizationMethod Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>
                        <ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256"/>
                        <ds:Reference Id="invoiceSignedData" URI="">
                            <ds:Transforms>
                                <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
                                    <ds:XPath>not(//ancestor-or-self::ext:UBLExtensions)</ds:XPath>
                                </ds:Transform>
                                <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
                                    <ds:XPath>not(//ancestor-or-self::cac:Signature)</ds:XPath>
                                </ds:Transform>
                                <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
                                    <ds:XPath>not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])</ds:XPath>
                                </ds:Transform>
                                <ds:Transform Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>
                            </ds:Transforms>
                            <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
                            <ds:DigestValue>{INVOICE_HASH_BASE64}</ds:DigestValue>
                        </ds:Reference>
                        <ds:Reference Type="http://www.w3.org/2000/09/xmldsig#SignatureProperties" URI="#xadesSignedProperties">
                            <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
                            <ds:DigestValue>{SIGNED_PROPERTIES_HASH}</ds:DigestValue>
                        </ds:Reference>
                    </ds:SignedInfo>
                    <ds:SignatureValue>{SIGNATURE_BASE64_DER}</ds:SignatureValue>
                    <ds:KeyInfo>
                        <ds:X509Data>
                            <ds:X509Certificate>{CERT_BASE64_NO_HEADERS}</ds:X509Certificate>
                        </ds:X509Data>
                    </ds:KeyInfo>
                    <ds:Object>
                        <xades:QualifyingProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Target="signature">
                            {SIGNED_PROPERTIES — same whitespace as the hashed string, without per-element xmlns:ds}
                        </xades:QualifyingProperties>
                    </ds:Object>
                </ds:Signature>
            </sac:SignatureInformation>
        </sig:UBLDocumentSignatures>
    </ext:ExtensionContent>
</ext:UBLExtension>
```

`cac:Signature` in the invoice body must have `cbc:ID` = `urn:oasis:names:specification:ubl:signature:Invoice` and `cbc:SignatureMethod` = `urn:oasis:names:specification:ubl:dsig:enveloped:xades` (BR-KSA-28/29/30).

S2 also lists `SigningCertificateV2`, `SignaturePolicyIdentifier` and `SignedDataObjectProperties`, i.e. full XAdES. **No implementation emits those.** The SDK uses `SigningCertificate` (v1) only. Follow the SDK.

**Order of operations (Node sketch):**

```ts
import { createHash, sign, X509Certificate, createPrivateKey } from 'node:crypto';

const b64 = (b: Buffer) => b.toString('base64');
const sha256 = (d: string | Buffer) => createHash('sha256').update(d).digest();

// 1. xmlFinalLayout: final document incl. placeholder UBLExtensions, QR ADR and cac:Signature
const hashBytes = sha256(c14n(removeUblExtSignatureQr(xmlFinalLayout)));   // must preserve whitespace text nodes
const invoiceHash = b64(hashBytes);                                           // 44 chars
// 2. signature over raw hash bytes (DER)
const signatureValue = b64(sign('sha256', hashBytes, createPrivateKey(privateKeyPem)));
// 3. certificate facts
const certB64 = pemBody(certPem);                          // no headers, no newlines
const certHash = b64(Buffer.from(sha256(certB64).toString('hex'), 'utf8'));
const x509 = new X509Certificate(certPem);
const issuer = x509.issuer.split('\n').reverse().join(', ');
const serial = BigInt('0x' + x509.serialNumber).toString(10);
// 4. signed properties
const sp = SIGNED_PROPS_TEMPLATE.replace(...);             // exact template above
const spHash = b64(Buffer.from(sha256(sp).toString('hex'), 'utf8'));
// 5. QR (see 2d), 6. inject UBLExtensions + QR, 7. submit { invoiceHash, uuid, invoice: b64(Buffer.from(xml,'utf8')) }
```

**Node crypto facts verified in this session (Node 24):**
- `generateKeyPairSync('ec', {namedCurve:'secp256k1'})` works.
- `crypto.sign('sha256', …)` returns a DER signature of about 72 bytes.
- SPKI DER of a secp256k1 key is **88 bytes**.
- The private key exports as `-----BEGIN EC PRIVATE KEY-----` with `type:'sec1'`.
- **WebCrypto does NOT support secp256k1** (`Unrecognized namedCurve` for `K-256`). Libraries built on WebCrypto (e.g. `@peculiar/x509` with its default engine) cannot sign the CSR with this curve.
- **Options for the CSR:**
  - (a) shell out to `openssl req` (what the SDK, wes4m and Microsoft do). This adds an OpenSSL dependency on the server.
  - (b) build the PKCS#10 DER with an ASN.1 library (`asn1js`/`pkijs`, or hand-rolled) and sign the `CertificationRequestInfo` DER with `crypto.sign('sha256', tbs, key)`.
  - Option (b) keeps everything in-process and is recommended for a multi-tenant SaaS.

### 2d. QR code (Phase 2)

TLV, base64 [P S2 §4.1]:

| Tag | Value | Encoding used by working implementations |
|---|---|---|
| 1 | Seller name (BT-27) | UTF-8 text |
| 2 | Seller VAT number (BT-31) | UTF-8 text |
| 3 | Invoice timestamp, ISO 8601, e.g. `2022-02-21T12:13:57Z` | S12 uses `IssueDate + 'T' + IssueTime + ('Z' if missing)`. S11 uses `YYYY-MM-DDTHH:mm:ssZ`. **Use `${IssueDate}T${IssueTime}` exactly as in the XML** and append `Z` only if you store time in UTC [K]. |
| 4 | Invoice total incl. VAT (BT-112 `TaxInclusiveAmount`) | UTF-8 text, as in the XML (e.g. `48.30`) |
| 5 | VAT total (BT-110) | UTF-8 text from the **first** `cac:TaxTotal/cbc:TaxAmount` |
| 6 | Invoice hash | S11 and S12 put the **base64 hash string** as UTF-8 text (44 bytes). **CONFLICT:** S2 says "for tag 6 Length: length of hash (SHA256) is 32 bytes; Value: the byte array". The prod-tested implementations use the 44-char base64 text; follow them. |
| 7 | ECDSA signature | the **base64 signature string** as text (S11: `Buffer.from(digital_signature)`; S12: `new InvoiceDigitalSignature($signatureValue)`) |
| 8 | ECDSA public key | **raw DER bytes of SubjectPublicKeyInfo** (88 bytes for secp256k1). S12: `base64_decode(PKCS8 public key PEM body)`. S11: `publicKeyRaw` of the cert. |
| 9 | Signature of the certificate by ZATCA's CA | **raw DER bytes** of the cert's `signatureValue` BIT STRING content, i.e. the leading unused-bits `0x00` byte stripped (S12 `substr(signature,1)`). **Simplified invoices and their notes only.** |

- **Tag and length are 1 byte each.** Length is the **UTF-8 byte length** (Arabic names take 2 bytes per char). S2 says "The length shall be stored in one byte", so every value must be ≤ 255 bytes. S11 and S12 both use single-byte lengths.
- **Total size:** S2 says "encoded in Base64 format with up to 700 characters". With 9 tags a typical payload is about 450–480 bytes, or about 600–640 base64 chars. A long Arabic seller name can push it over 700. Validate at onboarding (e.g. warn if `RegistrationName` exceeds ~60 Arabic chars).
- **Phase 1 QR:** tags 1–5 only.
- **Standard invoices:** ZATCA generates the QR during clearance. Print the one in `clearedInvoice`.
- **Printed invoice requirement:** the QR must be printed on simplified invoices and credit/debit notes [P S3].

### 2e. Onboarding: keys and CSR

**Key:** EC `secp256k1`. OpenSSL: `openssl ecparam -name secp256k1 -genkey -noout -out privatekey.pem` [S S10, OSS S11]. S2 requires FIPS 186 generation and non-exportable storage [P S2 §2.2.1 #6].

**CSR subject (DN):** the order in DER is **C, OU, O, CN**, which matches both the SDK and the issued certificate. It was verified by decoding a ZATCA-issued certificate in this session: `C=SA, O=Maximum Speed Tech Supply LTD, OU=Riyadh Branch, CN=TST-886431145-399999999900003`. S12 builds the DN in C → OU → O → CN order.

| Field | Content [P S2 Table 1, S5, S S10] |
|---|---|
| `C` | 2-letter ISO country, `SA` |
| `OU` | Branch name. **For VAT groups (11th digit of the VAT number = `1`), the 10-digit TIN of the group member.** |
| `O` | Taxpayer name (free text; Arabic allowed, S12 sets `utf8 = yes`) |
| `CN` | Unique name or asset-tracking number of the unit, chosen by the taxpayer. In practice the SDK sample uses `TST-886431145-399999999900003`. Microsoft's sample puts `PREZATCA-Code-Signing` in CN for simulation, which looks like confusion; use a unique device name. |

**Extensions:**

| OID / openssl name | Value |
|---|---|
| `1.3.6.1.4.1.311.20.2` (Microsoft certificate template name) | `ZATCA-Code-Signing` (production, `/core`), `PREZATCA-Code-Signing` (simulation), `TSTZATCA-Code-Signing` (developer-portal sandbox) |
| `subjectAltName = dirName:dir_sect` containing: | |
| `SN` → **OID 2.5.4.4 (surname)**. OpenSSL's `SN` short name is *surname*, not serialNumber 2.5.4.5, and this was verified in the issued certificate. | EGS serial `1-<SolutionProviderName>|2-<ModelOrVersion>|3-<SerialNumber>`, e.g. `1-TST|2-TST|3-ed22f1d8-e6a2-1118-9b58-d9a8f11e445f`. Must match the regex `1-...|2-...|3-...`. The SDK forbids `=` [OSS S12]. |
| `UID` → OID 0.9.2342.19200300.100.1.1 | VAT number (15 digits, 3…3). **CONFLICT:** S2 Table 1 says "organizationIdentifier (2.5.4.97)", but the SDK, the certificate and every implementation use `UID`. **Use UID.** |
| `title` → 2.5.4.12 | Functionality map, 4 digits `TSCZ`: T = standard, S = simplified, C/Z = future use (S5 calls them buyer QR / self-billing QR). Examples: `1000` standard only, `0100` simplified only, `1100` both. Cannot be all zeros. |
| `registeredAddress` → 2.5.4.26 | Branch location. The "Short Address" of the Saudi National Address is preferred (e.g. `RRRD2929`), or a website for e-commerce. |
| `businessCategory` → 2.5.4.15 | Industry, e.g. `Restaurants` / `مطاعم` |

S12 validates `CN`, `O`, `OU`, the location and the industry against the forbidden character set `!@#$%&*_<=` [OSS S12, "SDK validation"].

**Template-name encoding:** `ASN1:PRINTABLESTRING:` per ZATCA [P S6, S7, S10]. wes4m and S12 use `ASN1:UTF8String:`, and those work too [OSS]. Prefer **PRINTABLESTRING** as documented.

**OpenSSL config, ZATCA/Microsoft style** [S S10; P S6]:

```ini
oid_section = OIDs
[OIDs]
certificateTemplateName = 1.3.6.1.4.1.311.20.2

[req]
default_bits = 2048
prompt = no
default_md = sha256
req_extensions = req_ext
distinguished_name = dn
utf8 = yes
string_mask = utf8only

[dn]
C = SA
OU = Riyadh Branch
O = Example Restaurant Co
CN = MUNASSIQ-POS1-399999999900003

[req_ext]
certificateTemplateName = ASN1:PRINTABLESTRING:ZATCA-Code-Signing
subjectAltName = dirName:alt_names

[alt_names]
SN = 1-Munassiq|2-1.0|3-6f1c2a9e-5b0d-4d3e-9d7a-2c1e0f9b8a11
UID = 399999999900003
title = 0100
registeredAddress = RRRD2929
businessCategory = Restaurants
```

Command: `openssl req -new -sha256 -key privatekey.pem -config csr.cnf -out taxpayer.csr`. The API body carries **base64 of the whole PEM text, including the BEGIN/END lines**, with no newlines in the base64 [S10: `openssl base64 -in taxpayer.csr` with newlines stripped; S11 and S12: `base64_encode($csrPem)`].

ZATCA SDK CLI equivalent [K]: the `csr-config.properties` keys are `csr.common.name`, `csr.serial.number`, `csr.organization.identifier`, `csr.organization.unit.name`, `csr.organization.name`, `csr.country.name`, `csr.invoice.type`, `csr.location.address` and `csr.industry.business.category`. Run `fatoora -csr -csrConfig <file> [-pem] [-nonprod|-sim]`.

**Certificate validity:** "Certificate generation process date/time + Up to 60 months" [P S2]. The simulation certificate decoded in this session is valid for 5 years (2024-01-11 → 2029-01-09). **Read `notAfter` and schedule renewal reminders.** The portal also sends reminders [P S2 §2.1.2].

### 2f. APIs

**Base URLs** [P S6, S7; OSS S12]:

| Environment | Base URL | CSR template | OTP source |
|---|---|---|---|
| Developer portal sandbox | `https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal` | `TSTZATCA-Code-Signing` | Fixed test OTP. Widely used values are **`123345`** (and `111222`) [K; S10's example shows `-otp 123345`]. |
| Simulation | `https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation` | `PREZATCA-Code-Signing` | Real OTP from the **Fatoora Simulation Portal**, a separate environment with separate devices [P S6] |
| Production | `https://gw-fatoora.zatca.gov.sa/e-invoicing/core` | `ZATCA-Code-Signing` | Real OTP from **fatoora.zatca.gov.sa** |

The old host `gw-apic-gov.gazt.gov.sa` that wes4m uses is **obsolete**.

**Common headers** [P S5 §3; OSS S12; S10]:

```
Accept: application/json
Content-Type: application/json
Accept-Version: V2              ("V2 is currently the only valid version" [P S5])
Accept-Language: en | ar        (language of validation messages)
Authorization: Basic base64(<binarySecurityToken>:<secret>)   (all calls except POST /compliance)
```

The Basic username is the **`binarySecurityToken` string exactly as returned**. That token is base64 of the certificate's base64 text. S12 builds it as `base64(base64(certB64) + ':' + secret)`, where `certB64 = base64_decode(binarySecurityToken)`, so the result is the same. The password is `secret`. The Security standard describes this as "OAuth 2 Basic Authentication … Client ID will be the digital certificate … Secret" [P S2 §5].

| # | Method and path | Extra headers | Auth | Body | Success response |
|---|---|---|---|---|---|
| 1 | `POST /compliance` | `OTP: <6 digits>` | none | `{"csr":"<base64 of CSR PEM>"}` | `{"requestID": 1234567890123, "dispositionMessage":"ISSUED", "binarySecurityToken":"TUlJQ…", "secret":"…", "errors": null}` (field names from S10/S11/S12; `dispositionMessage` [K]) |
| 2 | `POST /compliance/invoices` | — | CCSID | `{"invoiceHash":"…","uuid":"…","invoice":"<base64 XML>"}` | `{"validationResults":{…},"reportingStatus":"REPORTED"|null,"clearanceStatus":"CLEARED"|null, …}` [OSS S12 `ComplianceInvoiceResponse`]. Other fields such as `qrSellertStatus`/`qrBuyertStatus` exist [K]. |
| 3 | `POST /production/csids` | — | CCSID | `{"compliance_request_id":"<requestID from #1>"}` | same shape as #1 (PCSID) |
| 4 | `PATCH /production/csids` (renewal) | `OTP: <otp>` | **current PCSID** | `{"csr":"<base64 of new CSR PEM>"}` | same shape as #1 [OSS S12 `renewProductionCertificate`; S6 "Request or renew a production CSID"] |
| 5 | `POST /invoices/reporting/single` | `Clearance-Status: 0` | PCSID | `{"invoiceHash","uuid","invoice"}` | `{"validationResults":{…},"reportingStatus":"REPORTED"}` |
| 6 | `POST /invoices/clearance/single` | `Clearance-Status: 1` | PCSID | `{"invoiceHash","uuid","invoice"}` | `{"validationResults":{…},"clearanceStatus":"CLEARED","clearedInvoice":"<base64 XML stamped by ZATCA>"}` |

`validationResults` shape [OSS S12; P S8]:

```json
{
  "infoMessages":    [{"type":"INFO","code":"XSD_ZATCA_VALID","category":"XSD validation","message":"Complied with UBL 2.1 standards in line with ZATCA specifications","status":"PASS"}],
  "warningMessages": [{"type":"WARNING","code":"BR-KSA-…","category":"KSA","message":"…","status":"WARNING"}],
  "errorMessages":   [{"type":"ERROR","code":"…","category":"…","message":"…","status":"ERROR"}],
  "status": "PASS" | "WARNING" | "ERROR"
}
```

`infoMessages` may be an object rather than an array in some responses [K]. Parse defensively.

**HTTP status meanings** [P S5 FAQ; P S8]:

| Code | Meaning | Action |
|---|---|---|
| 200 | Accepted / cleared, no warnings | mark reported/cleared |
| 202 | Accepted **with warnings** | Treat as success. Store the warnings and show them to the tenant; the document stays valid. |
| 303 | Clearance currently disabled | Resubmit the standard document through the **reporting** endpoint (clearance endpoint only) |
| 400 | Invalid request or validation **errors**. `reportingStatus: NOT_REPORTED` / `clearanceStatus: NOT_CLEARED` | The document is rejected. **Do not delete it; do not reuse ICV/PIH.** Issue a corrected new document; for simplified, report the next one normally. Surface the errors. |
| 401 | Bad or expired credentials (CSID/secret) | Re-onboard or renew |
| 406 | Wrong or missing `Accept-Version` [K] | Config bug |
| 409 | **Duplicate:** "Invoice Hash Previously Submitted". Body: `{"validationResults":{"errorMessages":[{"type":"ERROR","code":"Invoice-Errors","category":"Duplicate-Invoice","message":"Invoice Hash Previously Submitted","status":"ERROR"}],"status":"ERROR"},"reportingStatus":"NOT_REPORTED"}`. ZATCA staff: "if you receive a 409 error it means that the invoice corresponding to the invoice hash has been either cleared or reported with a 200 or 202 response code previously" [P S8]. The body may be empty. | Treat as already accepted, which makes retries idempotent |
| 429 | Rate limit [K] | back off |
| 500 / 503 | Server error | Retry with backoff. The 24h reporting window still applies. |

**Compliance checks before a production CSID** [S S10; P S5 note]: the CCSID must pass compliance checks for **every document type implied by `title`**:
- `1000` → 3 documents: standard invoice, standard debit note, standard credit note.
- `0100` → 3 documents: simplified invoice, simplified debit note, simplified credit note.
- `1100` → all **6**.

S12's automated script uses ICV 1 and the initial PIH for all six and passes. Calling `/production/csids` before the checks are complete returns an error [P S5].

**Recommended title for Munassiq:**
- Use `0100` if the product only issues simplified documents. This means fewer checks, and the unit then cannot issue standard invoices.
- Use `1100` if catering/B2B tax invoices are needed. Decide per tenant.

### 2g. Who does what (taxpayer vs solution provider)

**Taxpayer (the restaurant) in the FATOORA portal** [P S6]:
1. Log in at https://fatoora.zatca.gov.sa/ with **ERAD credentials** (TIN or registered email + password). These are different from the Developer Portal credentials.
2. Click **"Onboard new solution unit/device"** and choose the number of OTPs to generate (one per EGS unit). The OTPs are shown and can be downloaded. **Each OTP is valid for 1 hour.**
3. Enter the OTP into the EGS within 1 hour. **This step is in Munassiq:** the tenant pastes the OTP, and the server generates the key and CSR, calls `/compliance`, runs the compliance checks, then calls `/production/csids`.
4. **Renewal:** "Renewing Existing Cryptographic Stamp Identifier (CSID)" produces a new OTP (1 h). The EGS then calls `PATCH /production/csids` with the OTP and a new CSR, authenticated with the current PCSID.
5. **"View list of solutions and devices":** filter, search and **revoke** (irreversible; re-onboarding creates a new device). Revoke when a key is compromised, a device is decommissioned, or the data is wrong [P S2 §2.1.3].
6. **"E-invoicing statistics":** the last 12 months of accepted / with-warnings / rejected documents, with downloadable error details.
7. The simulation portal is a toggle in the same portal. It is an **independent** environment for end-to-end testing and must not be used for load testing [P S6].
8. Before using the stamp, the taxpayer agrees to the subscriber terms [P S2 §2.2.1 #3]. The taxpayer is solely responsible for the accuracy of the certificate data [P S2 #5].

**Solution provider (Munassiq)** [P S22]:
- **No mandatory certification or registration.** ZATCA's Solution Providers Directory is a voluntary, non-binding list: "not considered as an approval by ZATCA". Taxpayers may use any compliant solution, even an unlisted one.
- Optionally apply to be listed.
- Use the **Developer Portal** (separate registration) for the sandbox, Swagger docs, the SDK and the Compliance & Enablement Toolbox.
- Must provide compliant XML, signing, QR, secure key storage and the anti-tamper functions (§1.9).

**Product flow:**
- The onboarding UI asks the tenant for: OTP; branch or unit name (→ OU); legal name (→ O; pre-filled from the tenant); VAT number (→ UID); CRN; National Address short code (→ registeredAddress); industry.
- The server generates everything else. The SN is `1-Munassiq|2-<appVersion>|3-<egsUnitUuid>`.
- Keep the **environment per EGS unit** (`sandbox|simulation|production`). Never mix certificates across environments.

---

## 3. KSA VAT return

**Boxes** (ZATCA portal "VAT return" form). The numbering follows [S S19] and matches the common knowledge of the form [K]. Each of boxes 1–5 and 7–11 has three columns: **Amount (SAR)**, **Adjustment (SAR)** and **VAT amount (SAR)**.

| Box | English | Arabic (portal) [K] | Notes |
|---|---|---|---|
| 1 | Standard rated sales | المبيعات الخاضعة للنسبة الأساسية | 15%. Restaurant sales go here, net of credit notes via the Adjustment column. |
| 2 | Sales to citizens (private healthcare / private education / first residential house) | المبيعات للمواطنين (الخدمات الصحية الخاصة/التعليم الأهلي الخاص/المسكن الأول) | VAT borne by the state. The "first house" part was for real estate and has since changed [K]. |
| 3 | Zero rated domestic sales | المبيعات المحلية الخاضعة للنسبة الصفرية | |
| 4 | Exports | الصادرات | |
| 5 | Exempt sales | المبيعات المعفاة | |
| 6 | Total sales | إجمالي المبيعات | Σ 1–5 |
| 7 | Standard rated domestic purchases | المشتريات الخاضعة للنسبة الأساسية | input VAT |
| 8 | Imports subject to VAT paid at customs | الاستيرادات الخاضعة لضريبة القيمة المضافة بالنسبة الأساسية والتي تدفع في الجمارك | |
| 9 | Imports subject to VAT accounted for through reverse charge mechanism | الاستيرادات الخاضعة للضريبة بالنسبة الأساسية والتي تطبق عليها آلية الاحتساب العكسي | Imported services, e.g. foreign SaaS or ads. Output and input both. |
| 10 | Zero rated purchases | المشتريات الخاضعة للنسبة الصفرية | |
| 11 | Exempt purchases | المشتريات المعفاة | |
| 12 | Total purchases | إجمالي المشتريات | Σ 7–11 |
| 13 | Total VAT due for current period | إجمالي ضريبة القيمة المضافة المستحقة عن الفترة الضريبية الحالية | 6 − 12 (VAT columns) |
| 14 | Corrections from previous period (between ±SAR 5,000) | تصحيحات من الفترات السابقة (بين ±5,000 ريال) | Larger errors need a voluntary disclosure / return amendment [K] |
| 15 | VAT credit carried forward from previous period(s) | ضريبة القيمة المضافة المرحّلة من الفترة/الفترات السابقة | |
| 16 | Net VAT due (or claimed) | صافي الضريبة المستحقة (أو المستردة) | 13 + 14 − 15 |

**Filing rules:**
- **Frequency:** monthly if annual taxable supplies exceed **SAR 40 million**; otherwise **quarterly** (a taxpayer can opt for monthly) [S S19; K].
- **Deadline:** file and pay by the **last day of the month following the end of the tax period** [S S19].
- **Rate:** **15%** since **1 July 2020** (5% before) [K; well known].
- **Registration thresholds:** mandatory above SAR 375,000; voluntary above SAR 187,500 [K].

**Penalties** (VAT Law Arts. 40–45) [K]. **Verify current amounts;** ZATCA has run repeated penalty-waiver initiatives.

| Violation | Penalty |
|---|---|
| Failure to register | SAR 10,000 |
| Incorrect return or amendment causing a tax difference | 50% of the difference |
| Late filing | 5%–25% of the tax due |
| Late payment | 5% of unpaid tax for each month or part of a month |
| Tax evasion | 1–3× the tax |
| Failure to keep records | up to SAR 50,000 |
| Other violations | up to SAR 50,000 |

E-invoicing violations follow a separate graduated schedule, starting with a warning and then fines. Look up the current ZATCA e-invoicing violations table.

**Product mapping:**
- VAT-return boxes come from `e_invoices` (sales, split by category S/Z/E/O and export flag) and from purchase documents (input VAT, import VAT, reverse charge).
- Credit and debit notes post to the **Adjustment** column of the period in which they were issued [K].
- Tag every tax line with `vat_box` at posting time, so the return is a `GROUP BY` and not a reinterpretation.

---

## 4. Accounting requirements in KSA for SMEs

- **Framework:**
  - Since 2018, unlisted entities apply IFRS as endorsed by SOCPA, with the option or default of **IFRS for SMEs as endorsed by SOCPA** [S S21].
  - SOCPA adds Shariah-related disclosures. It also requires the Liquidation Basis standard instead of IFRS for SMEs when the entity is not a going concern [S S21].
  - Listed companies and banks use full IFRS.
  - For a restaurant SME, design reports for **IFRS for SMEs**: statement of financial position, P&L/OCI, changes in equity, cash flows and notes.
  - Companies file annual financial statements through the Ministry of Commerce **Qawaem** platform [K].
- **Law of Commercial Books** (M/61, 1409H, last updated 2022) [P S13]:
  - **Art. 1:** books must be in **Arabic** and kept well. The minimum is **original journal (اليومية الأصلية), inventory book (دفتر الجرد) and general ledger (دفتر الأستاذ العام)**. There is an exemption when capital ≤ SAR 100,000.
  - **Art. 2:** electronic storage is allowed. The Implementing Regulations set rules "that ensure the accuracy and security of electronically stored data" [K]: prevent unauthorized modification, keep backups, and make the data retrievable and printable.
  - **Art. 3:** transactions are entered **daily** in detail. Personal withdrawals may be entered monthly in total. Subsidiary journals are allowed, with totals posted to the original journal regularly.
  - **Art. 4:** at fiscal year-end, record the goods on hand (the inventory count) and a copy of the balance sheet in the inventory book.
  - **Art. 5:** post from the journal to the ledger so each account's balance is available at any time.
  - **Art. 6:** keep copies of all correspondence and documents.
  - **Art. 7:** the form is set by the Ministry of Commerce and pages are numbered. For software this means sequential entry numbers.
  - **Art. 8:** keep for **≥ 10 years**.
  - **Art. 12:** fine of SAR 5,000–50,000.
  - **New law:** a replacement "Law of Commercial Books" has been in public consultation [K, unverified]. **Check laws.boe.gov.sa before release.** The retention rule is unlikely to fall below 10 years.
- **Zakat:**
  - Businesses owned by Saudi or GCC nationals pay zakat at **2.5% of the zakat base** (adjusted net assets / equity-based). For a Gregorian financial year the rate is prorated: **2.5% × 365/354 ≈ 2.5776%**. Sources quote 2.5775%–2.578% [K].
  - Non-GCC ownership shares pay **20% income tax** instead [K].
  - The new **Zakat Implementing Regulation (MR 1007, 29 Feb 2024)** applies to financial years starting on or after **1 Jan 2024** [S S20]. It introduced a new base methodology: sources of funds less deductible investments, plus special sector rules.
  - The return and payment are due **within 120 days of financial year-end** [S S20].
  - For software: support a **zakat provision** journal (Dr Zakat expense / Cr Zakat provision) and the base calculation report as an *estimate*. Do not claim to be a zakat filing tool.
- **Fiscal year:** usually the Gregorian calendar year. The CR/articles can define another year. Support any 12-month year and periods (monthly).
- **Software implications:**
  1. **Immutable posted journals.** Corrections are made by reversing entries, never by edits or deletes (this also satisfies e-invoicing §1.9).
  2. **Gap-free journal numbers** per fiscal year (Art. 7).
  3. **Period locking:** a closed month rejects postings unless reopened by an authorized role, with an audit-log entry. A closed year is hard-locked after the closing entry.
  4. **Daily posting** (Art. 3). POS summaries may post one daily journal per branch with details in subsidiary journals (sales detail tables).
  5. **Year-end inventory count** stored as an immutable document linked to the closing entry (Art. 4).
  6. **Audit trail** of who, what and when, append-only and hash-chained, as the e-invoicing log requirement also says.
  7. **Arabic** account names and reports (English optional).
  8. **Export** of books (journal, ledger, trial balance) in a readable format, for 10-year retention and for ZATCA/MoC audits.

---

## 5. Recommended chart of accounts for a Saudi restaurant

This design is original, based on common Saudi practice [K]. It uses a 4-level tree: 1-digit class, 2-digit group, 4-digit account, 6-digit sub-account. Only leaf accounts (6-digit) accept postings. Account types are A (asset), L (liability), Q (equity), R (revenue), X (expense) and C (contra).

```
1 الأصول (Assets)
 11 الأصول المتداولة (Current assets)
  1101 النقد وما في حكمه (Cash & cash equivalents)
   110101 الصندوق الرئيسي (Main cash)
   110102 صناديق نقاط البيع / الكاشير (POS cash drawers)  ← one per branch/drawer via dimension
   110103 العهد النقدية (Petty cash / custodies)
   110110 البنك – الحساب الجاري (Bank – current account)
   110120 نقد في الطريق / إيداعات قيد التحصيل (Cash in transit)
  1102 الذمم المدينة (Receivables)
   110201 مستحقات بطاقات مدى/الائتمان (Card settlements receivable – acquirer/gateway)
   110202 مستحقات تطبيقات التوصيل – هنقرستيشن (Delivery app receivable – HungerStation)
   110203 مستحقات تطبيقات التوصيل – جاهز (– Jahez)
   110204 مستحقات تطبيقات التوصيل – كيتا (– Keeta)
   110205 مستحقات تطبيقات التوصيل – مرسول وأخرى (– Mrsool/others)
   110206 مستحقات بوابات الدفع الإلكتروني (Payment gateway receivable – Moyasar/HyperPay/Tap)
   110210 عملاء آجل (Trade receivables – catering/corporate)
   110290 مخصص خسائر ائتمانية متوقعة (Allowance for expected credit losses) [C]
  1103 المخزون (Inventory)
   110301 مخزون مواد غذائية خام (Raw food)
   110302 مخزون مشروبات (Beverages)
   110303 مخزون مواد تغليف وتعبئة (Packaging & disposables)
   110304 مخزون مواد نظافة ومستهلكات (Cleaning & consumables)
   110305 مخزون أصناف محضّرة / نصف مصنعة (Prepared / semi-finished items)
   110390 مخزون في الطريق (Goods in transit)
  1104 مصروفات مدفوعة مقدماً وأرصدة مدينة أخرى (Prepayments & other receivables)
   110401 إيجار مدفوع مقدماً (Prepaid rent)
   110402 تأمين طبي مدفوع مقدماً (Prepaid medical insurance)
   110403 رسوم حكومية مدفوعة مقدماً (Prepaid gov. fees – iqama, work permits, Balady licence)
   110404 سلف الموظفين (Employee advances)
   110405 دفعات مقدمة للموردين (Advances to suppliers)
   110406 تأمينات مستردة (Refundable deposits)
  1105 ضريبة القيمة المضافة – مدخلات (VAT input)
   110501 ضريبة القيمة المضافة على المشتريات – مدخلات (Input VAT – domestic purchases)  → box 7
   110502 ضريبة القيمة المضافة على الواردات (Input VAT – imports paid at customs) → box 8
   110503 ضريبة القيمة المضافة – احتساب عكسي مدخلات (Input VAT – reverse charge) → box 9
 12 الأصول غير المتداولة (Non-current assets)
  1201 الممتلكات والمعدات (PP&E)
   120101 معدات المطبخ (Kitchen equipment)
   120102 الأثاث والتجهيزات (Furniture & fixtures)
   120103 تحسينات على مبانٍ مستأجرة (Leasehold improvements / fit-out)
   120104 أجهزة حاسب ونقاط بيع (Computers & POS hardware)
   120105 سيارات (Vehicles)
  1202 مجمع الإهلاك (Accumulated depreciation) [C]
   120201 … one per 1201 sub-account
  1203 أصول حق الاستخدام (Right-of-use assets – leases)
   120301 حق استخدام – مباني مستأجرة (ROU – premises)
   120302 مجمع استهلاك حق الاستخدام [C]
  1204 الأصول غير الملموسة (Intangibles)
   120401 برمجيات وتراخيص (Software & licences)
   120402 مجمع الإطفاء [C]

2 الخصوم (Liabilities)
 21 الخصوم المتداولة (Current liabilities)
  2101 الذمم الدائنة (Payables)
   210101 موردون – مواد غذائية (Trade payables – food suppliers)
   210102 موردون – أخرى (Other suppliers)
   210103 مصروفات مستحقة (Accrued expenses – utilities etc.)
  2102 ضريبة القيمة المضافة (VAT)
   210201 ضريبة القيمة المضافة المستحقة – مخرجات (Output VAT) → box 1
   210202 ضريبة القيمة المضافة – احتساب عكسي مخرجات (Output VAT – reverse charge) → box 9
   210203 تسوية ضريبة القيمة المضافة / المستحق للهيئة (VAT settlement / payable to ZATCA)
  2103 مستحقات الموظفين (Employee liabilities)
   210301 رواتب مستحقة (Salaries payable)
   210302 التأمينات الاجتماعية المستحقة (GOSI payable)
   210303 إجازات وتذاكر مستحقة (Accrued leave & tickets)
  2104 الزكاة وضريبة الدخل (Zakat & income tax)
   210401 مخصص الزكاة (Zakat provision)
   210402 ضريبة الدخل المستحقة (Income tax payable – non-GCC share)
  2105 إيرادات مؤجلة ودفعات مقدمة من العملاء (Deferred revenue / customer advances)
   210501 دفعات مقدمة من العملاء (Customer advances / catering deposits)
   210502 بطاقات هدايا وأرصدة محافظ العملاء (Gift cards & wallet balances)
   210503 نقاط ولاء غير مستردة (Loyalty points liability)
  2106 التزامات الإيجار – الجزء المتداول (Lease liabilities – current)
   210601 التزامات عقود الإيجار – متداول
  2107 أرصدة دائنة أخرى (Other payables)
   210701 إكراميات مستحقة للموظفين (Tips payable to staff)
   210702 تأمينات مستلمة (Deposits received)
 22 الخصوم غير المتداولة (Non-current liabilities)
  2201 مخصص مكافأة نهاية الخدمة (End-of-service benefits provision)
   220101 مكافأة نهاية الخدمة (EOSB)
  2202 التزامات الإيجار – غير متداول (Lease liabilities – non-current)
   220201 التزامات عقود الإيجار – غير متداول
  2203 قروض طويلة الأجل (Long-term loans)
   220301 قروض بنكية / تمويل منشآت

3 حقوق الملكية (Equity)
 31 رأس المال والاحتياطيات
  3101 رأس المال (Capital)
   310101 رأس المال المدفوع
  3102 الاحتياطي النظامي (Statutory reserve – companies)  [K: optional since 2023 Companies Law]
   310201 الاحتياطي النظامي
  3103 جاري المالك / الشركاء (Owner/partners current account)
   310301 جاري المالك – مسحوبات (Owner drawings)
  3104 الأرباح المبقاة (Retained earnings)
   310401 أرباح (خسائر) مبقاة
   310402 أرباح (خسائر) العام – ملخص الدخل (Current year P&L – closing account)

4 الإيرادات (Revenue)
 41 إيرادات النشاط (Operating revenue)
  4101 مبيعات المطعم (Restaurant sales)
   410101 مبيعات صالة (Dine-in)
   410102 مبيعات سفري (Takeaway)
   410103 مبيعات توصيل – تطبيقات (Delivery-app sales)  ← dimension: app
   410104 مبيعات توصيل – مباشر (Own delivery)
   410105 مبيعات تموين ومناسبات (Catering)
   410106 رسوم توصيل محصلة (Delivery fees charged)
  4102 مردودات ومسموحات وخصومات المبيعات (Sales returns & discounts) [C]
   410201 مردودات المبيعات (إشعارات دائنة) (Sales returns – credit notes)
   410202 خصومات ممنوحة (Discounts given)
 42 إيرادات أخرى (Other income)
  4201 إيرادات متنوعة
   420101 أرباح بيع أصول
   420102 إيرادات دعم/حوافز (e.g., HRDF subsidies)
   420103 فروقات جرد بالزيادة (Stock count surplus) [or credit to COGS; see §6]

5 المصروفات (Expenses)
 51 تكلفة المبيعات (Cost of sales)
  5101 تكلفة المواد (Cost of materials)
   510101 تكلفة مواد غذائية مستهلكة (Food cost)
   510102 تكلفة مشروبات (Beverage cost)
   510103 تكلفة مواد تغليف (Packaging cost)
  5102 الهدر والفاقد (Waste & losses)
   510201 هدر مواد غذائية (Food waste)
   510202 عجز جرد (Stock count shortage)
   510203 وجبات موظفين (Staff meals)  [K: may be non-deductible/deemed supply issues]
  5103 عمولات تطبيقات التوصيل (Delivery-app commissions)
   510301 عمولات هنقرستيشن … (per app or with dimension)
  5104 عمولات بطاقات وبوابات الدفع (Card/gateway fees – mada/Visa/MC)
   510401 عمولات مدى والبطاقات
 52 مصروفات تشغيلية (Operating expenses)
  5201 الرواتب وما في حكمها (Payroll)
   520101 رواتب أساسية (Basic salaries)
   520102 بدل سكن (Housing allowance)
   520103 بدل نقل (Transport allowance)
   520104 عمل إضافي (Overtime)
   520105 حصة المنشأة في التأمينات الاجتماعية (Employer GOSI)
   520106 مصروف مكافأة نهاية الخدمة (EOSB expense)
   520107 تأمين طبي (Medical insurance – CCHI)
   520108 إجازات وتذاكر سفر (Leave & tickets)
  5202 الرسوم الحكومية (Government fees)
   520201 رسوم الإقامات وتجديدها (Iqama fees)
   520202 المقابل المالي / رسوم رخص العمل (Expat levy & work permits – MHRSD/Qiwa)
   520203 رسوم رخصة البلدية (بلدي) واللوحات (Balady licence & signage)
   520204 رسوم الدفاع المدني (سلامة) (Civil defence – Salama)
   520205 رسوم السجل التجاري والغرفة التجارية (CR & Chamber fees)
   520206 الشهادات الصحية (Health certificates for staff)
  5203 الإشغال (Occupancy)
   520301 إيجار (short-term / low-value leases; IFRS 16 otherwise)
   520302 كهرباء (Electricity – SEC)
   520303 مياه (Water – NWC)
   520304 غاز (Gas)
   520305 صيانة وإصلاحات (Repairs & maintenance)
   520306 نظافة ومكافحة حشرات (Cleaning & pest control)
  5204 التسويق (Marketing)
   520401 إعلانات رقمية (Digital ads – often reverse charge)
   520402 عروض ترويجية ممولة على التطبيقات (App-funded promos charged to restaurant)
  5205 مصروفات إدارية وعمومية (G&A)
   520501 اتصالات وإنترنت
   520502 اشتراكات برمجيات (Software subscriptions – incl. Munassiq)
   520503 أتعاب مهنية (Professional fees – audit, zakat advisory)
   520504 رسوم بنكية
   520505 قرطاسية ومطبوعات
  5206 الإهلاك والإطفاء (Depreciation & amortization)
   520601 إهلاك الممتلكات والمعدات
   520602 استهلاك أصول حق الاستخدام
   520603 إطفاء الأصول غير الملموسة
  5207 مصروفات تمويلية (Finance costs)
   520701 فوائد/تكاليف تمويل
   520702 مصروف فائدة التزامات الإيجار
 53 الزكاة والضرائب (Zakat & income tax)
  5301 مصروف الزكاة (Zakat expense)
   530101 الزكاة
  5302 مصروف ضريبة الدخل (Income tax expense)
   530201 ضريبة الدخل
```

**Design notes:**
- Use **dimensions** (branch, cost centre, delivery app, POS terminal) instead of multiplying accounts. Keep one account per app only if reporting needs it.
- Every account needs `vat_treatment` metadata where relevant, and every VAT account needs a `vat_box`.
- **Inventory method:** use **perpetual** inventory with a moving average cost computed server-side. The POS sale posts COGS from the recipe/BOM at sale time. The simpler "periodic" method (purchases → expense, then adjust at count) is not recommended, because the platform already tracks recipes and stock movements.

---

## 6. Standard postings (Dr/Cr) for restaurant operations

These are [K], standard double-entry practice under IFRS for SMEs and KSA VAT at 15%. Amounts are illustrative: a SAR 115.00 VAT-inclusive sale is net 100.00 + VAT 15.00.

**6.1 Cash sale, dine-in or takeaway (simplified invoice)**
```
Dr 110102 POS cash drawer                115.00
   Cr 410101 Dine-in sales                        100.00
   Cr 210201 Output VAT                            15.00
Dr 510101 Food cost (recipe cost)         32.00
   Cr 110301 Raw food inventory                    32.00      (+ beverages/packaging per BOM)
```

**6.2 Card sale (mada/Visa), with acquirer fee at settlement**
```
Sale:        Dr 110201 Card settlements receivable 115.00 / Cr 410101 100.00 / Cr 210201 15.00
Settlement (bank receives 114.08, fee 0.80 + VAT 0.12):
Dr 110110 Bank                            114.08
Dr 510401 Card fees                         0.80
Dr 110501 Input VAT                         0.12   (only if the acquirer issues a VAT tax invoice for its fee)
   Cr 110201 Card settlements receivable          115.00
```

**6.3 Delivery-app sale with commission**

The restaurant invoices the customer; the app collects the money and deducts its commission.
```
At order (restaurant issues simplified invoice to the end customer):
Dr 110202 HungerStation receivable        115.00
   Cr 410103 Delivery-app sales                   100.00
   Cr 210201 Output VAT                            15.00
At app statement / payout (commission 20% of 100 = 20.00 + VAT 3.00 on commission):
Dr 510301 App commission                   20.00
Dr 110501 Input VAT                         3.00   (the app's tax invoice for commission)
Dr 110110 Bank                             92.00
   Cr 110202 HungerStation receivable              115.00
```

**VAT caveat [K]:** depending on the app's contract (merchant-of-record vs agent), the app may invoice the customer itself. In that case the restaurant's supply is to the app, not the consumer. Confirm per contract.
- Munassiq should model a per-app setting: **"who issues the customer invoice"**.
- App-funded discounts and restaurant-funded discounts must be split. A restaurant-funded promo reduces sales, not commission expense.

**6.4 Sales refund / credit note (full or partial)**
```
Dr 410201 Sales returns (credit notes)    100.00
Dr 210201 Output VAT                       15.00
   Cr 110102 Cash (or 110201/110202)              115.00
If food returned unused to stock (rare in restaurants):  Dr 110301 / Cr 510101 at cost
If the food is discarded: no inventory reversal; the cost stays in COGS (or reclassify to 510201 waste).
```

**6.5 Purchase of inventory on credit with VAT (supplier tax invoice)**
```
Dr 110301 Raw food inventory            1,000.00
Dr 110501 Input VAT                        150.00
   Cr 210101 Trade payables – food               1,150.00
```
Input VAT is deductible only with a valid tax invoice. For e-invoiced suppliers in Phase 2, that is a cleared standard invoice.

**6.6 Supplier payment**
```
Dr 210101 Trade payables                 1,150.00
   Cr 110110 Bank                                1,150.00
```

**6.7 Purchase return (supplier issues a credit note)**
```
Dr 210101 Trade payables                   230.00
   Cr 110301 Raw food inventory                   200.00
   Cr 110501 Input VAT                              30.00
```

**6.8 Operating expense with VAT paid in cash (e.g. maintenance)**
```
Dr 520305 Repairs & maintenance            200.00
Dr 110501 Input VAT                         30.00
   Cr 110103 Petty cash                           230.00
```
- Government fees such as iqama, Balady and GOSI carry **no VAT** (out of scope).
- Salaries: no VAT.
- Imported services (foreign ads/SaaS) use reverse charge:
```
Dr 520401 Digital ads                      1,000.00
   Cr 110110 Bank                                 1,000.00
Dr 110503 Input VAT – RCM                    150.00
   Cr 210202 Output VAT – RCM                       150.00     (box 9 on both sides)
```

**6.9 Inventory waste (spoilage, expired stock)**
```
Dr 510201 Food waste                        45.00
   Cr 110301 Raw food inventory                    45.00
```
VAT note [K]: input VAT on normal-course spoilage is generally not clawed back. Items given away free may be a **deemed supply**. Staff meals and free samples need a policy decision; consult ZATCA's nominal/deemed supply guidance.

**6.10 Stock count shortage / surplus (at cost)**
```
Shortage:  Dr 510202 Stock count shortage  60.00 / Cr 110301 Inventory 60.00
Surplus:   Dr 110301 Inventory 25.00 / Cr 510202 (reduce shortage) or Cr 420103 Stock surplus 25.00
```

**6.11 Internal production: raw → prepared (sauces, dough, marinated meat)**
```
Dr 110305 Prepared items inventory        300.00   (cost roll-up of consumed raws + optional labour/overhead)
   Cr 110301 Raw food inventory                   300.00
Sale of dishes using prepared items then credits 110305 via COGS as in 6.1.
Production yield loss: Dr 510201 Food waste / Cr 110301.
```

**6.12 VAT settlement at period end (quarter)**
```
Close output and input into the settlement account:
Dr 210201 Output VAT                     X (balance)
Dr 210202 Output VAT – RCM               Y
   Cr 110501 Input VAT                             A
   Cr 110502 Input VAT – imports                   B
   Cr 110503 Input VAT – RCM                       C
   Cr 210203 VAT payable to ZATCA                  (X+Y−A−B−C)   [if negative → debit = VAT receivable / carry forward]
Payment (SADAD):
Dr 210203 VAT payable to ZATCA
   Cr 110110 Bank
```
The settlement entry should reference the VAT return ID. Box 14 corrections post to the settlement account in the period filed.

**6.13 Zakat provision (at month-end estimate or year-end)**
```
Dr 530101 Zakat expense                  Z
   Cr 210401 Zakat provision                     Z
Payment on filing (≤120 days after FY end):  Dr 210401 / Cr 110110
```

**6.14 Payroll month (Saudi + expat), GOSI and EOSB accrual**
```
Dr 520101/520102/520103 salaries & allowances   G
   Cr 210301 Salaries payable                        G − employee GOSI share
   Cr 210302 GOSI payable (employee share)           e
Dr 520105 Employer GOSI                        r
   Cr 210302 GOSI payable (employer share)           r
Dr 520106 EOSB expense                          b
   Cr 220101 EOSB provision                          b
Payment via Mudad/WPS: Dr 210301 / Cr 110110 ; GOSI payment: Dr 210302 / Cr 110110
```
- **GOSI rates [K; verify with GOSI]:**
  - Saudis: employer ~11.75% (annuities 9% + SANED 0.75% + occupational hazards 2%); employee ~9.75% (9% + 0.75%). The contributable wage is basic + housing, capped at SAR 45,000. The annuity rate for employees who joined from July 2024 rises gradually.
  - Non-Saudis: employer 2% occupational hazards only.
- **EOSB (Labour Law Art. 84):** half a month's wage per year for the first 5 years, one month per year after that. The wage basis is the last wage.

**6.15 Month-end closing**
1. Post accruals: utilities, depreciation (Dr 520601 / Cr 1202xx), ROU amortization and lease interest, and prepaid expense release (Dr 5203xx / Cr 110401).
2. Reconcile the bank, card and app receivables against statements.
3. Run the inventory count variance (6.10) and the waste log.
4. Run the VAT check: the output VAT balance must equal the VAT on issued e-invoices less credit notes for the period. Any difference is a red flag.
5. **Lock the period** (monthly soft close).
6. Year end:
```
Dr all 4xxxxx revenue / Cr 310402 Current year P&L ; Dr 310402 / Cr all 5xxxxx expenses
Then Dr/Cr 310402 ↔ 310401 Retained earnings
```
   Then record the year-end inventory in the inventory book (Commercial Books Law Art. 4), and hard-lock the year.

---

## 7. Other integrations (customer-connected)

Keep these optional, per tenant, with credentials entered by the customer.

| Integration | Public API? | Notes |
|---|---|---|
| **Moyasar** (payment gateway) | Yes, public REST API and docs (https://docs.moyasar.com/) [K] | Payments, refunds, webhooks; supports mada, Apple Pay, STC Pay. Settlement reports → card/gateway receivable reconciliation. |
| **HyperPay** | Yes, OPPWA/COPYandPAY API (https://wordpresshyperpay.docs.oppwa.com/) [K] | Merchant onboarding goes through HyperPay. |
| **Tap Payments** | Yes, public API (https://developers.tap.company/) [K] | Charges, refunds, webhooks. |
| **Bank feeds / open banking** | SAMA Open Banking Framework: **AIS (account information) went live in phase 1 (formally rolled out Q4 2023)**; PIS (payment initiation) is the next phase [S https://www.openbankingexpo.com/news/saudi-central-bank-publishes-open-banking-framework/]. Access only through **licensed TPPs** such as **Tarabut** (AIS certified May 2023) and **Lean** [S https://www.tarabut.com/blogs/post/tarabut-open-bankin-certified-sama]. | Integrate through a TPP aggregator (commercial contract), not the banks directly. The fallback is CSV/MT940 statement import. |
| **HungerStation** | **No open public API.** Partner/POS integrations run through approved integrators (Deliverect, Foodics "Foodizone", Foodstack, FeedUs) [S https://www.deliverect.com/en/integrations/hungerstation ; https://www.foodics.com/portfolio/foodizone/] | Realistic path: an aggregator partnership or statement (CSV) import for reconciliation. |
| **Jahez** | Partner integration by request: the restaurant emails `integration@jahez.net`, then uses the "Jahez Integration Portal" [S https://apps.odoo.com/apps/modules/19.0/mn_food_aggregator_pos] | Not self-serve public. |
| **Keeta** (Meituan) | Through integrators (Foodics, FeedUs, Odoo modules) [S] | No public self-serve API found. |
| **Mrsool** | Integrator-based [S] | |
| **Mudad** (payroll / WPS, MHRSD + SAMA) | Integrations exist for approved HR/payroll vendors (ZenHR, Bayzat, Jisr, Mercans) [S https://www.zenhr.com/en/marketplace-integration/mudad]. No open public API for arbitrary apps [K]. | Export a Mudad-compatible WPS file as a first step. |
| **GOSI** | No public self-serve API for employers [K]. Business portal only; some partner integrations. | Manual registration or monthly update; reconcile GOSI invoices. |
| **Qiwa** | No public API for SMEs [K]. | Contracts and work permits are handled in Qiwa manually. |
| **ZATCA VAT return filing** | No public API for VAT return submission [K]. The return is filed manually in the ERAD portal. | Munassiq prepares the box values and the taxpayer types them in. |

---

## 8. Key implementation pitfalls

**Hash and signature**
1. **Hash mismatch from whitespace.** The hash is recomputed from the submitted bytes after removing UBLExtensions, the QR ADR and cac:Signature, keeping the surrounding whitespace text nodes. Compute the hash on the final layout (§2b). Never pretty-print or reformat after hashing. Generate LF line endings only. If you use `xml2js`/`fast-xml-parser` builders, emit the final string once and hash that same string (wes4m's hack is a symptom of violating this).
2. **Initial PIH is base64 of the *hex text*** of SHA256("0") (`NWZlY2Vi…OQ==`). Later PIHs are base64 of *raw* digests (44 chars). Do not "normalize" the initial value.
3. **The certificate hash is SHA-256 of the base64 certificate text**, rendered as hex and then base64-encoded. Hashing the DER bytes or skipping the hex step gives a wrong `CertDigest` [OSS S11/S12].
4. **The SignedProperties hash depends on exact whitespace and inline `xmlns:ds`.** Copy the prod-tested template byte-for-byte. The embedded copy must have identical inner whitespace (§2c).
5. **SigningTime format:** `YYYY-MM-DDTHH:mm:ss`, with no milliseconds. The same string must appear in the hashed SignedProperties and in the embedded one. `Z` or no `Z` must be consistent (**CONFLICT** between S11 and S12; §2c).
6. **What gets signed:** the raw 32 hash bytes with SHA256withECDSA (DER output). Signing the base64 text, the hex, or the canonical SignedInfo fails validation.
7. **Certificate handling:**
   - `binarySecurityToken` is **base64 of the base64 certificate**. Decode once for the PEM body; use the raw token as the Basic username.
   - The `ds:X509Certificate` element takes the PEM body with no headers or newlines.
   - The serial goes in **decimal**; the issuer goes in **reversed** RDN order joined with `", "`.
8. **secp256k1 is not supported by WebCrypto.** Use `node:crypto` or OpenSSL for keys, signatures and the CSR.

**CSR**

9. `SN` in the CSR is **surname (2.5.4.4)**, the EGS serial. `UID` holds the VAT number (not 2.5.4.97, despite S2). Use `title` for the invoice types.
10. The template name must match the environment: `TSTZATCA-` (sandbox), `PREZATCA-` (simulation), `ZATCA-` (production). A mismatch gives 400/401 on `/compliance`.
11. The OTP expires in **1 hour**. Portal and simulation OTPs are **not interchangeable**. Onboarding has to happen inside that window, so run `/compliance` → compliance checks → `/production/csids` in one server-side job. On failure, keep the CCSID and request ID so the job can resume without a new OTP. Compliance checks can be retried with the same CCSID [K].

**XML content rules**

12. Every amount carries `currencyID`. Every currency ID equals `DocumentCurrencyCode`, except BT-111 (BR-KSA-CL-02).
13. **No empty elements** (BR-KSA-F-03). Omit optional elements rather than emitting `<cbc:Note/>`.
14. **All amounts positive** (BR-KSA-F-04). Credit notes use positive values; the sign comes from type 381.
15. **Building number exactly 4 digits and postal code exactly 5 digits** (BR-KSA-37/66). Validate the seller's address at tenant setup, because a wrong seller address is a common cause of **202 warnings** [P S5: "If error in Seller Address: Accepted with warning"].
16. **VAT number:** 15 digits, `^3\d{13}3$` (BR-KSA-40).
17. **Seller `PartyIdentification`: exactly one**, with a valid schemeID (BR-KSA-08). Alphanumeric only, no dashes.
18. **IssueDate must not be in the future** (BR-KSA-04). Server clock skew or timezone bugs (UTC vs AST, UTC+3) around midnight cause rejects. Use AST local time without `Z`, or UTC with `Z`, consistently, in both the XML and the QR.
19. **InvoiceTypeCode `name` must be exactly 7 characters**, `0200000` / `0100000`. S11's template uses `0211010`, which is wrong for a normal sale because it flags nominal+summary.
20. **Standard 388 requires `cac:Delivery/cbc:ActualDeliveryDate`** (BR-KSA-15). Standard documents need buyer name and address (BR-KSA-10/42), and a buyer ID when there is no buyer VAT number (BR-KSA-81).
21. **Credit/debit notes require BillingReference and InstructionNote** (BR-KSA-56, BR-KSA-17).
22. **Two TaxTotal elements** (EN16931-08/09). Omitting the one without subtotals, or putting subtotals in both, fails validation.
23. **Exemption code and text** for Z/E/O must come from the fixed list verbatim (CL-04/05, BR-KSA-83). `S` must not carry them.

**Rounding**

24. **Rounding rules** [P S1 §10; P S9]:
    - line net = round2(qty × unit net price − line allowances + line charges)
    - line VAT = round2(line net × rate)
    - line incl. = line net + line VAT
    - category taxable = Σ line nets (already rounded) − doc allowances + doc charges
    - **category VAT = round2(category taxable × rate)**, not the sum of line VATs
    - BT-109 = BT-106 − BT-107 + BT-108
    - BT-112 = BT-109 + BT-110
    - BT-115 = BT-112 − BT-113 + BT-114
    
    Store the *rounded* intermediate calculated values and use them downstream (the forum fix for BR-CO-15). Use decimal arithmetic (`numeric` in Postgres; bigint halalas or a decimal library in TS), **never JS floats**.
25. **VAT-inclusive menu prices** (shelf prices in KSA include VAT). Back-computing net from gross can make `line net + round2(line net × 0.15)` differ from the menu price by 0.01. Options:
    - (a) pick a unit net price with up to 6 decimals so that qty × price rounds correctly (BT-146 allows more decimals);
    - (b) accept a 1-halala difference and bridge it with `cbc:PayableRoundingAmount` (BT-114), so that BT-115 equals the cash collected;
    - (c) adjust the last line.
    
    **Test every option with the SDK validator.** Sum of line VAT ≠ document VAT by 0.01 is legitimate under §10.

**API and operations**

26. **202 is success** (with warnings). **409 is "already submitted"**, so treat it as success for idempotent retries (§2f). Only 200/202 mean reported or cleared; a 400 document is rejected but **stays in the chain**.
27. **Reporting queue:** simplified invoices are reported **within 24h**. Use a durable outbox with retries and alerts at, for example, 12h and 20h. Make each call idempotent per `(egs_unit, icv)`. Retrying the same bytes is safe thanks to 409.
28. **Standard invoice:** do not give it to the customer until it is `CLEARED`. On 303, send it to reporting. **Print the QR from `clearedInvoice`** and store the cleared XML as the legal copy.
29. **One chain per EGS unit, strictly serial.** Concurrency means two POS terminals sharing one unit must be serialized, e.g. with a DB row lock on `egs_units`. In a multi-tenant cloud, use **one EGS unit per branch or terminal**, each with its own certificate, so chains don't contend.
30. **Base64 of the invoice in the body is base64 of the UTF-8 bytes** of the signed XML (keep the XML declaration). Do not base64 a JS UTF-16 string.
31. **Environment separation:** sandbox, simulation and production each have their own certificates, secrets, CSR template and OTP source. Key material must be encrypted at rest and never exported or shown [P S2, P S3 "Export of stamping keys"].
32. **Validate locally before sending.** Put the official **ZATCA SDK (Java CLI `fatoora`)** in CI. Commands [K]: `fatoora -validate -invoice f.xml`, `-generateHash`, `-qr`, `-sign`, `-invoiceRequest`, `-csr -csrConfig cfg.properties`. The web-based **Compliance & Enablement Toolbox** in the Developer Portal is also available [P S5]. The SDK is a download from https://zatca.gov.sa/en/E-Invoicing/SystemsDevelopers/ComplianceEnablementToolbox/Pages/DownloadSDK.aspx [K; URL not re-verified].
33. **Arabic in the CSR:** set `utf8 = yes` / `string_mask = utf8only`. Forbidden characters `!@#$%&*_<=` in the CN, O, OU, location and industry fields make the SDK reject the CSR [OSS S12].
34. **Do not claim anything beyond what is implemented.** The project rules (CLAUDE.md #8) currently forbid claiming Phase 2 compliance. Implementing this document changes that, so update the rule when Phase 2 ships and passes ZATCA compliance checks in simulation and production.

---

## 9. Open questions / to verify before coding

- EDU/HEA exemption category placement (Z vs E): confirm in the SDK Schematron (`Rules/Schematrons/*.xsl`).
- Exact acceptance of an empty `cac:AccountingCustomerParty` on simplified invoices (BR-KSA-F-03).
- `SigningTime` with or without `Z`, and QR tag 3 with or without `Z`: confirm with the SDK `-validate` on generated samples.
- QR tag 6: 44-byte base64 text (implementations) vs 32 raw bytes (S2 text). Implementations win, but test it.
- The current e-invoicing violation penalty table and current VAT penalty amounts.
- Whether the Ministry of Commerce has issued the new Commercial Books Law and its e-books Implementing Regulations.
- Per-app VAT treatment for delivery platforms (who is the supplier to the consumer).
- GOSI rates for employees who joined after July 2024.
