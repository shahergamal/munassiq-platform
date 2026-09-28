-- ZATCA e-invoicing Phase 2 (integration): the workspace's own e-invoicing device (EGS unit), onboarded by the
-- workspace owner with an OTP from the Fatoora portal; signed UBL documents; and every submission to ZATCA.
--
--   * The device's private key and CSID secrets are stored encrypted (AES-256-GCM, key held by the server).
--   * One active device per workspace; its ICV counter and previous-invoice hash chain every signed document.
--   * Signed documents and submissions are append-only.

CREATE TABLE zatca_devices (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  environment           text NOT NULL CHECK (environment IN ('sandbox', 'simulation', 'production')),
  status                text NOT NULL DEFAULT 'onboarding' CHECK (status IN ('onboarding', 'active', 'failed', 'retired')),
  common_name           text NOT NULL,
  serial_number         text NOT NULL,
  organization_unit     text NOT NULL,
  invoice_types         text NOT NULL CHECK (invoice_types ~ '^[01]{2}00$' AND invoice_types <> '0000'),
  location              text NOT NULL,
  industry              text NOT NULL,
  private_key_enc       text NOT NULL,
  csr_pem               text NOT NULL,
  compliance_request_id text,
  compliance_token      text,
  compliance_secret_enc text,
  production_token      text,
  production_secret_enc text,
  -- Base64 DER of the production certificate (from the CSID), used in every signature.
  certificate           text,
  certificate_expires_at timestamptz,
  -- The chain: last issued counter and the hash of the last signed document (initial PIH = base64(SHA-256("0"))).
  last_icv              bigint NOT NULL DEFAULT 0,
  last_hash             text NOT NULL DEFAULT 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==',
  -- The outcome of each compliance check run at onboarding (shown on the device page).
  compliance_results    jsonb,
  failure               text,
  onboarded_at          timestamptz,
  created_by            uuid NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX zatca_devices_one_active_uq ON zatca_devices (tenant_id) WHERE status = 'active';
CREATE TRIGGER zatca_devices_updated BEFORE UPDATE ON zatca_devices FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The chain only moves forward, one document at a time: no reset, no skip, no rewriting the last hash.
CREATE FUNCTION zatca_chain_forward() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.last_icv <> OLD.last_icv AND NEW.last_icv <> OLD.last_icv + 1 THEN
    RAISE EXCEPTION 'zatca_chain_violation' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.last_icv = OLD.last_icv AND NEW.last_hash <> OLD.last_hash THEN
    RAISE EXCEPTION 'zatca_chain_violation' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.environment <> OLD.environment OR NEW.private_key_enc <> OLD.private_key_enc THEN
    RAISE EXCEPTION 'zatca_device_immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zatca_devices_chain BEFORE UPDATE ON zatca_devices FOR EACH ROW EXECUTE FUNCTION zatca_chain_forward();

CREATE TABLE zatca_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id     uuid NOT NULL,
  source_type   text NOT NULL CHECK (source_type IN ('sales_document', 'pos_order', 'pos_refund')),
  source_id     uuid NOT NULL,
  doc_number    text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('invoice', 'credit_note', 'debit_note')),
  invoice_type  text NOT NULL CHECK (invoice_type IN ('standard', 'simplified')),
  uuid          uuid NOT NULL,
  icv           bigint NOT NULL CHECK (icv >= 1),
  pih           text NOT NULL,
  invoice_hash  text NOT NULL,
  xml           text NOT NULL,
  qr_base64     text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (device_id, icv),
  FOREIGN KEY (tenant_id, device_id) REFERENCES zatca_devices (tenant_id, id)
);
CREATE UNIQUE INDEX zatca_documents_source_uq ON zatca_documents (tenant_id, source_type, source_id);
CREATE TRIGGER zatca_documents_immutable BEFORE UPDATE OR DELETE ON zatca_documents FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE zatca_submissions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id  uuid NOT NULL,
  mode         text NOT NULL CHECK (mode IN ('reporting', 'clearance')),
  http_status  integer,
  -- accepted (200), accepted_with_warnings (202), rejected (400: the document is invalid), error (network / 5xx: retry).
  outcome      text NOT NULL CHECK (outcome IN ('accepted', 'accepted_with_warnings', 'rejected', 'error')),
  response     jsonb,
  -- Clearance returns the invoice stamped by ZATCA: that XML is the one to share with the buyer.
  cleared_xml  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, document_id) REFERENCES zatca_documents (tenant_id, id)
);
CREATE INDEX zatca_submissions_document_idx ON zatca_submissions (tenant_id, document_id, created_at DESC);
CREATE TRIGGER zatca_submissions_immutable BEFORE UPDATE OR DELETE ON zatca_submissions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DO $$
DECLARE _t text;
BEGIN
  FOREACH _t IN ARRAY ARRAY['zatca_devices', 'zatca_documents', 'zatca_submissions'] LOOP
    PERFORM enable_tenant_rls(_t::regclass);
  END LOOP;
  PERFORM grant_app('zatca_devices', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('zatca_documents', 'SELECT, INSERT');
  PERFORM grant_app('zatca_submissions', 'SELECT, INSERT');
END $$;
