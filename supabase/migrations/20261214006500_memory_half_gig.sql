BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';

DO $$
BEGIN
  IF (SELECT count(*) FROM cron.job WHERE jobname='io-cron-history-retention')<>1 THEN
    RAISE EXCEPTION 'The hourly retention job is missing or duplicated';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index removed JOIN pg_index retained
      ON removed.indrelid=retained.indrelid
      AND removed.indkey=retained.indkey AND removed.indclass=retained.indclass
      AND removed.indcollation=retained.indcollation AND removed.indoption=retained.indoption
      AND removed.indisunique=retained.indisunique
      AND removed.indexprs IS NOT DISTINCT FROM retained.indexprs
      AND removed.indpred IS NOT DISTINCT FROM retained.indpred
    WHERE removed.indexrelid='public.idx_trade_game_time'::regclass
      AND retained.indexrelid='public.idx_nba_games_game_time'::regclass
      AND retained.indisvalid AND retained.indisready
  ) THEN
    RAISE EXCEPTION 'The retained game-time index does not cover the removed index';
  END IF;
END;
$$;
DROP INDEX public.idx_trade_game_time;

ALTER TABLE public.player_game_stats SET (
  fillfactor=90,
  autovacuum_vacuum_threshold=50,
  autovacuum_vacuum_scale_factor=0.02,
  autovacuum_analyze_threshold=25,
  autovacuum_analyze_scale_factor=0.02
);

DO $$
DECLARE target regclass; trigger_row record; arguments text[]; predicate text;
BEGIN
  FOREACH target IN ARRAY ARRAY['public.player_game_stats'::regclass,'public.nba_games'::regclass] LOOP
    SELECT * INTO STRICT trigger_row FROM pg_trigger
      WHERE tgrelid=target AND tgname='score_revision_nba' AND NOT tgisinternal;
    IF trigger_row.tgfoid<>'private.track_score_input_revision()'::regprocedure
      OR trigger_row.tgtype<>29 OR trigger_row.tgenabled<>'O' THEN
      RAISE EXCEPTION 'Unexpected score revision trigger on %',target;
    END IF;
    arguments:=string_to_array(encode(trigger_row.tgargs,'escape'),'\000');
    SELECT string_agg(CASE WHEN field='stats_synced_at'
      THEN '(OLD.stats_synced_at IS NULL) IS DISTINCT FROM (NEW.stats_synced_at IS NULL)'
      ELSE format('OLD.%1$I IS DISTINCT FROM NEW.%1$I',field) END,' OR ')
    INTO predicate FROM unnest(string_to_array(arguments[2],',')) field;
    EXECUTE format('CREATE OR REPLACE TRIGGER score_revision_nba AFTER INSERT OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION private.track_score_input_revision(%L,%L)',target,arguments[1],arguments[2]);
    EXECUTE format('CREATE TRIGGER score_revision_nba_update AFTER UPDATE ON %s FOR EACH ROW WHEN (%s) EXECUTE FUNCTION private.track_score_input_revision(%L,%L)',target,predicate,arguments[1],arguments[2]);
  END LOOP;
END;
$$;

SELECT cron.alter_job(jobid,command:=$command$
SET statement_timeout='5s';
SET lock_timeout='100ms';
SET work_mem='2MB';
DO $job$
BEGIN
  IF (SELECT paused FROM private.worker_controls WHERE id)
    OR NOT pg_try_advisory_xact_lock(hashtextextended('io-cron-history-retention',0)) THEN
    RETURN;
  END IF;

  PERFORM private.retain_cron_job_run_details();

  WITH victims AS MATERIALIZED (
    SELECT ctid FROM cron.job_run_details
    WHERE status='succeeded' AND end_time<now()-interval '6 hours'
    ORDER BY runid LIMIT 512 FOR UPDATE SKIP LOCKED
  ) DELETE FROM cron.job_run_details WHERE ctid=ANY(ARRAY(SELECT ctid FROM victims));

  WITH victims AS MATERIALIZED (
    SELECT run.id FROM public.sync_runs run
    WHERE run.status='success' AND run.error IS NULL
      AND run.finished_at IS NOT NULL AND run.finished_at<now()-interval '1 day'
      AND run.id IS DISTINCT FROM (
        SELECT newest.id FROM public.sync_runs newest
        WHERE newest.function_name=run.function_name AND newest.status='success'
          AND newest.error IS NULL AND newest.finished_at IS NOT NULL
        ORDER BY newest.started_at DESC,newest.id DESC LIMIT 1
      )
    ORDER BY run.finished_at,run.id LIMIT 4096 FOR UPDATE OF run SKIP LOCKED
  ) DELETE FROM public.sync_runs run USING victims WHERE run.id=victims.id;

  WITH victims AS MATERIALIZED (
    SELECT id,inserted_at FROM realtime.messages
    WHERE extension='broadcast' AND private IS TRUE AND topic LIKE 'l1:%'
      AND inserted_at<now()-interval '1 day'
    ORDER BY inserted_at LIMIT 4096 FOR UPDATE SKIP LOCKED
  ) DELETE FROM realtime.messages message USING victims
    WHERE message.id=victims.id AND message.inserted_at=victims.inserted_at
      AND message.inserted_at<now()-interval '1 day';

  WITH victims AS MATERIALIZED (
    SELECT ctid FROM private.scheduler_health_log
    WHERE created_at<now()-interval '7 days'
    ORDER BY id LIMIT 512 FOR UPDATE SKIP LOCKED
  ) DELETE FROM private.scheduler_health_log WHERE ctid=ANY(ARRAY(SELECT ctid FROM victims));
END;
$job$;
$command$) FROM cron.job WHERE jobname='io-cron-history-retention';

UPDATE private.retention_rules SET retention_rule=
  'Succeeded: 6 hours; failed and orphaned: 24 hours; active executions stay; 512 rows per hourly batch'
WHERE relation_name='cron.job_run_details';
UPDATE private.retention_rules SET retention_rule=
  'Succeeded: 1 day, plus newest success per function; failed: 30 days, plus newest failure; active rows stay; hourly success batch of 4096'
WHERE relation_name='public.sync_runs';
UPDATE private.retention_rules SET retention_rule=
  'Scheduler state transitions: 7 days; current state and revision stay in worker_controls and scheduler_health_hint; 512 rows per hourly batch'
WHERE relation_name='private.scheduler_health_log';
INSERT INTO private.retention_rules(relation_name,retention_rule) VALUES
  ('realtime.messages','Private l1 application broadcasts: 1 day; 4096 rows per hourly batch; other messages follow managed Realtime retention')
ON CONFLICT(relation_name) DO UPDATE SET retention_rule=EXCLUDED.retention_rule;

COMMIT;
