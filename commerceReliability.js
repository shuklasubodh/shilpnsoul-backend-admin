import sql from './db.js'

let schemaPromise

export const ensureCommerceReliabilitySchema = () => {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const ready = (await sql.query(`
        SELECT
          to_regclass('checkout_requests') IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid='notification_deliveries'::regclass
              AND conname='notification_deliveries_notification_type_check'
              AND pg_get_constraintdef(oid) LIKE '%ADMIN_ORDER_ALERT%'
          ) AS schema_ready
      `))[0]
      if (ready?.schema_ready) return

      await sql.query(`
        CREATE TABLE IF NOT EXISTS checkout_requests (
          request_id UUID PRIMARY KEY,
          subject_type TEXT NOT NULL CHECK (subject_type IN ('CUSTOMER','GUEST')),
          subject_id TEXT NOT NULL,
          order_id BIGINT UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `)
      await sql.query(`
        CREATE INDEX IF NOT EXISTS checkout_requests_subject_idx
        ON checkout_requests(subject_type,subject_id,created_at DESC)
      `)
      await sql.query(`
        DO $$ BEGIN
          PERFORM pg_advisory_xact_lock(hashtext('shilpnsoul:checkout-reliability-schema'));
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid='notification_deliveries'::regclass
              AND conname='notification_deliveries_notification_type_check'
              AND pg_get_constraintdef(oid) LIKE '%ADMIN_ORDER_ALERT%'
          ) THEN
            ALTER TABLE notification_deliveries DROP CONSTRAINT IF EXISTS notification_deliveries_notification_type_check;
            ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_notification_type_check
              CHECK (notification_type IN ('OTP','ORDER_SUMMARY','ADMIN_ORDER_ALERT'));
          END IF;
        END $$
      `)
    })().catch((error) => {
      schemaPromise = null
      throw error
    })
  }
  return schemaPromise
}
