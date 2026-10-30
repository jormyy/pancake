-- Canonical SQL source for private.valid_player_birthdate.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.valid_player_birthdate(p_birthdate date)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT p_birthdate >= DATE '1900-01-01' AND p_birthdate <= now()::date;
$$;
