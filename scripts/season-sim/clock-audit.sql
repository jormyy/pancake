WITH sources AS (
  SELECT 'function' AS kind, p.oid::regprocedure::text AS name, p.prosrc AS body
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','private') AND p.prokind='f'
  UNION ALL
  SELECT 'function-default',p.oid::regprocedure::text,pg_get_expr(p.proargdefaults,0)
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','private') AND p.pronargdefaults>0
  UNION ALL
  SELECT 'default', c.relname || '.' || a.attname, pg_get_expr(d.adbin,d.adrelid)
  FROM pg_attrdef d JOIN pg_class c ON c.oid=d.adrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum WHERE n.nspname IN ('public','private')
  UNION ALL
  SELECT 'policy', tablename || '.' || policyname, coalesce(qual,'') || coalesce(with_check,'') FROM pg_policies WHERE schemaname IN ('public','private')
  UNION ALL
  SELECT 'view', viewname, definition FROM pg_views WHERE schemaname IN ('public','private')
  UNION ALL
  SELECT 'constraint', c.relname || '.' || k.conname, pg_get_constraintdef(k.oid)
  FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','private')
), forms AS (
  SELECT unnest(ARRAY['now', 'clock_timestamp', 'transaction_timestamp', 'statement_timestamp', 'current_timestamp', 'current_date', 'current_time', 'localtimestamp', 'localtime', 'timeofday', 'season_sim_native_now', 'season_sim_native_clock_timestamp', 'season_sim_native_transaction_timestamp', 'season_sim_native_statement_timestamp']) AS form
)
SELECT jsonb_object_agg(form, matches) FROM (
 SELECT form, jsonb_build_object('occurrences',coalesce(sum(regexp_count(body, '\m' || form || '\M',1,'i')),0),'objects',coalesce(jsonb_agg(jsonb_build_object('kind',kind,'name',name)) FILTER(WHERE body ~* ('\m' || form || '\M')),'[]')) AS matches
 FROM forms CROSS JOIN sources GROUP BY form
) counts;
