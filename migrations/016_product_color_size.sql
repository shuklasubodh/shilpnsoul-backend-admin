ALTER TABLE product_color
  ADD COLUMN IF NOT EXISTS size TEXT NOT NULL DEFAULT '';

DROP INDEX IF EXISTS product_color_product_color_uidx;

CREATE UNIQUE INDEX IF NOT EXISTS product_color_product_color_size_uidx
  ON product_color(product_id, LOWER(BTRIM(color)), LOWER(BTRIM(size)));
