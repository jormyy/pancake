\set ON_ERROR_STOP on
BEGIN;
\ir rules-support.sql
DO $$
DECLARE item private.work_items%ROWTYPE; name text;
BEGIN
  INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status)
    VALUES('002-nightly-worker-hours',9544,1,current_date,now()-interval '1 hour','CHI','NYK','InProgress');
  FOREACH name IN ARRAY ARRAY['sync-players','sync-trade-values','sync-rankings','pick-predictions','trade-revaluation-scan','trade-revaluation-check'] LOOP
    INSERT INTO private.work_items(kind,key,status,lease_token,lease_until,payload)
      VALUES(name,'nightly-hours-'||gen_random_uuid(),'running',gen_random_uuid(),now()+interval '5 minutes','{}') RETURNING * INTO item;
    PERFORM private.work_execute(item.id,item.lease_token);
    PERFORM pg_temp.check_rules((SELECT status='pending' AND due_at>now() AND lease_token IS NULL FROM private.work_items WHERE id=item.id),name||' defers while a game is live');
    PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.edge_invocations WHERE work_item_id=item.id),name||' starts no worker during games');
  END LOOP;
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
