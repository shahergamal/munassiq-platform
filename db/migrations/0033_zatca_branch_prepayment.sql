-- 0033_zatca_branch_prepayment: ZATCA for factories (docs/manufacturing/ARCHITECTURE.md, M6).
--   * One e-invoicing device (EGS unit) per branch, each with its own ICV/PIH chain; a device without a branch
--     serves every branch that has none of its own (the only kind that existed before).
--   * Prepayment invoices (type code 386) against a sales order, and the final invoice that deducts them
--     (prepayment lines, PrepaidAmount). The advance is a liability until applied.
--   * The KSA-2 exports flag on standard invoices.
--   * What the durable reporting worker needs to find pending documents without reading any tenant's data.

-- ── Device per branch ─────────────────────────────────────────────────────────────────────────
ALTER TABLE zatca_devices ADD COLUMN branch_id uuid;
ALTER TABLE zatca_devices ADD CONSTRAINT zatca_devices_branch_fk FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id);
DROP INDEX zatca_devices_one_active_uq;
CREATE UNIQUE INDEX zatca_devices_one_active_uq ON zatca_devices (tenant_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE status = 'active';

-- ── Prepayment and export documents ───────────────────────────────────────────────────────────
ALTER TABLE zatca_documents DROP CONSTRAINT zatca_documents_kind_check;
ALTER TABLE zatca_documents ADD CONSTRAINT zatca_documents_kind_check CHECK (kind IN ('invoice', 'credit_note', 'debit_note', 'prepayment'));

ALTER TABLE sales_documents DROP CONSTRAINT sales_documents_kind_check;
ALTER TABLE sales_documents ADD CONSTRAINT sales_documents_kind_check CHECK (kind IN ('invoice', 'credit_note', 'debit_note', 'prepayment'));
-- The note rule was an unnamed CHECK: find it by its text and restate it with prepayments allowed.
DO $$
DECLARE _c text;
BEGIN
  SELECT conname INTO _c FROM pg_constraint
   WHERE conrelid = 'sales_documents'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%original_id IS NOT NULL%';
  EXECUTE format('ALTER TABLE sales_documents DROP CONSTRAINT %I', _c);
END $$;
ALTER TABLE sales_documents ADD CONSTRAINT sales_documents_note_check CHECK (kind IN ('invoice', 'prepayment') OR (original_id IS NOT NULL AND reason IS NOT NULL));
-- Gross (VAT included) of earlier prepayments this invoice deducts; the buyer pays total − prepaid_amount.
ALTER TABLE sales_documents ADD COLUMN prepaid_amount numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE sales_documents ADD CONSTRAINT sales_documents_prepaid_check CHECK (prepaid_amount >= 0 AND prepaid_amount <= total AND (prepaid_amount = 0 OR kind = 'invoice'));
-- A prepayment is always received money on a sales order.
ALTER TABLE sales_documents ADD CONSTRAINT sales_documents_prepayment_check CHECK (kind <> 'prepayment' OR (sales_order_id IS NOT NULL AND payment_means <> 'credit'));
-- KSA-2 position 5: an export invoice (standard only, zero-rated supplies to a buyer outside the Kingdom).
ALTER TABLE sales_documents ADD COLUMN is_export boolean NOT NULL DEFAULT false;
ALTER TABLE sales_documents ADD CONSTRAINT sales_documents_export_check CHECK (NOT is_export OR (invoice_type = 'standard' AND kind <> 'prepayment'));

-- Which prepayment an invoice deducted, and how much of it (net and VAT): the final invoice's KSA-31/KSA-32.
CREATE TABLE prepayment_applications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id     uuid NOT NULL,
  prepayment_id  uuid NOT NULL,
  taxable        numeric(14,2) NOT NULL CHECK (taxable > 0),
  vat            numeric(14,2) NOT NULL CHECK (vat >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, invoice_id, prepayment_id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES sales_documents (tenant_id, id),
  FOREIGN KEY (tenant_id, prepayment_id) REFERENCES sales_documents (tenant_id, id)
);
CREATE INDEX prepayment_applications_prepayment_idx ON prepayment_applications (tenant_id, prepayment_id);
CREATE TRIGGER prepayment_applications_immutable BEFORE UPDATE OR DELETE ON prepayment_applications FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ── Reporting worker ──────────────────────────────────────────────────────────────────────────
-- Workspaces with a signed document never accepted or rejected, and whose last attempt is older than the retry
-- backoff (1, 5, 15, then 60 minutes). Only identifiers and counts leave this function; the worker then works
-- inside each workspace with its own RLS, acting as the device's creator.
CREATE FUNCTION zatca_pending_work(_limit integer DEFAULT 50)
RETURNS TABLE (tenant_id uuid, user_id uuid, pending integer, oldest timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
  WITH p AS (
    SELECT d.tenant_id, d.device_id, d.created_at,
           (SELECT count(*) FROM zatca_submissions s WHERE s.document_id = d.id) AS tries,
           (SELECT max(s.created_at) FROM zatca_submissions s WHERE s.document_id = d.id) AS last_try
      FROM zatca_documents d
     WHERE NOT EXISTS (SELECT 1 FROM zatca_submissions s WHERE s.document_id = d.id AND s.outcome <> 'error')
  )
  SELECT p.tenant_id, (SELECT v.created_by FROM zatca_devices v WHERE v.id = min(p.device_id::text)::uuid), count(*)::int, min(p.created_at)
    FROM p JOIN tenants t ON t.id = p.tenant_id
   WHERE tenant_is_operational(p.tenant_id)
     AND (p.last_try IS NULL OR p.last_try < now() - CASE WHEN p.tries <= 1 THEN interval '1 minute' WHEN p.tries = 2 THEN interval '5 minutes'
                                                        WHEN p.tries = 3 THEN interval '15 minutes' ELSE interval '60 minutes' END)
   GROUP BY p.tenant_id ORDER BY min(p.created_at) LIMIT _limit $$;
REVOKE ALL ON FUNCTION zatca_pending_work(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION zatca_pending_work(integer) TO munassiq_app;

DO $$
BEGIN
  PERFORM enable_tenant_rls('prepayment_applications'::regclass);
  PERFORM grant_app('prepayment_applications', 'SELECT, INSERT');
END $$;
