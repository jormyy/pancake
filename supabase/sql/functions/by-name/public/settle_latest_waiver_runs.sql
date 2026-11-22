-- Canonical SQL source for public.settle_latest_waiver_runs.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.settle_latest_waiver_runs(p_drain_started_at timestamptz)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_count int := 0; v_row record;
BEGIN
  FOR v_row IN
    SELECT DISTINCT COALESCE(league.timezone, 'America/Los_Angeles') AS timezone,
           (SELECT max(weeks.week_end)
              FROM public.season_weeks weeks
             WHERE weeks.season_year = season.season_year
               AND weeks.week_end <= (now() AT TIME ZONE COALESCE(league.timezone, 'America/Los_Angeles'))::date) AS week_end
      FROM public.leagues league
      JOIN public.league_seasons season ON season.league_id = league.id AND season.is_current
     WHERE league.status IN ('active', 'playoffs', 'offseason')
  LOOP
    IF v_row.week_end IS NOT NULL THEN
      v_count := v_count + private.settle_waiver_runs(v_row.timezone, v_row.week_end, p_drain_started_at);
    END IF;
  END LOOP;
  FOR v_row IN
    SELECT league.id AS league_id,
           COALESCE(league.timezone, 'America/Los_Angeles') AS timezone,
           week.week_end
      FROM public.leagues league
      JOIN public.league_seasons season ON season.league_id = league.id AND season.is_current
      JOIN private.league_roster_policies policy ON policy.league_id = league.id
      CROSS JOIN LATERAL private.roster_floor_week(league.id, season.id) week
     WHERE league.status IN ('active', 'playoffs', 'offseason')
       AND policy.weekly_roster_floor IS NOT NULL
       AND policy.floor_activated_at IS NOT NULL
  LOOP
    v_count := v_count + private.settle_waiver_runs(v_row.timezone, v_row.week_end, p_drain_started_at, v_row.league_id);
  END LOOP;
  RETURN v_count;
END;
$$;
