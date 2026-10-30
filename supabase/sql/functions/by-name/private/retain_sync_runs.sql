-- Canonical SQL source for private.retain_sync_runs.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.retain_sync_runs(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
AS $$
DECLARE v_count bigint; v_total bigint:=0; v_outcome integer; v_condition text; v_age interval;
BEGIN
  WITH stale AS (
    SELECT r.id FROM public.sync_runs r
    WHERE r.finished_at IS NULL AND r.started_at<p_now-interval '30 days'
      AND NOT EXISTS(SELECT 1 FROM public.edge_invocations i WHERE i.sync_run_id=r.id
        AND i.worker_status='running' AND i.worker_started_at>=p_now-interval '30 days')
    ORDER BY r.started_at,r.id LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) UPDATE public.sync_runs r SET status='failed',finished_at=p_now,
    error=COALESCE(r.error,'Worker remains unfinished after 30 days')
  FROM stale WHERE r.id=stale.id;
  FOR v_outcome IN 1..2 LOOP
    IF v_outcome=1 THEN
      v_condition:='status=''success'' AND error IS NULL AND finished_at IS NOT NULL';
      v_age:=interval '7 days';
    ELSE
      v_condition:='(status=''failed'' OR error IS NOT NULL) AND finished_at IS NOT NULL';
      v_age:=interval '30 days';
    END IF;
    EXECUTE format($query$
      WITH victims AS (
        SELECT r.id FROM public.sync_runs r
        WHERE %1$s AND r.finished_at<$1-$2
          AND r.id IS DISTINCT FROM (SELECT newest.id FROM public.sync_runs newest
            WHERE newest.function_name=r.function_name AND %1$s
            ORDER BY newest.started_at DESC,newest.id DESC LIMIT 1)
        ORDER BY r.finished_at,r.id LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
      ) DELETE FROM public.sync_runs r USING victims v WHERE r.id=v.id
    $query$,v_condition) USING p_now,v_age;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    v_total:=v_total+v_count;
  END LOOP;
  RETURN jsonb_build_object('public.sync_runs',v_total);
END;
$$;
