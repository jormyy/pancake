-- Canonical SQL source for private.compact_trade_input_revisions.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.compact_trade_input_revisions()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF (SELECT count(*) FROM (SELECT 1 FROM private.trade_input_revisions r WHERE writer<>0
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity a WHERE a.pid=r.writer) LIMIT 64) retired)<64
    OR NOT pg_try_advisory_xact_lock(hashtextextended('trade-input-compaction',0)) THEN RETURN; END IF;
  WITH retired AS (
    DELETE FROM private.trade_input_revisions r WHERE writer<>0
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity a WHERE a.pid=r.writer)
    RETURNING source,scope,revision
  )
  INSERT INTO private.trade_input_revisions AS current(source,scope,writer,revision)
    SELECT source,scope,0,sum(revision)::bigint FROM retired GROUP BY source,scope
    ON CONFLICT(source,scope,writer) DO UPDATE SET revision=current.revision+EXCLUDED.revision;
END;
$$;
