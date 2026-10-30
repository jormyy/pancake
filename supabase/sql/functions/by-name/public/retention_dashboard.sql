-- Canonical SQL source for public.retention_dashboard.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.retention_dashboard()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  WITH relations AS (
    SELECT n.nspname||'.'||c.relname AS relation_name,c.oid,c.reltuples::bigint AS estimated_rows
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','p','m') AND n.nspname IN ('public','private','analytics','auth','storage','cron','net')
  ), rows AS (
    SELECT relations.relation_name,pg_total_relation_size(relations.oid) AS total_bytes,
      pg_relation_size(relations.oid) AS table_bytes,relations.estimated_rows,
      COALESCE(rules.retention_rule,'Unassigned: requires a retention decision') AS retention_rule,
      rules.worker IS NOT NULL AS automatically_pruned,
      status.last_checked_at,status.last_pruned_at,COALESCE(status.rows_pruned,0) AS rows_pruned,
      status.last_rows_pruned,status.last_error
    FROM relations LEFT JOIN private.retention_rules rules USING(relation_name)
    LEFT JOIN private.retention_status status USING(relation_name)
  )
  SELECT jsonb_build_object('tables',COALESCE(jsonb_agg(to_jsonb(rows) ORDER BY relation_name),'[]'::jsonb),
    'external',jsonb_build_array(
      jsonb_build_object('name','Vercel and Edge logs','rule','External provider retention; no database copy'),
      jsonb_build_object('name','Avatar files','rule','Upsert one file per supported format per user; 5 MB each; object deletion requires Storage API'),
      jsonb_build_object('name','Replay evidence','rule','Verified receipt summaries stay in replay artifacts after database log expiry')))
  FROM rows;
$$;
