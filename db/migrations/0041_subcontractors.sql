-- 0041_subcontractors: subcontractors (docs/contracting/ARCHITECTURE.md, C4).
--   * A subcontractor is a supplier with a qualification record (classification field/grade/expiry, certificates).
--     Residency already lives on suppliers (0028); it decides reverse charge and withholding.
--   * A subcontract is a contract of role SUB: with a supplier, under a MAIN contract (back-to-back), within the
--     subcontracting ceiling of the main contract's form (e.g. Etimad: 30% with the entity's approval, below 50% with
--     a further approval) and never a sub of a sub.
--   * Its IPCs reuse ipcs/ipc_lines. What differs: set-off deductions, the reverse-charge VAT of a non-resident, and
--     the subcontractor's own invoice number instead of our sales invoice.
--   * Advances paid to subcontractors and retention releases (both directions) are their own documents.

CREATE TABLE subcontractor_profiles (
  supplier_id           uuid NOT NULL,
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cr_number             text CHECK (cr_number IS NULL OR char_length(trim(cr_number)) BETWEEN 1 AND 30),
  -- Contractor classification (Balady): field, grade and expiry. Required for a resident before any subcontract.
  classification_field  text CHECK (classification_field IS NULL OR char_length(trim(classification_field)) BETWEEN 2 AND 120),
  classification_grade  text CHECK (classification_grade IS NULL OR char_length(trim(classification_grade)) BETWEEN 1 AND 20),
  classification_expiry date,
  zakat_cert_expiry     date,
  gosi_cert_expiry      date,
  insurance_expiry      date,
  specialties           text CHECK (specialties IS NULL OR char_length(specialties) <= 300),
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'suspended')),
  -- Periodic evaluation (1–5), with the date it was last rated.
  rating                smallint CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  rated_at              date,
  notes                 text CHECK (notes IS NULL OR char_length(notes) <= 1000),
  approved_by           uuid,
  approved_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, supplier_id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id)
);

-- The contract form's subcontracting ceilings (data, per form; null = none in the form).
UPDATE contract_profiles SET defaults = defaults || '{"subcontractApprovalPct":30,"subcontractMaxPct":50}'::jsonb WHERE code = 'ETIMAD_GC_2020';

ALTER TABLE contracts
  ADD COLUMN supplier_id uuid,
  ADD COLUMN parent_contract_id uuid,
  -- The documented approval (entity's letter / efficiency center) when the subcontracted share needs one.
  ADD COLUMN subcontract_approval_ref text CHECK (subcontract_approval_ref IS NULL OR char_length(trim(subcontract_approval_ref)) BETWEEN 2 AND 120),
  ADD FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, parent_contract_id) REFERENCES contracts (tenant_id, id),
  ADD CONSTRAINT contracts_sub_ck CHECK (role = 'MAIN' AND supplier_id IS NULL AND parent_contract_id IS NULL
                                         OR role = 'SUB' AND supplier_id IS NOT NULL AND parent_contract_id IS NOT NULL AND customer_id IS NULL);
-- A subcontract hangs under a MAIN contract of the same project (no sub-subcontracting).
CREATE FUNCTION contracts_sub_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record;
BEGIN
  IF NEW.role = 'SUB' THEN
    SELECT role, project_id INTO p FROM contracts WHERE id = NEW.parent_contract_id;
    IF p.role <> 'MAIN' THEN RAISE EXCEPTION 'sub_of_sub' USING ERRCODE = 'P0001'; END IF;
    IF p.project_id <> NEW.project_id THEN RAISE EXCEPTION 'sub_other_project' USING ERRCODE = 'P0001'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contracts_sub_guard BEFORE INSERT OR UPDATE OF role, parent_contract_id, project_id ON contracts FOR EACH ROW EXECUTE FUNCTION contracts_sub_guard();

-- Back-to-back: a subcontract BOQ item may point at the main contract item it delivers (margin per item).
ALTER TABLE boq_items ADD COLUMN main_item_id uuid, ADD FOREIGN KEY (tenant_id, main_item_id) REFERENCES boq_items (tenant_id, id);

-- Subcontractor IPC figures (zero on client IPCs).
ALTER TABLE ipcs
  ADD COLUMN deductions         numeric(16,2) NOT NULL DEFAULT 0 CHECK (deductions >= 0),
  ADD COLUMN reverse_charge_vat numeric(16,2) NOT NULL DEFAULT 0 CHECK (reverse_charge_vat >= 0),
  ADD COLUMN supplier_invoice   text CHECK (supplier_invoice IS NULL OR char_length(trim(supplier_invoice)) BETWEEN 1 AND 60),
  ADD COLUMN supplier_invoice_date date;
CREATE OR REPLACE FUNCTION ipcs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'ipc_final' USING ERRCODE = 'P0001'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('approved', 'invoiced') AND (NEW.gross_to_date <> OLD.gross_to_date OR NEW.current_gross <> OLD.current_gross OR NEW.retention_current <> OLD.retention_current
      OR NEW.advance_recovery <> OLD.advance_recovery OR NEW.ld_amount <> OLD.ld_amount OR NEW.vat <> OLD.vat OR NEW.net_payable <> OLD.net_payable
      OR NEW.deductions <> OLD.deductions OR NEW.reverse_charge_vat <> OLD.reverse_charge_vat
      OR (OLD.status = 'invoiced' AND (NEW.status <> 'invoiced' OR NEW.supplier_invoice IS DISTINCT FROM OLD.supplier_invoice))) THEN
    RAISE EXCEPTION 'ipc_final' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- Set-off deductions on a subcontractor IPC (back-charges). Frozen with the IPC (ipc_lines' rule).
CREATE TABLE ipc_deductions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ipc_id      uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('materials', 'equipment', 'damages', 'other')),
  description text NOT NULL CHECK (char_length(trim(description)) BETWEEN 3 AND 300),
  amount      numeric(16,2) NOT NULL CHECK (amount > 0),
  cost_code_id uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, ipc_id) REFERENCES ipcs (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, cost_code_id) REFERENCES cost_codes (tenant_id, id)
);
CREATE TRIGGER ipc_deductions_guard BEFORE INSERT OR UPDATE OR DELETE ON ipc_deductions FOR EACH ROW EXECUTE FUNCTION ipc_lines_guard();

-- An advance paid to a subcontractor: its invoice to us (386), recovered by its IPCs.
CREATE TABLE subcontract_advances (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contract_id      uuid NOT NULL,
  number           integer NOT NULL,
  taxable          numeric(16,2) NOT NULL CHECK (taxable > 0),
  vat              numeric(16,2) NOT NULL DEFAULT 0 CHECK (vat >= 0),
  reverse_charge_vat numeric(16,2) NOT NULL DEFAULT 0 CHECK (reverse_charge_vat >= 0),
  supplier_invoice text CHECK (supplier_invoice IS NULL OR char_length(trim(supplier_invoice)) BETWEEN 1 AND 60),
  advance_date     date NOT NULL,
  idempotency_key  uuid NOT NULL,
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, contract_id, number),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES contracts (tenant_id, id)
);

-- Retention released: by the client to us (MAIN: money in) or by us to a subcontractor (SUB: it becomes payable).
CREATE TABLE retention_releases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contract_id     uuid NOT NULL,
  amount          numeric(16,2) NOT NULL CHECK (amount > 0),
  released_on     date NOT NULL,
  -- MAIN only: how the client paid it.
  method          text CHECK (method IS NULL OR method IN ('bank_transfer', 'cash', 'cheque')),
  reason          text NOT NULL CHECK (char_length(trim(reason)) BETWEEN 3 AND 300),
  idempotency_key uuid NOT NULL,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES contracts (tenant_id, id)
);
CREATE TRIGGER subcontract_advances_append_only BEFORE UPDATE OR DELETE ON subcontract_advances FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER retention_releases_append_only BEFORE UPDATE OR DELETE ON retention_releases FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Subcontracting accounts for existing contracting workspaces (new ones get them on first use in the app).
CREATE OR REPLACE FUNCTION seed_contracting_accounts(_t uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r record; _parent uuid;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('1118', '11', 'محتجزات لدى العملاء', 'asset', 'retention_receivable'),
    ('1119', '11', 'دفعات مقدمة لمقاولي الباطن', 'asset', 'subcontractor_advances'),
    ('2118', '21', 'محتجزات مقاولي الباطن', 'liability', 'retention_payable'),
    ('4104', '4',  'إيرادات عقود المقاولات', 'revenue', 'contract_revenue'),
    ('5110', '5',  'تكاليف مقاولي الباطن', 'expense', 'subcontract_cost')
  ) AS v(code, parent, name, type, system_key) LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM accounts WHERE tenant_id = _t AND system_key = r.system_key);
    CONTINUE WHEN EXISTS (SELECT 1 FROM accounts WHERE tenant_id = _t AND code = r.code);
    SELECT id INTO _parent FROM accounts WHERE tenant_id = _t AND code = r.parent;
    CONTINUE WHEN _parent IS NULL;
    INSERT INTO accounts (tenant_id, code, name, type, parent_id, is_group, system_key) VALUES (_t, r.code, r.name, r.type, _parent, false, r.system_key);
  END LOOP;
  UPDATE accounts SET system_key = 'customer_advances' WHERE tenant_id = _t AND code = '2108' AND system_key IS NULL
     AND NOT EXISTS (SELECT 1 FROM accounts WHERE tenant_id = _t AND system_key = 'customer_advances');
  UPDATE accounts SET system_key = 'bank_fees' WHERE tenant_id = _t AND code = '6110' AND system_key IS NULL AND NOT is_group
     AND NOT EXISTS (SELECT 1 FROM accounts WHERE tenant_id = _t AND system_key = 'bank_fees');
END $$;
DO $$ DECLARE _t uuid; BEGIN FOR _t IN SELECT id FROM tenants WHERE sector = 'contracting' LOOP PERFORM seed_contracting_accounts(_t); END LOOP; END $$;

DO $$
DECLARE _t text;
BEGIN
  FOREACH _t IN ARRAY ARRAY['subcontractor_profiles', 'ipc_deductions', 'subcontract_advances', 'retention_releases'] LOOP
    PERFORM enable_tenant_rls(_t::regclass);
  END LOOP;
  PERFORM grant_app('subcontractor_profiles', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('ipc_deductions', 'SELECT, INSERT, UPDATE, DELETE');
  PERFORM grant_app('subcontract_advances', 'SELECT, INSERT');
  PERFORM grant_app('retention_releases', 'SELECT, INSERT');
END $$;
