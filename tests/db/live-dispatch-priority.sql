BEGIN;
SET LOCAL app.supabase_url='http://127.0.0.1:1';
SET LOCAL app.edge_internal_token='live-dispatch-priority';
\ir rules-support.sql
DELETE FROM private.work_items;
DELETE FROM private.live_matchup_refresh_queue;
UPDATE private.worker_controls SET paused=false WHERE id;
CREATE OR REPLACE FUNCTION private.enqueue_scheduled_work(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END; $$;
CREATE OR REPLACE FUNCTION private.apply_scheduler_health(p_health jsonb)
RETURNS text LANGUAGE sql AS $$ SELECT 'normal'::text; $$;
CREATE OR REPLACE FUNCTION private.work_execute(p_id bigint,p_token uuid)
RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END; $$;
DO $$
DECLARE claimed integer; health text;
BEGIN
  FOREACH health IN ARRAY ARRAY['normal','degraded'] LOOP
    DELETE FROM private.work_items;
    EXECUTE format('CREATE OR REPLACE FUNCTION private.apply_scheduler_health(p_health jsonb) RETURNS text LANGUAGE sql AS %L','SELECT '||quote_literal(health)||'::text');
  FOR n IN 1..4 LOOP
    PERFORM private.work_enqueue('process-trades','older-'||n,now()-interval '1 hour',jsonb_build_object('fixture',n));
  END LOOP;
  PERFORM private.work_enqueue('live-poll','live-now',now());
  claimed:=public.dispatch_work();
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE key='live-now' AND status='running'),
    health||': live ingestion starts before four older asynchronous jobs occupy every slot');
  PERFORM pg_temp.check_rules(claimed=4 AND (SELECT count(*)=4 FROM private.work_items WHERE status='running'),
    health||': live priority preserves exactly four active workers');
  PERFORM pg_temp.check_rules((SELECT count(*)=3 FROM private.work_items WHERE kind='process-trades' AND status='running'),
    health||': ordinary ready jobs use the other three slots');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM private.work_items WHERE kind='process-trades' AND status='pending'),
    health||': the remaining ordinary job stays queued');
  END LOOP;
  DELETE FROM private.work_items;
  UPDATE private.worker_controls SET paused=true WHERE id;
  PERFORM private.work_enqueue('live-poll','paused-live',now());
  PERFORM pg_temp.check_rules(public.dispatch_work()=0,'live priority respects the explicit pause switch');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE key='paused-live' AND status='pending'),
    'paused live work remains queued');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
