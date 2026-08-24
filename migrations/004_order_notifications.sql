ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ;

ALTER TABLE orders
  ALTER COLUMN user_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS notification_channel TEXT,
  ADD COLUMN IF NOT EXISTS notification_destination TEXT;

ALTER TABLE payments
  ALTER COLUMN user_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS notification_verifications (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('EMAIL', 'WHATSAPP')),
  destination TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('REGISTRATION', 'CHECKOUT')),
  code_hash TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS notification_verifications_rate_idx
  ON notification_verifications(channel, destination, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT REFERENCES orders(id) ON DELETE RESTRICT,
  verification_id BIGINT REFERENCES notification_verifications(id) ON DELETE SET NULL,
  notification_type TEXT NOT NULL CHECK (notification_type IN ('OTP', 'ORDER_SUMMARY')),
  channel TEXT NOT NULL CHECK (channel IN ('EMAIL', 'WHATSAPP')),
  destination TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_message_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'ACCEPTED', 'DELIVERED', 'FAILED', 'BOUNCED', 'COMPLAINED', 'SUPPRESSED')),
  error_message TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS notification_deliveries_order_idx
  ON notification_deliveries(order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS notification_deliveries_destination_idx
  ON notification_deliveries(channel, destination, created_at DESC);
