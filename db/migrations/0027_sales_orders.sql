-- 0027_sales_orders: the order-to-cash cycle for factories (docs/manufacturing/ARCHITECTURE.md, M3).
--   quotation → confirmed order (reserves stock: available = on hand − open orders) → delivery notes (stock out at
--   average cost, earliest expiry first, cost of sales posted) → tax invoices from what was delivered (the existing
--   ZATCA engine) → returns (stock back at the delivered cost). A customer's credit limit caps confirmation.

ALTER TABLE ingredients ADD COLUMN sale_price numeric(14,2) CHECK (sale_price IS NULL OR sale_price >= 0);
ALTER TABLE customers ADD COLUMN credit_limit numeric(14,2) CHECK (credit_limit IS NULL OR credit_limit >= 0);

CREATE TABLE sales_orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  so_number        bigint NOT NULL,
  customer_id      uuid NOT NULL,
  location_id      uuid NOT NULL,
  status           text NOT NULL DEFAULT 'quotation' CHECK (status IN ('quotation', 'confirmed', 'closed', 'cancelled')),
  order_date       date NOT NULL,
  valid_until      date,
  delivery_date    date,
  customer_ref     text CHECK (customer_ref IS NULL OR char_length(customer_ref) <= 60),
  notes            text CHECK (notes IS NULL OR char_length(notes) <= 1000),
  -- Server-computed from the lines (VAT at the workspace rate on standard-rated lines).
  subtotal         numeric(14,2) NOT NULL DEFAULT 0,
  discount         numeric(14,2) NOT NULL DEFAULT 0,
  taxable          numeric(14,2) NOT NULL DEFAULT 0,
  vat              numeric(14,2) NOT NULL DEFAULT 0,
  total            numeric(14,2) NOT NULL DEFAULT 0,
  idempotency_key  uuid NOT NULL,
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  confirmed_at     timestamptz,
  confirmed_by     uuid,
  closed_at        timestamptz,
  cancelled_at     timestamptz,
  cancel_reason    text,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, so_number),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id)
);
CREATE INDEX sales_orders_status_idx ON sales_orders (tenant_id, status, so_number DESC);

CREATE TABLE sales_order_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id        uuid NOT NULL,
  line_no         integer NOT NULL,
  item_id         uuid NOT NULL,
  description     text NOT NULL CHECK (char_length(trim(description)) BETWEEN 1 AND 300),
  quantity        numeric(18,4) NOT NULL CHECK (quantity > 0),
  unit_price      numeric(14,2) NOT NULL CHECK (unit_price >= 0),
  discount        numeric(14,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  vat_category    text NOT NULL DEFAULT 'S' CHECK (vat_category IN ('S', 'Z', 'E', 'O')),
  exemption_code  text,
  exemption_reason text,
  -- Running totals (updated with each delivery, return and invoice in the same transaction).
  delivered_qty   numeric(18,4) NOT NULL DEFAULT 0 CHECK (delivered_qty >= 0),
  invoiced_qty    numeric(18,4) NOT NULL DEFAULT 0 CHECK (invoiced_qty >= 0),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, order_id, line_no),
  CHECK (delivered_qty <= quantity),
  CHECK (vat_category = 'S' OR exemption_code IS NOT NULL),
  FOREIGN KEY (tenant_id, order_id) REFERENCES sales_orders (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id) REFERENCES ingredients (tenant_id, id)
);
CREATE INDEX sales_order_lines_item_idx ON sales_order_lines (tenant_id, item_id);

-- Delivery notes and customer returns: immutable, each posts cost of sales (or its reversal).
CREATE TABLE deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  delivery_number bigint NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('delivery', 'return')),
  order_id        uuid NOT NULL,
  location_id     uuid NOT NULL,
  delivered_on    date NOT NULL,
  -- Lines: order line, item, quantity, unit cost, value, batches (shape written by routes/sales/orders.ts).
  lines           jsonb NOT NULL,
  value           numeric(14,2) NOT NULL CHECK (value >= 0),
  reason          text CHECK (reason IS NULL OR char_length(reason) <= 300),
  driver          text CHECK (driver IS NULL OR char_length(driver) <= 120),
  idempotency_key uuid NOT NULL,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, kind, delivery_number),
  UNIQUE (tenant_id, idempotency_key),
  CHECK (kind = 'delivery' OR reason IS NOT NULL),
  FOREIGN KEY (tenant_id, order_id) REFERENCES sales_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id)
);
CREATE INDEX deliveries_order_idx ON deliveries (tenant_id, order_id, created_at);
CREATE TRIGGER deliveries_append_only BEFORE UPDATE OR DELETE ON deliveries FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Invoices know the order they bill, and their lines the item.
ALTER TABLE sales_documents ADD COLUMN sales_order_id uuid;
ALTER TABLE sales_documents ADD CONSTRAINT sales_documents_order_fk FOREIGN KEY (tenant_id, sales_order_id) REFERENCES sales_orders (tenant_id, id);
CREATE INDEX sales_documents_order_idx ON sales_documents (tenant_id, sales_order_id) WHERE sales_order_id IS NOT NULL;
ALTER TABLE sales_document_lines ADD COLUMN item_id uuid;
ALTER TABLE sales_document_lines ADD CONSTRAINT sales_document_lines_item_fk FOREIGN KEY (tenant_id, item_id) REFERENCES ingredients (tenant_id, id);

-- Stock that leaves for a customer, or comes back.
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_movement_type_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_movement_type_check
  CHECK (movement_type IN ('purchase', 'sale', 'refund_return', 'transfer_out', 'transfer_in', 'waste', 'count_adjustment',
                           'production_in', 'production_out', 'purchase_return', 'delivery', 'customer_return'));

DO $$
BEGIN
  PERFORM enable_tenant_rls('sales_orders'::regclass);
  PERFORM enable_tenant_rls('sales_order_lines'::regclass);
  PERFORM enable_tenant_rls('deliveries'::regclass);
  PERFORM grant_app('sales_orders', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('sales_order_lines', 'SELECT, INSERT, UPDATE, DELETE');
  PERFORM grant_app('deliveries', 'SELECT, INSERT');
END $$;
