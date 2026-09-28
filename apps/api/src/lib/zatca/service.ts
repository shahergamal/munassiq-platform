import { randomUUID } from "node:crypto";
import { config } from "../../config.ts";
import { withTenantTx, type Db, type TenantCtx } from "../../db/pool.ts";
import { AppError } from "../errors.ts";
import { parseMoney, percentToBp, splitGross, vatOf } from "../money.ts";
import { certificateInfo } from "./cert.ts";
import { buildCsr, generateKeys, type ZatcaEnvironment } from "./csr.ts";
import { INITIAL_PIH, signDocument } from "./sign.ts";
import { documentProblems, type Party, type UblDocument, type UblLine } from "./ubl.ts";
import { open, seal } from "./vault.ts";

/**
 * ZATCA Phase 2 for one workspace: onboarding its own e-invoicing device (the owner enters an OTP from the
 * Fatoora portal; no platform credentials are involved), stamping each document inside the business transaction
 * (so the chain can never skip or fork), and submitting it: clearance for standard invoices, reporting within
 * 24 hours for simplified ones. Network calls happen outside database transactions.
 */

export const BASE: Record<ZatcaEnvironment, string> = {
  sandbox: "https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal",
  simulation: "https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation",
  production: "https://gw-fatoora.zatca.gov.sa/e-invoicing/core",
};

export interface ZatcaReply { status: number; body: any }
export type Transport = (env: ZatcaEnvironment, method: "POST" | "PATCH", path: string, headers: Record<string, string>, body: unknown) => Promise<ZatcaReply>;

const httpTransport: Transport = async (env, method, path, headers, body) => {
  const r = await fetch(BASE[env] + path, {
    method,
    headers: { Accept: "application/json", "Content-Type": "application/json", "Accept-Version": "V2", "Accept-Language": "ar", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 2000) }; }
  return { status: r.status, body: parsed };
};
let transport: Transport = httpTransport;
/** Tests replace the network with a stand-in for ZATCA. */
export function setZatcaTransport(t: Transport | null) { transport = t ?? httpTransport; }

const secret = () => config.ZATCA_KEY_SECRET ?? config.SESSION_SECRET;
const basic = (token: string, pass: string) => `Basic ${Buffer.from(`${token}:${pass}`, "utf8").toString("base64")}`;

/** ZATCA's validation messages (errors first), as plain text. */
export function zatcaMessages(body: any): { errors: string[]; warnings: string[] } {
  const v = body?.validationResults ?? {};
  const list = (x: any) => (Array.isArray(x) ? x : x ? [x] : []).map((m: any) => [m.code, m.message].filter(Boolean).join(": ")).filter(Boolean);
  const errors = [...list(v.errorMessages), ...(Array.isArray(body?.errors) ? body.errors.map((e: any) => (typeof e === "string" ? e : e?.message ?? JSON.stringify(e))) : [])];
  if (!errors.length && body?.message) errors.push(String(body.message));
  return { errors, warnings: list(v.warningMessages) };
}

// ── Seller ────────────────────────────────────────────────────────────────────────────────────
export async function seller(db: Db): Promise<{ party: Party; problems: string[]; companyName: string }> {
  const r = (await db.query<{ company_name: string; tax_id: string; legal_name: string | null; cr_number: string | null; street: string | null; building_no: string | null; additional_no: string | null; district: string | null; city: string | null; postal_code: string | null }>(
    `SELECT t.company_name, t.tax_id, p.legal_name, p.cr_number, p.street, p.building_no, p.additional_no, p.district, p.city, p.postal_code
       FROM tenants t LEFT JOIN tax_profiles p ON p.tenant_id = t.id`)).rows[0]!;
  const problems: string[] = [];
  if (!/^3\d{13}3$/.test(r.tax_id)) problems.push("الرقم الضريبي للمنشأة يجب أن يكون 15 رقماً يبدأ وينتهي بـ 3");
  if (!r.legal_name) problems.push("أكمل بيانات المنشأة الضريبية (الاسم النظامي والعنوان الوطني)");
  else if (!r.cr_number) problems.push("أضف رقم السجل التجاري في بيانات المنشأة الضريبية");
  return {
    companyName: r.company_name,
    problems,
    party: {
      name: r.legal_name ?? r.company_name, vatNumber: r.tax_id, idScheme: r.cr_number ? "CRN" : null, id: r.cr_number,
      street: r.street, buildingNo: r.building_no, additionalNo: r.additional_no, district: r.district, city: r.city, postalCode: r.postal_code, countryCode: "SA",
    },
  };
}

// ── Onboarding ────────────────────────────────────────────────────────────────────────────────
export interface OnboardInput {
  environment: ZatcaEnvironment;
  otp: string;
  /** "1100" standard + simplified, "0100" simplified only, "1000" standard only. */
  invoiceTypes: "1100" | "0100" | "1000";
  organizationUnit: string;
  location: string;
  industry: string;
  /** The branch this device signs for; null = every branch without a device of its own. */
  branchId?: string | null;
}

/** The sample documents ZATCA's compliance step expects for the declared invoice types. */
function complianceSamples(types: string, s: Party, now: Date): UblDocument[] {
  const buyer: Party = { name: "شركة اختبار الامتثال", vatNumber: "399999999800003", street: "طريق الملك فهد", buildingNo: "1111", district: "العليا", city: "الرياض", postalCode: "12211", countryCode: "SA" };
  const line: UblLine = { id: 1, name: "وجبة اختبار", quantity: 1, unitPrice: 10000, lineExtension: 10000, category: "S", rate: 15, vat: 1500 };
  const base = (invoiceType: "standard" | "simplified", kind: UblDocument["kind"], n: number): UblDocument => ({
    kind, invoiceType, number: `CMP-${n}`, uuid: randomUUID(), issuedAt: now, supplyDate: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh" }).format(now),
    icv: n, pih: INITIAL_PIH, seller: s, buyer: invoiceType === "standard" ? buyer : { name: "عميل نقدي" },
    billingReference: kind === "invoice" ? null : `CMP-${invoiceType === "standard" ? 1 : 4}`, reason: kind === "invoice" ? null : "تعديل على الفاتورة الأصلية",
    paymentMeans: "cash", lines: [line], allowances: [],
    subtotals: [{ category: "S", rate: 15, taxable: 10000, vat: 1500 }],
    totals: { lineExtension: 10000, allowance: 0, taxExclusive: 10000, vat: 1500, taxInclusive: 11500, payable: 11500 },
  });
  const out: UblDocument[] = [];
  if (types[0] === "1") out.push(base("standard", "invoice", 1), base("standard", "credit_note", 2), base("standard", "debit_note", 3));
  if (types[1] === "1") out.push(base("simplified", "invoice", 4), base("simplified", "credit_note", 5), base("simplified", "debit_note", 6));
  return out;
}

const KIND_AR = { invoice: "فاتورة", credit_note: "إشعار دائن", debit_note: "إشعار مدين", prepayment: "فاتورة دفعة مقدمة" } as const;

export interface ComplianceResult { document: string; ok: boolean; status: number; errors: string[]; warnings: string[] }
export type ComplianceOutcome =
  | { ok: true; requestId: string; token: string; secret: string; results: ComplianceResult[] }
  | { ok: false; stage: "csid" | "checks"; message: string; requestId?: string; token?: string; secret?: string; results: ComplianceResult[] };

/**
 * Steps 1 and 2 of onboarding, with no database: the compliance CSID for the CSR (with the owner's OTP), then one
 * signed sample per declared document type sent to ZATCA's compliance check. Used by onboarding and by the live
 * check against the developer portal (scripts/zatca-live-check.ts).
 */
export async function runCompliance(env: ZatcaEnvironment, otp: string, csrPem: string, invoiceTypes: string, party: Party, privateKeyPem: string): Promise<ComplianceOutcome> {
  let cc: ZatcaReply;
  try {
    cc = await transport(env, "POST", "/compliance", { OTP: otp }, { csr: Buffer.from(csrPem, "utf8").toString("base64") });
  } catch {
    return { ok: false, stage: "csid", message: "تعذر الاتصال بمنصة فاتورة. تحقق من اتصال الخادم بالإنترنت ثم أعد المحاولة برمز جديد", results: [] };
  }
  if (cc.status !== 200 || !cc.body?.binarySecurityToken) {
    const m = zatcaMessages(cc.body).errors;
    return { ok: false, stage: "csid", results: [], message: cc.status === 400 || cc.status === 401
      ? `رفضت الهيئة الطلب: ${m.join("، ") || "تحقق من رمز التحقق (OTP) وصلاحيته (ساعة واحدة) وأنه من بيئة المنصة الصحيحة"}` : `خطأ من منصة فاتورة (${cc.status}): ${m.join("، ")}` };
  }
  const token: string = cc.body.binarySecurityToken;
  const sec: string = cc.body.secret;
  const requestId = String(cc.body.requestID);
  const cert = Buffer.from(token, "base64").toString("utf8");
  const auth = basic(token, sec);
  const results: ComplianceResult[] = [];
  for (const d of complianceSamples(invoiceTypes, party, new Date())) {
    const signed = signDocument(d, cert, privateKeyPem);
    let r: ZatcaReply;
    try {
      r = await transport(env, "POST", "/compliance/invoices", { Authorization: auth },
        { invoiceHash: signed.invoiceHash, uuid: d.uuid, invoice: Buffer.from(signed.xml, "utf8").toString("base64") });
    } catch {
      return { ok: false, stage: "checks", message: "انقطع الاتصال بمنصة فاتورة أثناء اختبارات الامتثال. أعد المحاولة", requestId, token, secret: sec, results };
    }
    const m = zatcaMessages(r.body);
    results.push({ document: `${KIND_AR[d.kind]} ${d.invoiceType === "standard" ? "ضريبية" : "مبسطة"}`, ok: r.status === 200 || r.status === 202, status: r.status, ...m });
  }
  if (results.some((x) => !x.ok)) return { ok: false, stage: "checks", message: "لم تجتز الأجهزة اختبارات الامتثال لدى الهيئة. التفاصيل في نتائج الاختبارات", requestId, token, secret: sec, results };
  return { ok: true, requestId, token, secret: sec, results };
}

export async function onboard(ctx: TenantCtx, input: OnboardInput) {
  const deviceId = randomUUID();
  const keys = generateKeys();
  const branchId = input.branchId ?? null;
  const s = await withTenantTx(ctx, async (db) => {
    const sel = await seller(db);
    if (sel.problems.length) throw new AppError(409, "zatca_not_ready", sel.problems.join("، "));
    // Each branch's device has its own name in ZATCA's records (the branch code in the common name).
    const branch = branchId ? (await db.query<{ code: string }>("SELECT code FROM branches WHERE id = $1 AND is_active", [branchId])).rows[0] : null;
    if (branchId && !branch) throw new AppError(404, "not_found", "الفرع غير موجود أو موقوف");
    const commonName = `MUNASSIQ-${ctx.tenantId.slice(0, 8)}${branch ? `-${branch.code}` : ""}-${sel.party.vatNumber}`;
    const csr = buildCsr({
      environment: input.environment, commonName,
      organizationUnit: input.organizationUnit, organization: sel.party.name, vatNumber: sel.party.vatNumber!,
      serialNumber: `1-Munassiq|2-1.0|3-${deviceId}`, invoiceTypes: input.invoiceTypes, location: input.location, industry: input.industry,
    }, keys.privateKeyPem);
    await db.query(
      `INSERT INTO zatca_devices (id, tenant_id, environment, common_name, serial_number, organization_unit, invoice_types, location, industry, private_key_enc, csr_pem, branch_id, created_by)
       VALUES ($1, app_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, app_user_id())`,
      [deviceId, input.environment, commonName, `1-Munassiq|2-1.0|3-${deviceId}`, input.organizationUnit,
        input.invoiceTypes, input.location, input.industry, seal(keys.privateKeyPem, secret()), csr.pem, branchId]);
    return { ...sel, csrPem: csr.pem };
  });
  const fail = async (message: string, results?: unknown) => {
    await withTenantTx(ctx, (db) => db.query("UPDATE zatca_devices SET status = 'failed', failure = $2, compliance_results = coalesce($3, compliance_results) WHERE id = $1",
      [deviceId, message.slice(0, 2000), results ? JSON.stringify(results) : null]));
    return new AppError(422, "zatca_onboarding_failed", message, { deviceId, results });
  };

  // 1-2. Compliance CSID with the owner's OTP, then ZATCA's compliance checks.
  const c = await runCompliance(input.environment, input.otp, s.csrPem, input.invoiceTypes, s.party, keys.privateKeyPem);
  if (c.token && c.secret) {
    const [token, sec] = [c.token, c.secret];
    await withTenantTx(ctx, (db) => db.query(
      "UPDATE zatca_devices SET compliance_request_id = $2, compliance_token = $3, compliance_secret_enc = $4 WHERE id = $1",
      [deviceId, c.requestId, token, seal(sec, secret())]));
  }
  if (!c.ok) throw await fail(c.message, c.results.length ? c.results : undefined);
  const results = c.results;
  const auth = basic(c.token, c.secret);

  // 3. Production CSID.
  let pc: ZatcaReply;
  try {
    pc = await transport(input.environment, "POST", "/production/csids", { Authorization: auth }, { compliance_request_id: c.requestId });
  } catch {
    throw await fail("انقطع الاتصال بمنصة فاتورة عند طلب شهادة الإنتاج. أعد المحاولة", results);
  }
  if (pc.status !== 200 || !pc.body?.binarySecurityToken) throw await fail(`تعذر إصدار شهادة الإنتاج: ${zatcaMessages(pc.body).errors.join("، ") || pc.status}`, results);
  const productionCert = Buffer.from(pc.body.binarySecurityToken, "base64").toString("utf8");
  const info = certificateInfo(productionCert);

  // 4. Activate: the previous device of the same branch (if any) retires; the new chain starts from ICV 1.
  return withTenantTx(ctx, async (db) => {
    await db.query("UPDATE zatca_devices SET status = 'retired' WHERE status = 'active' AND branch_id IS NOT DISTINCT FROM $1", [branchId]);
    await db.query(
      `UPDATE zatca_devices SET status = 'active', production_token = $2, production_secret_enc = $3, certificate = $4, certificate_expires_at = $5,
              compliance_results = $6, failure = NULL, onboarded_at = now() WHERE id = $1`,
      [deviceId, pc.body.binarySecurityToken, seal(pc.body.secret, secret()), productionCert, info.validTo, JSON.stringify(results)]);
    return { deviceId, results, certificateExpiresAt: info.validTo };
  });
}

// ── Stamping inside the business transaction ──────────────────────────────────────────────────
interface DeviceRow { id: string; environment: ZatcaEnvironment; invoice_types: string; private_key_enc: string; certificate: string; last_icv: string; last_hash: string }

export type StampInput = Omit<UblDocument, "icv" | "pih" | "seller" | "uuid"> & {
  sourceType: "sales_document" | "pos_order" | "pos_refund"; sourceId: string; uuid?: string;
  /** The branch the document belongs to: its own device signs it, or the workspace-wide device. */
  branchId?: string | null;
};

/**
 * Signs the next document of this workspace's active device and records it, advancing the chain in the same
 * transaction as the sale/invoice. Returns null when no device is active (Phase 1: the plain QR applies).
 */
export async function stamp(db: Db, input: StampInput) {
  const problems = documentProblems(input);
  if (problems.length) throw new AppError(422, "zatca_document_invalid", problems.join("، "));
  const dev = (await db.query<DeviceRow>(
    `SELECT id, environment, invoice_types, private_key_enc, certificate, last_icv::text, last_hash FROM zatca_devices
      WHERE status = 'active' AND (branch_id = $1 OR branch_id IS NULL) ORDER BY branch_id NULLS LAST LIMIT 1 FOR UPDATE`, [input.branchId ?? null])).rows[0];
  if (!dev) return null;
  const allowed = input.invoiceType === "standard" ? dev.invoice_types[0] === "1" : dev.invoice_types[1] === "1";
  if (!allowed) throw new AppError(409, "zatca_type_not_enabled", input.invoiceType === "standard"
    ? "جهاز الفوترة مسجَّل للفواتير المبسطة فقط. أعد التسجيل مع تفعيل الفواتير الضريبية (بين المنشآت)"
    : "جهاز الفوترة مسجَّل للفواتير الضريبية فقط. أعد التسجيل مع تفعيل الفواتير المبسطة");
  const s = await seller(db);
  const icv = Number(dev.last_icv) + 1;
  const uuid = input.uuid ?? randomUUID();
  const { sourceType, sourceId, branchId: _branch, ...ubl } = input;
  const signed = signDocument({ ...ubl, uuid, icv, pih: dev.last_hash, seller: s.party }, dev.certificate, open(dev.private_key_enc, secret()));
  const doc = await db.query<{ id: string }>(
    `INSERT INTO zatca_documents (tenant_id, device_id, source_type, source_id, doc_number, kind, invoice_type, uuid, icv, pih, invoice_hash, xml, qr_base64)
     VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [dev.id, sourceType, sourceId, input.number, input.kind, input.invoiceType, uuid, icv, dev.last_hash, signed.invoiceHash, signed.xml, signed.qr]);
  await db.query("UPDATE zatca_devices SET last_icv = $2, last_hash = $3 WHERE id = $1", [dev.id, icv, signed.invoiceHash]);
  return { documentId: doc.rows[0]!.id, qr: signed.qr, invoiceHash: signed.invoiceHash, uuid, environment: dev.environment };
}

const RIYADH = "Asia/Riyadh";

/** A point-of-sale order as a simplified tax invoice (order discount as a document-level allowance). */
export async function stampPosOrder(db: Db, orderId: string) {
  const o = (await db.query<{ order_number: string; created_at: Date; subtotal: string; discount: string; taxable: string; vat: string; total: string; customer: string | null; method: string | null; rate: string; branch_id: string | null }>(
    `SELECT o.order_number::text, o.created_at, (SELECT l.branch_id FROM locations l WHERE l.id = o.location_id) AS branch_id, o.subtotal::text, o.discount::text, o.taxable::text, o.vat::text, o.total::text,
            coalesce(c.name, nullif(trim(o.customer_name), '')) AS customer,
            (SELECT CASE WHEN count(DISTINCT p.method) = 1 THEN min(p.method) END FROM pos_payments p WHERE p.order_id = o.id) AS method,
            (SELECT vat_rate_percent::text FROM tenant_settings) AS rate
       FROM pos_orders o LEFT JOIN customers c ON c.id = o.customer_id WHERE o.id = $1`, [orderId])).rows[0];
  if (!o) return null;
  const rate = Number(o.rate);
  // unit_price_net already includes the modifiers; line_net = unit × quantity, before the order discount.
  const items = (await db.query<{ name: string; quantity: number; unit: string; net: string }>(
    `SELECT i.name_snapshot || coalesce(' + ' || (SELECT string_agg(m.name_snapshot, ' + ') FROM pos_order_item_modifiers m WHERE m.order_item_id = i.id), '') AS name,
            i.quantity, i.unit_price_net::text AS unit, i.line_net::text AS net
       FROM pos_order_items i WHERE i.order_id = $1 ORDER BY i.id`, [orderId])).rows;
  const lines: UblLine[] = items.map((it, n) => {
    const ext = parseMoney(it.net);
    return { id: n + 1, name: it.name, quantity: it.quantity, unitPrice: parseMoney(it.unit), lineExtension: ext, category: "S", rate, vat: vatOf(ext, percentToBp(rate)) };
  });
  const means = o.method === "cash" ? "cash" : o.method && ["mada", "visa", "mastercard"].includes(o.method) ? "card" : "other";
  return stamp(db, {
    sourceType: "pos_order", sourceId: orderId, branchId: o.branch_id, kind: "invoice", invoiceType: "simplified", number: `POS-${o.order_number}`, issuedAt: o.created_at,
    buyer: { name: o.customer ?? "عميل نقدي" }, paymentMeans: means, lines,
    allowances: [{ category: "S", rate, amount: parseMoney(o.discount) }],
    subtotals: [{ category: "S", rate, taxable: parseMoney(o.taxable), vat: parseMoney(o.vat) }],
    totals: { lineExtension: parseMoney(o.subtotal), allowance: parseMoney(o.discount), taxExclusive: parseMoney(o.taxable), vat: parseMoney(o.vat), taxInclusive: parseMoney(o.total), payable: parseMoney(o.total) },
  });
}

/** A point-of-sale refund as a simplified credit note on the original order. */
export async function stampPosRefund(db: Db, refundId: string) {
  const r = (await db.query<{ order_number: string; created_at: Date; amount: string; reason: string; method: string; rate: string; branch_id: string | null }>(
    `SELECT o.order_number::text, r.created_at, (SELECT l.branch_id FROM locations l WHERE l.id = o.location_id) AS branch_id, r.amount::text, r.reason, r.method, (SELECT vat_rate_percent::text FROM tenant_settings) AS rate
       FROM pos_refunds r JOIN pos_orders o ON o.id = r.order_id WHERE r.id = $1`, [refundId])).rows[0];
  if (!r) return null;
  const rate = Number(r.rate);
  const split = splitGross(parseMoney(r.amount), percentToBp(rate));
  const n = (await db.query<{ n: string }>("SELECT next_counter('pos_credit_note')::text AS n")).rows[0]!.n;
  return stamp(db, {
    sourceType: "pos_refund", sourceId: refundId, branchId: r.branch_id, kind: "credit_note", invoiceType: "simplified", number: `PCN-${n.padStart(6, "0")}`, issuedAt: r.created_at,
    buyer: { name: "عميل نقدي" }, billingReference: `POS-${r.order_number}`, reason: r.reason,
    paymentMeans: r.method === "cash" ? "cash" : ["mada", "visa", "mastercard"].includes(r.method) ? "card" : "other",
    lines: [{ id: 1, name: `استرجاع على الطلب ${r.order_number}`, quantity: 1, unitPrice: split.net, lineExtension: split.net, category: "S", rate, vat: split.vat }],
    allowances: [],
    subtotals: [{ category: "S", rate, taxable: split.net, vat: split.vat }],
    totals: { lineExtension: split.net, allowance: 0, taxExclusive: split.net, vat: split.vat, taxInclusive: split.net + split.vat, rounding: split.rounding, payable: split.net + split.vat + split.rounding },
  });
}

// ── Submission (outside any transaction) ──────────────────────────────────────────────────────
type Outcome = "accepted" | "accepted_with_warnings" | "rejected" | "error";

export async function submit(ctx: TenantCtx, documentId: string) {
  const d = await withTenantTx(ctx, async (db) => (await db.query<{ invoice_type: string; uuid: string; invoice_hash: string; xml: string; environment: ZatcaEnvironment; token: string | null; secret_enc: string | null }>(
    `SELECT d.invoice_type, d.uuid, d.invoice_hash, d.xml, v.environment, v.production_token AS token, v.production_secret_enc AS secret_enc
       FROM zatca_documents d JOIN zatca_devices v ON v.id = d.device_id WHERE d.id = $1`, [documentId])).rows[0], { readOnly: true });
  if (!d) throw new AppError(404, "not_found", "المستند غير موجود");
  if (!d.token || !d.secret_enc) throw new AppError(409, "zatca_device_inactive", "جهاز الفوترة غير مفعّل");
  const auth = basic(d.token, open(d.secret_enc, secret()));
  const body = { invoiceHash: d.invoice_hash, uuid: d.uuid, invoice: Buffer.from(d.xml, "utf8").toString("base64") };
  let mode: "clearance" | "reporting" = d.invoice_type === "standard" ? "clearance" : "reporting";
  let reply: ZatcaReply | null = null;
  try {
    reply = await transport(d.environment, "POST", mode === "clearance" ? "/invoices/clearance/single" : "/invoices/reporting/single", { Authorization: auth, "Clearance-Status": mode === "clearance" ? "1" : "0" }, body);
    // 303: clearance is switched off by ZATCA; the standard document goes to reporting instead.
    if (reply.status === 303 && mode === "clearance") {
      mode = "reporting";
      reply = await transport(d.environment, "POST", "/invoices/reporting/single", { Authorization: auth, "Clearance-Status": "0" }, body);
    }
  } catch {
    reply = null;
  }
  const status = reply?.status ?? null;
  // 409 = this exact hash was already accepted: a retry after a lost response.
  const outcome: Outcome = status === 200 || status === 409 ? "accepted" : status === 202 ? "accepted_with_warnings" : status === 400 ? "rejected" : "error";
  const cleared = mode === "clearance" && reply?.body?.clearedInvoice ? Buffer.from(reply.body.clearedInvoice, "base64").toString("utf8") : null;
  await withTenantTx(ctx, (db) => db.query(
    "INSERT INTO zatca_submissions (tenant_id, document_id, mode, http_status, outcome, response, cleared_xml) VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6)",
    [documentId, mode, status, outcome, reply ? JSON.stringify(reply.body ?? null) : JSON.stringify({ error: "network" }), cleared]));
  return { outcome, mode, httpStatus: status, ...zatcaMessages(reply?.body) };
}

/** Documents never accepted or rejected (not sent yet, or the last try failed on the network), oldest first. */
export async function submitPending(ctx: TenantCtx, limit = 25) {
  const ids = await withTenantTx(ctx, async (db) => (await db.query<{ id: string }>(
    `SELECT d.id FROM zatca_documents d
      WHERE NOT EXISTS (SELECT 1 FROM zatca_submissions s WHERE s.document_id = d.id AND s.outcome <> 'error')
      ORDER BY d.icv LIMIT $1`, [limit])).rows.map((r) => r.id), { readOnly: true });
  const tally = { accepted: 0, accepted_with_warnings: 0, rejected: 0, error: 0 };
  for (const id of ids) tally[(await submit(ctx, id)).outcome]++;
  return { attempted: ids.length, ...tally };
}

const lastSweep = new Map<string, number>();

/**
 * Reports a document right after it is issued, without making the till wait. When that works, anything still
 * pending for the workspace (a sale made while the link was down) is resent too, at most every 5 minutes, so the
 * 24-hour reporting window is kept by normal trading, without a job that reaches across workspaces.
 */
export function submitSoon(ctx: TenantCtx, documentId: string, log: (err: unknown) => void) {
  setImmediate(() => {
    submit(ctx, documentId).then((r) => {
      if (r.outcome === "error" || Date.now() - (lastSweep.get(ctx.tenantId) ?? 0) < 5 * 60_000) return;
      lastSweep.set(ctx.tenantId, Date.now());
      return submitPending(ctx, 10);
    }).catch(log);
  });
}
