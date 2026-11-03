\set ON_ERROR_STOP on
\getenv window_db_url SUPABASE_DB_URL
SELECT :'window_db_url' ~ '^postgres(ql)?://[^/]+@(127\.0\.0\.1|localhost):[0-9]+/[^?]+$' AS window_local \gset
\if :window_local
\else
  DO $$ BEGIN RAISE EXCEPTION 'Window tests require an isolated local database'; END $$;
\endif
BEGIN;
\ir rules-support.sql
CREATE TEMP TABLE window_fixture AS SELECT * FROM pg_temp.rules_fixture(2, public.current_season_year_et());
CREATE TEMP TABLE window_players (label text, id uuid DEFAULT gen_random_uuid());
INSERT INTO window_players(label) VALUES ('A Boundary'), ('B Steady'), ('C Missing'), ('D Zero'), ('E Unknown');
GRANT SELECT ON window_fixture, window_players TO authenticated;
UPDATE public.leagues SET scoring_settings='{"points":1.005,"turnovers":-2.125,"double_double":1.111}' WHERE id=(SELECT league_id FROM window_fixture);
INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,nba_team)
SELECT id,label,'Window','PG',ARRAY['PG'],'BOS' FROM window_players;
INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
SELECT league_id,season_id,member_ids[1],id,'draft' FROM window_fixture CROSS JOIN window_players;
CREATE TEMP TABLE window_games AS
SELECT gen_random_uuid() AS id, delta, pts, dnp, prefix FROM
(VALUES (-15,999,false,'002'),(-14,10,false,'002'),(-7,20,false,'002'),(-6,30,false,'002'),
(0,50,false,'002'),(1,999,false,'002'),(-1,999,true,'002'),(-2,999,false,'001')) f(delta,pts,dnp,prefix);
INSERT INTO public.nba_games(id,nba_game_id,season_year,game_date,week_number,home_team,away_team,status)
SELECT id,prefix||replace(id::text,'-',''),public.current_season_year_et(),
(now() AT TIME ZONE 'America/New_York')::date+delta,1,'BOS','NYK',CASE WHEN delta=0 THEN 'InProgress' ELSE 'Final' END FROM window_games;
INSERT INTO public.nba_games(nba_game_id,season_year,game_date,week_number,home_team,away_team,status)
VALUES('002'||replace(gen_random_uuid()::text,'-',''),public.current_season_year_et(),
(now() AT TIME ZONE 'America/New_York')::date,1,'BOS','NYK','Postponed');
INSERT INTO public.player_game_stats(player_id,game_id,season_year,week_number,points,turnovers,minutes_played,did_not_play,double_double)
SELECT p.id,g.id,public.current_season_year_et(),1,g.pts,1,30,g.dnp,g.delta=0
FROM window_players p CROSS JOIN window_games g WHERE p.label='A Boundary';
INSERT INTO public.player_game_stats(player_id,game_id,season_year,week_number,points,turnovers,minutes_played,did_not_play)
SELECT p.id,g.id,public.current_season_year_et(),1,
CASE p.label WHEN 'B Steady' THEN 40 WHEN 'D Zero' THEN 0 END,
CASE WHEN p.label='B Steady' THEN 1 ELSE 0 END,10,false
FROM window_players p CROSS JOIN window_games g WHERE g.delta=0 AND p.label IN ('B Steady','D Zero','E Unknown');
SET LOCAL ROLE authenticated;
DO $$
DECLARE f record; a uuid; b uuid; c uuid; d uuid; e uuid; selected_window jsonb; seven jsonb; fifteen jsonb; row jsonb; ids jsonb; points numeric; count_games integer;
BEGIN
  SELECT * INTO f FROM window_fixture;
  SELECT id INTO a FROM window_players WHERE label='A Boundary';
  SELECT id INTO b FROM window_players WHERE label='B Steady';
  SELECT id INTO c FROM window_players WHERE label='C Missing';
  SELECT id INTO d FROM window_players WHERE label='D Zero';
  SELECT id INTO e FROM window_players WHERE label='E Unknown';
  SELECT jsonb_agg(id) INTO ids FROM window_players;
  PERFORM set_config('request.jwt.claim.sub', f.user_ids[1]::text, true);
  selected_window:=public.stats_window(7);
  PERFORM pg_temp.check_rules((selected_window->>'endDate')::date=(now() AT TIME ZONE 'America/New_York')::date, 'current Eastern upper boundary');
  PERFORM pg_temp.check_rules((selected_window->>'endDate')::date-(selected_window->>'startDate')::date=6, 'seven inclusive calendar dates');
  PERFORM pg_temp.check_rules((public.stats_window(15)->>'endDate')::date-(public.stats_window(15)->>'startDate')::date=14, 'fifteen inclusive calendar dates');
  PERFORM pg_temp.check_rules(public.stats_window(NULL) IS NULL, 'season has no window');
  SELECT avg_points,games_played INTO points,count_games FROM public.player_window_averages(f.league_id,7,ARRAY[a]);
  PERFORM pg_temp.check_rules(points=40 AND count_games=2, 'seven includes lower and current partial dates; excludes older, future, DNP and preseason');
  SELECT avg_points,games_played INTO points,count_games FROM public.player_window_averages(f.league_id,15,ARRAY[a]);
  PERFORM pg_temp.check_rules(points=27.5 AND count_games=4, 'fifteen includes day fourteen; excludes day fifteen and future');
  PERFORM pg_temp.check_rules((SELECT avg_fantasy_points=38.64 FROM public.player_window_averages(f.league_id,7,ARRAY[a])), 'per-game fantasy rounding and double-double scoring');
  PERFORM pg_temp.check_rules((SELECT avg_fantasy_points=25.80 FROM public.player_window_averages(f.league_id,15,ARRAY[a])), 'fifteen uses the same scoring');
  seven:=public.view_players(f.league_id,f.member_ids[1],jsonb_build_object('statsDays',7,'includePlayerIds',ids,'sortBy','fpts','limit',1));
  fifteen:=public.view_players(f.league_id,f.member_ids[1],jsonb_build_object('statsDays',15,'includePlayerIds',ids,'sortBy','fpts','limit',1));
  PERFORM pg_temp.check_rules(seven->'players'->0->>'id'=a::text AND fifteen->'players'->0->>'id'=b::text, 'selected window sorts the entire pool before pagination');
  PERFORM pg_temp.check_rules(seven->'visibleTotals'='[]'::jsonb, 'season overlay cannot replace the selected window');
  PERFORM pg_temp.check_rules(seven->'statsWindow'=public.stats_window(7), 'players returns the shared date convention');
  row:=public.view_players(f.league_id,f.member_ids[1],jsonb_build_object('statsDays',15,'includePlayerIds',ids,'sortBy','fpts','limit',1,'offset',1))->'players'->0;
  PERFORM pg_temp.check_rules(row->>'id'=a::text, 'next page uses selected-window order');
  row:=public.view_players(f.league_id,f.member_ids[1],jsonb_build_object('statsDays',15,'includePlayerIds',jsonb_build_array(a,b),'sortBy','pts','sortDir','asc'))->'players'->0;
  PERFORM pg_temp.check_rules(row->>'id'=a::text, 'ascending points uses selected window');
  seven:=public.view_players(f.league_id,f.member_ids[1],jsonb_build_object('statsDays',7,'includePlayerIds',ids));
  row:=(SELECT value FROM jsonb_array_elements(seven->'players') WHERE value->>'id'=c::text);
  PERFORM pg_temp.check_rules(row->'games_played'='0'::jsonb AND row->'avg_points'='null'::jsonb, 'no played rows, including a postponed game, means zero GP and no average');
  row:=(SELECT value FROM jsonb_array_elements(seven->'players') WHERE value->>'id'=d::text);
  PERFORM pg_temp.check_rules(row->'games_played'='1'::jsonb AND (row->>'avg_points')::numeric=0, 'zero output remains an actual zero');
  row:=(SELECT value FROM jsonb_array_elements(seven->'players') WHERE value->>'id'=e::text);
  PERFORM pg_temp.check_rules(row->'games_played'='1'::jsonb AND row->'avg_points'='null'::jsonb, 'unavailable stat remains null with a recorded game');
  PERFORM pg_temp.check_rules(NOT (public.view_players(f.league_id,f.member_ids[1],jsonb_build_object('includePlayerIds',ids)) ? 'statsWindow'), 'players default stays season');
  PERFORM pg_temp.reject_rules('SELECT public.stats_window(8)','Choose past 7 or 15 days.','invalid window rejected');
  PERFORM set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
  PERFORM pg_temp.reject_rules(format('SELECT public.view_players(%L,%L,%L)',f.league_id,f.member_ids[1],'{"statsDays":7}'),'This screen is not available.','window retains membership checks');
END;
$$;
RESET ROLE;
SELECT count(*) AS passed_checks FROM rules_checks;
SELECT label AS passed FROM rules_checks ORDER BY label;
ROLLBACK;
