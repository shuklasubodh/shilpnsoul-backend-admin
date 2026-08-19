ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS customer_hidden_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS order_events (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  from_payment_status TEXT,
  to_payment_status TEXT,
  actor_type TEXT NOT NULL DEFAULT 'SYSTEM',
  actor_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS order_events_order_id_idx
  ON order_events(order_id, created_at, id);

CREATE INDEX IF NOT EXISTS orders_archive_eligibility_idx
  ON orders(updated_at)
  WHERE payment_status = 'PAID' OR status IN ('CANCELLED', 'RETURNED');

INSERT INTO order_events (
  order_id, event_type, to_status, to_payment_status, actor_type, metadata, created_at
)
SELECT
  o.id, 'HISTORY_SNAPSHOT', o.status, o.payment_status, 'SYSTEM',
  jsonb_build_object('reason', 'order history migration'), o.updated_at
FROM orders o
WHERE (o.payment_status = 'PAID' OR o.status IN ('CANCELLED', 'RETURNED'))
  AND NOT EXISTS (
    SELECT 1 FROM order_events oe
    WHERE oe.order_id = o.id AND oe.event_type = 'HISTORY_SNAPSHOT'
  );
