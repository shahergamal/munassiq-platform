import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { systemPool, type Db } from "../../db/pool.ts";
import { rawQuantityFor, round4, weightedAverage } from "../../lib/costing.ts";
import { AppError, badRequest, forbidden, notFound } from "../../lib/errors.ts";
import { formatMoney, parseMoney, percentToBp, priceOrder, splitGross, type Discount } from "../../lib/money.ts";
import { pageMeta, parsePage, sortSql } from "../../lib/pagination.ts";
import type { Permission } from "../../lib/rbac.ts";
import { buildQrBase64, GENESIS_HASH, integrityHash } from "../../lib/zatca.ts";
import { auditTenant, isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";
import { idempotencyKey } from "./purchases.ts";
import { postPosOrder, postPosRefund, postShiftClose } from "../../lib/accounting/posting.ts";
import { stampPosOrder, stampPosRefund, submitSoon } from "../../lib/zatca/service.ts";
import { resolveTicketCart, settleTicket } from "./posTickets.ts";

const methods = z.enum(["cash", "mada", "visa", "mastercard", "platform"]);

const SHIFT_SORT = ["locationName", "openedAt", "closedAt", "ordersCount", "salesTotal", "expectedCash", "overShort", "status"];
const ORDER_SORT = ["number", "createdAt", "channel", "locationName", "vat", "total", "status"];

export const orderSchema = z.object({
  locationId: z.string().uuid(),
  shiftId: z.string().uuid(),
  channel: z.enum(["dine_in", "takeaway", "delivery"]),
  customerName: z.string().trim().max(120).nullable().optional().transform((v) => v || null),
  notes: z.string().trim().max(500).nullable().optional().transform((v) => v || null),
  discount: z.object({ type: z.enum(["amount", "percent"]), value: z.number().min(0).max(1_000_000) }).nullable().default(null),
  discountReason: z.string().trim().max(300).nullable().optional().transform((v) => v || null),
  items: z.array(z.object({
    recipeId: z.string().uuid(),
    quantity: z.number().int().min(1).max(1000),
    modifiers: z.array(z.string().uuid()).max(20).default([]),
    /** For the kitchen and the receipt ("no onions"). */
    note: z.string().trim().max(140).nullable().optional().transform((v) => v || null),
  })).min(1, "السلة فارغة").max(100),
  tableId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
  guests: z.number().int().min(1).max(100).nullable().optional().transform((v) => v ?? null),
  customerId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
  platformId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
  externalRef: z.string().trim().max(60).nullable().optional().transform((v) => v || null),
  payments: z.array(z.object({ method: methods, amount: z.number().positive().max(1_000_000) })).min(1, "أضف طريقة دفع").max(6),
  /** Paying an open ticket (all of it, or chosen lines for a split bill). The ticket, not the browser, decides the items. */
  ticket: z.object({
    id: z.string().uuid(),
    version: z.number().int(),
    lines: z.array(z.object({ lineId: z.string().uuid(), quantity: z.number().int().min(1).max(1000) })).min(1).max(100).optional(),
  }).nullable().optional().transform((v) => v ?? null),
});

/** Issues an e-invoice row and advances the per-location hash chain (row is locked, so ICVs never collide). */
async function issueInvoice(
  db: Db, p: { locationId: string; orderId: string; refundId: string | null; kind: "simplified_invoice" | "credit_note"; total: number; vat: number; qr?: string | null },
) {
  const t = (await db.query<{ company_name: string; tax_id: string }>("SELECT company_name, tax_id FROM tenants")).rows[0];
  if (!t) throw new AppError(500, "internal", "tenant missing");
  await db.query(
    "INSERT INTO invoice_sequences (tenant_id, location_id) VALUES (app_tenant_id(), $1) ON CONFLICT DO NOTHING", [p.locationId]);
  const seq = (await db.query<{ next_icv: string; previous_hash: string }>(
    "SELECT next_icv::text, previous_hash FROM invoice_sequences WHERE location_id = $1 FOR UPDATE", [p.locationId])).rows[0];
  const icv = Number(seq?.next_icv ?? 1);
  const previous = seq?.previous_hash ?? GENESIS_HASH;
  const issuedAt = new Date();
  const total = formatMoney(p.total);
  const vat = formatMoney(p.vat);
  // Phase 2 (a ZATCA device is active): the stamped 9-tag QR; otherwise the Phase 1 QR.
  const qr = p.qr ?? buildQrBase64({ sellerName: t.company_name, vatNumber: t.tax_id, issuedAt, totalWithVat: total, vatAmount: vat });
  const hash = integrityHash(previous, { icv, kind: p.kind, order: p.orderId, total, vat, issuedAt: issuedAt.toISOString() });
  await db.query(
    `INSERT INTO e_invoices (tenant_id, location_id, kind, icv, order_id, refund_id, issued_at, seller_name, vat_number, total, vat, previous_hash, integrity_hash, qr_base64)
     VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [p.locationId, p.kind, icv, p.orderId, p.refundId, issuedAt, t.company_name, t.tax_id, total, vat, previous, hash, qr],
  );
  await db.query("UPDATE invoice_sequences SET next_icv = $2, previous_hash = $3 WHERE location_id = $1", [p.locationId, icv + 1, hash]);
  return { icv, qr };
}

async function loadOpenShift(db: Db, shiftId: string, userId: string, perms: readonly Permission[]) {
  const s = (await db.query<{ location_id: string; opened_by: string; status: string }>(
    "SELECT location_id, opened_by, status FROM pos_shifts WHERE id = $1 FOR SHARE", [shiftId])).rows[0];
  if (!s) throw notFound("الشفت غير موجود");
  if (s.status !== "open") throw new AppError(409, "shift_closed", "الشفت مغلق. افتح شفتاً جديداً");
  if (s.opened_by !== userId && !perms.includes("pos.supervise")) throw forbidden("هذا الشفت يخص كاشيراً آخر");
  return s;
}


type CartInput = { items: { recipeId: string; quantity: number; modifiers: string[] }[]; discount: { type: "amount" | "percent"; value: number } | null };
interface OptionRow { id: string; group_id: string; name: string; price_net: string; ingredient_id: string | null; ingredient_name: string | null; q: number | null; active: boolean }

/**
 * The ONE place a cart is priced. Used by the quote (what the cashier sees and charges) and by the sale
 * (what is recorded), so the two can never disagree. Also enforces the cashier's discount limit.
 */
export async function priceCart(db: Db, body: CartInput, perms: readonly Permission[]) {
  const settings = (await db.query<{ vat: number; approval: number }>(
    "SELECT vat_rate_percent::float8 AS vat, discount_approval_percent::float8 AS approval FROM tenant_settings")).rows[0];
  if (!settings) throw new AppError(500, "internal", "settings missing");

  const recipeIds = [...new Set(body.items.map((i) => i.recipeId))];
  const recipes = (await db.query<{ id: string; name: string; price_net: string }>(
    "SELECT id, name, price_net::text FROM recipes WHERE id = ANY($1::uuid[]) AND status = 'approved'", [recipeIds])).rows;
  const byId = new Map(recipes.map((r) => [r.id, r]));
  for (const id of recipeIds) if (!byId.has(id)) throw new AppError(422, "recipe_unavailable", "أحد الأصناف غير متاح للبيع");

  // Modifiers: every option must be active and belong to a group linked to THAT recipe; each group's min/max is enforced.
  const optionIds = [...new Set(body.items.flatMap((i) => i.modifiers))];
  const options = optionIds.length ? (await db.query<OptionRow>(
    `SELECT o.id, o.group_id, o.name, o.price_net::text, o.ingredient_id, i.name AS ingredient_name, o.ingredient_qty::float8 AS q, (o.is_active AND g.is_active) AS active
       FROM modifier_options o JOIN modifier_groups g ON g.id = o.group_id LEFT JOIN ingredients i ON i.id = o.ingredient_id
      WHERE o.id = ANY($1::uuid[])`, [optionIds])).rows : [];
  const optBy = new Map(options.map((o) => [o.id, o]));
  const links = (await db.query<{ recipe_id: string; group_id: string; name: string; min_select: number; max_select: number }>(
    `SELECT rmg.recipe_id, g.id AS group_id, g.name, g.min_select, g.max_select
       FROM recipe_modifier_groups rmg JOIN modifier_groups g ON g.id = rmg.group_id AND g.is_active WHERE rmg.recipe_id = ANY($1::uuid[])`, [recipeIds])).rows;
  for (const line of body.items) {
    if (new Set(line.modifiers).size !== line.modifiers.length) throw badRequest("لا يمكن تكرار نفس الإضافة في السطر");
    const groups = links.filter((l) => l.recipe_id === line.recipeId);
    for (const m of line.modifiers) {
      const o = optBy.get(m);
      if (!o || !o.active) throw new AppError(422, "modifier_unavailable", "إحدى الإضافات غير متاحة");
      if (!groups.some((g) => g.group_id === o.group_id)) throw new AppError(422, "modifier_unavailable", "إحدى الإضافات لا تخص هذا الصنف");
    }
    for (const g of groups) {
      const n = line.modifiers.filter((m) => optBy.get(m)?.group_id === g.group_id).length;
      if (n < g.min_select || n > g.max_select) {
        throw new AppError(422, "modifier_selection", g.min_select === g.max_select ? `اختر ${g.min_select} من «${g.name}»` : `اختر من ${g.min_select} إلى ${g.max_select} من «${g.name}»`, { group: g.name });
      }
    }
  }
  const unitNet = (line: CartInput["items"][number]) =>
    parseMoney((byId.get(line.recipeId) as { price_net: string }).price_net) + line.modifiers.reduce((a, m) => a + parseMoney((optBy.get(m) as OptionRow).price_net), 0);

  const discount: Discount = body.discount
    ? body.discount.type === "amount"
      ? { type: "amount", value: parseMoney(body.discount.value) }
      : { type: "percent", valueBp: percentToBp(body.discount.value) }
    : null;
  let priced;
  try {
    priced = priceOrder(
      body.items.map((i) => ({ unitNet: unitNet(i), quantity: i.quantity })),
      discount, percentToBp(settings.vat));
  } catch (e) {
    if (e instanceof RangeError) throw badRequest("الخصم أكبر من إجمالي الطلب");
    throw e;
  }
  if (priced.discount > 0) {
    const pct = priced.subtotal > 0 ? (priced.discount / priced.subtotal) * 100 : 0;
    if (pct > settings.approval && !perms.includes("pos.discount")) {
      throw new AppError(403, "manager_approval_required", `الخصم يتجاوز ${settings.approval}% ويحتاج موافقة مدير`);
    }
  }
  return { priced, byId, optBy, unitNet, vatRate: settings.vat };
}

export type OrderInput = Omit<z.infer<typeof orderSchema>, "payments"> & { payments: { method: z.infer<typeof methods> | "online"; amount: number }[] };

/**
 * One sale, inside the caller's transaction: prices, stock, the order, the invoice (stamped when a ZATCA device is
 * active) and its journal entry. Used by the till and by an online payment confirmed by the gateway.
 */
export async function performSale(db: Db, input: OrderInput, key: string, perms: readonly Permission[], userId: string,
  audit: (db: Db, orderId: string, total: string) => Promise<void>) {
  const dup = (await db.query<{ id: string; order_number: string; total: string; vat: string }>(
    "SELECT id, order_number::text, total::text, vat::text FROM pos_orders WHERE idempotency_key = $1", [key])).rows[0];
  if (dup) return { id: dup.id, orderNumber: Number(dup.order_number), total: Number(dup.total), vat: Number(dup.vat), qr: null, replay: true, ticketClosed: null };
  const { body, ticket, take } = await resolveTicketCart(db, input, true);

  const shift = await loadOpenShift(db, body.shiftId, userId, perms);
  if (shift.location_id !== body.locationId) throw badRequest("الشفت لا يخص هذا الموقع");

  const { priced, byId, optBy, unitNet } = await priceCart(db, body, perms);
  if (priced.discount > 0 && (!body.discountReason || body.discountReason.length < 3)) throw badRequest("اكتب سبب الخصم");

  // Where the order goes: a table (dine-in), a delivery platform (settled by the platform), and/or a known customer.
  if (body.tableId) {
    if (body.channel !== "dine_in") throw badRequest("الطاولة للطلبات المحلية فقط");
    const t = (await db.query<{ ok: boolean }>(
      "SELECT (t.is_active AND a.is_active AND a.location_id = $2) AS ok FROM dining_tables t JOIN dining_areas a ON a.id = t.area_id WHERE t.id = $1", [body.tableId, body.locationId])).rows[0];
    if (!t?.ok) throw new AppError(422, "table_unavailable", "الطاولة غير متاحة في هذا الموقع");
  }
  let commissionPct = 0;
  if (body.platformId) {
    if (body.channel !== "delivery") throw badRequest("تطبيق التوصيل لطلبات التوصيل فقط");
    const p = (await db.query<{ pct: number; is_active: boolean }>("SELECT commission_percent::float8 AS pct, is_active FROM delivery_platforms WHERE id = $1", [body.platformId])).rows[0];
    if (!p?.is_active) throw new AppError(422, "platform_unavailable", "تطبيق التوصيل غير متاح");
    if (body.payments.some((pm) => pm.method !== "platform")) throw new AppError(422, "payment_mismatch", "طلبات التطبيقات تُسدَّد عبر التطبيق فقط");
    commissionPct = p.pct;
  } else if (body.payments.some((pm) => pm.method === "platform")) {
    throw new AppError(422, "payment_mismatch", "الدفع عبر التطبيق لطلبات التطبيقات فقط");
  }
  // Commission on the VAT-exclusive amount, half-up to the halala (commissionPct has 2 decimals → ×100 basis points).
  const commission = Math.floor((priced.taxable * Math.round(commissionPct * 100) + 5000) / 10000);
  const paid = body.payments.reduce((a, p) => a + parseMoney(p.amount), 0);
  if (paid !== priced.total) {
    throw new AppError(422, "payment_mismatch", "مجموع الدفعات لا يساوي إجمالي الطلب", { expected: priced.total / 100, received: paid / 100 });
  }

  // Stock: compute raw consumption per line, lock the stock rows in a stable order, verify, deduct.
  const recipeItems = (await db.query<{ recipe_id: string; ingredient_id: string; q: number; y: number; name: string }>(
    `SELECT ri.recipe_id, ri.ingredient_id, ri.quantity::float8 AS q, i.yield_percentage::float8 AS y, i.name
       FROM recipe_items ri JOIN ingredients i ON i.id = ri.ingredient_id WHERE ri.recipe_id = ANY($1::uuid[])`, [[...byId.keys()]])).rows;
  const need = new Map<string, number>();
  const names = new Map<string, string>();
  const lineNeeds = body.items.map((line) => [
    ...recipeItems.filter((r) => r.recipe_id === line.recipeId).map((r) => {
      const raw = rawQuantityFor(r.q * line.quantity, r.y);
      need.set(r.ingredient_id, round4((need.get(r.ingredient_id) ?? 0) + raw));
      names.set(r.ingredient_id, r.name);
      return { ingredientId: r.ingredient_id, raw };
    }),
    // A modifier that consumes an ingredient (extra cheese) takes its RAW quantity per unit sold.
    ...line.modifiers.map((m) => optBy.get(m) as OptionRow).filter((o) => o.ingredient_id && o.q).map((o) => {
      const raw = round4((o.q as number) * line.quantity);
      need.set(o.ingredient_id as string, round4((need.get(o.ingredient_id as string) ?? 0) + raw));
      names.set(o.ingredient_id as string, o.ingredient_name ?? "");
      return { ingredientId: o.ingredient_id as string, raw };
    }),
  ]);
  const ingredientIds = [...need.keys()].sort();
  const stock = (await db.query<{ ingredient_id: string; q: number; c: number }>(
    `SELECT ingredient_id, quantity::float8 AS q, avg_cost::float8 AS c FROM stock_levels
      WHERE location_id = $1 AND ingredient_id = ANY($2::uuid[]) ORDER BY ingredient_id FOR UPDATE`,
    [body.locationId, ingredientIds])).rows;
  const stockBy = new Map(stock.map((s) => [s.ingredient_id, s]));
  for (const id of ingredientIds) {
    const have = stockBy.get(id)?.q ?? 0;
    if (have < (need.get(id) as number)) {
      throw new AppError(409, "insufficient_stock", `الرصيد غير كافٍ للمكوّن: ${names.get(id)}`, { ingredient: names.get(id), available: have, required: need.get(id) });
    }
  }
  const orderId = await (async () => {
    const n = (await db.query<{ n: string }>("SELECT next_counter('order')::text AS n")).rows[0] as { n: string };
    const lineCosts = lineNeeds.map((needs) => needs.reduce((a, x) => a + x.raw * (stockBy.get(x.ingredientId)?.c ?? 0), 0));
    const costTotal = round4(lineCosts.reduce((a, b) => a + b, 0));
    const o = await db.query<{ id: string }>(
      `INSERT INTO pos_orders (tenant_id, order_number, location_id, shift_id, channel, subtotal, discount, taxable, vat, total, cost_total,
                               discount_reason, customer_name, notes, idempotency_key, created_by,
                               table_id, guests, customer_id, platform_id, external_ref, commission_amount, ticket_id)
       VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, app_user_id(), $15, $16, $17, $18, $19, $20, $21) RETURNING id`,
      [n.n, body.locationId, body.shiftId, body.channel, formatMoney(priced.subtotal), formatMoney(priced.discount), formatMoney(priced.taxable),
        formatMoney(priced.vat), formatMoney(priced.total), costTotal, body.discountReason, body.customerName, body.notes, key,
        body.tableId, body.channel === "dine_in" ? body.guests : null, body.customerId, body.platformId, body.externalRef, formatMoney(commission), ticket?.id ?? null]);
    const id = (o.rows[0] as { id: string }).id;
    for (const [i, line] of body.items.entries()) {
      const p = priced.lines[i] as (typeof priced.lines)[number];
      const rec = byId.get(line.recipeId) as { name: string; price_net: string };
      const item = (await db.query<{ id: string }>(
        `INSERT INTO pos_order_items (tenant_id, order_id, recipe_id, name_snapshot, quantity, unit_price_net, line_net, discount, vat, line_total, cost, note)
         VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [id, line.recipeId, rec.name, line.quantity, formatMoney(unitNet(line)), formatMoney(p.net), formatMoney(p.discount), formatMoney(p.vat), formatMoney(p.total), round4(lineCosts[i] as number),
          line.note ?? null])).rows[0] as { id: string };
      for (const m of line.modifiers) {
        const o = optBy.get(m) as OptionRow;
        await db.query("INSERT INTO pos_order_item_modifiers (tenant_id, order_item_id, option_id, name_snapshot, price_net) VALUES (app_tenant_id(), $1, $2, $3, $4)",
          [item.id, o.id, o.name, o.price_net]);
      }
    }
    return id;
  })();

  for (const ingId of ingredientIds) {
    const s = stockBy.get(ingId) as { q: number; c: number };
    const use = need.get(ingId) as number;
    await db.query("UPDATE stock_levels SET quantity = $3, updated_at = now() WHERE location_id = $1 AND ingredient_id = $2", [body.locationId, ingId, round4(s.q - use)]);
    await db.query(
      `INSERT INTO stock_movements (tenant_id, location_id, ingredient_id, movement_type, quantity, unit_cost, ref_type, ref_id, created_by)
       VALUES (app_tenant_id(), $1, $2, 'sale', $3, $4, 'pos_order', $5, app_user_id())`,
      [body.locationId, ingId, -use, s.c, orderId]);
  }
  for (const p of body.payments) {
    await db.query(
      "INSERT INTO pos_payments (tenant_id, order_id, shift_id, method, amount, created_by) VALUES (app_tenant_id(), $1, $2, $3, $4, app_user_id())",
      [orderId, body.shiftId, p.method, formatMoney(parseMoney(p.amount))]);
  }
  // A ticket already told the kitchen what it has; only what the kitchen never got goes now. A direct sale is one ticket.
  const ticketClosed = ticket ? await settleTicket(db, ticket, take, orderId) : null;
  if (!ticket) await db.query("INSERT INTO kitchen_tickets (tenant_id, order_id, location_id) VALUES (app_tenant_id(), $1, $2)", [orderId, body.locationId]);
  const stamped = await stampPosOrder(db, orderId);
  const inv = await issueInvoice(db, { locationId: body.locationId, orderId, refundId: null, kind: "simplified_invoice", total: priced.total, vat: priced.vat, qr: stamped?.qr });
  await postPosOrder(db, orderId);
  const num = (await db.query<{ n: string }>("SELECT order_number::text AS n FROM pos_orders WHERE id = $1", [orderId])).rows[0] as { n: string };
  await audit(db, orderId, formatMoney(priced.total));
  return { id: orderId, orderNumber: Number(num.n), total: priced.total / 100, vat: priced.vat / 100, qr: inv.qr, replay: false, ticketClosed, zatcaDocument: stamped?.documentId ?? null };
}

export default async function posRoutes(app: FastifyInstance) {
  // ── Menu: approved recipes with how many portions the location can still make ──────────────
  app.get("/pos/menu", { preHandler: requireTenant("pos.sell") }, async (req) => {
    const { locationId } = req.query as { locationId?: string };
    if (!isUuid(locationId)) throw badRequest("اختر الموقع");
    return tenantTx(req, async (db) => {
      const { rows } = await db.query(
        `SELECT r.id, r.code, r.name, r.category, r.price_net::float8 AS "priceNet",
                round(r.price_net * (1 + (SELECT vat_rate_percent FROM tenant_settings) / 100), 2)::float8 AS "priceGross",
                least(9999, coalesce((
                  SELECT min(floor(coalesce(sl.quantity, 0) / (ri.quantity / (i.yield_percentage / 100))))
                    FROM recipe_items ri JOIN ingredients i ON i.id = ri.ingredient_id
                    LEFT JOIN stock_levels sl ON sl.ingredient_id = ri.ingredient_id AND sl.location_id = $1
                   WHERE ri.recipe_id = r.id), 0))::int AS available
           FROM recipes r WHERE r.status = 'approved' ORDER BY r.category NULLS LAST, r.name`, [locationId]);
      const groups = (await db.query<{ recipe_id: string; id: string; name: string; min: number; max: number; options: { id: string; name: string; priceNet: number; priceGross: number }[] }>(
        `SELECT rmg.recipe_id, g.id, g.name, g.min_select AS min, g.max_select AS max,
                coalesce(json_agg(json_build_object('id', o.id, 'name', o.name, 'priceNet', o.price_net::float8,
                  'priceGross', round(o.price_net * (1 + (SELECT vat_rate_percent FROM tenant_settings) / 100), 2)::float8) ORDER BY o.sort_order, o.name)
                  FILTER (WHERE o.id IS NOT NULL), '[]') AS options
           FROM recipe_modifier_groups rmg JOIN modifier_groups g ON g.id = rmg.group_id AND g.is_active
           LEFT JOIN modifier_options o ON o.group_id = g.id AND o.is_active
          GROUP BY rmg.recipe_id, g.id, g.name, g.min_select, g.max_select, rmg.sort_order ORDER BY rmg.sort_order, g.name`)).rows;
      return { items: rows.map((r) => ({ ...r, modifierGroups: groups.filter((g) => g.recipe_id === r.id).map(({ recipe_id, ...g }) => g) })) };
    }, { readOnly: true });
  });

  // ── Shifts ───────────────────────────────────────────────────────────────────────────────────
  app.get("/pos/shift", { preHandler: requireTenant("pos.sell") }, async (req) => {
    const { locationId } = req.query as { locationId?: string };
    if (!isUuid(locationId)) throw badRequest("اختر الموقع");
    return tenantTx(req, async (db) => {
      const s = (await db.query(
        `SELECT s.id, s.opened_at AS "openedAt", s.opening_float::float8 AS "openingFloat",
                coalesce((SELECT sum(amount) FROM pos_payments p WHERE p.shift_id = s.id AND p.method = 'cash'), 0)::float8 AS "cashSales",
                coalesce((SELECT sum(amount) FROM pos_payments p WHERE p.shift_id = s.id AND p.method <> 'cash'), 0)::float8 AS "cardSales",
                coalesce((SELECT sum(amount) FROM pos_refunds f WHERE f.shift_id = s.id AND f.method = 'cash'), 0)::float8 AS "cashRefunds",
                (SELECT count(*)::int FROM pos_orders o WHERE o.shift_id = s.id) AS "ordersCount"
           FROM pos_shifts s WHERE s.location_id = $1 AND s.opened_by = app_user_id() AND s.status = 'open'`, [locationId])).rows[0];
      return { shift: s ?? null };
    }, { readOnly: true });
  });

  // Shift history. Expected cash / over-short are only known after closing (blind count), so open shifts show null.
  app.get("/pos/shifts", { preHandler: requireTenant("shifts.view") }, async (req) => {
    const q = req.query as { status?: string; locationId?: string; page?: string; pageSize?: string; sort?: string };
    const page = parsePage(q);
    const status = q.status === "open" || q.status === "closed" ? q.status : null;
    const loc = isUuid(q.locationId) ? q.locationId : null;
    return tenantTx(req, async (db) => {
      const { rows } = await db.query(
        `SELECT s.id, s.status, s.opened_at AS "openedAt", s.closed_at AS "closedAt", l.name AS "locationName",
                s.opened_by AS "openedBy", s.opening_float::float8 AS "openingFloat",
                s.expected_cash::float8 AS "expectedCash", s.counted_cash::float8 AS "countedCash", s.over_short::float8 AS "overShort",
                (SELECT count(*)::int FROM pos_orders o WHERE o.shift_id = s.id) AS "ordersCount",
                coalesce((SELECT sum(total) FROM pos_orders o WHERE o.shift_id = s.id), 0)::float8 AS "salesTotal",
                (s.opened_by = app_user_id()) AS "isMine", count(*) OVER()::int AS "_total"
           FROM pos_shifts s JOIN locations l ON l.id = s.location_id
          WHERE ($1::text IS NULL OR s.status = $1) AND ($2::uuid IS NULL OR s.location_id = $2)
          ORDER BY ${sortSql(q.sort, SHIFT_SORT)}s.opened_at DESC LIMIT $3 OFFSET $4`, [status, loc, page.pageSize, page.offset]);
      return rows;
    }, { readOnly: true }).then(async (rows) => {
      // Names come from the auth tables (system pool), limited to members of THIS tenant.
      const ids = [...new Set(rows.map((r) => r.openedBy as string))];
      const names = ids.length
        ? new Map((await systemPool.query<{ id: string; full_name: string }>(
            "SELECT u.id, u.full_name FROM users u JOIN memberships m ON m.user_id = u.id AND m.tenant_id = $1 WHERE u.id = ANY($2::uuid[])",
            [req.tenant!.id, ids])).rows.map((r) => [r.id, r.full_name]))
        : new Map<string, string>();
      const items = rows.map(({ _total, openedBy, ...r }) => ({ ...r, openedByName: names.get(openedBy as string) ?? null }));
      return { items, meta: pageMeta(page, rows[0]?._total ?? 0) };
    });
  });

  app.post("/pos/shifts/open", { preHandler: requireTenant("pos.sell") }, async (req, reply) => {
    const key = idempotencyKey(req);
    const body = z.object({ locationId: z.string().uuid(), openingFloat: z.number().min(0).max(1_000_000) }).parse(req.body);
    const id = await tenantTx(req, async (db) => {
      const dup = await db.query<{ id: string }>("SELECT id FROM pos_shifts WHERE idempotency_key = $1", [key]);
      if (dup.rows[0]) return dup.rows[0].id;
      try {
        const r = await db.query<{ id: string }>(
          `INSERT INTO pos_shifts (tenant_id, location_id, opened_by, opening_float, idempotency_key)
           VALUES (app_tenant_id(), $1, app_user_id(), $2, $3) RETURNING id`,
          [body.locationId, formatMoney(parseMoney(body.openingFloat)), key]);
        const newId = (r.rows[0] as { id: string }).id;
        await auditTenant(db, req, "shift.opened", "pos_shift", newId);
        return newId;
      } catch (err) {
        if ((err as { constraint?: string }).constraint === "pos_one_open_shift_uq") {
          throw new AppError(409, "shift_already_open", "لديك شفت مفتوح بالفعل في هذا الموقع");
        }
        throw err;
      }
    });
    return reply.status(201).send({ id });
  });

  app.post("/pos/shifts/:id/close", { preHandler: requireTenant("pos.sell") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const body = z.object({ countedCash: z.number().min(0).max(10_000_000) }).parse(req.body);
    return tenantTx(req, async (db) => {
      const s = (await db.query<{ status: string; opened_by: string; opening_float: string }>(
        "SELECT status, opened_by, opening_float::text FROM pos_shifts WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!s) throw notFound();
      if (s.status !== "open") throw new AppError(409, "shift_closed", "الشفت مغلق بالفعل");
      if (s.opened_by !== req.tenant!.userId && !req.tenant!.permissions.includes("pos.supervise")) throw forbidden("لا يمكنك إغلاق شفت كاشير آخر");
      const sums = (await db.query<{ cash_in: string; cash_out: string }>(
        `SELECT coalesce((SELECT sum(amount) FROM pos_payments WHERE shift_id = $1 AND method = 'cash'), 0)::text AS cash_in,
                coalesce((SELECT sum(amount) FROM pos_refunds WHERE shift_id = $1 AND method = 'cash'), 0)::text AS cash_out`, [id])).rows[0];
      const expected = parseMoney(s.opening_float) + parseMoney(sums?.cash_in ?? "0") - parseMoney(sums?.cash_out ?? "0");
      const counted = parseMoney(body.countedCash);
      await db.query(
        `UPDATE pos_shifts SET status = 'closed', closed_by = app_user_id(), closed_at = now(),
                expected_cash = $2, counted_cash = $3, over_short = $4 WHERE id = $1`,
        [id, formatMoney(expected), formatMoney(counted), ((counted - expected) / 100).toFixed(2)]);
      await postShiftClose(db, id);
      await auditTenant(db, req, "shift.closed", "pos_shift", id, { expected: formatMoney(expected), counted: formatMoney(counted) });
      return { expectedCash: expected / 100, countedCash: counted / 100, overShort: (counted - expected) / 100 };
    });
  });

  /**
   * X report: the shift so far, without closing it. The count stays blind: whoever cannot close another cashier's
   * shift (no pos:refund) does not see the cash figures of an open shift, only the non-cash ones.
   */
  app.get("/pos/shifts/:id/summary", { preHandler: requireTenant("pos.sell", "shifts.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const manager = req.tenant!.permissions.includes("pos.supervise");
    return tenantTx(req, async (db) => {
      const s = (await db.query<{ status: string; opened_by: string; location_id: string; opened_at: string; opening_float: number; expected_cash: number | null; counted_cash: number | null; over_short: number | null }>(
        `SELECT status, opened_by, location_id, opened_at, opening_float::float8 AS opening_float, expected_cash::float8 AS expected_cash,
                counted_cash::float8 AS counted_cash, over_short::float8 AS over_short FROM pos_shifts WHERE id = $1`, [id])).rows[0];
      if (!s) throw notFound();
      if (s.opened_by !== req.tenant!.userId && !manager) throw forbidden("هذا الشفت يخص كاشيراً آخر");
      const showCash = manager || s.status === "closed";
      const totals = (await db.query(
        `SELECT count(*)::int AS "ordersCount", coalesce(sum(total), 0)::float8 AS "salesTotal", coalesce(sum(discount), 0)::float8 AS discounts,
                coalesce(sum(vat), 0)::float8 AS vat, coalesce(sum(subtotal - discount), 0)::float8 AS "netSales", coalesce(sum(guests), 0)::int AS guests,
                count(*) FILTER (WHERE discount > 0)::int AS "discountedOrders"
           FROM pos_orders WHERE shift_id = $1`, [id])).rows[0];
      const byMethod = (await db.query<{ method: string; amount: number; count: number }>(
        "SELECT method, sum(amount)::float8 AS amount, count(*)::int AS count FROM pos_payments WHERE shift_id = $1 GROUP BY method ORDER BY 2 DESC", [id])).rows
        .map((m) => (m.method === "cash" && !showCash ? { ...m, amount: null } : m));
      const byChannel = (await db.query(
        `SELECT channel, count(*)::int AS count, sum(total)::float8 AS total FROM pos_orders WHERE shift_id = $1 GROUP BY channel ORDER BY 3 DESC`, [id])).rows;
      const refunds = (await db.query<{ count: number; amount: number; cash: number }>(
        `SELECT count(*)::int AS count, coalesce(sum(amount), 0)::float8 AS amount, coalesce(sum(amount) FILTER (WHERE method = 'cash'), 0)::float8 AS cash
           FROM pos_refunds WHERE shift_id = $1`, [id])).rows[0]!;
      const topItems = (await db.query(
        `SELECT oi.name_snapshot AS name, sum(oi.quantity)::int AS quantity, sum(oi.line_total)::float8 AS total
           FROM pos_order_items oi JOIN pos_orders o ON o.id = oi.order_id WHERE o.shift_id = $1 GROUP BY 1 ORDER BY 2 DESC, 3 DESC LIMIT 10`, [id])).rows;
      const openTickets = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pos_tickets WHERE location_id = $1 AND status = 'open'", [s.location_id])).rows[0]!.n;
      const cashIn = byMethod.find((m) => m.method === "cash")?.amount ?? 0;
      return {
        status: s.status, openedAt: s.opened_at, ...totals, byMethod, byChannel, topItems, openTickets,
        refunds: { count: refunds.count, amount: refunds.amount, cash: showCash ? refunds.cash : null },
        openingFloat: showCash ? s.opening_float : null,
        expectedCash: s.status === "closed" ? s.expected_cash : showCash ? Math.round((s.opening_float + (cashIn as number) - refunds.cash) * 100) / 100 : null,
        countedCash: s.counted_cash, overShort: s.over_short, blind: !showCash,
      };
    }, { readOnly: true });
  });

  // ── Orders ───────────────────────────────────────────────────────────────────────────────────
  // Quote: the cart priced by the server. The cashier charges exactly this total; nothing is written.
  app.post("/pos/quote", { preHandler: requireTenant("pos.sell") }, async (req) => {
    const body = orderSchema.pick({ items: true, discount: true }).parse(req.body);
    return tenantTx(req, async (db) => {
      const { priced, byId, optBy, vatRate } = await priceCart(db, body, req.tenant!.permissions);
      const h = (v: number) => v / 100;
      return {
        vatRatePercent: vatRate,
        lines: body.items.map((it, i) => {
          const l = priced.lines[i]!;
          return { recipeId: it.recipeId, name: (byId.get(it.recipeId) as { name: string }).name, modifiers: it.modifiers.map((m) => (optBy.get(m) as OptionRow).name),
            quantity: it.quantity, net: h(l.net), discount: h(l.discount), vat: h(l.vat), total: h(l.total) };
        }),
        subtotal: h(priced.subtotal), discount: h(priced.discount), taxable: h(priced.taxable), vat: h(priced.vat), total: h(priced.total),
      };
    }, { readOnly: true });
  });

  // Prices, VAT, discount limits, stock and cost are ALL decided here from database values. The browser sends only ids and quantities.
  app.post("/pos/orders", { preHandler: requireTenant("pos.sell") }, async (req, reply) => {
    const key = idempotencyKey(req);
    const body = orderSchema.parse(req.body);
    const perms = req.tenant!.permissions;
    const userId = req.tenant!.userId;

    const result = await tenantTx(req, (db) => performSale(db, body, key, perms, userId,
      (db, orderId, total) => auditTenant(db, req, "order.completed", "pos_order", orderId, { total })));
    const { zatcaDocument, ...out } = result as typeof result & { zatcaDocument?: string | null };
    if (zatcaDocument) submitSoon({ tenantId: req.tenant!.id, userId: req.tenant!.userId }, zatcaDocument, (err) => req.log.warn({ err }, "zatca reporting deferred"));
    return reply.status(out.replay ? 200 : 201).send(out);
  });

  app.get("/pos/orders", { preHandler: requireTenant("orders.view", "pos.sell", "shifts.view") }, async (req) => {
    const q = req.query as { shiftId?: string; from?: string; to?: string; page?: string; pageSize?: string; sort?: string };
    const page = parsePage(q);
    const shift = isUuid(q.shiftId) ? q.shiftId : null;
    const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from ?? "") ? q.from : null;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to ?? "") ? q.to : null;
    return tenantTx(req, async (db) => {
      const { rows } = await db.query(
        `SELECT o.id, o.order_number AS "number", o.channel, o.status, o.total::float8 AS total, o.vat::float8 AS vat,
                o.created_at AS "createdAt", l.name AS "locationName", t.name AS "tableName", p.name AS "platformName",
                (SELECT coalesce(sum(oi.quantity), 0)::float8 FROM pos_order_items oi WHERE oi.order_id = o.id) AS "itemsCount",
                count(*) OVER()::int AS "_total"
           FROM pos_orders o JOIN locations l ON l.id = o.location_id
           LEFT JOIN dining_tables t ON t.id = o.table_id LEFT JOIN delivery_platforms p ON p.id = o.platform_id
          WHERE ($1::uuid IS NULL OR o.shift_id = $1) AND ($2::date IS NULL OR o.created_at >= $2::date) AND ($3::date IS NULL OR o.created_at < $3::date + 1)
          ORDER BY ${sortSql(q.sort, ORDER_SORT)}o.created_at DESC LIMIT $4 OFFSET $5`, [shift, from, to, page.pageSize, page.offset]);
      return { items: rows.map(({ _total, ...r }) => r), meta: pageMeta(page, rows[0]?._total ?? 0) };
    }, { readOnly: true });
  });

  app.get("/pos/orders/:id", { preHandler: requireTenant("orders.view", "pos.sell") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => {
      const o = (await db.query(
        `SELECT o.id, o.order_number AS "number", o.channel, o.status, o.subtotal::float8 AS subtotal, o.discount::float8 AS discount,
                o.vat::float8 AS vat, o.total::float8 AS total, o.customer_name AS "customerName", o.created_at AS "createdAt", o.location_id AS "locationId",
                o.guests, o.external_ref AS "externalRef", o.commission_amount::float8 AS "commission",
                t.name AS "tableName", c.name AS "customerFullName", c.phone AS "customerPhone", p.name AS "platformName"
           FROM pos_orders o LEFT JOIN dining_tables t ON t.id = o.table_id LEFT JOIN customers c ON c.id = o.customer_id
           LEFT JOIN delivery_platforms p ON p.id = o.platform_id WHERE o.id = $1`, [id])).rows[0];
      if (!o) throw notFound();
      const items = (await db.query(
        `SELECT oi.name_snapshot AS name, oi.quantity, oi.unit_price_net::float8 AS "unitPriceNet", oi.line_total::float8 AS "lineTotal", oi.note,
                coalesce((SELECT json_agg(m.name_snapshot ORDER BY m.name_snapshot) FROM pos_order_item_modifiers m WHERE m.order_item_id = oi.id), '[]') AS modifiers
           FROM pos_order_items oi WHERE oi.order_id = $1`, [id])).rows;
      const payments = (await db.query("SELECT method, amount::float8 AS amount FROM pos_payments WHERE order_id = $1", [id])).rows;
      const refunds = (await db.query("SELECT amount::float8 AS amount, method, reason, created_at AS \"createdAt\" FROM pos_refunds WHERE order_id = $1 ORDER BY created_at", [id])).rows;
      const invoices = (await db.query(`SELECT kind, icv, qr_base64 AS qr, issued_at AS "issuedAt" FROM e_invoices WHERE order_id = $1 ORDER BY icv`, [id])).rows;
      return { ...o, items, payments, refunds, invoices };
    }, { readOnly: true });
  });

  app.post("/pos/orders/:id/refund", { preHandler: requireTenant("orders.refund") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const key = idempotencyKey(req);
    const body = z.object({
      shiftId: z.string().uuid(),
      amount: z.number().positive().max(1_000_000),
      method: methods,
      reason: z.string().trim().min(3, "اكتب سبب الاسترجاع").max(300),
      restock: z.boolean().default(false),
    }).parse(req.body);

    const refund = await tenantTx(req, async (db) => {
      const dup = await db.query<{ id: string }>("SELECT id FROM pos_refunds WHERE idempotency_key = $1", [key]);
      if (dup.rows[0]) return { newId: dup.rows[0].id, zatcaDocument: null };

      const order = (await db.query<{ status: string; total: string; vat: string; location_id: string }>(
        "SELECT status, total::text, vat::text, location_id FROM pos_orders WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!order) throw notFound();
      if (order.status === "refunded") throw new AppError(409, "invalid_state", "تم استرجاع الطلب بالكامل");
      const shift = await loadOpenShift(db, body.shiftId, req.tenant!.userId, req.tenant!.permissions);
      if (shift.location_id !== order.location_id) throw badRequest("الشفت لا يخص موقع الطلب");

      const refundedSoFar = parseMoney((await db.query<{ s: string }>("SELECT coalesce(sum(amount), 0)::text AS s FROM pos_refunds WHERE order_id = $1", [id])).rows[0]?.s ?? "0");
      const orderTotal = parseMoney(order.total);
      const remaining = orderTotal - refundedSoFar;
      const amount = parseMoney(body.amount);
      if (amount > remaining) throw new AppError(409, "refund_exceeds_total", "مبلغ الاسترجاع أكبر من المتبقي على الطلب", { remaining: remaining / 100 });
      const isFinal = amount === remaining;
      if (body.restock && !isFinal) throw badRequest("إرجاع المخزون متاح عند الاسترجاع الكامل للمتبقي فقط");
      // VAT = round(net × rate) with the net that fits the refunded amount (ZATCA BR-CO-17); a halala left over is rounding.
      const rateBp = percentToBp(Number((await db.query<{ r: string }>("SELECT vat_rate_percent::text AS r FROM tenant_settings")).rows[0]?.r ?? 15));
      const vatPortion = parseMoney(order.vat) > 0 ? splitGross(amount, rateBp).vat : 0;

      const r = await db.query<{ id: string }>(
        `INSERT INTO pos_refunds (tenant_id, order_id, shift_id, amount, vat_amount, method, reason, restocked, idempotency_key, created_by)
         VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, app_user_id()) RETURNING id`,
        [id, body.shiftId, formatMoney(amount), formatMoney(vatPortion), body.method, body.reason, body.restock, key]);
      const newId = (r.rows[0] as { id: string }).id;

      if (body.restock) {
        const back = (await db.query<{ ingredient_id: string; qty: number; cost: number }>(
          `SELECT ingredient_id, (-sum(quantity))::float8 AS qty, (sum(-quantity * unit_cost) / nullif(sum(-quantity), 0))::float8 AS cost
             FROM stock_movements WHERE ref_type = 'pos_order' AND ref_id = $1 AND movement_type = 'sale'
            GROUP BY ingredient_id ORDER BY ingredient_id`, [id])).rows;
        for (const b of back) {
          await db.query("INSERT INTO stock_levels (tenant_id, location_id, ingredient_id, quantity, avg_cost) VALUES (app_tenant_id(), $1, $2, 0, 0) ON CONFLICT DO NOTHING", [order.location_id, b.ingredient_id]);
          const cur = (await db.query<{ q: number; c: number }>(
            "SELECT quantity::float8 AS q, avg_cost::float8 AS c FROM stock_levels WHERE location_id = $1 AND ingredient_id = $2 FOR UPDATE", [order.location_id, b.ingredient_id])).rows[0] as { q: number; c: number };
          await db.query("UPDATE stock_levels SET quantity = $3, avg_cost = $4, updated_at = now() WHERE location_id = $1 AND ingredient_id = $2",
            [order.location_id, b.ingredient_id, round4(cur.q + b.qty), weightedAverage(cur.q, cur.c, b.qty, b.cost)]);
          await db.query(
            `INSERT INTO stock_movements (tenant_id, location_id, ingredient_id, movement_type, quantity, unit_cost, ref_type, ref_id, created_by)
             VALUES (app_tenant_id(), $1, $2, 'refund_return', $3, $4, 'pos_refund', $5, app_user_id())`,
            [order.location_id, b.ingredient_id, b.qty, b.cost, newId]);
        }
      }
      const stamped = await stampPosRefund(db, newId);
      await issueInvoice(db, { locationId: order.location_id, orderId: id, refundId: newId, kind: "credit_note", total: amount, vat: vatPortion, qr: stamped?.qr });
      await postPosRefund(db, newId);
      await db.query("UPDATE pos_orders SET status = $2 WHERE id = $1", [id, isFinal ? "refunded" : "partially_refunded"]);
      await auditTenant(db, req, "order.refunded", "pos_order", id, { amount: formatMoney(amount), restock: body.restock });
      return { newId, zatcaDocument: stamped?.documentId ?? null };
    });
    if (refund.zatcaDocument) submitSoon({ tenantId: req.tenant!.id, userId: req.tenant!.userId }, refund.zatcaDocument, (err) => req.log.warn({ err }, "zatca reporting deferred"));
    return reply.status(201).send({ id: refund.newId });
  });
}
