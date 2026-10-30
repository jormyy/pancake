-- Canonical SQL source for private.seed_member_lineup_optimizer.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.seed_member_lineup_optimizer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.lineup_optimizer_settings
    (league_id, league_season_id, member_id, enabled_at)
  SELECT NEW.league_id, season.id, NEW.id, now()
  FROM public.league_seasons AS season
  WHERE season.league_id = NEW.league_id AND season.is_current
  ON CONFLICT (league_id, league_season_id, member_id) DO NOTHING;
  RETURN NEW;
END;
$$;
