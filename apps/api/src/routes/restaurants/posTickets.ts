import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db } from "../../db/pool.ts";
import { AppError, badRequest, forbidden, notFound } from "../../lib/errors.ts";
import type { Permission } from "../../lib/rbac.ts";
import { auditTenant, isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";
import { type OrderInput, priceCart } from "./pos.ts";
import { idempotencyKey } from "./purchases.ts";

/**
 * Open orders at the till. A ticket is what one customer (or table) has ordered so far; the till keeps several open
 * and switches between them. Money is never stored: the server prices a ticket whenever it is shown or paid.
 * Sending to the kitchen happens in rounds; what the kitchen already has can only be reduced by a manager, with a
 * reason, and the kitchen is told (a "void" round). Paying turns the ticket, or part of it (split bill), into a sale.
 */

export interface TicketLine { id: string; recipeId: string; quantity: number; modifiers: string[]; note: string | null; sent: number }
interface TicketRow {
  id: string; ticket_number: string; location_id: string; label: string | null; channel: "dine_in" | "takeaway" | "delivery";
  table_id: string | null; guests: number | null; customer_id: string | null; platform_id: string | null; external_ref: string | null;
  discount: { type: "amount" | "percent"; value: number } | null; discount_reason: string | null; notes: string | null;
  items: TicketLine[]; status: string; version: number; kitchen_rounds: number;
}

const lineSchema = z.object({
  id: z.string().uuid(),
  recipeId: z.string().uuid(),
  quantity: z.number().int().min(1).max(1000),
  modifiers: z.array(z.string().uuid()).max(20).default([]),
  note: z.string().trim().max(140).nullable().optional().transform((v) => v || null),
});
const fieldsSchema = z.object({
  label: z.string().trim().max(60).nullable().optional().transform((v) => v || null),
  channel: z.enum(["dine_in", "takeaway", "delivery"]).default("takeaway"),
  tableId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
  guests: z.number().int().min(1).max(100).nullable().optional().transform((v) => v ?? null),
  customerId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
  platformId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
  externalRef: z.string().trim().max(60).nullable().optional().transform((v) => v || null),
  discount: z.object({ type: z.enum(["amount", "percent"]), value: z.number().min(0).max(1_000_000) }).nullable().optional().transform((v) => (v && v.value > 0 ? v : null)),
  discountReason: z.string().trim().max(300).nullable().optional().transform((v) => v || null),
  notes: z.string().trim().max(500).nullable().optional().transform((v) => v || null),
  items: z.array(lineSchema).max(100).default([]).refine((ls) => new Set(ls.map((l) => l.id)).size === ls.length, "سطر مكرر"),
});
type Fields = z.infer<typeof fieldsSchema>;

const sameOptions = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

async function loadTicket(db: Db, id: string, lock = false): Promise<TicketRow> {
  const t = (await db.query<TicketRow & { ticket_number: string }>(
    `SELECT id, ticket_number::text, location_id, label, channel, table_id, guests, customer_id, platform_id, external_ref, discount, discount_reason, notes,
            items, status, version, kitchen_rounds FROM pos_tickets WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id])).rows[0];
  if (!t) throw notFound("الطلب المفتوح غير موجود");
  return t;
}

function assertOpen(t: TicketRow, version?: number) {
  if (t.status !== "open") throw new AppError(409, "ticket_closed", t.status === "paid" ? "هذا الطلب دُفع وأُغلق" : "هذا الطلب أُلغي");
  if (version !== undefined && version !== t.version) {
    throw new AppError(409, "ticket_stale", "عُدّل هذا الطلب من جهاز آخر. حدّثنا نسخته أمامك، راجعها ثم أعد المحاولة", { version: t.version });
  }
}

/** Where the order goes must make sense for this location; the database checks it again. */
async function checkPlacement(db: Db, locationId: string, f: Pick<Fields, "channel" | "tableId" | "platformId">) {
  if (f.tableId) {
    if (f.channel !== "dine_in") throw badRequest("الطاولة للطلبات المحلية فقط");
    const ok = (await db.query<{ ok: boolean }>(
      "SELECT (t.is_active AND a.is_active AND a.location_id = $2) AS ok FROM dining_tables t JOIN dining_areas a ON a.id = t.area_id WHERE t.id = $1", [f.tableId, locationId])).rows[0];
    if (!ok?.ok) throw new AppError(422, "table_unavailable", "الطاولة غير متاحة في هذا الموقع");
  }
  if (f.platformId) {
    if (f.channel !== "delivery") throw badRequest("تطبيق التوصيل لطلبات التوصيل فقط");
    const p = (await db.query<{ is_active: boolean }>("SELECT is_active FROM delivery_platforms WHERE id = $1", [f.platformId])).rows[0];
    if (!p?.is_active) throw new AppError(422, "platform_unavailable", "تطبيق التوصيل غير متاح");
  }
}

/** One open ticket per table: say which one, so the till can open it (the unique index is the backstop). */
async function checkTableFree(db: Db, tableId: string | null, self: string | null) {
  if (!tableId) return;
  const other = (await db.query<{ id: string; n: string }>(
    "SELECT id, ticket_number::text AS n FROM pos_tickets WHERE table_id = $1 AND status = 'open' AND id IS DISTINCT FROM $2", [tableId, self])).rows[0];
  if (other) throw new AppError(409, "table_busy", `على هذه الطاولة طلب مفتوح (T-${other.n}). افتحه وأضف عليه`, { ticketId: other.id });
}

interface RoundLine { recipeId: string; modifiers: string[]; note: string | null; quantity: number }

/** Sends one round to the kitchen, with names as they are now (a void round has negative quantities). */
async function kitchenRound(db: Db, t: TicketRow, lines: RoundLine[], orderId: string | null) {
  if (!lines.length) return;
  const recipes = new Map((await db.query<{ id: string; name: string }>("SELECT id, name FROM recipes WHERE id = ANY($1::uuid[])", [[...new Set(lines.map((l) => l.recipeId))]])).rows.map((r) => [r.id, r.name]));
  const optIds = [...new Set(lines.flatMap((l) => l.modifiers))];
  const opts = optIds.length ? new Map((await db.query<{ id: string; name: string }>("SELECT id, name FROM modifier_options WHERE id = ANY($1::uuid[])", [optIds])).rows.map((r) => [r.id, r.name])) : new Map<string, string>();
  const items = lines.map((l) => ({ name: recipes.get(l.recipeId) ?? "", quantity: l.quantity, modifiers: l.modifiers.map((m) => opts.get(m) ?? ""), note: l.note }));
  const round = t.kitchen_rounds + 1;
  await db.query("INSERT INTO kitchen_tickets (tenant_id, order_id, location_id, pos_ticket_id, round, items) VALUES (app_tenant_id(), $1, $2, $3, $4, $5)",
    [orderId, t.location_id, t.id, round, JSON.stringify(items)]);
  t.kitchen_rounds = round;
  await db.query("UPDATE pos_tickets SET kitchen_rounds = $2, last_sent_at = now() WHERE id = $1", [t.id, round]);
}

async function saveLines(db: Db, t: TicketRow, items: TicketLine[], extra = "") {
  t.items = items;
  t.version += 1;
  await db.query(`UPDATE pos_tickets SET items = $2, version = $3, updated_by = app_user_id()${extra} WHERE id = $1`, [t.id, JSON.stringify(items), t.version]);
}

/**
 * For a sale from a ticket: the cart IS the ticket (or the chosen part of it). The browser's copy of the items is
 * ignored, so what is charged is what the ticket holds on the server.
 */
export async function resolveTicketCart<T extends Omit<OrderInput, "payments">>(db: Db, body: T, lock: boolean): Promise<{ body: T; ticket: TicketRow | null; take: Map<string, number> }> {
  const ref = body.ticket;
  if (!ref) return { body, ticket: null, take: new Map() };
  const t = await loadTicket(db, ref.id, lock);
  assertOpen(t, ref.version);
  if (t.location_id !== body.locationId) throw badRequest("الطلب المفتوح لا يخص هذا الموقع");
  if (!t.items.length) throw new AppError(422, "empty_ticket", "الطلب فارغ");
  const take = new Map<string, number>();
  for (const l of ref.lines ?? t.items.map((x) => ({ lineId: x.id, quantity: x.quantity }))) {
    const line = t.items.find((x) => x.id === l.lineId);
    if (!line) throw new AppError(409, "ticket_stale", "أحد الأصناف لم يعد في الطلب. حدّث الطلب", { version: t.version });
    const q = (take.get(line.id) ?? 0) + l.quantity;
    if (q > line.quantity) throw badRequest(`الكمية المختارة من الصنف أكبر من المطلوب`);
    take.set(line.id, q);
  }
  const partial = t.items.some((x) => (take.get(x.id) ?? 0) < x.quantity);
  if (partial && t.discount?.type === "amount") throw new AppError(422, "split_amount_discount", "الخصم بمبلغ ثابت يُطبَّق عند دفع الطلب كاملاً. حوّله لنسبة لتقسيم الفاتورة");
  const customer = t.customer_id ? (await db.query<{ name: string }>("SELECT name FROM customers WHERE id = $1", [t.customer_id])).rows[0] : undefined;
  return {
    ticket: t, take,
    body: {
      ...body,
      channel: t.channel, tableId: t.table_id, guests: t.guests, customerId: t.customer_id, customerName: customer?.name ?? body.customerName ?? null,
      platformId: t.platform_id, externalRef: t.external_ref, notes: t.notes, discount: t.discount, discountReason: t.discount_reason,
      items: t.items.filter((x) => take.has(x.id)).map((x) => ({ recipeId: x.recipeId, quantity: take.get(x.id)!, modifiers: x.modifiers, note: x.note })),
    },
  };
}

/** After the sale: the paid part leaves the ticket (from what the kitchen has first); what the kitchen never got is sent now. */
export async function settleTicket(db: Db, t: TicketRow, take: Map<string, number>, orderId: string) {
  const unsent: RoundLine[] = [];
  const left: TicketLine[] = [];
  for (const line of t.items) {
    const q = take.get(line.id) ?? 0;
    const fromSent = Math.min(line.sent, q);
    if (q - fromSent > 0) unsent.push({ recipeId: line.recipeId, modifiers: line.modifiers, note: line.note, quantity: q - fromSent });
    if (line.quantity - q > 0) left.push({ ...line, quantity: line.quantity - q, sent: line.sent - fromSent });
  }
  await kitchenRound(db, t, unsent, orderId);
  await saveLines(db, t, left, left.length ? "" : ", status = 'paid', closed_at = now(), closed_by = app_user_id()");
  return left.length === 0;
}

/** The till's view of a ticket, priced now. A ticket that no longer prices (an item was withdrawn) says why. */
async function view(db: Db, ids: string[], perms: readonly Permission[]) {
  if (!ids.length) return [];
  const rows = (await db.query(
    `SELECT t.id, t.ticket_number::int AS "number", t.location_id AS "locationId", t.label, t.channel, t.table_id AS "tableId", tb.name AS "tableName", t.guests,
            t.customer_id AS "customerId", c.name AS "customerName", c.phone AS "customerPhone", t.platform_id AS "platformId", p.name AS "platformName",
            t.external_ref AS "externalRef", t.discount, t.discount_reason AS "discountReason", t.notes, t.items, t.status, t.version,
            t.kitchen_rounds AS "kitchenRounds", t.last_sent_at AS "lastSentAt", t.created_at AS "createdAt", t.updated_at AS "updatedAt", t.void_reason AS "voidReason",
            coalesce((SELECT json_agg(json_build_object('id', o.id, 'number', o.order_number, 'total', o.total::float8) ORDER BY o.created_at) FROM pos_orders o WHERE o.ticket_id = t.id), '[]') AS orders
       FROM pos_tickets t LEFT JOIN dining_tables tb ON tb.id = t.table_id LEFT JOIN customers c ON c.id = t.customer_id LEFT JOIN delivery_platforms p ON p.id = t.platform_id
      WHERE t.id = ANY($1::uuid[]) ORDER BY t.created_at`, [ids])).rows as (Record<string, unknown> & { items: TicketLine[]; discount: TicketRow["discount"] })[];
  const recipeIds = [...new Set(rows.flatMap((r) => r.items.map((l) => l.recipeId)))];
  const names = new Map((await db.query<{ id: string; name: string }>("SELECT id, name FROM recipes WHERE id = ANY($1::uuid[])", [recipeIds])).rows.map((r) => [r.id, r.name]));
  const out = [];
  for (const r of rows) {
    let totals: { subtotal: number; discount: number; vat: number; total: number } | null = null;
    let problem: string | null = null;
    if (r.items.length) {
      try {
        await db.query("SAVEPOINT price_ticket");
        const { priced } = await priceCart(db, { items: r.items, discount: r.discount }, perms);
        totals = { subtotal: priced.subtotal / 100, discount: priced.discount / 100, vat: priced.vat / 100, total: priced.total / 100 };
        await db.query("RELEASE SAVEPOINT price_ticket");
      } catch (err) {
        await db.query("ROLLBACK TO SAVEPOINT price_ticket");
        if (!(err instanceof AppError)) throw err;
        problem = err.message;
      }
    }
    out.push({
      ...r,
      items: r.items.map((l) => ({ ...l, name: names.get(l.recipeId) ?? "صنف محذوف" })),
      count: r.items.reduce((a, l) => a + l.quantity, 0),
      unsent: r.items.reduce((a, l) => a + Math.max(0, l.quantity - l.sent), 0),
      totals, problem,
    });
  }
  return out;
}

export default async function posTicketRoutes(app: FastifyInstance) {
  const perms = (req: FastifyRequest) => req.tenant!.permissions;

  // Every open ticket of the location: the till's tabs. Shared by all tills there.
  app.get("/pos/tickets", { preHandler: requireTenant("pos.sell") }, async (req) => {
    const { locationId } = req.query as { locationId?: string };
    if (!isUuid(locationId)) throw badRequest("اختر الموقع");
    return tenantTx(req, async (db) => {
      const ids = (await db.query<{ id: string }>("SELECT id FROM pos_tickets WHERE location_id = $1 AND status = 'open' ORDER BY created_at LIMIT 200", [locationId])).rows.map((r) => r.id);
      return { items: await view(db, ids, perms(req)), serverTime: new Date().toISOString() };
    }, { readOnly: true });
  });

  app.get("/pos/tickets/:id", { preHandler: requireTenant("pos.sell") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const [t] = await view(db, [id], perms(req));
      if (!t) throw notFound("الطلب المفتوح غير موجود");
      return t;
    }, { readOnly: true });
  });

  app.post("/pos/tickets", { preHandler: requireTenant("pos.sell") }, async (req, reply) => {
    const key = idempotencyKey(req);
    const b = fieldsSchema.extend({ locationId: z.string().uuid() }).parse(req.body);
    const out = await tenantTx(req, async (db) => {
      const dup = (await db.query<{ id: string }>("SELECT id FROM pos_tickets WHERE idempotency_key = $1", [key])).rows[0];
      if (dup) return { id: dup.id, replay: true };
      await checkPlacement(db, b.locationId, b);
      if (b.items.length) await priceCart(db, { items: b.items, discount: b.discount }, perms(req));
      const n = (await db.query<{ n: string }>("SELECT next_counter('ticket')::text AS n")).rows[0]!.n;
      const items: TicketLine[] = b.items.map((l) => ({ ...l, sent: 0 }));
      await checkTableFree(db, b.tableId, null);
      const r = await db.query<{ id: string }>(
        `INSERT INTO pos_tickets (tenant_id, ticket_number, location_id, label, channel, table_id, guests, customer_id, platform_id, external_ref, discount, discount_reason,
                                  notes, items, idempotency_key, created_by)
         VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, app_user_id()) RETURNING id`,
        [n, b.locationId, b.label, b.channel, b.tableId, b.channel === "dine_in" ? b.guests : null, b.customerId, b.platformId, b.externalRef,
          b.discount ? JSON.stringify(b.discount) : null, b.discountReason, b.notes, JSON.stringify(items), key]);
      return { id: r.rows[0]!.id, replay: false };
    });
    const [t] = await tenantTx(req, (db) => view(db, [out.id], perms(req)), { readOnly: true });
    return reply.status(out.replay ? 200 : 201).send(t);
  });

  /**
   * Saves the whole ticket as the till shows it (autosave). Lines the kitchen already has keep their item and
   * options; their quantity can grow (the extra goes in the next round) but going below what was sent needs a
   * manager and a reason, and the kitchen is told at once.
   */
  app.put("/pos/tickets/:id", { preHandler: requireTenant("pos.sell") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = fieldsSchema.extend({ version: z.number().int(), voidReason: z.string().trim().max(200).nullable().optional().transform((v) => v || null) }).parse(req.body);
    await tenantTx(req, async (db) => {
      const t = await loadTicket(db, id, true);
      assertOpen(t, b.version);
      await checkPlacement(db, t.location_id, b);
      if (b.items.length) await priceCart(db, { items: b.items, discount: b.discount }, perms(req));
      else if (b.discount) throw badRequest("لا خصم على طلب فارغ");

      const voided: RoundLine[] = [];
      const next: TicketLine[] = b.items.map((l) => {
        const was = t.items.find((x) => x.id === l.id);
        if (!was || was.sent === 0) return { ...l, sent: 0 };
        if (was.recipeId !== l.recipeId || !sameOptions(was.modifiers, l.modifiers) || (was.note ?? null) !== l.note) {
          throw new AppError(409, "sent_line_locked", "لا يمكن تعديل صنف وصل للمطبخ. أضف التعديل سطراً جديداً");
        }
        if (l.quantity < was.sent) voided.push({ recipeId: l.recipeId, modifiers: l.modifiers, note: l.note, quantity: -(was.sent - l.quantity) });
        return { ...l, sent: Math.min(was.sent, l.quantity) };
      });
      for (const was of t.items) {
        if (was.sent > 0 && !b.items.some((l) => l.id === was.id)) voided.push({ recipeId: was.recipeId, modifiers: was.modifiers, note: was.note, quantity: -was.sent });
      }
      if (voided.length) {
        if (!perms(req).includes("pos.void")) throw forbidden("إلغاء صنف وصل للمطبخ يحتاج موافقة مدير");
        if (!b.voidReason || b.voidReason.length < 3) throw new AppError(422, "void_reason_required", "اكتب سبب إلغاء ما أُرسل للمطبخ");
        await kitchenRound(db, t, voided, null);
        await auditTenant(db, req, "ticket.items_voided", "pos_ticket", id, { reason: b.voidReason, lines: voided.length });
      }
      await checkTableFree(db, b.tableId, id);
      t.version += 1;
      await db.query(
        `UPDATE pos_tickets SET label = $2, channel = $3, table_id = $4, guests = $5, customer_id = $6, platform_id = $7, external_ref = $8, discount = $9,
                discount_reason = $10, notes = $11, items = $12, version = $13, updated_by = app_user_id() WHERE id = $1`,
        [id, b.label, b.channel, b.tableId, b.channel === "dine_in" ? b.guests : null, b.customerId, b.platformId, b.externalRef,
          b.discount ? JSON.stringify(b.discount) : null, b.discountReason, b.notes, JSON.stringify(next), t.version]);
    });
    const [t] = await tenantTx(req, (db) => view(db, [id], perms(req)), { readOnly: true });
    return t;
  });

  // What the kitchen does not have yet, as the next round.
  app.post("/pos/tickets/:id/send", { preHandler: requireTenant("pos.sell") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ version: z.number().int() }).parse(req.body);
    await tenantTx(req, async (db) => {
      const t = await loadTicket(db, id, true);
      assertOpen(t, b.version);
      const lines = t.items.filter((l) => l.quantity > l.sent).map((l) => ({ recipeId: l.recipeId, modifiers: l.modifiers, note: l.note, quantity: l.quantity - l.sent }));
      if (!lines.length) throw new AppError(409, "nothing_to_send", "كل الأصناف وصلت للمطبخ");
      await kitchenRound(db, t, lines, null);
      await saveLines(db, t, t.items.map((l) => ({ ...l, sent: l.quantity })));
      await auditTenant(db, req, "ticket.sent", "pos_ticket", id, { round: t.kitchen_rounds });
    });
    const [t] = await tenantTx(req, (db) => view(db, [id], perms(req)), { readOnly: true });
    return t;
  });

  // Cancels an unpaid ticket. If the kitchen has anything from it, only a manager can, with a reason.
  app.post("/pos/tickets/:id/void", { preHandler: requireTenant("pos.sell") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ version: z.number().int(), reason: z.string().trim().max(200).nullable().optional().transform((v) => v || null) }).parse(req.body);
    await tenantTx(req, async (db) => {
      const t = await loadTicket(db, id, true);
      assertOpen(t, b.version);
      const sent = t.items.filter((l) => l.sent > 0);
      if (sent.length) {
        if (!perms(req).includes("pos.void")) throw forbidden("إلغاء طلب وصل للمطبخ يحتاج موافقة مدير");
        if (!b.reason || b.reason.length < 3) throw new AppError(422, "void_reason_required", "اكتب سبب إلغاء الطلب");
        await kitchenRound(db, t, sent.map((l) => ({ recipeId: l.recipeId, modifiers: l.modifiers, note: l.note, quantity: -l.sent })), null);
      }
      await db.query("UPDATE pos_tickets SET status = 'void', void_reason = $2, closed_at = now(), closed_by = app_user_id(), version = version + 1 WHERE id = $1", [id, b.reason]);
      await auditTenant(db, req, "ticket.voided", "pos_ticket", id, { reason: b.reason, sentLines: sent.length });
    });
    return { ok: true };
  });

  // Moves the unpaid lines of one ticket into another (two tables joined, a guest moving over).
  app.post("/pos/tickets/:id/merge", { preHandler: requireTenant("pos.sell") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ version: z.number().int(), intoId: z.string().uuid(), intoVersion: z.number().int() }).parse(req.body);
    if (b.intoId === id) throw badRequest("اختر طلباً آخر");
    await tenantTx(req, async (db) => {
      const [first, second] = [id, b.intoId].sort();
      const a = await loadTicket(db, first!, true);
      const c = await loadTicket(db, second!, true);
      const [from, into] = a.id === id ? [a, c] : [c, a];
      assertOpen(from, b.version);
      assertOpen(into, b.intoVersion);
      if (from.location_id !== into.location_id) throw badRequest("الطلبان في موقعين مختلفين");
      await saveLines(db, into, [...into.items, ...from.items.map((l) => ({ ...l, id: randomUUID() }))]);
      await db.query("UPDATE pos_tickets SET kitchen_rounds = greatest(kitchen_rounds, $2) WHERE id = $1", [into.id, from.kitchen_rounds]);
      await db.query("UPDATE pos_tickets SET status = 'void', void_reason = $2, items = '[]', closed_at = now(), closed_by = app_user_id(), version = version + 1 WHERE id = $1",
        [from.id, `دُمج في T-${into.ticket_number}`]);
      await auditTenant(db, req, "ticket.merged", "pos_ticket", from.id, { into: into.id });
    });
    const [t] = await tenantTx(req, (db) => view(db, [b.intoId], perms(req)), { readOnly: true });
    return t;
  });
}
