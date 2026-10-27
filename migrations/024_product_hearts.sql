CREATE TABLE IF NOT EXISTS product_hearts (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  guest_session_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT product_hearts_one_actor CHECK (
    (user_id IS NOT NULL AND guest_session_hash IS NULL)
    OR (user_id IS NULL AND guest_session_hash IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS product_hearts_user_unique
  ON product_hearts(product_id, user_id)
  WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS product_hearts_guest_unique
  ON product_hearts(product_id, guest_session_hash)
  WHERE guest_session_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS product_hearts_product_idx
  ON product_hearts(product_id);
