-- Canonical SQL source for public.create_or_resume_stats_sync_job_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.create_or_resume_stats_sync_job_atomic(
  p_start_date date,
  p_end_date date
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job_id uuid;
  v_job_type text;
  v_total_items integer;
BEGIN
  IF p_start_date IS NULL OR p_end_date IS NULL OR p_start_date > p_end_date THEN
    RAISE EXCEPTION 'Stats sync date range is invalid.';
  END IF;
  IF p_end_date - p_start_date + 1 > 365 THEN
    RAISE EXCEPTION 'Stats sync date range cannot exceed 365 days.';
  END IF;

  PERFORM set_config('app.stats_sync_fenced_transition', 'on', true);
  v_job_type := format('sync_stats_range:%s:%s', p_start_date, p_end_date);
  SELECT count(*)::integer
    INTO v_total_items
    FROM public.nba_games AS game
   WHERE game.game_date BETWEEN p_start_date AND p_end_date
     AND game.nba_game_id LIKE '002%'
     AND (
       game.game_date < (now() AT TIME ZONE 'America/New_York')::date
       OR game.status <> 'Scheduled'
     );

  INSERT INTO public.sync_jobs (
    job_type,
    status,
    total_items,
    completed_items,
    failed_items,
    error_log,
    metadata,
    started_at
  )
  VALUES (
    v_job_type,
    'pending',
    v_total_items,
    0,
    0,
    '[]'::jsonb,
    jsonb_build_object(
      'startDate', p_start_date::text,
      'endDate', p_end_date::text,
      'nextDate', p_start_date::text
    ),
    now()
  )
  ON CONFLICT (job_type)
    WHERE job_type LIKE 'sync_stats_range:%'
      AND status IN ('pending', 'running', 'failed')
  DO UPDATE
     SET status = CASE WHEN public.sync_jobs.status = 'failed' THEN 'pending' ELSE public.sync_jobs.status END,
         failed_items = CASE WHEN public.sync_jobs.status = 'failed' THEN 0 ELSE public.sync_jobs.failed_items END,
         completed_items = CASE
           WHEN public.sync_jobs.status = 'failed'
             AND NOT private.is_valid_stats_sync_metadata(public.sync_jobs.metadata) THEN 0
           ELSE public.sync_jobs.completed_items
         END,
         total_items = CASE
           WHEN public.sync_jobs.status = 'failed'
             AND NOT private.is_valid_stats_sync_metadata(public.sync_jobs.metadata) THEN excluded.total_items
           ELSE public.sync_jobs.total_items
         END,
         metadata = CASE
           WHEN public.sync_jobs.status = 'failed'
             AND NOT private.is_valid_stats_sync_metadata(public.sync_jobs.metadata) THEN excluded.metadata
           ELSE public.sync_jobs.metadata
         END,
         completed_at = CASE WHEN public.sync_jobs.status = 'failed' THEN NULL ELSE public.sync_jobs.completed_at END,
         claimed_at = CASE WHEN public.sync_jobs.status = 'failed' THEN NULL ELSE public.sync_jobs.claimed_at END,
         claim_token = CASE WHEN public.sync_jobs.status = 'failed' THEN NULL ELSE public.sync_jobs.claim_token END
  RETURNING id INTO v_job_id;

  RETURN v_job_id;
END;
$$;
