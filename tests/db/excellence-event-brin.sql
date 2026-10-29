\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='30s';
SET LOCAL lock_timeout='500ms';
SET LOCAL session_replication_role=replica;
INSERT INTO public.league_events(kind,summary,created_at)
SELECT 'database-benchmark','Synthetic append-only time range',timestamptz '2025-01-01 00:00:00+00'+id*interval '1 minute'
FROM generate_series(1,100000) id;
SET LOCAL session_replication_role=origin;
ANALYZE public.league_events;
DO $$
DECLARE child regclass;
BEGIN
  IF to_regclass('public.league_events_created_at_brin') IS NOT NULL THEN
    FOR child IN SELECT inhrelid FROM pg_inherits WHERE inhparent='public.league_events_created_at_brin'::regclass LOOP
      PERFORM brin_summarize_new_values(child);
    END LOOP;
  END IF;
END;
$$;
EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON)
SELECT count(*) FROM public.league_events
WHERE created_at>=timestamptz '2025-02-04 17:20:00+00' AND created_at<timestamptz '2025-02-04 17:30:00+00';
DO $$
DECLARE result bigint; plan jsonb;
BEGIN
  SELECT count(*) INTO result FROM public.league_events
  WHERE created_at>=timestamptz '2025-02-04 17:20:00+00' AND created_at<timestamptz '2025-02-04 17:30:00+00';
  IF result<>10 THEN RAISE EXCEPTION 'The event range result changes'; END IF;
  IF to_regclass('public.league_events_created_at_brin') IS NULL THEN
    RAISE EXCEPTION 'The event time BRIN index is missing';
  END IF;
  EXECUTE 'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT count(*) FROM public.league_events WHERE created_at>=timestamptz ''2025-02-04 17:20:00+00'' AND created_at<timestamptz ''2025-02-04 17:30:00+00''' INTO plan;
  IF NOT EXISTS(SELECT FROM pg_inherits child JOIN pg_class index ON index.oid=child.inhrelid
    WHERE child.inhparent='public.league_events_created_at_brin'::regclass AND plan::text LIKE '%'||index.relname||'%') THEN
    RAISE EXCEPTION 'The event time range does not use its BRIN index';
  END IF;
END;
$$;
ROLLBACK;
