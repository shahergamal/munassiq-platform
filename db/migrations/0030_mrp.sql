-- 0030_mrp: material requirements planning (docs/manufacturing/ARCHITECTURE.md, M4).
-- A run is a snapshot: what was needed, why, and what it suggested (make or buy). Suggestions become draft
-- manufacturing or purchase orders by hand; the run itself never changes stock or the ledger.

-- Days from ordering to having the item: the supplier's delivery time for what is bought, the production time for
-- what is made. MRP orders this many days before the need date.
ALTER TABLE ingredients ADD COLUMN lead_time_days integer NOT NULL DEFAULT 0 CHECK (lead_time_days BETWEEN 0 AND 365);

CREATE TABLE mrp_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_number  bigint NOT NULL,
  -- What the run considered (horizon, whether minimum stock is replenished) and its totals.
  params      jsonb NOT NULL,
  summary     jsonb NOT NULL,
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, run_number)
);

CREATE TABLE mrp_suggestions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id        uuid NOT NULL,
  item_id       uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('make', 'buy')),
  level         integer NOT NULL CHECK (level >= 0),
  quantity      numeric(18,4) NOT NULL CHECK (quantity > 0),
  need_date     date NOT NULL,
  order_date    date NOT NULL,
  supplier_id   uuid,
  -- Gross demand by source, stock, scheduled receipts, safety stock: how the quantity was reached.
  explanation   jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'converted', 'dismissed')),
  converted_to  uuid,
  converted_at  timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES mrp_runs (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id) REFERENCES ingredients (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id)
);
CREATE INDEX mrp_suggestions_run_idx ON mrp_suggestions (tenant_id, run_id, kind, level);

DO $$
BEGIN
  PERFORM enable_tenant_rls('mrp_runs'::regclass);
  PERFORM enable_tenant_rls('mrp_suggestions'::regclass);
  PERFORM grant_app('mrp_runs', 'SELECT, INSERT');
  PERFORM grant_app('mrp_suggestions', 'SELECT, INSERT, UPDATE');
END $$;
