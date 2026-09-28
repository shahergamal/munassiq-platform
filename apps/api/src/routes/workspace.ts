import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { systemPool, withSystemTx, type Db } from "../db/pool.ts";
import { AppError, conflict, forbidden, notFound } from "../lib/errors.ts";
import { catalogFor, IMPLIES, isPermission, LEGACY_PERMISSIONS, normalizePermissions, PERMISSIONS, permissionsOf, ROLES, sectorPermissions, type Permission, type Role } from "../lib/rbac.ts";
import { auditSystem, auditTenant, isUuid, requireTenant, tenantTx } from "../plugins/auth.ts";

// Sector-independent tenant endpoints: context, settings, members.
export default async function workspaceRoutes(app: FastifyInstance) {
  app.get("/context", { preHandler: requireTenant() }, async (req) => {
    const tenant = req.tenant!;
    // A support session is shown to the admin with its expiry and a way to end it early.
    const support = tenant.role === "support"
      ? (await systemPool.query<{ id: string; expires_at: Date }>(
          "SELECT id, expires_at FROM support_sessions WHERE admin_user_id = $1 AND tenant_id = $2 AND ended_at IS NULL AND expires_at > now() ORDER BY started_at DESC LIMIT 1",
          [tenant.userId, tenant.id])).rows[0] ?? null
      : null;
    return tenantTx(req, async (db) => {
      const t = (await db.query(
        `SELECT t.id, t.company_name, t.sector, t.tax_id, t.tax_id_verified, t.status, t.city,
                s.status AS sub_status, s.ends_at::text AS ends_at, p.name_ar AS plan_name,
                tenant_is_operational(t.id) AS operational,
                tenant_limit(t.id, 'branches') AS branches_limit, tenant_limit(t.id, 'users') AS users_limit,
                (SELECT count(*)::int FROM branches b WHERE b.is_active) AS branches_used,
                (SELECT count(*)::int FROM memberships m WHERE m.is_active) AS users_used,
                st.vat_rate_percent::float8 AS vat, st.discount_approval_percent::float8 AS discount_approval, st.po_owner_approval_above::float8 AS po_limit,
                ss.limit_mb AS storage_limit_mb, ss.used_bytes::float8 AS storage_used_bytes
           FROM tenants t CROSS JOIN LATERAL tenant_storage_state(t.id) ss
           LEFT JOIN subscriptions s ON s.tenant_id = t.id AND s.status IN ('trial', 'active', 'suspended')
           LEFT JOIN plans p ON p.id = s.plan_id
           LEFT JOIN tenant_settings st ON st.tenant_id = t.id`,
      )).rows[0];
      if (!t) throw notFound();
      return {
        tenant: { id: t.id, companyName: t.company_name, sector: t.sector, taxId: t.tax_id, taxIdVerified: t.tax_id_verified, city: t.city, status: t.status },
        role: tenant.role,
        roleName: tenant.roleName,
        permissions: tenant.permissions,
        readOnlySupport: tenant.role === "support",
        supportSession: support ? { id: support.id, expiresAt: support.expires_at } : null,
        operational: Boolean(t.operational),
        subscription: { status: t.sub_status, endsAt: t.ends_at, planName: t.plan_name },
        limits: { branches: { used: t.branches_used, limit: t.branches_limit }, users: { used: t.users_used, limit: t.users_limit },
          storage: { usedMb: Math.round((t.storage_used_bytes / 1048576) * 10) / 10, limitMb: t.storage_limit_mb } },
        settings: { vatRatePercent: t.vat, discountApprovalPercent: t.discount_approval, poOwnerApprovalAbove: t.po_limit },
      };
    }, { readOnly: true });
  });

  app.patch("/settings", { preHandler: requireTenant("settings.edit") }, async (req) => {
    const body = z.object({
      vatRatePercent: z.number().min(0).max(100).optional(),
      discountApprovalPercent: z.number().min(0).max(100).optional(),
      // Purchase orders above this amount (VAT included) need the owner's approval; null removes the limit.
      poOwnerApprovalAbove: z.number().min(0).max(1_000_000_000).nullable().optional(),
    }).parse(req.body);
    await tenantTx(req, async (db) => {
      await db.query(
        `UPDATE tenant_settings SET vat_rate_percent = coalesce($1, vat_rate_percent),
                discount_approval_percent = coalesce($2, discount_approval_percent),
                po_owner_approval_above = CASE WHEN $3 THEN $4::numeric ELSE po_owner_approval_above END WHERE tenant_id = app_tenant_id()`,
        [body.vatRatePercent ?? null, body.discountApprovalPercent ?? null, body.poOwnerApprovalAbove !== undefined, body.poOwnerApprovalAbove ?? null],
      );
      await auditTenant(db, req, "settings.updated", "tenant_settings", req.tenant!.id, body);
    });
    return { ok: true };
  });

  // Members are read from the system pool because the app role has no access to the users table.
  app.get("/members", { preHandler: requireTenant("members.view") }, async (req) => {
    const { rows } = await systemPool.query(
      `SELECT u.id AS "userId", u.full_name AS "fullName", u.email, m.role, m.custom_role_id AS "customRoleId", r.name AS "roleName",
              m.is_active AS "isActive", m.created_at AS "createdAt"
         FROM memberships m JOIN users u ON u.id = m.user_id LEFT JOIN tenant_roles r ON r.id = m.custom_role_id
        WHERE m.tenant_id = $1 ORDER BY m.created_at`,
      [req.tenant!.id],
    );
    return { items: rows };
  });

  const assignable = z.enum(["manager", "accountant", "inventory_clerk", "cashier", "custom"]);
  const roleChoice = { role: assignable, customRoleId: z.string().uuid().nullable().optional().transform((v) => v ?? null) };

  /** Permissions a role choice grants; a custom role must belong to this workspace. */
  async function grantOf(db: Db, tenantId: string, role: z.infer<typeof assignable> | "owner", customRoleId: string | null): Promise<readonly Permission[]> {
    if (role !== "custom") return permissionsOf(role);
    if (!customRoleId) throw new AppError(422, "validation_failed", "اختر الدور المخصص", [{ path: "customRoleId", message: "اختر الدور" }]);
    const r = await db.query<{ permissions: string[] }>("SELECT permissions FROM tenant_roles WHERE tenant_id = $1 AND id = $2", [tenantId, customRoleId]);
    if (!r.rows[0]) throw notFound("الدور غير موجود");
    return normalizePermissions(r.rows[0].permissions);
  }

  /** Only the owner grants freely; anyone else managing members can hand out only what they hold themselves. */
  function assertWithinActor(req: FastifyRequest, perms: readonly Permission[], message: string) {
    if (req.tenant!.role === "owner") return;
    if (sectorPermissions(perms, req.tenant!.sector).some((p) => !req.tenant!.permissions.includes(p))) throw forbidden(message);
  }

  app.post("/members", { preHandler: requireTenant("members.invite") }, async (req, reply) => {
    const body = z.object({ email: z.string().trim().toLowerCase().email(), ...roleChoice }).parse(req.body);
    const tenantId = req.tenant!.id;
    await withSystemTx(async (db) => {
      const op = await db.query<{ ok: boolean }>("SELECT tenant_is_operational($1) AS ok", [tenantId]);
      if (!op.rows[0]?.ok) throw new AppError(403, "tenant_not_operational", "المنشأة غير مفعّلة: الاشتراك منتهٍ أو الحساب موقوف");
      assertWithinActor(req, await grantOf(db, tenantId, body.role, body.customRoleId), "لا يمكنك منح دور فيه صلاحيات لا تملكها");
      const u = await db.query<{ id: string }>("SELECT id FROM users WHERE email = $1 AND email_verified_at IS NOT NULL AND status = 'active'", [body.email]);
      const userId = u.rows[0]?.id;
      // Same answer for "no such user" and "not verified": we do not confirm which e-mails have accounts.
      if (!userId) throw new AppError(422, "user_not_found", "لا يوجد حساب مفعّل بهذا البريد. اطلب من الموظف التسجيل وتفعيل بريده أولاً");
      const ins = await db.query(
        "INSERT INTO memberships (tenant_id, user_id, role, custom_role_id) VALUES ($1, $2, $3, $4) ON CONFLICT (tenant_id, user_id) DO NOTHING RETURNING id",
        [tenantId, userId, body.role, body.role === "custom" ? body.customRoleId : null],
      );
      if (!ins.rowCount) throw conflict("already_member", "هذا المستخدم عضو في المنشأة بالفعل");
      await auditSystem(db, req, tenantId, "member.added", "membership", userId, { role: body.role, customRoleId: body.customRoleId });
    });
    return reply.status(201).send({ ok: true });
  });

  app.patch("/members/:userId", { preHandler: requireTenant("members.edit") }, async (req) => {
    const { userId } = req.params as { userId: string };
    if (!isUuid(userId)) throw notFound();
    const body = z.object({ role: assignable.optional(), customRoleId: roleChoice.customRoleId, isActive: z.boolean().optional() })
      .refine((b) => b.role !== undefined || b.isActive !== undefined, "لا توجد تغييرات").parse(req.body);
    if (userId === req.tenant!.userId) throw new AppError(422, "validation_failed", "لا يمكنك تعديل عضويتك الخاصة");
    const tenantId = req.tenant!.id;
    await withSystemTx(async (db) => {
      const cur = await db.query<{ role: Role | "custom"; custom_role_id: string | null }>(
        "SELECT role, custom_role_id FROM memberships WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE", [tenantId, userId]);
      const m = cur.rows[0];
      if (!m) throw notFound("العضو غير موجود");
      if (m.role === "owner") throw new AppError(422, "validation_failed", "لا يمكن تعديل مالك المنشأة");
      assertWithinActor(req, await grantOf(db, tenantId, m.role, m.custom_role_id), "لا يمكنك تعديل عضو صلاحياته أوسع من صلاحياتك");
      if (body.role) assertWithinActor(req, await grantOf(db, tenantId, body.role, body.customRoleId), "لا يمكنك منح دور فيه صلاحيات لا تملكها");
      await db.query(
        `UPDATE memberships SET role = coalesce($3, role), custom_role_id = CASE WHEN $3::text IS NULL THEN custom_role_id WHEN $3 = 'custom' THEN $4::uuid END,
                is_active = coalesce($5, is_active) WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, userId, body.role ?? null, body.customRoleId, body.isActive ?? null],
      );
      // Deactivation takes effect immediately: membership is re-checked on every tenant request.
      await auditSystem(db, req, tenantId, "member.updated", "membership", userId, body);
    });
    return { ok: true };
  });

  // ── Roles ───────────────────────────────────────────────────────────────────────────────────
  // Built-in roles are fixed in code; the owner adds workspace roles and picks each permission.
  app.get("/roles", { preHandler: requireTenant("roles.view", "members.view") }, async (req) => {
    return tenantTx(req, async (db) => {
      const custom = (await db.query<{ id: string; name: string; description: string | null; permissions: string[]; membersCount: number }>(
        `SELECT r.id, r.name, r.description, r.permissions, (SELECT count(*)::int FROM memberships m WHERE m.custom_role_id = r.id) AS "membersCount"
           FROM tenant_roles r ORDER BY r.name`)).rows;
      // The catalog is the editor's tree (module → page → action) for this workspace's sector; `grantable` is what
      // this member may hand out.
      const sector = req.tenant!.sector;
      return {
        catalog: catalogFor(sector), permissions: sectorPermissions(PERMISSIONS, sector), implies: IMPLIES,
        builtin: ROLES.map((r) => ({ key: r, permissions: sectorPermissions(permissionsOf(r), sector) })),
        custom: custom.map((r) => ({ ...r, permissions: sectorPermissions(normalizePermissions(r.permissions), sector) })),
        canEdit: req.tenant!.permissions.includes("roles.manage"),
        grantable: req.tenant!.role === "owner" ? sectorPermissions(PERMISSIONS, sector) : req.tenant!.permissions,
      };
    }, { readOnly: true });
  });

  const roleBody = z.object({
    name: z.string().trim().min(2, "اسم الدور حرفان على الأقل").max(60),
    description: z.string().trim().max(300).nullable().optional().transform((v) => v || null),
    // New names (page.action); first-version names (module:level) are still accepted and expanded.
    permissions: z.array(z.string()).min(1, "اختر صلاحية واحدة على الأقل").max(PERMISSIONS.length * 2)
      .refine((ps) => ps.every((p) => isPermission(p) || LEGACY_PERMISSIONS.includes(p)), "صلاحية غير معروفة"),
  });

  /**
   * The owner shapes roles freely. Anyone else holding roles.manage can only give a role what they hold
   * themselves, and cannot touch a role that already reaches beyond them (it could be their own manager's).
   */
  function assertGrantable(req: FastifyRequest, perms: readonly Permission[], message = "لا يمكنك منح صلاحيات لا تملكها") {
    if (req.tenant!.role === "owner") return;
    const missing = sectorPermissions(perms, req.tenant!.sector).filter((p) => !req.tenant!.permissions.includes(p));
    if (missing.length) throw new AppError(403, "forbidden", message, { missing });
  }
  const dupName = (e: unknown) => (e as { code?: string; constraint?: string }).code === "23505" && (e as { constraint?: string }).constraint === "tenant_roles_name_uq";

  app.post("/roles", { preHandler: requireTenant("roles.manage") }, async (req, reply) => {
    const body = roleBody.parse(req.body);
    // A role holds only the pages this workspace's sector has.
    const permissions = sectorPermissions(normalizePermissions(body.permissions), req.tenant!.sector);
    if (!permissions.length) throw new AppError(422, "validation_failed", "اختر صلاحية واحدة على الأقل", [{ path: "permissions", message: "اختر صلاحية واحدة على الأقل" }]);
    assertGrantable(req, permissions);
    const id = await tenantTx(req, async (db) => {
      try {
        const r = (await db.query<{ id: string }>(
          "INSERT INTO tenant_roles (tenant_id, name, description, permissions, created_by) VALUES (app_tenant_id(), $1, $2, $3, app_user_id()) RETURNING id",
          [body.name, body.description, permissions])).rows[0] as { id: string };
        await auditTenant(db, req, "role.created", "tenant_role", r.id, { name: body.name, permissions });
        return r.id;
      } catch (e) {
        if (dupName(e)) throw conflict("duplicate", "يوجد دور بنفس الاسم", [{ path: "name", message: "اسم مستخدم لدور آخر" }]);
        throw e;
      }
    });
    return reply.status(201).send({ id, permissions });
  });

  app.patch("/roles/:id", { preHandler: requireTenant("roles.manage") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    const body = roleBody.parse(req.body);
    // A role holds only the pages this workspace's sector has.
    const permissions = sectorPermissions(normalizePermissions(body.permissions), req.tenant!.sector);
    if (!permissions.length) throw new AppError(422, "validation_failed", "اختر صلاحية واحدة على الأقل", [{ path: "permissions", message: "اختر صلاحية واحدة على الأقل" }]);
    assertGrantable(req, permissions);
    await tenantTx(req, async (db) => {
      try {
        const before = (await db.query<{ permissions: string[] }>("SELECT permissions FROM tenant_roles WHERE id = $1 FOR UPDATE", [id])).rows[0];
        if (!before) throw notFound("الدور غير موجود");
        assertGrantable(req, normalizePermissions(before.permissions), "هذا الدور أوسع من صلاحياتك، فلا يمكنك تعديله");
        await db.query("UPDATE tenant_roles SET name = $2, description = $3, permissions = $4 WHERE id = $1", [id, body.name, body.description, permissions]);
        await auditTenant(db, req, "role.updated", "tenant_role", id, { name: body.name, before: normalizePermissions(before.permissions), after: permissions });
      } catch (e) {
        if (dupName(e)) throw conflict("duplicate", "يوجد دور بنفس الاسم", [{ path: "name", message: "اسم مستخدم لدور آخر" }]);
        throw e;
      }
    });
    return { ok: true, permissions };
  });

  app.delete("/roles/:id", { preHandler: requireTenant("roles.manage") }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound();
    await tenantTx(req, async (db) => {
      const cur = (await db.query<{ permissions: string[] }>("SELECT permissions FROM tenant_roles WHERE id = $1", [id])).rows[0];
      if (cur) assertGrantable(req, normalizePermissions(cur.permissions), "هذا الدور أوسع من صلاحياتك، فلا يمكنك حذفه");
      const used = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM memberships WHERE custom_role_id = $1", [id])).rows[0]?.n ?? 0;
      if (used > 0) throw conflict("role_in_use", `الدور مُسند إلى ${used} عضو. غيّر أدوارهم أولاً ثم احذفه`);
      const r = await db.query<{ name: string }>("DELETE FROM tenant_roles WHERE id = $1 RETURNING name", [id]);
      if (!r.rows[0]) throw notFound("الدور غير موجود");
      await auditTenant(db, req, "role.deleted", "tenant_role", id, { name: r.rows[0].name });
    });
    return { ok: true };
  });
}
