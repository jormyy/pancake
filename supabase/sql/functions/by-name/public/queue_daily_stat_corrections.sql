CREATE OR REPLACE FUNCTION public.queue_daily_stat_corrections(p_now timestamptz DEFAULT now())
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_local timestamp := p_now AT TIME ZONE 'America/New_York';
  v_start date := v_local::date - 7;
  v_end date := v_local::date - 1;
  v_job_type text := format('sync_stats_range:%s:%s', v_start, v_end);
  v_job_id uuid;
BEGIN
  IF p_now IS NULL OR v_local::time < time '06:20' THEN
    RETURN NULL;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('pancake:daily-stat-corrections', 0));

  SELECT id INTO v_job_id
  FROM public.sync_jobs
  WHERE job_type = v_job_type
  ORDER BY created_at DESC, id
  LIMIT 1;

  IF v_job_id IS NOT NULL THEN
    RETURN v_job_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.nba_games
    WHERE game_date BETWEEN v_start AND v_end
      AND nba_game_id LIKE '002%'
      AND status = 'Final'
  ) THEN
    RETURN NULL;
  END IF;

  v_job_id := public.create_or_resume_stats_sync_job_atomic(v_start, v_end);
  PERFORM public.invoke_stats_sync_dispatch_if_due();
  RETURN v_job_id;
END;
$$;
