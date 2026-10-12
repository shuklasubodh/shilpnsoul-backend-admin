-- Optional customer contact channels, one-time verification consumption,
-- multi-channel order notifications, invitations, and password reset support.

UPDATE users SET phone = NULL WHERE BTRIM(COALESCE(phone, '')) = '';
UPDATE users SET whatsapp_number = NULL WHERE BTRIM(COALESCE(whatsapp_number, '')) = '';

ALTER TABLE users
  ALTER COLUMN phone DROP NOT NULL,
  ALTER COLUMN whatsapp_number DROP NOT NULL;

ALTER TABLE notification_verifications
  ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ;

ALTER TABLE notification_verifications
  DROP CONSTRAINT IF EXISTS notification_verifications_purpose_check;

ALTER TABLE notification_verifications
  ADD CONSTRAINT notification_verifications_purpose_check
  CHECK (purpose IN ('REGISTRATION', 'CHECKOUT', 'INVITATION', 'PASSWORD_RESET'));

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS notification_channels TEXT[];

UPDATE orders
SET notification_channels = ARRAY[COALESCE(notification_channel, 'EMAIL')]
WHERE notification_channels IS NULL;

ALTER TABLE orders
  ALTER COLUMN notification_channels SET DEFAULT ARRAY['EMAIL']::TEXT[],
  ALTER COLUMN notification_channels SET NOT NULL;

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_notification_channels_check;

ALTER TABLE orders
  ADD CONSTRAINT orders_notification_channels_check CHECK (
    cardinality(notification_channels) >= 1
    AND notification_channels <@ ARRAY['EMAIL', 'SMS', 'WHATSAPP']::TEXT[]
    AND notification_channels @> ARRAY['EMAIL']::TEXT[]
  );

CREATE TABLE IF NOT EXISTS user_invitations (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS user_invitations_open_user_idx
  ON user_invitations(user_id)
  WHERE accepted_at IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT contact_number
      FROM users
      CROSS JOIN LATERAL unnest(ARRAY[phone, whatsapp_number]) contact_number
      WHERE contact_number IS NOT NULL
      GROUP BY contact_number
      HAVING COUNT(DISTINCT users.id) > 1
    ) conflicts
  ) THEN
    RAISE EXCEPTION 'Cannot enforce contact uniqueness: the same phone/WhatsApp number belongs to multiple users.';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION enforce_unique_user_contact_numbers()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  contact_number TEXT;
BEGIN
  FOR contact_number IN
    SELECT DISTINCT value
    FROM unnest(ARRAY[NEW.phone, NEW.whatsapp_number]) value
    WHERE value IS NOT NULL
    ORDER BY value
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(contact_number, 0));
    IF EXISTS (
      SELECT 1 FROM users
      WHERE id IS DISTINCT FROM NEW.id
        AND (phone = contact_number OR whatsapp_number = contact_number)
    ) THEN
      RAISE EXCEPTION 'Contact number is already assigned to another user.'
        USING ERRCODE = '23505', CONSTRAINT = 'users_contact_number_unique';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS users_contact_number_unique_trigger ON users;
CREATE TRIGGER users_contact_number_unique_trigger
BEFORE INSERT OR UPDATE OF phone, whatsapp_number ON users
FOR EACH ROW EXECUTE FUNCTION enforce_unique_user_contact_numbers();

CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique
  ON users(phone) WHERE phone IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_whatsapp_unique
  ON users(whatsapp_number) WHERE whatsapp_number IS NOT NULL;
