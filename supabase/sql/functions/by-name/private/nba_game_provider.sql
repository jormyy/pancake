-- Canonical SQL source for private.nba_game_provider.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.nba_game_provider(p_id text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE WHEN p_id ~ '^[0-9]{10}$' THEN 'nba'
    WHEN p_id ~ '^[0-9]{8}0[A-Za-z]{3}$' THEN 'bbref' ELSE 'unknown' END;
$$;
