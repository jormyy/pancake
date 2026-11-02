BEGIN;
SET LOCAL app.supabase_url='http://127.0.0.1:1';
SET LOCAL app.edge_internal_token='live-checkpoints';
\ir rules-support.sql
DO $$
DECLARE game uuid:=gen_random_uuid(); holder uuid; work record;
BEGIN
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_time)
    VALUES(game,'002live-checkpoints',9569,1,(now() AT TIME ZONE 'America/New_York')::date,'BOS','NYK','InProgress',now());
  SELECT * INTO work FROM public.get_live_checkpoint_work() WHERE id=game;
  PERFORM pg_temp.check_rules(work.id=game AND work.checkpoint_at IS NULL,'live checkpoint query returns compact pending game');
  PERFORM pg_temp.check_rules(NOT to_jsonb(work)?'live_cache','checkpoint query omits per-player caches');
  PERFORM pg_temp.reject_rules(format('SELECT public.record_live_checkpoint(%L,ARRAY[%L]::uuid[])',gen_random_uuid(),game),
    'Live poll lease expired or changed','checkpoint requires the live lease');
  holder:=public.try_live_poll_lease(779001,120);
  PERFORM public.record_live_checkpoint(holder,ARRAY[game]);
  PERFORM pg_temp.check_rules((SELECT checkpoint_at IS NOT NULL FROM public.get_live_checkpoint_work() WHERE id=game),'successful save records checkpoint');
  UPDATE public.nba_games SET status='Final',stats_synced_at=now() WHERE id=game;
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.get_live_checkpoint_work() WHERE id=game),'fresh official final leaves the live loop');
  UPDATE public.nba_games SET stats_synced_at=now()-interval '31 minutes' WHERE id=game;
  PERFORM pg_temp.check_rules((SELECT needs_final_check FROM public.get_live_checkpoint_work() WHERE id=game),'existing final correction cadence stays active');
  PERFORM pg_temp.check_rules(NOT has_function_privilege('authenticated','public.record_live_checkpoint(uuid,uuid[])','EXECUTE'),'clients cannot advance checkpoints');
  PERFORM pg_temp.check_rules(NOT has_function_privilege('authenticated','public.get_live_checkpoint_work(timestamptz)','EXECUTE'),'clients cannot read worker state');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
