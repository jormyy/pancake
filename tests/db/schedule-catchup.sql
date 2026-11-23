\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='120s';
CREATE TEMP TABLE schedule_failures(label text);
CREATE FUNCTION pg_temp.expect_once(p_label text,p_kind text,p_first timestamptz,p_again timestamptz,p_expected integer)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_first bigint; v_again bigint;
BEGIN
  DELETE FROM private.work_items WHERE kind=p_kind;
  PERFORM private.enqueue_scheduled_work(p_first);
  SELECT count(*) INTO v_first FROM private.work_items WHERE kind=p_kind;
  UPDATE private.work_items SET status='succeeded',lease_token=NULL,lease_until=NULL,completed_at=p_first WHERE kind=p_kind;
  PERFORM private.enqueue_scheduled_work(p_again);
  SELECT count(*) INTO v_again FROM private.work_items WHERE kind=p_kind;
  IF v_first<>p_expected THEN
    INSERT INTO schedule_failures VALUES(format('%s: %s queued %s item(s) at %s, expected %s',p_label,p_kind,v_first,p_first,p_expected));
  ELSIF v_again<>v_first THEN
    INSERT INTO schedule_failures VALUES(format('%s: %s queued again at %s in the same period',p_label,p_kind,p_again));
  END IF;
END;
$$;
CREATE FUNCTION pg_temp.expect_none(p_label text,p_kind text,p_at timestamptz)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM private.work_items WHERE kind=p_kind;
  PERFORM private.enqueue_scheduled_work(p_at);
  IF EXISTS(SELECT 1 FROM private.work_items WHERE kind=p_kind) THEN
    INSERT INTO schedule_failures VALUES(format('%s: %s queued at %s, before it was due',p_label,p_kind,p_at));
  END IF;
END;
$$;
INSERT INTO public.edge_invocations(function_name) VALUES('schedule-catchup-fixture');
CREATE TEMP TABLE scheduled_jobs(kind text,due_local timestamp,zone text,again interval,expected integer);
INSERT INTO scheduled_jobs VALUES
  ('sync-players','2098-10-21 04:00','America/New_York','100 minutes',1),
  ('sync-trade-values','2098-10-21 04:00','America/New_York','100 minutes',1),
  ('sync-rankings','2098-10-21 04:00','America/New_York','100 minutes',3),
  ('sync-schedule','2098-10-21 06:05','America/New_York','45 minutes',1),
  ('missing-final-stats','2098-10-21 06:30','America/New_York','40 minutes',1),
  ('cleanup-trade-estimates','2098-10-21 08:35','UTC','75 minutes',1),
  ('mock-room-expiry','2098-10-21 09:30','UTC','90 minutes',1),
  ('retention-prune','2098-10-21 10:00','UTC','2 hours',1),
  ('public-read-retention','2098-10-21 13:17','UTC','33 minutes',1),
  ('pg-net-response-vacuum','2098-10-21 13:17','UTC','33 minutes',1),
  ('edge-invocation-reconcile','2098-10-21 13:05','UTC','4 minutes',1);
DO $$
DECLARE v_job record; v_due timestamptz;
BEGIN
  FOR v_job IN SELECT job.kind,job.due_local+make_interval(days=>28*(row_number() OVER ()-1)::int) AS due_local,
      job.zone,job.again,job.expected FROM scheduled_jobs job LOOP
    v_due:=v_job.due_local AT TIME ZONE v_job.zone;
    PERFORM pg_temp.expect_once('on-time tick',v_job.kind,v_due,v_due+v_job.again,v_job.expected);
    v_due:=(v_job.due_local+interval '7 days') AT TIME ZONE v_job.zone;
    PERFORM pg_temp.expect_once('tick 3 minutes late',v_job.kind,v_due+interval '3 minutes',v_due+v_job.again,v_job.expected);
    v_due:=(v_job.due_local+interval '14 days') AT TIME ZONE v_job.zone;
    PERFORM pg_temp.expect_once('dispatch returned early on the due minute',v_job.kind,v_due+interval '1 minute',v_due+v_job.again,v_job.expected);
  END LOOP;
END;
$$;
DO $$
DECLARE v_failures text;
BEGIN
  SELECT string_agg(label,E'\n' ORDER BY label) INTO v_failures FROM schedule_failures;
  IF v_failures IS NOT NULL THEN
    RAISE EXCEPTION E'Scheduled work skipped a period:\n%',v_failures
      USING HINT='Schedule each job as a private.work_kinds row with a cadence, not a code branch or an exact-time gate.';
  END IF;
END;
$$;
INSERT INTO private.work_kinds(kind,cadence,due_offset,cadence_zone)
VALUES('schedule-catchup-probe',interval '7 days',interval '2 days 7 hours','America/New_York');
DO $$
DECLARE v_kind record; v_target timestamptz;
BEGIN
  FOR v_kind IN SELECT * FROM private.work_kinds WHERE cadence IS NOT NULL AND retired_at IS NULL ORDER BY kind LOOP
    v_target:=(date_bin(v_kind.cadence,timestamp '2098-11-04 00:00',timestamp '2000-01-03 00:00')+v_kind.due_offset)
      AT TIME ZONE v_kind.cadence_zone;
    PERFORM pg_temp.expect_none('cadence row',v_kind.kind,v_target-interval '1 minute');
    PERFORM pg_temp.expect_once('cadence row tick 3 minutes late',v_kind.kind,v_target+interval '3 minutes',v_target+interval '9 minutes',1);
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM schedule_failures) THEN RETURN; END IF;
  RAISE EXCEPTION E'A work_kinds cadence row skipped a period:\n%',(SELECT string_agg(label,E'\n' ORDER BY label) FROM schedule_failures);
END;
$$;
ROLLBACK;
