\set ON_ERROR_STOP on
BEGIN;
\ir rules-support.sql
CREATE TEMP TABLE card_fixture AS SELECT fixture.*,gen_random_uuid() AS player_id,
  gen_random_uuid() AS pending_id,gen_random_uuid() AS accepted_id,gen_random_uuid() AS completed_id,
  gen_random_uuid() AS pick_id,gen_random_uuid() AS quote_id FROM pg_temp.rules_fixture(3,public.current_season_year_et()) fixture;
CREATE TEMP TABLE card_other AS SELECT fixture.*,gen_random_uuid() AS trade_id FROM pg_temp.rules_fixture(2,public.current_season_year_et()) fixture;
GRANT SELECT ON card_fixture,card_other TO authenticated,service_role;
DO $$
DECLARE f record; other record; trade uuid; game uuid; settings jsonb; expected jsonb; actual jsonb;
BEGIN
  SELECT * INTO f FROM card_fixture;
  SELECT * INTO other FROM card_other;
  INSERT INTO public.players(id,first_name,last_name,nba_team,years_exp) VALUES(f.player_id,'Card','Fixture','BOS',0);
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[1],f.player_id,'draft');
  INSERT INTO public.draft_picks(id,league_id,original_owner_id,current_owner_id,season_year,round,predicted_trade_value)
    VALUES(f.pick_id,f.league_id,f.member_ids[1],f.member_ids[1],2039,3,NULL);
  INSERT INTO public.dynasty_pick_values(draft_year,round,tier,trade_value,derived,source,fetched_at)
    VALUES(2038,3,'mid',200,true,'l3d-fixture',now()) ON CONFLICT(draft_year,round,tier) DO UPDATE SET trade_value=EXCLUDED.trade_value;
  PERFORM set_config('session_replication_role','replica',true);
  FOREACH trade IN ARRAY ARRAY[f.pending_id,f.accepted_id,f.completed_id] LOOP
    INSERT INTO public.trades(id,league_id,league_season_id,proposer_member_id,recipient_member_id,status)
      VALUES(trade,f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],
        CASE trade WHEN f.accepted_id THEN 'accepted'::public.trade_status WHEN f.completed_id THEN 'completed'::public.trade_status ELSE 'pending'::public.trade_status END);
    INSERT INTO public.trade_participants(trade_id,league_id,proposed_at,member_id,sort_order,is_initiator,accepted_at)
      VALUES(trade,f.league_id,now(),f.member_ids[1],0,true,now()),(trade,f.league_id,now(),f.member_ids[2],1,false,NULL);
    INSERT INTO public.trade_items(trade_id,league_id,side,player_id,from_member_id,to_member_id)
      VALUES(trade,f.league_id,'proposer',f.player_id,f.member_ids[1],f.member_ids[2]);
    INSERT INTO public.trade_items(trade_id,league_id,side,pick_id,from_member_id,to_member_id)
      VALUES(trade,f.league_id,'proposer',f.pick_id,f.member_ids[1],f.member_ids[2]);
    INSERT INTO public.trade_items(trade_id,league_id,side,faab_amount,from_member_id,to_member_id)
      VALUES(trade,f.league_id,'proposer',5,f.member_ids[1],f.member_ids[2]);
  END LOOP;
  PERFORM set_config('session_replication_role','origin',true);
  INSERT INTO public.trades(id,league_id,league_season_id,proposer_member_id,recipient_member_id)
    VALUES(other.trade_id,other.league_id,other.season_id,other.member_ids[1],other.member_ids[2]);
  INSERT INTO public.trade_estimate_quotes(id,league_id,league_season_id,member_id,terms,inputs,analysis,model_version,input_version)
    VALUES(f.quote_id,f.league_id,f.season_id,f.member_ids[1],'[]','{}','{"teams":[{"id":1}],"assets":[{"kind":"player"}]}','l3d-model','l3d-input');
  INSERT INTO public.trade_estimates(trade_id,quote_id) VALUES(f.accepted_id,f.quote_id);
  INSERT INTO public.trade_estimates(trade_id,unavailable_reason) VALUES(f.pending_id,'fixture unavailable');
  INSERT INTO public.trade_vetos(trade_id,member_id,veto_type) VALUES(f.accepted_id,f.member_ids[1],'member');
  INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    VALUES('002-l3d-scoring',public.current_season_year_et(),1,current_date-1,'BOS','NYK','Final') RETURNING id INTO game;
  INSERT INTO public.player_game_stats(player_id,game_id,season_year,week_number,points,rebounds,assists,minutes_played,double_double,triple_double,did_not_play)
    VALUES(f.player_id,game,public.current_season_year_et(),1,13,12,10,30,true,true,false);
  INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    VALUES('002-l3d-dnp',public.current_season_year_et(),1,current_date-2,'BOS','NYK','Final') RETURNING id INTO game;
  INSERT INTO public.player_game_stats(player_id,game_id,season_year,week_number,points,rebounds,minutes_played,did_not_play)
    VALUES(f.player_id,game,public.current_season_year_et(),1,20,NULL,0,true);
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  FOR settings IN SELECT value FROM jsonb_array_elements('[{"points":1.001,"rebounds":-0.334,"double_double":2.005,"triple_double":3.007},{"points":0,"double_double":0},{"points":1,"rebounds":1.5,"assists":2}]'::jsonb) LOOP
    UPDATE public.leagues SET scoring_settings=settings WHERE id=f.league_id;
    SELECT jsonb_object_agg(id::text,public.compute_fantasy_points(id,f.league_id)) INTO expected
      FROM public.player_game_stats WHERE player_id=f.player_id AND season_year=public.current_season_year_et();
    actual:=public.view_player(f.league_id,f.member_ids[1],jsonb_build_object('playerId',f.player_id))->'fantasyPointsMap';
    PERFORM pg_temp.check_rules(expected::text=actual::text,'selected game scoring retains rounding, nulls, DNP and bonuses for '||settings::text);
  END LOOP;
END;
$$;
SET LOCAL ROLE authenticated;
DO $$
DECLARE f record; other record; member integer; ids uuid[]; expected jsonb; actual jsonb;
BEGIN
  SELECT * INTO f FROM card_fixture;
  SELECT * INTO other FROM card_other;
  ids:=ARRAY[f.pending_id,f.accepted_id,f.completed_id,other.trade_id,f.pending_id,NULL::uuid];
  FOR member IN 1..3 LOOP
    PERFORM set_config('request.jwt.claim.sub',f.user_ids[member]::text,true);
    SELECT jsonb_agg(public.view_trade_details(f.league_id,f.member_ids[member],jsonb_build_object('tradeId',id,'cardOnly',true))->'trade' ORDER BY ordinal)
      INTO expected FROM unnest(ids) WITH ORDINALITY entry(id,ordinal);
    actual:=public.get_trade_cards(f.league_id,f.member_ids[member],ids);
    PERFORM pg_temp.check_rules(expected::text=actual::text,'batch cards match quoted, pending, completed, missing and repeated cards for manager '||member);
    PERFORM pg_temp.check_rules(actual->3='null'::jsonb AND actual->5='null'::jsonb,'foreign and missing trades remain invisible for manager '||member);
    IF member=3 THEN
      PERFORM pg_temp.check_rules(actual->0='null'::jsonb AND actual->2='null'::jsonb,'nonparticipants cannot read pending or completed cards');
      PERFORM pg_temp.check_rules(actual->1->'estimate'->>'quoteId'=f.quote_id::text,'accepted observers can read the linked quote');
    END IF;
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  PERFORM pg_temp.check_rules(public.get_trade_cards(f.league_id,f.member_ids[1],ARRAY[]::uuid[])='[]','empty card page stays empty');
  PERFORM pg_temp.reject_rules(format('SELECT public.get_trade_cards(%L,%L,ARRAY[%L::uuid])',f.league_id,f.member_ids[2],f.pending_id),
    'This screen is not available.','another manager identity is rejected');
  PERFORM pg_temp.reject_rules(format('SELECT public.get_trade_cards(%L,%L,array_fill(%L::uuid,ARRAY[101]))',f.league_id,f.member_ids[1],f.pending_id),
    'Choose at most 100 trades.','card requests remain bounded');
  PERFORM set_config('request.jwt.claim.sub',other.user_ids[1]::text,true);
  PERFORM pg_temp.reject_rules(format('SELECT public.get_trade_cards(%L,%L,ARRAY[%L::uuid])',f.league_id,f.member_ids[1],f.accepted_id),
    'This screen is not available.','a foreign league caller is rejected');
END;
$$;
RESET ROLE;
DO $$
BEGIN
  PERFORM pg_temp.check_rules(NOT has_function_privilege('anon','public.get_trade_cards(uuid,uuid,uuid[])','EXECUTE'),'anonymous callers cannot execute the batch helper');
END;
$$;
CREATE FUNCTION pg_temp.require_screen_time(query text,time_limit numeric) RETURNS void LANGUAGE plpgsql AS $$
DECLARE started timestamptz:=clock_timestamp(); elapsed numeric;
BEGIN
  EXECUTE query;
  elapsed:=extract(epoch FROM clock_timestamp()-started)*1000;
  IF elapsed>=time_limit THEN RAISE EXCEPTION 'Slow screen guard fails: % ms exceeds % ms',elapsed,time_limit; END IF;
END;
$$;
SET LOCAL ROLE authenticated;
DO $$
DECLARE f record; name text; sample integer;
BEGIN
  SELECT * INTO f FROM card_fixture;
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  FOREACH name IN ARRAY ARRAY['view_player','view_trade_block','view_trades'] LOOP
    FOR sample IN 0..5 LOOP
      PERFORM pg_temp.require_screen_time(format('SELECT public.%I(%L,%L,%L::jsonb)',name,f.league_id,f.member_ids[1],jsonb_build_object('playerId',f.player_id)),
        CASE WHEN sample=0 THEN 150 ELSE 60 END);
    END LOOP;
  END LOOP;
  PERFORM pg_temp.reject_rules('SELECT pg_temp.require_screen_time(''SELECT pg_sleep(0.07)'',60)',
    'Slow screen guard fails:%','the screen timing guard rejects a delayed query');
END;
$$;
RESET ROLE;
SET LOCAL ROLE service_role;
SET LOCAL statement_timeout='3s';
DO $$
DECLARE f record; sample integer;
BEGIN
  SELECT * INTO f FROM card_fixture;
  FOR sample IN 0..5 LOOP
    PERFORM pg_temp.require_screen_time(format('SELECT public.get_trade_revaluation_inputs(%L,%L,%L)',f.user_ids[1],f.member_ids[1],f.pending_id),
      CASE WHEN sample=0 THEN 300 ELSE 60 END);
  END LOOP;
END;
$$;
RESET ROLE;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
