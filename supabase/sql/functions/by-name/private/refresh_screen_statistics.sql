-- Canonical SQL source for private.refresh_screen_statistics.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.refresh_screen_statistics()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE target regclass; started timestamptz; stale boolean; results jsonb:='[]'::jsonb;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('private.refresh_screen_statistics',0)) THEN
    RETURN jsonb_build_object('busy',true);
  END IF;
  PERFORM pg_stat_clear_snapshot();
  FOREACH target IN ARRAY private.screen_statistics_targets() LOOP
    started:=clock_timestamp();
    WITH relations AS (
      SELECT target::oid AS oid UNION SELECT relid::oid FROM pg_partition_tree(target)
    )
    SELECT bool_or(relation.reltuples<0 OR stats.last_analyze IS NULL AND stats.last_autoanalyze IS NULL
      OR COALESCE(stats.n_mod_since_analyze,0)+pg_stat_get_xact_tuples_inserted(relation.oid)
        +pg_stat_get_xact_tuples_updated(relation.oid)+pg_stat_get_xact_tuples_deleted(relation.oid)
        >COALESCE(options.threshold,current_setting('autovacuum_analyze_threshold'))::numeric
          +COALESCE(options.scale,current_setting('autovacuum_analyze_scale_factor'))::numeric*greatest(relation.reltuples,0))
      INTO stale FROM relations JOIN pg_class relation USING(oid)
      LEFT JOIN pg_stat_all_tables stats ON stats.relid=relation.oid
      LEFT JOIN LATERAL (
        SELECT max(option_value) FILTER(WHERE option_name='autovacuum_analyze_threshold') AS threshold,
          max(option_value) FILTER(WHERE option_name='autovacuum_analyze_scale_factor') AS scale
        FROM pg_options_to_table(relation.reloptions)
      ) options ON true;
    IF NOT COALESCE(stale,true) THEN
      results:=results||jsonb_build_object('relation',target::text,'status','fresh',
        'milliseconds',round((extract(epoch FROM clock_timestamp()-started)*1000)::numeric,3));
      CONTINUE;
    END IF;
    BEGIN
      EXECUTE format('ANALYZE %s',target);
      results:=results||jsonb_build_object('relation',target::text,'status','analyzed',
        'milliseconds',round((extract(epoch FROM clock_timestamp()-started)*1000)::numeric,3));
    EXCEPTION WHEN lock_not_available THEN
      results:=results||jsonb_build_object('relation',target::text,'status','skipped',
        'milliseconds',round((extract(epoch FROM clock_timestamp()-started)*1000)::numeric,3),'sqlstate',SQLSTATE);
    END;
  END LOOP;
  RETURN results;
END;
$$;
