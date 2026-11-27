-- Canonical SQL source for private.rookie_name_key.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.rookie_name_key(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT NULLIF(regexp_replace(regexp_replace(
    lower(regexp_replace(normalize(COALESCE(p_name, ''), NFD), '[̀-ͯ]', '', 'g')),
    '\m(jr|sr|ii|iii|iv)\M', '', 'g'), '[^a-z0-9]', '', 'g'), '')
$$;
