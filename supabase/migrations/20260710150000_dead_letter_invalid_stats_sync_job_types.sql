CREATE OR REPLACE FUNCTION private.is_valid_stats_sync_job_type(p_job_type text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_start_date date;
  v_end_date date;
  v_start_date_text text;
  v_end_date_text text;
BEGIN
  IF p_job_type IS NULL
     OR p_job_type !~ '^sync_stats_range:\d{4}-\d{2}-\d{2}:\d{4}-\d{2}-\d{2}$' THEN
    RETURN false;
  END IF;

  v_start_date_text := split_part(p_job_type, ':', 2);
  v_end_date_text := split_part(p_job_type, ':', 3);
  BEGIN
    v_start_date := make_date(
      substring(v_start_date_text, 1, 4)::integer,
      substring(v_start_date_text, 6, 2)::integer,
      substring(v_start_date_text, 9, 2)::integer
    );
    v_end_date := make_date(
      substring(v_end_date_text, 1, 4)::integer,
      substring(v_end_date_text, 6, 2)::integer,
      substring(v_end_date_text, 9, 2)::integer
    );
  EXCEPTION WHEN datetime_field_overflow THEN
    RETURN false;
  END;

  RETURN v_start_date <= v_end_date
    AND v_end_date - v_start_date + 1 <= 365;
END;
$$;

REVOKE ALL ON FUNCTION private.is_valid_stats_sync_job_type(text) FROM PUBLIC, anon, authenticated, service_role;

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
     OR NOT private.is_valid_stats_sync_job_type(p_job_type) THEN
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
  WITH malformed_candidate AS (
    SELECT job.id
      FROM public.sync_jobs AS job
     WHERE job.job_type LIKE 'sync_stats_range:%'
       AND NOT private.is_valid_stats_sync_job_type(job.job_type)
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
  ), dead_lettered AS (
    UPDATE public.sync_jobs AS job
       SET status = 'failed',
           failed_items = v_max_failed_attempts,
           error_log = CASE
             WHEN jsonb_typeof(job.error_log) IS DISTINCT FROM 'array'
               THEN jsonb_build_array('Invalid stats sync job type was dead-lettered at claim boundary')
             WHEN jsonb_array_length(job.error_log) >= 100
               THEN (job.error_log #- '{0}') || jsonb_build_array('Invalid stats sync job type was dead-lettered at claim boundary')
             ELSE job.error_log || jsonb_build_array('Invalid stats sync job type was dead-lettered at claim boundary')
           END,
           completed_at = now(),
           claimed_at = NULL,
           claim_token = NULL
      FROM malformed_candidate
     WHERE job.id = malformed_candidate.id
     RETURNING job.id
  ), candidate AS (
    SELECT job.id
      FROM public.sync_jobs AS job
     WHERE job.job_type LIKE 'sync_stats_range:%'
       AND private.is_valid_stats_sync_job_type(job.job_type)
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
