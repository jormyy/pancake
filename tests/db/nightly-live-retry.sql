BEGIN;
\ir rules-support.sql
DO $$
DECLARE definition text;
BEGIN
  definition:=pg_get_functiondef('private.trade_revaluation_next_change()'::regprocedure);
  definition:=replace(definition,'private.trade_revaluation_next_change()','pg_temp.trade_revaluation_next_change()');
  EXECUTE replace(definition,'now()','''2026-11-02 09:00 UTC''::timestamptz');
  definition:=pg_get_functiondef('private.work_execute(bigint,uuid)'::regprocedure);
  definition:=replace(definition,'private.work_execute(','pg_temp.work_execute_at(');
  definition:=replace(definition,'private.trade_revaluation_next_change()','pg_temp.trade_revaluation_next_change()');
  EXECUTE replace(definition,'now()','''2026-11-02 09:00 UTC''::timestamptz');
  definition:=pg_get_functiondef('private.enqueue_trade_revaluation_scan(uuid,bigint,text)'::regprocedure);
  definition:=replace(definition,'private.enqueue_trade_revaluation_scan(','pg_temp.enqueue_trade_revaluation_scan(');
  definition:=replace(definition,'private.trade_revaluation_next_change()','pg_temp.trade_revaluation_next_change()');
  EXECUTE replace(definition,'now()','''2026-11-02 09:00 UTC''::timestamptz');
END;
$$;
DO $$
DECLARE item private.work_items%ROWTYPE; fixture record;
BEGIN
  INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status)
    VALUES('002-nightly-retry',9567,1,'2026-11-01','2026-11-02 07:00 UTC','BOS','NYK','InProgress');
  INSERT INTO private.work_items(kind,key,status,lease_token,lease_until,payload)
    VALUES('sync-rankings','nightly-retry','running',gen_random_uuid(),'2026-11-02 09:05 UTC','{}') RETURNING * INTO item;
  PERFORM pg_temp.work_execute_at(item.id,item.lease_token);
  PERFORM pg_temp.check_rules((SELECT status='pending' AND due_at>'2026-11-02 09:00 UTC' AND due_at<='2026-11-02 09:01 UTC'
    FROM private.work_items WHERE id=item.id),'a live game retries within the remaining nightly window');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.edge_invocations WHERE work_item_id=item.id),'the live gate still blocks the worker');
  SELECT * INTO fixture FROM pg_temp.rules_fixture(2,9567,'active');
  INSERT INTO public.trades(league_id,league_season_id,proposer_member_id,recipient_member_id,status)
    VALUES(fixture.league_id,fixture.season_id,fixture.member_ids[1],fixture.member_ids[2],'pending');
  PERFORM pg_temp.enqueue_trade_revaluation_scan(fixture.season_id,1,NULL);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='trade-revaluation-scan'
    AND payload->>'seasonId'=fixture.season_id::text AND due_at>'2026-11-02 09:00 UTC' AND due_at<='2026-11-02 09:01 UTC'),
    'new scans also retry inside the current nightly window');
  PERFORM pg_temp.check_rules(private.nightly_work_retry_at('2026-11-02 08:59 UTC')='2026-11-02 09:00 UTC','pre-window work waits until four');
  PERFORM pg_temp.check_rules(private.nightly_work_retry_at('2026-11-02 10:59:30 UTC')='2026-11-02 11:00 UTC','last-minute retries stop at six');
  PERFORM pg_temp.check_rules(private.nightly_work_retry_at('2026-11-02 11:00 UTC')='2026-11-03 09:00 UTC','closed windows defer until tomorrow');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
