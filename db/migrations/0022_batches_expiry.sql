-- Batch (lot) tracking and expiry dates, first-expiry-first-out.
--
--   An ingredient that tracks expiry gets a batch for every quantity that enters a location with a known date:
--   a goods receipt line (batch number + expiry from the supplier label), a received transfer (the source batches
--   travel with their dates), a production run (today + the item's shelf life), or stock already on hand registered
--   by hand ("opening"). Batches are a layer ON TOP of stock_levels, which stays the single source of quantity and
--   weighted-average cost (the ledger and the accounting do not change).
--
--   Invariant: for every (location, ingredient), the sum of batch remainders never exceeds the level. One trigger on
--   stock_levels keeps it on EVERY path that lowers stock (sale, waste, transfer, production, stocktake, purchase
--   return): stock without a batch (from before tracking, or a count gain) goes first, then batches by earliest
--   expiry. Each consumption is logged, so a transfer can carry the exact batches it took to its destination and a
--   batch can be traced for a recall. A disposal targets its batch explicitly before the stock is taken.

-- ── Settings on the item (each one is read by the code) ────────────────────────────
-- track_expiry: receiving requires an expiry date per line. shelf_life_days: the default expiry at receipt and the
-- expiry of what a production run makes.
ALTER TABLE ingredients
  ADD COLUMN track_expiry boolean NOT NULL DEFAULT false,
  ADD COLUMN shelf_life_days integer CHECK (shelf_life_days IS NULL OR shelf_life_days BETWEEN 1 AND 3650);

-- ── Batches ─────────────────────────────────────────────────────────────────────────
CREATE TABLE stock_batches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id      uuid NOT NULL,
  ingredient_id    uuid NOT NULL,
  batch_no         text NOT NULL CHECK (char_length(batch_no) BETWEEN 1 AND 60),
  expiry_date      date,
  production_date  date,
  quantity         numeric(18,4) NOT NULL CHECK (quantity > 0),
  remaining        numeric(18,4) NOT NULL CHECK (remaining >= 0),
  unit_cost        numeric(18,6) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  source_type      text NOT NULL CHECK (source_type IN ('goods_receipt', 'transfer', 'production', 'opening')),
  source_id        uuid,
  supplier_id      uuid,
  parent_batch_id  uuid,
  received_at      timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (remaining <= quantity),
  CHECK (production_date IS NULL OR expiry_date IS NULL OR production_date <= expiry_date),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id),
  FOREIGN KEY (tenant_id, ingredient_id) REFERENCES ingredients (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_batch_id) REFERENCES stock_batches (tenant_id, id)
);
CREATE INDEX stock_batches_open_idx ON stock_batches (tenant_id, location_id, ingredient_id, expiry_date) WHERE remaining > 0;
CREATE INDEX stock_batches_expiry_idx ON stock_batches (tenant_id, expiry_date) WHERE remaining > 0;
CREATE INDEX stock_batches_source_idx ON stock_batches (tenant_id, source_type, source_id);

-- A batch's identity never changes and its remainder only goes down (stock returns re-enter without a batch).
CREATE FUNCTION stock_batches_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'stock batches are never deleted' USING ERRCODE = 'P0001'; END IF;
  IF (NEW.tenant_id, NEW.location_id, NEW.ingredient_id, NEW.batch_no, NEW.quantity, NEW.source_type) IS DISTINCT FROM
     (OLD.tenant_id, OLD.location_id, OLD.ingredient_id, OLD.batch_no, OLD.quantity, OLD.source_type)
     OR NEW.expiry_date IS DISTINCT FROM OLD.expiry_date OR NEW.source_id IS DISTINCT FROM OLD.source_id OR NEW.unit_cost <> OLD.unit_cost THEN
    RAISE EXCEPTION 'a stock batch can only be consumed' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.remaining > OLD.remaining THEN RAISE EXCEPTION 'a stock batch cannot grow back' USING ERRCODE = 'P0001'; END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER stock_batches_guard BEFORE UPDATE OR DELETE ON stock_batches FOR EACH ROW EXECUTE FUNCTION stock_batches_guard();

-- ── Consumption log (append-only) ────────────────────────────────────────────────────
CREATE TABLE stock_batch_consumptions (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  batch_id    uuid NOT NULL,
  quantity    numeric(18,4) NOT NULL CHECK (quantity > 0),
  reason      text NOT NULL DEFAULT 'fefo' CHECK (reason IN ('fefo', 'targeted')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES stock_batches (tenant_id, id)
);
CREATE INDEX stock_batch_consumptions_batch_idx ON stock_batch_consumptions (tenant_id, batch_id, id);
CREATE TRIGGER stock_batch_consumptions_immutable BEFORE UPDATE OR DELETE ON stock_batch_consumptions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Keeps batches within the level whenever stock goes down, by any path. Runs with the caller's rights and RLS.
CREATE FUNCTION stock_batches_follow_level() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE _excess numeric; _b record; _take numeric;
BEGIN
  IF NEW.quantity >= OLD.quantity THEN RETURN NEW; END IF;
  SELECT coalesce(sum(remaining), 0) - greatest(NEW.quantity, 0) INTO _excess
    FROM stock_batches WHERE location_id = NEW.location_id AND ingredient_id = NEW.ingredient_id AND remaining > 0;
  IF _excess <= 0 THEN RETURN NEW; END IF;
  FOR _b IN SELECT id, remaining FROM stock_batches
             WHERE location_id = NEW.location_id AND ingredient_id = NEW.ingredient_id AND remaining > 0
             ORDER BY expiry_date NULLS LAST, received_at, id FOR UPDATE LOOP
    EXIT WHEN _excess <= 0;
    _take := least(_b.remaining, _excess);
    UPDATE stock_batches SET remaining = remaining - _take WHERE id = _b.id;
    INSERT INTO stock_batch_consumptions (tenant_id, batch_id, quantity) VALUES (NEW.tenant_id, _b.id, _take);
    _excess := _excess - _take;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_levels_batches AFTER UPDATE OF quantity ON stock_levels FOR EACH ROW EXECUTE FUNCTION stock_batches_follow_level();

-- ── Where batches come from and go ───────────────────────────────────────────────────
-- The supplier label as received (goods_receipt_items stays append-only: these are set on insert).
ALTER TABLE goods_receipt_items
  ADD COLUMN batch_no text CHECK (batch_no IS NULL OR char_length(batch_no) BETWEEN 1 AND 60),
  ADD COLUMN expiry_date date,
  ADD COLUMN production_date date;
-- The batches a transfer took from its source, carried to the destination on receipt.
ALTER TABLE stock_transfer_items ADD COLUMN batches jsonb NOT NULL DEFAULT '[]';
-- A disposal of one batch (expired, recalled).
ALTER TABLE waste_items ADD COLUMN batch_id uuid;
ALTER TABLE waste_items ADD CONSTRAINT waste_items_batch_fk FOREIGN KEY (tenant_id, batch_id) REFERENCES stock_batches (tenant_id, id);

DO $$
BEGIN
  PERFORM enable_tenant_rls('stock_batches'::regclass);
  PERFORM enable_tenant_rls('stock_batch_consumptions'::regclass);
  PERFORM grant_app('stock_batches', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('stock_batch_consumptions', 'SELECT, INSERT');
  EXECUTE 'GRANT USAGE ON SEQUENCE stock_batch_consumptions_id_seq TO munassiq_app';
END $$;
