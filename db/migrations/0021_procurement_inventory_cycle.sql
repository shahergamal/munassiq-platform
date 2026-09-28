-- The complete purchasing and inventory document cycle.
--
--   Purchasing: requisition (a location asks) → approval → purchase order(s) per supplier → PO approval (owner above a
--   limit) → goods receipt notes, one per delivery (partial receipts, quality rejections, invoiced price, supplier
--   invoice number/date/amount for the three-way match) → supplier payable due by the supplier's terms → payment.
--   A PO is partially received, received, or closed short with a reason.
--   Inventory: transfers dispatch (goods in transit) and are received at the destination with any shortage recorded
--   and expensed; stocktakes can cover one category (cycle counts) and are counted with barcode scanners.
--
--   Goods receipts are append-only and each one posts its own journal entry. Received POs from before this migration
--   get one "legacy" receipt each (already posted under the PO, never posted again).

-- ── Settings read by the code ──────────────────────────────────────────────────────
-- Purchase orders above this amount (VAT included) can only be approved by the owner. NULL = no limit.
ALTER TABLE tenant_settings ADD COLUMN po_owner_approval_above numeric(14,2) CHECK (po_owner_approval_above IS NULL OR po_owner_approval_above >= 0);
-- Target level for reorder suggestions (base units). 0 = twice the minimum.
ALTER TABLE ingredients ADD COLUMN par_stock numeric(18,4) NOT NULL DEFAULT 0 CHECK (par_stock >= 0);

-- ── Purchase requisitions ──────────────────────────────────────────────────────────
CREATE TABLE purchase_requisitions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pr_number       bigint NOT NULL,
  location_id     uuid NOT NULL,
  needed_by       date,
  notes           text CHECK (notes IS NULL OR char_length(notes) <= 500),
  status          text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'approved', 'rejected', 'converted', 'cancelled')),
  decision_note   text CHECK (decision_note IS NULL OR char_length(decision_note) <= 300),
  idempotency_key uuid NOT NULL,
  requested_by    uuid NOT NULL,
  decided_by      uuid,
  decided_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, pr_number),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id)
);
CREATE INDEX purchase_requisitions_list_idx ON purchase_requisitions (tenant_id, created_at DESC);
CREATE TRIGGER purchase_requisitions_updated BEFORE UPDATE ON purchase_requisitions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE purchase_requisition_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  requisition_id    uuid NOT NULL,
  ingredient_id     uuid NOT NULL,
  quantity          numeric(18,4) NOT NULL CHECK (quantity > 0),   -- purchase units
  note              text CHECK (note IS NULL OR char_length(note) <= 200),
  purchase_order_id uuid,                                          -- set when converted
  UNIQUE (requisition_id, ingredient_id),
  FOREIGN KEY (tenant_id, requisition_id) REFERENCES purchase_requisitions (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, ingredient_id) REFERENCES ingredients (tenant_id, id),
  FOREIGN KEY (tenant_id, purchase_order_id) REFERENCES purchase_orders (tenant_id, id)
);

-- ── Purchase orders: partial receipt and closing short ─────────────────────────────
ALTER TABLE purchase_orders DROP CONSTRAINT purchase_orders_status_check;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_status_check
  CHECK (status IN ('draft', 'approved', 'partially_received', 'received', 'closed', 'cancelled'));
ALTER TABLE purchase_orders
  ADD COLUMN requisition_id uuid,
  ADD COLUMN expected_date date,
  ADD COLUMN notes text CHECK (notes IS NULL OR char_length(notes) <= 500),
  ADD COLUMN closed_reason text CHECK (closed_reason IS NULL OR char_length(closed_reason) <= 300),
  ADD COLUMN closed_by uuid,
  ADD COLUMN closed_at timestamptz,
  ADD CONSTRAINT purchase_orders_requisition_fk FOREIGN KEY (tenant_id, requisition_id) REFERENCES purchase_requisitions (tenant_id, id);
ALTER TABLE purchase_items ADD COLUMN received_quantity numeric(18,4) NOT NULL DEFAULT 0 CHECK (received_quantity >= 0);

-- ── Goods receipt notes ────────────────────────────────────────────────────────────
CREATE TABLE goods_receipts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  grn_number            bigint NOT NULL,
  purchase_order_id     uuid NOT NULL,
  supplier_id           uuid NOT NULL,
  location_id           uuid NOT NULL,
  received_on           date NOT NULL,
  supplier_invoice      text CHECK (supplier_invoice IS NULL OR char_length(supplier_invoice) <= 60),
  supplier_invoice_date date,
  -- What the supplier's invoice says (VAT included), for the three-way match. NULL = not entered.
  invoice_amount        numeric(14,2) CHECK (invoice_amount IS NULL OR invoice_amount >= 0),
  subtotal              numeric(14,2) NOT NULL CHECK (subtotal >= 0),   -- accepted lines at the invoiced price
  discount              numeric(14,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  shipping              numeric(14,2) NOT NULL DEFAULT 0 CHECK (shipping >= 0),
  fees                  numeric(14,2) NOT NULL DEFAULT 0 CHECK (fees >= 0),
  total                 numeric(14,2) NOT NULL CHECK (total >= 0),       -- net of VAT: inventory value
  vat_rate              numeric(5,2) NOT NULL DEFAULT 0,
  vat_amount            numeric(14,2) NOT NULL DEFAULT 0 CHECK (vat_amount >= 0),
  grand_total           numeric(14,2) GENERATED ALWAYS AS (total + vat_amount) STORED,
  notes                 text CHECK (notes IS NULL OR char_length(notes) <= 500),
  legacy                boolean NOT NULL DEFAULT false,
  idempotency_key       uuid NOT NULL,
  created_by            uuid NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, grn_number),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, purchase_order_id) REFERENCES purchase_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id)
);
CREATE INDEX goods_receipts_po_idx ON goods_receipts (tenant_id, purchase_order_id);
CREATE INDEX goods_receipts_supplier_idx ON goods_receipts (tenant_id, supplier_id, received_on);

CREATE TABLE goods_receipt_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  receipt_id        uuid NOT NULL,
  ingredient_id     uuid NOT NULL,
  quantity          numeric(18,4) NOT NULL CHECK (quantity >= 0),          -- accepted, purchase units
  rejected_quantity numeric(18,4) NOT NULL DEFAULT 0 CHECK (rejected_quantity >= 0),
  reject_reason     text CHECK (reject_reason IS NULL OR char_length(reject_reason) <= 200),
  ordered_price     numeric(14,4) NOT NULL CHECK (ordered_price >= 0),     -- per purchase unit on the PO
  unit_price        numeric(14,4) NOT NULL CHECK (unit_price >= 0),        -- as invoiced
  line_total        numeric(14,2) NOT NULL CHECK (line_total >= 0),
  unit_cost         numeric(18,6),                                         -- landed cost per base unit
  UNIQUE (receipt_id, ingredient_id),
  CHECK (quantity > 0 OR rejected_quantity > 0),
  CHECK (rejected_quantity = 0 OR reject_reason IS NOT NULL),
  FOREIGN KEY (tenant_id, receipt_id) REFERENCES goods_receipts (tenant_id, id),
  FOREIGN KEY (tenant_id, ingredient_id) REFERENCES ingredients (tenant_id, id)
);

-- Existing received purchase orders: one legacy receipt each, numbered in receipt order.
INSERT INTO goods_receipts (id, tenant_id, grn_number, purchase_order_id, supplier_id, location_id, received_on, supplier_invoice,
                            subtotal, discount, shipping, fees, total, vat_rate, vat_amount, legacy, idempotency_key, created_by, created_at)
SELECT gen_random_uuid(), p.tenant_id, row_number() OVER (PARTITION BY p.tenant_id ORDER BY p.received_at, p.po_number),
       p.id, p.supplier_id, p.location_id, (p.received_at AT TIME ZONE 'Asia/Riyadh')::date, p.supplier_invoice,
       p.subtotal, p.discount, p.shipping, p.fees, p.total, p.vat_rate, p.vat_amount, true, gen_random_uuid(),
       coalesce(p.received_by, p.created_by), p.received_at
  FROM purchase_orders p WHERE p.status = 'received';
INSERT INTO goods_receipt_items (tenant_id, receipt_id, ingredient_id, quantity, ordered_price, unit_price, line_total, unit_cost)
SELECT pi.tenant_id, g.id, pi.ingredient_id, pi.quantity, pi.unit_price, pi.unit_price, pi.line_total, pi.received_unit_cost
  FROM purchase_items pi JOIN goods_receipts g ON g.purchase_order_id = pi.purchase_order_id AND g.legacy;
UPDATE purchase_items pi SET received_quantity = pi.quantity FROM purchase_orders p WHERE p.id = pi.purchase_order_id AND p.status = 'received';
INSERT INTO tenant_counters (tenant_id, key, value)
SELECT tenant_id, 'grn', max(grn_number) FROM goods_receipts GROUP BY tenant_id
ON CONFLICT (tenant_id, key) DO UPDATE SET value = greatest(tenant_counters.value, EXCLUDED.value);

CREATE TRIGGER goods_receipts_immutable BEFORE UPDATE OR DELETE ON goods_receipts FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER goods_receipt_items_immutable BEFORE UPDATE OR DELETE ON goods_receipt_items FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ── Transfers: dispatch, in transit, receive with shortage ─────────────────────────
ALTER TABLE stock_transfers DROP CONSTRAINT stock_transfers_status_check;
ALTER TABLE stock_transfers ADD CONSTRAINT stock_transfers_status_check CHECK (status IN ('draft', 'in_transit', 'completed', 'cancelled'));
ALTER TABLE stock_transfers
  ADD COLUMN dispatched_by uuid,
  ADD COLUMN dispatched_at timestamptz,
  -- Value that left the source and did not arrive (expensed when received).
  ADD COLUMN shortage_value numeric(14,4) NOT NULL DEFAULT 0;
ALTER TABLE stock_transfer_items
  ADD COLUMN received_quantity numeric(18,4) CHECK (received_quantity IS NULL OR received_quantity >= 0),
  ADD COLUMN shortage_reason text CHECK (shortage_reason IS NULL OR char_length(shortage_reason) <= 200);

-- ── Barcodes: several per ingredient (a piece, a pack, a carton), each worth a quantity in base units ─
CREATE TABLE ingredient_barcodes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ingredient_id uuid NOT NULL,
  barcode       text NOT NULL CHECK (barcode ~ '^[0-9A-Za-z\-\.]{3,64}$'),
  base_quantity numeric(18,4) NOT NULL CHECK (base_quantity > 0),
  label         text CHECK (label IS NULL OR char_length(label) <= 60),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, barcode),
  FOREIGN KEY (tenant_id, ingredient_id) REFERENCES ingredients (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX ingredient_barcodes_ingredient_idx ON ingredient_barcodes (tenant_id, ingredient_id);

-- ── Stocktakes: a count can cover one category (cycle count) ───────────────────────
ALTER TABLE stocktakes ADD COLUMN category text CHECK (category IS NULL OR char_length(category) <= 80);
ALTER TABLE stocktakes ADD COLUMN scanned boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  PERFORM enable_tenant_rls('purchase_requisitions'::regclass);
  PERFORM enable_tenant_rls('purchase_requisition_items'::regclass);
  PERFORM enable_tenant_rls('goods_receipts'::regclass);
  PERFORM enable_tenant_rls('goods_receipt_items'::regclass);
  PERFORM enable_tenant_rls('ingredient_barcodes'::regclass);
  PERFORM grant_app('purchase_requisitions', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('purchase_requisition_items', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('goods_receipts', 'SELECT, INSERT');
  PERFORM grant_app('goods_receipt_items', 'SELECT, INSERT');
  PERFORM grant_app('ingredient_barcodes', 'SELECT, INSERT, UPDATE, DELETE');
END $$;
