-- Canonical SQL source for private.settle_waiver_runs.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.settle_waiver_runs(
  p_timezone text,
  p_date date,
  p_drain_started_at timestamptz,
  p_league_id uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_count int := 0;
BEGIN
  IF p_drain_started_at < (p_date + time '00:00') AT TIME ZONE p_timezone THEN
    RETURN 0;
  END IF;
  INSERT INTO private.waiver_run_settlements(league_id, league_season_id, process_date)
  SELECT league.id, season.id, p_date
    FROM public.leagues league
    JOIN public.league_seasons season ON season.league_id = league.id AND season.is_current
   WHERE COALESCE(league.timezone, 'America/Los_Angeles') = p_timezone
     AND (p_league_id IS NULL OR league.id = p_league_id)
     AND league.status IN ('active', 'playoffs', 'offseason')
     AND NOT EXISTS (
       SELECT 1 FROM public.waiver_claims claim
        WHERE claim.league_id = league.id
          AND claim.league_season_id = season.id
          AND claim.status = 'pending'
          AND claim.process_date <= p_date
          AND NOT EXISTS (
            SELECT 1 FROM public.waiver_wire_log wire
             WHERE wire.league_id = claim.league_id
               AND wire.league_season_id = claim.league_season_id
               AND wire.player_id = claim.player_id
               AND wire.cleared_at IS NULL
               AND wire.clears_at > (p_date + time '00:00') AT TIME ZONE p_timezone
          )
     )
  ON CONFLICT (league_id, league_season_id, process_date) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
