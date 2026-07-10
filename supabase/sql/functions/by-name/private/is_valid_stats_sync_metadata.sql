-- Canonical SQL source for private.is_valid_stats_sync_metadata.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
