-- Canonical SQL source for private.notif_season_trigger.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.notif_season_trigger()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  m record;
  seeds uuid[];
BEGIN
  IF TG_OP = 'INSERT' AND NEW.is_current AND EXISTS (
    SELECT 1 FROM public.league_seasons WHERE league_id = NEW.league_id AND season_year < NEW.season_year
  ) THEN
    FOR m IN SELECT id FROM public.league_members WHERE league_id = NEW.league_id LOOP
      PERFORM private.notif_enqueue('season_rollover',NEW.id::text,NEW.league_id,m.id,jsonb_build_object('leagueSeasonId',NEW.id));
    END LOOP;
  END IF;
  seeds := COALESCE(NEW.playoff_bracket_seed_ids,NEW.playoff_seed_member_ids);
  IF seeds IS NOT NULL AND (TG_OP = 'INSERT' OR COALESCE(OLD.playoff_bracket_seed_ids,OLD.playoff_seed_member_ids) IS DISTINCT FROM seeds) THEN
    FOR m IN SELECT unnest(seeds) AS id LOOP
      PERFORM private.notif_enqueue('playoff_seeding',NEW.id::text,NEW.league_id,m.id,jsonb_build_object('leagueSeasonId',NEW.id));
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
