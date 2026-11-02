BEGIN;
SET LOCAL app.supabase_url='http://127.0.0.1:1';
SET LOCAL app.edge_internal_token='checkpoint-version';
\ir rules-support.sql
DO $$
DECLARE f record; holder uuid; prior bigint;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9538);
  SET CONSTRAINTS ALL IMMEDIATE;
  holder:=public.try_live_poll_lease(779001,120);
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  PERFORM set_config('request.headers',jsonb_build_object('x-pancake-public-checkpoint','true','x-pancake-live-holder',holder)::text,true);
  PERFORM set_config('pancake.official_broadcast','false',true);
  SELECT version INTO prior FROM public.league_versions WHERE league_id=f.league_id;
  PERFORM private.publish_league_version(f.league_id,ARRAY['game','stat'],ARRAY['nba_games','player_game_stats']);
  PERFORM pg_temp.check_rules((SELECT version=prior FROM public.league_versions WHERE league_id=f.league_id),'silent live progress does not create a version gap');
  PERFORM set_config('pancake.official_broadcast','true',true);
  PERFORM private.publish_league_version(f.league_id,ARRAY['game','stat'],ARRAY['nba_games','player_game_stats']);
  PERFORM pg_temp.check_rules((SELECT version=prior+1 FROM public.league_versions WHERE league_id=f.league_id),'official final or correction still advances its version');
  PERFORM set_config('pancake.official_broadcast','false',true);
  PERFORM private.publish_league_version(f.league_id,ARRAY['roster'],ARRAY['roster_players']);
  PERFORM pg_temp.check_rules((SELECT version=prior+2 FROM public.league_versions WHERE league_id=f.league_id),'roster actions never use checkpoint suppression');
  PERFORM set_config('request.headers',jsonb_build_object('x-pancake-public-checkpoint','true','x-pancake-live-holder',gen_random_uuid())::text,true);
  PERFORM private.publish_league_version(f.league_id,ARRAY['stat'],ARRAY['player_game_stats']);
  PERFORM pg_temp.check_rules((SELECT version=prior+3 FROM public.league_versions WHERE league_id=f.league_id),'an invalid lease cannot suppress versions');
  PERFORM set_config('request.jwt.claims','{"role":"authenticated"}',true);
  PERFORM set_config('request.headers',jsonb_build_object('x-pancake-public-checkpoint','true','x-pancake-live-holder',holder)::text,true);
  PERFORM private.publish_league_version(f.league_id,ARRAY['stat'],ARRAY['player_game_stats']);
  PERFORM pg_temp.check_rules((SELECT version=prior+4 FROM public.league_versions WHERE league_id=f.league_id),'an authenticated caller cannot suppress versions');
  PERFORM set_config('request.headers','{}',true);
  PERFORM private.publish_league_version(f.league_id,ARRAY['stat'],ARRAY['player_game_stats']);
  PERFORM pg_temp.check_rules((SELECT version=prior+5 FROM public.league_versions WHERE league_id=f.league_id),'database mode keeps its existing versions');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
