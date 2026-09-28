CREATE TABLE IF NOT EXISTS security_rate_limits (
  rate_key text PRIMARY KEY,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  window_started_at timestamptz NOT NULL DEFAULT NOW(),
  blocked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS security_rate_limits_cleanup_idx
  ON security_rate_limits(updated_at);
