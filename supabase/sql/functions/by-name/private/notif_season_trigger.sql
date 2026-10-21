CREATE OR REPLACE FUNCTION private.notif_season_trigger()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  m record;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.is_current AND EXISTS (
    SELECT 1 FROM public.league_seasons WHERE league_id = NEW.league_id AND season_year < NEW.season_year
  ) THEN
    FOR m IN SELECT id FROM public.league_members WHERE league_id = NEW.league_id LOOP
      PERFORM private.notif_enqueue('season_rollover',NEW.id::text,NEW.league_id,m.id,jsonb_build_object('leagueSeasonId',NEW.id));
    END LOOP;
  END IF;
  IF NEW.playoff_seed_member_ids IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.playoff_seed_member_ids IS DISTINCT FROM NEW.playoff_seed_member_ids) THEN
    FOR m IN SELECT unnest(NEW.playoff_seed_member_ids) AS id LOOP
      PERFORM private.notif_enqueue('playoff_seeding',NEW.id::text,NEW.league_id,m.id,jsonb_build_object('leagueSeasonId',NEW.id));
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
