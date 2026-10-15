-- HttpOnly browser sessions, revocable administrator sessions, and one-time
-- invalidation of privileged invitation links created before this rollout.

ALTER TABLE auth_sessions
  ADD COLUMN IF NOT EXISTS csrf_token_hash TEXT;

ALTER TABLE order_access_grants
  ADD COLUMN IF NOT EXISTS csrf_token_hash TEXT;

CREATE TABLE IF NOT EXISTS admin_auth_sessions (
  session_id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS admin_auth_sessions_user_idx
  ON admin_auth_sessions(user_id, expires_at DESC);

UPDATE user_invitations invitation
SET expires_at = NOW()
FROM users
WHERE users.id = invitation.user_id
  AND UPPER(users.role) = 'ADMIN'
  AND invitation.accepted_at IS NULL
  AND invitation.expires_at > NOW();
