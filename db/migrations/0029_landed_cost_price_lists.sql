-- 0029_landed_cost_price_lists: the rest of M3 (docs/manufacturing/ARCHITECTURE.md).
--   * how a purchase order's shipping and fees (freight, insurance, customs, clearance) are spread over its lines
--   * customer price lists: the price a quotation proposes for a customer, before the item's own sale price

-- value: by line value (the default, as before); quantity: by base quantity; weight: by mass (items counted in
-- mass units), falling back to value when nothing on the receipt has a weight.
ALTER TABLE purchase_orders ADD COLUMN cost_allocation text NOT NULL DEFAULT 'value' CHECK (cost_allocation IN ('value', 'quantity', 'weight'));

CREATE TABLE price_lists (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (char_length(trim(name)) BETWEEN 2 AND 120),
  notes      text CHECK (notes IS NULL OR char_length(notes) <= 500),
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);
CREATE TABLE price_list_items (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  list_id    uuid NOT NULL,
  item_id    uuid NOT NULL,
  -- Per base unit, VAT excluded.
  price      numeric(14,2) NOT NULL CHECK (price >= 0),
  PRIMARY KEY (tenant_id, list_id, item_id),
  FOREIGN KEY (tenant_id, list_id) REFERENCES price_lists (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id) REFERENCES ingredients (tenant_id, id)
);
ALTER TABLE customers ADD COLUMN price_list_id uuid;
ALTER TABLE customers ADD CONSTRAINT customers_price_list_fk FOREIGN KEY (tenant_id, price_list_id) REFERENCES price_lists (tenant_id, id);

DO $$
BEGIN
  PERFORM enable_tenant_rls('price_lists'::regclass);
  PERFORM enable_tenant_rls('price_list_items'::regclass);
  PERFORM grant_app('price_lists', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('price_list_items', 'SELECT, INSERT, UPDATE, DELETE');
END $$;
