BEGIN;
SET LOCAL app.supabase_url='http://127.0.0.1:1';
SET LOCAL app.edge_internal_token='dispatch-short-work';
\ir rules-support.sql
DELETE FROM private.work_items;
DELETE FROM private.live_matchup_refresh_queue;
UPDATE private.worker_controls SET paused=false WHERE id;
CREATE OR REPLACE FUNCTION private.enqueue_scheduled_work(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END; $$;
CREATE OR REPLACE FUNCTION private.apply_scheduler_health(p_health jsonb)
RETURNS text LANGUAGE sql AS $$ SELECT 'normal'::text; $$;
CREATE OR REPLACE FUNCTION private.work_execute(p_id bigint,p_token uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT kind='cleanup-trade-estimates' FROM private.work_items WHERE id=p_id) THEN
    PERFORM private.work_finish(p_id,p_token);
  END IF;
END;
$$;
DO $$
DECLARE claimed integer;
BEGIN
  FOR n IN 1..4 LOOP
    PERFORM private.work_enqueue('cleanup-trade-estimates','short-'||n,now()-interval '2 hours',jsonb_build_object('fixture',n));
  END LOOP;
  PERFORM private.work_enqueue('live-poll','live-after-short-work',now()-interval '1 hour');
  FOR n IN 1..8 LOOP
    PERFORM private.work_enqueue('process-trades','async-'||n,now(),jsonb_build_object('fixture',n));
  END LOOP;
  claimed:=public.dispatch_work();
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE key='live-after-short-work' AND status='running'),
    'completed SQL work does not delay a live worker to the next minute');
  PERFORM pg_temp.check_rules((SELECT count(*)=4 FROM private.work_items WHERE status='running'),
    'short work preserves the four concurrent worker cap');
  PERFORM pg_temp.check_rules((SELECT count(*)=4 FROM private.work_items WHERE kind='cleanup-trade-estimates' AND status='succeeded'),
    'all earlier short work completes');
  PERFORM pg_temp.check_rules(claimed=8,'dispatch counts both completed SQL and admitted workers');
  DELETE FROM private.work_items;
  FOR n IN 1..40 LOOP
    PERFORM private.work_enqueue('cleanup-trade-estimates','bounded-'||n,now(),jsonb_build_object('fixture',n));
  END LOOP;
  claimed:=public.dispatch_work();
  PERFORM pg_temp.check_rules(claimed=32,'short SQL work retains a finite dispatch bound');
  PERFORM pg_temp.check_rules((SELECT count(*)=8 FROM private.work_items WHERE status='pending'),
    'excess short work remains queued for a later dispatch');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
