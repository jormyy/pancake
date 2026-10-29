BEGIN;
\ir rules-support.sql

CREATE FUNCTION pg_temp.require_trade_time(p_query text,p_limit numeric)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE started timestamptz:=clock_timestamp(); elapsed numeric;
BEGIN
  EXECUTE p_query;
  elapsed:=extract(epoch FROM clock_timestamp()-started)*1000;
  IF elapsed>=p_limit THEN RAISE EXCEPTION 'Trade timing guard: % ms exceeds % ms',elapsed,p_limit; END IF;
END;
$$;

DO $$
DECLARE f record; other record; trade uuid; asset uuid:=gen_random_uuid(); second uuid:=gen_random_uuid(); third uuid:=gen_random_uuid();
  game uuid; previous text; current_version text; original text; settings jsonb; publication jsonb; n integer;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9601);
  SELECT * INTO other FROM pg_temp.rules_fixture(2,9602);
  INSERT INTO public.players(id,first_name,last_name,nba_team)
    VALUES(asset,'Fast','One','AAA'),(second,'Fast','Two','BBB'),(third,'Fast','Three','AAA');
  FOR n IN 1..3 LOOP
    INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
      VALUES('002-fast-'||n,9601,1,current_date-n,'AAA','BBB','Final') RETURNING id INTO game;
    INSERT INTO public.player_game_stats(player_id,game_id,season_year,week_number,points,rebounds,minutes_played,double_double)
      VALUES(asset,game,9601,1,10+n,5+n,20,n=3),(second,game,9601,1,20+n,10+n,25,true),
        (third,game,9601,1,CASE WHEN n=2 THEN NULL ELSE n END,0,10,false);
  END LOOP;
  FOR settings IN SELECT value FROM jsonb_array_elements('[{"points":1,"rebounds":1.5,"double_double":2},
    {"points":1.001,"rebounds":-0.334,"double_double":2.005},
    {"points":1,"double_double":2.005},
    {"points":0,"rebounds":0,"double_double":0}]'::jsonb) LOOP
    UPDATE public.leagues SET scoring_settings=settings WHERE id=f.league_id;
    PERFORM pg_temp.check_rules(
      (SELECT jsonb_agg(to_jsonb(value) ORDER BY value.player_id)
        FROM private.trade_value_fantasy_averages(f.league_id,9601) value)=
      (SELECT jsonb_agg(jsonb_build_object('player_id',player_id,'avg_fantasy_points',avg_fantasy_points) ORDER BY player_id)
        FROM public.v_player_avg_fantasy_points WHERE league_id=f.league_id AND season_year=9601),
      'exact averages match per-game rounding for '||settings::text);
  END LOOP;
  INSERT INTO public.trades(league_id,league_season_id,proposer_member_id,recipient_member_id)
    VALUES(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2]) RETURNING id INTO trade;
  INSERT INTO public.trade_participants(trade_id,league_id,member_id,proposed_at,sort_order,is_initiator)
    VALUES(trade,f.league_id,f.member_ids[1],now(),0,true),(trade,f.league_id,f.member_ids[2],now(),1,false);
  INSERT INTO public.trade_items(league_id,trade_id,from_member_id,to_member_id,faab_amount,side)
    VALUES(f.league_id,trade,f.member_ids[1],f.member_ids[2],1,'proposer');
  previous:=private.trade_revaluation_input_version(trade);
  UPDATE public.players SET first_name=first_name WHERE id=asset;
  PERFORM pg_temp.check_rules(previous=private.trade_revaluation_input_version(trade),'no-op source writes preserve the version');
  UPDATE public.players SET first_name='Changed' WHERE id=asset;
  PERFORM pg_temp.check_rules(previous<>private.trade_revaluation_input_version(trade),'player metadata changes the version');
  previous:=private.trade_revaluation_input_version(trade);
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(other.league_id,other.season_id,other.member_ids[1],asset,'draft');
  PERFORM pg_temp.check_rules(previous=private.trade_revaluation_input_version(trade),'another league roster preserves the version');
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[1],asset,'draft');
  PERFORM pg_temp.check_rules(previous<>private.trade_revaluation_input_version(trade),'replacement roster changes the version');
  previous:=private.trade_revaluation_input_version(trade);
  DELETE FROM public.roster_players WHERE league_season_id=f.season_id AND player_id=asset;
  PERFORM pg_temp.check_rules(previous<>private.trade_revaluation_input_version(trade),'replacement deletion changes the version');
  previous:=private.trade_revaluation_input_version(trade);
  UPDATE public.player_game_stats SET points=points+1 WHERE game_id=game AND player_id=asset;
  PERFORM pg_temp.check_rules(previous<>private.trade_revaluation_input_version(trade),'stat corrections change the version');
  previous:=private.trade_revaluation_input_version(trade);
  DELETE FROM public.player_game_stats WHERE game_id=game AND player_id=second;
  PERFORM pg_temp.check_rules(previous<>private.trade_revaluation_input_version(trade),'stat deletions change the version');

  INSERT INTO private.trade_input_revisions(source,scope,writer,revision)
    SELECT 'compaction-fixture','',1000000000+series.value,series.value FROM generate_series(1,64) AS series(value);
  INSERT INTO private.trade_input_revisions(source,scope,writer,revision)
    VALUES('compaction-fixture','',pg_backend_pid(),7);
  previous:=private.trade_revaluation_input_version(trade);
  PERFORM private.compact_trade_input_revisions();
  PERFORM pg_temp.check_rules(previous=private.trade_revaluation_input_version(trade),'compaction preserves the input fingerprint');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.trade_input_revisions WHERE source='compaction-fixture' AND writer=pg_backend_pid()),
    'compaction preserves active writers');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.trade_input_revisions WHERE source='compaction-fixture' AND writer>=1000000000),
    'compaction removes retired writers');

  original:=pg_get_functiondef('private.build_trade_estimate_inputs(uuid,uuid,jsonb,boolean)'::regprocedure);
  EXECUTE $source$CREATE OR REPLACE FUNCTION private.build_trade_estimate_inputs(p_user_id uuid,p_member_id uuid,p_items jsonb,p_require_ownership boolean)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $blocked$
    BEGIN RAISE EXCEPTION 'Full inputs must not run during a check'; END;
    $blocked$ $source$;
  PERFORM pg_temp.reject_rules(format('SELECT public.get_trade_revaluation_inputs(%L,%L,%L)',f.user_ids[1],f.member_ids[1],trade),
    'Full inputs must not run during a check','the materialization control is active');
  PERFORM pg_temp.check_rules(public.view_refresh_work(NULL,NULL,jsonb_build_object('operation','check-trade','tradeId',trade,'modelVersion','fast'))='true',
    'changed checks enqueue without materializing inputs');
  PERFORM pg_temp.check_rules((SELECT NOT payload ? 'inputs' FROM private.work_items WHERE kind='trade-revaluation' AND key=trade::text||':fast:latest'),
    'queued checks carry no materialized inputs');
  current_version:=private.trade_revaluation_input_version(trade);
  publication:=jsonb_build_array(jsonb_build_object('tradeId',trade,'revaluation',jsonb_build_object('inputVersion',current_version,'modelVersion','fast')));
  PERFORM pg_temp.check_rules(private.refresh_trade_values(f.league_id,f.season_id,1,publication),'publication validates only the version');
  PERFORM pg_temp.check_rules(public.view_refresh_work(NULL,NULL,jsonb_build_object('operation','check-trade','tradeId',trade,'modelVersion','fast'))='false',
    'unchanged checks skip materialization and valuation');
  UPDATE public.trade_items SET faab_amount=2 WHERE trade_id=trade;
  PERFORM pg_temp.check_rules(NOT private.refresh_trade_values(f.league_id,f.season_id,2,publication),'stale publication is rejected without materialization');
  EXECUTE original;
  PERFORM pg_temp.check_rules(public.get_trade_revaluation_inputs(f.user_ids[1],f.member_ids[1],trade)->>'inputVersion'=private.trade_revaluation_input_version(trade),
    'the full payload carries the checked version');
  PERFORM pg_temp.reject_rules(format('SELECT public.get_trade_revaluation_inputs(%L,%L,%L)',other.user_ids[1],other.member_ids[1],trade),
    'This trade is not available for revaluation.','full input authorization remains enforced');
  FOR n IN 1..20 LOOP
    PERFORM pg_temp.require_trade_time(format('SELECT public.view_refresh_work(NULL,NULL,%L::jsonb)',
      jsonb_build_object('operation','check-trade','tradeId',trade,'modelVersion','fast')::text),50);
    PERFORM pg_temp.require_trade_time(format('SELECT public.get_trade_revaluation_inputs(%L,%L,%L)',f.user_ids[1],f.member_ids[1],trade),300);
  END LOOP;
  PERFORM pg_temp.check_rules(true,'twenty checks and full reads meet the timing guards');
  PERFORM pg_temp.reject_rules('SELECT pg_temp.require_trade_time(''SELECT pg_sleep(0.06)'',50)',
    'Trade timing guard:%','the timing guard rejects a delayed negative control');
END;
$$;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
