-- 0042_contract_revenue: revenue over time on construction contracts (docs/contracting/ARCHITECTURE.md, C5).
--   * The workspace's policy for measuring progress (read by the monthly close): output (work certified) or input
--     (cost to date / estimated total cost).
--   * The estimated total cost of a main contract, dated revisions (the latest applies at a close).
--   * The monthly close of a contract: the figures it used and the position it booked (contract asset or liability,
--     onerous provision). Append-only; periods close in order.

ALTER TABLE tenant_settings ADD COLUMN revenue_method text NOT NULL DEFAULT 'output' CHECK (revenue_method IN ('output', 'input'));

CREATE TABLE contract_estimates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contract_id    uuid NOT NULL,
  estimated_cost numeric(16,2) NOT NULL CHECK (estimated_cost > 0),
  as_of          date NOT NULL,
  note           text CHECK (note IS NULL OR char_length(note) <= 500),
  created_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES contracts (tenant_id, id)
);

CREATE TABLE contract_closes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contract_id       uuid NOT NULL,
  period            text NOT NULL CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  method            text NOT NULL CHECK (method IN ('output', 'input')),
  transaction_price numeric(16,2) NOT NULL,
  estimated_cost    numeric(16,2),
  cost_to_date      numeric(16,2) NOT NULL,
  certified_to_date numeric(16,2) NOT NULL,
  billed_to_date    numeric(16,2) NOT NULL,
  pct_complete      numeric(9,6) NOT NULL CHECK (pct_complete BETWEEN 0 AND 1),
  revenue_to_date   numeric(16,2) NOT NULL,
  -- Positive: contract asset (work done, not billed). Negative: contract liability (billed ahead).
  position          numeric(16,2) NOT NULL,
  expected_loss     numeric(16,2) NOT NULL DEFAULT 0,
  provision         numeric(16,2) NOT NULL DEFAULT 0,
  created_by        uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, contract_id, period),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES contracts (tenant_id, id)
);
CREATE TRIGGER contract_estimates_append_only BEFORE UPDATE OR DELETE ON contract_estimates FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER contract_closes_append_only BEFORE UPDATE OR DELETE ON contract_closes FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DO $$
DECLARE _t text;
BEGIN
  FOREACH _t IN ARRAY ARRAY['contract_estimates', 'contract_closes'] LOOP
    PERFORM enable_tenant_rls(_t::regclass);
    PERFORM grant_app(_t, 'SELECT, INSERT');
  END LOOP;
END $$;
