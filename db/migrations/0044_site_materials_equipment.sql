-- 0044_site_materials_equipment: site stores, material issues, local content and equipment (docs/contracting/ARCHITECTURE.md, C7).
--   * A site store is a location of type site tied to a project; transfers from the central store are the existing ones.
--   * A site issue takes materials out to the project (on its WBS element and cost code), a return brings them back;
--     each line may name the BOQ item it served, for consumption against the BOQ's theoretical quantities (norms).
--   * Local content: a mandatory-list flag and the product's certificate (number, percentage, validity) on the item.
--   * Equipment reuses the machines register (maintenance included) with its ownership and internal hourly rate;
--     a daily timesheet per machine charges its hours to a project.

ALTER TABLE locations DROP CONSTRAINT locations_location_type_check;
ALTER TABLE locations ADD CONSTRAINT locations_location_type_check CHECK (location_type IN ('kitchen', 'warehouse', 'store', 'quarantine', 'site'));
ALTER TABLE locations ADD COLUMN project_id uuid, ADD FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id),
  ADD CONSTRAINT locations_site_project CHECK ((location_type = 'site') = (project_id IS NOT NULL));

ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_movement_type_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_movement_type_check
  CHECK (movement_type IN ('purchase', 'sale', 'refund_return', 'transfer_out', 'transfer_in', 'waste', 'count_adjustment',
                           'production_in', 'production_out', 'purchase_return', 'delivery', 'customer_return', 'maintenance', 'site_issue', 'site_return'));

ALTER TABLE ingredients
  ADD COLUMN mandatory_list boolean NOT NULL DEFAULT false,
  ADD COLUMN lc_certificate text CHECK (lc_certificate IS NULL OR char_length(trim(lc_certificate)) BETWEEN 1 AND 60),
  ADD COLUMN lc_pct numeric(5,2) CHECK (lc_pct IS NULL OR lc_pct BETWEEN 0 AND 100),
  ADD COLUMN lc_valid_to date,
  ADD CONSTRAINT ingredients_lc_ck CHECK ((lc_certificate IS NULL) = (lc_pct IS NULL));

CREATE TABLE site_issues (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number          bigint NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('issue', 'return')),
  project_id      uuid NOT NULL,
  location_id     uuid NOT NULL,
  issued_on       date NOT NULL,
  wbs_id          uuid,
  cost_code_id    uuid,
  notes           text CHECK (notes IS NULL OR char_length(notes) <= 500),
  idempotency_key uuid NOT NULL,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id),
  FOREIGN KEY (tenant_id, wbs_id) REFERENCES wbs_nodes (tenant_id, id),
  FOREIGN KEY (tenant_id, cost_code_id) REFERENCES cost_codes (tenant_id, id)
);
CREATE TABLE site_issue_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  issue_id      uuid NOT NULL,
  ingredient_id uuid NOT NULL,
  quantity      numeric(18,4) NOT NULL CHECK (quantity > 0),
  unit_cost     numeric(18,6) NOT NULL CHECK (unit_cost >= 0),
  boq_item_id   uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, issue_id) REFERENCES site_issues (tenant_id, id),
  FOREIGN KEY (tenant_id, ingredient_id) REFERENCES ingredients (tenant_id, id),
  FOREIGN KEY (tenant_id, boq_item_id) REFERENCES boq_items (tenant_id, id)
);
CREATE TRIGGER site_issues_append_only BEFORE UPDATE OR DELETE ON site_issues FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER site_issue_lines_append_only BEFORE UPDATE OR DELETE ON site_issue_lines FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Theoretical material per unit of a BOQ item (from the tender's build-up, or entered).
CREATE TABLE boq_item_norms (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  boq_item_id   uuid NOT NULL,
  ingredient_id uuid NOT NULL,
  qty_per_unit  numeric(18,6) NOT NULL CHECK (qty_per_unit > 0),
  PRIMARY KEY (tenant_id, boq_item_id, ingredient_id),
  FOREIGN KEY (tenant_id, boq_item_id) REFERENCES boq_items (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, ingredient_id) REFERENCES ingredients (tenant_id, id)
);

ALTER TABLE machines
  ADD COLUMN ownership text NOT NULL DEFAULT 'owned' CHECK (ownership IN ('owned', 'rented', 'subcontractor')),
  -- The internal rate charged to projects per operating hour (idle hours at the idle share of it).
  ADD COLUMN hourly_rate numeric(12,2) NOT NULL DEFAULT 0 CHECK (hourly_rate >= 0),
  ADD COLUMN idle_rate_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (idle_rate_pct BETWEEN 0 AND 100);

CREATE TABLE equipment_timesheets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  machine_id      uuid NOT NULL,
  project_id      uuid NOT NULL,
  work_date       date NOT NULL,
  operating_hours numeric(5,2) NOT NULL DEFAULT 0 CHECK (operating_hours BETWEEN 0 AND 24),
  idle_hours      numeric(5,2) NOT NULL DEFAULT 0 CHECK (idle_hours BETWEEN 0 AND 24),
  breakdown_hours numeric(5,2) NOT NULL DEFAULT 0 CHECK (breakdown_hours BETWEEN 0 AND 24),
  fuel_liters     numeric(10,2) NOT NULL DEFAULT 0 CHECK (fuel_liters >= 0),
  wbs_id          uuid,
  hourly_rate     numeric(12,2) NOT NULL,
  idle_rate_pct   numeric(5,2) NOT NULL,
  amount          numeric(14,2) NOT NULL CHECK (amount >= 0),
  notes           text CHECK (notes IS NULL OR char_length(notes) <= 300),
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  -- A machine works in one place a day.
  UNIQUE (tenant_id, machine_id, work_date),
  CHECK (operating_hours + idle_hours + breakdown_hours <= 24),
  FOREIGN KEY (tenant_id, machine_id) REFERENCES machines (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id),
  FOREIGN KEY (tenant_id, wbs_id) REFERENCES wbs_nodes (tenant_id, id)
);
CREATE TRIGGER equipment_timesheets_append_only BEFORE UPDATE OR DELETE ON equipment_timesheets FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DO $$
DECLARE _t text;
BEGIN
  FOREACH _t IN ARRAY ARRAY['site_issues', 'site_issue_lines', 'boq_item_norms', 'equipment_timesheets'] LOOP
    PERFORM enable_tenant_rls(_t::regclass);
  END LOOP;
  PERFORM grant_app('site_issues', 'SELECT, INSERT');
  PERFORM grant_app('site_issue_lines', 'SELECT, INSERT');
  PERFORM grant_app('boq_item_norms', 'SELECT, INSERT, UPDATE, DELETE');
  PERFORM grant_app('equipment_timesheets', 'SELECT, INSERT');
END $$;
