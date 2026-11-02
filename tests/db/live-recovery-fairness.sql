BEGIN;
\ir rules-support.sql
DO $$
DECLARE first_game uuid:='95930000-0000-0000-0000-000000000001';
  second_game uuid:='95930000-0000-0000-0000-000000000002'; holder uuid; ordered uuid[];
BEGIN
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_time)
    VALUES(first_game,'002-recovery-fairness-1',9593,1,(now() AT TIME ZONE 'America/New_York')::date,'BOS','NYK','InProgress',now()),
      (second_game,'002-recovery-fairness-2',9593,1,(now() AT TIME ZONE 'America/New_York')::date,'LAL','MIA','InProgress',now());
  PERFORM pg_temp.reject_rules(format('SELECT public.record_live_recovery_failure(%L,%L)',gen_random_uuid(),first_game),
    'Live poll lease expired or changed','failure receipts require the live lease');
  holder:=public.try_live_poll_lease(779001,120);
  PERFORM public.record_live_recovery_failure(holder,first_game);
  PERFORM pg_temp.check_rules((SELECT checkpoint_at IS NULL AND recovery_failed_at IS NOT NULL FROM private.live_poll_game_state WHERE game_id=first_game),'a failure never advances the successful checkpoint');
  SELECT array_agg(work.id ORDER BY work.ordinality) INTO ordered
    FROM public.get_live_checkpoint_work() WITH ORDINALITY work WHERE work.id IN(first_game,second_game);
  PERFORM pg_temp.check_rules(ordered=ARRAY[second_game,first_game],'a new worker tries untouched games before failed games');
  PERFORM public.record_live_recovery_failure(holder,second_game);
  SELECT array_agg(work.id ORDER BY work.ordinality) INTO ordered
    FROM public.get_live_checkpoint_work() WITH ORDINALITY work WHERE work.id IN(first_game,second_game);
  PERFORM pg_temp.check_rules(ordered=ARRAY[first_game,second_game],'failed games retry from their oldest attempt');
  PERFORM public.record_live_checkpoint(holder,ARRAY[first_game]);
  PERFORM pg_temp.check_rules((SELECT checkpoint_at IS NOT NULL AND recovery_failed_at IS NULL FROM private.live_poll_game_state WHERE game_id=first_game),'a successful checkpoint clears its failure receipt');
  PERFORM pg_temp.check_rules(NOT has_function_privilege('authenticated','public.record_live_recovery_failure(uuid,uuid)','EXECUTE')
    AND NOT has_function_privilege('anon','public.record_live_recovery_failure(uuid,uuid)','EXECUTE'),'clients cannot write recovery receipts');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
