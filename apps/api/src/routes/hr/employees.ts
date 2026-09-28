import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { postFinalSettlement } from "../../lib/accounting/posting.ts";
import { AppError, badRequest, notFound } from "../../lib/errors.ts";
import { likePattern } from "../../lib/pagination.ts";
import { dailyWage, endOfService, fixedWage, gosiBase, gosiScheme, h, ibanInfo, type Pay } from "../../lib/hr/payroll.ts";
import { ensurePayrollAccounts, openHr, sealHr } from "../../lib/hr/seal.ts";
import { EMPLOYEE_COLS, eosProvisioned, gosiRate, leaveBalances, payOf, type EmployeeRow } from "../../lib/hr/service.ts";
import { auditTenant, isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";
import { today } from "../restaurants/batches.ts";
import { idempotencyKey } from "../restaurants/purchases.ts";

// Employees for every sector (ARCHITECTURE.md, M7). Identity numbers, IBANs and pay are sealed at field level and
// opened only for `employees.view_pay`; everyone else with `employees.view` sees the job data and the alerts.

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح");
const optDate = date.nullable().optional().transform((v) => v ?? null);
const money = z.number().min(0).max(1_000_000);
const payBody = z.object({
  basic: money.refine((v) => v > 0, "أدخل الراتب الأساسي"),
  housing: money.default(0),
  housingInKind: z.boolean().default(false),
  transport: money.default(0),
  other: money.default(0),
  gosiRegisteredWage: money.nullable().optional().transform((v) => v ?? null),
});
const body = z.object({
  code: z.string().trim().regex(/^[A-Za-z0-9-]{1,20}$/, "الرقم الوظيفي حروف إنجليزية وأرقام وشرطة"),
  name: z.string().trim().min(2, "أدخل الاسم").max(120),
  nameEn: z.string().trim().max(120).nullable().optional().transform((v) => v || null),
  gender: z.enum(["male", "female"]),
  nationality: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "رمز الدولة حرفان (SA للسعودي)"),
  idType: z.enum(["national_id", "iqama", "border_number", "passport"]),
  idNumber: z.string().trim().min(4).max(20).optional(),
  idExpiry: optDate, passportExpiry: optDate, birthDate: optDate,
  jobTitle: z.string().trim().min(2, "أدخل المسمى الوظيفي").max(120),
  occupationCode: z.string().trim().max(20).nullable().optional().transform((v) => v || null),
  branchId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
  costCenterId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
  workCenterId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
  hireDate: date,
  gosiFirstRegistered: optDate,
  gosiNumber: z.string().trim().max(20).nullable().optional().transform((v) => v || null),
  iban: z.string().trim().max(40).nullable().optional(),
  qiwaContractNo: z.string().trim().max(40).nullable().optional().transform((v) => v || null),
  contractType: z.enum(["fixed", "unlimited"]).default("unlimited"),
  contractEnd: optDate,
  medicalClass: z.string().trim().max(20).nullable().optional().transform((v) => v || null),
  medicalDependents: z.number().int().min(0).max(20).default(0),
  medicalExpiry: optDate,
  pay: payBody.optional(),
});

const canSeePay = (req: FastifyRequest) => req.tenant!.permissions.includes("employees.view_pay");

export default async function employeeRoutes(app: FastifyInstance) {
  app.get("/employees", { preHandler: requireTenant("employees.view", "attendance.view", "leaves.view", "payroll.view") }, async (req) => {
    const q = req.query as { q?: string; status?: string };
    const status = q.status === "terminated" ? "terminated" : q.status === "all" ? null : "active";
    return tenantTx(req, async (db) => ({
      today: today(),
      items: (await db.query(
        `SELECT e.id, e.code, e.name, e.name_en AS "nameEn", e.gender, e.nationality, e.nationality = 'SA' AS "isSaudi", e.id_type AS "idType", e.id_last4 AS "idLast4",
                e.id_expiry::text AS "idExpiry", e.passport_expiry::text AS "passportExpiry", e.job_title AS "jobTitle", e.hire_date::text AS "hireDate",
                e.contract_type AS "contractType", e.contract_end::text AS "contractEnd", e.medical_expiry::text AS "medicalExpiry", e.status, e.terminated_on::text AS "terminatedOn",
                b.name AS "branchName", c.name AS "costCenterName", w.name AS "workCenterName", e.bank_code AS "bankCode", e.iban_enc IS NOT NULL AS "hasIban"
           FROM employees e LEFT JOIN branches b ON b.id = e.branch_id LEFT JOIN cost_centers c ON c.id = e.cost_center_id LEFT JOIN work_centers w ON w.id = e.work_center_id
          WHERE ($1::text IS NULL OR e.status = $1) AND ($2::text IS NULL OR e.name ILIKE $2 OR e.code ILIKE $2 OR e.job_title ILIKE $2 OR e.id_last4 = $3)
          ORDER BY e.status, e.code`, [status, q.q?.trim() ? likePattern(q.q) : null, q.q?.trim() ?? null])).rows,
    }), { readOnly: true });
  });

  app.get("/employees/:id", { preHandler: requireTenant("employees.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const pay = canSeePay(req);
    return tenantTx(req, async (db) => {
      const e = (await db.query<EmployeeRow & Record<string, unknown>>(
        `SELECT ${EMPLOYEE_COLS}, name_en AS "nameEn", id_type AS "idType", id_last4 AS "idLast4", id_expiry::text AS "idExpiry", passport_expiry::text AS "passportExpiry",
                birth_date::text AS "birthDate", job_title AS "jobTitle", occupation_code AS "occupationCode", work_center_id AS "workCenterId", gosi_number AS "gosiNumber",
                bank_code AS "bankCode", qiwa_contract_no AS "qiwaContractNo", contract_type AS "contractType", contract_end::text AS "contractEnd",
                medical_class AS "medicalClass", medical_dependents AS "medicalDependents", medical_expiry::text AS "medicalExpiry"
           FROM employees WHERE id = $1`, [id])).rows[0];
      if (!e) throw notFound("الموظف غير موجود");
      const { pay_enc, iban_enc, id_number_enc, hire_date, gosi_first_registered, cost_center_id, branch_id, terminated_on, ...rest } = e;
      const asOf = terminated_on ?? today();
      const out: Record<string, unknown> = {
        ...rest, hireDate: hire_date, gosiFirstRegistered: gosi_first_registered, costCenterId: cost_center_id, branchId: branch_id, terminatedOn: terminated_on,
        gosiScheme: gosiScheme(e.nationality, gosi_first_registered), leave: await leaveBalances(db, id, hire_date, asOf),
        settlement: (await db.query(`SELECT id, last_day::text AS "lastDay", reason, total::float8 AS total FROM final_settlements WHERE employee_id = $1`, [id])).rows[0] ?? null,
      };
      if (pay) {
        const p = payOf({ pay_enc });
        const scheme = gosiScheme(e.nationality, gosi_first_registered);
        const rate = await gosiRate(db, scheme, asOf);
        const wage = fixedWage(p);
        const eos = endOfService(wage, hire_date, asOf, "termination");
        Object.assign(out, {
          pay: p, idNumber: openHr<string>(id_number_enc), iban: iban_enc ? openHr<string>(iban_enc) : null,
          wage: wage / 100, dailyWage: dailyWage(p) / 100, gosiBase: gosiBase(p, rate.wageCeiling) / 100,
          eos: { asOf, years: eos.years, termination: eos.full / 100, provisioned: (await eosProvisioned(db, id)) / 100 },
        });
      }
      return out;
    }, { readOnly: true });
  });

  /** Sealed fields from the body: ID number (required on create), IBAN (validated, bank code kept plain), pay. */
  function sealed(b: z.infer<typeof body>, current?: { id_number_enc: string; iban_enc: string | null; bank_code: string | null; pay_enc: string }) {
    if (!current && !b.idNumber) throw badRequest("أدخل رقم الهوية أو الإقامة");
    if (!current && !b.pay) throw badRequest("أدخل الراتب");
    let iban = current?.iban_enc ?? null;
    let bank = current?.bank_code ?? null;
    if (b.iban !== undefined) {
      if (!b.iban) { iban = null; bank = null; } else {
        const i = ibanInfo(b.iban);
        if (!i) throw new AppError(422, "validation_failed", "رقم الآيبان غير صحيح (SA ثم 22 رقماً، وخانات التحقق)", [{ path: "iban", message: "آيبان غير صحيح" }]);
        iban = sealHr(i.iban); bank = i.bankCode;
      }
    }
    if (b.pay?.housingInKind && b.pay.housing) b.pay.housing = 0;
    return {
      idNumber: b.idNumber ? sealHr(b.idNumber) : current!.id_number_enc,
      idLast4: b.idNumber ? b.idNumber.slice(-4) : null,
      iban, bank,
      pay: b.pay ? sealHr(b.pay satisfies Pay) : current!.pay_enc,
    };
  }

  app.post("/employees", { preHandler: requireTenant("employees.create") }, async (req, reply) => {
    const b = body.parse(req.body);
    if (!canSeePay(req)) throw new AppError(403, "forbidden", "إضافة موظف تحتاج صلاحية رؤية الرواتب والبيانات الحساسة");
    if (b.contractType === "fixed" && !b.contractEnd) throw badRequest("حدد نهاية العقد محدد المدة");
    const s = sealed(b);
    const id = await tenantTx(req, async (db) => {
      try {
        const r = (await db.query<{ id: string }>(
          `INSERT INTO employees (tenant_id, code, name, name_en, gender, nationality, id_type, id_number_enc, id_last4, id_expiry, passport_expiry, birth_date, job_title, occupation_code,
                                  branch_id, cost_center_id, work_center_id, hire_date, gosi_first_registered, gosi_number, pay_enc, iban_enc, bank_code, qiwa_contract_no, contract_type,
                                  contract_end, medical_class, medical_dependents, medical_expiry)
           VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28) RETURNING id`,
          [b.code, b.name, b.nameEn, b.gender, b.nationality, b.idType, s.idNumber, s.idLast4, b.idExpiry, b.passportExpiry, b.birthDate, b.jobTitle, b.occupationCode,
            b.branchId, b.costCenterId, b.workCenterId, b.hireDate, b.gosiFirstRegistered, b.gosiNumber, s.pay, s.iban, s.bank, b.qiwaContractNo, b.contractType,
            b.contractType === "fixed" ? b.contractEnd : null, b.medicalClass, b.medicalDependents, b.medicalExpiry])).rows[0]!;
        await auditTenant(db, req, "employee.created", "employee", r.id, { code: b.code });
        return r.id;
      } catch (e) {
        if ((e as { code?: string }).code === "23505") throw new AppError(409, "duplicate", "الرقم الوظيفي مستخدم");
        throw e;
      }
    });
    return reply.status(201).send({ id });
  });

  app.put("/employees/:id", { preHandler: requireTenant("employees.edit") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = body.parse(req.body);
    // Without the pay permission the sealed fields are neither shown nor changed.
    if (!canSeePay(req) && (b.pay || b.idNumber || b.iban !== undefined)) throw new AppError(403, "forbidden", "تعديل الراتب والهوية والآيبان يحتاج صلاحية رؤية الرواتب");
    if (b.contractType === "fixed" && !b.contractEnd) throw badRequest("حدد نهاية العقد محدد المدة");
    await tenantTx(req, async (db) => {
      const cur = (await db.query<{ id_number_enc: string; iban_enc: string | null; bank_code: string | null; pay_enc: string; status: string }>(
        "SELECT id_number_enc, iban_enc, bank_code, pay_enc, status FROM employees WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!cur) throw notFound("الموظف غير موجود");
      if (cur.status !== "active") throw new AppError(409, "invalid_state", "انتهت خدمة الموظف: سجله للقراءة");
      const s = sealed(b, cur);
      try {
        await db.query(
          `UPDATE employees SET code = $2, name = $3, name_en = $4, gender = $5, nationality = $6, id_type = $7, id_number_enc = $8, id_last4 = coalesce($9, id_last4), id_expiry = $10,
                  passport_expiry = $11, birth_date = $12, job_title = $13, occupation_code = $14, branch_id = $15, cost_center_id = $16, work_center_id = $17, hire_date = $18,
                  gosi_first_registered = $19, gosi_number = $20, pay_enc = $21, iban_enc = $22, bank_code = $23, qiwa_contract_no = $24, contract_type = $25, contract_end = $26,
                  medical_class = $27, medical_dependents = $28, medical_expiry = $29 WHERE id = $1`,
          [id, b.code, b.name, b.nameEn, b.gender, b.nationality, b.idType, s.idNumber, s.idLast4, b.idExpiry, b.passportExpiry, b.birthDate, b.jobTitle, b.occupationCode,
            b.branchId, b.costCenterId, b.workCenterId, b.hireDate, b.gosiFirstRegistered, b.gosiNumber, s.pay, s.iban, s.bank, b.qiwaContractNo, b.contractType,
            b.contractType === "fixed" ? b.contractEnd : null, b.medicalClass, b.medicalDependents, b.medicalExpiry]);
      } catch (e) {
        if ((e as { code?: string }).code === "23505") throw new AppError(409, "duplicate", "الرقم الوظيفي مستخدم");
        throw e;
      }
      // The audit says what changed in kind only, never the sealed values.
      await auditTenant(db, req, "employee.updated", "employee", id, { pay: Boolean(b.pay), identity: Boolean(b.idNumber), iban: b.iban !== undefined });
    });
    return { ok: true };
  });

  /**
   * Documents about to expire (ID/iqama, passport, contract, medical insurance within 60 days), the Mudad deadline
   * for the last approved payroll (30 days from the end of its month), and the Saudization ratio (an estimate:
   * Nitaqat bands depend on the activity and size, not computed here).
   */
  app.get("/hr/overview", { preHandler: requireTenant("employees.view") }, async (req) =>
    tenantTx(req, async (db) => {
      const t = today();
      const alerts = (await db.query(
        `SELECT e.id, e.code, e.name, x.kind, x.d::text AS date, (x.d - $1::date)::int AS "daysLeft"
           FROM employees e CROSS JOIN LATERAL (VALUES ('id', e.id_expiry), ('passport', e.passport_expiry), ('contract', e.contract_end), ('medical', e.medical_expiry)) x(kind, d)
          WHERE e.status = 'active' AND x.d IS NOT NULL AND x.d <= $1::date + 60 ORDER BY x.d`, [t])).rows;
      const mix = (await db.query<{ saudi: number; total: number }>(
        "SELECT count(*) FILTER (WHERE nationality = 'SA')::int AS saudi, count(*)::int AS total FROM employees WHERE status = 'active'")).rows[0]!;
      const last = (await db.query<{ period: string; status: string }>("SELECT period, status FROM payroll_runs WHERE status <> 'draft' ORDER BY period DESC LIMIT 1")).rows[0];
      let wps: { period: string; deadline: string; daysLeft: number } | null = null;
      if (last) {
        const [y, m] = last.period.split("-").map(Number) as [number, number];
        const deadline = new Date(Date.UTC(y, m, 30)).toISOString().slice(0, 10);
        wps = { period: last.period, deadline, daysLeft: Math.round((Date.parse(deadline) - Date.parse(t)) / 86_400_000) };
      }
      return { today: t, alerts, saudization: { saudi: mix.saudi, total: mix.total, ratio: mix.total ? Math.round(mix.saudi / mix.total * 10000) / 100 : null }, wps };
    }, { readOnly: true }));

  /** What leaving on a date would pay (before confirming a settlement). */
  app.get("/employees/:id/settlement-preview", { preHandler: requireTenant("employees.terminate") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const q = z.object({ lastDay: date, reason: z.enum(["resignation", "termination", "contract_end", "article_87", "article_80"]) }).parse(req.query);
    return tenantTx(req, (db) => settle(db, id, q.lastDay, q.reason), { readOnly: true });
  });

  async function settle(db: import("../../db/pool.ts").Db, id: string, lastDay: string, reason: z.infer<typeof separation>) {
    const e = (await db.query<EmployeeRow>(`SELECT ${EMPLOYEE_COLS} FROM employees WHERE id = $1`, [id])).rows[0];
    if (!e) throw notFound("الموظف غير موجود");
    if (e.status !== "active") throw new AppError(409, "invalid_state", "انتهت خدمة الموظف من قبل");
    if (lastDay < e.hire_date) throw badRequest("آخر يوم قبل تاريخ الالتحاق");
    const p = payOf(e);
    const wage = fixedWage(p);
    const eos = endOfService(wage, e.hire_date, lastDay, reason);
    const leave = await leaveBalances(db, id, e.hire_date, lastDay);
    const leaveDays = Math.max(0, leave.annual.balance) + Math.max(0, leave.compensatory.balance);
    const leaveEncashment = Math.round(dailyWage(p) * leaveDays);
    const provision = await eosProvisioned(db, id);
    return { wage: wage / 100, years: eos.years, fullAward: eos.full / 100, factor: eos.factor, award: eos.award / 100, leaveDays, leaveEncashment: leaveEncashment / 100,
      provision: provision / 100, total: (eos.award + leaveEncashment) / 100, _h: { award: eos.award, leaveEncashment, provision } };
  }
  const separation = z.enum(["resignation", "termination", "contract_end", "article_87", "article_80"]);

  /**
   * The final settlement: end-of-service award (Articles 84/85/87, or none under 80) and unused leave, paid now,
   * posted against the provision. The last month's salary goes through that month's payroll as usual.
   */
  app.post("/employees/:id/terminate", { preHandler: requireTenant("employees.terminate") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const key = idempotencyKey(req);
    const b = z.object({ lastDay: date, reason: separation, paymentMethod: z.enum(["bank_transfer", "cash"]) }).parse(req.body);
    if (b.lastDay > today()) throw badRequest("آخر يوم عمل لا يكون في المستقبل");
    const out = await tenantTx(req, async (db) => {
      const dup = (await db.query<{ id: string }>("SELECT id FROM final_settlements WHERE idempotency_key = $1", [key])).rows[0];
      if (dup) return { id: dup.id, replay: true };
      await db.query("SELECT 1 FROM employees WHERE id = $1 FOR UPDATE", [id]);
      const s = await settle(db, id, b.lastDay, b.reason);
      await ensurePayrollAccounts(db);
      const r = (await db.query<{ id: string }>(
        `INSERT INTO final_settlements (tenant_id, employee_id, last_day, reason, amounts_enc, total, idempotency_key, created_by)
         VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, app_user_id()) RETURNING id`,
        [id, b.lastDay, b.reason, sealHr({ ...s._h, total: h(s.total), years: s.years, factor: s.factor, leaveDays: s.leaveDays, paymentMethod: b.paymentMethod }), s.total, key])).rows[0]!;
      await db.query("UPDATE employees SET status = 'terminated', terminated_on = $2 WHERE id = $1", [id, b.lastDay]);
      await postFinalSettlement(db, r.id);
      await auditTenant(db, req, "employee.terminated", "employee", id, { reason: b.reason, lastDay: b.lastDay });
      return { id: r.id, replay: false };
    });
    return reply.status(out.replay ? 200 : 201).send({ id: out.id });
  });
}
