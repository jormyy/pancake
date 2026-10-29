\set ON_ERROR_STOP on
BEGIN;
\ir rules-support.sql
DELETE FROM private.work_items;
DO $$
DECLARE f record; item private.work_items%ROWTYPE; cutoff timestamptz:=date_trunc('hour',now())-interval '7 days';
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9596);
  PERFORM private.enqueue_scheduled_work('2026-01-14 12:16 UTC');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='public-read-retention'),'read retention waits until minute seventeen');
  PERFORM private.enqueue_scheduled_work('2026-01-14 12:17 UTC');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM private.work_items WHERE kind='public-read-retention'),'read retention enqueues at minute seventeen');
  PERFORM private.enqueue_scheduled_work('2026-01-14 12:59 UTC');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM private.work_items WHERE kind='public-read-retention'),'read retention keeps one key per hour');
  UPDATE private.work_items SET status='succeeded' WHERE kind='public-read-retention';
  PERFORM private.enqueue_scheduled_work('2026-01-14 13:45 UTC');
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM private.work_items WHERE kind='public-read-retention'),'read retention catches up after a missed tick');
  DELETE FROM private.work_items WHERE kind<>'public-read-retention';
  INSERT INTO public.public_read_log(league_id,hour,resource,reads)
    VALUES(f.league_id,cutoff-interval '1 hour','league',1),(f.league_id,cutoff,'league',1),(f.league_id,cutoff+interval '1 hour','league',1);
  SELECT * INTO item FROM private.work_claim(1);
  PERFORM private.work_execute(item.id,item.lease_token);
  PERFORM pg_temp.check_rules((SELECT status='succeeded' FROM private.work_items WHERE id=item.id),'dispatcher completes read retention');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.public_read_log WHERE league_id=f.league_id AND hour<cutoff),'dispatcher removes expired read logs');
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM public.public_read_log WHERE league_id=f.league_id),'dispatcher preserves cutoff and fresh read logs');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM cron.job WHERE jobname='public-read-retention'),'separate read retention cron is removed');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
