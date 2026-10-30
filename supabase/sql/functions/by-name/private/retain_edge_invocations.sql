-- Canonical SQL source for private.retain_edge_invocations.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.retain_edge_invocations(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
AS $$
DECLARE v_count bigint; v_total bigint:=0; v_outcome integer; v_condition text; v_age interval;
BEGIN
  WITH stale AS (
    SELECT r.id FROM public.edge_invocations r
    WHERE (r.reconciled_at IS NULL OR r.worker_status='running')
      AND GREATEST(r.queued_at,r.worker_started_at)<p_now-interval '30 days'
    ORDER BY r.queued_at,r.id LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) UPDATE public.edge_invocations r SET reconciled_at=COALESCE(r.reconciled_at,p_now),
    worker_status='failed',worker_finished_at=COALESCE(r.worker_finished_at,p_now),
    error_message=COALESCE(r.error_message,'Invocation remains unfinished after 30 days')
  FROM stale WHERE r.id=stale.id;
  v_total:=private.drop_expired_invocation_partitions(p_now);
  FOR v_outcome IN 1..2 LOOP
    IF v_outcome=1 THEN
      v_condition:='status_code BETWEEN 200 AND 299 AND error_message IS NULL AND worker_status IS DISTINCT FROM ''failed'' AND reconciled_at IS NOT NULL AND (worker_started_at IS NULL OR worker_finished_at IS NOT NULL) AND worker_status IS DISTINCT FROM ''running''';
      v_age:=interval '7 days';
    ELSE
      v_condition:='(status_code IS NULL OR status_code NOT BETWEEN 200 AND 299 OR error_message IS NOT NULL OR worker_status=''failed'') AND reconciled_at IS NOT NULL AND (worker_started_at IS NULL OR worker_finished_at IS NOT NULL OR worker_status=''failed'') AND worker_status IS DISTINCT FROM ''running''';
      v_age:=interval '30 days';
    END IF;
    EXECUTE format($query$
      WITH victims AS (
        SELECT r.id FROM public.edge_invocations r
        WHERE %1$s AND r.reconciled_at<$1-$2
          AND r.id IS DISTINCT FROM (SELECT newest.id FROM public.edge_invocations newest
            WHERE newest.function_name=r.function_name AND %1$s
            ORDER BY newest.queued_at DESC,newest.id DESC LIMIT 1)
        ORDER BY r.reconciled_at,r.id LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
      ) DELETE FROM public.edge_invocations r USING victims v WHERE r.id=v.id
    $query$,v_condition) USING p_now,v_age;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    v_total:=v_total+v_count;
  END LOOP;
  RETURN jsonb_build_object('public.edge_invocations',v_total);
END;
$$;
