\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='30s';
SET LOCAL app.supabase_url='http://127.0.0.1:1';
SET LOCAL app.edge_internal_token='average-refresh-fixture';
\ir rules-support.sql
DO $$
DECLARE f record; player uuid:=gen_random_uuid(); stale_player uuid:=gen_random_uuid(); game uuid:=gen_random_uuid();
  version bigint; rows_before jsonb; rows_after jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9877);
  INSERT INTO public.players(id,first_name,last_name) VALUES(player,'Average',player::text),(stale_player,'Average',stale_player::text);
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    VALUES(game,'002-'||game,9877,1,current_date,'BOS','LAL','Final');
  INSERT INTO public.player_game_stats(player_id,game_id,season_year,week_number,points,minutes_played)
    VALUES(player,game,9877,1,17,20);
  SELECT q.version INTO version FROM private.screen_refresh_queue q WHERE league_season_id=f.season_id;
  PERFORM private.refresh_player_averages(f.league_id,f.season_id,version);
  PERFORM pg_temp.check_rules((SELECT (averages->>'avg_points')::numeric=17 FROM public.player_season_averages
    WHERE league_season_id=f.season_id AND player_id=player),'the refresh stores the source average');
  INSERT INTO public.player_season_averages(league_id,league_season_id,season_year,player_id,averages,avg_fantasy_points,version)
    VALUES(f.league_id,f.season_id,9877,stale_player,'{}',0,version);
  PERFORM private.refresh_player_averages(f.league_id,f.season_id,version);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT FROM public.player_season_averages
    WHERE league_season_id=f.season_id AND player_id=stale_player),'the same source removes stale cached players');
  SELECT jsonb_agg(jsonb_build_object('row',to_jsonb(c),'ctid',c.ctid::text) ORDER BY c.player_id) INTO rows_before
    FROM public.player_season_averages c WHERE league_season_id=f.season_id;
  UPDATE private.screen_refresh_queue q SET version=q.version+1 WHERE league_season_id=f.season_id RETURNING q.version INTO version;
  PERFORM private.refresh_player_averages(f.league_id,f.season_id,version);
  SELECT jsonb_agg(jsonb_build_object('row',to_jsonb(c),'ctid',c.ctid::text) ORDER BY c.player_id) INTO rows_after
    FROM public.player_season_averages c WHERE league_season_id=f.season_id;
  PERFORM pg_temp.check_rules(rows_before=rows_after,'a newer unchanged refresh preserves rows and timestamps');
  UPDATE public.player_game_stats SET points=31 WHERE game_id=game AND player_id=player;
  UPDATE private.screen_refresh_queue q SET version=q.version+1 WHERE league_season_id=f.season_id RETURNING q.version INTO version;
  PERFORM private.refresh_player_averages(f.league_id,f.season_id,version);
  PERFORM pg_temp.check_rules((SELECT (averages->>'avg_points')::numeric=31 FROM public.player_season_averages
    WHERE league_season_id=f.season_id AND player_id=player),'a correction replaces the average');
  PERFORM pg_temp.check_rules(NOT private.refresh_player_averages(f.league_id,f.season_id,version-1),'an older refresh cannot replace corrected rows');
  INSERT INTO public.player_game_stats(player_id,game_id,season_year,week_number,points,minutes_played)
    VALUES(stale_player,game,9877,1,22,20);
  UPDATE private.screen_refresh_queue q SET version=q.version+1 WHERE league_season_id=f.season_id RETURNING q.version INTO version;
  PERFORM private.refresh_player_averages(f.league_id,f.season_id,version);
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM public.player_season_averages WHERE league_season_id=f.season_id),'a new source player enters the cache');
  DELETE FROM public.player_game_stats WHERE game_id=game;
  UPDATE private.screen_refresh_queue q SET version=q.version+1 WHERE league_season_id=f.season_id RETURNING q.version INTO version;
  PERFORM private.refresh_player_averages(f.league_id,f.season_id,version);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT FROM public.player_season_averages WHERE league_season_id=f.season_id),'an empty source clears the cache');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
