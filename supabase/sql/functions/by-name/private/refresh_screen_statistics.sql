-- Canonical SQL source for private.refresh_screen_statistics.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.refresh_screen_statistics()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE target regclass; started timestamptz; results jsonb:='[]'::jsonb;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('private.refresh_screen_statistics',0)) THEN
    RETURN jsonb_build_object('busy',true);
  END IF;
  FOREACH target IN ARRAY private.screen_statistics_targets() LOOP
    started:=clock_timestamp();
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
