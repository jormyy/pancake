BEGIN;
SELECT set_config('app.supabase_url', 'http://127.0.0.1:1', true);
SELECT set_config('app.edge_internal_token', 'correlation-fixture', true);
CREATE TEMP TABLE invocation_fixture (label text PRIMARY KEY, id bigint, key uuid, run uuid);

SELECT public.invoke_edge_function_at_et_time('correlation-daily', 0, 0);
INSERT INTO invocation_fixture SELECT 'first', id, invocation_key, NULL FROM public.edge_invocations
 WHERE function_name = 'correlation-daily' ORDER BY id DESC LIMIT 1;
SELECT public.start_edge_invocation(key, 'correlation-daily') FROM invocation_fixture WHERE label = 'first';
UPDATE invocation_fixture f SET run = i.sync_run_id FROM public.edge_invocations i WHERE f.id = i.id;
SELECT public.finish_edge_invocation(key, 'failed', 633, 'one identity conflict') FROM invocation_fixture WHERE label = 'first';
UPDATE public.edge_invocations SET queued_at = now() - interval '2 minutes' WHERE id IN (SELECT id FROM invocation_fixture);
INSERT INTO net._http_response (id, status_code, content, timed_out, created)
 SELECT request_id, 500, '{"ok":false}', false, now() FROM public.edge_invocations WHERE id IN (SELECT id FROM invocation_fixture);
SELECT private.reconcile_edge_invocations();
DO $$
BEGIN
  IF (SELECT count(*) FROM public.sync_runs WHERE function_name IN ('correlation-daily', 'cron:correlation-daily')) <> 1 THEN
    RAISE EXCEPTION 'worker failure is duplicated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.sync_runs WHERE id = (SELECT run FROM invocation_fixture WHERE label = 'first')
    AND status = 'failed' AND rows_affected = 633 AND error = 'one identity conflict') THEN
    RAISE EXCEPTION 'partial count or worker failure is lost';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cron_dispatch_state WHERE job_key = 'et-time:correlation-daily'
    AND retry_after > now() AND attempts = 1) THEN RAISE EXCEPTION 'failure does not permit a bounded retry'; END IF;
  IF private.claim_cron_dispatch('et-time:correlation-daily', to_char(timezone('America/New_York', now()), 'YYYY-MM-DD')) THEN
    RAISE EXCEPTION 'retry ignores backoff';
  END IF;
END $$;
UPDATE public.cron_dispatch_state SET retry_after = now() - interval '1 second' WHERE job_key = 'et-time:correlation-daily';
SELECT public.invoke_edge_function_at_et_time('correlation-daily', 0, 0);
INSERT INTO invocation_fixture SELECT 'second', id, invocation_key, NULL FROM public.edge_invocations
 WHERE function_name = 'correlation-daily' ORDER BY id DESC LIMIT 1;
SELECT public.start_edge_invocation(key, 'correlation-daily') FROM invocation_fixture WHERE label = 'second';
SELECT public.finish_edge_invocation(key, 'success', 634) FROM invocation_fixture WHERE label = 'second';
UPDATE public.edge_invocations SET queued_at = now() - interval '2 minutes' WHERE id = (SELECT id FROM invocation_fixture WHERE label = 'second');
INSERT INTO net._http_response (id, status_code, content, timed_out, created)
 SELECT request_id, NULL, NULL, true, now() FROM public.edge_invocations WHERE id = (SELECT id FROM invocation_fixture WHERE label = 'second');
SELECT private.reconcile_edge_invocations();
SELECT public.invoke_edge_function_at_et_time('correlation-daily', 0, 0);
DO $$
BEGIN
  IF (SELECT count(*) FROM public.edge_invocations WHERE function_name = 'correlation-daily') <> 2 THEN
    RAISE EXCEPTION 'successful retry dispatches again';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cron_dispatch_state WHERE job_key = 'et-time:correlation-daily' AND attempts = 2 AND retry_after IS NULL) THEN
    RAISE EXCEPTION 'stale first failure releases a newer successful claim';
  END IF;
  IF (SELECT count(*) FROM public.sync_runs WHERE function_name IN ('correlation-daily', 'cron:correlation-daily') AND status = 'failed') <> 1 THEN
    RAISE EXCEPTION 'transport timeout marks successful retry failed';
  END IF;
END $$;

INSERT INTO public.edge_invocations (function_name, invocation_key, queued_at)
 VALUES ('correlation-running', gen_random_uuid(), now());
INSERT INTO invocation_fixture SELECT 'running', id, invocation_key, NULL FROM public.edge_invocations WHERE function_name = 'correlation-running';
SELECT public.start_edge_invocation(key, 'correlation-running') FROM invocation_fixture WHERE label = 'running';
UPDATE public.edge_invocations SET queued_at = now() - interval '2 minutes' WHERE function_name = 'correlation-running';
SELECT private.reconcile_edge_invocations();
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.sync_runs WHERE id = (SELECT sync_run_id FROM public.edge_invocations WHERE function_name = 'correlation-running') AND status <> 'running') THEN
    RAISE EXCEPTION 'active worker is prematurely failed';
  END IF;
END $$;
UPDATE public.edge_invocations SET worker_started_at = now() - interval '11 minutes' WHERE function_name = 'correlation-running';
SELECT private.reconcile_edge_invocations();
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.sync_runs WHERE id = (SELECT sync_run_id FROM public.edge_invocations WHERE function_name = 'correlation-running')
    AND status = 'failed' AND error = 'worker did not finish within 10 minutes') THEN RAISE EXCEPTION 'stale worker never fails'; END IF;
END $$;
SELECT public.finish_edge_invocation(key, 'success', 7) FROM invocation_fixture WHERE label = 'running';
SELECT private.reconcile_edge_invocations();
DO $$
BEGIN
  IF (SELECT count(*) FROM public.sync_runs WHERE function_name IN ('correlation-running', 'cron:correlation-running')) <> 1
    OR NOT EXISTS (SELECT 1 FROM public.sync_runs WHERE function_name = 'correlation-running' AND status = 'success' AND rows_affected = 7) THEN
    RAISE EXCEPTION 'late completion does not repair the same canonical row';
  END IF;
END $$;

SELECT public.invoke_edge_function_at_et_time('correlation-late-success', 0, 0);
SELECT public.start_edge_invocation(invocation_key, 'correlation-late-success') FROM public.edge_invocations WHERE function_name = 'correlation-late-success';
UPDATE public.edge_invocations SET queued_at = now() - interval '12 minutes', worker_started_at = now() - interval '11 minutes'
 WHERE function_name = 'correlation-late-success';
SELECT private.reconcile_edge_invocations();
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.cron_dispatch_state WHERE job_key = 'et-time:correlation-late-success' AND retry_after IS NOT NULL) THEN
    RAISE EXCEPTION 'stale worker does not permit recovery';
  END IF;
END $$;
SELECT public.finish_edge_invocation(invocation_key, 'success', 7) FROM public.edge_invocations WHERE function_name = 'correlation-late-success';
SELECT private.reconcile_edge_invocations();
SELECT public.invoke_edge_function_at_et_time('correlation-late-success', 0, 0);
DO $$
BEGIN
  IF (SELECT count(*) FROM public.edge_invocations WHERE function_name = 'correlation-late-success') <> 1
    OR EXISTS (SELECT 1 FROM public.cron_dispatch_state WHERE job_key = 'et-time:correlation-late-success' AND retry_after IS NOT NULL) THEN
    RAISE EXCEPTION 'late success retains a redundant retry';
  END IF;
END $$;

SELECT public.invoke_edge_function_at_et_time('correlation-bounded', 0, 0);
DO $$
DECLARE v_id bigint; v_attempt integer;
BEGIN
  FOR v_attempt IN 1..3 LOOP
    SELECT max(id) INTO v_id FROM public.edge_invocations WHERE function_name = 'correlation-bounded';
    UPDATE public.edge_invocations SET queued_at = now() - interval '11 minutes' WHERE id = v_id;
    PERFORM private.reconcile_edge_invocations();
    UPDATE public.cron_dispatch_state SET retry_after = now() - interval '1 second' WHERE job_key = 'et-time:correlation-bounded' AND retry_after IS NOT NULL;
    PERFORM public.invoke_edge_function_at_et_time('correlation-bounded', 0, 0);
  END LOOP;
  IF (SELECT count(*) FROM public.edge_invocations WHERE function_name = 'correlation-bounded') <> 3 THEN
    RAISE EXCEPTION 'failed dispatch retry limit is not three';
  END IF;
END $$;

DO $$
DECLARE v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    EXECUTE format('SET LOCAL ROLE %I', v_role);
    BEGIN
      PERFORM public.start_edge_invocation(gen_random_uuid(), 'forbidden');
      RAISE EXCEPTION 'client starts internal invocation';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      PERFORM public.finish_edge_invocation(gen_random_uuid(), 'success');
      RAISE EXCEPTION 'client finishes internal invocation';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;
  END LOOP;
END $$;
GRANT SELECT ON invocation_fixture TO service_role;
SET LOCAL ROLE service_role;
DO $$
BEGIN
  BEGIN
    PERFORM public.start_edge_invocation((SELECT key FROM invocation_fixture WHERE label = 'first'), 'correlation-daily');
    RAISE EXCEPTION 'duplicate worker is allowed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Invocation already started or settled' THEN RAISE; END IF;
  END;
END $$;
RESET ROLE;
SELECT 'correlated dispatch: partial counts, timeout truth, active/stale/late workers, retry backoff/limit/fencing and explicit roles pass';
ROLLBACK;
