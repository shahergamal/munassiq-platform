-- 0006: prep (sub) recipes + production, purchase returns, supplier payments (payables), operating expenses.

ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_movement_type_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_movement_type_check
  CHECK (movement_type IN ('purchase', 'sale', 'refund_return', 'transfer_out', 'transfer_in', 'waste', 'count_adjustment',
                           'production_in', 'production_out', 'purchase_return'));

-- A prepared ingredient (sauce, marinated chicken…) is an ingredient produced in-house. Menu recipes use it like any other.
ALTER TABLE ingredients ADD COLUMN is_prepared boolean NOT NULL DEFAULT false;

-- ── Prep recipes & production ─────────────────────────────────────────────────────────────────
CREATE TABLE prep_recipes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ingredient_id   uuid NOT NULL,                                    -- the prepared output
  batch_yield     numeric(18,4) NOT NULL CHECK (batch_yield > 0),   -- output base units produced by ONE batch
  notes           text CHECK (notes IS NULL OR char_length(notes) <= 500),
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, ingredient_id),
  FOREIGN KEY (tenant_id, ingredient_id) REFERENCES ingredients (tenant_id, id)
);
CREATE TRIGGER prep_recipes_updated BEFORE UPDATE ON prep_recipes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE prep_recipe_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  prep_recipe_id uuid NOT NULL,
  ingredient_id  uuid NOT NULL,
  quantity       numeric(18,4) NOT NULL CHECK (quantity > 0),       -- raw base units per batch
  UNIQUE (prep_recipe_id, ingredient_id),
  FOREIGN KEY (tenant_id, prep_recipe_id) REFERENCES prep_recipes (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, ingredient_id) REFERENCES ingredients (tenant_id, id)
);

CREATE TABLE production_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_number      bigint NOT NULL,
  prep_recipe_id  uuid NOT NULL,
  location_id     uuid NOT NULL,
  batches         numeric(10,3) NOT NULL CHECK (batches > 0),
  output_quantity numeric(18,4) NOT NULL CHECK (output_quantity > 0),
  total_cost      numeric(14,4) NOT NULL CHECK (total_cost >= 0),
  unit_cost       numeric(18,6) NOT NULL CHECK (unit_cost >= 0),
  idempotency_key uuid NOT NULL,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, run_number),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, prep_recipe_id) REFERENCES prep_recipes (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id)
);
CREATE TRIGGER production_runs_immutable BEFORE UPDATE OR DELETE ON production_runs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ── Purchase returns ──────────────────────────────────────────────────────────────────────────
CREATE TABLE purchase_returns (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  return_number     bigint NOT NULL,
  supplier_id       uuid NOT NULL,
  location_id       uuid NOT NULL,
  purchase_order_id uuid,
  reason            text NOT NULL CHECK (char_length(trim(reason)) >= 3 AND char_length(reason) <= 300),
  total_value       numeric(14,2) NOT NULL CHECK (total_value >= 0),
  idempotency_key   uuid NOT NULL,
  created_by        uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, return_number),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id),
  FOREIGN KEY (tenant_id, purchase_order_id) REFERENCES purchase_orders (tenant_id, id)
);
CREATE TRIGGER purchase_returns_immutable BEFORE UPDATE OR DELETE ON purchase_returns FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE purchase_return_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  return_id     uuid NOT NULL,
  ingredient_id uuid NOT NULL,
  quantity      numeric(18,4) NOT NULL CHECK (quantity > 0),
  unit_cost     numeric(18,6) NOT NULL CHECK (unit_cost >= 0),
  UNIQUE (return_id, ingredient_id),
  FOREIGN KEY (tenant_id, return_id) REFERENCES purchase_returns (tenant_id, id),
  FOREIGN KEY (tenant_id, ingredient_id) REFERENCES ingredients (tenant_id, id)
);
CREATE TRIGGER purchase_return_items_immutable BEFORE UPDATE OR DELETE ON purchase_return_items FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ── Supplier payments (payables) ──────────────────────────────────────────────────────────────
CREATE TABLE supplier_payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  payment_number  bigint NOT NULL,
  supplier_id     uuid NOT NULL,
  paid_on         date NOT NULL,
  amount          numeric(14,2) NOT NULL CHECK (amount > 0),
  method          text NOT NULL CHECK (method IN ('bank_transfer', 'cash', 'cheque', 'card')),
  reference       text CHECK (reference IS NULL OR char_length(reference) <= 80),
  notes           text CHECK (notes IS NULL OR char_length(notes) <= 500),
  idempotency_key uuid NOT NULL,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, payment_number),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id)
);
CREATE INDEX supplier_payments_supplier_idx ON supplier_payments (tenant_id, supplier_id, paid_on DESC);
CREATE TRIGGER supplier_payments_immutable BEFORE UPDATE OR DELETE ON supplier_payments FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ── Operating expenses ────────────────────────────────────────────────────────────────────────
CREATE TABLE expense_categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (char_length(trim(name)) BETWEEN 2 AND 80),
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE expenses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  expense_number  bigint NOT NULL,
  category_id     uuid NOT NULL,
  branch_id       uuid,
  expense_date    date NOT NULL,
  description     text NOT NULL CHECK (char_length(trim(description)) BETWEEN 3 AND 300),
  amount_net      numeric(14,2) NOT NULL CHECK (amount_net > 0),
  vat_amount      numeric(14,2) NOT NULL DEFAULT 0 CHECK (vat_amount >= 0),
  total           numeric(14,2) NOT NULL CHECK (total > 0),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'paid', 'cancelled')),
  payment_method  text CHECK (payment_method IS NULL OR payment_method IN ('bank_transfer', 'cash', 'cheque', 'card')),
  reference       text CHECK (reference IS NULL OR char_length(reference) <= 80),
  cancel_reason   text,
  idempotency_key uuid NOT NULL,
  created_by      uuid NOT NULL,
  approved_by     uuid,
  approved_at     timestamptz,
  paid_by         uuid,
  paid_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (total = amount_net + vat_amount),
  CHECK (status <> 'paid' OR payment_method IS NOT NULL),
  CHECK (status <> 'cancelled' OR char_length(trim(coalesce(cancel_reason, ''))) >= 3),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, expense_number),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, category_id) REFERENCES expense_categories (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id)
);
CREATE INDEX expenses_list_idx ON expenses (tenant_id, expense_date DESC);
CREATE TRIGGER expenses_updated BEFORE UPDATE ON expenses FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Default categories for tenants that already exist (new tenants get them at creation).
INSERT INTO expense_categories (tenant_id, name)
SELECT t.id, c.name FROM tenants t
CROSS JOIN (VALUES ('الإيجار'), ('الرواتب والأجور'), ('الكهرباء والماء'), ('الغاز'), ('الصيانة'), ('التسويق'), ('النظافة والمستهلكات'), ('رسوم حكومية'), ('عمولات التوصيل'), ('أخرى')) AS c(name)
ON CONFLICT DO NOTHING;

DO $$
DECLARE _t text;
BEGIN
  FOREACH _t IN ARRAY ARRAY['prep_recipes','prep_recipe_items','production_runs','purchase_returns','purchase_return_items','supplier_payments','expense_categories','expenses'] LOOP
    PERFORM enable_tenant_rls(_t::regclass);
  END LOOP;
  PERFORM grant_app('prep_recipes');
  PERFORM grant_app('prep_recipe_items');
  PERFORM grant_app('production_runs', 'SELECT, INSERT');
  PERFORM grant_app('purchase_returns', 'SELECT, INSERT');
  PERFORM grant_app('purchase_return_items', 'SELECT, INSERT');
  PERFORM grant_app('supplier_payments', 'SELECT, INSERT');
  PERFORM grant_app('expense_categories', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('expenses', 'SELECT, INSERT, UPDATE');
END $$;
