-- 0004_pos: shifts, orders, payments, refunds and the e-invoice ledger. Financial rows are never deleted.

CREATE TABLE pos_shifts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id     uuid NOT NULL,
  opened_by       uuid NOT NULL,
  opened_at       timestamptz NOT NULL DEFAULT now(),
  opening_float   numeric(14,2) NOT NULL DEFAULT 0 CHECK (opening_float >= 0),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_by       uuid,
  closed_at       timestamptz,
  expected_cash   numeric(14,2),
  counted_cash    numeric(14,2) CHECK (counted_cash IS NULL OR counted_cash >= 0),
  over_short      numeric(14,2),
  idempotency_key uuid NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id)
);
-- One open shift per cashier per location.
CREATE UNIQUE INDEX pos_one_open_shift_uq ON pos_shifts (tenant_id, location_id, opened_by) WHERE status = 'open';

CREATE TABLE pos_orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_number    bigint NOT NULL,
  location_id     uuid NOT NULL,
  shift_id        uuid NOT NULL,
  channel         text NOT NULL CHECK (channel IN ('dine_in', 'takeaway', 'delivery')),
  status          text NOT NULL DEFAULT 'paid' CHECK (status IN ('paid', 'partially_refunded', 'refunded')),
  subtotal        numeric(14,2) NOT NULL CHECK (subtotal >= 0),
  discount        numeric(14,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  taxable         numeric(14,2) NOT NULL CHECK (taxable >= 0),
  vat             numeric(14,2) NOT NULL CHECK (vat >= 0),
  total           numeric(14,2) NOT NULL CHECK (total >= 0),
  cost_total      numeric(14,4) NOT NULL DEFAULT 0 CHECK (cost_total >= 0),
  discount_reason text,
  customer_name   text,
  notes           text,
  idempotency_key uuid NOT NULL,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, order_number),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES pos_shifts (tenant_id, id)
);
CREATE INDEX pos_orders_list_idx ON pos_orders (tenant_id, created_at DESC);
CREATE INDEX pos_orders_shift_idx ON pos_orders (tenant_id, shift_id);

CREATE TABLE pos_order_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id       uuid NOT NULL,
  recipe_id      uuid NOT NULL,
  name_snapshot  text NOT NULL,
  quantity       integer NOT NULL CHECK (quantity > 0),
  unit_price_net numeric(12,2) NOT NULL CHECK (unit_price_net >= 0),
  line_net       numeric(14,2) NOT NULL CHECK (line_net >= 0),
  discount       numeric(14,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  vat            numeric(14,2) NOT NULL CHECK (vat >= 0),
  line_total     numeric(14,2) NOT NULL CHECK (line_total >= 0),
  cost           numeric(14,4) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  FOREIGN KEY (tenant_id, order_id) REFERENCES pos_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, recipe_id) REFERENCES recipes (tenant_id, id)
);
CREATE INDEX pos_order_items_order_idx ON pos_order_items (tenant_id, order_id);

CREATE TABLE pos_payments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id   uuid NOT NULL,
  shift_id   uuid NOT NULL,
  method     text NOT NULL CHECK (method IN ('cash', 'mada', 'visa', 'mastercard')),
  amount     numeric(14,2) NOT NULL CHECK (amount > 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, order_id) REFERENCES pos_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES pos_shifts (tenant_id, id)
);
CREATE INDEX pos_payments_shift_idx ON pos_payments (tenant_id, shift_id, method);

CREATE TABLE pos_refunds (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id        uuid NOT NULL,
  shift_id        uuid NOT NULL,
  amount          numeric(14,2) NOT NULL CHECK (amount > 0),
  vat_amount      numeric(14,2) NOT NULL CHECK (vat_amount >= 0),
  method          text NOT NULL CHECK (method IN ('cash', 'mada', 'visa', 'mastercard')),
  reason          text NOT NULL CHECK (char_length(trim(reason)) >= 3),
  restocked       boolean NOT NULL DEFAULT false,
  idempotency_key uuid NOT NULL,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, order_id) REFERENCES pos_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES pos_shifts (tenant_id, id)
);

-- One row per shift/location counter used to chain invoices (ICV + previous hash).
CREATE TABLE invoice_sequences (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id   uuid NOT NULL,
  next_icv      bigint NOT NULL DEFAULT 1,
  previous_hash text NOT NULL DEFAULT repeat('0', 64),
  PRIMARY KEY (tenant_id, location_id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id)
);

-- Phase-1 e-invoice ledger: simplified invoices and credit notes with the mandatory QR.
CREATE TABLE e_invoices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id    uuid NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('simplified_invoice', 'credit_note')),
  icv            bigint NOT NULL,
  order_id       uuid NOT NULL,
  refund_id      uuid,
  issued_at      timestamptz NOT NULL DEFAULT now(),
  seller_name    text NOT NULL,
  vat_number     text NOT NULL,
  total          numeric(14,2) NOT NULL,
  vat            numeric(14,2) NOT NULL,
  previous_hash  text NOT NULL,
  integrity_hash text NOT NULL,
  qr_base64      text NOT NULL,
  UNIQUE (tenant_id, location_id, icv),
  FOREIGN KEY (tenant_id, order_id) REFERENCES pos_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id)
);
CREATE TRIGGER e_invoices_immutable BEFORE UPDATE OR DELETE ON e_invoices FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DO $$
DECLARE _t text;
BEGIN
  FOREACH _t IN ARRAY ARRAY['pos_shifts','pos_orders','pos_order_items','pos_payments','pos_refunds','invoice_sequences','e_invoices'] LOOP
    PERFORM enable_tenant_rls(_t::regclass);
  END LOOP;
  PERFORM grant_app('pos_shifts', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('pos_orders', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('invoice_sequences', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('pos_order_items', 'SELECT, INSERT');
  PERFORM grant_app('pos_payments', 'SELECT, INSERT');
  PERFORM grant_app('pos_refunds', 'SELECT, INSERT');
  PERFORM grant_app('e_invoices', 'SELECT, INSERT');
END $$;

CREATE TRIGGER pos_orders_updated BEFORE UPDATE ON pos_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();
