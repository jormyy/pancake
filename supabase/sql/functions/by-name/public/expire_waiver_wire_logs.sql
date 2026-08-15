-- Canonical SQL source for public.expire_waiver_wire_logs.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.expire_waiver_wire_logs()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_expired integer;
BEGIN
  UPDATE waiver_wire_log AS wwl
     SET cleared_at = now()
    FROM league_seasons AS season,
         leagues AS league
   WHERE wwl.cleared_at IS NULL
     AND season.id = wwl.league_season_id
     AND season.is_current = true
     AND league.id = wwl.league_id
     AND league.status IN ('active'::league_status, 'playoffs'::league_status, 'offseason'::league_status)
     AND wwl.clears_at < now()
     AND NOT EXISTS (
       SELECT 1
         FROM waiver_claims AS wc
        WHERE wc.league_id = wwl.league_id
          AND wc.league_season_id = wwl.league_season_id
          AND wc.player_id = wwl.player_id
          AND wc.status = 'pending'
     );

  GET DIAGNOSTICS v_expired = ROW_COUNT;
  RETURN v_expired;
END;
$$;
