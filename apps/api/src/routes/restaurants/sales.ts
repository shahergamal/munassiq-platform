import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../../db/pool.ts";
import { postCustomerReceipt, postSalesDocument } from "../../lib/accounting/posting.ts";
import { AppError, badRequest, notFound } from "../../lib/errors.ts";
import { formatMoney, parseMoney, riyal, percentToBp, vatOf } from "../../lib/money.ts";
import { pageMeta, parsePage } from "../../lib/pagination.ts";
import { buildQrBase64 } from "../../lib/zatca.ts";
import { stamp, submit, submitSoon } from "../../lib/zatca/service.ts";
import { zatcaStateOf } from "./zatca.ts";
import { auditTenant, isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";
import { idempotencyKey } from "./purchases.ts";

/**
 * Tax invoices, credit and debit notes (ZATCA data model), and customer receipts. Every amount is computed here
 * from quantities and prices; an issued document is never edited (corrections are credit/debit notes), and each
 * one posts to the ledger in the same transaction.
 */

const TZ = "Asia/Riyadh";
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** ZATCA exemption / zero-rating reasons (VATEX codes). The English text goes in the XML verbatim (BR-KSA-83); the Arabic is for display. */
export const EXEMPTION_REASONS: Record<string, { cat: "Z" | "E" | "O"; ar: string; en: string }> = {
  "VATEX-SA-29": { cat: "E", ar: "الخدمات المالية", en: "Financial services mentioned in Article 29 of the VAT Regulations" },
  "VATEX-SA-29-7": { cat: "E", ar: "عقد تأمين على الحياة", en: "Life insurance services mentioned in Article 29 of the VAT Regulations" },
  "VATEX-SA-30": { cat: "E", ar: "التوريدات العقارية المعفاة من الضريبة", en: "Real estate transactions mentioned in Article 30 of the VAT Regulations" },
  "VATEX-SA-32": { cat: "Z", ar: "صادرات السلع من المملكة", en: "Export of goods" },
  "VATEX-SA-33": { cat: "Z", ar: "صادرات الخدمات من المملكة", en: "Export of services" },
  "VATEX-SA-34-1": { cat: "Z", ar: "النقل الدولي للسلع", en: "The international transport of Goods" },
  "VATEX-SA-34-2": { cat: "Z", ar: "النقل الدولي للركاب", en: "international transport of passengers" },
  "VATEX-SA-34-3": { cat: "Z", ar: "الخدمات المرتبطة مباشرة أو عرضياً بتوريد النقل الدولي للركاب", en: "services directly connected and incidental to a Supply of international passenger transport" },
  "VATEX-SA-34-4": { cat: "Z", ar: "توريد وسائل النقل المؤهلة", en: "Supply of a qualifying means of transport" },
  "VATEX-SA-34-5": { cat: "Z", ar: "الخدمات ذات الصلة بنقل السلع أو الركاب، وفقاً للتعريف الوارد بالمادة الخامسة والعشرين من اللائحة التنفيذية لنظام ضريبة القيمة المضافة", en: "Any services relating to Goods or passenger transportation, as defined in article twenty five of these Regulations" },
  "VATEX-SA-35": { cat: "Z", ar: "الأدوية والمعدات الطبية", en: "Medicines and medical equipment" },
  "VATEX-SA-36": { cat: "Z", ar: "المعادن المؤهلة", en: "Qualifying metals" },
  "VATEX-SA-EDU": { cat: "Z", ar: "الخدمات التعليمية الخاصة للمواطنين", en: "Private education to citizen" },
  "VATEX-SA-HEA": { cat: "Z", ar: "الخدمات الصحية الخاصة للمواطنين", en: "Private healthcare to citizen" },
  "VATEX-SA-MLTRY": { cat: "Z", ar: "توريد السلع العسكرية المؤهلة", en: "supply of qualified military goods" },
  "VATEX-SA-OOS": { cat: "O", ar: "خارج نطاق ضريبة القيمة المضافة", en: "Reason is free text, to be provided by the taxpayer on case to case basis." },
};

const lineSchema = z.object({
  description: z.string().trim().min(1, "اكتب وصف البند").max(300),
  quantity: z.number().positive("الكمية أكبر من صفر").max(1_000_000),
  unitPrice: z.number().min(0).max(100_000_000),
  discount: z.number().min(0).max(100_000_000).default(0),
  vatCategory: z.enum(["S", "Z", "E", "O"]).default("S"),
  exemptionCode: z.string().max(20).nullable().optional().transform((v) => v || null),
  exemptionReason: z.string().trim().max(300).nullable().optional().transform((v) => v || null),
  accountId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
});

export const docSchema = z.object({
  kind: z.enum(["invoice", "credit_note", "debit_note"]).default("invoice"),
  invoiceType: z.enum(["standard", "simplified"]),
  customerId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
  branchId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
  originalId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
  reason: z.string().trim().max(300).nullable().optional().transform((v) => v || null),
  supplyDate: z.string().regex(ISO).nullable().optional().transform((v) => v ?? null),
  paymentMeans: z.enum(["cash", "card", "bank_transfer", "credit"]).default("credit"),
  notes: z.string().trim().max(1000).nullable().optional().transform((v) => v || null),
  /** KSA-2 exports flag: a standard, zero-rated invoice to a buyer outside the Kingdom. */
  isExport: z.boolean().default(false),
  lines: z.array(lineSchema).min(1, "أضف بنداً واحداً على الأقل").max(200),
});

interface SellerRow { legal_name: string; tax_id: string; cr_number: string | null; street: string; building_no: string; additional_no: string | null; district: string; city: string; postal_code: string }
interface CustomerRow {
  id: string; name: string; customer_type: string; vat_number: string | null; other_id_scheme: string | null; other_id: string | null; street: string | null; building_no: string | null;
  additional_no: string | null; district: string | null; city: string | null; postal_code: string | null; country_code: string; payment_terms_days: number; phone: string; email: string | null;
}

async function seller(db: Db) {
  const s = (await db.query<SellerRow>(
    `SELECT p.legal_name, t.tax_id, p.cr_number, p.street, p.building_no, p.additional_no, p.district, p.city, p.postal_code
       FROM tax_profiles p CROSS JOIN tenants t`)).rows[0];
  if (!s) throw new AppError(409, "tax_profile_missing", "أكمل بيانات المنشأة الضريبية (الاسم النظامي والعنوان الوطني) من إعدادات المحاسبة قبل إصدار الفواتير");
  return {
    legalName: s.legal_name, vatNumber: s.tax_id, crNumber: s.cr_number, street: s.street, buildingNo: s.building_no, additionalNo: s.additional_no,
    district: s.district, city: s.city, postalCode: s.postal_code, countryCode: "SA",
  };
}

const buyerOf = (c: CustomerRow) => ({
  name: c.name, vatNumber: c.vat_number, otherIdScheme: c.other_id_scheme, otherId: c.other_id, street: c.street, buildingNo: c.building_no,
  additionalNo: c.additional_no, district: c.district, city: c.city, postalCode: c.postal_code, countryCode: c.country_code, phone: c.phone, email: c.email,
});

/** A buyer on a standard (B2B) invoice needs an identifier and a full national address (an export buyer: a name and a country). */
function standardBuyerProblems(c: CustomerRow, isExport = false): string[] {
  const out: string[] = [];
  if (isExport) return c.country_code === "SA" ? ["دولة خارج المملكة (فاتورة تصدير)"] : c.city ? [] : ["المدينة"];
  if (!c.vat_number && !c.other_id) out.push("الرقم الضريبي أو رقم تعريف آخر (مثل السجل التجاري)");
  if (c.country_code === "SA") {
    if (!c.street) out.push("الشارع");
    if (!c.building_no) out.push("رقم المبنى");
    if (!c.district) out.push("الحي");
    if (!c.city) out.push("المدينة");
    if (!c.postal_code) out.push("الرمز البريدي");
  }
  return out;
}

/** Sums per VAT category (and exemption reason), as the document-level breakdown needs them. */
function groups<T extends { vatCategory: "S" | "Z" | "E" | "O"; rate: number; exemptionCode: string | null; reason: string | null }>(lines: T[], value: (l: T) => number) {
  const out = new Map<string, { key: { category: T["vatCategory"]; rate: number; exemptionCode: string | null; exemptionReason: string | null }; sum: number }>();
  for (const l of lines) {
    const k = `${l.vatCategory}|${l.rate}|${l.exemptionCode ?? ""}|${l.reason ?? ""}`;
    const text = l.vatCategory === "S" ? null : l.exemptionCode === "VATEX-SA-OOS" ? l.reason : EXEMPTION_REASONS[l.exemptionCode ?? ""]?.en ?? null;
    const g = out.get(k) ?? { key: { category: l.vatCategory, rate: l.rate, exemptionCode: l.exemptionCode, exemptionReason: text }, sum: 0 };
    g.sum += value(l);
    out.set(k, g);
  }
  return [...out.values()];
}

const KIND_PREFIX = { invoice: "INV", credit_note: "CRN", debit_note: "DBN", prepayment: "PRE" } as const;
const KIND_AR = { invoice: "فاتورة ضريبية", credit_note: "إشعار دائن", debit_note: "إشعار مدين", prepayment: "فاتورة دفعة مقدمة" } as const;

/** The liability an advance sits in until an invoice deducts it (created on first use: charts older than M6 lack it). */
export async function advancesAccount(db: Db): Promise<string> {
  const a = (await db.query<{ id: string }>("SELECT id FROM accounts WHERE system_key = 'customer_advances'")).rows[0];
  if (a) return a.id;
  // The standard chart has it (2108) without a key: adopt it.
  const std = (await db.query<{ id: string }>("UPDATE accounts SET system_key = 'customer_advances' WHERE code = '2108' AND system_key IS NULL AND NOT is_group RETURNING id")).rows[0];
  if (std) return std.id;
  const parent = (await db.query<{ id: string }>("SELECT id FROM accounts WHERE code = '21'")).rows[0];
  if (!parent) throw new AppError(409, "account_missing", "أضف مجموعة الخصوم المتداولة (21) في دليل الحسابات");
  const code = (await db.query("SELECT 1 FROM accounts WHERE code = '2108'")).rowCount ? "2198" : "2108";
  return (await db.query<{ id: string }>(
    `INSERT INTO accounts (tenant_id, code, name, type, parent_id, is_group, system_key)
     VALUES (app_tenant_id(), $1, 'دفعات مقدمة من العملاء', 'liability', $2, false, 'customer_advances') RETURNING id`, [code, parent.id])).rows[0]!.id;
}

/** What is left of each prepayment on an order (taxable and VAT, halalas): not deducted by an invoice nor refunded by a credit note. */
export async function unappliedPrepayments(db: Db, sourceId: string, by: "order" | "contract" = "order") {
  return (await db.query<{ id: string; doc_number: string; issued_at: Date; rate: string; taxable: string; vat: string }>(
    `SELECT p.id, p.doc_number, p.issued_at, (SELECT max(l.vat_rate) FROM sales_document_lines l WHERE l.document_id = p.id)::text AS rate,
            (p.taxable - coalesce((SELECT sum(a.taxable) FROM prepayment_applications a WHERE a.prepayment_id = p.id), 0)
                       - coalesce((SELECT sum(n.taxable) FROM sales_documents n WHERE n.original_id = p.id AND n.kind = 'credit_note'), 0))::text AS taxable,
            (p.vat - coalesce((SELECT sum(a.vat) FROM prepayment_applications a WHERE a.prepayment_id = p.id), 0)
                   - coalesce((SELECT sum(n.vat) FROM sales_documents n WHERE n.original_id = p.id AND n.kind = 'credit_note'), 0))::text AS vat
       FROM sales_documents p WHERE ${by === "order" ? "p.sales_order_id" : "p.contract_id"} = $1 AND p.kind = 'prepayment' ORDER BY p.issued_at`, [sourceId])).rows
    .map((r) => ({ id: r.id, number: r.doc_number, issuedAt: r.issued_at, rate: Number(r.rate ?? 15), taxable: parseMoney(r.taxable), vat: parseMoney(r.vat) }))
    .filter((r) => r.taxable + r.vat > 0);
}

export type DocInput = Omit<z.infer<typeof docSchema>, "lines" | "kind" | "isExport"> & {
  /** "prepayment" (386) is issued only from a sales order (routes/sales/orders.ts). */
  kind: z.infer<typeof docSchema>["kind"] | "prepayment";
  isExport?: boolean;
  /** Set when the document invoices a sales order (routes/sales/orders.ts). */
  salesOrderId?: string | null;
  /** Final invoice of a sales order: deduct the order's unapplied prepayments (up to the invoice total). */
  applyPrepayments?: boolean;
  /** Set when the document belongs to a construction contract (its advance, or an IPC's invoice). */
  contractId?: string | null;
  /** Deduct at most this much of the source's advances (gross, halalas): an IPC recovers its share only. */
  prepaymentLimit?: number;
  /** Retained by the client on this invoice (halalas, excl. VAT): booked to retention receivable, VAT unaffected. */
  retentionAmount?: number;
  lines: (z.infer<typeof docSchema>["lines"][number] & { itemId?: string | null })[];
};

/**
 * Issues one tax invoice or note inside the caller's transaction: validates, prices (VAT per category), stamps it for
 * ZATCA when the workspace has a device, stores it with its lines and posts it. Idempotent on `key`. The caller sends
 * the result to ZATCA after commit with `sendToZatca`.
 */
export async function issueSalesDocument(db: Db, b: DocInput, key: string, req: FastifyRequest | null): Promise<{ id: string; number: string; replay: boolean; zatcaDocument?: string | null; prepaid?: number }> {
  if (b.kind !== "invoice" && b.kind !== "prepayment" && (!b.originalId || !b.reason || b.reason.length < 3)) throw badRequest("الإشعار يحتاج الفاتورة الأصلية وسبب الإصدار");
  if (b.kind === "prepayment" && (!(b.salesOrderId || b.contractId) || b.paymentMeans === "credit" || b.lines.some((l) => l.vatCategory !== "S"))) {
    throw badRequest("الدفعة المقدمة مبلغ مقبوض على أمر بيع بالنسبة الأساسية");
  }
  if (b.isExport && (b.invoiceType !== "standard" || b.kind === "prepayment")) throw badRequest("فاتورة التصدير فاتورة ضريبية (بين المنشآت)");
  for (const [i, l] of b.lines.entries()) {
    if (l.discount > l.quantity * l.unitPrice) throw badRequest(`خصم البند ${i + 1} أكبر من قيمته`);
    if (l.vatCategory !== "S") {
      const r = l.exemptionCode ? EXEMPTION_REASONS[l.exemptionCode] : undefined;
      if (!r || r.cat !== l.vatCategory) throw badRequest(`اختر سبب الإعفاء أو النسبة الصفرية للبند ${i + 1}`);
      if (l.vatCategory === "O" && !l.exemptionReason) throw badRequest(`اكتب سبب كون البند ${i + 1} خارج نطاق الضريبة`);
    }
  }
  const dup = (await db.query<{ id: string; doc_number: string }>("SELECT id, doc_number FROM sales_documents WHERE idempotency_key = $1", [key])).rows[0];
  if (dup) return { id: dup.id, number: dup.doc_number, replay: true };
  const s = await seller(db);
  const settings = (await db.query<{ vat_rate_percent: string }>("SELECT vat_rate_percent::text FROM tenant_settings")).rows[0];
  const rate = Number(settings?.vat_rate_percent ?? 15);

  let customer: CustomerRow | null = null;
  if (b.customerId) {
    customer = (await db.query<CustomerRow>(
      `SELECT id, name, customer_type, vat_number, other_id_scheme, other_id, street, building_no, additional_no, district, city, postal_code,
              country_code, payment_terms_days, phone, email FROM customers WHERE id = $1`, [b.customerId])).rows[0] ?? null;
    if (!customer) throw notFound("العميل غير موجود");
  }
  if (b.invoiceType === "standard") {
    if (!customer) throw badRequest("الفاتورة الضريبية (بين المنشآت) تحتاج عميلاً");
    const missing = standardBuyerProblems(customer, b.isExport);
    if (missing.length) throw new AppError(422, "buyer_incomplete", `أكمل بيانات العميل للفاتورة الضريبية: ${missing.join("، ")}`, { missing });
  }
  if (b.paymentMeans === "credit" && !customer) throw badRequest("البيع الآجل يحتاج عميلاً");

  let original: { id: string; customer_id: string | null; invoice_type: string; total: string; credited: string; kind: string; applied: string } | null = null;
  if (b.originalId) {
    // Issued documents are append-only (no row locks): serialise notes on one invoice with an advisory lock.
    await db.query("SELECT pg_advisory_xact_lock(hashtext('sales_document:' || $1))", [b.originalId]);
    original = (await db.query<{ id: string; customer_id: string | null; invoice_type: string; total: string; credited: string; kind: string; applied: string }>(
      `SELECT d.id, d.customer_id, d.invoice_type, d.kind, d.total::text,
              coalesce((SELECT sum(n.total) FROM sales_documents n WHERE n.original_id = d.id AND n.kind = 'credit_note'), 0)::text AS credited,
              coalesce((SELECT sum(a.taxable + a.vat) FROM prepayment_applications a WHERE a.prepayment_id = d.id), 0)::text AS applied
         FROM sales_documents d WHERE d.id = $1`, [b.originalId])).rows[0] ?? null;
    // A prepayment can only be refunded (credit note), and only what no invoice has deducted.
    if (!original || !(original.kind === "invoice" || (original.kind === "prepayment" && b.kind === "credit_note"))) throw notFound("الفاتورة الأصلية غير موجودة");
    if (original.invoice_type !== b.invoiceType || original.customer_id !== b.customerId) throw badRequest("الإشعار يتبع نوع الفاتورة الأصلية وعميلها");
  }

  // Lines and totals, in halalas. VAT is computed per category on the category's taxable total.
  const accounts = new Map((await db.query<{ id: string; system_key: string | null; type: string; is_group: boolean; is_active: boolean }>(
    "SELECT id, system_key, type, is_group, is_active FROM accounts")).rows.map((a) => [a.id, a]));
  // An advance and its refund sit in the customer advances liability, not in revenue.
  const onAdvance = b.kind === "prepayment" || original?.kind === "prepayment";
  const advances = onAdvance ? await advancesAccount(db) : null;
  if (advances && !accounts.has(advances)) accounts.set(advances, { id: advances, system_key: "customer_advances", type: "liability", is_group: false, is_active: true });
  const defaultAccount = advances ?? [...accounts.values()].find((a) => a.system_key === "sales_invoiced")?.id;
  let subtotal = 0; let discount = 0;
  const lines = b.lines.map((l, i) => {
    const gross = Math.round(l.quantity * parseMoney(l.unitPrice));
    const disc = parseMoney(l.discount);
    const net = gross - disc;
    const lrate = l.vatCategory === "S" ? rate : 0;
    subtotal += gross; discount += disc;
    const accountId = advances ?? l.accountId ?? defaultAccount;
    const acc = accountId ? accounts.get(accountId) : undefined;
    if (!acc || acc.type !== (advances ? "liability" : "revenue") || acc.is_group || !acc.is_active) throw badRequest(`اختر حساب إيرادات فرعياً للبند ${i + 1}`);
    const reason = l.exemptionCode ? (l.vatCategory === "O" ? l.exemptionReason : EXEMPTION_REASONS[l.exemptionCode]!.ar) : null;
    return { ...l, lineNo: i + 1, net, rate: lrate, vat: vatOf(net, percentToBp(lrate)), accountId: acc && accountId!, reason };
  });
  const taxable = lines.reduce((a, l) => a + l.net, 0);
  const standardNet = lines.filter((l) => l.vatCategory === "S").reduce((a, l) => a + l.net, 0);
  const vat = vatOf(standardNet, percentToBp(rate));
  const total = taxable + vat;
  if (total <= 0) throw badRequest("إجمالي المستند صفر");
  if (original && b.kind === "credit_note") {
    const remaining = parseMoney(original.total) - parseMoney(original.credited) - parseMoney(original.applied);
    if (total > remaining) throw new AppError(409, "credit_exceeds_invoice", `الإشعار الدائن أكبر من المتبقي على ${original.kind === "prepayment" ? "الدفعة المقدمة (غير المخصوم منها)" : "الفاتورة"} (${riyal(remaining)})`);
  }

  // Final invoice: earlier advances on the order are deducted, oldest first, up to this invoice's total. A partly
  // used advance splits its remaining VAT in proportion.
  const prepayments: { id: string; number: string; issuedAt: Date; rate: number; taxable: number; vat: number }[] = [];
  const prepaySource = b.salesOrderId ? { id: b.salesOrderId, by: "order" as const } : b.contractId ? { id: b.contractId, by: "contract" as const } : null;
  if (b.kind === "invoice" && b.applyPrepayments && prepaySource) {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('so_prepayment:' || $1))", [prepaySource.id]);
    let room = Math.min(total, b.prepaymentLimit ?? total);
    for (const p of await unappliedPrepayments(db, prepaySource.id, prepaySource.by)) {
      if (room <= 0) break;
      const gross = Math.min(room, p.taxable + p.vat);
      const vatPart = gross === p.taxable + p.vat ? p.vat : Math.round(gross * p.vat / (p.taxable + p.vat));
      prepayments.push({ id: p.id, number: p.number, issuedAt: p.issuedAt, rate: p.rate, taxable: gross - vatPart, vat: vatPart });
      room -= gross;
    }
  }
  const prepaid = prepayments.reduce((a, p) => a + p.taxable + p.vat, 0);

  const issueDate = today();
  const supplyDate = b.supplyDate ?? (b.invoiceType === "standard" ? issueDate : null);
  const dueDate = b.paymentMeans === "credit" && customer
    ? (await db.query<{ d: string }>("SELECT ($1::date + $2::int)::text AS d", [issueDate, customer.payment_terms_days])).rows[0]!.d : null;
  const n = (await db.query<{ n: string }>("SELECT next_counter($1)::text AS n", [`sales_${b.kind}`])).rows[0]!.n;
  const number = `${KIND_PREFIX[b.kind]}-${n.padStart(6, "0")}`;
  const issuedAt = new Date();
  const id = randomUUID();
  const uuid = randomUUID();
  // Phase 2 when this workspace has an active ZATCA device: the stamped document and its QR; otherwise the Phase 1 QR.
  const stamped = await stamp(db, {
    sourceType: "sales_document", sourceId: id, uuid, kind: b.kind, invoiceType: b.invoiceType, number, issuedAt, supplyDate, branchId: b.branchId,
    flags: { exports: Boolean(b.isExport) },
    prepayments: prepayments.map((p) => ({ number: p.number, issuedAt: p.issuedAt, category: "S" as const, rate: p.rate, taxable: p.taxable, vat: p.vat })),
    buyer: customer ? { name: customer.name, vatNumber: customer.vat_number, idScheme: customer.vat_number ? null : customer.other_id_scheme, id: customer.vat_number ? null : customer.other_id,
      street: customer.street, buildingNo: customer.building_no, additionalNo: customer.additional_no, district: customer.district, city: customer.city,
      postalCode: customer.postal_code, countryCode: customer.country_code } : { name: "عميل نقدي" },
    billingReference: original ? (await db.query<{ n: string }>("SELECT doc_number AS n FROM sales_documents WHERE id = $1", [original.id])).rows[0]!.n : null,
    reason: b.reason, paymentMeans: b.paymentMeans,
    lines: lines.map((l) => ({ id: l.lineNo, name: l.description, quantity: l.quantity, unitPrice: parseMoney(l.unitPrice), lineExtension: l.net + parseMoney(l.discount),
      category: l.vatCategory, rate: l.rate, vat: vatOf(l.net + parseMoney(l.discount), percentToBp(l.rate)) })),
    allowances: groups(lines, (l) => parseMoney(l.discount)).map((g) => ({ ...g.key, amount: g.sum })),
    subtotals: groups(lines, (l) => l.net).map((g) => ({ ...g.key, taxable: g.sum, vat: g.key.category === "S" ? vat : 0 })),
    totals: { lineExtension: subtotal, allowance: discount, taxExclusive: taxable, vat, taxInclusive: total, payable: total - prepaid },
  });
  const qr = stamped?.qr ?? buildQrBase64({ sellerName: s.legalName, vatNumber: s.vatNumber, issuedAt, totalWithVat: formatMoney(total), vatAmount: formatMoney(vat) });

  await db.query(
    `INSERT INTO sales_documents (id, uuid, tenant_id, kind, invoice_type, doc_number, customer_id, branch_id, issue_date, issued_at, supply_date, due_date, original_id, reason,
                                  payment_means, notes, subtotal, discount, taxable, vat, total, seller, buyer, qr_base64, idempotency_key, created_by, sales_order_id,
                                  prepaid_amount, is_export, contract_id, retention_amount)
     VALUES ($23, $24, app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, app_user_id(), $25, $26, $27, $28, $29)`,
    [b.kind, b.invoiceType, number, b.customerId, b.branchId, issueDate, issuedAt, supplyDate, dueDate, b.originalId, b.reason, b.paymentMeans, b.notes,
      formatMoney(subtotal), formatMoney(discount), formatMoney(taxable), formatMoney(vat), formatMoney(total), JSON.stringify(s), customer ? JSON.stringify(buyerOf(customer)) : null, qr, key, id, uuid,
      b.salesOrderId ?? null, formatMoney(prepaid), Boolean(b.isExport), b.contractId ?? null, formatMoney(b.retentionAmount ?? 0)]);
  for (const p of prepayments) {
    await db.query("INSERT INTO prepayment_applications (tenant_id, invoice_id, prepayment_id, taxable, vat) VALUES (app_tenant_id(), $1, $2, $3, $4)",
      [id, p.id, formatMoney(p.taxable), formatMoney(p.vat)]);
  }
  for (const l of lines) {
    await db.query(
      `INSERT INTO sales_document_lines (tenant_id, document_id, line_no, description, quantity, unit_price, discount, net, vat_category, vat_rate, exemption_code, exemption_reason, vat, total, account_id, item_id)
       VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [id, l.lineNo, l.description, l.quantity, formatMoney(parseMoney(l.unitPrice)), formatMoney(parseMoney(l.discount)), formatMoney(l.net), l.vatCategory, l.rate,
        l.exemptionCode, l.reason, formatMoney(l.vat), formatMoney(l.net + l.vat), l.accountId, l.itemId ?? null]);
  }
  await postSalesDocument(db, id);
  if (req) await auditTenant(db, req, "sales_document.issued", "sales_document", id, { kind: b.kind, number, total: formatMoney(total) });
  return { id, number, replay: false, zatcaDocument: stamped?.documentId ?? null, prepaid: prepaid / 100 };
}

/** After commit: a standard invoice is cleared by ZATCA before it goes to the buyer; a simplified one is reported within 24 hours. */
export async function sendToZatca(req: FastifyRequest, invoiceType: string, out: { replay: boolean; zatcaDocument?: string | null }) {
  const ctx = { tenantId: req.tenant!.id, userId: req.tenant!.userId };
  if (out.replay || !out.zatcaDocument) return null;
  if (invoiceType === "standard") return submit(ctx, out.zatcaDocument);
  submitSoon(ctx, out.zatcaDocument, (err) => req.log.warn({ err }, "zatca reporting deferred"));
  return null;
}

export default async function salesRoutes(app: FastifyInstance) {
  app.get("/sales/exemption-reasons", { preHandler: requireTenant("acc_invoices.view") }, async () => ({
    items: Object.entries(EXEMPTION_REASONS).map(([code, r]) => ({ code, category: r.cat, label: r.ar })),
  }));

  app.get("/sales-documents", { preHandler: requireTenant("acc_invoices.view", "acc_receipts.create") }, async (req) => {
    const q = req.query as { kind?: string; customerId?: string; status?: string; q?: string; from?: string; to?: string; page?: string; pageSize?: string };
    const page = parsePage(q);
    const kind = ["invoice", "credit_note", "debit_note", "prepayment"].includes(q.kind ?? "") ? q.kind : null;
    const customer = isUuid(q.customerId) ? q.customerId : null;
    const from = ISO.test(q.from ?? "") ? q.from : null;
    const to = ISO.test(q.to ?? "") ? q.to : null;
    const search = q.q?.trim() ? `%${q.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const unpaid = q.status === "unpaid";
    return tenantTx(req, async (db) => {
      const { rows } = await db.query(
        `WITH d AS (
           SELECT d.id, d.kind, d.invoice_type AS "invoiceType", d.doc_number AS "number", d.issue_date::text AS "issueDate", d.due_date::text AS "dueDate",
                  d.total::float8 AS total, d.vat::float8 AS vat, d.payment_means AS "paymentMeans", c.name AS "customerName", d.customer_id AS "customerId",
                  CASE WHEN d.kind <> 'invoice' THEN NULL ELSE
                    d.total - coalesce((SELECT sum(n.total) FROM sales_documents n WHERE n.original_id = d.id AND n.kind = 'credit_note'), 0)
                            + coalesce((SELECT sum(n.total) FROM sales_documents n WHERE n.original_id = d.id AND n.kind = 'debit_note'), 0)
                            - d.prepaid_amount - d.retention_amount
                            - CASE WHEN d.payment_means = 'credit' THEN coalesce((SELECT sum(r.amount) FROM customer_receipts r WHERE r.document_id = d.id), 0) ELSE d.total - d.prepaid_amount - d.retention_amount END
                  END::float8 AS balance
             FROM sales_documents d LEFT JOIN customers c ON c.id = d.customer_id
            WHERE ($1::text IS NULL OR d.kind = $1) AND ($2::uuid IS NULL OR d.customer_id = $2)
              AND ($3::date IS NULL OR d.issue_date >= $3::date) AND ($4::date IS NULL OR d.issue_date <= $4::date)
              AND ($5::text IS NULL OR d.doc_number ILIKE $5 OR c.name ILIKE $5))
         SELECT *, count(*) OVER()::int AS "_total" FROM d WHERE NOT $6 OR balance > 0
          ORDER BY "issueDate" DESC, number DESC LIMIT $7 OFFSET $8`,
        [kind, customer, from, to, search, unpaid, page.pageSize, page.offset]);
      return { items: rows.map(({ _total, ...r }) => r), meta: pageMeta(page, rows[0]?._total ?? 0) };
    }, { readOnly: true });
  });

  app.get("/sales-documents/:id", { preHandler: requireTenant("acc_invoices.view", "acc_receipts.create") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const d = (await db.query(
        `SELECT d.id, d.kind, d.invoice_type AS "invoiceType", d.doc_number AS "number", d.uuid, d.issue_date::text AS "issueDate", d.issued_at AS "issuedAt",
                d.supply_date::text AS "supplyDate", d.due_date::text AS "dueDate", d.reason, d.payment_means AS "paymentMeans", d.notes,
                d.subtotal::float8 AS subtotal, d.discount::float8 AS discount, d.taxable::float8 AS taxable, d.vat::float8 AS vat, d.total::float8 AS total,
                d.prepaid_amount::float8 AS "prepaidAmount", d.is_export AS "isExport", d.sales_order_id AS "salesOrderId",
                d.retention_amount::float8 AS "retentionAmount", d.contract_id AS "contractId",
                d.seller, d.buyer, d.qr_base64 AS qr, d.customer_id AS "customerId", d.original_id AS "originalId", o.doc_number AS "originalNumber", o.issue_date::text AS "originalDate"
           FROM sales_documents d LEFT JOIN sales_documents o ON o.id = d.original_id WHERE d.id = $1`, [id])).rows[0];
      if (!d) throw notFound("المستند غير موجود");
      const lines = (await db.query(
        `SELECT line_no AS "lineNo", description, quantity::float8 AS quantity, unit_price::float8 AS "unitPrice", discount::float8 AS discount, net::float8 AS net,
                vat_category AS "vatCategory", vat_rate::float8 AS "vatRate", exemption_code AS "exemptionCode", exemption_reason AS "exemptionReason",
                vat::float8 AS vat, total::float8 AS total FROM sales_document_lines WHERE document_id = $1 ORDER BY line_no`, [id])).rows;
      const notes = (await db.query(`SELECT id, kind, doc_number AS "number", issue_date::text AS "issueDate", total::float8 AS total, reason FROM sales_documents WHERE original_id = $1 ORDER BY issued_at`, [id])).rows;
      const receipts = (await db.query(`SELECT id, receipt_number::int AS "number", received_on::text AS "receivedOn", amount::float8 AS amount, method FROM customer_receipts WHERE document_id = $1 ORDER BY received_on`, [id])).rows;
      const cents = (v: number) => Math.round(v * 100);
      const credits = notes.filter((n) => n.kind === "credit_note").reduce((s, n) => s + cents(n.total), 0);
      const debits = notes.filter((n) => n.kind === "debit_note").reduce((s, n) => s + cents(n.total), 0);
      const prepaid = cents(d.prepaidAmount);
      const retained = cents(d.retentionAmount);
      const paid = d.paymentMeans === "credit" ? receipts.reduce((s, r) => s + cents(r.amount), 0) : cents(d.total) - prepaid - retained;
      const balance = d.kind === "invoice" ? (cents(d.total) - credits + debits - prepaid - retained - paid) / 100 : null;
      const prepayments = (await db.query(
        `SELECT p.id, p.doc_number AS "number", p.issue_date::text AS "issueDate", a.taxable::float8 AS taxable, a.vat::float8 AS vat
           FROM prepayment_applications a JOIN sales_documents p ON p.id = a.prepayment_id WHERE a.invoice_id = $1 ORDER BY p.issued_at`, [id])).rows;
      return { ...d, prepayments, kindLabel: KIND_AR[d.kind as keyof typeof KIND_AR], lines, related: notes, receipts, balance, zatca: await zatcaStateOf(db, "sales_document", id) };
    }, { readOnly: true });
  });

  app.post("/sales-documents", { preHandler: requireTenant("acc_invoices.create") }, async (req, reply) => {
    const key = idempotencyKey(req);
    const b = docSchema.parse(req.body);
    const out = await tenantTx(req, (db) => issueSalesDocument(db, b, key, req));
    const zatca = await sendToZatca(req, b.invoiceType, out);
    return reply.status(out.replay ? 200 : 201).send({ id: out.id, number: out.number, zatca });
  });

  // ── Receipts ────────────────────────────────────────────────────────────────────────────────
  app.get("/customer-receipts", { preHandler: requireTenant("acc_receipts.view") }, async (req) => {
    const q = req.query as { customerId?: string; page?: string; pageSize?: string };
    const page = parsePage(q);
    const customer = isUuid(q.customerId) ? q.customerId : null;
    return tenantTx(req, async (db) => {
      const { rows } = await db.query(
        `SELECT r.id, r.receipt_number::int AS "number", r.received_on::text AS "receivedOn", r.amount::float8 AS amount, r.method, r.reference,
                c.name AS "customerName", d.doc_number AS "documentNumber", count(*) OVER()::int AS "_total"
           FROM customer_receipts r JOIN customers c ON c.id = r.customer_id LEFT JOIN sales_documents d ON d.id = r.document_id
          WHERE $1::uuid IS NULL OR r.customer_id = $1 ORDER BY r.received_on DESC, r.receipt_number DESC LIMIT $2 OFFSET $3`, [customer, page.pageSize, page.offset]);
      return { items: rows.map(({ _total, ...r }) => r), meta: pageMeta(page, rows[0]?._total ?? 0) };
    }, { readOnly: true });
  });

  app.post("/customer-receipts", { preHandler: requireTenant("acc_receipts.create") }, async (req, reply) => {
    const key = idempotencyKey(req);
    const b = z.object({
      customerId: z.string().uuid("اختر العميل"),
      documentId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
      receivedOn: z.string().regex(ISO, "تاريخ غير صحيح"),
      amount: z.number().positive("المبلغ أكبر من صفر").max(100_000_000),
      method: z.enum(["cash", "bank_transfer", "cheque", "card"]),
      reference: z.string().trim().max(80).nullable().optional().transform((v) => v || null),
      notes: z.string().trim().max(500).nullable().optional().transform((v) => v || null),
    }).parse(req.body);
    if (b.receivedOn > today()) throw badRequest("تاريخ القبض لا يكون في المستقبل");
    const out = await tenantTx(req, async (db) => {
      const dup = (await db.query<{ id: string }>("SELECT id FROM customer_receipts WHERE idempotency_key = $1", [key])).rows[0];
      if (dup) return { id: dup.id, replay: true };
      if (!(await db.query("SELECT 1 FROM customers WHERE id = $1", [b.customerId])).rowCount) throw notFound("العميل غير موجود");
      if (b.documentId) {
        await db.query("SELECT pg_advisory_xact_lock(hashtext('sales_document:' || $1))", [b.documentId]);
        const d = (await db.query<{ customer_id: string | null; kind: string; payment_means: string; balance: string }>(
          `SELECT d.customer_id, d.kind, d.payment_means,
                  (d.total - coalesce((SELECT sum(n.total) FROM sales_documents n WHERE n.original_id = d.id AND n.kind = 'credit_note'), 0)
                           + coalesce((SELECT sum(n.total) FROM sales_documents n WHERE n.original_id = d.id AND n.kind = 'debit_note'), 0)
                           - d.prepaid_amount - d.retention_amount - coalesce((SELECT sum(r.amount) FROM customer_receipts r WHERE r.document_id = d.id), 0))::text AS balance
             FROM sales_documents d WHERE d.id = $1`, [b.documentId])).rows[0];
        if (!d || d.kind !== "invoice") throw notFound("الفاتورة غير موجودة");
        if (d.customer_id !== b.customerId) throw badRequest("الفاتورة لا تخص هذا العميل");
        if (d.payment_means !== "credit") throw new AppError(409, "already_paid", "هذه الفاتورة مدفوعة عند الإصدار");
        if (parseMoney(b.amount) > parseMoney(d.balance)) throw new AppError(409, "receipt_exceeds_balance", `المبلغ أكبر من المتبقي على الفاتورة (${riyal(parseMoney(d.balance))})`);
      }
      const n = (await db.query<{ n: string }>("SELECT next_counter('customer_receipt')::text AS n")).rows[0]!.n;
      const r = await db.query<{ id: string }>(
        `INSERT INTO customer_receipts (tenant_id, receipt_number, customer_id, document_id, received_on, amount, method, reference, notes, idempotency_key, created_by)
         VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, app_user_id()) RETURNING id`,
        [n, b.customerId, b.documentId, b.receivedOn, formatMoney(parseMoney(b.amount)), b.method, b.reference, b.notes, key]);
      const id = r.rows[0]!.id;
      await postCustomerReceipt(db, id);
      await auditTenant(db, req, "customer_receipt.created", "customer_receipt", id, { amount: b.amount });
      return { id, replay: false };
    });
    return reply.status(out.replay ? 200 : 201).send({ id: out.id });
  });
}
