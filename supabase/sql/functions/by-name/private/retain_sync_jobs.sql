-- Canonical SQL source for private.retain_sync_jobs.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.retain_sync_jobs(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
AS $$
DECLARE v_count bigint;
BEGIN
  WITH victims AS (
    SELECT r.id FROM public.sync_jobs r
    WHERE r.status='completed' AND r.completed_at<p_now-interval '30 days'
      AND NOT EXISTS (SELECT 1 FROM public.sync_jobs active WHERE active.job_type=r.job_type AND active.status IN ('pending','running')
        AND active.metadata->>'seasonYear'=r.metadata->>'seasonYear')
    ORDER BY r.completed_at,r.id LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM public.sync_jobs r USING victims v WHERE r.id=v.id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('public.sync_jobs',v_count);
END;
$$;
