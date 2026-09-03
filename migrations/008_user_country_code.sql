ALTER TABLE users ADD COLUMN IF NOT EXISTS country_code TEXT;

UPDATE users SET country_code = '+65' WHERE country_code IS NULL;

ALTER TABLE users
  ALTER COLUMN country_code SET DEFAULT '+65',
  ALTER COLUMN country_code SET NOT NULL;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_country_code_format;
ALTER TABLE users ADD CONSTRAINT users_country_code_format
  CHECK (country_code ~ '^\+[1-9][0-9]{0,3}$');
