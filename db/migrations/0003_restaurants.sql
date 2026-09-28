-- 0003_restaurants: master data, purchasing, inventory (weighted-average cost) and recipes.
-- Every table carries tenant_id and uses composite (tenant_id, id) foreign keys, so a row can never
-- reference another tenant's data even if application code is wrong. RLS is the second wall.

CREATE TABLE units (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code      text NOT NULL,
  name      text NOT NULL,
  dimension text NOT NULL CHECK (dimension IN ('mass', 'volume', 'count')),
  to_base   numeric(18,6) NOT NULL CHECK (to_base > 0),   -- factor to g / ml / piece
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE suppliers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code               text NOT NULL,
  name               text NOT NULL,
  tax_id             text,
  phone              text,
  email              text,
  payment_terms_days integer NOT NULL DEFAULT 0 CHECK (payment_terms_days >= 0),
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE branches (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code       text NOT NULL,
  name       text NOT NULL,
  city       text,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE locations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id     uuid,
  code          text NOT NULL,
  name          text NOT NULL,
  location_type text NOT NULL DEFAULT 'kitchen' CHECK (location_type IN ('kitchen', 'warehouse', 'store')),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id)
);

CREATE TABLE ingredients (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku               text NOT NULL,
  name              text NOT NULL,
  category          text,
  base_unit_id      uuid NOT NULL,                      -- stock and cost are kept in this unit
  purchase_unit_id  uuid NOT NULL,
  purchase_to_base  numeric(18,6) NOT NULL CHECK (purchase_to_base > 0),  -- base units in ONE purchase unit
  yield_percentage  numeric(6,2) NOT NULL DEFAULT 100 CHECK (yield_percentage > 0 AND yield_percentage <= 100),
  min_stock         numeric(18,4) NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
  barcode           text,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, sku),
  FOREIGN KEY (tenant_id, base_unit_id) REFERENCES units (tenant_id, id),
  FOREIGN KEY (tenant_id, purchase_unit_id) REFERENCES units (tenant_id, id)
);
CREATE INDEX ingredients_name_idx ON ingredients (tenant_id, name);

CREATE TABLE stock_levels (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id   uuid NOT NULL,
  ingredient_id uuid NOT NULL,
  quantity      numeric(18,4) NOT NULL DEFAULT 0 CHECK (quantity >= 0),      -- never negative: enforced by the database
  avg_cost      numeric(18,6) NOT NULL DEFAULT 0 CHECK (avg_cost >= 0),      -- weighted-average cost per base unit
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, location_id, ingredient_id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id),
  FOREIGN KEY (tenant_id, ingredient_id) REFERENCES ingredients (tenant_id, id)
);

CREATE TABLE stock_movements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id   uuid NOT NULL,
  ingredient_id uuid NOT NULL,
  movement_type text NOT NULL CHECK (movement_type IN ('purchase', 'sale', 'refund_return')),
  quantity      numeric(18,4) NOT NULL CHECK (quantity <> 0),   -- signed: + in, - out
  unit_cost     numeric(18,6) NOT NULL CHECK (unit_cost >= 0),
  ref_type      text NOT NULL,
  ref_id        uuid NOT NULL,
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id),
  FOREIGN KEY (tenant_id, ingredient_id) REFERENCES ingredients (tenant_id, id)
);
CREATE INDEX stock_movements_ref_idx ON stock_movements (tenant_id, ref_type, ref_id);
CREATE INDEX stock_movements_time_idx ON stock_movements (tenant_id, created_at DESC);
CREATE TRIGGER stock_movements_immutable BEFORE UPDATE OR DELETE ON stock_movements FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE purchase_orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  po_number        bigint NOT NULL,
  supplier_id      uuid NOT NULL,
  location_id      uuid NOT NULL,
  supplier_invoice text,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'received', 'cancelled')),
  subtotal         numeric(14,2) NOT NULL CHECK (subtotal >= 0),
  discount         numeric(14,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  shipping         numeric(14,2) NOT NULL DEFAULT 0 CHECK (shipping >= 0),
  fees             numeric(14,2) NOT NULL DEFAULT 0 CHECK (fees >= 0),
  total            numeric(14,2) NOT NULL CHECK (total >= 0),
  idempotency_key  uuid NOT NULL,
  created_by       uuid NOT NULL,
  approved_by      uuid,
  received_by      uuid,
  approved_at      timestamptz,
  received_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, po_number),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id),
  CHECK (discount <= subtotal)
);
CREATE INDEX purchase_orders_list_idx ON purchase_orders (tenant_id, created_at DESC);

CREATE TABLE purchase_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  purchase_order_id  uuid NOT NULL,
  ingredient_id      uuid NOT NULL,
  quantity           numeric(18,4) NOT NULL CHECK (quantity > 0),   -- in purchase units
  unit_price         numeric(14,4) NOT NULL CHECK (unit_price >= 0),-- per purchase unit, VAT exclusive
  line_total         numeric(14,2) NOT NULL CHECK (line_total >= 0),
  received_unit_cost numeric(18,6),                                 -- landed cost per base unit, set on receipt
  UNIQUE (purchase_order_id, ingredient_id),
  FOREIGN KEY (tenant_id, purchase_order_id) REFERENCES purchase_orders (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, ingredient_id) REFERENCES ingredients (tenant_id, id)
);

CREATE TABLE recipes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code           text NOT NULL,
  name           text NOT NULL,
  category       text,
  price_net      numeric(12,2) NOT NULL CHECK (price_net >= 0),      -- VAT-exclusive selling price
  packaging_cost numeric(12,4) NOT NULL DEFAULT 0 CHECK (packaging_cost >= 0),
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'archived')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE recipe_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  recipe_id     uuid NOT NULL,
  ingredient_id uuid NOT NULL,
  quantity      numeric(18,4) NOT NULL CHECK (quantity > 0),   -- USABLE quantity in the ingredient base unit
  UNIQUE (recipe_id, ingredient_id),
  FOREIGN KEY (tenant_id, recipe_id) REFERENCES recipes (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, ingredient_id) REFERENCES ingredients (tenant_id, id)
);

-- Plan limit: branches (serialised per tenant so two concurrent inserts cannot both slip under the cap).
CREATE FUNCTION enforce_branches_limit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE _lim integer; _cnt integer;
BEGIN
  IF NOT NEW.is_active THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text, 1));
  _lim := tenant_limit(NEW.tenant_id, 'branches');
  IF _lim IS NULL THEN RAISE EXCEPTION 'no_active_subscription' USING ERRCODE = 'P0001'; END IF;
  SELECT count(*) INTO _cnt FROM branches WHERE tenant_id = NEW.tenant_id AND is_active AND id IS DISTINCT FROM NEW.id;
  IF _cnt >= _lim THEN RAISE EXCEPTION 'plan_limit_reached:branches' USING ERRCODE = 'P0001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER branches_limit BEFORE INSERT OR UPDATE OF is_active ON branches FOR EACH ROW EXECUTE FUNCTION enforce_branches_limit();

DO $$
DECLARE _t text;
BEGIN
  FOREACH _t IN ARRAY ARRAY['units','suppliers','branches','locations','ingredients','stock_levels','stock_movements',
                            'purchase_orders','purchase_items','recipes','recipe_items'] LOOP
    PERFORM enable_tenant_rls(_t::regclass);
  END LOOP;
  FOREACH _t IN ARRAY ARRAY['units','suppliers','branches','locations','ingredients','recipes','recipe_items'] LOOP
    PERFORM grant_app(_t::regclass);
  END LOOP;
  PERFORM grant_app('purchase_orders', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('purchase_items', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('stock_levels', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('stock_movements', 'SELECT, INSERT');            -- append-only ledger
END $$;

-- Keep updated_at honest on every row change.
CREATE TRIGGER suppliers_updated        BEFORE UPDATE ON suppliers        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER branches_updated         BEFORE UPDATE ON branches         FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER locations_updated        BEFORE UPDATE ON locations        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER ingredients_updated      BEFORE UPDATE ON ingredients      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER purchase_orders_updated  BEFORE UPDATE ON purchase_orders  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER recipes_updated          BEFORE UPDATE ON recipes          FOR EACH ROW EXECUTE FUNCTION set_updated_at();
