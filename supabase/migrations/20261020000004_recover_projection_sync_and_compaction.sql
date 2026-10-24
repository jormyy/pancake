CREATE OR REPLACE FUNCTION private.projection_sync_due_work(p_now timestamptz DEFAULT now())
RETURNS TABLE(job_key text, period_key text, function_name text)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH local_clock AS (
    SELECT p_now AT TIME ZONE 'America/Los_Angeles' AS local_now
  ), clock AS (
    SELECT local_now, local_now::date AS today,
      date_trunc('week',local_now)::date AS monday,
      EXTRACT(HOUR FROM local_now)::integer AS hour,
      EXTRACT(YEAR FROM local_now)::integer + (EXTRACT(MONTH FROM local_now)>=10)::integer AS season_year
    FROM local_clock
  ), calendar AS (
    SELECT clock.*, min(g.game_time) AS first_tipoff
    FROM clock LEFT JOIN public.nba_games g ON g.game_date=clock.today
      AND g.season_year=clock.season_year AND public.is_regular_season_game_id(g.nba_game_id)
    GROUP BY local_now,today,monday,hour,clock.season_year
  )
  SELECT 'pt:sleeper-week',monday::text,'sync-sleeper-projections'
  FROM calendar WHERE EXISTS (SELECT 1 FROM public.season_weeks w WHERE w.season_year=calendar.season_year
    AND date_trunc('week',w.week_start::timestamp)::date=calendar.monday)
  UNION ALL
  SELECT 'pt:sleeper-day',today::text||':'||CASE WHEN hour>=15 THEN '15' WHEN hour>=12 THEN '12' ELSE '08' END,
    'sync-sleeper-projections'
  FROM calendar WHERE hour>=8 AND first_tipoff>p_now
  UNION ALL
  SELECT 'pt:fantasypros',today::text||':'||CASE WHEN hour>=15 THEN '15' ELSE '08' END,'sync-projections'
  FROM calendar WHERE hour>=8;
$$;

CREATE OR REPLACE FUNCTION private.compact_fantasypros_runs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_ids uuid[];
BEGIN
  IF NEW.source<>'fantasypros' OR NEW.status<>'success' OR NEW.completed_at IS NULL
    OR OLD.status='success' AND OLD.completed_at IS NOT NULL THEN RETURN NULL; END IF;
  SELECT array_agg(id) INTO v_ids FROM (
    SELECT id FROM public.projection_sync_runs r WHERE r.source='fantasypros'
      AND r.projection_type=NEW.projection_type AND r.status='success' AND r.completed_at IS NOT NULL
      AND (r.started_at,r.id)<(NEW.started_at,NEW.id)
      AND (NEW.projection_type='daily' AND r.projection_date=NEW.projection_date
        OR NEW.projection_type<>'daily' AND r.season_year=NEW.season_year AND r.week_number=NEW.week_number)
    ORDER BY r.started_at LIMIT 200
  ) old_runs;
  PERFORM private.delete_projection_runs(v_ids,100000);
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION private.projection_sync_due_work(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.compact_fantasypros_runs() FROM PUBLIC, anon, authenticated;
