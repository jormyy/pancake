BEGIN;
\ir rules-support.sql
CREATE TEMP TABLE average_attempts(player_id uuid);
GRANT INSERT ON average_attempts TO postgres;
CREATE FUNCTION pg_temp.record_average_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO average_attempts VALUES(NEW.player_id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER record_average_attempt BEFORE INSERT ON public.player_season_averages
  FOR EACH ROW EXECUTE FUNCTION pg_temp.record_average_attempt();
DO $$
DECLARE f record; one uuid:=gen_random_uuid(); two uuid:=gen_random_uuid(); game uuid:=gen_random_uuid(); next_game uuid:=gen_random_uuid(); version bigint;
  before_other jsonb; after_other jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9595);
  INSERT INTO public.players(id,first_name,last_name) VALUES(one,'Average','One'),(two,'Average','Two');
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    VALUES(game,'002-average-scope',9595,1,current_date,'AAA','BBB','Final');
  INSERT INTO public.player_game_stats(player_id,game_id,season_year,week_number,points,minutes_played)
    VALUES(one,game,9595,1,10,20),(two,game,9595,1,20,20);
  SELECT q.version INTO version FROM private.screen_refresh_queue q WHERE league_season_id=f.season_id;
  PERFORM private.refresh_player_averages(f.league_id,f.season_id,version);
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM public.player_season_averages WHERE league_season_id=f.season_id),'initial refresh fills the season');
  SELECT to_jsonb(row) INTO before_other FROM public.player_season_averages row WHERE league_season_id=f.season_id AND player_id=two;
  TRUNCATE average_attempts;
  UPDATE public.player_game_stats SET points=11 WHERE player_id=one AND game_id=game;
  PERFORM private.refresh_queue_screen_views(f.league_id);
  SELECT q.version INTO version FROM private.screen_refresh_queue q WHERE league_season_id=f.season_id;
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM private.screen_average_dirty WHERE league_season_id=f.season_id),'a stat line marks only its player');
  PERFORM private.refresh_player_averages(f.league_id,f.season_id,version);
  PERFORM pg_temp.check_rules((SELECT count(*)=1 AND min(player_id::text)=one::text FROM average_attempts),'the refresh visits only the changed player');
  PERFORM pg_temp.check_rules((SELECT averages->>'avg_points'='11.0' FROM public.player_season_averages WHERE league_season_id=f.season_id AND player_id=one),'changed player receives current averages');
  SELECT to_jsonb(row) INTO after_other FROM public.player_season_averages row WHERE league_season_id=f.season_id AND player_id=two;
  PERFORM pg_temp.check_rules(before_other=after_other,'unaffected player keeps its value and publication version');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.screen_average_dirty WHERE league_season_id=f.season_id),'refresh drains only completed player work');
  TRUNCATE average_attempts;
  PERFORM private.refresh_queue_screen_views(f.league_id);
  PERFORM private.refresh_player_averages(f.league_id,f.season_id,version);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM average_attempts),'a change without stats visits no players');
  PERFORM pg_temp.check_rules((SELECT to_jsonb(row)=after_other FROM public.player_season_averages row WHERE league_season_id=f.season_id AND player_id=two),
    'a league change without stats does not rewrite averages');
  DELETE FROM public.player_game_stats WHERE player_id=one AND game_id=game;
  PERFORM private.refresh_player_averages(f.league_id,f.season_id,version);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.player_season_averages WHERE league_season_id=f.season_id AND player_id=one),'deleting the last stat removes its cached average');
  UPDATE public.leagues SET scoring_settings='{"points":2}' WHERE id=f.league_id;
  SELECT q.version INTO version FROM private.screen_refresh_queue q WHERE league_season_id=f.season_id;
  PERFORM private.refresh_player_averages(f.league_id,f.season_id,version);
  PERFORM pg_temp.check_rules((SELECT avg_fantasy_points=40 FROM public.player_season_averages WHERE league_season_id=f.season_id AND player_id=two),'scoring changes recompute all affected season players');
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    VALUES(next_game,'002-average-next',9597,1,current_date,'AAA','BBB','Final');
  INSERT INTO public.player_game_stats(player_id,game_id,season_year,week_number,points,minutes_played)
    VALUES(one,next_game,9597,1,7,20);
  UPDATE public.league_seasons SET season_year=9597 WHERE id=f.season_id;
  SELECT q.version INTO version FROM private.screen_refresh_queue q WHERE league_season_id=f.season_id;
  PERFORM private.refresh_player_averages(f.league_id,f.season_id,version);
  PERFORM pg_temp.check_rules((SELECT count(*)=1 AND bool_and(season_year=9597 AND avg_fantasy_points=14)
    FROM public.player_season_averages WHERE league_season_id=f.season_id),'season rollover replaces old-year averages');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
