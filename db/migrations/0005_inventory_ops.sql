-- 0005_inventory_ops: transfers between locations, waste, and physical stocktakes.
-- Every stock change still goes through stock_movements (append-only), at the weighted-average cost of the moment.

ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_movement_type_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_movement_type_check
  CHECK (movement_type IN ('purchase', 'sale', 'refund_return', 'transfer_out', 'transfer_in', 'waste', 'count_adjustment'));
CREATE INDEX stock_movements_ingredient_idx ON stock_movements (tenant_id, ingredient_id, created_at DESC);

-- ── Transfers ─────────────────────────────────────────────────────────────────────────────────
CREATE TABLE stock_transfers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  transfer_number  bigint NOT NULL,
  from_location_id uuid NOT NULL,
  to_location_id   uuid NOT NULL,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'completed', 'cancelled')),
  notes            text CHECK (notes IS NULL OR char_length(notes) <= 500),
  idempotency_key  uuid NOT NULL,
  created_by       uuid NOT NULL,
  completed_by     uuid,
  completed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (from_location_id <> to_location_id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, transfer_number),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, from_location_id) REFERENCES locations (tenant_id, id),
  FOREIGN KEY (tenant_id, to_location_id) REFERENCES locations (tenant_id, id)
);
CREATE INDEX stock_transfers_list_idx ON stock_transfers (tenant_id, created_at DESC);
CREATE TRIGGER stock_transfers_updated BEFORE UPDATE ON stock_transfers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE stock_transfer_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  transfer_id   uuid NOT NULL,
  ingredient_id uuid NOT NULL,
  quantity      numeric(18,4) NOT NULL CHECK (quantity > 0),   -- base units
  unit_cost     numeric(18,6),                                 -- source weighted-average cost, set on completion
  UNIQUE (transfer_id, ingredient_id),
  FOREIGN KEY (tenant_id, transfer_id) REFERENCES stock_transfers (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, ingredient_id) REFERENCES ingredients (tenant_id, id)
);

-- ── Waste (posted immediately, never edited) ──────────────────────────────────────────────────
CREATE TABLE waste_records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  waste_number    bigint NOT NULL,
  location_id     uuid NOT NULL,
  reason          text NOT NULL CHECK (reason IN ('expired', 'spoiled', 'damaged', 'prep_error', 'overproduction', 'other')),
  notes           text CHECK (notes IS NULL OR char_length(notes) <= 500),
  total_cost      numeric(14,4) NOT NULL CHECK (total_cost >= 0),
  idempotency_key uuid NOT NULL,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, waste_number),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id),
  CHECK (reason <> 'other' OR char_length(trim(coalesce(notes, ''))) >= 3)
);
CREATE INDEX waste_records_list_idx ON waste_records (tenant_id, created_at DESC);
CREATE TRIGGER waste_records_immutable BEFORE UPDATE OR DELETE ON waste_records FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE waste_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  waste_id      uuid NOT NULL,
  ingredient_id uuid NOT NULL,
  quantity      numeric(18,4) NOT NULL CHECK (quantity > 0),
  unit_cost     numeric(18,6) NOT NULL CHECK (unit_cost >= 0),
  UNIQUE (waste_id, ingredient_id),
  FOREIGN KEY (tenant_id, waste_id) REFERENCES waste_records (tenant_id, id),
  FOREIGN KEY (tenant_id, ingredient_id) REFERENCES ingredients (tenant_id, id)
);
CREATE TRIGGER waste_items_immutable BEFORE UPDATE OR DELETE ON waste_items FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ── Stocktakes ────────────────────────────────────────────────────────────────────────────────
CREATE TABLE stocktakes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  count_number   bigint NOT NULL,
  location_id    uuid NOT NULL,
  status         text NOT NULL DEFAULT 'counting' CHECK (status IN ('counting', 'posted', 'cancelled')),
  notes          text CHECK (notes IS NULL OR char_length(notes) <= 500),
  variance_value numeric(14,4),
  created_by     uuid NOT NULL,
  posted_by      uuid,
  posted_at      timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, count_number),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id)
);
-- One open count per location, so two sheets cannot both overwrite the same stock.
CREATE UNIQUE INDEX stocktakes_one_open_uq ON stocktakes (tenant_id, location_id) WHERE status = 'counting';
CREATE TRIGGER stocktakes_updated BEFORE UPDATE ON stocktakes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE stocktake_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  stocktake_id  uuid NOT NULL,
  ingredient_id uuid NOT NULL,
  counted_qty   numeric(18,4) CHECK (counted_qty IS NULL OR counted_qty >= 0),  -- NULL = not counted, left unchanged
  system_qty    numeric(18,4),                                                  -- snapshot at posting time
  unit_cost     numeric(18,6),
  UNIQUE (stocktake_id, ingredient_id),
  FOREIGN KEY (tenant_id, stocktake_id) REFERENCES stocktakes (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, ingredient_id) REFERENCES ingredients (tenant_id, id)
);

DO $$
DECLARE _t text;
BEGIN
  FOREACH _t IN ARRAY ARRAY['stock_transfers','stock_transfer_items','waste_records','waste_items','stocktakes','stocktake_items'] LOOP
    PERFORM enable_tenant_rls(_t::regclass);
  END LOOP;
  PERFORM grant_app('stock_transfers', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('stock_transfer_items', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('waste_records', 'SELECT, INSERT');
  PERFORM grant_app('waste_items', 'SELECT, INSERT');
  PERFORM grant_app('stocktakes', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('stocktake_items', 'SELECT, INSERT, UPDATE');
END $$;
