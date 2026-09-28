-- Platform billing, storage quota, and operations.
--
--   * Each plan has a storage limit; a workspace can buy extra storage packages. Its usage is measured from its own
--     rows in the database (and stored files) and cached in tenant_storage.
--   * A workspace pays the PLATFORM (the platform's own Moyasar account) for a plan or a storage package; once
--     Moyasar confirms the payment, the server applies it: subscription activated/extended, or storage raised.
--   * security_events feeds the admin's "suspicious IPs" list (failed logins, rate limiting, rejected origins).

-- ── Storage ─────────────────────────────────────────────────────────────────────
ALTER TABLE plans ADD COLUMN storage_limit_mb integer NOT NULL DEFAULT 1024 CHECK (storage_limit_mb BETWEEN 10 AND 10000000);
UPDATE plans SET storage_limit_mb = CASE WHEN code LIKE '%-trial' THEN 200 WHEN code LIKE '%-starter' THEN 1024 WHEN code LIKE '%-pro' THEN 5120 ELSE storage_limit_mb END;

CREATE TABLE tenant_storage (
  tenant_id   uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  -- Purchased (or granted by the admin) on top of the plan's limit.
  extra_mb    integer NOT NULL DEFAULT 0 CHECK (extra_mb BETWEEN 0 AND 100000000),
  used_bytes  bigint NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  measured_at timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER tenant_storage_updated BEFORE UPDATE ON tenant_storage FOR EACH ROW EXECUTE FUNCTION set_updated_at();
INSERT INTO tenant_storage (tenant_id) SELECT id FROM tenants ON CONFLICT DO NOTHING;
REVOKE ALL ON tenant_storage FROM munassiq_app;

-- What a workspace stores: every row of every tenant-scoped table (its data), measured as PostgreSQL stores it.
CREATE FUNCTION tenant_storage_bytes(_t uuid) RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE r record; _sum bigint := 0; _n bigint;
BEGIN
  FOR r IN SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
            WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'tenant_storage' LOOP
    EXECUTE format('SELECT coalesce(sum(pg_column_size(x.*)), 0) FROM %I x WHERE x.tenant_id = $1', r.table_name) INTO _n USING _t;
    _sum := _sum + _n;
  END LOOP;
  RETURN _sum;
END $$;
REVOKE ALL ON FUNCTION tenant_storage_bytes(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_storage_bytes(uuid) TO munassiq_system;

-- The workspace's own limit and last measured usage (plan limit + purchased extra), readable from tenant traffic.
CREATE FUNCTION tenant_storage_state(_t uuid, OUT limit_mb integer, OUT used_bytes bigint, OUT measured_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
  SELECT (SELECT p.storage_limit_mb FROM subscriptions s JOIN plans p ON p.id = s.plan_id
           WHERE s.tenant_id = _t AND s.status IN ('trial', 'active', 'suspended') ORDER BY s.created_at DESC LIMIT 1) + coalesce(ts.extra_mb, 0),
         coalesce(ts.used_bytes, 0), ts.measured_at
    FROM (SELECT _t AS tenant_id) x LEFT JOIN tenant_storage ts ON ts.tenant_id = x.tenant_id $$;
REVOKE ALL ON FUNCTION tenant_storage_state(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_storage_state(uuid) TO munassiq_app, munassiq_system;

-- Over the limit: stored files (assistant exports) are refused; daily operations (sales, stock) never are.
CREATE FUNCTION enforce_storage_limit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE s record;
BEGIN
  SELECT * INTO s FROM tenant_storage_state(NEW.tenant_id);
  IF s.limit_mb IS NOT NULL AND s.used_bytes >= s.limit_mb::bigint * 1048576 THEN
    RAISE EXCEPTION 'plan_limit_reached:storage' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assistant_exports_storage_limit BEFORE INSERT ON assistant_exports FOR EACH ROW EXECUTE FUNCTION enforce_storage_limit();

-- Storage packages the admin sells.
CREATE TABLE storage_addons (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name_ar    text NOT NULL CHECK (char_length(trim(name_ar)) BETWEEN 2 AND 80),
  size_mb    integer NOT NULL CHECK (size_mb BETWEEN 10 AND 10000000),
  price      numeric(12,2) NOT NULL CHECK (price > 0),
  is_active  boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO storage_addons (name_ar, size_mb, price, sort_order) VALUES
  ('مساحة إضافية 1 جيجابايت', 1024, 29, 1), ('مساحة إضافية 5 جيجابايت', 5120, 99, 2);
GRANT SELECT ON storage_addons TO munassiq_app;

-- ── Payments to the platform ──────────────────────────────────────────────────────
CREATE TABLE platform_payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('subscription', 'storage')),
  plan_id         uuid REFERENCES plans(id),
  period          text CHECK (period IN ('monthly', 'annual')),
  addon_id        uuid REFERENCES storage_addons(id),
  size_mb         integer CHECK (size_mb > 0),
  description     text NOT NULL,
  amount          numeric(12,2) NOT NULL CHECK (amount > 0),
  provider        text NOT NULL DEFAULT 'moyasar' CHECK (provider IN ('moyasar')),
  mode            text NOT NULL CHECK (mode IN ('test', 'live')),
  provider_ref    text NOT NULL UNIQUE CHECK (char_length(provider_ref) BETWEEN 3 AND 100),
  url             text NOT NULL CHECK (url ~ '^https://'),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'expired', 'canceled')),
  provider_status text,
  payment_ref     text,
  failure         text,
  paid_at         timestamptz,
  idempotency_key uuid NOT NULL,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  CHECK ((kind = 'subscription' AND plan_id IS NOT NULL AND period IS NOT NULL) OR (kind = 'storage' AND size_mb IS NOT NULL))
);
CREATE INDEX platform_payments_tenant_idx ON platform_payments (tenant_id, created_at DESC);
CREATE TRIGGER platform_payments_updated BEFORE UPDATE ON platform_payments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- Paid is final, and what was bought never changes.
CREATE FUNCTION platform_payment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'paid' OR NEW.amount <> OLD.amount OR NEW.kind <> OLD.kind OR NEW.provider_ref <> OLD.provider_ref
     OR NEW.plan_id IS DISTINCT FROM OLD.plan_id OR NEW.size_mb IS DISTINCT FROM OLD.size_mb THEN
    RAISE EXCEPTION 'payment_link_immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER platform_payments_guard BEFORE UPDATE ON platform_payments FOR EACH ROW EXECUTE FUNCTION platform_payment_guard();
CREATE TRIGGER platform_payments_no_delete BEFORE DELETE ON platform_payments FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
-- The workspace reads its own payments; creating and applying them goes through the server's billing code.
SELECT enable_tenant_rls('platform_payments'::regclass, false);
GRANT SELECT ON platform_payments TO munassiq_app;

-- ── Security events (for the admin's suspicious-IP list) ──────────────────────────
CREATE TABLE security_events (
  id    bigserial PRIMARY KEY,
  ip    inet NOT NULL,
  kind  text NOT NULL CHECK (kind IN ('login_failed', 'rate_limited', 'origin_rejected', 'unauthorized')),
  path  text NOT NULL CHECK (char_length(path) <= 200),
  at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX security_events_at_idx ON security_events (at DESC);
CREATE INDEX security_events_ip_idx ON security_events (ip, at DESC);
REVOKE ALL ON security_events FROM munassiq_app;
-- munassiq_system already has every table by default privileges (0001).
