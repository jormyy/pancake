-- Canonical SQL source for public.name_key.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION name_key(n text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT
  SET search_path = public
  AS $$
  SELECT trim(regexp_replace(
    regexp_replace(
      regexp_replace(extensions.unaccent(lower(n)), '\s+(jr\.?|sr\.?|ii|iii|iv|v)$', ''),
      '[^a-z0-9 ]', '', 'g'
    ),
    '\s+', ' ', 'g'
  ))
$$;
