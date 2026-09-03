-- Captures products requested by customers that are not currently available.
-- Intended for storefront chatbot submissions and other future demand sources.
CREATE TABLE IF NOT EXISTS market_requirements (
  id BIGSERIAL PRIMARY KEY,

  product_requested VARCHAR(255) NOT NULL,
  category VARCHAR(150) NOT NULL,
  free_text TEXT,

  requester_name VARCHAR(255),
  requester_email VARCHAR(320),

  source VARCHAR(50) NOT NULL DEFAULT 'STOREFRONT_CHATBOT',

  status VARCHAR(30) NOT NULL DEFAULT 'NEW'
    CHECK (status IN ('NEW', 'REVIEWING', 'PLANNED', 'DECLINED')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE market_requirements IS
  'Customer product requests used to evaluate unmet market demand.';
COMMENT ON COLUMN market_requirements.product_requested IS
  'Short name or description of the product requested by the customer.';
COMMENT ON COLUMN market_requirements.category IS
  'Product category supplied by the customer or request-capture channel.';
COMMENT ON COLUMN market_requirements.free_text IS
  'Optional requirements, preferences, quantities, or other customer context.';
COMMENT ON COLUMN market_requirements.requester_name IS
  'Optional requester name for follow-up.';
COMMENT ON COLUMN market_requirements.requester_email IS
  'Optional requester email address for follow-up.';
COMMENT ON COLUMN market_requirements.source IS
  'Channel that captured the request; defaults to STOREFRONT_CHATBOT.';
COMMENT ON COLUMN market_requirements.status IS
  'Review workflow: NEW, REVIEWING, PLANNED, or DECLINED.';

CREATE INDEX IF NOT EXISTS idx_market_requirements_status
  ON market_requirements (status);

CREATE INDEX IF NOT EXISTS idx_market_requirements_category
  ON market_requirements (category);

CREATE INDEX IF NOT EXISTS idx_market_requirements_created_at
  ON market_requirements (created_at DESC);

CREATE OR REPLACE FUNCTION update_market_requirements_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_market_requirements_updated_at
  ON market_requirements;

CREATE TRIGGER trg_market_requirements_updated_at
BEFORE UPDATE ON market_requirements
FOR EACH ROW
EXECUTE FUNCTION update_market_requirements_timestamp();

-- Example usage (documentation only; this migration does not insert sample data):
-- INSERT INTO market_requirements (
--   product_requested,
--   category,
--   free_text,
--   requester_name,
--   requester_email,
--   source
-- ) VALUES (
--   'Hand-painted ceramic dinner set',
--   'Tableware',
--   'Looking for a blue set for six people.',
--   'Customer Name',
--   'customer@example.com',
--   'STOREFRONT_CHATBOT'
-- );
