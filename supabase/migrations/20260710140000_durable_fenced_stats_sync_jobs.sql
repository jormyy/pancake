-- Make ranged stats synchronization a database-owned durable queue:
-- - one active job per exact date range,
-- - immutable per-claim fencing tokens,
-- - atomic state transitions,
-- - periodic rescue of pending and stale work.

ALTER TABLE public.sync_jobs
  ADD COLUMN claimed_at timestamptz,
  ADD COLUMN claim_token uuid;

-- The previous Edge-only implementation stored its lease timestamp in metadata.
-- Give live legacy workers a full drain window. They remain tokenless so their
-- predeploy direct writes can finish until a fenced worker takes ownership.
UPDATE public.sync_jobs
   SET metadata = metadata - 'claimedAt',
       claimed_at = now(),
       claim_token = NULL
 WHERE job_type LIKE 'sync_stats_range:%'
   AND status = 'running';

-- Preserve the newest active job if duplicate jobs were created before this
-- migration installed database-enforced deduplication.
WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY job_type ORDER BY created_at DESC, id DESC) AS position
    FROM public.sync_jobs
   WHERE job_type LIKE 'sync_stats_range:%'
     AND status IN ('pending', 'running', 'failed')
)
UPDATE public.sync_jobs AS job
   SET status = 'completed',
       completed_at = now(),
       error_log = COALESCE(job.error_log, '[]'::jsonb) ||
         jsonb_build_array('Superseded while installing atomic stats sync deduplication')
  FROM ranked
 WHERE job.id = ranked.id
   AND ranked.position > 1;

CREATE UNIQUE INDEX sync_jobs_one_active_stats_range_idx
  ON public.sync_jobs (job_type)
  WHERE job_type LIKE 'sync_stats_range:%'
    AND status IN ('pending', 'running', 'failed');

CREATE INDEX sync_jobs_dispatchable_stats_idx
  ON public.sync_jobs (status, completed_at, claimed_at, created_at, id)
  WHERE job_type LIKE 'sync_stats_range:%'
    AND status IN ('pending', 'running', 'failed');

CREATE OR REPLACE FUNCTION private.is_valid_stats_sync_metadata(p_metadata jsonb, p_job_type text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_start_date date;
  v_end_date date;
  v_next_date date;
  v_job_start_date text;
  v_job_end_date text;
BEGIN
  IF p_metadata IS NULL
     OR jsonb_typeof(p_metadata) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_metadata -> 'startDate') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_metadata -> 'endDate') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_metadata -> 'nextDate') IS DISTINCT FROM 'string'
     OR (p_metadata ->> 'startDate') !~ '^\d{4}-\d{2}-\d{2}$'
     OR (p_metadata ->> 'endDate') !~ '^\d{4}-\d{2}-\d{2}$'
     OR (p_metadata ->> 'nextDate') !~ '^\d{4}-\d{2}-\d{2}$'
     OR p_metadata ? 'invalidMetadata'
     OR p_job_type !~ '^sync_stats_range:\d{4}-\d{2}-\d{2}:\d{4}-\d{2}-\d{2}$' THEN
    RETURN false;
  END IF;

  v_job_start_date := split_part(p_job_type, ':', 2);
  v_job_end_date := split_part(p_job_type, ':', 3);
  IF p_metadata ->> 'startDate' IS DISTINCT FROM v_job_start_date
     OR p_metadata ->> 'endDate' IS DISTINCT FROM v_job_end_date THEN
    RETURN false;
  END IF;

  BEGIN
    v_start_date := make_date(
      substring(p_metadata ->> 'startDate', 1, 4)::integer,
      substring(p_metadata ->> 'startDate', 6, 2)::integer,
      substring(p_metadata ->> 'startDate', 9, 2)::integer
    );
    v_end_date := make_date(
      substring(p_metadata ->> 'endDate', 1, 4)::integer,
      substring(p_metadata ->> 'endDate', 6, 2)::integer,
      substring(p_metadata ->> 'endDate', 9, 2)::integer
    );
    v_next_date := make_date(
      substring(p_metadata ->> 'nextDate', 1, 4)::integer,
      substring(p_metadata ->> 'nextDate', 6, 2)::integer,
      substring(p_metadata ->> 'nextDate', 9, 2)::integer
    );
  EXCEPTION WHEN datetime_field_overflow THEN
    RETURN false;
  END;

  IF v_start_date > v_end_date
     OR v_end_date - v_start_date + 1 > 365
     OR v_next_date < v_start_date
     OR v_next_date > v_end_date + 1 THEN
    RETURN false;
  END IF;

  IF p_metadata ? 'afterGameId' AND (
       jsonb_typeof(p_metadata -> 'afterGameId') IS DISTINCT FROM 'string'
       OR (p_metadata ->> 'afterGameId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR v_next_date > v_end_date
     ) THEN
    RETURN false;
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION private.is_valid_stats_sync_metadata(jsonb, text) FROM PUBLIC, anon, authenticated, service_role;

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
             AND NOT private.is_valid_stats_sync_metadata(public.sync_jobs.metadata, public.sync_jobs.job_type) THEN 0
           ELSE public.sync_jobs.completed_items
         END,
         total_items = CASE
           WHEN public.sync_jobs.status = 'failed'
             AND NOT private.is_valid_stats_sync_metadata(public.sync_jobs.metadata, public.sync_jobs.job_type) THEN excluded.total_items
           ELSE public.sync_jobs.total_items
         END,
         metadata = CASE
           WHEN public.sync_jobs.status = 'failed'
             AND NOT private.is_valid_stats_sync_metadata(public.sync_jobs.metadata, public.sync_jobs.job_type) THEN excluded.metadata
           ELSE public.sync_jobs.metadata
         END,
         completed_at = CASE WHEN public.sync_jobs.status = 'failed' THEN NULL ELSE public.sync_jobs.completed_at END,
         claimed_at = CASE WHEN public.sync_jobs.status = 'failed' THEN NULL ELSE public.sync_jobs.claimed_at END,
         claim_token = CASE WHEN public.sync_jobs.status = 'failed' THEN NULL ELSE public.sync_jobs.claim_token END
  RETURNING id INTO v_job_id;

  RETURN v_job_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_stats_sync_job_atomic(
  p_job_id uuid DEFAULT NULL,
  p_stale_after_seconds integer DEFAULT 120
)
RETURNS TABLE (
  id uuid,
  claim_token uuid,
  job_type text,
  completed_items integer,
  total_items integer,
  metadata jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_stale_after_seconds integer := LEAST(GREATEST(COALESCE(p_stale_after_seconds, 120), 60), 900);
  v_max_failed_attempts constant integer := 3;
BEGIN
  PERFORM set_config('app.stats_sync_fenced_transition', 'on', true);
  RETURN QUERY
  WITH candidate AS (
    SELECT job.id
      FROM public.sync_jobs AS job
     WHERE job.job_type LIKE 'sync_stats_range:%'
       AND (p_job_id IS NULL OR job.id = p_job_id)
       AND (
         job.status = 'pending'
         OR (
           job.status = 'failed'
           AND job.failed_items < v_max_failed_attempts
           AND COALESCE(job.completed_at, job.created_at) <= now() - make_interval(
             secs => CASE WHEN job.failed_items <= 1 THEN 60 ELSE 300 END
           )
         )
         OR (
         job.status = 'running'
           AND (
             (
               job.claim_token IS NULL
               AND COALESCE(job.claimed_at, job.created_at) <= now() - interval '15 minutes'
             )
             OR (
               job.claim_token IS NOT NULL
               AND (
                 job.claimed_at IS NULL
                 OR job.claimed_at <= now() - make_interval(secs => v_stale_after_seconds)
               )
             )
           )
         )
       )
     ORDER BY job.created_at, job.id
     LIMIT 1
     FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE public.sync_jobs AS job
       SET status = 'running',
           claimed_at = now(),
           claim_token = gen_random_uuid(),
           completed_at = NULL
      FROM candidate
     WHERE job.id = candidate.id
     RETURNING job.id, job.claim_token, job.job_type, job.completed_items,
       job.total_items, job.metadata
  )
  SELECT claimed.id, claimed.claim_token, claimed.job_type, claimed.completed_items,
    claimed.total_items, claimed.metadata
  FROM claimed;
END;
$$;

CREATE OR REPLACE FUNCTION public.checkpoint_stats_sync_job_atomic(
  p_job_id uuid,
  p_claim_token uuid,
  p_completed_items integer,
  p_metadata jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job_type text;
BEGIN
  SELECT job_type INTO v_job_type
    FROM public.sync_jobs
   WHERE id = p_job_id AND status = 'running' AND claim_token = p_claim_token;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_completed_items IS NULL OR p_completed_items < 0
     OR NOT private.is_valid_stats_sync_metadata(p_metadata, v_job_type) THEN
    RAISE EXCEPTION 'Stats sync checkpoint is invalid.';
  END IF;

  PERFORM set_config('app.stats_sync_fenced_transition', 'on', true);
  UPDATE public.sync_jobs
     SET completed_items = p_completed_items,
         failed_items = 0,
         metadata = p_metadata,
         claimed_at = now()
   WHERE id = p_job_id
     AND status = 'running'
     AND claim_token = p_claim_token;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_stats_sync_job_atomic(
  p_job_id uuid,
  p_claim_token uuid,
  p_completed_items integer,
  p_metadata jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job_type text;
BEGIN
  SELECT job_type INTO v_job_type
    FROM public.sync_jobs
   WHERE id = p_job_id AND status = 'running' AND claim_token = p_claim_token;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_completed_items IS NULL OR p_completed_items < 0
     OR NOT private.is_valid_stats_sync_metadata(p_metadata, v_job_type) THEN
    RAISE EXCEPTION 'Stats sync release is invalid.';
  END IF;

  PERFORM set_config('app.stats_sync_fenced_transition', 'on', true);
  UPDATE public.sync_jobs
     SET status = 'pending',
         completed_items = p_completed_items,
         failed_items = 0,
         metadata = p_metadata,
         claimed_at = NULL,
         claim_token = NULL
   WHERE id = p_job_id
     AND status = 'running'
     AND claim_token = p_claim_token;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_stats_sync_job_atomic(
  p_job_id uuid,
  p_claim_token uuid,
  p_completed_items integer,
  p_metadata jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job_type text;
BEGIN
  SELECT job_type INTO v_job_type
    FROM public.sync_jobs
   WHERE id = p_job_id AND status = 'running' AND claim_token = p_claim_token;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_completed_items IS NULL OR p_completed_items < 0
     OR NOT private.is_valid_stats_sync_metadata(p_metadata, v_job_type) THEN
    RAISE EXCEPTION 'Stats sync completion is invalid.';
  END IF;

  PERFORM set_config('app.stats_sync_fenced_transition', 'on', true);
  UPDATE public.sync_jobs
     SET status = 'completed',
         completed_items = p_completed_items,
         failed_items = 0,
         metadata = p_metadata,
         completed_at = now(),
         claimed_at = NULL,
         claim_token = NULL
   WHERE id = p_job_id
     AND status = 'running'
     AND claim_token = p_claim_token;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_stats_sync_job_atomic(
  p_job_id uuid,
  p_claim_token uuid,
  p_completed_items integer,
  p_metadata jsonb,
  p_error text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job_type text;
BEGIN
  SELECT job_type INTO v_job_type
    FROM public.sync_jobs
   WHERE id = p_job_id AND status = 'running' AND claim_token = p_claim_token;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_completed_items IS NULL OR p_completed_items < 0
     OR p_metadata IS NULL OR jsonb_typeof(p_metadata) IS DISTINCT FROM 'object'
     OR NOT private.is_valid_stats_sync_metadata(p_metadata - 'invalidMetadata', v_job_type) THEN
    RAISE EXCEPTION 'Stats sync failure checkpoint is invalid.';
  END IF;

  PERFORM set_config('app.stats_sync_fenced_transition', 'on', true);
  UPDATE public.sync_jobs
     SET status = 'failed',
         completed_items = p_completed_items,
         failed_items = failed_items + 1,
         error_log = CASE
           WHEN jsonb_array_length(COALESCE(error_log, '[]'::jsonb)) >= 100
             THEN (COALESCE(error_log, '[]'::jsonb) #- '{0}') || jsonb_build_array(left(COALESCE(p_error, 'Unknown stats sync failure'), 4000))
           ELSE COALESCE(error_log, '[]'::jsonb) || jsonb_build_array(left(COALESCE(p_error, 'Unknown stats sync failure'), 4000))
         END,
         metadata = p_metadata,
         completed_at = now(),
         claimed_at = NULL,
         claim_token = NULL
   WHERE id = p_job_id
     AND status = 'running'
     AND claim_token = p_claim_token;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION private.enforce_stats_sync_claim_fence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF OLD.job_type LIKE 'sync_stats_range:%'
     AND current_setting('app.stats_sync_fenced_transition', true) IS DISTINCT FROM 'on' THEN
    IF OLD.claim_token IS NOT NULL THEN
      RAISE EXCEPTION 'Stats sync job % is owned by a fenced claim.', OLD.id
        USING ERRCODE = '55000';
    END IF;

    IF NEW.status = 'running'
       AND NEW.claim_token IS NULL THEN
      NEW.claimed_at := now();
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.enforce_stats_sync_claim_fence() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER enforce_stats_sync_claim_fence
  BEFORE UPDATE ON public.sync_jobs
  FOR EACH ROW
  EXECUTE FUNCTION private.enforce_stats_sync_claim_fence();

REVOKE ALL ON FUNCTION public.create_or_resume_stats_sync_job_atomic(date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_or_resume_stats_sync_job_atomic(date, date) TO service_role;
REVOKE ALL ON FUNCTION public.claim_stats_sync_job_atomic(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_stats_sync_job_atomic(uuid, integer) TO service_role;
REVOKE ALL ON FUNCTION public.checkpoint_stats_sync_job_atomic(uuid, uuid, integer, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.checkpoint_stats_sync_job_atomic(uuid, uuid, integer, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.release_stats_sync_job_atomic(uuid, uuid, integer, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_stats_sync_job_atomic(uuid, uuid, integer, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.complete_stats_sync_job_atomic(uuid, uuid, integer, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_stats_sync_job_atomic(uuid, uuid, integer, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.fail_stats_sync_job_atomic(uuid, uuid, integer, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_stats_sync_job_atomic(uuid, uuid, integer, jsonb, text) TO service_role;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('nba-dispatch-stats-sync-jobs') WHERE EXISTS (
      SELECT 1 FROM cron.job WHERE jobname = 'nba-dispatch-stats-sync-jobs'
    );
    PERFORM cron.schedule(
      'nba-dispatch-stats-sync-jobs',
      '* * * * *',
      $$SELECT public.invoke_edge_function(
        'sync-stats',
        '{"dispatch":true,"jobId":"00000000-0000-4000-8000-000000000000"}'::jsonb
      )$$
    );
  END IF;
END
$cron$;

COMMENT ON INDEX public.sync_jobs_one_active_stats_range_idx IS
  'Enforces one pending, running, or retryable failed stats range job per exact date range.';
