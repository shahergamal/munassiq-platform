-- Assistant, second step:
-- 1) the platform admin sets each workspace's daily question limit (per member); NULL = the server default,
--    0 = the assistant is switched off for that workspace. Read by POST /t/assistant/chat and GET /t/assistant/status.
-- 2) Word (.doc) exports.
-- 3) The platform admin's own assistant: platform data only (never a workspace's internal data). Stored apart from
--    tenant data, reached only through the system role by admin routes, each row owned by one admin.

ALTER TABLE tenant_limit_overrides ADD COLUMN assistant_daily_turns integer CHECK (assistant_daily_turns BETWEEN 0 AND 10000);

-- The current workspace's override only (app.tenant_id), so a member can never read another workspace's value.
CREATE FUNCTION tenant_assistant_turns() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
  SELECT assistant_daily_turns FROM tenant_limit_overrides WHERE tenant_id = app_tenant_id() $$;
REVOKE ALL ON FUNCTION tenant_assistant_turns() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_assistant_turns() TO munassiq_app;

ALTER TABLE assistant_exports DROP CONSTRAINT assistant_exports_mime_check;
ALTER TABLE assistant_exports ADD CONSTRAINT assistant_exports_mime_check CHECK (mime IN (
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv; charset=utf-8', 'text/html; charset=utf-8', 'application/msword'));

CREATE TABLE admin_assistant_conversations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  messages   jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(messages) = 'array' AND octet_length(messages::text) <= 4000000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_assistant_conversations_user_idx ON admin_assistant_conversations (user_id, updated_at DESC);
CREATE TRIGGER admin_assistant_conversations_updated BEFORE UPDATE ON admin_assistant_conversations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE admin_assistant_exports (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename   text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 160),
  mime       text NOT NULL CHECK (mime IN ('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv; charset=utf-8', 'text/html; charset=utf-8', 'application/msword')),
  content    bytea NOT NULL CHECK (octet_length(content) <= 10485760),
  row_count  integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days'
);
CREATE INDEX admin_assistant_exports_user_idx ON admin_assistant_exports (user_id, created_at DESC);

-- Not for the tenant role, even by mistake: RLS on with no policy for it.
ALTER TABLE admin_assistant_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_assistant_exports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON admin_assistant_conversations, admin_assistant_exports FROM munassiq_app;
