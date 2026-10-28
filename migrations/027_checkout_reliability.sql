CREATE TABLE IF NOT EXISTS checkout_requests (
  request_id UUID PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('CUSTOMER', 'GUEST')),
  subject_id TEXT NOT NULL,
  order_id BIGINT UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS checkout_requests_subject_idx
  ON checkout_requests(subject_type, subject_id, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'notification_deliveries'::regclass
      AND conname = 'notification_deliveries_notification_type_check'
      AND pg_get_constraintdef(oid) LIKE '%ADMIN_ORDER_ALERT%'
  ) THEN
    ALTER TABLE notification_deliveries
      DROP CONSTRAINT IF EXISTS notification_deliveries_notification_type_check;
    ALTER TABLE notification_deliveries
      ADD CONSTRAINT notification_deliveries_notification_type_check
      CHECK (notification_type IN ('OTP', 'ORDER_SUMMARY', 'ADMIN_ORDER_ALERT'));
  END IF;
END $$;
