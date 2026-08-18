CREATE TABLE IF NOT EXISTS product_images (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  blob_url TEXT NOT NULL,
  blob_pathname TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (product_id, blob_url)
);

CREATE INDEX IF NOT EXISTS product_images_product_id_idx
  ON product_images(product_id, sort_order, id);

CREATE UNIQUE INDEX IF NOT EXISTS product_images_one_primary_idx
  ON product_images(product_id) WHERE is_primary;
