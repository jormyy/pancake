-- pg_net purges responses without telling autovacuum, so the daily
-- pg-net-response-vacuum job is what keeps net._http_response compact. Runs
-- outside a transaction because VACUUM cannot run inside one.
-- A live Realtime reader can retain pre-delete tuples. Wait for those readers
-- before testing page reuse; VACUUM must obey their snapshots.
CREATE FUNCTION pg_temp.wait_response_readers() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_cutoff xid := pg_current_xact_id()::text::xid;
  v_deadline timestamptz := clock_timestamp() + interval '10 seconds';
BEGIN
  LOOP
    PERFORM pg_stat_clear_snapshot();
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM pg_stat_activity
       WHERE pid <> pg_backend_pid()
         AND datname = current_database()
         AND backend_xmin IS NOT NULL
         AND age(backend_xmin) > age(v_cutoff)
    );
    IF clock_timestamp() >= v_deadline THEN
      RAISE EXCEPTION 'A database reader still retains pre-delete response tuples';
    END IF;
    PERFORM pg_sleep(0.05);
  END LOOP;
END $$;

BEGIN;
DELETE FROM private.work_items;
SELECT private.enqueue_scheduled_work('2004-06-22 08:17 UTC');
DO $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM private.work_items work JOIN private.work_kinds kind USING(kind)
    WHERE work.kind='pg-net-response-vacuum' AND work.payload->>'action'='vacuum'
      AND kind.function_name='dispatcher') THEN
    RAISE EXCEPTION 'The dispatcher does not queue response vacuum at minute seventeen';
  END IF;
END;
$$;
ROLLBACK;

-- Production's shape: purged responses fill the heap and the live ones sit at its tail.
INSERT INTO net._http_response (id, status_code, content_type, headers, content, timed_out, created)
SELECT 980000000 + g, 200, 'application/json', jsonb_build_object('x-pad', repeat('h', 900)), '{"ok":true}', false, now() - interval '7 hours'
  FROM generate_series(1, 6000) AS g;
INSERT INTO net._http_response (id, status_code, content_type, headers, content, timed_out, created)
SELECT 980010000 + g, 200, 'application/json', jsonb_build_object('x-pad', repeat('h', 900)), '{"ok":true}', false, now()
  FROM generate_series(1, 50) AS g;
DELETE FROM net._http_response WHERE id BETWEEN 980000001 AND 980006000;

SELECT pg_temp.wait_response_readers();


-- The job's own command, as the job runs it.
VACUUM (ANALYZE, INDEX_CLEANUP ON) net._http_response;
SELECT set_config('test.size_bloated', pg_relation_size('net._http_response')::text, false);

-- One TTL period later: new responses fill the freed pages and the tail expires.
INSERT INTO net._http_response (id, status_code, content_type, headers, content, timed_out, created)
SELECT 980020000 + g, 200, 'application/json', jsonb_build_object('x-pad', repeat('h', 900)), '{"ok":true}', false, now()
  FROM generate_series(1, 50) AS g;
DELETE FROM net._http_response WHERE id BETWEEN 980010001 AND 980010050;

SELECT pg_temp.wait_response_readers();

VACUUM (ANALYZE, INDEX_CLEANUP ON) net._http_response;
SELECT set_config('test.size_after', pg_relation_size('net._http_response')::text, false);

DELETE FROM net._http_response WHERE id BETWEEN 980000001 AND 980020050;

DO $$
DECLARE
  v_bloated bigint := current_setting('test.size_bloated')::bigint;
  v_after bigint := current_setting('test.size_after')::bigint;
BEGIN
  IF v_after * 10 > v_bloated THEN
    RAISE EXCEPTION 'net._http_response stayed at % of % bytes after its expired tail was vacuumed', v_after, v_bloated;
  END IF;
END $$;
