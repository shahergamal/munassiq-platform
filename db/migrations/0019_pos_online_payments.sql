-- Paying at the till through the workspace's own gateway (Moyasar / Tap): the cashier shows a QR of the hosted
-- payment page, the customer pays on their phone, and the sale is recorded only once the gateway confirms it.
--
--   * The cart is priced and validated (stock, shift, discount) by the server before the page is opened; the priced
--     cart is kept here and replayed as the sale, with one payment of method 'online' for the confirmed amount.
--   * A payment the gateway confirmed but the sale could not be recorded (stock ran out meanwhile, shift closed) is
--     kept as 'paid_unfulfilled' with the reason, so the manager can retry or refund from the gateway dashboard.

CREATE TABLE pos_payment_intents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider        text NOT NULL CHECK (provider IN ('moyasar', 'tap')),
  mode            text NOT NULL CHECK (mode IN ('test', 'live')),
  location_id     uuid NOT NULL,
  shift_id        uuid NOT NULL,
  amount          numeric(14,2) NOT NULL CHECK (amount > 0),
  -- The sale request (ids and quantities only) replayed once paid.
  cart            jsonb NOT NULL,
  -- The cashier's permissions when the cart was validated (discount limit, shift ownership) used for the replay.
  permissions     text[] NOT NULL,
  provider_ref    text NOT NULL CHECK (char_length(provider_ref) BETWEEN 3 AND 100),
  url             text NOT NULL CHECK (url ~ '^https://'),
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'paid', 'paid_unfulfilled', 'failed', 'expired', 'canceled', 'paid_after_cancel')),
  provider_status text,
  payment_ref     text,
  failure         text,
  order_id        uuid,
  paid_at         timestamptz,
  idempotency_key uuid NOT NULL,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (provider, provider_ref),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES pos_shifts (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES pos_orders (tenant_id, id),
  CHECK ((status = 'paid') = (order_id IS NOT NULL))
);
CREATE INDEX pos_payment_intents_shift_idx ON pos_payment_intents (tenant_id, shift_id, created_at DESC);
CREATE UNIQUE INDEX pos_payment_intents_order_uq ON pos_payment_intents (order_id) WHERE order_id IS NOT NULL;
CREATE TRIGGER pos_payment_intents_updated BEFORE UPDATE ON pos_payment_intents FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A fulfilled intent never changes again, and the amount/cart it was paid for are fixed.
CREATE FUNCTION pos_payment_intent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'paid' OR NEW.amount <> OLD.amount OR NEW.cart <> OLD.cart OR NEW.provider_ref <> OLD.provider_ref THEN
    RAISE EXCEPTION 'payment_link_immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pos_payment_intents_guard BEFORE UPDATE ON pos_payment_intents FOR EACH ROW EXECUTE FUNCTION pos_payment_intent_guard();
CREATE TRIGGER pos_payment_intents_no_delete BEFORE DELETE ON pos_payment_intents FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE pos_payments DROP CONSTRAINT pos_payments_method_check;
ALTER TABLE pos_payments ADD CONSTRAINT pos_payments_method_check CHECK (method IN ('cash', 'mada', 'visa', 'mastercard', 'platform', 'online'));

DO $$
BEGIN
  PERFORM enable_tenant_rls('pos_payment_intents'::regclass);
  PERFORM grant_app('pos_payment_intents', 'SELECT, INSERT, UPDATE');
END $$;
