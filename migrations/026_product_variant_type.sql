DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'products'
      AND column_name = 'variant_type'
  ) THEN
    ALTER TABLE products ADD COLUMN variant_type TEXT NOT NULL DEFAULT 'NONE';

    UPDATE products p
    SET variant_type = CASE
      WHEN EXISTS (
        SELECT 1 FROM product_color pc
        WHERE pc.product_id = p.id AND BTRIM(COALESCE(pc.size, '')) <> ''
      ) THEN 'BOTH'
      WHEN EXISTS (SELECT 1 FROM product_color pc WHERE pc.product_id = p.id) THEN 'COLOR'
      ELSE 'NONE'
    END;
  END IF;
END $$;

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_variant_type_check;
ALTER TABLE products ADD CONSTRAINT products_variant_type_check
  CHECK (variant_type IN ('COLOR', 'SIZE', 'BOTH', 'NONE'));

-- Size-only variants use an empty color value. Product-level validation decides
-- which fields are required for each variant type.
ALTER TABLE product_color DROP CONSTRAINT IF EXISTS product_color_color_check;
ALTER TABLE product_color ALTER COLUMN color SET DEFAULT '';

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS size TEXT;

CREATE OR REPLACE FUNCTION sync_product_stock_from_colors() RETURNS TRIGGER AS $$
DECLARE affected_product_id BIGINT;
BEGIN
  affected_product_id := CASE WHEN TG_OP='DELETE' THEN OLD.product_id ELSE NEW.product_id END;
  UPDATE products
  SET stock_quantity = COALESCE((SELECT SUM(quantity) FROM product_color WHERE product_id=affected_product_id), 0),
      updated_at = NOW()
  WHERE id=affected_product_id AND variant_type <> 'NONE';
  IF TG_OP='UPDATE' AND OLD.product_id<>NEW.product_id THEN
    UPDATE products
    SET stock_quantity=COALESCE((SELECT SUM(quantity) FROM product_color WHERE product_id=OLD.product_id),0),
        updated_at=NOW()
    WHERE id=OLD.product_id AND variant_type <> 'NONE';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
