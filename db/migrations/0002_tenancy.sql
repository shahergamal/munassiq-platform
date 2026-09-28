-- 0002_tenancy: sectors, plans, tenants, subscriptions, memberships, limits, and the isolation helpers.

CREATE TABLE sectors (
  key          text PRIMARY KEY,
  name_ar      text NOT NULL,
  is_available boolean NOT NULL DEFAULT false   -- only sectors with a real implementation may be sold/registered
);
INSERT INTO sectors (key, name_ar, is_available) VALUES
  ('restaurants', 'المطاعم', true),
  ('manufacturing', 'التصنيع', false),
  ('contracting', 'المقاولات', false);

CREATE TABLE plans (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sector         text NOT NULL REFERENCES sectors(key),
  code           text NOT NULL UNIQUE,
  name_ar        text NOT NULL,
  monthly_price  numeric(12,2) NOT NULL DEFAULT 0 CHECK (monthly_price >= 0),
  branches_limit integer NOT NULL CHECK (branches_limit >= 1),
  users_limit    integer NOT NULL CHECK (users_limit >= 1),
  is_active      boolean NOT NULL DEFAULT true
);
INSERT INTO plans (sector, code, name_ar, monthly_price, branches_limit, users_limit) VALUES
  ('restaurants', 'restaurants-trial',   'التجربة المجانية', 0,   1, 3),
  ('restaurants', 'restaurants-starter', 'الأساسية',       299, 2, 5),
  ('restaurants', 'restaurants-pro',     'الاحترافية',     799, 10, 25);

CREATE TABLE tenants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name    text NOT NULL CHECK (char_length(company_name) BETWEEN 2 AND 180),
  sector          text NOT NULL REFERENCES sectors(key),
  tax_id          text NOT NULL CHECK (tax_id ~ '^[0-9]{10,15}$'),
  tax_id_verified boolean NOT NULL DEFAULT false,  -- set by a platform admin; prevents tax-id squatting
  city            text,
  slug            text NOT NULL UNIQUE,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked', 'archived')),
  blocked_reason  text,
  owner_user_id   uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenants_block_reason CHECK (status <> 'blocked' OR char_length(trim(coalesce(blocked_reason, ''))) >= 3)
);
-- Only an admin-verified tax id is unique, so nobody can lock a competitor out by typing their number.
CREATE UNIQUE INDEX tenants_tax_id_verified_uq ON tenants (tax_id) WHERE tax_id_verified;
CREATE INDEX tenants_owner_idx ON tenants (owner_user_id);
CREATE TRIGGER tenants_updated BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id     uuid NOT NULL REFERENCES plans(id),
  status      text NOT NULL CHECK (status IN ('trial', 'active', 'expired', 'suspended')),
  starts_at   date NOT NULL,
  ends_at     date NOT NULL,
  total_value numeric(12,2) NOT NULL DEFAULT 0 CHECK (total_value >= 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE UNIQUE INDEX subscriptions_one_current_uq ON subscriptions (tenant_id) WHERE status IN ('trial', 'active', 'suspended');
CREATE TRIGGER subscriptions_updated BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE tenant_limit_overrides (
  tenant_id      uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  branches_limit integer CHECK (branches_limit >= 1),
  users_limit    integer CHECK (users_limit >= 1)
);

CREATE TABLE memberships (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner', 'manager', 'accountant', 'inventory_clerk', 'cashier')),
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id) WHERE is_active;
CREATE TRIGGER memberships_updated BEFORE UPDATE ON memberships FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE tenant_settings (
  tenant_id                 uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  vat_rate_percent          numeric(5,2) NOT NULL DEFAULT 15 CHECK (vat_rate_percent BETWEEN 0 AND 100),
  discount_approval_percent numeric(5,2) NOT NULL DEFAULT 10 CHECK (discount_approval_percent BETWEEN 0 AND 100),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER tenant_settings_updated BEFORE UPDATE ON tenant_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE tenant_counters (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key       text NOT NULL,
  value     bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE waitlist (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        citext NOT NULL,
  company_name text NOT NULL,
  sector       text NOT NULL REFERENCES sectors(key),
  phone        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (email, sector)
);

CREATE TABLE support_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid NOT NULL REFERENCES users(id),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  reason        text NOT NULL CHECK (char_length(trim(reason)) >= 5),
  started_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  ended_at      timestamptz
);
CREATE INDEX support_sessions_active_idx ON support_sessions (admin_user_id, tenant_id) WHERE ended_at IS NULL;

-- ── Isolation and commercial gate ────────────────────────────────────────────────────────────
-- A tenant is operational only when it is active AND has a running (trial/active) subscription that has not ended.
-- Writes are refused by RLS when it is not; reads stay allowed so a customer can still see their data.
CREATE FUNCTION tenant_is_operational(_t uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1 FROM tenants x JOIN subscriptions s ON s.tenant_id = x.id
    WHERE x.id = _t AND x.status = 'active' AND s.status IN ('trial', 'active') AND s.ends_at >= current_date
  ) $$;

CREATE FUNCTION tenant_limit(_t uuid, _kind text) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
  SELECT CASE _kind
           WHEN 'branches' THEN coalesce(o.branches_limit, p.branches_limit)
           WHEN 'users'    THEN coalesce(o.users_limit, p.users_limit)
         END
  FROM subscriptions s
  JOIN plans p ON p.id = s.plan_id
  LEFT JOIN tenant_limit_overrides o ON o.tenant_id = s.tenant_id
  WHERE s.tenant_id = _t AND s.status IN ('trial', 'active')
  ORDER BY s.created_at DESC LIMIT 1 $$;

-- Generates SELECT / INSERT / UPDATE / DELETE policies for a tenant-scoped table.
CREATE FUNCTION enable_tenant_rls(_tbl regclass, _writable boolean DEFAULT true) RETURNS void LANGUAGE plpgsql AS $$
DECLARE _n text := replace(_tbl::text, '.', '_');
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', _tbl);
  EXECUTE format('CREATE POLICY %I ON %s FOR SELECT USING (tenant_id = app_tenant_id())', _n || '_sel', _tbl);
  IF _writable THEN
    EXECUTE format('CREATE POLICY %I ON %s FOR INSERT WITH CHECK (tenant_id = app_tenant_id() AND tenant_is_operational(tenant_id))', _n || '_ins', _tbl);
    EXECUTE format('CREATE POLICY %I ON %s FOR UPDATE USING (tenant_id = app_tenant_id() AND tenant_is_operational(tenant_id)) WITH CHECK (tenant_id = app_tenant_id() AND tenant_is_operational(tenant_id))', _n || '_upd', _tbl);
    EXECUTE format('CREATE POLICY %I ON %s FOR DELETE USING (tenant_id = app_tenant_id() AND tenant_is_operational(tenant_id))', _n || '_del', _tbl);
  END IF;
END $$;

-- Per-tenant gap-free counters (SKUs, PO numbers, order numbers). Runs with the caller's RLS.
CREATE FUNCTION next_counter(_key text) RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO tenant_counters (tenant_id, key, value) VALUES (app_tenant_id(), _key, 1)
  ON CONFLICT (tenant_id, key) DO UPDATE SET value = tenant_counters.value + 1
  RETURNING value $$;

-- Plan limit: users
CREATE FUNCTION enforce_users_limit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE _lim integer; _cnt integer;
BEGIN
  IF NOT NEW.is_active THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text, 2));
  _lim := tenant_limit(NEW.tenant_id, 'users');
  IF _lim IS NULL THEN RAISE EXCEPTION 'no_active_subscription' USING ERRCODE = 'P0001'; END IF;
  SELECT count(*) INTO _cnt FROM memberships WHERE tenant_id = NEW.tenant_id AND is_active AND id IS DISTINCT FROM NEW.id;
  IF _cnt >= _lim THEN RAISE EXCEPTION 'plan_limit_reached:users' USING ERRCODE = 'P0001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER memberships_users_limit BEFORE INSERT OR UPDATE OF is_active ON memberships
  FOR EACH ROW EXECUTE FUNCTION enforce_users_limit();

-- Tenant traffic: read its own tenant/subscription/membership rows; edit settings; use counters.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenants_sel ON tenants FOR SELECT USING (id = app_tenant_id());
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY subscriptions_sel ON subscriptions FOR SELECT USING (tenant_id = app_tenant_id());
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY memberships_sel ON memberships FOR SELECT USING (tenant_id = app_tenant_id());
SELECT enable_tenant_rls('tenant_settings');
SELECT enable_tenant_rls('tenant_counters');
SELECT grant_app('tenants', 'SELECT');
SELECT grant_app('subscriptions', 'SELECT');
SELECT grant_app('memberships', 'SELECT');
SELECT grant_app('tenant_settings', 'SELECT, UPDATE');
SELECT grant_app('tenant_counters', 'SELECT, INSERT, UPDATE');
SELECT grant_app('plans', 'SELECT');
SELECT grant_app('sectors', 'SELECT');
