-- 0026_manufacturing_orders: production for factory workspaces (docs/manufacturing/ARCHITECTURE.md, M2).
--   work centers (capacity and hourly rates) → bills of materials (versioned: components with expected scrap,
--   phantom sub-assemblies, operations on work centers, by-products with a cost share) → manufacturing orders.
-- An order freezes its BOM at confirmation. Everything it does afterwards (issues, returns, labour, output, scrap,
-- close) is an append-only record that posts its own journal entry, so the order's work in progress always equals
-- what went in minus what came out; closing posts the remainder as a production variance and leaves WIP at zero.
-- The sector opens for sign-up here: production orders are its real implementation.

-- ── Work centers ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE work_centers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code               text NOT NULL CHECK (code ~ '^[A-Za-z0-9-]{1,20}$'),
  name               text NOT NULL CHECK (char_length(trim(name)) BETWEEN 2 AND 120),
  location_id        uuid,
  cost_center_id     uuid,
  hours_per_day      numeric(5,2) NOT NULL DEFAULT 8 CHECK (hours_per_day > 0 AND hours_per_day <= 24),
  -- Rates per hour of operation: direct labour, and overhead (power, depreciation, supervision) absorbed with it.
  labor_rate         numeric(12,4) NOT NULL DEFAULT 0 CHECK (labor_rate >= 0),
  overhead_rate      numeric(12,4) NOT NULL DEFAULT 0 CHECK (overhead_rate >= 0),
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id),
  FOREIGN KEY (tenant_id, cost_center_id) REFERENCES cost_centers (tenant_id, id)
);

-- ── Bills of materials ────────────────────────────────────────────────────────────────────────
CREATE TABLE boms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  item_id     uuid NOT NULL,
  version     integer NOT NULL CHECK (version >= 1),
  -- The batch the lines describe: "these components make 500 kg".
  quantity    numeric(18,4) NOT NULL CHECK (quantity > 0),
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  notes       text CHECK (notes IS NULL OR char_length(notes) <= 1000),
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  activated_by uuid,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, item_id, version),
  FOREIGN KEY (tenant_id, item_id) REFERENCES ingredients (tenant_id, id)
);
-- One active version per item: activating a new one archives the old in the same transaction.
CREATE UNIQUE INDEX boms_one_active ON boms (tenant_id, item_id) WHERE status = 'active';

CREATE TABLE bom_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bom_id        uuid NOT NULL,
  seq           integer NOT NULL,
  component_id  uuid NOT NULL,
  quantity      numeric(18,4) NOT NULL CHECK (quantity > 0),
  -- Expected loss in production: the order issues quantity × (1 + scrap%).
  scrap_percent numeric(6,2) NOT NULL DEFAULT 0 CHECK (scrap_percent >= 0 AND scrap_percent < 100),
  -- A phantom sub-assembly is never stocked: the order explodes it into its own components.
  phantom       boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, bom_id, component_id),
  FOREIGN KEY (tenant_id, bom_id) REFERENCES boms (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, component_id) REFERENCES ingredients (tenant_id, id)
);

CREATE TABLE bom_operations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bom_id         uuid NOT NULL,
  seq            integer NOT NULL,
  name           text NOT NULL CHECK (char_length(trim(name)) BETWEEN 2 AND 120),
  work_center_id uuid NOT NULL,
  setup_minutes  numeric(10,2) NOT NULL DEFAULT 0 CHECK (setup_minutes >= 0),
  -- Minutes for the BOM's whole batch quantity.
  run_minutes    numeric(12,2) NOT NULL DEFAULT 0 CHECK (run_minutes >= 0),
  UNIQUE (tenant_id, bom_id, seq),
  FOREIGN KEY (tenant_id, bom_id) REFERENCES boms (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, work_center_id) REFERENCES work_centers (tenant_id, id)
);

CREATE TABLE bom_byproducts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bom_id          uuid NOT NULL,
  item_id         uuid NOT NULL,
  quantity        numeric(18,4) NOT NULL CHECK (quantity > 0),
  -- Share of the batch cost this by-product carries (the main product carries the rest).
  cost_share      numeric(6,2) NOT NULL DEFAULT 0 CHECK (cost_share >= 0 AND cost_share < 100),
  UNIQUE (tenant_id, bom_id, item_id),
  FOREIGN KEY (tenant_id, bom_id) REFERENCES boms (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id) REFERENCES ingredients (tenant_id, id)
);

-- An active or archived version is history: orders were made from it. Changes need a new version.
CREATE FUNCTION bom_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE _b uuid; _s text;
BEGIN
  _b := CASE WHEN TG_OP = 'DELETE' THEN OLD.bom_id ELSE NEW.bom_id END;
  SELECT status INTO _s FROM boms WHERE id = _b;
  IF _s IS NOT NULL AND _s <> 'draft' THEN RAISE EXCEPTION 'bom_frozen' USING ERRCODE = 'P0001'; END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER bom_lines_frozen BEFORE INSERT OR UPDATE OR DELETE ON bom_lines FOR EACH ROW EXECUTE FUNCTION bom_frozen();
CREATE TRIGGER bom_operations_frozen BEFORE INSERT OR UPDATE OR DELETE ON bom_operations FOR EACH ROW EXECUTE FUNCTION bom_frozen();
CREATE TRIGGER bom_byproducts_frozen BEFORE INSERT OR UPDATE OR DELETE ON bom_byproducts FOR EACH ROW EXECUTE FUNCTION bom_frozen();

-- ── Manufacturing orders ──────────────────────────────────────────────────────────────────────
CREATE TABLE manufacturing_orders (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mo_number          bigint NOT NULL,
  item_id            uuid NOT NULL,
  bom_id             uuid NOT NULL,
  quantity           numeric(18,4) NOT NULL CHECK (quantity > 0),
  -- Components are issued from (and work happens at) the production location; output goes to the output location.
  location_id        uuid NOT NULL,
  output_location_id uuid NOT NULL,
  cost_center_id     uuid,
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'in_progress', 'closed', 'cancelled')),
  planned_start      date,
  due_date           date,
  notes              text CHECK (notes IS NULL OR char_length(notes) <= 1000),
  -- Frozen at confirmation (BOM cost roll-up): the value of one good unit of output.
  standard_unit_cost numeric(18,6),
  produced_quantity  numeric(18,4) NOT NULL DEFAULT 0 CHECK (produced_quantity >= 0),
  idempotency_key    uuid NOT NULL,
  created_by         uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  confirmed_at       timestamptz,
  confirmed_by       uuid,
  closed_at          timestamptz,
  closed_by          uuid,
  cancelled_at       timestamptz,
  cancel_reason      text,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, mo_number),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, item_id) REFERENCES ingredients (tenant_id, id),
  FOREIGN KEY (tenant_id, bom_id) REFERENCES boms (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id),
  FOREIGN KEY (tenant_id, output_location_id) REFERENCES locations (tenant_id, id),
  FOREIGN KEY (tenant_id, cost_center_id) REFERENCES cost_centers (tenant_id, id),
  CHECK (status = 'draft' OR status = 'cancelled' OR standard_unit_cost IS NOT NULL)
);
CREATE INDEX manufacturing_orders_status_idx ON manufacturing_orders (tenant_id, status, created_at DESC);

-- The plan frozen at confirmation (BOM exploded through phantoms).
CREATE TABLE mo_components (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mo_id         uuid NOT NULL,
  component_id  uuid NOT NULL,
  required_qty  numeric(18,4) NOT NULL CHECK (required_qty > 0),
  standard_cost numeric(18,6) NOT NULL DEFAULT 0 CHECK (standard_cost >= 0),
  UNIQUE (tenant_id, mo_id, component_id),
  FOREIGN KEY (tenant_id, mo_id) REFERENCES manufacturing_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, component_id) REFERENCES ingredients (tenant_id, id)
);
CREATE TABLE mo_operations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mo_id           uuid NOT NULL,
  seq             integer NOT NULL,
  name            text NOT NULL,
  work_center_id  uuid NOT NULL,
  planned_minutes numeric(12,2) NOT NULL CHECK (planned_minutes >= 0),
  labor_rate      numeric(12,4) NOT NULL,
  overhead_rate   numeric(12,4) NOT NULL,
  UNIQUE (tenant_id, mo_id, seq),
  FOREIGN KEY (tenant_id, mo_id) REFERENCES manufacturing_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, work_center_id) REFERENCES work_centers (tenant_id, id)
);
CREATE TABLE mo_byproducts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mo_id       uuid NOT NULL,
  item_id     uuid NOT NULL,
  -- Expected per unit of main output, and the value of one unit at standard.
  per_unit    numeric(18,6) NOT NULL CHECK (per_unit > 0),
  unit_cost   numeric(18,6) NOT NULL CHECK (unit_cost >= 0),
  UNIQUE (tenant_id, mo_id, item_id),
  FOREIGN KEY (tenant_id, mo_id) REFERENCES manufacturing_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES ingredients (tenant_id, id)
);

-- What happened (append-only; each row posts one journal entry). `value` is exact money (halalas).
CREATE TABLE mo_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mo_id           uuid NOT NULL,
  event_number    bigint NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('issue', 'return', 'labor', 'output', 'close')),
  -- issue/return: components with quantity, unit cost and batches; labor: operation, minutes, rates;
  -- output: good quantity, scrap, batch, by-products. Shape per kind is written by routes/manufacturing.
  detail          jsonb NOT NULL DEFAULT '{}',
  -- Effect on the order's work in progress: + issue and labour, − return, output, abnormal scrap, close.
  wip_delta       numeric(14,2) NOT NULL,
  idempotency_key uuid NOT NULL,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, mo_id) REFERENCES manufacturing_orders (tenant_id, id)
);
CREATE INDEX mo_events_mo_idx ON mo_events (tenant_id, mo_id, created_at);
CREATE TRIGGER mo_events_append_only BEFORE UPDATE OR DELETE ON mo_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- The frozen plan never changes after confirmation.
CREATE FUNCTION mo_plan_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'mo_plan_frozen' USING ERRCODE = 'P0001'; END $$;
CREATE TRIGGER mo_components_frozen BEFORE UPDATE OR DELETE ON mo_components FOR EACH ROW EXECUTE FUNCTION mo_plan_frozen();
CREATE TRIGGER mo_operations_frozen BEFORE UPDATE OR DELETE ON mo_operations FOR EACH ROW EXECUTE FUNCTION mo_plan_frozen();
CREATE TRIGGER mo_byproducts_frozen BEFORE UPDATE OR DELETE ON mo_byproducts FOR EACH ROW EXECUTE FUNCTION mo_plan_frozen();

-- A closed or cancelled order is final.
CREATE FUNCTION mo_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('closed', 'cancelled') THEN RAISE EXCEPTION 'mo_final' USING ERRCODE = 'P0001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER manufacturing_orders_final BEFORE UPDATE ON manufacturing_orders FOR EACH ROW EXECUTE FUNCTION mo_final();

-- Production batches may come from an order.
ALTER TABLE stock_batches DROP CONSTRAINT stock_batches_source_type_check;
ALTER TABLE stock_batches ADD CONSTRAINT stock_batches_source_type_check CHECK (source_type IN ('goods_receipt', 'transfer', 'production', 'opening', 'manufacturing'));

DO $$
BEGIN
  PERFORM enable_tenant_rls('work_centers'::regclass);
  PERFORM enable_tenant_rls('boms'::regclass);
  PERFORM enable_tenant_rls('bom_lines'::regclass);
  PERFORM enable_tenant_rls('bom_operations'::regclass);
  PERFORM enable_tenant_rls('bom_byproducts'::regclass);
  PERFORM enable_tenant_rls('manufacturing_orders'::regclass);
  PERFORM enable_tenant_rls('mo_components'::regclass);
  PERFORM enable_tenant_rls('mo_operations'::regclass);
  PERFORM enable_tenant_rls('mo_byproducts'::regclass);
  PERFORM enable_tenant_rls('mo_events'::regclass);
  PERFORM grant_app('work_centers', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('boms', 'SELECT, INSERT, UPDATE, DELETE');
  PERFORM grant_app('bom_lines', 'SELECT, INSERT, UPDATE, DELETE');
  PERFORM grant_app('bom_operations', 'SELECT, INSERT, UPDATE, DELETE');
  PERFORM grant_app('bom_byproducts', 'SELECT, INSERT, UPDATE, DELETE');
  PERFORM grant_app('manufacturing_orders', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('mo_components', 'SELECT, INSERT');
  PERFORM grant_app('mo_operations', 'SELECT, INSERT');
  PERFORM grant_app('mo_byproducts', 'SELECT, INSERT');
  PERFORM grant_app('mo_events', 'SELECT, INSERT');
END $$;

-- The sector has its real implementation now: sign-up may choose it.
UPDATE sectors SET is_available = true WHERE key = 'manufacturing';
