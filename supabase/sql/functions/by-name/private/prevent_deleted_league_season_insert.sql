-- Canonical SQL source for private.prevent_deleted_league_season_insert.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.prevent_deleted_league_season_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.leagues AS league
     WHERE league.id = NEW.league_id
       AND league.deleted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Deleted leagues cannot be advanced.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
