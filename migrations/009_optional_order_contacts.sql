ALTER TABLE orders
  ALTER COLUMN shipping_phone DROP NOT NULL,
  ALTER COLUMN contact_email DROP NOT NULL,
  ALTER COLUMN contact_phone DROP NOT NULL;

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS chk_orders_shipping_phone_not_blank,
  DROP CONSTRAINT IF EXISTS chk_orders_contact_email_not_blank,
  DROP CONSTRAINT IF EXISTS chk_orders_contact_phone_not_blank,
  DROP CONSTRAINT IF EXISTS chk_orders_contact_required;

ALTER TABLE orders
  ADD CONSTRAINT chk_orders_contact_required CHECK (
    NULLIF(BTRIM(contact_email), '') IS NOT NULL
    OR NULLIF(BTRIM(contact_phone), '') IS NOT NULL
  );
