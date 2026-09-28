-- Workspace-defined roles: the owner names a role and picks its permissions one by one.
-- The permission list below must match PERMISSIONS in apps/api/src/lib/rbac.ts (a test checks it).
CREATE TABLE tenant_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 60),
  description text CHECK (description IS NULL OR char_length(description) <= 300),
  permissions text[] NOT NULL CHECK (
    cardinality(permissions) >= 1 AND permissions <@ ARRAY[
      'catalog:read','catalog:write','stock:read','stock:adjust','stock:post_count',
      'purchases:read','purchases:write','purchases:approve','purchases:receive','recipes:read','recipes:write',
      'pos:read','pos:operate','pos:refund','pos:discount_override','pos:kitchen','reports:read',
      'expenses:read','expenses:write','expenses:approve','payables:write','members:manage','settings:manage'
    ]::text[]),
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX tenant_roles_name_uq ON tenant_roles (tenant_id, lower(btrim(name)));
CREATE TRIGGER tenant_roles_updated BEFORE UPDATE ON tenant_roles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE memberships DROP CONSTRAINT memberships_role_check;
ALTER TABLE memberships
  ADD CONSTRAINT memberships_role_check CHECK (role IN ('owner', 'manager', 'accountant', 'inventory_clerk', 'cashier', 'custom')),
  ADD COLUMN custom_role_id uuid,
  ADD CONSTRAINT memberships_custom_role_fk FOREIGN KEY (tenant_id, custom_role_id) REFERENCES tenant_roles (tenant_id, id),
  ADD CONSTRAINT memberships_custom_role_ck CHECK ((role = 'custom') = (custom_role_id IS NOT NULL));
CREATE INDEX memberships_custom_role_idx ON memberships (custom_role_id) WHERE custom_role_id IS NOT NULL;

DO $$
BEGIN
  PERFORM enable_tenant_rls('tenant_roles'::regclass);
  PERFORM grant_app('tenant_roles');
END $$;
