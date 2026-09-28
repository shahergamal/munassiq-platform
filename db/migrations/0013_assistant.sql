-- AI assistant: a tenant member asks questions about THEIR workspace and requests reports.
-- Isolation is layered: tenant RLS (like every table) + a RESTRICTIVE policy so a member only ever sees
-- their own conversations and exports, even inside their own tenant.

-- New permission, grantable to custom roles like any other.
ALTER TABLE tenant_roles DROP CONSTRAINT tenant_roles_permissions_check;
ALTER TABLE tenant_roles ADD CONSTRAINT tenant_roles_permissions_check CHECK (
  cardinality(permissions) >= 1 AND permissions <@ ARRAY[
    'catalog:read','catalog:write','stock:read','stock:adjust','stock:post_count',
    'purchases:read','purchases:write','purchases:approve','purchases:receive','recipes:read','recipes:write',
    'pos:read','pos:operate','pos:refund','pos:discount_override','pos:kitchen','reports:read',
    'expenses:read','expenses:write','expenses:approve','payables:write','members:manage','settings:manage',
    'assistant:use'
  ]::text[]);

CREATE TABLE assistant_conversations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  -- The model-facing transcript (user text, assistant content incl. tool calls, tool results), replayed each turn.
  messages   jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(messages) = 'array' AND octet_length(messages::text) <= 4000000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX assistant_conversations_user_idx ON assistant_conversations (tenant_id, user_id, updated_at DESC);
CREATE TRIGGER assistant_conversations_updated BEFORE UPDATE ON assistant_conversations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Files the assistant produced from real query results; short-lived.
CREATE TABLE assistant_exports (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename   text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 160),
  mime       text NOT NULL CHECK (mime IN ('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv; charset=utf-8', 'text/html; charset=utf-8')),
  content    bytea NOT NULL CHECK (octet_length(content) <= 10485760),
  row_count  integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days'
);
CREATE INDEX assistant_exports_user_idx ON assistant_exports (tenant_id, user_id, created_at DESC);

-- Daily usage per member: enforces the quota and shows cost drivers.
CREATE TABLE assistant_usage (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day           date NOT NULL,
  turns         integer NOT NULL DEFAULT 0,
  tool_calls    integer NOT NULL DEFAULT 0,
  input_tokens  bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, user_id, day)
);

DO $$
DECLARE _t text;
BEGIN
  FOREACH _t IN ARRAY ARRAY['assistant_conversations', 'assistant_exports', 'assistant_usage'] LOOP
    PERFORM enable_tenant_rls(_t::regclass);
    -- RESTRICTIVE: AND-ed with the tenant policies. Another member of the same tenant sees nothing.
    EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR ALL USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id())', _t || '_owner', _t);
  END LOOP;
  PERFORM grant_app('assistant_conversations');
  PERFORM grant_app('assistant_exports', 'SELECT, INSERT, DELETE');
  PERFORM grant_app('assistant_usage', 'SELECT, INSERT, UPDATE');
END $$;
