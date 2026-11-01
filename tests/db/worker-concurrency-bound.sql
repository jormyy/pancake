BEGIN;
SET LOCAL statement_timeout='15s';
SET LOCAL lock_timeout='500ms';
\getenv concurrency_api_url SUPABASE_URL
\if :{?concurrency_api_url}
SELECT set_config('app.supabase_url',:'concurrency_api_url',true);
\else
SELECT set_config('app.supabase_url','http://127.0.0.1:1',true);
\endif
SET LOCAL app.edge_internal_token='worker-bound-fixture';
DELETE FROM private.work_items;
DO $$
DECLARE item record; claimed integer;
BEGIN
  FOR n IN 1..8 LOOP
    PERFORM private.work_enqueue('process-trades','concurrency-bound-'||n,now()-interval '2 minutes',jsonb_build_object('worker',n));
  END LOOP;
  SELECT count(*) INTO claimed FROM private.work_claim(64);
  IF claimed<>4 THEN RAISE EXCEPTION 'Expected four active workers, got %',claimed; END IF;
  SELECT count(*) INTO claimed FROM private.work_claim(64);
  IF claimed<>0 THEN RAISE EXCEPTION 'A full worker budget admits more work'; END IF;
  FOR item IN SELECT id,lease_token FROM private.work_items WHERE status='running' LOOP
    IF NOT private.work_finish(item.id,item.lease_token) THEN RAISE EXCEPTION 'A held lease cannot finish'; END IF;
  END LOOP;
  SELECT count(*) INTO claimed FROM private.work_claim(64);
  IF claimed<>4 THEN RAISE EXCEPTION 'Released slots do not admit the remaining workers'; END IF;
  FOR item IN SELECT id,lease_token FROM private.work_items WHERE status='running' LOOP
    PERFORM private.work_finish(item.id,item.lease_token);
  END LOOP;
  IF (SELECT count(*) FROM private.work_items WHERE status='succeeded')<>8 THEN RAISE EXCEPTION 'The cap loses work'; END IF;
  DELETE FROM private.work_items;
  DELETE FROM private.live_matchup_refresh_queue;
  UPDATE private.worker_controls SET paused=false WHERE id;
  FOR n IN 1..8 LOOP
    PERFORM private.work_enqueue('process-trades','dispatch-bound-'||n,now()-interval '2 days',jsonb_build_object('worker',n));
  END LOOP;
  CREATE OR REPLACE FUNCTION private.enqueue_scheduled_work(p_now timestamptz DEFAULT now())
  RETURNS void LANGUAGE plpgsql AS $fn$ BEGIN RETURN; END; $fn$;
  claimed:=public.dispatch_work();
  IF claimed<>4 THEN RAISE EXCEPTION 'A dispatch minute starts % workers instead of four',claimed; END IF;
  IF (SELECT count(*) FROM private.work_items WHERE status='running')<>4 THEN RAISE EXCEPTION 'Dispatch exceeds its concurrent limit'; END IF;
END;
$$;
ROLLBACK;
