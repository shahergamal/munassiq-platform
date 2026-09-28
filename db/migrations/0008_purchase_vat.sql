-- Input VAT on purchases. `total` stays VAT-exclusive: it is the landed cost that goes into inventory,
-- because VAT is recoverable and never part of cost. What we owe the supplier is `grand_total`.
ALTER TABLE purchase_orders
  ADD COLUMN vat_rate   numeric(5,2)  NOT NULL DEFAULT 0 CHECK (vat_rate BETWEEN 0 AND 100),
  ADD COLUMN vat_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (vat_amount >= 0),
  ADD COLUMN grand_total numeric(14,2) GENERATED ALWAYS AS (total + vat_amount) STORED;

-- A return reverses the input VAT of what goes back. total_value stays the cost value that left stock.
ALTER TABLE purchase_returns
  ADD COLUMN vat_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (vat_amount >= 0);
