-- 0047_contracting_integrity: fixes from the contracting security review.
--   * A BOQ or tender edit racing with the freeze/submit: the guards read the status under FOR SHARE, so they wait
--     for (and see) the transaction that freezes it.
--   * A bank guarantee (its fee is posted) takes an Idempotency-Key like every financial write.
--   * A verified statutory value never goes back to draft.
--   * A claim once agreed, rejected or withdrawn is final (its assessed amount feeds the transaction price).

CREATE OR REPLACE FUNCTION boq_frozen_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE _v uuid := CASE WHEN TG_OP = 'INSERT' THEN NEW.version_id ELSE OLD.version_id END;
BEGIN
  IF (SELECT status FROM boq_versions WHERE id = _v FOR SHARE) = 'frozen' THEN RAISE EXCEPTION 'boq_frozen' USING ERRCODE = 'P0001'; END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE OR REPLACE FUNCTION tender_content_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE _t uuid;
BEGIN
  IF TG_TABLE_NAME = 'tender_items' THEN _t := CASE WHEN TG_OP = 'DELETE' THEN OLD.tender_id ELSE NEW.tender_id END;
  ELSE SELECT tender_id INTO _t FROM tender_items WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.item_id ELSE NEW.item_id END;
  END IF;
  IF (SELECT status FROM tenders WHERE id = _t FOR SHARE) <> 'draft' THEN RAISE EXCEPTION 'tender_locked' USING ERRCODE = 'P0001'; END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

ALTER TABLE bank_guarantees ADD COLUMN idempotency_key uuid;
CREATE UNIQUE INDEX bank_guarantees_idem ON bank_guarantees (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE OR REPLACE FUNCTION regulatory_parameters_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'verified' THEN RAISE EXCEPTION 'regulatory_parameter_verified' USING ERRCODE = 'P0001'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'verified' AND (NEW.status = 'draft' OR NEW.value <> OLD.value OR NEW.unit <> OLD.unit OR NEW.key <> OLD.key OR NEW.regime <> OLD.regime
      OR NEW.effective_from <> OLD.effective_from OR NEW.legal_basis <> OLD.legal_basis OR NEW.source_title <> OLD.source_title) THEN
    RAISE EXCEPTION 'regulatory_parameter_verified' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION claims_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('agreed', 'rejected', 'withdrawn') THEN RAISE EXCEPTION 'claim_final' USING ERRCODE = 'P0001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER claims_guard BEFORE UPDATE ON claims FOR EACH ROW EXECUTE FUNCTION claims_guard();
