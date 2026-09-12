-- cron->edge invocations must leave a durable failure record when the function
-- never answered: transport error, non-2xx, or no response inside the grace window.
BEGIN;
INSERT INTO public.edge_invocations (function_name, request_id, queued_at) VALUES
  ('reconcile-test-ok',        990000001, now() - interval '5 minutes'),
  ('reconcile-test-http500',   990000002, now() - interval '5 minutes'),
  ('reconcile-test-transport', 990000003, now() - interval '5 minutes'),
  ('reconcile-test-fresh',     990000004, now() - interval '5 minutes'),
  ('reconcile-test-vanished',  990000005, now() - interval '3 hours');
INSERT INTO net._http_response (id, status_code, content_type, headers, content, timed_out, error_msg, created) VALUES
  (990000001, 200, 'application/json', '{}'::jsonb, '{"ok":true}', false, NULL, now()),
  (990000002, 500, 'application/json', '{}'::jsonb, '{"error":"boom"}', false, NULL, now()),
  (990000003, NULL, NULL, NULL, NULL, false, 'Couldn''t connect to server', now());

SELECT private.reconcile_edge_invocations() AS reconciled \gset
DO $$
DECLARE v_failed int; v_ok int; v_fresh int; v_vanished int;
BEGIN
  RAISE NOTICE 'reconciled rows: %', :reconciled;
  SELECT count(*) INTO v_ok FROM public.sync_runs WHERE function_name = 'cron:reconcile-test-ok';
  IF v_ok <> 0 THEN RAISE EXCEPTION 'a 200 must not produce a failed sync run'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.edge_invocations WHERE function_name = 'reconcile-test-ok' AND status_code = 200 AND reconciled_at IS NOT NULL) THEN
    RAISE EXCEPTION 'the 200 was not reconciled onto the invocation row';
  END IF;
  SELECT count(*) INTO v_failed FROM public.sync_runs WHERE function_name = 'cron:reconcile-test-http500' AND status = 'failed' AND error LIKE 'HTTP 500%';
  IF v_failed <> 1 THEN RAISE EXCEPTION 'HTTP 500 did not produce one failed sync run (got %)', v_failed; END IF;
  SELECT count(*) INTO v_failed FROM public.sync_runs WHERE function_name = 'cron:reconcile-test-transport' AND status = 'failed' AND error LIKE 'Couldn%';
  IF v_failed <> 1 THEN RAISE EXCEPTION 'transport error did not produce one failed sync run (got %)', v_failed; END IF;
  SELECT count(*) INTO v_fresh FROM public.edge_invocations WHERE function_name = 'reconcile-test-fresh' AND reconciled_at IS NOT NULL;
  IF v_fresh <> 0 THEN RAISE EXCEPTION 'an invocation inside the grace window was reconciled too early'; END IF;
  SELECT count(*) INTO v_vanished FROM public.sync_runs WHERE function_name = 'cron:reconcile-test-vanished' AND status = 'failed' AND error LIKE 'no response recorded%';
  IF v_vanished <> 1 THEN RAISE EXCEPTION 'a vanished response past the grace window was not failed closed'; END IF;
END $$;
-- idempotent: a second pass reconciles nothing new
DO $$
DECLARE v_again int;
BEGIN
  SELECT private.reconcile_edge_invocations() INTO v_again;
  IF v_again <> 0 THEN RAISE EXCEPTION 'second reconcile pass touched % rows', v_again; END IF;
END $$;
ROLLBACK;
