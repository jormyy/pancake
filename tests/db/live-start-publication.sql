BEGIN;
SET LOCAL app.supabase_url='http://127.0.0.1:1';
SET LOCAL app.edge_internal_token='live-start-publication';
\ir rules-support.sql
DO $$
DECLARE f record; game uuid:=gen_random_uuid(); holder uuid; before_version bigint; before_messages bigint;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,2027);
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_time)
    VALUES(game,'002live-start-publication',2027,1,(now() AT TIME ZONE 'America/New_York')::date,'BOS','NYK','Scheduled',now()+interval '1 hour');
  SET CONSTRAINTS ALL IMMEDIATE;
  SELECT version INTO before_version FROM public.league_versions WHERE league_id=f.league_id;
  SELECT count(*) INTO before_messages FROM realtime.messages WHERE topic='l1:league:'||f.league_id::text;
  holder:=public.try_live_poll_lease(779001,120);
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  PERFORM set_config('request.headers',jsonb_build_object('x-pancake-live-holder',holder)::text,true);
  PERFORM public.save_live_scoreboard_atomic(game,'002live-start-publication','InProgress',0,0,'Live game discovered',0);
  PERFORM pg_temp.check_rules((SELECT status='InProgress' FROM public.nba_games WHERE id=game),'receipt starts the game');
  PERFORM pg_temp.check_rules((SELECT version>before_version FROM public.league_versions WHERE league_id=f.league_id),'receipt publishes the league version');
  PERFORM pg_temp.check_rules((SELECT count(*)>before_messages FROM realtime.messages WHERE topic='l1:league:'||f.league_id::text),'receipt publishes the game change');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM realtime.messages message,
    jsonb_array_elements(COALESCE(message.payload->'hints','[]')) hint
    WHERE message.topic='l1:league:'||f.league_id::text AND hint->'row'->>'topic'='version'
      AND (hint#>>'{row,revision}')::bigint>before_version
      AND hint#>'{row,details}' @> '[{"scope":{"topics":["game"],"tables":["nba_games"]}}]'::jsonb),
    'receipt notification identifies the game change');
  PERFORM public.release_live_poll_lease(779001,holder);
END $$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
