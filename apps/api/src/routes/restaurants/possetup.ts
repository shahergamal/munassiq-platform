import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { round4 } from "../../lib/costing.ts";
import { AppError, badRequest, notFound } from "../../lib/errors.ts";
import { likePattern, pageMeta, parsePage, sortSql } from "../../lib/pagination.ts";
import { auditTenant, isUuid, requireTenant, tenantTx } from "../../plugins/auth.ts";
import type { Db } from "../../db/pool.ts";

const name80 = z.string().trim().min(1).max(80);
const phone = z.string().trim().regex(/^\+?[0-9]{9,15}$/, "رقم جوال غير صحيح: أرقام فقط، مثل 0501234567");
const CUSTOMER_SORT = ["name", "phone", "ordersCount", "totalSpent", "lastOrderAt"];
const CUSTOMER_ORDER_SORT = ["number", "createdAt", "channel", "total", "status"];

export default async function posSetupRoutes(app: FastifyInstance) {
  // ── Dining areas & tables ───────────────────────────────────────────────────────────────────
  // Readable by the till (pos:operate) so the cashier can pick a table; edited with catalog:write.
  app.get("/dining-areas", { preHandler: requireTenant("dining.view", "pos.sell") }, async (req) => {
    const { locationId } = req.query as { locationId?: string };
    return tenantTx(req, async (db) => {
      const { rows } = await db.query(
        `SELECT a.id, a.name, a.location_id AS "locationId", l.name AS "locationName", a.sort_order AS "sortOrder", a.is_active AS "isActive",
                coalesce(json_agg(json_build_object('id', t.id, 'name', t.name, 'seats', t.seats, 'isActive', t.is_active,
                  'busy', EXISTS (SELECT 1 FROM pos_tickets pt WHERE pt.table_id = t.id AND pt.status = 'open')
                          OR EXISTS (SELECT 1 FROM kitchen_tickets k JOIN pos_orders o ON o.id = k.order_id WHERE o.table_id = t.id AND k.status <> 'served'),
                  'ticketId', (SELECT pt.id FROM pos_tickets pt WHERE pt.table_id = t.id AND pt.status = 'open'))
                  ORDER BY t.name) FILTER (WHERE t.id IS NOT NULL), '[]') AS tables
           FROM dining_areas a JOIN locations l ON l.id = a.location_id LEFT JOIN dining_tables t ON t.area_id = a.id
          WHERE ($1::uuid IS NULL OR a.location_id = $1)
          GROUP BY a.id, a.name, a.location_id, l.name, a.sort_order, a.is_active ORDER BY l.name, a.sort_order, a.name`,
        [isUuid(locationId) ? locationId : null]);
      return { items: rows };
    }, { readOnly: true });
  });

  app.post("/dining-areas", { preHandler: requireTenant("dining.create") }, async (req, reply) => {
    const body = z.object({ locationId: z.string().uuid(), name: name80, sortOrder: z.number().int().min(0).max(999).default(0) }).parse(req.body);
    const id = await tenantTx(req, async (db) => {
      const r = (await db.query<{ id: string }>("INSERT INTO dining_areas (tenant_id, location_id, name, sort_order) VALUES (app_tenant_id(), $1, $2, $3) RETURNING id", [body.locationId, body.name, body.sortOrder])).rows[0] as { id: string };
      await auditTenant(db, req, "dining_area.created", "dining_area", r.id);
      return r.id;
    });
    return reply.status(201).send({ id });
  });

  app.patch("/dining-areas/:id", { preHandler: requireTenant("dining.edit") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ name: name80.optional(), sortOrder: z.number().int().min(0).max(999).optional(), isActive: z.boolean().optional() }).parse(req.body);
    await tenantTx(req, async (db) => {
      const r = await db.query("UPDATE dining_areas SET name = coalesce($2, name), sort_order = coalesce($3, sort_order), is_active = coalesce($4, is_active) WHERE id = $1",
        [id, b.name ?? null, b.sortOrder ?? null, b.isActive ?? null]);
      if (!r.rowCount) throw notFound();
    });
    return { ok: true };
  });

  app.post("/dining-tables", { preHandler: requireTenant("dining.create") }, async (req, reply) => {
    const body = z.object({ areaId: z.string().uuid(), name: z.string().trim().min(1).max(40), seats: z.number().int().min(1).max(50).default(4) }).parse(req.body);
    const id = await tenantTx(req, async (db) => {
      const r = (await db.query<{ id: string }>("INSERT INTO dining_tables (tenant_id, area_id, name, seats) VALUES (app_tenant_id(), $1, $2, $3) RETURNING id", [body.areaId, body.name, body.seats])).rows[0] as { id: string };
      return r.id;
    });
    return reply.status(201).send({ id });
  });

  app.patch("/dining-tables/:id", { preHandler: requireTenant("dining.edit") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = z.object({ name: z.string().trim().min(1).max(40).optional(), seats: z.number().int().min(1).max(50).optional(), isActive: z.boolean().optional() }).parse(req.body);
    await tenantTx(req, async (db) => {
      const r = await db.query("UPDATE dining_tables SET name = coalesce($2, name), seats = coalesce($3, seats), is_active = coalesce($4, is_active) WHERE id = $1",
        [id, b.name ?? null, b.seats ?? null, b.isActive ?? null]);
      if (!r.rowCount) throw notFound();
    });
    return { ok: true };
  });

  // ── Modifier groups & options ───────────────────────────────────────────────────────────────
  app.get("/modifier-groups", { preHandler: requireTenant("modifiers.view", "recipes.create", "recipes.edit") }, async (req) =>
    tenantTx(req, async (db) => ({
      items: (await db.query(
        `SELECT g.id, g.name, g.min_select AS "minSelect", g.max_select AS "maxSelect", g.is_active AS "isActive",
                (SELECT count(*)::int FROM recipe_modifier_groups r WHERE r.group_id = g.id) AS "recipesCount",
                coalesce(json_agg(json_build_object('id', o.id, 'name', o.name, 'priceNet', o.price_net::float8, 'ingredientId', o.ingredient_id,
                  'ingredientName', i.name, 'unit', u.name, 'ingredientQty', o.ingredient_qty::float8, 'isActive', o.is_active, 'sortOrder', o.sort_order)
                  ORDER BY o.sort_order, o.name) FILTER (WHERE o.id IS NOT NULL), '[]') AS options
           FROM modifier_groups g LEFT JOIN modifier_options o ON o.group_id = g.id
           LEFT JOIN ingredients i ON i.id = o.ingredient_id LEFT JOIN units u ON u.id = i.base_unit_id
          GROUP BY g.id ORDER BY g.is_active DESC, g.name`)).rows,
    }), { readOnly: true }));

  const optionSchema = z.object({
    id: z.string().uuid().optional(),
    name: name80,
    priceNet: z.number().min(0).max(100_000),
    ingredientId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
    ingredientQty: z.number().positive().max(1_000_000).nullable().optional().transform((v) => v ?? null),
    isActive: z.boolean().default(true),
  }).refine((o) => (o.ingredientId === null) === (o.ingredientQty === null), { message: "حدد المادة وكميتها معاً، أو اتركهما فارغين", path: ["ingredientQty"] });
  const groupSchema = z.object({
    name: z.string().trim().min(2, "أدخل اسم المجموعة").max(80),
    minSelect: z.number().int().min(0).max(20),
    maxSelect: z.number().int().min(1).max(20),
    isActive: z.boolean().default(true),
    options: z.array(optionSchema).min(1, "أضف خياراً واحداً على الأقل").max(40),
  }).refine((g) => g.minSelect <= g.maxSelect, { message: "الحد الأدنى أكبر من الأقصى", path: ["minSelect"] })
    .refine((g) => g.maxSelect <= g.options.filter((o) => o.isActive).length, { message: "الحد الأقصى أكبر من عدد الخيارات النشطة", path: ["maxSelect"] })
    .refine((g) => new Set(g.options.map((o) => o.name)).size === g.options.length, { message: "أسماء الخيارات مكررة", path: ["options"] });

  /** Options are upserted by id: existing ones are updated (never deleted, since past orders reference them), new ones added. */
  async function saveOptions(db: import("../../db/pool.ts").Db, groupId: string, options: z.infer<typeof optionSchema>[]) {
    const keep: string[] = [];
    for (const [i, o] of options.entries()) {
      if (o.id) {
        const r = await db.query("UPDATE modifier_options SET name = $3, price_net = $4, ingredient_id = $5, ingredient_qty = $6, is_active = $7, sort_order = $8 WHERE id = $1 AND group_id = $2",
          [o.id, groupId, o.name, o.priceNet, o.ingredientId, o.ingredientQty === null ? null : round4(o.ingredientQty), o.isActive, i]);
        if (!r.rowCount) throw badRequest("خيار غير موجود في هذه المجموعة");
        keep.push(o.id);
      } else {
        const r = (await db.query<{ id: string }>(
          "INSERT INTO modifier_options (tenant_id, group_id, name, price_net, ingredient_id, ingredient_qty, is_active, sort_order) VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7) RETURNING id",
          [groupId, o.name, o.priceNet, o.ingredientId, o.ingredientQty === null ? null : round4(o.ingredientQty), o.isActive, i])).rows[0] as { id: string };
        keep.push(r.id);
      }
    }
    // Options removed from the list are deactivated, not deleted.
    await db.query("UPDATE modifier_options SET is_active = false WHERE group_id = $1 AND NOT (id = ANY($2::uuid[]))", [groupId, keep]);
  }

  app.post("/modifier-groups", { preHandler: requireTenant("modifiers.create") }, async (req, reply) => {
    const b = groupSchema.parse(req.body);
    const id = await tenantTx(req, async (db) => {
      const g = (await db.query<{ id: string }>("INSERT INTO modifier_groups (tenant_id, name, min_select, max_select, is_active) VALUES (app_tenant_id(), $1, $2, $3, $4) RETURNING id",
        [b.name, b.minSelect, b.maxSelect, b.isActive])).rows[0] as { id: string };
      await saveOptions(db, g.id, b.options);
      await auditTenant(db, req, "modifier_group.created", "modifier_group", g.id);
      return g.id;
    });
    return reply.status(201).send({ id });
  });

  app.put("/modifier-groups/:id", { preHandler: requireTenant("modifiers.edit") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = groupSchema.parse(req.body);
    await tenantTx(req, async (db) => {
      const r = await db.query("UPDATE modifier_groups SET name = $2, min_select = $3, max_select = $4, is_active = $5 WHERE id = $1", [id, b.name, b.minSelect, b.maxSelect, b.isActive]);
      if (!r.rowCount) throw notFound();
      await saveOptions(db, id, b.options);
      await auditTenant(db, req, "modifier_group.updated", "modifier_group", id);
    });
    return { ok: true };
  });

  app.get("/recipes/:id/modifier-groups", { preHandler: requireTenant("recipes.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    return tenantTx(req, async (db) => ({
      groupIds: (await db.query<{ group_id: string }>("SELECT group_id FROM recipe_modifier_groups WHERE recipe_id = $1 ORDER BY sort_order", [id])).rows.map((r) => r.group_id),
    }), { readOnly: true });
  });

  app.put("/recipes/:id/modifier-groups", { preHandler: requireTenant("recipes.edit") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const { groupIds } = z.object({ groupIds: z.array(z.string().uuid()).max(10) }).parse(req.body);
    await tenantTx(req, async (db) => {
      const r = await db.query("SELECT 1 FROM recipes WHERE id = $1", [id]);
      if (!r.rowCount) throw notFound();
      await db.query("DELETE FROM recipe_modifier_groups WHERE recipe_id = $1", [id]);
      for (const [i, g] of [...new Set(groupIds)].entries()) {
        await db.query("INSERT INTO recipe_modifier_groups (tenant_id, recipe_id, group_id, sort_order) VALUES (app_tenant_id(), $1, $2, $3)", [id, g, i]);
      }
      await auditTenant(db, req, "recipe.modifiers_updated", "recipe", id, { groupIds });
    });
    return { ok: true };
  });

  // ── Delivery platforms ──────────────────────────────────────────────────────────────────────
  app.get("/delivery-platforms", { preHandler: requireTenant("platforms.view", "pos.sell") }, async (req) =>
    tenantTx(req, async (db) => ({
      items: (await db.query(
        `SELECT p.id, p.name, p.commission_percent::float8 AS "commissionPercent", p.is_active AS "isActive",
                (SELECT count(*)::int FROM pos_orders o WHERE o.platform_id = p.id) AS "ordersCount"
           FROM delivery_platforms p ORDER BY p.is_active DESC, p.name`)).rows,
    }), { readOnly: true }));

  const platformSchema = z.object({ name: z.string().trim().min(2, "أدخل اسم التطبيق").max(80), commissionPercent: z.number().min(0).max(100), isActive: z.boolean().default(true) });
  app.post("/delivery-platforms", { preHandler: requireTenant("platforms.create") }, async (req, reply) => {
    const b = platformSchema.parse(req.body);
    const id = await tenantTx(req, async (db) => (await db.query<{ id: string }>(
      "INSERT INTO delivery_platforms (tenant_id, name, commission_percent, is_active) VALUES (app_tenant_id(), $1, $2, $3) RETURNING id", [b.name, b.commissionPercent, b.isActive])).rows[0]!.id);
    return reply.status(201).send({ id });
  });
  app.patch("/delivery-platforms/:id", { preHandler: requireTenant("platforms.edit") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = platformSchema.partial().parse(req.body);
    await tenantTx(req, async (db) => {
      const r = await db.query("UPDATE delivery_platforms SET name = coalesce($2, name), commission_percent = coalesce($3, commission_percent), is_active = coalesce($4, is_active) WHERE id = $1",
        [id, b.name ?? null, b.commissionPercent ?? null, b.isActive ?? null]);
      if (!r.rowCount) throw notFound();
      await auditTenant(db, req, "platform.updated", "delivery_platform", id, b);
    });
    return { ok: true };
  });

  // ── Customers ───────────────────────────────────────────────────────────────────────────────
  // The till can look up and add customers (pos:operate); editing is for catalog writers too.
  app.get("/customers", { preHandler: requireTenant("customers.view", "pos.sell") }, async (req) => {
    const q = req.query as { q?: string; page?: string; pageSize?: string; sort?: string };
    const page = parsePage(q);
    const search = q.q?.trim() ? likePattern(q.q) : null;
    return tenantTx(req, async (db) => {
      const { rows } = await db.query(
        `SELECT c.id, c.name, c.phone, c.email, c.address, c.notes, c.created_at AS "createdAt",
                c.customer_type AS "customerType", c.vat_number AS "vatNumber", c.other_id_scheme AS "otherIdScheme", c.other_id AS "otherId",
                c.street, c.building_no AS "buildingNo", c.additional_no AS "additionalNo", c.district, c.city, c.postal_code AS "postalCode",
                c.country_code AS "countryCode", c.payment_terms_days AS "paymentTermsDays", c.credit_limit::float8 AS "creditLimit", c.price_list_id AS "priceListId",
                (SELECT count(*)::int FROM pos_orders o WHERE o.customer_id = c.id) AS "ordersCount",
                (SELECT coalesce(sum(total), 0)::float8 FROM pos_orders o WHERE o.customer_id = c.id) AS "totalSpent",
                (SELECT max(created_at) FROM pos_orders o WHERE o.customer_id = c.id) AS "lastOrderAt",
                count(*) OVER()::int AS "_total"
           FROM customers c WHERE ($1::text IS NULL OR c.name ILIKE $1 OR c.phone ILIKE $1) ORDER BY ${sortSql(q.sort, CUSTOMER_SORT)}c.name LIMIT $2 OFFSET $3`,
        [search, page.pageSize, page.offset]);
      return { items: rows.map(({ _total, ...r }) => r), meta: pageMeta(page, rows[0]?._total ?? 0) };
    }, { readOnly: true });
  });

  const customerSchema = z.object({
    name: z.string().trim().min(2, "أدخل اسم العميل").max(120),
    phone,
    email: z.string().trim().email("بريد غير صحيح").max(255).nullable().optional().transform((v) => v || null),
    address: z.string().trim().max(300).nullable().optional().transform((v) => v || null),
    notes: z.string().trim().max(500).nullable().optional().transform((v) => v || null),
    // Business buyer (standard tax invoice): VAT number or another id, and the national address.
    customerType: z.enum(["individual", "business"]).optional(),
    vatNumber: z.string().trim().regex(/^3[0-9]{13}3$/, "الرقم الضريبي 15 رقماً يبدأ وينتهي بـ 3").nullable().optional().transform((v) => v || null),
    otherIdScheme: z.enum(["CRN", "MOM", "MLS", "700", "SAG", "NAT", "GCC", "IQA", "PAS", "OTH", "TIN"]).nullable().optional().transform((v) => v ?? null),
    otherId: z.string().trim().min(2).max(40).nullable().optional().transform((v) => v || null),
    street: z.string().trim().max(120).nullable().optional().transform((v) => v || null),
    buildingNo: z.string().trim().regex(/^[0-9]{4}$/, "رقم المبنى 4 أرقام").nullable().optional().transform((v) => v || null),
    additionalNo: z.string().trim().regex(/^[0-9]{4}$/, "الرقم الإضافي 4 أرقام").nullable().optional().transform((v) => v || null),
    district: z.string().trim().max(120).nullable().optional().transform((v) => v || null),
    city: z.string().trim().max(80).nullable().optional().transform((v) => v || null),
    postalCode: z.string().trim().regex(/^[0-9]{5}$/, "الرمز البريدي 5 أرقام").nullable().optional().transform((v) => v || null),
    countryCode: z.string().trim().regex(/^[A-Z]{2}$/, "رمز الدولة حرفان").optional(),
    paymentTermsDays: z.number().int().min(0).max(365).optional(),
    /** Confirming a sales order may not take what the customer owes plus open orders above this. Null: no limit. */
    creditLimit: z.number().min(0).max(1_000_000_000).nullable().optional(),
    /** The customer's own prices on quotations (sales/priceLists.ts). */
    priceListId: z.string().uuid().nullable().optional(),
  });
  const B2B: [keyof z.infer<typeof customerSchema>, string][] = [
    ["customerType", "customer_type"], ["vatNumber", "vat_number"], ["otherIdScheme", "other_id_scheme"], ["otherId", "other_id"], ["street", "street"],
    ["buildingNo", "building_no"], ["additionalNo", "additional_no"], ["district", "district"], ["city", "city"], ["postalCode", "postal_code"],
    ["countryCode", "country_code"], ["paymentTermsDays", "payment_terms_days"], ["creditLimit", "credit_limit"], ["priceListId", "price_list_id"],
  ];
  /** Sets the business fields that were sent (a field sent as null is cleared). */
  const setB2B = async (db: Db, id: string, b: Partial<z.infer<typeof customerSchema>>) => {
    const sent = B2B.filter(([k]) => b[k] !== undefined);
    if (!sent.length) return;
    await db.query(`UPDATE customers SET ${sent.map(([, col], i) => `${col} = $${i + 2}`).join(", ")} WHERE id = $1`, [id, ...sent.map(([k]) => b[k])]);
  };
  app.post("/customers", { preHandler: requireTenant("customers.create", "pos.sell") }, async (req, reply) => {
    const b = customerSchema.parse(req.body);
    const id = await tenantTx(req, async (db) => {
      try {
        const id = (await db.query<{ id: string }>("INSERT INTO customers (tenant_id, name, phone, email, address, notes) VALUES (app_tenant_id(), $1, $2, $3, $4, $5) RETURNING id",
          [b.name, b.phone, b.email, b.address, b.notes])).rows[0]!.id;
        await setB2B(db, id, b);
        return id;
      } catch (err) {
        if ((err as { code?: string }).code === "23505") throw new AppError(409, "customer_exists", "يوجد عميل مسجل بهذا الجوال");
        throw err;
      }
    });
    return reply.status(201).send({ id });
  });
  app.patch("/customers/:id", { preHandler: requireTenant("customers.edit") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const b = customerSchema.partial().parse(req.body);
    await tenantTx(req, async (db) => {
      const r = await db.query("UPDATE customers SET name = coalesce($2, name), phone = coalesce($3, phone), email = coalesce($4, email), address = coalesce($5, address), notes = coalesce($6, notes) WHERE id = $1",
        [id, b.name ?? null, b.phone ?? null, b.email ?? null, b.address ?? null, b.notes ?? null]);
      if (!r.rowCount) throw notFound();
      await setB2B(db, id, b);
    });
    return { ok: true };
  });

  app.get("/customers/:id/orders", { preHandler: requireTenant("customers.view") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const q = req.query as { page?: string; pageSize?: string; sort?: string };
    const page = parsePage(q);
    return tenantTx(req, async (db) => {
      const { rows } = await db.query(
        `SELECT o.id, o.order_number AS "number", o.channel, o.status, o.total::float8 AS total, o.created_at AS "createdAt", count(*) OVER()::int AS "_total"
           FROM pos_orders o WHERE o.customer_id = $1 ORDER BY ${sortSql(q.sort, CUSTOMER_ORDER_SORT)}o.created_at DESC LIMIT $2 OFFSET $3`, [id, page.pageSize, page.offset]);
      return { items: rows.map(({ _total, ...r }) => r), meta: pageMeta(page, rows[0]?._total ?? 0) };
    }, { readOnly: true });
  });

  // ── Kitchen display ─────────────────────────────────────────────────────────────────────────
  app.get("/kds", { preHandler: requireTenant("kitchen.use") }, async (req) => {
    const { locationId } = req.query as { locationId?: string };
    if (!isUuid(locationId)) throw badRequest("اختر الموقع");
    return tenantTx(req, async (db) => {
      const { rows } = await db.query(
        `SELECT k.id, k.status, k.created_at AS "createdAt", k.started_at AS "startedAt", k.ready_at AS "readyAt", k.round,
                o.order_number AS "orderNumber", pt.ticket_number::int AS "ticketNumber", pt.label AS "ticketLabel",
                coalesce(o.channel, pt.channel) AS channel, coalesce(o.notes, pt.notes) AS notes, coalesce(o.customer_name, c.name) AS "customerName",
                t.name AS "tableName", p.name AS "platformName", coalesce(o.external_ref, pt.external_ref) AS "externalRef",
                coalesce(k.items, (SELECT jsonb_agg(jsonb_build_object('name', oi.name_snapshot, 'quantity', oi.quantity, 'note', oi.note,
                   'modifiers', coalesce((SELECT jsonb_agg(m.name_snapshot) FROM pos_order_item_modifiers m WHERE m.order_item_id = oi.id), '[]'::jsonb))) FROM pos_order_items oi WHERE oi.order_id = o.id)) AS items
           FROM kitchen_tickets k LEFT JOIN pos_orders o ON o.id = k.order_id LEFT JOIN pos_tickets pt ON pt.id = k.pos_ticket_id
           LEFT JOIN customers c ON c.id = pt.customer_id
           LEFT JOIN dining_tables t ON t.id = coalesce(o.table_id, pt.table_id) LEFT JOIN delivery_platforms p ON p.id = coalesce(o.platform_id, pt.platform_id)
          WHERE k.location_id = $1 AND (k.status <> 'served' OR k.served_at > now() - interval '15 minutes')
          ORDER BY k.created_at LIMIT 200`, [locationId]);
      return { items: rows, serverTime: new Date().toISOString() };
    }, { readOnly: true });
  });

  const NEXT: Record<string, string> = { new: "preparing", preparing: "ready", ready: "served" };
  /** Forward-only: new → preparing → ready → served. "recall" moves a served ticket back to ready within 15 minutes. */
  app.post("/kds/:id/status", { preHandler: requireTenant("kitchen.use") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const { status } = z.object({ status: z.enum(["preparing", "ready", "served", "recall"]) }).parse(req.body);
    await tenantTx(req, async (db) => {
      const k = (await db.query<{ status: string; recent: boolean; void_only: boolean }>(
        `SELECT status, (served_at > now() - interval '15 minutes') AS recent,
                coalesce(items IS NOT NULL AND jsonb_array_length(items) > 0 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(items) e WHERE (e->>'quantity')::numeric > 0), false) AS void_only
           FROM kitchen_tickets WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!k) throw notFound();
      // A cancellation notice has nothing to cook: the kitchen acknowledges it in one step.
      if (k.void_only && status === "served" && k.status !== "served") {
        await db.query("UPDATE kitchen_tickets SET status = 'served', served_at = now() WHERE id = $1", [id]);
        return;
      }
      if (status === "recall") {
        if (k.status !== "served" || !k.recent) throw new AppError(409, "invalid_state", "يمكن استرجاع التذكرة خلال 15 دقيقة من تسليمها فقط");
        await db.query("UPDATE kitchen_tickets SET status = 'ready', served_at = NULL WHERE id = $1", [id]);
        return;
      }
      if (NEXT[k.status] !== status) throw new AppError(409, "invalid_state", "حالة التذكرة تغيّرت. حدّث الشاشة");
      const col = { preparing: "started_at", ready: "ready_at", served: "served_at" }[status];
      await db.query(`UPDATE kitchen_tickets SET status = $2, ${col} = now() WHERE id = $1`, [id, status]);
    });
    return { ok: true };
  });

  // ── Sales by channel / platform ─────────────────────────────────────────────────────────────
  app.get("/reports/sales-by-channel", { preHandler: requireTenant("rep_sales_channel.view") }, async (req) => {
    const q = req.query as { from?: string; to?: string };
    const DATE = /^\d{4}-\d{2}-\d{2}$/;
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh" }).format(new Date());
    const to = DATE.test(q.to ?? "") ? (q.to as string) : today;
    const from = DATE.test(q.from ?? "") ? (q.from as string) : new Date(Date.parse(to) - 29 * 86_400_000).toISOString().slice(0, 10);
    if (from > to) throw badRequest("تاريخ البداية بعد تاريخ النهاية");
    return tenantTx(req, async (db) => {
      const { rows } = await db.query(
        `SELECT o.channel, p.name AS "platformName", count(*)::int AS orders, sum(o.taxable)::float8 AS "netSales", sum(o.total)::float8 AS total,
                sum(o.commission_amount)::float8 AS commission, (sum(o.taxable) - sum(o.commission_amount) - sum(o.cost_total))::float8 AS "netAfterCommission"
           FROM pos_orders o LEFT JOIN delivery_platforms p ON p.id = o.platform_id
          WHERE (o.created_at AT TIME ZONE 'Asia/Riyadh')::date BETWEEN $1::date AND $2::date
          GROUP BY o.channel, p.name ORDER BY total DESC`, [from, to]);
      return { from, to, items: rows };
    }, { readOnly: true });
  });
}
