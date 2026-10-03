-- 0043_tenders: estimating and tendering (docs/contracting/ARCHITECTURE.md, C6).
--   * A tender: the prospective client, the specialty (units), the markups, and its outcome.
--   * Its bill of quantities (a tree like the contract BOQ) and each item's rate build-up from resources (materials
--     from the item master or described, labour, equipment, subcontract), or a direct rate.
--   * Winning converts it into a project (or an existing one) and a draft main contract with the priced BOQ, and
--     records the cost without profit as the contract's first estimated cost.

CREATE TABLE tenders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number          text NOT NULL CHECK (char_length(trim(number)) BETWEEN 1 AND 40),
  title           text NOT NULL CHECK (char_length(trim(title)) BETWEEN 2 AND 200),
  customer_id     uuid,
  specialty       text NOT NULL REFERENCES specialty_templates(code),
  governing_regime text NOT NULL DEFAULT 'PRIVATE' CHECK (governing_regime IN ('GTPL_1440', 'GTPL_1448', 'PRIVATE')),
  tender_date     date,
  submission_due  date,
  overhead_pct    numeric(6,2) NOT NULL DEFAULT 0 CHECK (overhead_pct BETWEEN 0 AND 100),
  risk_pct        numeric(6,2) NOT NULL DEFAULT 0 CHECK (risk_pct BETWEEN 0 AND 100),
  profit_pct      numeric(6,2) NOT NULL DEFAULT 0 CHECK (profit_pct BETWEEN 0 AND 100),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'won', 'lost', 'cancelled')),
  -- What we priced when submitted (the offer), kept as it was.
  submitted_total numeric(16,2),
  submitted_at    timestamptz,
  outcome_note    text CHECK (outcome_note IS NULL OR char_length(outcome_note) <= 500),
  contract_id     uuid,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES contracts (tenant_id, id)
);

CREATE TABLE tender_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tender_id   uuid NOT NULL,
  parent_id   uuid,
  code        text NOT NULL CHECK (char_length(trim(code)) BETWEEN 1 AND 40),
  description text NOT NULL CHECK (char_length(trim(description)) BETWEEN 1 AND 1000),
  is_section  boolean NOT NULL DEFAULT false,
  unit        text CHECK (unit IS NULL OR char_length(unit) <= 20),
  quantity    numeric(18,4) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  -- A rate priced directly (lump sum, a subcontract quote) when the item has no resources.
  direct_rate numeric(16,4) CHECK (direct_rate IS NULL OR direct_rate >= 0),
  sort        integer NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, tender_id, code),
  FOREIGN KEY (tenant_id, tender_id) REFERENCES tenders (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, parent_id) REFERENCES tender_items (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE tender_resources (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  item_id     uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('material', 'labor', 'equipment', 'subcontract')),
  ingredient_id uuid,
  description text NOT NULL CHECK (char_length(trim(description)) BETWEEN 1 AND 200),
  unit        text CHECK (unit IS NULL OR char_length(unit) <= 20),
  -- Per unit of the item.
  quantity    numeric(18,6) NOT NULL CHECK (quantity > 0),
  unit_cost   numeric(16,4) NOT NULL CHECK (unit_cost >= 0),
  waste_pct   numeric(6,2) NOT NULL DEFAULT 0 CHECK (waste_pct BETWEEN 0 AND 100),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES tender_items (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, ingredient_id) REFERENCES ingredients (tenant_id, id)
);

-- A tender no longer in draft keeps its priced content.
CREATE FUNCTION tender_content_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE _t uuid;
BEGIN
  IF TG_TABLE_NAME = 'tender_items' THEN _t := CASE WHEN TG_OP = 'DELETE' THEN OLD.tender_id ELSE NEW.tender_id END;
  ELSE SELECT tender_id INTO _t FROM tender_items WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.item_id ELSE NEW.item_id END;
  END IF;
  IF (SELECT status FROM tenders WHERE id = _t) <> 'draft' THEN RAISE EXCEPTION 'tender_locked' USING ERRCODE = 'P0001'; END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER tender_items_guard BEFORE INSERT OR UPDATE OR DELETE ON tender_items FOR EACH ROW EXECUTE FUNCTION tender_content_guard();
CREATE TRIGGER tender_resources_guard BEFORE INSERT OR UPDATE OR DELETE ON tender_resources FOR EACH ROW EXECUTE FUNCTION tender_content_guard();

DO $$
DECLARE _t text;
BEGIN
  FOREACH _t IN ARRAY ARRAY['tenders', 'tender_items', 'tender_resources'] LOOP
    PERFORM enable_tenant_rls(_t::regclass);
  END LOOP;
  PERFORM grant_app('tenders', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('tender_items', 'SELECT, INSERT, UPDATE, DELETE');
  PERFORM grant_app('tender_resources', 'SELECT, INSERT, UPDATE, DELETE');
END $$;
