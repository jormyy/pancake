\set ON_ERROR_STOP on
BEGIN;
\ir excellence-fixture.sql
DELETE FROM private.work_items;
DELETE FROM public.sync_jobs;
CREATE TEMP TABLE missing_final_fixture AS
SELECT id AS game_id,gen_random_uuid() AS scheduled_id FROM public.nba_games
WHERE game_date='2026-10-27' AND home_team='LAL' AND away_team='POR';
UPDATE public.nba_games SET status='Final' WHERE id IN(SELECT game_id FROM missing_final_fixture);
DELETE FROM public.player_game_stats WHERE game_id IN(SELECT game_id FROM missing_final_fixture);
INSERT INTO public.nba_games(id,nba_game_id,game_date,season_year,week_number,home_team,away_team,status)
SELECT scheduled_id,'002-scheduled-'||scheduled_id::text,'2026-10-26',2027,1,'RCH','RCA','Scheduled' FROM missing_final_fixture;
DO $$
DECLARE item private.work_items%ROWTYPE; first_job uuid; result jsonb;
BEGIN
  IF (SELECT count(*) FROM missing_final_fixture)<>1 THEN RAISE EXCEPTION 'The backup POR at LAL game is required'; END IF;
  PERFORM private.enqueue_scheduled_work('2026-10-28 10:15:00+00');
  IF EXISTS(SELECT 1 FROM private.work_items WHERE kind='missing-final-stats') THEN
    RAISE EXCEPTION 'Reconciliation runs before 06:30 Eastern';
  END IF;
  PERFORM private.enqueue_scheduled_work('2026-10-28 10:30:00+00');
  PERFORM private.enqueue_scheduled_work('2026-10-28 10:45:00+00');
  IF (SELECT count(*) FROM private.work_items WHERE kind='missing-final-stats')<>1 THEN
    RAISE EXCEPTION 'Daily reconciliation does not deduplicate';
  END IF;
  UPDATE private.work_items SET due_at=now() WHERE kind='missing-final-stats';
  DELETE FROM private.work_items WHERE kind<>'missing-final-stats';
  SELECT * INTO STRICT item FROM private.work_claim(1);
  PERFORM private.work_execute(item.id,item.lease_token);
  SELECT id INTO STRICT first_job FROM public.sync_jobs WHERE job_type='sync_stats_range:2026-10-27:2026-10-27';
  IF NOT EXISTS(SELECT 1 FROM private.work_items WHERE id=item.id AND status='succeeded')
    OR NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='stats-sync') THEN
    RAISE EXCEPTION 'Reconciliation does not use the existing stats dispatcher';
  END IF;
  result:=private.reconcile_missing_final_stats('2026-10-28 11:00:00+00');
  IF NOT result->'jobs' @> jsonb_build_array(first_job) OR
    (SELECT count(*) FROM public.sync_jobs WHERE job_type='sync_stats_range:2026-10-27:2026-10-27')<>1 THEN
    RAISE EXCEPTION 'Pending date repair is duplicated';
  END IF;
  IF EXISTS(SELECT 1 FROM public.sync_jobs WHERE job_type='sync_stats_range:2026-10-26:2026-10-26') THEN
    RAISE EXCEPTION 'Scheduled games enter final reconciliation';
  END IF;
END;
$$;
INSERT INTO public.nba_games(nba_game_id,game_date,season_year,week_number,home_team,away_team,status)
SELECT '002-reconcile-page-'||day::text,date '2000-01-01'+day,2000,1,'RCB','RCC','Final' FROM generate_series(1,17) day;
DO $$
DECLARE result jsonb; followup jsonb;
BEGIN
  result:=private.reconcile_missing_final_stats('2026-10-28 11:00:00+00');
  IF jsonb_array_length(result->'dates')<>16 THEN RAISE EXCEPTION 'Reconciliation batch exceeds or misses its bound'; END IF;
  IF NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='missing-final-stats' AND payload ? 'beforeDate') THEN
    RAISE EXCEPTION 'Reconciliation does not continue old missing games';
  END IF;
  followup:=private.reconcile_missing_final_stats('2026-10-28 11:00:00+00',(result->'dates'->>15)::date);
  IF jsonb_array_length(followup->'dates')<>2 THEN RAISE EXCEPTION 'Reconciliation cursor loses or repeats dates'; END IF;
END;
$$;
EXPLAIN (ANALYZE,BUFFERS,WAL) SELECT private.reconcile_missing_final_stats('2026-10-28 11:00:00+00');
ROLLBACK;
SELECT 'missing Final reconciliation: eight rules pass';
