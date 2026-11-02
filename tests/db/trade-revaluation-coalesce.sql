BEGIN;
\ir rules-support.sql
SELECT set_config('trade_window.clock','2026-11-02T00:00:00-05:00',true);
DO $$
DECLARE fn regprocedure;
BEGIN
  FOREACH fn IN ARRAY ARRAY['private.begin_trade_revaluation(uuid,text)'::regprocedure,
    'private.refresh_queue_trade_revaluation(uuid,text,text,jsonb)'::regprocedure,
    'private.refresh_trade_values(uuid,uuid,bigint,jsonb)'::regprocedure,
    'private.trade_revaluation_next_change()'::regprocedure] LOOP
    EXECUTE replace(pg_get_functiondef(fn),'now()','(current_setting(''trade_window.clock'')::timestamptz)');
  END LOOP;
END;
$$;
DO $$
DECLARE f record; trade uuid; game uuid:=gen_random_uuid(); started timestamptz:=current_setting('trade_window.clock')::timestamptz;
  due timestamptz; work bigint;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9603);
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    VALUES(game,'002-trade-window',9603,1,current_date,'BOS','NYK','InProgress');
  INSERT INTO public.trades(league_id,league_season_id,proposer_member_id,recipient_member_id)
    VALUES(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2]) RETURNING id INTO trade;
  INSERT INTO public.trade_participants(trade_id,league_id,member_id,proposed_at,sort_order,is_initiator)
    VALUES(trade,f.league_id,f.member_ids[1],now(),0,true),(trade,f.league_id,f.member_ids[2],now(),1,false);
  INSERT INTO public.trade_items(league_id,trade_id,from_member_id,to_member_id,faab_amount,side)
    VALUES(f.league_id,trade,f.member_ids[1],f.member_ids[2],1,'proposer');
  PERFORM pg_temp.check_rules(private.begin_trade_revaluation(trade,'a'),'the first value starts immediately');
  PERFORM pg_temp.check_rules(private.begin_trade_revaluation(trade,'a'),'a failed first value remains retryable');
  PERFORM private.refresh_trade_values(f.league_id,f.season_id,1,jsonb_build_array(jsonb_build_object(
    'tradeId',trade,'revaluation',jsonb_build_object('inputVersion',private.trade_revaluation_input_version(trade),'modelVersion','a'))));
  PERFORM pg_temp.check_rules(NOT private.begin_trade_revaluation(trade,'a'),'a second published value waits until the nightly window');
  PERFORM pg_temp.check_rules(NOT private.begin_trade_revaluation(trade,'b'),'changing models cannot bypass the nightly window');
  PERFORM private.refresh_queue_trade_revaluation(trade,'first','a');
  SELECT id,due_at INTO work,due FROM private.work_items WHERE kind='trade-revaluation' AND key=trade::text||':a:latest';
  PERFORM pg_temp.check_rules(due=started+interval '4 hours','queued work waits for four in the morning');
  PERFORM set_config('trade_window.clock',(started+interval '1 hour')::text,true);
  PERFORM private.refresh_queue_trade_revaluation(trade,'second','a');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM private.work_items WHERE kind='trade-revaluation' AND key=trade::text||':a:latest'),
    'ticks share one pending work item');
  PERFORM pg_temp.check_rules((SELECT payload->>'inputFingerprint'='second' AND (payload->>'latestInputs')::boolean AND due_at=due FROM private.work_items WHERE id=work),
    'the queued item keeps current inputs without moving its deadline');
  UPDATE private.work_items SET status='running',lease_token=gen_random_uuid(),lease_until=started+interval '2 hours' WHERE id=work;
  PERFORM pg_temp.check_rules(NOT private.refresh_queue_trade_revaluation(trade,'third','a'),'running work is not overwritten');
  UPDATE private.work_items SET status='succeeded',lease_token=NULL,lease_until=NULL WHERE id=work;
  UPDATE public.nba_games SET status='Final' WHERE id=game;
  PERFORM private.refresh_queue_trade_revaluation(trade,'final','a');
  PERFORM pg_temp.check_rules((SELECT due_at=due FROM private.work_items WHERE id=work),
    'a game ending does not start an extra trade analysis');
  PERFORM pg_temp.check_rules(NOT private.begin_trade_revaluation(trade,'a'),'final inputs keep the nightly window');
  PERFORM set_config('trade_window.clock',(started+interval '4 hours')::text,true);
  PERFORM pg_temp.check_rules(private.begin_trade_revaluation(trade,'a'),'the nightly window permits the next value');
END;
$$;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
