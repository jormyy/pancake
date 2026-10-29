\set ON_ERROR_STOP on
\getenv publication_db_port PANCAKE_TEST_DB_PORT
SELECT :'HOST' IN ('127.0.0.1','localhost') AND :'PORT'=:'publication_db_port' AS publication_local \gset
\if :publication_local
\else
  DO $$ BEGIN RAISE EXCEPTION 'Use the private screen test database.'; END $$;
\endif
BEGIN;
SET LOCAL statement_timeout='60s';
SET LOCAL lock_timeout='5s';
\ir rules-support.sql
CREATE TEMP TABLE publication_fixture AS SELECT * FROM pg_temp.rules_fixture(2,9571);
SET CONSTRAINTS private.league_version_commit IMMEDIATE;
DO $$
DECLARE f record; before_version bigint; queue_version bigint;
BEGIN
  SELECT * INTO f FROM publication_fixture;
  UPDATE private.screen_refresh_queue SET dirty=false WHERE league_season_id=f.season_id;
  SELECT version INTO queue_version FROM private.screen_refresh_queue WHERE league_season_id=f.season_id;
  SELECT version INTO before_version FROM public.league_versions WHERE league_id=f.league_id;
  INSERT INTO public.standings_current(league_id,league_season_id,member_id,team_name,wins,losses,ties,points_for,points_against,max_points_for,version)
    VALUES(f.league_id,f.season_id,f.member_ids[1],'Published team',1,0,0,100,90,110,1);
  PERFORM pg_temp.check_rules((SELECT version=before_version+1 FROM public.league_versions WHERE league_id=f.league_id),'published rows advance the league version');
  PERFORM pg_temp.check_rules((SELECT NOT dirty AND version=queue_version FROM private.screen_refresh_queue WHERE league_season_id=f.season_id),'publication never queues another refresh');
  SELECT version INTO before_version FROM public.league_versions WHERE league_id=f.league_id;
  UPDATE public.standings_current SET wins=2 WHERE league_season_id=f.season_id;
  PERFORM pg_temp.check_rules((SELECT version=before_version+1 FROM public.league_versions WHERE league_id=f.league_id),'changed published fields advance the version');
  SELECT version INTO before_version FROM public.league_versions WHERE league_id=f.league_id;
  UPDATE public.standings_current SET version=version+1,refreshed_at=clock_timestamp() WHERE league_season_id=f.season_id;
  PERFORM pg_temp.check_rules((SELECT version=before_version FROM public.league_versions WHERE league_id=f.league_id),'refresh metadata alone does not advance the version');
  DELETE FROM public.standings_current WHERE league_season_id=f.season_id;
  PERFORM pg_temp.check_rules((SELECT version=before_version+1 FROM public.league_versions WHERE league_id=f.league_id),'removed published rows advance the version');
  PERFORM pg_temp.check_rules((SELECT NOT dirty AND version=queue_version FROM private.screen_refresh_queue WHERE league_season_id=f.season_id),'updates and removals do not create refresh loops');
  PERFORM pg_temp.check_rules((SELECT count(*)=12 FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('league_version_insert','league_version_update','league_version_delete') AND tgrelid IN ('public.standings_current'::regclass,'public.matchup_totals'::regclass,'public.player_season_averages'::regclass,'public.trade_value_cache'::regclass)),'all four derived tables publish version changes');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
