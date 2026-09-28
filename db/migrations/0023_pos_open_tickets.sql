-- Open orders at the till ("tickets"): several customers served at once, each order kept on the server until paid.
--
--   A ticket holds what a customer ordered (recipe ids, quantities, options, a note per line) and where it goes
--   (table, takeaway, delivery, customer). Nothing about money is stored: every total is priced by the server when
--   shown and when paid. A ticket can be sent to the kitchen before payment, in rounds (the first order, then
--   additions); reducing something the kitchen already has sends a "void" round and needs a manager (pos:refund).
--   Paying records a normal sale (pos_orders) linked to the ticket; a bill can be split by items into several sales.
--   One open ticket per table. Tickets are shared by the location's tills, with a version for concurrent edits.

CREATE TABLE pos_tickets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_number    bigint NOT NULL,
  location_id      uuid NOT NULL,
  label            text CHECK (label IS NULL OR char_length(label) <= 60),
  channel          text NOT NULL DEFAULT 'takeaway' CHECK (channel IN ('dine_in', 'takeaway', 'delivery')),
  table_id         uuid,
  guests           integer CHECK (guests IS NULL OR guests BETWEEN 1 AND 100),
  customer_id      uuid,
  platform_id      uuid,
  external_ref     text CHECK (external_ref IS NULL OR char_length(external_ref) <= 60),
  discount         jsonb,
  discount_reason  text CHECK (discount_reason IS NULL OR char_length(discount_reason) <= 300),
  notes            text CHECK (notes IS NULL OR char_length(notes) <= 500),
  -- [{ id, recipeId, quantity, modifiers: [optionId], note, sent }]; validated and priced by the server on every write.
  items            jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(items) = 'array'),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'void')),
  void_reason      text,
  version          integer NOT NULL DEFAULT 1,
  kitchen_rounds   integer NOT NULL DEFAULT 0,
  last_sent_at     timestamptz,
  idempotency_key  uuid NOT NULL,
  created_by       uuid NOT NULL,
  updated_by       uuid,
  closed_by        uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, ticket_number),
  UNIQUE (tenant_id, idempotency_key),
  CHECK (table_id IS NULL OR channel = 'dine_in'),
  CHECK (platform_id IS NULL OR channel = 'delivery'),
  CHECK (status = 'open' OR closed_at IS NOT NULL),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id),
  FOREIGN KEY (tenant_id, table_id) REFERENCES dining_tables (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, platform_id) REFERENCES delivery_platforms (tenant_id, id)
);
CREATE INDEX pos_tickets_open_idx ON pos_tickets (tenant_id, location_id, created_at) WHERE status = 'open';
CREATE UNIQUE INDEX pos_tickets_one_per_table_uq ON pos_tickets (tenant_id, table_id) WHERE status = 'open' AND table_id IS NOT NULL;
CREATE TRIGGER pos_tickets_updated BEFORE UPDATE ON pos_tickets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A closed ticket stays as it was closed.
CREATE FUNCTION pos_tickets_closed_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'tickets are never deleted' USING ERRCODE = 'P0001'; END IF;
  IF OLD.status <> 'open' THEN RAISE EXCEPTION 'ticket_closed' USING ERRCODE = 'P0001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pos_tickets_closed_guard BEFORE UPDATE OR DELETE ON pos_tickets FOR EACH ROW EXECUTE FUNCTION pos_tickets_closed_guard();

-- Sales made from a ticket (several when the bill is split), and a note per sold line ("no onions").
ALTER TABLE pos_orders ADD COLUMN ticket_id uuid;
ALTER TABLE pos_orders ADD CONSTRAINT pos_orders_ticket_fk FOREIGN KEY (tenant_id, ticket_id) REFERENCES pos_tickets (tenant_id, id);
CREATE INDEX pos_orders_ticket_idx ON pos_orders (tenant_id, ticket_id) WHERE ticket_id IS NOT NULL;
ALTER TABLE pos_order_items ADD COLUMN note text CHECK (note IS NULL OR char_length(note) <= 140);

-- Kitchen tickets: a round of a ticket (sent before payment, possibly several) carries its own items snapshot.
-- A sale without a ticket keeps one kitchen ticket per order, read from the order's lines as before.
ALTER TABLE kitchen_tickets
  ALTER COLUMN order_id DROP NOT NULL,
  ADD COLUMN pos_ticket_id uuid,
  ADD COLUMN round integer NOT NULL DEFAULT 1 CHECK (round >= 1),
  ADD COLUMN items jsonb,
  ADD CONSTRAINT kitchen_tickets_source CHECK (order_id IS NOT NULL OR pos_ticket_id IS NOT NULL),
  ADD CONSTRAINT kitchen_tickets_pos_ticket_fk FOREIGN KEY (tenant_id, pos_ticket_id) REFERENCES pos_tickets (tenant_id, id);
CREATE INDEX kitchen_tickets_pos_ticket_idx ON kitchen_tickets (tenant_id, pos_ticket_id) WHERE pos_ticket_id IS NOT NULL;

DO $$
BEGIN
  PERFORM enable_tenant_rls('pos_tickets'::regclass);
  PERFORM grant_app('pos_tickets', 'SELECT, INSERT, UPDATE');
END $$;
