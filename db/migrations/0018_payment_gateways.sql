-- Online payment gateways (Moyasar, Tap), connected by each workspace with its own account keys.
-- A payment link collects a credit invoice's balance; when the gateway confirms the payment (webhook, or a manual
-- "check now"), the server re-reads the payment from the gateway and records a customer receipt + journal entry.
--
--   * The secret key is stored encrypted (AES-256-GCM, key held by the server) and never returned to the browser.
--   * The webhook URL carries a random per-connection token; the payment is always re-read from the gateway,
--     never trusted from the webhook body.

CREATE TABLE payment_connections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider        text NOT NULL CHECK (provider IN ('moyasar', 'tap')),
  mode            text NOT NULL CHECK (mode IN ('test', 'live')),
  secret_enc      text NOT NULL,
  -- Last 4 characters of the key, so the owner can tell which key is connected.
  key_hint        text NOT NULL CHECK (char_length(key_hint) = 4),
  webhook_token   text NOT NULL CHECK (webhook_token ~ '^[A-Za-z0-9_-]{32,64}$'),
  connected_by    uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, provider)
);
CREATE TRIGGER payment_connections_updated BEFORE UPDATE ON payment_connections FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE payment_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider        text NOT NULL CHECK (provider IN ('moyasar', 'tap')),
  mode            text NOT NULL CHECK (mode IN ('test', 'live')),
  document_id     uuid NOT NULL,
  customer_id     uuid NOT NULL,
  amount          numeric(14,2) NOT NULL CHECK (amount > 0),
  -- The gateway's object: Moyasar invoice id, Tap charge id.
  provider_ref    text NOT NULL CHECK (char_length(provider_ref) BETWEEN 3 AND 100),
  url             text NOT NULL CHECK (url ~ '^https://'),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'expired', 'canceled')),
  -- The gateway's own status word and payment reference at the last check (shown to the owner).
  provider_status text,
  payment_ref     text,
  receipt_id      uuid,
  paid_at         timestamptz,
  checked_at      timestamptz,
  idempotency_key uuid NOT NULL,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (provider, provider_ref),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, document_id) REFERENCES sales_documents (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, receipt_id) REFERENCES customer_receipts (tenant_id, id),
  -- A paid link always has its receipt, and a receipt is attached only once.
  CHECK ((status = 'paid') = (receipt_id IS NOT NULL))
);
CREATE INDEX payment_links_document_idx ON payment_links (tenant_id, document_id, created_at DESC);
CREATE UNIQUE INDEX payment_links_receipt_uq ON payment_links (receipt_id) WHERE receipt_id IS NOT NULL;

-- A settled link stays settled: no going back from paid, and the amount/target never change.
CREATE FUNCTION payment_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'paid' OR NEW.amount <> OLD.amount OR NEW.document_id <> OLD.document_id OR NEW.provider_ref <> OLD.provider_ref THEN
    RAISE EXCEPTION 'payment_link_immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_links_guard BEFORE UPDATE ON payment_links FOR EACH ROW EXECUTE FUNCTION payment_link_guard();
CREATE TRIGGER payment_links_no_delete BEFORE DELETE ON payment_links FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Receipts collected online.
ALTER TABLE customer_receipts DROP CONSTRAINT customer_receipts_method_check;
ALTER TABLE customer_receipts ADD CONSTRAINT customer_receipts_method_check CHECK (method IN ('cash', 'bank_transfer', 'cheque', 'card', 'online'));

DO $$
BEGIN
  PERFORM enable_tenant_rls('payment_connections'::regclass);
  PERFORM enable_tenant_rls('payment_links'::regclass);
  PERFORM grant_app('payment_connections', 'SELECT, INSERT, UPDATE, DELETE');
  PERFORM grant_app('payment_links', 'SELECT, INSERT, UPDATE');
END $$;

-- The clearing account for money held by the gateway until it settles to the bank.
CREATE FUNCTION seed_payment_accounts(_t uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE _parent uuid; _code text;
BEGIN
  IF EXISTS (SELECT 1 FROM accounts WHERE tenant_id = _t AND system_key = 'gateway_clearing') THEN RETURN; END IF;
  SELECT id INTO _parent FROM accounts WHERE tenant_id = _t AND code = '11';
  IF _parent IS NULL THEN RETURN; END IF;
  SELECT c INTO _code FROM generate_series(1110, 1199) g, LATERAL (SELECT g::text AS c) x
   WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE tenant_id = _t AND code = x.c) ORDER BY g LIMIT 1;
  INSERT INTO accounts (tenant_id, code, name, type, parent_id, is_group, system_key)
  VALUES (_t, _code, 'مستحقات بوابات الدفع الإلكتروني', 'asset', _parent, false, 'gateway_clearing');
END $$;
REVOKE ALL ON FUNCTION seed_payment_accounts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION seed_payment_accounts(uuid) TO munassiq_system;

DO $$
DECLARE _t uuid;
BEGIN
  FOR _t IN SELECT id FROM tenants LOOP PERFORM seed_payment_accounts(_t); END LOOP;
END $$;
