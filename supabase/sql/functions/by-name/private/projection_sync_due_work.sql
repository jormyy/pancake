-- Canonical SQL source for private.projection_sync_due_work.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.projection_sync_due_work(p_now timestamptz DEFAULT now())
RETURNS TABLE(job_key text, period_key text, function_name text)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH clock AS (
    SELECT (p_now AT TIME ZONE 'America/Los_Angeles')::date AS today,
      (p_now AT TIME ZONE 'America/Los_Angeles')::time AS local_time,
      date_trunc('week',p_now AT TIME ZONE 'America/Los_Angeles')::date AS monday,
      extract(year FROM p_now AT TIME ZONE 'America/Los_Angeles')::integer
        +(extract(month FROM p_now AT TIME ZONE 'America/Los_Angeles')>=10)::integer AS season_year
  ), calendar AS (
    SELECT clock.*,min(game.game_time) AS first_tipoff FROM clock
    LEFT JOIN public.nba_games game ON game.game_date=clock.today AND game.season_year=clock.season_year
      AND game.status NOT IN ('Cancelled','Postponed') AND public.is_regular_season_game_id(game.nba_game_id)
    GROUP BY today,local_time,monday,clock.season_year
  ), periods AS (
    SELECT *,today::text||CASE WHEN p_now>=first_tipoff-interval '1 hour' THEN ':pregame' ELSE ':08' END AS period
    FROM calendar WHERE (local_time>=time '08:00' AND local_time<time '09:00' AND (first_tipoff IS NULL OR p_now<first_tipoff))
      OR p_now>=first_tipoff-interval '1 hour' AND p_now<first_tipoff
  )
  SELECT 'pt:sleeper-day',period,'sync-sleeper-projections' FROM periods
    WHERE EXISTS(SELECT 1 FROM public.season_weeks week WHERE week.season_year=periods.season_year
      AND date_trunc('week',week.week_start::timestamp)::date=periods.monday)
  UNION ALL
  SELECT 'pt:fantasypros',period,'sync-projections' FROM periods;
$$;
