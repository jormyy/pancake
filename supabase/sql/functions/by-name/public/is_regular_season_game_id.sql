-- Canonical SQL source for public.is_regular_season_game_id.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.is_regular_season_game_id(p_game_id text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_game_id IS NULL OR btrim(p_game_id) = '' THEN false
    WHEN btrim(p_game_id) LIKE '002%' THEN true
    WHEN btrim(p_game_id) ~ '^00[0-9]' THEN false
    ELSE true
  END
$$;
