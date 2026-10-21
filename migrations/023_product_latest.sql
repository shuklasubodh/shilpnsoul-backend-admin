ALTER TABLE products
  ADD COLUMN IF NOT EXISTS latest CHAR(1) NOT NULL DEFAULT 'F';

UPDATE products
SET latest = 'F'
WHERE latest IS NULL OR UPPER(latest) NOT IN ('T', 'F');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_latest_flag_valid'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT products_latest_flag_valid CHECK (latest IN ('T', 'F'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS products_latest_active_idx
  ON products(latest, is_active, category_id);
