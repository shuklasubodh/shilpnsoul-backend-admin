ALTER TABLE users
  ADD COLUMN IF NOT EXISTS whatsapp_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS whatsapp_number TEXT,
  ADD COLUMN IF NOT EXISTS preferred_notification_channel TEXT NOT NULL DEFAULT 'EMAIL',
  ADD COLUMN IF NOT EXISTS return_window_days INTEGER NOT NULL DEFAULT 2;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_preferred_notification_channel_check,
  DROP CONSTRAINT IF EXISTS users_return_window_days_check;

ALTER TABLE users
  ADD CONSTRAINT users_preferred_notification_channel_check
    CHECK (preferred_notification_channel IN ('EMAIL', 'SMS', 'WHATSAPP')),
  ADD CONSTRAINT users_return_window_days_check
    CHECK (return_window_days BETWEEN 0 AND 365);

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS contact_whatsapp TEXT,
  ADD COLUMN IF NOT EXISTS return_window_days INTEGER NOT NULL DEFAULT 2;

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_return_window_days_check;

ALTER TABLE orders
  ADD CONSTRAINT orders_return_window_days_check
    CHECK (return_window_days BETWEEN 0 AND 365);

UPDATE users SET whatsapp_number=phone WHERE whatsapp_number IS NULL;
UPDATE orders SET contact_whatsapp=contact_phone
  WHERE contact_whatsapp IS NULL AND notification_channel='WHATSAPP';

ALTER TABLE carts
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'PENDING';

ALTER TABLE carts
  DROP CONSTRAINT IF EXISTS carts_status_check;

ALTER TABLE carts
  ADD CONSTRAINT carts_status_check CHECK (status IN ('PENDING'));

CREATE TABLE IF NOT EXISTS order_action_requests (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  order_item_id BIGINT REFERENCES order_items(id) ON DELETE RESTRICT,
  action_type TEXT NOT NULL CHECK (action_type IN ('CANCEL', 'RETURN')),
  original_order_status TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'REVIEW' CHECK (status IN ('REVIEW', 'APPROVED', 'REJECTED')),
  quantity INTEGER,
  reason TEXT,
  requested_by_type TEXT NOT NULL CHECK (requested_by_type IN ('CUSTOMER', 'GUEST')),
  requested_by_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  decided_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ,
  decision_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (action_type = 'CANCEL' AND order_item_id IS NULL AND quantity IS NULL)
    OR (action_type = 'RETURN' AND order_item_id IS NOT NULL AND quantity > 0)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS order_action_open_cancel_idx
  ON order_action_requests(order_id, action_type)
  WHERE action_type = 'CANCEL' AND status = 'REVIEW';

CREATE UNIQUE INDEX IF NOT EXISTS order_action_open_return_item_idx
  ON order_action_requests(order_id, order_item_id, action_type)
  WHERE action_type = 'RETURN' AND status = 'REVIEW';

CREATE INDEX IF NOT EXISTS order_action_requests_order_idx
  ON order_action_requests(order_id, requested_at DESC);
