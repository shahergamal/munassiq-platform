import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../../db/pool.ts";
import { postMaintenanceOrder } from "../../lib/accounting/posting.ts";
import { round4 } from "../../lib/costing.ts";
import { AppError, badRequest, notFound } from "../../lib/errors.ts";
import { auditTenant, isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";
import { addDays, today } from "../restaurants/batches.ts";
import { movement, takeOut } from "../restaurants/inventory.ts";
import { idempotencyKey } from "../restaurants/purchases.ts";

// Maintenance for factory workspaces (ARCHITECTURE.md, M5): machines on work centers, preventive plans by calendar
// or meter, maintenance orders (preventive or breakdown) whose spare parts leave stock into maintenance expense,
// and reliability figures (MTBF, MTTR, availability) from the breakdowns recorded.

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح");
const part = z.object({ itemId: z.string().uuid(), quantity: z.number().positive().max(1_000_000) });
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
/** Due within this many days (or this share of the meter interval) counts as due now. */
const SOON_DAYS = 7;
const SOON_METER = 0.9;

interface PlanRow { id: string; machine_id: string; machine: string; name: string; trigger_kind: "days" | "meter"; interval_value: number; planned_minutes: number;
  tasks: string | null; parts: { itemId: string; quantity: number }[]; last_done_on: string | null; last_meter: number | null; meter: number; meter_unit: string | null; open_order: number | null; is_active: boolean }

/** When a plan is next due: a date for calendar plans; a meter reading (and how far along) for meter plans. */
export function nextDue(p: Pick<PlanRow, "trigger_kind" | "interval_value" | "last_done_on" | "last_meter" | "meter">, t: string) {
  if (p.trigger_kind === "days") {
    const dueOn = p.last_done_on ? addDays(p.last_done_on, Math.round(p.interval_value)) : t;
    const left = days(t, dueOn);
    return { dueOn, dueMeter: null, daysLeft: left, state: left < 0 ? "overdue" : left <= SOON_DAYS ? "due" : "ok" } as const;
  }
  const base = p.last_meter ?? 0;
  const dueMeter = round4(base + p.interval_value);
  const used = (p.meter - base) / p.interval_value;
  return { dueOn: null, dueMeter, daysLeft: null, state: p.meter >= dueMeter ? "overdue" : used >= SOON_METER ? "due" : "ok" } as const;
}

/**
 * Reliability over a period from breakdowns closed in it. Running time is the work center's daily hours over the
 * period (24h for a machine without one) less the downtime. MTBF = running time / failures, MTTR = downtime /
 * failures, availability = MTBF / (MTBF + MTTR). With no failure the MTBF is the running time (a lower bound).
 */
export function reliability(p: { periodDays: number; minutesPerDay: number; failures: number; downtimeMinutes: number }) {
  const planned = p.periodDays * p.minutesPerDay;
  const running = Math.max(0, planned - p.downtimeMinutes);
  const mtbf = p.failures ? running / p.failures : running;
  const mttr = p.failures ? p.downtimeMinutes / p.failures : 0;
  return { plannedMinutes: planned, runningMinutes: running, mtbfHours: round4(mtbf / 60), mttrHours: round4(mttr / 60),
    availability: planned ? round4(running / planned) : 1 };
}

async function loadPlans(db: Db, where = "true", params: unknown[] = []) {
  return (await db.query<PlanRow>(
    `SELECT p.id, p.machine_id, m.name AS machine, p.name, p.trigger_kind, p.interval_value::float8 AS interval_value, p.planned_minutes, p.tasks, p.parts,
            p.last_done_on::text AS last_done_on, p.last_meter::float8 AS last_meter, m.meter_reading::float8 AS meter, m.meter_unit, p.is_active,
            (SELECT o.order_number::int FROM maintenance_orders o WHERE o.plan_id = p.id AND o.status = 'open' LIMIT 1) AS open_order
       FROM maintenance_plans p JOIN machines m ON m.id = p.machine_id WHERE ${where} ORDER BY m.code, p.name`, params)).rows;
}

async function newOrder(db: Db, o: { machineId: string; planId: string | null; kind: "preventive" | "corrective"; dueDate: string; minutes: number; description: string;
  failedAt: string | null; parts: { itemId: string; quantity: number }[]; key: string }) {
  const n = (await db.query<{ n: string }>("SELECT next_counter('maintenance_order')::text AS n")).rows[0]!.n;
  return (await db.query<{ id: string }>(
    `INSERT INTO maintenance_orders (tenant_id, order_number, machine_id, plan_id, kind, due_date, planned_minutes, description, failed_at, parts, idempotency_key, created_by)
     VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, app_user_id()) RETURNING id`,
    [n, o.machineId, o.planId, o.kind, o.dueDate, o.minutes, o.description, o.failedAt, JSON.stringify(o.parts), o.key])).rows[0]!.id;
}

export default async function maintenanceRoutes(app: FastifyInstance) {
  // Machines ──────────────────────────────────────────────────────────────────────────────────
  app.get("/machines", { preHandler: requireTenant("machines.view", "maintenance.view") }, async (req) =>
    tenantTx(req, async (db) => ({
      items: (await db.query(
        `SELECT m.id, m.code, m.name, m.work_center_id AS "workCenterId", w.name AS "workCenterName", m.serial_no AS "serialNo", m.meter_unit AS "meterUnit",
                m.meter_reading::float8 AS "meterReading", m.is_active AS "isActive",
                (SELECT count(*)::int FROM maintenance_plans p WHERE p.machine_id = m.id AND p.is_active) AS plans,
                (SELECT count(*)::int FROM maintenance_orders o WHERE o.machine_id = m.id AND o.status = 'open') AS "openOrders"
           FROM machines m LEFT JOIN work_centers w ON w.id = m.work_center_id ORDER BY m.is_active DESC, m.code`)).rows,
    }), { readOnly: true }));

  const machineBody = z.object({
    code: z.string().trim().regex(/^[A-Za-z0-9-]{1,20}$/, "الرمز حروف إنجليزية وأرقام وشرطة (حتى 20)"),
    name: z.string().trim().min(2, "أدخل اسم الآلة").max(120),
    workCenterId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
    serialNo: z.string().trim().max(60).nullable().optional().transform((v) => v || null),
    meterUnit: z.string().trim().max(20).nullable().optional().transform((v) => v || null),
  });
  const saveMachine = (id: string | null) => async (req: FastifyRequest) => {
    const b = machineBody.extend({ isActive: z.boolean().default(true) }).parse(req.body);
    return tenantTx(req, async (db) => {
      try {
        const r = id
          ? await db.query<{ id: string }>("UPDATE machines SET code = $2, name = $3, work_center_id = $4, serial_no = $5, meter_unit = $6, is_active = $7 WHERE id = $1 RETURNING id",
            [id, b.code, b.name, b.workCenterId, b.serialNo, b.meterUnit, b.isActive])
          : await db.query<{ id: string }>("INSERT INTO machines (tenant_id, code, name, work_center_id, serial_no, meter_unit) VALUES (app_tenant_id(), $1, $2, $3, $4, $5) RETURNING id",
            [b.code, b.name, b.workCenterId, b.serialNo, b.meterUnit]);
        if (!r.rows[0]) throw notFound("الآلة غير موجودة");
        await auditTenant(db, req, id ? "machine.updated" : "machine.created", "machine", r.rows[0].id, { code: b.code });
        return { id: r.rows[0].id };
      } catch (e) {
        if ((e as { code?: string }).code === "23505") throw new AppError(409, "duplicate", "رمز الآلة مستخدم");
        throw e;
      }
    });
  };
  app.post("/machines", { preHandler: requireTenant("machines.create") }, async (req, reply) => reply.status(201).send(await saveMachine(null)(req)));
  app.put("/machines/:id", { preHandler: requireTenant("machines.edit") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return saveMachine(id)(req);
  });
  // The meter only moves forward (hours run, cycles); a lower reading is a typing mistake, not a reset.
  app.post("/machines/:id/meter", { preHandler: requireTenant("machines.edit") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ reading: z.number().min(0).max(1e12) }).parse(req.body);
    return tenantTx(req, async (db) => {
      const cur = (await db.query<{ r: number }>("SELECT meter_reading::float8 AS r FROM machines WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!cur) throw notFound("الآلة غير موجودة");
      if (b.reading < cur.r) throw badRequest(`القراءة أقل من الحالية (${cur.r})`);
      await db.query("UPDATE machines SET meter_reading = $2 WHERE id = $1", [id, b.reading]);
      await auditTenant(db, req, "machine.meter", "machine", id, { from: cur.r, to: b.reading });
      return { ok: true };
    });
  });

  // Plans ─────────────────────────────────────────────────────────────────────────────────────
  app.get("/maintenance/plans", { preHandler: requireTenant("machines.view", "maintenance.view") }, async (req) =>
    tenantTx(req, async (db) => {
      const t = today();
      const plans = await loadPlans(db);
      // Names of the usual spare parts, so the plan can be edited without looking them up.
      const partItems = (await db.query<{ id: string; name: string; unit: string }>(
        "SELECT i.id, i.name, u.name AS unit FROM ingredients i JOIN units u ON u.id = i.base_unit_id WHERE i.id = ANY($1::uuid[])",
        [[...new Set(plans.flatMap((p) => p.parts.map((x) => x.itemId)))]])).rows;
      return { today: t, partItems, items: plans.map((p) => ({ id: p.id, machineId: p.machine_id, machineName: p.machine, name: p.name, triggerKind: p.trigger_kind,
        intervalValue: p.interval_value, plannedMinutes: p.planned_minutes, tasks: p.tasks, parts: p.parts, lastDoneOn: p.last_done_on, lastMeter: p.last_meter,
        meter: p.meter, meterUnit: p.meter_unit, isActive: p.is_active, openOrder: p.open_order, ...nextDue(p, t) })) };
    }, { readOnly: true }));

  const planBody = z.object({
    machineId: z.string().uuid("اختر الآلة"),
    name: z.string().trim().min(2, "أدخل اسم الخطة").max(120),
    triggerKind: z.enum(["days", "meter"]),
    intervalValue: z.number().positive("أدخل الفترة").max(1e9),
    plannedMinutes: z.number().int().min(1).max(10000).default(60),
    tasks: z.string().trim().max(2000).nullable().optional().transform((v) => v || null),
    parts: z.array(part).max(30).default([]),
    lastDoneOn: date.nullable().optional().transform((v) => v ?? null),
  });
  app.post("/maintenance/plans", { preHandler: requireTenant("machines.edit") }, async (req, reply) => {
    const b = planBody.parse(req.body);
    const id = await tenantTx(req, async (db) => {
      const m = (await db.query<{ unit: string | null; r: number }>("SELECT meter_unit AS unit, meter_reading::float8 AS r FROM machines WHERE id = $1", [b.machineId])).rows[0];
      if (!m) throw notFound("الآلة غير موجودة");
      if (b.triggerKind === "meter" && !m.unit) throw badRequest("حدد وحدة عدّاد الآلة أولاً (ساعات تشغيل أو دورات)");
      const r = (await db.query<{ id: string }>(
        `INSERT INTO maintenance_plans (tenant_id, machine_id, name, trigger_kind, interval_value, planned_minutes, tasks, parts, last_done_on, last_meter)
         VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [b.machineId, b.name, b.triggerKind, b.intervalValue, b.plannedMinutes, b.tasks, JSON.stringify(b.parts), b.lastDoneOn, b.triggerKind === "meter" ? m.r : null])).rows[0]!;
      await auditTenant(db, req, "maintenance_plan.created", "maintenance_plan", r.id);
      return r.id;
    });
    return reply.status(201).send({ id });
  });
  app.put("/maintenance/plans/:id", { preHandler: requireTenant("machines.edit") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = planBody.omit({ machineId: true, triggerKind: true, lastDoneOn: true }).extend({ isActive: z.boolean().default(true) }).parse(req.body);
    await tenantTx(req, async (db) => {
      const r = await db.query("UPDATE maintenance_plans SET name = $2, interval_value = $3, planned_minutes = $4, tasks = $5, parts = $6, is_active = $7 WHERE id = $1",
        [id, b.name, b.intervalValue, b.plannedMinutes, b.tasks, JSON.stringify(b.parts), b.isActive]);
      if (!r.rowCount) throw notFound("الخطة غير موجودة");
      await auditTenant(db, req, "maintenance_plan.updated", "maintenance_plan", id, { isActive: b.isActive });
    });
    return { ok: true };
  });

  // Opens a preventive order for every active plan that is due (or nearly) and has none open.
  app.post("/maintenance/generate", { preHandler: requireTenant("maintenance.create") }, async (req) =>
    tenantTx(req, async (db) => {
      const t = today();
      const created: string[] = [];
      for (const p of await loadPlans(db, "p.is_active AND m.is_active")) {
        const d = nextDue(p, t);
        if (d.state === "ok" || p.open_order) continue;
        const id = await newOrder(db, { machineId: p.machine_id, planId: p.id, kind: "preventive", dueDate: d.dueOn && d.dueOn > t ? d.dueOn : t, minutes: p.planned_minutes,
          description: p.tasks ? `${p.name}: ${p.tasks}`.slice(0, 1000) : p.name, failedAt: null, parts: p.parts, key: crypto.randomUUID() });
        created.push(id);
        await auditTenant(db, req, "maintenance.generated", "maintenance_order", id, { planId: p.id });
      }
      return { created: created.length };
    }));

  // Orders ────────────────────────────────────────────────────────────────────────────────────
  app.get("/maintenance/orders", { preHandler: requireTenant("maintenance.view") }, async (req) => {
    const q = req.query as { status?: string; machineId?: string };
    const status = ["open", "done", "cancelled"].includes(q.status ?? "") ? q.status! : null;
    return tenantTx(req, async (db) => ({
      today: today(),
      items: (await db.query(
        `SELECT o.id, o.order_number::int AS number, o.kind, o.status, o.due_date::text AS "dueDate", o.planned_minutes AS "plannedMinutes", o.description,
                o.failed_at AS "failedAt", o.completed_at AS "completedAt", o.downtime_minutes AS "downtimeMinutes", o.parts_cost::float8 AS "partsCost",
                m.id AS "machineId", m.code AS "machineCode", m.name AS "machineName", p.name AS "planName"
           FROM maintenance_orders o JOIN machines m ON m.id = o.machine_id LEFT JOIN maintenance_plans p ON p.id = o.plan_id
          WHERE ($1::text IS NULL OR o.status = $1) AND ($2::uuid IS NULL OR o.machine_id = $2)
          ORDER BY o.status = 'open' DESC, o.due_date, o.order_number DESC LIMIT 300`, [status, q.machineId && isUuid(q.machineId) ? q.machineId : null])).rows,
    }), { readOnly: true });
  });

  app.get("/maintenance/orders/:id", { preHandler: requireTenant("maintenance.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const o = (await db.query(
        `SELECT o.id, o.order_number::int AS number, o.kind, o.status, o.due_date::text AS "dueDate", o.planned_minutes AS "plannedMinutes", o.description,
                o.failed_at AS "failedAt", o.completed_at AS "completedAt", o.downtime_minutes AS "downtimeMinutes", o.meter_at_service::float8 AS "meterAtService",
                o.findings, o.parts, o.parts_cost::float8 AS "partsCost", o.location_id AS "locationId", l.name AS "locationName",
                m.id AS "machineId", m.code AS "machineCode", m.name AS "machineName", m.meter_unit AS "meterUnit", m.meter_reading::float8 AS "meterReading", p.name AS "planName",
                j.id AS "journalId", j.entry_number::int AS "journalNumber"
           FROM maintenance_orders o JOIN machines m ON m.id = o.machine_id LEFT JOIN maintenance_plans p ON p.id = o.plan_id LEFT JOIN locations l ON l.id = o.location_id
           LEFT JOIN journal_entries j ON j.source_type = 'maintenance' AND j.source_id = o.id
          WHERE o.id = $1`, [id])).rows[0];
      if (!o) throw notFound("أمر الصيانة غير موجود");
      const ids = ((o.parts as { itemId: string }[]) ?? []).map((x) => x.itemId);
      const items = (await db.query(`SELECT i.id, i.name, u.name AS unit FROM ingredients i JOIN units u ON u.id = i.base_unit_id WHERE i.id = ANY($1::uuid[])`, [ids])).rows;
      return { ...o, items };
    }, { readOnly: true });
  });

  app.post("/maintenance/orders", { preHandler: requireTenant("maintenance.create") }, async (req, reply) => {
    const key = idempotencyKey(req);
    const b = z.object({
      machineId: z.string().uuid("اختر الآلة"),
      kind: z.enum(["preventive", "corrective"]),
      planId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
      dueDate: date.optional(),
      plannedMinutes: z.number().int().min(1).max(10000).default(60),
      description: z.string().trim().min(3, "صف العمل المطلوب أو العطل").max(1000),
      failedAt: z.string().datetime({ offset: true }).nullable().optional().transform((v) => v ?? null),
      parts: z.array(part).max(30).default([]),
    }).parse(req.body);
    if (b.kind === "corrective" && !b.failedAt) throw badRequest("حدد وقت توقف الآلة");
    if (b.failedAt && Date.parse(b.failedAt) > Date.now() + 60_000) throw badRequest("وقت التوقف في المستقبل");
    const out = await tenantTx(req, async (db) => {
      const dup = (await db.query<{ id: string }>("SELECT id FROM maintenance_orders WHERE idempotency_key = $1", [key])).rows[0];
      if (dup) return { id: dup.id, replay: true };
      if (!(await db.query("SELECT 1 FROM machines WHERE id = $1 AND is_active", [b.machineId])).rowCount) throw notFound("الآلة غير موجودة أو موقوفة");
      if (b.planId && !(await db.query("SELECT 1 FROM maintenance_plans WHERE id = $1 AND machine_id = $2", [b.planId, b.machineId])).rowCount) throw badRequest("الخطة لا تخص هذه الآلة");
      const id = await newOrder(db, { machineId: b.machineId, planId: b.kind === "preventive" ? b.planId : null, kind: b.kind, dueDate: b.dueDate ?? today(),
        minutes: b.plannedMinutes, description: b.description, failedAt: b.kind === "corrective" ? b.failedAt : null, parts: b.parts, key });
      await auditTenant(db, req, "maintenance.created", "maintenance_order", id, { kind: b.kind });
      return { id, replay: false };
    });
    return reply.status(out.replay ? 200 : 201).send({ id: out.id });
  });

  /**
   * Done: spare parts used leave the chosen location at its average cost into maintenance expense (one entry, on the
   * machine's cost center), downtime is recorded (a breakdown's runs from when it stopped), and the plan restarts
   * from today and the meter reading.
   */
  app.post("/maintenance/orders/:id/complete", { preHandler: requireTenant("maintenance.complete") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    idempotencyKey(req);
    const b = z.object({
      completedAt: z.string().datetime({ offset: true }).optional(),
      downtimeMinutes: z.number().int().min(0).max(525_600).nullable().optional().transform((v) => v ?? null),
      meterAtService: z.number().min(0).max(1e12).nullable().optional().transform((v) => v ?? null),
      findings: z.string().trim().max(2000).nullable().optional().transform((v) => v || null),
      locationId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
      parts: z.array(part).max(30).default([]),
    }).parse(req.body);
    const done = b.completedAt ? new Date(b.completedAt) : new Date();
    if (done.getTime() > Date.now() + 60_000) throw badRequest("وقت الإنجاز في المستقبل");
    return tenantTx(req, async (db) => {
      const o = (await db.query<{ status: string; kind: string; failed_at: Date | null; plan_id: string | null; machine_id: string; planned_minutes: number; meter: number; journal: string | null }>(
        `SELECT o.status, o.kind, o.failed_at, o.plan_id, o.machine_id, o.planned_minutes, m.meter_reading::float8 AS meter,
                (SELECT j.id FROM journal_entries j WHERE j.source_type = 'maintenance' AND j.source_id = o.id) AS journal
           FROM maintenance_orders o JOIN machines m ON m.id = o.machine_id WHERE o.id = $1 FOR UPDATE OF o, m`, [id])).rows[0];
      if (!o) throw notFound("أمر الصيانة غير موجود");
      if (o.status === "done") return { ok: true, replay: true, journalId: o.journal };
      if (o.status !== "open") throw new AppError(409, "invalid_state", "الأمر ملغى");
      if (o.failed_at && done < o.failed_at) throw badRequest("وقت الإنجاز قبل وقت التوقف");
      if (b.meterAtService !== null && b.meterAtService < o.meter) throw badRequest(`قراءة العدّاد أقل من الحالية (${o.meter})`);
      const downtime = b.downtimeMinutes ?? (o.failed_at ? Math.round((done.getTime() - o.failed_at.getTime()) / 60_000) : o.planned_minutes);
      let cost = 0;
      const used: { itemId: string; quantity: number; unitCost: number; value: number }[] = [];
      if (b.parts.length) {
        if (!b.locationId) throw badRequest("اختر المستودع الذي تُصرف منه القطع");
        const loc = (await db.query<{ t: string }>("SELECT location_type AS t FROM locations WHERE id = $1 AND is_active", [b.locationId])).rows[0];
        if (!loc) throw notFound("الموقع غير موجود");
        if (loc.t === "quarantine") throw new AppError(409, "quality_hold", "لا تُصرف قطع من حجر الجودة");
        const merged = new Map<string, number>();
        for (const p of b.parts) merged.set(p.itemId, round4((merged.get(p.itemId) ?? 0) + p.quantity));
        const taken = await takeOut(db, b.locationId, [...merged].map(([ingredientId, quantity]) => ({ ingredientId, quantity })));
        for (const t of taken) {
          await movement(db, { locationId: b.locationId, ingredientId: t.ingredientId, type: "maintenance", quantity: -t.quantity, unitCost: t.unitCost, refType: "maintenance", refId: id });
          const value = Math.round(t.quantity * t.unitCost * 100) / 100;
          used.push({ itemId: t.ingredientId, quantity: t.quantity, unitCost: t.unitCost, value });
          cost += value;
        }
      }
      const meter = b.meterAtService ?? o.meter;
      await db.query(
        `UPDATE maintenance_orders SET status = 'done', completed_at = $2, downtime_minutes = $3, meter_at_service = $4, findings = $5, parts = $6, parts_cost = $7,
                location_id = $8, completed_by = app_user_id() WHERE id = $1`,
        [id, done.toISOString(), downtime, meter, b.findings, JSON.stringify(used), Math.round(cost * 100) / 100, b.parts.length ? b.locationId : null]);
      if (meter > o.meter) await db.query("UPDATE machines SET meter_reading = $2 WHERE id = $1", [o.machine_id, meter]);
      if (o.plan_id) {
        await db.query("UPDATE maintenance_plans SET last_done_on = (($2::timestamptz) AT TIME ZONE 'Asia/Riyadh')::date, last_meter = $3 WHERE id = $1", [o.plan_id, done.toISOString(), meter]);
      }
      const journal = await postMaintenanceOrder(db, id);
      await auditTenant(db, req, "maintenance.completed", "maintenance_order", id, { partsCost: cost, downtime });
      return { ok: true, replay: false, journalId: journal };
    });
  });

  app.post("/maintenance/orders/:id/cancel", { preHandler: requireTenant("maintenance.cancel") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ reason: z.string().trim().min(3, "اذكر سبب الإلغاء").max(300) }).parse(req.body);
    await tenantTx(req, async (db) => {
      const r = await db.query("UPDATE maintenance_orders SET status = 'cancelled' WHERE id = $1 AND status = 'open'", [id]);
      if (!r.rowCount) throw new AppError(409, "invalid_state", "الأمر غير موجود أو غير مفتوح");
      await auditTenant(db, req, "maintenance.cancelled", "maintenance_order", id, { reason: b.reason });
    });
    return { ok: true };
  });

  // Reliability per machine over a period (default: the last 90 days).
  app.get("/maintenance/kpis", { preHandler: requireTenant("maintenance.view") }, async (req) => {
    const q = req.query as { from?: string; to?: string };
    const to = q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to) ? q.to : today();
    const from = q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from) ? q.from : addDays(to, -89);
    if (from > to) throw badRequest("بداية الفترة بعد نهايتها");
    const periodDays = days(from, to) + 1;
    return tenantTx(req, async (db) => {
      const rows = (await db.query<{ id: string; code: string; name: string; mpd: number | null; failures: number; downtime: number; preventive: number; on_time: number; cost: number; open: number; overdue: number }>(
        `SELECT m.id, m.code, m.name, (w.hours_per_day * 60)::float8 AS mpd,
                count(o.id) FILTER (WHERE o.kind = 'corrective' AND o.status = 'done')::int AS failures,
                coalesce(sum(o.downtime_minutes) FILTER (WHERE o.kind = 'corrective' AND o.status = 'done'), 0)::float8 AS downtime,
                count(o.id) FILTER (WHERE o.kind = 'preventive' AND o.status = 'done')::int AS preventive,
                count(o.id) FILTER (WHERE o.kind = 'preventive' AND o.status = 'done' AND (o.completed_at AT TIME ZONE 'Asia/Riyadh')::date <= o.due_date)::int AS on_time,
                coalesce(sum(o.parts_cost) FILTER (WHERE o.status = 'done'), 0)::float8 AS cost,
                (SELECT count(*)::int FROM maintenance_orders x WHERE x.machine_id = m.id AND x.status = 'open') AS open,
                (SELECT count(*)::int FROM maintenance_orders x WHERE x.machine_id = m.id AND x.status = 'open' AND x.due_date < $2::date) AS overdue
           FROM machines m LEFT JOIN work_centers w ON w.id = m.work_center_id
           LEFT JOIN maintenance_orders o ON o.machine_id = m.id AND (o.completed_at AT TIME ZONE 'Asia/Riyadh')::date BETWEEN $1::date AND $2::date
          WHERE m.is_active GROUP BY m.id, w.hours_per_day ORDER BY m.code`, [from, to])).rows;
      const items = rows.map((r) => ({ machineId: r.id, code: r.code, name: r.name, failures: r.failures, downtimeMinutes: r.downtime, preventiveDone: r.preventive,
        preventiveOnTime: r.on_time, partsCost: r.cost, openOrders: r.open, overdueOrders: r.overdue,
        ...reliability({ periodDays, minutesPerDay: r.mpd ?? 1440, failures: r.failures, downtimeMinutes: r.downtime }) }));
      const tot = (k: "failures" | "downtimeMinutes" | "partsCost" | "preventiveDone" | "preventiveOnTime") => items.reduce((a, x) => a + x[k], 0);
      return { from, to, periodDays, items, totals: { failures: tot("failures"), downtimeMinutes: tot("downtimeMinutes"), partsCost: Math.round(tot("partsCost") * 100) / 100,
        preventiveCompliance: tot("preventiveDone") ? round4(tot("preventiveOnTime") / tot("preventiveDone")) : null } };
    }, { readOnly: true });
  });
}
