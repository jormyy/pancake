\set ON_ERROR_STOP on
\getenv io_port PANCAKE_TEST_DB_PORT
\if :{?io_port}
\else
  \set io_port 58922
\endif
SELECT :'HOST' IN ('127.0.0.1','localhost') AND :'PORT'=:'io_port' AS io_local \gset
\if :io_local
\else
  DO $$ BEGIN RAISE EXCEPTION 'Use the private IO test database.'; END $$;
\endif
BEGIN;
SET LOCAL app.supabase_url='http://127.0.0.1:1';
SET LOCAL app.edge_internal_token='io-fixture';
\ir rules-support.sql
CREATE TEMP TABLE io_writes(relation_name text,operation text);
CREATE FUNCTION pg_temp.observe_io() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO io_writes
  SELECT n.nspname||'.'||c.relname,TG_OP
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.oid=coalesce(pg_partition_root(TG_RELID),TG_RELID);
  RETURN NULL;
END;
$$;
DO $$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['public.standings_current','public.matchup_totals','public.player_season_averages',
    'public.trade_value_cache','private.trade_value_publications','public.league_change_hints','private.league_version_pending',
    'public.nba_games','public.player_game_stats','private.score_input_revisions','private.work_items',
    'public.edge_invocations','public.league_events','cron.job_run_details','net._http_response'] LOOP
    EXECUTE format('CREATE TRIGGER io_observe AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION pg_temp.observe_io()',relation);
  END LOOP;
END;
$$;
CREATE TEMP TABLE io_fixture AS SELECT * FROM pg_temp.rules_fixture(2,9588);
DO $$
DECLARE f record; game uuid:=gen_random_uuid(); player uuid:=gen_random_uuid(); matchup uuid:=gen_random_uuid(); trade uuid:=gen_random_uuid(); trade_values jsonb;
  hint_revision bigint; provider text:='002-io-'||game; stats jsonb; v_version bigint; changed integer; relation text;
BEGIN
  SELECT * INTO f FROM io_fixture;
  INSERT INTO public.players(id,first_name,last_name) VALUES(player,'IO','Fixture');
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    VALUES(game,provider,9588,1,'9588-01-01','XXA','XXB','Scheduled');
  stats:=jsonb_build_array(jsonb_build_object('player_id',player,'game_id',game,'points',20,'did_not_play',false));
  PERFORM public.save_live_scoreboard_atomic(game,provider,'InProgress',30,20,'Q1',600);
  PERFORM public.save_live_game_stats_atomic(game,provider,stats,600);
  TRUNCATE io_writes;
  PERFORM public.save_live_scoreboard_atomic(game,provider,'InProgress',30,20,'Q1',600);
  changed:=public.save_live_game_stats_atomic(game,provider,stats,600);
  PERFORM pg_temp.check_rules(changed=0 AND NOT EXISTS(SELECT 1 FROM io_writes),'same live snapshot writes no rows or revisions');
  PERFORM public.save_live_game_stats_atomic(game,provider,jsonb_set(stats,'{0,points}','21'),600);
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM io_writes WHERE relation_name='public.player_game_stats'),'same-clock stat correction writes one changed line');
  TRUNCATE io_writes;
  PERFORM public.save_live_scoreboard_atomic(game,provider,'InProgress',31,20,'Q1',600);
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM io_writes WHERE relation_name='public.nba_games'),'same-clock score correction writes once');
  TRUNCATE io_writes;
  PERFORM public.save_live_game_stats_atomic(game,provider,jsonb_set(stats,'{0,points}','21'),601);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM io_writes WHERE relation_name='public.player_game_stats'),'advancing clock preserves unchanged stat lines');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM io_writes WHERE relation_name='public.nba_games'),'advancing clock retains the ordering fence');
  INSERT INTO public.matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id,home_points,away_points)
    VALUES(matchup,f.league_id,f.season_id,1,f.member_ids[1],f.member_ids[2],42,31);
  INSERT INTO public.trades(id,league_id,league_season_id,proposer_member_id,recipient_member_id)
    VALUES(trade,f.league_id,f.season_id,f.member_ids[1],f.member_ids[2]);
  INSERT INTO public.trade_participants(trade_id,league_id,member_id,proposed_at,sort_order,is_initiator)
    VALUES(trade,f.league_id,f.member_ids[1],now(),0,true),(trade,f.league_id,f.member_ids[2],now(),1,false);
  INSERT INTO public.trade_items(trade_id,side,from_member_id,to_member_id,faab_amount)
    VALUES(trade,'proposer',f.member_ids[1],f.member_ids[2],1);
  trade_values:=jsonb_build_array(jsonb_build_object('tradeId',trade,'revaluation',jsonb_build_object(
    'analysis','{"teams":[]}'::jsonb,'modelVersion','io-fixture',
    'inputVersion',public.get_trade_revaluation_inputs(f.user_ids[1],f.member_ids[1],trade)->>'inputVersion')));
  SELECT q.version INTO v_version FROM private.screen_refresh_queue q WHERE league_season_id=f.season_id;
  PERFORM private.refresh_standings(f.league_id,f.season_id,v_version);
  PERFORM private.refresh_matchup_totals(f.league_id,f.season_id,v_version);
  PERFORM private.refresh_player_averages(f.league_id,f.season_id,v_version);
  PERFORM private.refresh_trade_values(f.league_id,f.season_id,v_version,trade_values);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.player_season_averages WHERE league_season_id=f.season_id),'average fixture contains a row');
  UPDATE private.screen_refresh_queue SET version=version+1 WHERE league_season_id=f.season_id;
  v_version:=v_version+1;
  TRUNCATE io_writes;
  PERFORM private.refresh_standings(f.league_id,f.season_id,v_version);
  PERFORM private.refresh_matchup_totals(f.league_id,f.season_id,v_version);
  PERFORM private.refresh_player_averages(f.league_id,f.season_id,v_version);
  PERFORM private.refresh_trade_values(f.league_id,f.season_id,v_version,trade_values);
  PERFORM private.refresh_queue_trade_revaluation(trade,trade_values->0->'revaluation'->>'inputVersion','io-fixture');
  RAISE NOTICE 'IO unchanged cache rows=%', (SELECT count(*) FROM io_writes WHERE relation_name IN ('public.standings_current','public.matchup_totals','public.player_season_averages','public.trade_value_cache'));
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM io_writes WHERE relation_name<>'private.trade_value_publications'),'new publication with identical screen content writes no cached rows');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.player_season_averages WHERE league_season_id=f.season_id),'unchanged average survives pruning');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM io_writes WHERE relation_name='private.trade_value_publications'),'trade freshness writes one small publication row');
  TRUNCATE io_writes;
  PERFORM private.refresh_trade_values(f.league_id,f.season_id,v_version,trade_values);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM io_writes),'identical trade publication writes no content or metadata');
  SET CONSTRAINTS ALL IMMEDIATE;
  UPDATE private.screen_refresh_queue SET dirty=false WHERE league_season_id=f.season_id;
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  PERFORM pg_temp.check_rules(NOT (public.view_context(f.league_id,f.member_ids[1],jsonb_build_object('seasonId',f.season_id,'tradeId',trade))->>'tradeAnalysisStale')::boolean,'unchanged trade content retains fresh publication');
  SET CONSTRAINTS ALL DEFERRED;
  UPDATE private.trade_value_publications SET valid_until=now()-interval '1 second' WHERE trade_id=trade;
  PERFORM pg_temp.check_rules((public.view_context(f.league_id,f.member_ids[1],jsonb_build_object('seasonId',f.season_id,'tradeId',trade))->>'tradeAnalysisStale')::boolean,'expired trade publication remains stale');
  UPDATE public.league_members SET team_name='Changed IO team' WHERE id=f.member_ids[1];
  UPDATE private.screen_refresh_queue SET version=version+1 WHERE league_season_id=f.season_id;
  SELECT q.version INTO v_version FROM private.screen_refresh_queue q WHERE league_season_id=f.season_id;
  TRUNCATE io_writes;
  PERFORM private.refresh_standings(f.league_id,f.season_id,v_version);
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM io_writes WHERE relation_name='public.standings_current'),'changed screen content writes only its changed row');
  PERFORM private.league_version_enqueue(f.league_id,'score','matchups');
  TRUNCATE io_writes;
  PERFORM private.league_version_enqueue(f.league_id,'score','matchups');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM io_writes),'repeated version topic and source write no pending row');
  TRUNCATE io_writes;
  UPDATE public.matchups SET home_points=43 WHERE id=matchup;
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM io_writes WHERE relation_name='public.league_change_hints' AND operation='UPDATE'),'same transaction coalesces an already covered score scope');
  SELECT revision INTO hint_revision FROM public.league_change_hints WHERE league_id=f.league_id AND topic='score';
  INSERT INTO public.matchups(league_id,league_season_id,week_number,home_member_id,away_member_id)
    VALUES(f.league_id,f.season_id,2,f.member_ids[1],f.member_ids[2]);
  PERFORM pg_temp.check_rules((SELECT revision=hint_revision AND jsonb_array_length(scopes)=2
    FROM public.league_change_hints WHERE league_id=f.league_id AND topic='score'),'new scope merges without a second transaction revision');
  INSERT INTO public.matchups(league_id,league_season_id,week_number,home_member_id,away_member_id)
    SELECT f.league_id,f.season_id,week,f.member_ids[1],f.member_ids[2] FROM generate_series(3,18) week;
  PERFORM pg_temp.check_rules((SELECT revision=hint_revision AND scopes IS NULL
    FROM public.league_change_hints WHERE league_id=f.league_id AND topic='score'),'wide merged scopes keep the full refresh signal');
END;
$$;
DO $$
DECLARE run bigint:=900000000001; result jsonb; reference_time timestamptz:=now()+interval '25 hours';
BEGIN
  DELETE FROM cron.job_run_details;
  INSERT INTO cron.job_run_details(jobid,runid,status,start_time,end_time)
    VALUES(999999,run,'succeeded',reference_time-interval '25 hours',reference_time-interval '25 hours'),
      (999999,run+1,'failed',reference_time-interval '25 hours',reference_time-interval '25 hours'),
      (999999,run+2,'succeeded',reference_time-interval '23 hours',reference_time-interval '23 hours'),
      (999999,run+3,'running',reference_time-interval '25 hours',NULL);
  UPDATE cron.job_run_details SET job_pid=pg_backend_pid() WHERE runid=run+3;
  result:=private.retain_cron_job_run_details(reference_time);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM cron.job_run_details WHERE runid IN(run,run+1)),'cron success and failure expire after 24 hours');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM cron.job_run_details WHERE runid=run+2),'recent cron history stays');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM cron.job_run_details WHERE runid=run+3),'live cron execution stays');
  TRUNCATE io_writes;
  result:=private.retain_cron_job_run_details(reference_time);
  PERFORM pg_temp.check_rules((result->>'cron.job_run_details')::int=0 AND NOT EXISTS(SELECT 1 FROM io_writes),'unchanged retained history writes no rows');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 AND bool_and(schedule='12 * * * *') FROM cron.job WHERE jobname='io-cron-history-retention'),'cron retention has one bounded hourly schedule');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 AND bool_and(schedule='* * * * *') FROM cron.job WHERE jobname='io-hint-drain'),'hint drain keeps a minute wake without edge work');
  PERFORM private.work_enqueue('player-stats-hints','io-dedupe');
  UPDATE private.work_items SET status='succeeded',completed_at=now() WHERE kind='player-stats-hints' AND key='io-dedupe';
  SELECT last_value INTO run FROM private.work_items_id_seq;
  TRUNCATE io_writes;
  PERFORM private.work_enqueue('player-stats-hints','io-dedupe');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM io_writes) AND (SELECT last_value=run FROM private.work_items_id_seq),'completed enqueue replay writes no row or sequence');
END;
$$;
DO $$
DECLARE options text[];
BEGIN
  SELECT reloptions INTO options FROM pg_class WHERE oid='private.work_items'::regclass;
  PERFORM pg_temp.check_rules(options @> ARRAY['fillfactor=90','autovacuum_vacuum_threshold=50','autovacuum_vacuum_scale_factor=0.02'],'hot work table has bounded vacuum and page reserve');
END;
$$;
TRUNCATE public.leagues CASCADE;
TRUNCATE public.sync_jobs,public.edge_invocations,private.work_items CASCADE;
TRUNCATE private.player_stats_hint_pending,private.league_hint_pending;
TRUNCATE io_writes;
DO $$
DECLARE sequence_value bigint;
BEGIN
  SELECT last_value INTO sequence_value FROM private.work_items_id_seq;
  PERFORM private.enqueue_scheduled_work('2000-01-01 00:01:00+00');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM io_writes),'idle scheduling creates no work, events, or invocations');
  PERFORM pg_temp.check_rules((SELECT last_value=sequence_value FROM private.work_items_id_seq),'idle scheduling does not advance work sequence');
  PERFORM private.flush_player_stats_hints();
  PERFORM private.flush_league_inventory_hints(1000);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM io_writes),'empty minute drain writes no application rows');
END;
$$;
CREATE OR REPLACE FUNCTION private.enqueue_scheduled_work(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END; $$;
CREATE OR REPLACE FUNCTION private.work_claim(p_limit integer DEFAULT 64)
RETURNS SETOF private.work_items LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Idle dispatcher attempts a claim'; END; $$;
UPDATE private.worker_controls SET paused=false WHERE id;
DO $$
BEGIN
  PERFORM pg_temp.check_rules(public.dispatch_work()=0,'empty dispatcher returns before claim bookkeeping');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM io_writes),'empty dispatcher writes no application rows');
END;
$$;
UPDATE private.worker_controls SET paused=true WHERE id;
CREATE OR REPLACE FUNCTION private.flush_player_stats_hints()
RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Paused hint drain runs'; END; $$;
CREATE OR REPLACE FUNCTION private.flush_league_inventory_hints(p_limit integer DEFAULT 1000)
RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Paused inventory drain runs'; END; $$;
CREATE OR REPLACE FUNCTION private.retain_cron_job_run_details(p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Paused retention runs'; END; $$;
DO $$
DECLARE job record;
BEGIN
  FOR job IN SELECT command FROM cron.job WHERE jobname IN ('io-hint-drain','io-cron-history-retention') LOOP
    EXECUTE job.command;
  END LOOP;
  PERFORM pg_temp.check_rules(true,'IO maintenance preserves the operator pause');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
