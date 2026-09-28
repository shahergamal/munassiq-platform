-- Per-user interface preferences (table sort and visible columns), so a layout follows the user across devices.
-- Owned by the user, not a tenant: like `users`, only munassiq_system reads or writes it (no grant to munassiq_app).
CREATE TABLE user_ui_prefs (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pref_key   text NOT NULL CHECK (char_length(pref_key) BETWEEN 1 AND 120 AND pref_key !~ '[[:cntrl:]]'),
  value      jsonb NOT NULL CHECK (octet_length(value::text) <= 4000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, pref_key)
);
