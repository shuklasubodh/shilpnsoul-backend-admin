CREATE TABLE IF NOT EXISTS banners (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  alt_text TEXT NOT NULL DEFAULT '',
  link_url TEXT NOT NULL DEFAULT '',
  blob_url TEXT NOT NULL UNIQUE,
  blob_pathname TEXT NOT NULL UNIQUE CHECK (blob_pathname LIKE 'banner/%'),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS banners_display_idx
  ON banners(is_active, sort_order, id);
