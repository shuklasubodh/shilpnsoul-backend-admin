DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM users
    GROUP BY LOWER(BTRIM(email))
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce unique user emails: normalized duplicates exist.';
  END IF;
END $$;

UPDATE users SET email = LOWER(BTRIM(email));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'users'::regclass
      AND conname = 'users_email_unique'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_email_unique UNIQUE (email);
  END IF;
END $$;
