-- 0031_quality_maintenance: quality control and preventive maintenance for factories (ARCHITECTURE.md, M5).
--   Quality: inspection plans per item and stage, inspections with measured results and a decision, holding a batch
--   by moving it to a quarantine location (nothing issues or delivers from there), non-conformance reports.
--   Maintenance: machines on work centers, preventive plans by time or meter, maintenance orders with spare parts
--   issued from stock (posted to maintenance expense) and downtime (MTBF / MTTR, and less capacity in the schedule).

-- A quarantine location: stock there is on hold until quality releases it.
ALTER TABLE locations DROP CONSTRAINT locations_location_type_check;
ALTER TABLE locations ADD CONSTRAINT locations_location_type_check CHECK (location_type IN ('kitchen', 'warehouse', 'store', 'quarantine'));

-- ── Quality ───────────────────────────────────────────────────────────────────────────────────
CREATE TABLE qc_plans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  item_id         uuid NOT NULL,
  stage           text NOT NULL CHECK (stage IN ('receipt', 'production')),
  name            text NOT NULL CHECK (char_length(trim(name)) BETWEEN 2 AND 120),
  -- [{ name, kind: "numeric" | "check", min?, max?, unit? }]: what is measured and its acceptance range.
  characteristics jsonb NOT NULL CHECK (jsonb_typeof(characteristics) = 'array' AND jsonb_array_length(characteristics) BETWEEN 1 AND 40),
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES ingredients (tenant_id, id)
);
CREATE UNIQUE INDEX qc_plans_one_active ON qc_plans (tenant_id, item_id, stage) WHERE is_active;

CREATE TABLE qc_inspections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  inspection_number bigint NOT NULL,
  plan_id           uuid NOT NULL,
  item_id           uuid NOT NULL,
  -- The lot inspected (a receipt of an item without batches has none: it cannot be held, only recorded).
  batch_id          uuid,
  -- Where the lot came from: a goods receipt or a production order's output event.
  source_type       text NOT NULL CHECK (source_type IN ('goods_receipt', 'mo_event', 'manual')),
  source_id         uuid,
  -- [{ name, value, pass }] against the plan's characteristics.
  results           jsonb NOT NULL,
  decision          text NOT NULL CHECK (decision IN ('accepted', 'on_hold', 'rejected')),
  quantity          numeric(18,4) NOT NULL CHECK (quantity > 0),
  notes             text CHECK (notes IS NULL OR char_length(notes) <= 1000),
  idempotency_key   uuid NOT NULL,
  inspected_by      uuid NOT NULL,
  inspected_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, inspection_number),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, plan_id) REFERENCES qc_plans (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES ingredients (tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES stock_batches (tenant_id, id)
);
CREATE INDEX qc_inspections_batch_idx ON qc_inspections (tenant_id, batch_id);
CREATE TRIGGER qc_inspections_append_only BEFORE UPDATE OR DELETE ON qc_inspections FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- A batch's quality state is its latest decision (held batches sit in a quarantine location).
CREATE TABLE qc_releases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  batch_id      uuid NOT NULL,
  action        text NOT NULL CHECK (action IN ('hold', 'release')),
  from_location uuid NOT NULL,
  to_location   uuid NOT NULL,
  quantity      numeric(18,4) NOT NULL CHECK (quantity > 0),
  new_batch_id  uuid NOT NULL,
  reason        text NOT NULL CHECK (char_length(trim(reason)) BETWEEN 3 AND 300),
  inspection_id uuid,
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES stock_batches (tenant_id, id),
  FOREIGN KEY (tenant_id, new_batch_id) REFERENCES stock_batches (tenant_id, id),
  FOREIGN KEY (tenant_id, inspection_id) REFERENCES qc_inspections (tenant_id, id)
);
CREATE TRIGGER qc_releases_append_only BEFORE UPDATE OR DELETE ON qc_releases FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE ncrs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ncr_number    bigint NOT NULL,
  item_id       uuid NOT NULL,
  batch_id      uuid,
  inspection_id uuid,
  supplier_id   uuid,
  quantity      numeric(18,4) CHECK (quantity IS NULL OR quantity > 0),
  description   text NOT NULL CHECK (char_length(trim(description)) BETWEEN 5 AND 1000),
  -- What is done with it: rework, scrap, return to the supplier, use as is (concession).
  disposition   text CHECK (disposition IS NULL OR disposition IN ('rework', 'scrap', 'return_to_supplier', 'use_as_is')),
  root_cause    text CHECK (root_cause IS NULL OR char_length(root_cause) <= 1000),
  corrective_action text CHECK (corrective_action IS NULL OR char_length(corrective_action) <= 1000),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  closed_by     uuid,
  closed_at     timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, ncr_number),
  CHECK (status = 'open' OR (disposition IS NOT NULL AND closed_at IS NOT NULL)),
  FOREIGN KEY (tenant_id, item_id) REFERENCES ingredients (tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES stock_batches (tenant_id, id),
  FOREIGN KEY (tenant_id, inspection_id) REFERENCES qc_inspections (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id)
);

-- ── Maintenance ───────────────────────────────────────────────────────────────────────────────
CREATE TABLE machines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code           text NOT NULL CHECK (code ~ '^[A-Za-z0-9-]{1,20}$'),
  name           text NOT NULL CHECK (char_length(trim(name)) BETWEEN 2 AND 120),
  work_center_id uuid,
  serial_no      text CHECK (serial_no IS NULL OR char_length(serial_no) <= 60),
  meter_unit     text CHECK (meter_unit IS NULL OR char_length(meter_unit) <= 20),
  meter_reading  numeric(14,2) NOT NULL DEFAULT 0 CHECK (meter_reading >= 0),
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, work_center_id) REFERENCES work_centers (tenant_id, id)
);

CREATE TABLE maintenance_plans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  machine_id      uuid NOT NULL,
  name            text NOT NULL CHECK (char_length(trim(name)) BETWEEN 2 AND 120),
  trigger_kind    text NOT NULL CHECK (trigger_kind IN ('days', 'meter')),
  interval_value  numeric(12,2) NOT NULL CHECK (interval_value > 0),
  planned_minutes integer NOT NULL DEFAULT 60 CHECK (planned_minutes BETWEEN 1 AND 10000),
  tasks           text CHECK (tasks IS NULL OR char_length(tasks) <= 2000),
  -- [{ itemId, quantity }] spare parts a service normally uses.
  parts           jsonb NOT NULL DEFAULT '[]',
  last_done_on    date,
  last_meter      numeric(14,2),
  is_active       boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, machine_id) REFERENCES machines (tenant_id, id)
);

CREATE TABLE maintenance_orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_number     bigint NOT NULL,
  machine_id       uuid NOT NULL,
  plan_id          uuid,
  kind             text NOT NULL CHECK (kind IN ('preventive', 'corrective')),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  due_date         date NOT NULL,
  planned_minutes  integer NOT NULL DEFAULT 60 CHECK (planned_minutes BETWEEN 1 AND 10000),
  description      text NOT NULL CHECK (char_length(trim(description)) BETWEEN 3 AND 1000),
  -- Corrective: when the machine stopped. Done: when it ran again, what was found, parts used and their cost.
  failed_at        timestamptz,
  completed_at     timestamptz,
  downtime_minutes integer CHECK (downtime_minutes IS NULL OR downtime_minutes >= 0),
  meter_at_service numeric(14,2),
  findings         text CHECK (findings IS NULL OR char_length(findings) <= 2000),
  parts            jsonb NOT NULL DEFAULT '[]',
  parts_cost       numeric(14,2) NOT NULL DEFAULT 0 CHECK (parts_cost >= 0),
  location_id      uuid,
  idempotency_key  uuid NOT NULL,
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_by     uuid,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, order_number),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, machine_id) REFERENCES machines (tenant_id, id),
  FOREIGN KEY (tenant_id, plan_id) REFERENCES maintenance_plans (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id)
);
CREATE INDEX maintenance_orders_open_idx ON maintenance_orders (tenant_id, status, due_date);
-- A finished or cancelled order is history.
CREATE FUNCTION maintenance_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'open' THEN RAISE EXCEPTION 'maintenance_final' USING ERRCODE = 'P0001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER maintenance_orders_final BEFORE UPDATE ON maintenance_orders FOR EACH ROW EXECUTE FUNCTION maintenance_final();

-- Spare parts leave stock into maintenance expense: the existing "الصيانة والإصلاح" account gets a system key.
UPDATE accounts SET system_key = 'maintenance_expense' WHERE code = '6107' AND system_key IS NULL;

ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_movement_type_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_movement_type_check
  CHECK (movement_type IN ('purchase', 'sale', 'refund_return', 'transfer_out', 'transfer_in', 'waste', 'count_adjustment',
                           'production_in', 'production_out', 'purchase_return', 'delivery', 'customer_return', 'maintenance'));

DO $$
BEGIN
  PERFORM enable_tenant_rls('qc_plans'::regclass);
  PERFORM enable_tenant_rls('qc_inspections'::regclass);
  PERFORM enable_tenant_rls('qc_releases'::regclass);
  PERFORM enable_tenant_rls('ncrs'::regclass);
  PERFORM enable_tenant_rls('machines'::regclass);
  PERFORM enable_tenant_rls('maintenance_plans'::regclass);
  PERFORM enable_tenant_rls('maintenance_orders'::regclass);
  PERFORM grant_app('qc_plans', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('qc_inspections', 'SELECT, INSERT');
  PERFORM grant_app('qc_releases', 'SELECT, INSERT');
  PERFORM grant_app('ncrs', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('machines', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('maintenance_plans', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('maintenance_orders', 'SELECT, INSERT, UPDATE');
END $$;
