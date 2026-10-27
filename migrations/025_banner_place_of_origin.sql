ALTER TABLE banners
  ADD COLUMN IF NOT EXISTS place_of_origin TEXT NOT NULL DEFAULT '';

-- Preserve routing for banners created before origin was stored explicitly.
UPDATE banners
SET place_of_origin = CASE
  WHEN LOWER(CONCAT_WS(' ', title, alt_text)) ~ '(rajasthan|jaipur|jodhpur|hawa[ -]?mahal|mehrangarh|mahrangarh)' THEN 'Rajasthan'
  WHEN LOWER(CONCAT_WS(' ', title, alt_text)) ~ '(uttar[ -]?pradesh|agra|taj[ -]?mahal|lucknow|elephant[ -]?park)' THEN 'Uttar Pradesh'
  WHEN LOWER(CONCAT_WS(' ', title, alt_text)) LIKE '%diwali%' THEN 'Diwali'
  ELSE place_of_origin
END
WHERE place_of_origin = '';

CREATE INDEX IF NOT EXISTS banners_place_of_origin_idx
  ON banners (place_of_origin, is_active, sort_order);
