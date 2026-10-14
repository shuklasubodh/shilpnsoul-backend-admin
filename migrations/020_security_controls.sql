-- Scoped guest capabilities, verification isolation, replay protection, and
-- canonical contact locking. This migration is additive and preserves data.

ALTER TABLE notification_verifications
  ADD COLUMN IF NOT EXISTS subject_type TEXT,
  ADD COLUMN IF NOT EXISTS subject_id TEXT,
  ADD COLUMN IF NOT EXISTS public_id TEXT,
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;

UPDATE notification_verifications
SET subject_type = CASE WHEN user_id IS NULL THEN 'GUEST' ELSE 'CUSTOMER' END
WHERE subject_type IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS notification_verifications_public_id_uidx
  ON notification_verifications(public_id) WHERE public_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS notification_verifications_active_idx
  ON notification_verifications(purpose, channel, destination, subject_type, subject_id, created_at DESC)
  WHERE consumed_at IS NULL AND superseded_at IS NULL;

ALTER TABLE notification_verifications
  DROP CONSTRAINT IF EXISTS notification_verifications_purpose_check;

ALTER TABLE notification_verifications
  ADD CONSTRAINT notification_verifications_purpose_check CHECK (
    purpose IN ('REGISTRATION', 'CHECKOUT', 'INVITATION', 'PASSWORD_RESET',
                'INITIAL_ADMIN', 'GUEST_ORDER_ACCESS', 'ACCOUNT_CONTACT_CHANGE')
  );

CREATE TABLE IF NOT EXISTS order_access_grants (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT[] NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (cardinality(scopes) >= 1),
  CHECK (scopes <@ ARRAY['CHECKOUT','PAYMENT_READ','RELEASE','READ','RESEND','ACTION']::TEXT[])
);

CREATE INDEX IF NOT EXISTS order_access_grants_order_idx
  ON order_access_grants(order_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS auth_sessions (
  session_id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS auth_sessions_user_idx
  ON auth_sessions(user_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Serialize all mutations that assign an email, SMS number, or WhatsApp number
-- to a customer. Order creation takes the same locks before its final check.
CREATE OR REPLACE FUNCTION lock_user_contact_identities()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  identity_key TEXT;
BEGIN
  FOR identity_key IN
    SELECT DISTINCT value FROM unnest(ARRAY[
      CASE WHEN NEW.email IS NULL THEN NULL ELSE 'email:' || LOWER(BTRIM(NEW.email)) END,
      CASE WHEN NEW.phone IS NULL THEN NULL ELSE 'phone:' || NEW.phone END,
      CASE WHEN NEW.whatsapp_number IS NULL THEN NULL ELSE 'phone:' || NEW.whatsapp_number END
    ]) value
    WHERE value IS NOT NULL
    ORDER BY value
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(identity_key, 0));
  END LOOP;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS users_contact_identity_lock_trigger ON users;
CREATE TRIGGER users_contact_identity_lock_trigger
BEFORE INSERT OR UPDATE OF email, phone, whatsapp_number ON users
FOR EACH ROW EXECUTE FUNCTION lock_user_contact_identities();

