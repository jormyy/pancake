BEGIN;
DELETE FROM private.retention_status WHERE relation_name IN ('public.edge_invocations','public.sync_runs');
UPDATE private.retention_rules SET worker=NULL
WHERE relation_name NOT IN ('public.edge_invocations','public.sync_runs');

CREATE OR REPLACE FUNCTION private.retain_edge_invocations(p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_sleep(2);
  RETURN jsonb_build_object('public.edge_invocations',0);
END;
$$;

CREATE OR REPLACE FUNCTION private.retain_sync_runs(p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A timed-out run starts another batch';
END;
$$;

SET LOCAL statement_timeout='50ms';
DO $$
DECLARE v_started timestamptz:=clock_timestamp(); v_result jsonb;
BEGIN
  v_result:=private.run_retention();
  IF (SELECT count(*) FROM jsonb_each(v_result))<>1
    OR (v_result->'public.edge_invocations'->>'error' LIKE '57014:%') IS DISTINCT FROM true
    OR clock_timestamp()-v_started>=interval '1 second' THEN
    RAISE EXCEPTION 'FAIL: timeout stops retention before another batch';
  END IF;
  RAISE NOTICE 'PASS: timeout records cancellation and stops before another batch';
END;
$$;
ROLLBACK;
