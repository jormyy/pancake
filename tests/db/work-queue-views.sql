BEGIN;
\ir rules-support.sql
DELETE FROM private.work_items;
DELETE FROM private.screen_refresh_queue;
INSERT INTO private.screen_refresh_queue(league_id,league_season_id,dirty)
  SELECT season.league_id,season.id,false FROM public.league_seasons season
  JOIN public.leagues league ON league.id=season.league_id AND league.deleted_at IS NULL;
\getenv queue_api_url SUPABASE_URL
\if :{?queue_api_url}
SELECT set_config('app.supabase_url',:'queue_api_url',true);
\else
SELECT set_config('app.supabase_url','http://127.0.0.1:1',true);
\endif
SELECT set_config('app.edge_internal_token','queue-view-fixture',true);
DO $$
DECLARE f record; item private.work_items%ROWTYPE;
BEGIN
  PERFORM private.enqueue_screen_views();
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='refresh-views'),'idle views create no work');
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9569);
  DELETE FROM private.screen_refresh_queue WHERE league_season_id=f.season_id;
  PERFORM private.enqueue_screen_views();
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.screen_refresh_queue WHERE league_season_id=f.season_id),'view gate discovers an existing season');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM private.work_items WHERE kind='refresh-views'),'dirty views enter the single work queue');
  PERFORM private.enqueue_screen_views();
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM private.work_items WHERE kind='refresh-views'),'repeat view ticks do not duplicate work');
  SELECT * INTO item FROM private.work_claim();
  PERFORM private.work_execute(item.id,item.lease_token);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE id=item.id AND status='succeeded') AND NOT EXISTS(SELECT 1 FROM public.edge_invocations WHERE work_item_id=item.id),'view refresh completes bounded SQL work without an Edge invocation');
  DELETE FROM private.work_items;
  UPDATE private.screen_refresh_queue SET claimed_at=now() WHERE league_season_id=f.season_id;
  PERFORM private.enqueue_screen_views();
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='refresh-views'),'active view claims retain their three-minute exclusion');
  UPDATE private.screen_refresh_queue SET dirty=true,available_at=now(),claimed_at=now()-interval '3 minutes 1 second' WHERE league_season_id=f.season_id;
  PERFORM private.enqueue_screen_views();
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='refresh-views'),'stale view claims enqueue recovery');
  DELETE FROM private.work_items;
  UPDATE private.screen_refresh_queue SET available_at=now()+interval '1 minute' WHERE league_season_id=f.season_id;
  PERFORM private.enqueue_screen_views();
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='refresh-views'),'future view retries remain gated');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 AND bool_and(jobname='work-dispatcher') FROM cron.job WHERE jobname NOT IN ('io-hint-drain','io-cron-history-retention','public-read-retention','screen-statistics')),'view refresh adds no second cron entry');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
