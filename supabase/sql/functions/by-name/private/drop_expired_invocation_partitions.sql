-- Canonical SQL source for private.drop_expired_invocation_partitions.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.drop_expired_invocation_partitions(p_now timestamptz DEFAULT now())
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='100ms' SET statement_timeout='3s' AS $$
DECLARE keep_ids bigint[]; part record; eligible boolean; removed bigint:=0; counted bigint; month_offset integer;
BEGIN
  FOR month_offset IN 0..2 LOOP
    PERFORM private.ensure_log_partition('public.edge_invocations',((p_now AT TIME ZONE 'UTC')::date+make_interval(months=>month_offset))::date);
  END LOOP;
  SELECT array_agg(latest.id) INTO keep_ids FROM (
    (SELECT DISTINCT ON (function_name) id FROM public.edge_invocations
      WHERE status_code BETWEEN 200 AND 299 AND error_message IS NULL AND worker_status IS DISTINCT FROM 'failed'
        AND reconciled_at IS NOT NULL AND (worker_started_at IS NULL OR worker_finished_at IS NOT NULL)
        AND worker_status IS DISTINCT FROM 'running'
      ORDER BY function_name,queued_at DESC,id DESC)
    UNION ALL
    (SELECT DISTINCT ON (function_name) id FROM public.edge_invocations
      WHERE (status_code IS NULL OR status_code NOT BETWEEN 200 AND 299 OR error_message IS NOT NULL OR worker_status='failed')
        AND reconciled_at IS NOT NULL AND (worker_started_at IS NULL OR worker_finished_at IS NOT NULL OR worker_status='failed')
        AND worker_status IS DISTINCT FROM 'running'
      ORDER BY function_name,queued_at DESC,id DESC)
  ) latest;
  FOR part IN SELECT partition_table FROM private.log_partitions
    WHERE parent_table='public.edge_invocations'::regclass AND upper_bound::timestamp AT TIME ZONE 'UTC'<=p_now-interval '30 days'
    ORDER BY lower_bound LIMIT 12 LOOP
    EXECUTE format($query$
      SELECT NOT EXISTS(SELECT FROM %s row WHERE row.id=ANY($2) OR NOT coalesce(
        (row.status_code BETWEEN 200 AND 299 AND row.error_message IS NULL AND row.worker_status IS DISTINCT FROM 'failed'
          AND row.reconciled_at<$1-interval '7 days' AND (row.worker_started_at IS NULL OR row.worker_finished_at IS NOT NULL)
          AND row.worker_status IS DISTINCT FROM 'running')
        OR ((row.status_code IS NULL OR row.status_code NOT BETWEEN 200 AND 299 OR row.error_message IS NOT NULL OR row.worker_status='failed')
          AND row.reconciled_at<$1-interval '30 days' AND (row.worker_started_at IS NULL OR row.worker_finished_at IS NOT NULL OR row.worker_status='failed')
          AND row.worker_status IS DISTINCT FROM 'running'),false))
    $query$,part.partition_table) INTO eligible USING p_now,coalesce(keep_ids,'{}'::bigint[]);
    IF NOT eligible THEN CONTINUE; END IF;
    EXECUTE format('SELECT count(*) FROM %s',part.partition_table) INTO counted;
    DELETE FROM private.retention_status WHERE relation_name=part.partition_table::text;
    DELETE FROM private.retention_rules WHERE relation_name=part.partition_table::text;
    EXECUTE format('DROP TABLE %s',part.partition_table);
    DELETE FROM private.log_partitions WHERE partition_table=part.partition_table;
    removed:=removed+counted;
  END LOOP;
  RETURN removed;
END;
$$;
