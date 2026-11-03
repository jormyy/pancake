\set ON_ERROR_STOP on
\getenv daily_db_url SUPABASE_DB_URL
SELECT :'daily_db_url' ~ '^postgres(ql)?://[^/]+@(127\.0\.0\.1|localhost):[0-9]+/[^?]+$' AS daily_local \gset
\if :daily_local
\else
  DO $$ BEGIN RAISE EXCEPTION 'Daily tests require an isolated local database'; END $$;
\endif
BEGIN;
\ir rules-support.sql
UPDATE public.lineup_optimizer_settings SET enabled=false;
CREATE TEMP TABLE daily_fixture AS SELECT * FROM pg_temp.rules_fixture(2, 9198);
DO $$
DECLARE
  f record; d date := (now() AT TIME ZONE 'America/New_York')::date;
  pg uuid := gen_random_uuid(); center uuid := gen_random_uuid(); game uuid := gen_random_uuid();
  morning timestamptz; early timestamptz; assignments jsonb; before_rows jsonb; first_work bigint;
BEGIN
  SELECT * INTO f FROM daily_fixture;
  morning := (d + time '06:00') AT TIME ZONE 'America/New_York';
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(9198,1,d,d+6);
  INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,nba_team) VALUES
    (pg,'Daily','Guard','PG',ARRAY['PG'],'DA1'),(center,'Daily','Center','C',ARRAY['C'],'DA2');
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[1],pg,'draft'),(f.league_id,f.season_id,f.member_ids[1],center,'draft');
  DELETE FROM public.lineup_slot_templates WHERE league_id=f.league_id;
  INSERT INTO public.lineup_slot_templates(league_id,slot_type,slot_count) VALUES(f.league_id,'PG',1),(f.league_id,'UTIL',1);
  DELETE FROM private.work_items WHERE kind='lineup-optimizer';
  PERFORM private.enqueue_lineup_optimizer(morning);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='lineup-optimizer'),'no-game date enqueues nothing');
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status)
    VALUES(game,'002'||game,9198,1,d,now()+interval '4 hours','DA1','DA2','Scheduled');
  UPDATE public.lineup_optimizer_settings SET enabled=false WHERE league_id=f.league_id;
  PERFORM private.enqueue_lineup_optimizer(morning);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='lineup-optimizer'),'disabled teams enqueue nothing');
  UPDATE public.lineup_optimizer_settings SET enabled=true WHERE member_id=f.member_ids[1];
  PERFORM private.enqueue_lineup_optimizer(morning-interval '1 second');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='lineup-optimizer'),'daily waits for Eastern due time');
  PERFORM private.enqueue_scheduled_work(morning);
  SELECT id INTO first_work FROM private.work_items WHERE kind='lineup-optimizer' AND key=d::text;
  PERFORM pg_temp.check_rules(first_work IS NOT NULL AND EXISTS(SELECT 1 FROM private.work_items WHERE id=first_work AND payload=jsonb_build_object('mode','daily','date',d)),'minute scheduler queues current Eastern daily payload');
  UPDATE private.work_items SET status='succeeded',completed_at=now() WHERE id=first_work;
  PERFORM private.enqueue_lineup_optimizer(morning+interval '1 minute');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM private.work_items WHERE kind='lineup-optimizer'),'completed daily work is not queued twice');
  DELETE FROM private.work_items WHERE kind='lineup-optimizer';
  early := (d + time '05:30') AT TIME ZONE 'America/New_York';
  UPDATE public.nba_games SET game_time=early WHERE id=game;
  PERFORM private.enqueue_lineup_optimizer(early-interval '10 minutes 1 second');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='lineup-optimizer'),'early tipoff waits until ten-minute lead');
  PERFORM private.enqueue_lineup_optimizer(early-interval '10 minutes');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='lineup-optimizer' AND key=d::text),'early tipoff runs before the normal morning time');
  DELETE FROM private.work_items WHERE kind='lineup-optimizer';
  UPDATE public.nba_games SET game_time=now()+interval '4 hours',game_status_text='Postponed' WHERE id=game;
  PERFORM private.enqueue_lineup_optimizer(morning);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='lineup-optimizer'),'postponed games enqueue nothing');
  UPDATE public.nba_games SET game_time=NULL,game_status_text=NULL WHERE id=game;
  PERFORM private.enqueue_lineup_optimizer(morning);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='lineup-optimizer'),'TBD games receive a daily run');
  UPDATE public.nba_games SET game_time=now()+interval '4 hours' WHERE id=game;
  assignments := jsonb_build_array(jsonb_build_object('player_id',center,'slot_type','PG','week_number',1,'is_auto_set',true));
  PERFORM pg_temp.reject_rules(format('SELECT public.apply_daily_lineup(%L,%L,%L,%L,%L)',d,f.league_id,f.season_id,f.member_ids[1],assignments),'%eligible%','ineligible daily slot is rejected');
  PERFORM pg_temp.check_rules((SELECT last_daily_optimized_date IS NULL FROM public.lineup_optimizer_settings WHERE member_id=f.member_ids[1]),'failed daily write does not consume its date');
  assignments := jsonb_build_array(jsonb_build_object('player_id',pg,'slot_type','PG','week_number',1,'is_auto_set',true),jsonb_build_object('player_id',center,'slot_type','UTIL','week_number',1,'is_auto_set',true));
  PERFORM pg_temp.check_rules(public.apply_daily_lineup(d,f.league_id,f.season_id,f.member_ids[1],assignments),'daily writes its eligible lineup');
  SELECT jsonb_agg(to_jsonb(w) ORDER BY player_id) INTO before_rows FROM public.weekly_lineups w WHERE member_id=f.member_ids[1];
  PERFORM pg_temp.check_rules(NOT public.apply_daily_lineup(d,f.league_id,f.season_id,f.member_ids[1],'[]'),'daily rerun is a no-op even with changed assignments');
  PERFORM pg_temp.check_rules(before_rows=(SELECT jsonb_agg(to_jsonb(w) ORDER BY player_id) FROM public.weekly_lineups w WHERE member_id=f.member_ids[1]),'daily retry preserves row identities and timestamps');
  PERFORM pg_temp.check_rules(NOT public.apply_daily_lineup(d+1,f.league_id,f.season_id,f.member_ids[1],'[]'),'future-date daily work cannot write');
  UPDATE public.lineup_optimizer_settings SET last_daily_optimized_date=NULL WHERE member_id=f.member_ids[1];
  UPDATE public.players SET nba_team='LOCKED' WHERE id=pg;
  INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status)
    VALUES('002'||gen_random_uuid(),9198,1,d,now()-interval '1 minute','LOCKED','DX','InProgress');
  PERFORM pg_temp.reject_rules(format('SELECT public.apply_daily_lineup(%L,%L,%L,%L,%L)',d,f.league_id,f.season_id,f.member_ids[1],'[]'),'%lock%','daily cannot remove a locked starter');
  PERFORM pg_temp.check_rules(NOT public.apply_daily_lineup(d,f.league_id,f.season_id,f.member_ids[1],assignments),'daily preserves an unchanged locked lineup');
  PERFORM pg_temp.check_rules(before_rows=(SELECT jsonb_agg(to_jsonb(w) ORDER BY player_id) FROM public.weekly_lineups w WHERE member_id=f.member_ids[1]),'locked starter remains unmoved');
  PERFORM pg_temp.check_rules(NOT public.apply_daily_lineup(d,f.league_id,f.season_id,f.member_ids[2],'[]'),'disabled team cannot receive a daily write');
  PERFORM pg_temp.check_rules(NOT has_column_privilege('authenticated','public.lineup_optimizer_settings','last_daily_optimized_date','UPDATE'),'clients cannot forge the daily receipt');
  PERFORM pg_temp.check_rules(NOT has_function_privilege('authenticated','public.apply_daily_lineup(date,uuid,uuid,uuid,jsonb)','EXECUTE'),'daily RPC is service-only');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
SELECT label FROM rules_checks ORDER BY label;
ROLLBACK;
