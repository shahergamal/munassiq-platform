-- 0045_contracting_units: a contracting workspace got the restaurant subset of units (no ton, cubic metre, roll,
-- sheet…), which construction materials need; and length and area had no dimension at all (rebar, cable, tiles).
ALTER TABLE units DROP CONSTRAINT units_dimension_check;
ALTER TABLE units ADD CONSTRAINT units_dimension_check CHECK (dimension IN ('mass', 'volume', 'count', 'length', 'area'));

CREATE OR REPLACE FUNCTION seed_units(_t uuid, _sector text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO units (tenant_id, code, name, dimension, to_base)
  SELECT _t, v.code, v.name, v.dimension, v.to_base FROM (VALUES
    ('kg', 'كيلوجرام', 'mass', 1000), ('g', 'جرام', 'mass', 1), ('ton', 'طن', 'mass', 1000000),
    ('l', 'لتر', 'volume', 1000), ('ml', 'مل', 'volume', 1), ('m3', 'متر مكعب', 'volume', 1000000),
    ('pcs', 'حبة', 'count', 1), ('dozen', 'دزينة', 'count', 12), ('carton', 'كرتون', 'count', 1), ('pack', 'عبوة', 'count', 1),
    ('bag', 'كيس', 'count', 1), ('box', 'علبة', 'count', 1), ('bottle', 'زجاجة', 'count', 1),
    ('drum', 'برميل', 'count', 1), ('pallet', 'طبلية', 'count', 1), ('roll', 'لفة', 'count', 1), ('sheet', 'لوح', 'count', 1), ('set', 'طقم', 'count', 1),
    ('m', 'متر', 'length', 1), ('m2', 'متر مربع', 'area', 1)
  ) AS v(code, name, dimension, to_base)
  WHERE (_sector = 'manufacturing' AND v.dimension NOT IN ('length', 'area')) OR _sector = 'contracting'
     OR v.code NOT IN ('ton', 'm3', 'drum', 'pallet', 'roll', 'sheet', 'set', 'm', 'm2')
  ON CONFLICT (tenant_id, code) DO NOTHING;
END $$;
DO $$ DECLARE _t uuid; BEGIN FOR _t IN SELECT id FROM tenants WHERE sector = 'contracting' LOOP PERFORM seed_units(_t, 'contracting'); END LOOP; END $$;
