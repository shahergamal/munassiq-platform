-- 0038_ipcs_variations: client payment certificates (IPCs), variations and claims (ARCHITECTURE.md, C3).
--   * The IPC is the contractual document (measured, certified by the consultant, approved by the client). The tax
--     invoice (388) is generated FROM an approved IPC by the existing sales-document engine and ZATCA service only.
--   * Retention does not reduce the VAT base (ZATCA contracting guideline, May 2026): the invoice carries the full
--     amount; the retained part is booked to retention receivable (sales_documents.retention_amount).
--   * The contract's advance is a prepayment invoice (386) recovered pro rata in each IPC invoice (prepayment lines).
--   * Performance-linked delay damages are a price reduction: a credit note (381) with VAT on the IPC's invoice.

-- Sales documents learn about contracts (advance and IPC invoices) and retention.
ALTER TABLE sales_documents ADD COLUMN contract_id uuid;
ALTER TABLE sales_documents ADD CONSTRAINT sales_documents_contract_fk FOREIGN KEY (tenant_id, contract_id) REFERENCES contracts (tenant_id, id);
ALTER TABLE sales_documents ADD COLUMN retention_amount numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE sales_documents ADD CONSTRAINT sales_documents_retention_check CHECK (retention_amount >= 0 AND retention_amount <= total - prepaid_amount AND (retention_amount = 0 OR kind = 'invoice'));
ALTER TABLE sales_documents DROP CONSTRAINT sales_documents_prepayment_check;
ALTER TABLE sales_documents ADD CONSTRAINT sales_documents_prepayment_check
  CHECK (kind <> 'prepayment' OR ((sales_order_id IS NOT NULL OR contract_id IS NOT NULL) AND payment_means <> 'credit'));

CREATE TABLE variations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contract_id      uuid NOT NULL,
  number           integer NOT NULL,
  title            text NOT NULL CHECK (char_length(trim(title)) BETWEEN 3 AND 200),
  source           text NOT NULL CHECK (source IN ('instruction', 'rfi', 'design_change', 'client_request', 'other')),
  time_impact_days integer NOT NULL DEFAULT 0 CHECK (time_impact_days BETWEEN -3650 AND 3650),
  status           text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'rejected')),
  -- The contractor's written consent (needed beyond the no-consent limits of Art. 67 GTPL 1448).
  contractor_consent boolean NOT NULL DEFAULT false,
  -- The caps checked at approval and the remaining headroom, with their source.
  cap_check        jsonb,
  decided_by       uuid,
  decided_at       timestamptz,
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, contract_id, number),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES contracts (tenant_id, id)
);

CREATE TABLE variation_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  variation_id  uuid NOT NULL,
  -- new_item: an item not in the BOQ; change_qty: more (+) or less (−) of an existing BOQ item.
  kind          text NOT NULL CHECK (kind IN ('new_item', 'change_qty')),
  boq_item_id   uuid,
  code          text NOT NULL CHECK (char_length(trim(code)) BETWEEN 1 AND 40),
  description   text NOT NULL CHECK (char_length(trim(description)) BETWEEN 1 AND 500),
  unit          text CHECK (unit IS NULL OR char_length(unit) <= 20),
  quantity      numeric(18,4) NOT NULL CHECK (quantity <> 0),
  rate          numeric(16,4) NOT NULL CHECK (rate >= 0),
  UNIQUE (tenant_id, id),
  CHECK (kind = 'new_item' AND boq_item_id IS NULL AND quantity > 0 OR kind = 'change_qty' AND boq_item_id IS NOT NULL),
  FOREIGN KEY (tenant_id, variation_id) REFERENCES variations (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, boq_item_id) REFERENCES boq_items (tenant_id, id)
);
-- A decided variation no longer changes.
CREATE FUNCTION variation_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE _v uuid := CASE WHEN TG_OP = 'INSERT' THEN NEW.variation_id ELSE OLD.variation_id END;
BEGIN
  IF (SELECT status FROM variations WHERE id = _v) <> 'proposed' THEN RAISE EXCEPTION 'variation_decided' USING ERRCODE = 'P0001'; END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER variation_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON variation_lines FOR EACH ROW EXECUTE FUNCTION variation_lines_guard();

CREATE TABLE ipcs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contract_id          uuid NOT NULL,
  number               integer NOT NULL,
  kind                 text NOT NULL DEFAULT 'interim' CHECK (kind IN ('interim', 'final')),
  period_from          date NOT NULL,
  period_to            date NOT NULL,
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'certified', 'approved', 'invoiced')),
  -- Computed by the server at each step (cumulative-to-date minus the previous approved IPC), SAR excl. VAT.
  gross_to_date        numeric(16,2) NOT NULL DEFAULT 0,
  previous_gross       numeric(16,2) NOT NULL DEFAULT 0,
  current_gross        numeric(16,2) NOT NULL DEFAULT 0,
  retention_current    numeric(16,2) NOT NULL DEFAULT 0,
  advance_recovery     numeric(16,2) NOT NULL DEFAULT 0,
  ld_days              integer NOT NULL DEFAULT 0 CHECK (ld_days >= 0),
  ld_amount            numeric(16,2) NOT NULL DEFAULT 0 CHECK (ld_amount >= 0),
  vat                  numeric(16,2) NOT NULL DEFAULT 0,
  net_payable          numeric(16,2) NOT NULL DEFAULT 0,
  -- Government client: VAT falls due at the payment order (or receipt, if earlier); the invoice waits for it.
  payment_order_date   date,
  sales_document_id    uuid,
  ld_credit_note_id    uuid,
  notes                text CHECK (notes IS NULL OR char_length(notes) <= 1000),
  submitted_at         timestamptz,
  certified_by         uuid,
  certified_at         timestamptz,
  approved_by          uuid,
  approved_at          timestamptz,
  created_by           uuid NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, contract_id, number),
  CHECK (period_to >= period_from),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES contracts (tenant_id, id),
  FOREIGN KEY (tenant_id, sales_document_id) REFERENCES sales_documents (tenant_id, id),
  FOREIGN KEY (tenant_id, ld_credit_note_id) REFERENCES sales_documents (tenant_id, id)
);
-- One open IPC per contract at a time; the next starts after the previous is approved.
CREATE UNIQUE INDEX ipcs_one_open ON ipcs (tenant_id, contract_id) WHERE status IN ('draft', 'submitted', 'certified');
-- Approved figures are final: after approval only the invoice link and the status move.
CREATE FUNCTION ipcs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'ipc_final' USING ERRCODE = 'P0001'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('approved', 'invoiced') AND (NEW.gross_to_date <> OLD.gross_to_date OR NEW.current_gross <> OLD.current_gross OR NEW.retention_current <> OLD.retention_current
      OR NEW.advance_recovery <> OLD.advance_recovery OR NEW.ld_amount <> OLD.ld_amount OR NEW.vat <> OLD.vat OR NEW.net_payable <> OLD.net_payable
      OR (OLD.status = 'invoiced' AND NEW.status <> 'invoiced')) THEN
    RAISE EXCEPTION 'ipc_final' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ipcs_guard BEFORE UPDATE OR DELETE ON ipcs FOR EACH ROW EXECUTE FUNCTION ipcs_guard();

CREATE TABLE ipc_lines (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ipc_id              uuid NOT NULL,
  -- boq: a BOQ item; vo: an approved variation's new item; mos: materials on site (an amount, not a quantity).
  kind                text NOT NULL CHECK (kind IN ('boq', 'vo', 'mos')),
  boq_item_id         uuid,
  variation_line_id   uuid,
  description         text NOT NULL,
  unit                text,
  rate                numeric(16,4) NOT NULL DEFAULT 0,
  -- Cumulative quantity to date: as submitted by us, then as certified by the consultant (what is billed).
  submitted_qty       numeric(18,4) NOT NULL DEFAULT 0,
  certified_qty       numeric(18,4),
  previous_qty        numeric(18,4) NOT NULL DEFAULT 0,
  -- For materials on site: the cumulative amount (SAR) instead of quantity × rate.
  submitted_amount    numeric(16,2),
  certified_amount    numeric(16,2),
  previous_amount     numeric(16,2) NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, ipc_id, boq_item_id),
  UNIQUE (tenant_id, ipc_id, variation_line_id),
  CHECK (kind = 'boq' AND boq_item_id IS NOT NULL OR kind = 'vo' AND variation_line_id IS NOT NULL OR kind = 'mos'),
  FOREIGN KEY (tenant_id, ipc_id) REFERENCES ipcs (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, boq_item_id) REFERENCES boq_items (tenant_id, id),
  FOREIGN KEY (tenant_id, variation_line_id) REFERENCES variation_lines (tenant_id, id)
);
CREATE FUNCTION ipc_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE _i uuid := CASE WHEN TG_OP = 'INSERT' THEN NEW.ipc_id ELSE OLD.ipc_id END;
BEGIN
  IF (SELECT status FROM ipcs WHERE id = _i) IN ('approved', 'invoiced') THEN RAISE EXCEPTION 'ipc_final' USING ERRCODE = 'P0001'; END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER ipc_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON ipc_lines FOR EACH ROW EXECUTE FUNCTION ipc_lines_guard();

CREATE TABLE claims (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contract_id     uuid NOT NULL,
  number          integer NOT NULL,
  title           text NOT NULL CHECK (char_length(trim(title)) BETWEEN 3 AND 200),
  kind            text NOT NULL CHECK (kind IN ('time', 'cost', 'time_cost')),
  event_date      date NOT NULL,
  -- The notice deadline follows the contract's form (e.g. FIDIC 2017 Sub-Cl. 20.2: 28 days).
  notice_deadline date NOT NULL,
  notice_date     date,
  description     text NOT NULL CHECK (char_length(trim(description)) BETWEEN 5 AND 2000),
  amount_claimed  numeric(16,2) CHECK (amount_claimed IS NULL OR amount_claimed >= 0),
  days_claimed    integer CHECK (days_claimed IS NULL OR days_claimed >= 0),
  amount_assessed numeric(16,2),
  days_assessed   integer,
  status          text NOT NULL DEFAULT 'identified' CHECK (status IN ('identified', 'notified', 'submitted', 'agreed', 'rejected', 'withdrawn')),
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, contract_id, number),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES contracts (tenant_id, id)
);

-- Default cost codes for a contracting workspace.
CREATE FUNCTION seed_cost_codes(_t uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO cost_codes (tenant_id, code, name, kind) VALUES
    (_t, 'MAT', 'مواد', 'material'), (_t, 'LAB', 'عمالة', 'labor'), (_t, 'EQP', 'معدات', 'equipment'),
    (_t, 'SUB', 'مقاولو باطن', 'subcontract'), (_t, 'OVH', 'مصروفات غير مباشرة للموقع', 'overhead')
  ON CONFLICT (tenant_id, code) DO NOTHING $$;
REVOKE ALL ON FUNCTION seed_cost_codes(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION seed_cost_codes(uuid) TO munassiq_system;
DO $$ DECLARE _t uuid; BEGIN FOR _t IN SELECT id FROM tenants WHERE sector = 'contracting' LOOP PERFORM seed_cost_codes(_t); END LOOP; END $$;

DO $$
DECLARE _t text;
BEGIN
  FOREACH _t IN ARRAY ARRAY['variations', 'variation_lines', 'ipcs', 'ipc_lines', 'claims'] LOOP
    PERFORM enable_tenant_rls(_t::regclass);
  END LOOP;
  PERFORM grant_app('variations', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('variation_lines', 'SELECT, INSERT, UPDATE, DELETE');
  PERFORM grant_app('ipcs', 'SELECT, INSERT, UPDATE, DELETE');
  PERFORM grant_app('ipc_lines', 'SELECT, INSERT, UPDATE, DELETE');
  PERFORM grant_app('claims', 'SELECT, INSERT, UPDATE');
END $$;

-- The sector is open for sign-up.
UPDATE sectors SET is_available = true WHERE key = 'contracting';
