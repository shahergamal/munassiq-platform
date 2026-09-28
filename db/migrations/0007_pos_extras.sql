-- 0007_pos_extras: dining areas & tables, modifiers, customers, delivery platforms, kitchen tickets.

-- ── Dining areas & tables ─────────────────────────────────────────────────────────────────────
CREATE TABLE dining_areas (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id uuid NOT NULL,
  name        text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 80),
  sort_order  integer NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, location_id, name),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id)
);

CREATE TABLE dining_tables (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  area_id   uuid NOT NULL,
  name      text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 40),
  seats     integer NOT NULL DEFAULT 4 CHECK (seats BETWEEN 1 AND 50),
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  UNIQUE (area_id, name),
  FOREIGN KEY (tenant_id, area_id) REFERENCES dining_areas (tenant_id, id)
);

-- ── Modifiers ─────────────────────────────────────────────────────────────────────────────────
CREATE TABLE modifier_groups (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (char_length(trim(name)) BETWEEN 2 AND 80),
  min_select integer NOT NULL DEFAULT 0 CHECK (min_select >= 0),
  max_select integer NOT NULL DEFAULT 1 CHECK (max_select >= 1),
  is_active  boolean NOT NULL DEFAULT true,
  CHECK (min_select <= max_select),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE modifier_options (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  group_id       uuid NOT NULL,
  name           text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 80),
  price_net      numeric(12,2) NOT NULL DEFAULT 0 CHECK (price_net >= 0),
  ingredient_id  uuid,                                                         -- stock consumed when chosen (optional)
  ingredient_qty numeric(18,4) CHECK (ingredient_qty IS NULL OR ingredient_qty > 0),
  sort_order     integer NOT NULL DEFAULT 0,
  is_active      boolean NOT NULL DEFAULT true,
  CHECK ((ingredient_id IS NULL) = (ingredient_qty IS NULL)),
  UNIQUE (tenant_id, id),
  UNIQUE (group_id, name),
  FOREIGN KEY (tenant_id, group_id) REFERENCES modifier_groups (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, ingredient_id) REFERENCES ingredients (tenant_id, id)
);

CREATE TABLE recipe_modifier_groups (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  recipe_id  uuid NOT NULL,
  group_id   uuid NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  PRIMARY KEY (recipe_id, group_id),
  FOREIGN KEY (tenant_id, recipe_id) REFERENCES recipes (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, group_id) REFERENCES modifier_groups (tenant_id, id) ON DELETE CASCADE
);

-- ── Customers & delivery platforms ────────────────────────────────────────────────────────────
CREATE TABLE customers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (char_length(trim(name)) BETWEEN 2 AND 120),
  phone      text NOT NULL CHECK (phone ~ '^\+?[0-9]{9,15}$'),
  email      text CHECK (email IS NULL OR char_length(email) <= 255),
  address    text CHECK (address IS NULL OR char_length(address) <= 300),
  notes      text CHECK (notes IS NULL OR char_length(notes) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, phone)
);
CREATE TRIGGER customers_updated BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE delivery_platforms (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name               text NOT NULL CHECK (char_length(trim(name)) BETWEEN 2 AND 80),
  commission_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (commission_percent BETWEEN 0 AND 100),
  is_active          boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

-- ── Orders: new references (all optional) ─────────────────────────────────────────────────────
ALTER TABLE pos_orders
  ADD COLUMN table_id          uuid,
  ADD COLUMN guests            integer CHECK (guests IS NULL OR guests BETWEEN 1 AND 100),
  ADD COLUMN customer_id       uuid,
  ADD COLUMN platform_id       uuid,
  ADD COLUMN external_ref      text CHECK (external_ref IS NULL OR char_length(external_ref) <= 60),
  ADD COLUMN commission_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (commission_amount >= 0),
  ADD CONSTRAINT pos_orders_table_fk FOREIGN KEY (tenant_id, table_id) REFERENCES dining_tables (tenant_id, id),
  ADD CONSTRAINT pos_orders_customer_fk FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  ADD CONSTRAINT pos_orders_platform_fk FOREIGN KEY (tenant_id, platform_id) REFERENCES delivery_platforms (tenant_id, id),
  ADD CONSTRAINT pos_orders_platform_channel CHECK (platform_id IS NULL OR channel = 'delivery'),
  ADD CONSTRAINT pos_orders_table_channel CHECK (table_id IS NULL OR channel = 'dine_in');
CREATE INDEX pos_orders_customer_idx ON pos_orders (tenant_id, customer_id, created_at DESC) WHERE customer_id IS NOT NULL;

-- Orders from a delivery platform are settled by the platform, not at the till.
ALTER TABLE pos_payments DROP CONSTRAINT pos_payments_method_check;
ALTER TABLE pos_payments ADD CONSTRAINT pos_payments_method_check CHECK (method IN ('cash', 'mada', 'visa', 'mastercard', 'platform'));
ALTER TABLE pos_refunds DROP CONSTRAINT pos_refunds_method_check;
ALTER TABLE pos_refunds ADD CONSTRAINT pos_refunds_method_check CHECK (method IN ('cash', 'mada', 'visa', 'mastercard', 'platform'));

-- Pricing lines need an id to attach their modifiers.
CREATE TABLE pos_order_item_modifiers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_item_id  uuid NOT NULL REFERENCES pos_order_items(id),
  option_id      uuid NOT NULL,
  name_snapshot  text NOT NULL,
  price_net      numeric(12,2) NOT NULL CHECK (price_net >= 0),
  FOREIGN KEY (tenant_id, option_id) REFERENCES modifier_options (tenant_id, id)
);
CREATE INDEX pos_order_item_modifiers_item_idx ON pos_order_item_modifiers (order_item_id);

-- ── Kitchen tickets (KDS) ─────────────────────────────────────────────────────────────────────
CREATE TABLE kitchen_tickets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id    uuid NOT NULL,
  location_id uuid NOT NULL,
  status      text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'preparing', 'ready', 'served')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  ready_at    timestamptz,
  served_at   timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (order_id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES pos_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id)
);
CREATE INDEX kitchen_tickets_board_idx ON kitchen_tickets (tenant_id, location_id, status, created_at);

DO $$
DECLARE _t text;
BEGIN
  FOREACH _t IN ARRAY ARRAY['dining_areas','dining_tables','modifier_groups','modifier_options','recipe_modifier_groups','customers','delivery_platforms','pos_order_item_modifiers','kitchen_tickets'] LOOP
    PERFORM enable_tenant_rls(_t::regclass);
  END LOOP;
  PERFORM grant_app('dining_areas', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('dining_tables', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('modifier_groups', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('modifier_options', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('recipe_modifier_groups');
  PERFORM grant_app('customers', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('delivery_platforms', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('pos_order_item_modifiers', 'SELECT, INSERT');
  PERFORM grant_app('kitchen_tickets', 'SELECT, INSERT, UPDATE');
END $$;
