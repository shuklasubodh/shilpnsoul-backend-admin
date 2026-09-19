ALTER TABLE products
  ADD COLUMN IF NOT EXISTS optimize_for_mobile BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE products SET optimize_for_mobile = TRUE WHERE optimize_for_mobile IS DISTINCT FROM TRUE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_mobile_optimization_required'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT products_mobile_optimization_required CHECK (optimize_for_mobile = TRUE);
  END IF;
END $$;
