-- Canonical SQL source for private.flush_deferred_league_versions.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.flush_deferred_league_versions(p_limit integer DEFAULT 1000)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE pending record; processed integer:=0;
BEGIN
  FOR pending IN SELECT transaction_id,league_id,topics,sources FROM private.league_version_pending
    WHERE transaction_id<>pg_current_xact_id()
    ORDER BY transaction_id,league_id LIMIT LEAST(GREATEST(COALESCE(p_limit,1000),0),5000)
    FOR UPDATE SKIP LOCKED LOOP
    BEGIN
      PERFORM private.publish_league_version(pending.league_id,pending.topics,pending.sources);
      DELETE FROM private.league_version_pending
        WHERE transaction_id=pending.transaction_id AND league_id=pending.league_id;
      processed:=processed+1;
    EXCEPTION WHEN serialization_failure OR lock_not_available THEN
      NULL;
    END;
  END LOOP;
  RETURN processed;
END;
$$;
