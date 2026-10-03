-- 0037_projects_contracts: projects, contracts, bills of quantities, WBS and bank guarantees (ARCHITECTURE.md, C2).

CREATE TABLE projects (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code               text NOT NULL CHECK (code ~ '^[A-Za-z0-9-]{1,20}$'),
  name               text NOT NULL CHECK (char_length(trim(name)) BETWEEN 2 AND 160),
  client_id          uuid,
  specialty          text NOT NULL REFERENCES specialty_templates(code),
  -- The project is its own cost center (kind project): every posting for it carries that dimension.
  cost_center_id     uuid NOT NULL,
  branch_id          uuid,
  location           text CHECK (location IS NULL OR char_length(location) <= 300),
  latitude           numeric(9,6) CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  longitude          numeric(9,6) CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  -- Saudi Building Code edition applying to the design (e.g. SBC 2024, mandatory from 2025-06-30).
  code_edition       text CHECK (code_edition IS NULL OR char_length(code_edition) <= 40),
  status             text NOT NULL DEFAULT 'planning' CHECK (status IN ('planning', 'active', 'completed', 'closed')),
  created_by         uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, client_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, cost_center_id) REFERENCES cost_centers (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id)
);

CREATE TABLE project_permits (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id  uuid NOT NULL,
  kind        text NOT NULL CHECK (char_length(trim(kind)) BETWEEN 2 AND 80),
  number      text NOT NULL CHECK (char_length(trim(number)) BETWEEN 1 AND 60),
  issuer      text CHECK (issuer IS NULL OR char_length(issuer) <= 120),
  expires_on  date,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id) ON DELETE CASCADE
);

-- WBS: a tree per project; the specialty's levels name its depths.
CREATE TABLE wbs_nodes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id  uuid NOT NULL,
  parent_id   uuid,
  code        text NOT NULL CHECK (char_length(trim(code)) BETWEEN 1 AND 40),
  name        text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 160),
  sort        integer NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, project_id, code),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, parent_id) REFERENCES wbs_nodes (tenant_id, id) ON DELETE CASCADE
);

-- Cost breakdown codes (materials, labour, equipment, subcontract, overheads), per workspace.
CREATE TABLE cost_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code        text NOT NULL CHECK (code ~ '^[A-Za-z0-9.-]{1,20}$'),
  name        text NOT NULL CHECK (char_length(trim(name)) BETWEEN 2 AND 120),
  kind        text NOT NULL CHECK (kind IN ('material', 'labor', 'equipment', 'subcontract', 'overhead')),
  is_active   boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);
ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_wbs_fk FOREIGN KEY (tenant_id, wbs_id) REFERENCES wbs_nodes (tenant_id, id);
ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_cost_code_fk FOREIGN KEY (tenant_id, cost_code_id) REFERENCES cost_codes (tenant_id, id);

CREATE TABLE contracts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id          uuid NOT NULL,
  number              text NOT NULL CHECK (char_length(trim(number)) BETWEEN 1 AND 40),
  title               text NOT NULL CHECK (char_length(trim(title)) BETWEEN 2 AND 200),
  -- MAIN: we are the contractor to a client. SUB (C4): we hire a subcontractor.
  role                text NOT NULL DEFAULT 'MAIN' CHECK (role IN ('MAIN', 'SUB')),
  customer_id         uuid,
  profile             text NOT NULL REFERENCES contract_profiles(code),
  pricing_model       text NOT NULL CHECK (pricing_model IN ('LUMP_SUM', 'UNIT_PRICE', 'COST_PLUS', 'GMP', 'T_AND_M', 'RATE_CARD')),
  -- Which law governs it: decided by the tender date, not today (a 2026 tender stays under GTPL 1440).
  governing_regime    text NOT NULL CHECK (governing_regime IN ('GTPL_1440', 'GTPL_1448', 'PRIVATE')),
  -- A government entity as client: VAT falls due at the payment order or receipt, whichever is first (main contractor).
  government_client   boolean NOT NULL DEFAULT false,
  tender_date         date,
  sign_date           date,
  site_handover_date  date,
  start_date          date,
  duration_days       integer CHECK (duration_days IS NULL OR duration_days > 0),
  -- Contract value excluding VAT (the original value; approved variations are kept apart).
  value               numeric(16,2) NOT NULL CHECK (value >= 0),
  advance_pct         numeric(5,2) NOT NULL DEFAULT 0 CHECK (advance_pct BETWEEN 0 AND 100),
  retention_pct       numeric(5,2) NOT NULL DEFAULT 0 CHECK (retention_pct BETWEEN 0 AND 100),
  retention_cap_pct   numeric(5,2) NOT NULL DEFAULT 0 CHECK (retention_cap_pct BETWEEN 0 AND 100),
  ld_rate_per_day     numeric(14,2) NOT NULL DEFAULT 0 CHECK (ld_rate_per_day >= 0),
  -- The penalty cap: from the regime's verified parameter, or agreed (private contracts).
  ld_cap_pct          numeric(5,2) CHECK (ld_cap_pct IS NULL OR ld_cap_pct BETWEEN 0 AND 100),
  dlp_months          integer NOT NULL DEFAULT 12 CHECK (dlp_months BETWEEN 0 AND 120),
  claim_notice_days   integer NOT NULL DEFAULT 28 CHECK (claim_notice_days BETWEEN 1 AND 365),
  -- The statutory values applied at activation, with their source and effective date (shown with every calculation).
  applied_params      jsonb NOT NULL DEFAULT '{}',
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'completed', 'closed')),
  created_by          uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  activated_at        timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  CHECK (role <> 'MAIN' OR customer_id IS NOT NULL),
  CHECK (governing_regime = 'PRIVATE' OR tender_date IS NOT NULL),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id)
);

-- BOQ versions: tender → contract (frozen at activation) → revised copies.
CREATE TABLE boq_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contract_id uuid NOT NULL,
  number      integer NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('tender', 'contract', 'revised')),
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'frozen')),
  note        text CHECK (note IS NULL OR char_length(note) <= 300),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, contract_id, number),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES contracts (tenant_id, id) ON DELETE CASCADE
);

-- BOQ items: an unlimited tree (section → bill → item → sub-item); only leaves carry quantity and rate.
CREATE TABLE boq_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  version_id        uuid NOT NULL,
  parent_id         uuid,
  code              text NOT NULL CHECK (char_length(trim(code)) BETWEEN 1 AND 40),
  description       text NOT NULL CHECK (char_length(trim(description)) BETWEEN 1 AND 1000),
  is_section        boolean NOT NULL DEFAULT false,
  unit              text CHECK (unit IS NULL OR char_length(unit) <= 20),
  quantity          numeric(18,4) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  rate              numeric(16,4) NOT NULL DEFAULT 0 CHECK (rate >= 0),
  is_provisional    boolean NOT NULL DEFAULT false,
  is_prime_cost     boolean NOT NULL DEFAULT false,
  is_daywork        boolean NOT NULL DEFAULT false,
  spec_ref          text CHECK (spec_ref IS NULL OR char_length(spec_ref) <= 80),
  sort              integer NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, version_id, code),
  CHECK (NOT is_section OR (quantity = 0 AND rate = 0)),
  FOREIGN KEY (tenant_id, version_id) REFERENCES boq_versions (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, parent_id) REFERENCES boq_items (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX boq_items_version_idx ON boq_items (tenant_id, version_id, sort);
-- A frozen version is the contract: its items no longer change.
CREATE FUNCTION boq_frozen_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE _v uuid := CASE WHEN TG_OP = 'INSERT' THEN NEW.version_id ELSE OLD.version_id END;
BEGIN
  IF (SELECT status FROM boq_versions WHERE id = _v) = 'frozen' THEN RAISE EXCEPTION 'boq_frozen' USING ERRCODE = 'P0001'; END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER boq_items_frozen BEFORE INSERT OR UPDATE OR DELETE ON boq_items FOR EACH ROW EXECUTE FUNCTION boq_frozen_guard();

-- BOQ item ↔ WBS node, with the share of the item's value on each node.
CREATE TABLE boq_wbs (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  boq_item_id uuid NOT NULL,
  wbs_id      uuid NOT NULL,
  share_pct   numeric(5,2) NOT NULL DEFAULT 100 CHECK (share_pct > 0 AND share_pct <= 100),
  PRIMARY KEY (tenant_id, boq_item_id, wbs_id),
  FOREIGN KEY (tenant_id, boq_item_id) REFERENCES boq_items (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, wbs_id) REFERENCES wbs_nodes (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE bank_guarantees (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contract_id   uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('bid', 'performance', 'advance', 'retention')),
  number        text NOT NULL CHECK (char_length(trim(number)) BETWEEN 1 AND 60),
  bank          text NOT NULL CHECK (char_length(trim(bank)) BETWEEN 2 AND 120),
  amount        numeric(16,2) NOT NULL CHECK (amount > 0),
  issued_on     date NOT NULL,
  expires_on    date NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'expired')),
  -- The bank's fee: a cost of the project (posted when entered).
  fee           numeric(14,2) NOT NULL DEFAULT 0 CHECK (fee >= 0),
  fee_paid_from text CHECK (fee_paid_from IS NULL OR fee_paid_from IN ('bank_transfer', 'cash')),
  released_on   date,
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (expires_on >= issued_on),
  CHECK (fee = 0 OR fee_paid_from IS NOT NULL),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES contracts (tenant_id, id)
);

DO $$
DECLARE _t text;
BEGIN
  FOREACH _t IN ARRAY ARRAY['projects', 'project_permits', 'wbs_nodes', 'cost_codes', 'contracts', 'boq_versions', 'boq_items', 'boq_wbs', 'bank_guarantees'] LOOP
    PERFORM enable_tenant_rls(_t::regclass);
  END LOOP;
  PERFORM grant_app('projects', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('project_permits', 'SELECT, INSERT, UPDATE, DELETE');
  PERFORM grant_app('wbs_nodes', 'SELECT, INSERT, UPDATE, DELETE');
  PERFORM grant_app('cost_codes', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('contracts', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('boq_versions', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('boq_items', 'SELECT, INSERT, UPDATE, DELETE');
  PERFORM grant_app('boq_wbs', 'SELECT, INSERT, DELETE');
  PERFORM grant_app('bank_guarantees', 'SELECT, INSERT, UPDATE');
END $$;
