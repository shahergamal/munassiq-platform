-- 0001_core: users, sessions, one-time tokens, append-only audit log, shared helpers.
CREATE EXTENSION IF NOT EXISTS citext;

-- The system role gets every table the owner creates from here on (auth/admin/provisioning).
ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO munassiq_system;
ALTER DEFAULT PRIVILEGES GRANT ALL ON SEQUENCES TO munassiq_system;

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'append_only_table' USING ERRCODE = 'P0001'; END $$;

-- Tenant context for the current transaction (set by the API with set_config(..., true)).
CREATE FUNCTION app_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION grant_app(_tbl regclass, _privs text DEFAULT 'SELECT, INSERT, UPDATE, DELETE')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN EXECUTE format('GRANT %s ON %s TO munassiq_app', _privs, _tbl); END $$;

CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              citext NOT NULL UNIQUE,
  password_hash      text NOT NULL,
  full_name          text NOT NULL CHECK (char_length(full_name) BETWEEN 2 AND 120),
  phone              text CHECK (phone IS NULL OR phone ~ '^\+?[0-9]{9,15}$'),
  email_verified_at  timestamptz,
  is_platform_admin  boolean NOT NULL DEFAULT false,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  failed_login_count integer NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  last_login_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash          text NOT NULL UNIQUE,          -- sha256 of the cookie value; the raw token is never stored
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  idle_expires_at     timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at          timestamptz,
  ip                  inet,
  user_agent          text
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE one_time_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    text NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid,
  tenant_id     uuid,
  action        text NOT NULL,
  entity_type   text,
  entity_id     text,
  meta          jsonb NOT NULL DEFAULT '{}',
  ip            inet
);
CREATE INDEX audit_log_tenant_idx ON audit_log (tenant_id, at DESC);
CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Tenant traffic may only APPEND to the audit log, and only for its own tenant.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_log_insert ON audit_log FOR INSERT WITH CHECK (tenant_id = app_tenant_id());
SELECT grant_app('audit_log', 'INSERT');
