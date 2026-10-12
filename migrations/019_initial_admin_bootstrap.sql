-- Permanent, one-time store bootstrap state. Existing installations are
-- considered complete so applying this migration can never reopen setup.

ALTER TABLE notification_verifications
  ADD COLUMN IF NOT EXISTS context_hash TEXT;

ALTER TABLE notification_verifications
  DROP CONSTRAINT IF EXISTS notification_verifications_purpose_check;

ALTER TABLE notification_verifications
  ADD CONSTRAINT notification_verifications_purpose_check
  CHECK (purpose IN ('REGISTRATION', 'CHECKOUT', 'INVITATION', 'PASSWORD_RESET', 'INITIAL_ADMIN'));

CREATE TABLE IF NOT EXISTS system_bootstrap (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'COMPLETED')),
  admin_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (status = 'PENDING' AND completed_at IS NULL)
    OR (status = 'COMPLETED' AND completed_at IS NOT NULL)
  )
);

INSERT INTO system_bootstrap(id, status, admin_user_id, completed_at)
SELECT
  1,
  CASE WHEN EXISTS (SELECT 1 FROM users) THEN 'COMPLETED' ELSE 'PENDING' END,
  (SELECT id FROM users WHERE role = 'ADMIN' ORDER BY id LIMIT 1),
  CASE WHEN EXISTS (SELECT 1 FROM users) THEN NOW() ELSE NULL END
ON CONFLICT (id) DO NOTHING;

CREATE INDEX IF NOT EXISTS notification_verifications_initial_admin_idx
  ON notification_verifications(purpose, destination, created_at DESC)
  WHERE purpose = 'INITIAL_ADMIN';
