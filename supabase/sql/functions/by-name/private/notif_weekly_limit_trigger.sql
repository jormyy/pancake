-- Canonical SQL source for private.notif_weekly_limit_trigger.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.notif_weekly_limit_trigger()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_limit int;
BEGIN
  SELECT weekly_add_limit INTO v_limit FROM public.leagues WHERE id = NEW.league_id;
  IF v_limit IS NOT NULL AND v_limit > 0 AND NEW.add_count >= v_limit
    AND (TG_OP = 'INSERT' OR OLD.add_count < v_limit) THEN
    PERFORM private.notif_enqueue('waiver_limit_reached',NEW.league_season_id::text || ':' || NEW.week_number::text,
      NEW.league_id,NEW.member_id,jsonb_build_object('leagueSeasonId',NEW.league_season_id,'week',NEW.week_number));
  END IF;
  RETURN NEW;
END;
$$;
