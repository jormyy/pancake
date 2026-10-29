BEGIN;
\ir rules-support.sql
SELECT set_config('trade_window.clock',now()::text,true);
DO $$
DECLARE fn regprocedure;
BEGIN
  FOREACH fn IN ARRAY ARRAY['private.begin_trade_revaluation(uuid,text)'::regprocedure,
    'private.refresh_queue_trade_revaluation(uuid,text,text,jsonb)'::regprocedure] LOOP
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
  PERFORM pg_temp.check_rules(private.begin_trade_revaluation(trade,'a'),'the first live value starts immediately');
  PERFORM pg_temp.check_rules(NOT private.begin_trade_revaluation(trade,'a'),'a second live value waits');
  PERFORM pg_temp.check_rules(NOT private.begin_trade_revaluation(trade,'b'),'changing models cannot bypass the live window');
  PERFORM set_config('trade_window.clock',(started+interval '9 minutes 59 seconds')::text,true);
  PERFORM pg_temp.check_rules(NOT private.begin_trade_revaluation(trade,'a'),'the full ten-minute interval is required');
  PERFORM set_config('trade_window.clock',(started+interval '10 minutes')::text,true);
  PERFORM pg_temp.check_rules(private.begin_trade_revaluation(trade,'a'),'the next interval can start');
  PERFORM private.refresh_queue_trade_revaluation(trade,'first','a');
  SELECT id,due_at INTO work,due FROM private.work_items WHERE kind='trade-revaluation' AND key=trade::text||':a:latest';
  PERFORM pg_temp.check_rules(due=started+interval '20 minutes','queued work waits for the next interval');
  PERFORM set_config('trade_window.clock',(started+interval '11 minutes')::text,true);
  PERFORM private.refresh_queue_trade_revaluation(trade,'second','a');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM private.work_items WHERE kind='trade-revaluation' AND payload->>'tradeId'=trade::text),
    'ticks share one pending work item');
  PERFORM pg_temp.check_rules((SELECT payload->>'inputFingerprint'='second' AND (payload->>'latestInputs')::boolean AND due_at=due FROM private.work_items WHERE id=work),
    'the queued item keeps current inputs without moving its deadline');
  UPDATE private.work_items SET status='running',lease_token=gen_random_uuid(),lease_until=started+interval '22 minutes' WHERE id=work;
  PERFORM pg_temp.check_rules(NOT private.refresh_queue_trade_revaluation(trade,'third','a'),'running work is not overwritten');
  UPDATE private.work_items SET status='succeeded',lease_token=NULL,lease_until=NULL WHERE id=work;
  UPDATE public.nba_games SET status='Final' WHERE id=game;
  PERFORM private.refresh_queue_trade_revaluation(trade,'final','a');
  PERFORM pg_temp.check_rules((SELECT due_at=started+interval '11 minutes' FROM private.work_items WHERE id=work),
    'the last game ending makes final inputs due immediately');
  PERFORM pg_temp.check_rules(private.begin_trade_revaluation(trade,'a'),'final inputs bypass the live window');
END;
$$;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
