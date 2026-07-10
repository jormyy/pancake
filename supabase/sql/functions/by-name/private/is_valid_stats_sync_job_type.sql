-- Canonical SQL source for private.is_valid_stats_sync_job_type.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
