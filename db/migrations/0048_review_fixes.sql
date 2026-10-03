-- 0048_review_fixes: from the contracting accounting review.
--   * A claim's agreement date, so a past period's close takes only the claims agreed by then (variable consideration).
--   * Set-off deductions on a subcontractor IPC are compensation only (damages, other): materials or equipment we
--     supply to a subcontractor are a taxable supply and are invoiced with VAT, never set off without it.

ALTER TABLE claims ADD COLUMN agreed_at timestamptz;
ALTER TABLE claims DISABLE TRIGGER claims_guard;
UPDATE claims SET agreed_at = created_at WHERE status = 'agreed';
ALTER TABLE claims ENABLE TRIGGER claims_guard;
CREATE OR REPLACE FUNCTION claims_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('agreed', 'rejected', 'withdrawn') THEN RAISE EXCEPTION 'claim_final' USING ERRCODE = 'P0001'; END IF;
  IF NEW.status = 'agreed' THEN NEW.agreed_at := now(); END IF;
  RETURN NEW;
END $$;

ALTER TABLE ipc_deductions DROP CONSTRAINT ipc_deductions_kind_check;
-- Existing ones become «other» (history kept; the guard of approved IPCs is bypassed for this relabel only).
ALTER TABLE ipc_deductions DISABLE TRIGGER ipc_deductions_guard;
UPDATE ipc_deductions SET kind = 'other' WHERE kind IN ('materials', 'equipment');
ALTER TABLE ipc_deductions ENABLE TRIGGER ipc_deductions_guard;
ALTER TABLE ipc_deductions ADD CONSTRAINT ipc_deductions_kind_check CHECK (kind IN ('damages', 'other'));
