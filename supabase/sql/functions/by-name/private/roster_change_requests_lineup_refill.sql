-- Canonical SQL source for private.roster_change_requests_lineup_refill.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.roster_change_requests_lineup_refill()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  BEGIN
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      PERFORM private.request_lineup_refill(NEW.league_id, NEW.league_season_id, NEW.member_id);
    END IF;
    IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND (OLD.member_id, OLD.league_season_id) IS DISTINCT FROM (NEW.member_id, NEW.league_season_id)) THEN
      PERFORM private.request_lineup_refill(OLD.league_id, OLD.league_season_id, OLD.member_id);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Lineup refill request skipped: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$;
