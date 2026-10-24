\set ON_ERROR_STOP on
\getenv players_db_url SUPABASE_DB_URL
\getenv players_db_port PANCAKE_TEST_DB_PORT
\if :{?players_db_port}
\else
  \set players_db_port 54322
\endif
SELECT :'players_db_port' ~ '^[0-9]{4,5}$'
  AND :'players_db_url' ~ ('^postgres(ql)?://[^/]+@(127\.0\.0\.1|localhost):' || :'players_db_port' || '/[^?]+$') AS players_local \gset
\if :players_local
\else
  DO $$ BEGIN RAISE EXCEPTION 'Refusing non-players local database'; END $$;
\endif
BEGIN;
SET LOCAL statement_timeout = '60s';
CREATE OR REPLACE FUNCTION public.current_season_year_et(p_now timestamptz DEFAULT now()) RETURNS integer LANGUAGE sql STABLE AS $$ SELECT 2091 $$;
INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
VALUES ('00000000-0000-4000-8000-000000230001','authenticated','authenticated','players-season@example.test','x',now(),'{}','{}',now(),now());
INSERT INTO public.leagues (id,name,slug,commissioner_id,status,scoring_settings)
VALUES ('00000000-0000-4000-8000-000000230002','Players season','players-season','00000000-0000-4000-8000-000000230001','active','{"points":1,"turnovers":-5}');
INSERT INTO public.league_members (league_id,user_id,role,team_name)
VALUES ('00000000-0000-4000-8000-000000230002','00000000-0000-4000-8000-000000230001','commissioner','Players');
INSERT INTO public.players (id,first_name,last_name,position,eligible_positions,nba_team)
SELECT ('00000000-0000-4000-8000-'||lpad((230100+n)::text,12,'0'))::uuid, name, 'Season', 'PG', ARRAY['PG'], 'BOS'
FROM (VALUES (1,'A Missing'),(2,'Z High'),(3,'B Negative'),(4,'Y Zero'),(5,'T Tie'),(6,'R Rookie')) f(n,name);
INSERT INTO public.nba_games (id,nba_game_id,season_year,game_date,week_number,home_team,away_team,status)
VALUES ('00000000-0000-4000-8000-000000230201','002players-prior',2090,'2090-01-02',1,'BOS','NYK','Final');
INSERT INTO public.player_game_stats (player_id,game_id,season_year,week_number,points,turnovers,minutes_played,did_not_play)
SELECT ('00000000-0000-4000-8000-'||lpad((230100+n)::text,12,'0'))::uuid,'00000000-0000-4000-8000-000000230201',2090,1,pts,tov,30,false
FROM (VALUES (2,40,0),(3,3,1),(4,0,0),(5,40,0)) f(n,pts,tov);
SELECT public.refresh_player_search_caches();
CREATE FUNCTION pg_temp.assert_players(expected text[], chosen integer DEFAULT NULL, mode text DEFAULT 'fpts', direction text DEFAULT 'desc', expected_season integer DEFAULT 2090) RETURNS void LANGUAGE plpgsql AS $$
DECLARE actual text[]; actual_seasons integer[];
BEGIN
  SELECT array_agg(r.display_name), array_agg(DISTINCT (to_jsonb(r)->>'stats_season_year')::integer)
  INTO actual, actual_seasons
  FROM public.search_players(p_league_id=>'00000000-0000-4000-8000-000000230002',p_include_player_ids=>ARRAY(SELECT id FROM public.players WHERE id::text LIKE '00000000-0000-4000-8000-00000023010%'),p_season_year=>chosen,p_sort_by=>mode,p_sort_dir=>direction) r;
  IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Players order: expected %, got %',expected,actual; END IF;
  IF actual_seasons IS DISTINCT FROM ARRAY[expected_season] THEN RAISE EXCEPTION 'Players season: expected %, got %',expected_season,actual_seasons; END IF;
END $$;
SELECT pg_temp.assert_players(ARRAY['T Tie Season','Z High Season','Y Zero Season','B Negative Season','A Missing Season','R Rookie Season']);
SELECT pg_temp.assert_players(ARRAY['B Negative Season','Y Zero Season','T Tie Season','Z High Season','A Missing Season','R Rookie Season'],NULL,'fpts','asc');
SELECT pg_temp.assert_players(ARRAY['T Tie Season','Z High Season','B Negative Season','A Missing Season','R Rookie Season','Y Zero Season'],2090,'pts');
SELECT pg_temp.assert_players(ARRAY['A Missing Season','B Negative Season','R Rookie Season','T Tie Season','Y Zero Season','Z High Season'],2091,'fpts','desc',2091);
INSERT INTO public.nba_games (id,nba_game_id,season_year,game_date,week_number,home_team,away_team,status)
SELECT ('00000000-0000-4000-8000-'||lpad((230210+n)::text,12,'0'))::uuid, prefix||'players-excluded',2091,'2090-10-01',1,'BOS','NYK','Final'
FROM (VALUES (1,'001'),(2,'003'),(3,'004'),(4,'005'),(5,'006')) f(n,prefix);
SELECT pg_temp.assert_players(ARRAY['T Tie Season','Z High Season','Y Zero Season','B Negative Season','A Missing Season','R Rookie Season']);
INSERT INTO public.nba_games (id,nba_game_id,season_year,game_date,week_number,home_team,away_team,status)
VALUES ('00000000-0000-4000-8000-000000230202','002players-current',2091,'2090-10-21',1,'BOS','NYK','Scheduled');
SELECT pg_temp.assert_players(ARRAY['T Tie Season','Z High Season','Y Zero Season','B Negative Season','A Missing Season','R Rookie Season']);
UPDATE public.nba_games SET status='InProgress' WHERE id='00000000-0000-4000-8000-000000230202';
SELECT pg_temp.assert_players(ARRAY['T Tie Season','Z High Season','Y Zero Season','B Negative Season','A Missing Season','R Rookie Season']);
INSERT INTO public.player_game_stats (player_id,game_id,season_year,week_number,points,minutes_played,did_not_play)
VALUES ('00000000-0000-4000-8000-000000230106','00000000-0000-4000-8000-000000230202',2091,1,90,0,true);
SELECT pg_temp.assert_players(ARRAY['T Tie Season','Z High Season','Y Zero Season','B Negative Season','A Missing Season','R Rookie Season']);
UPDATE public.player_game_stats SET did_not_play=false,minutes_played=1 WHERE player_id='00000000-0000-4000-8000-000000230106';
SELECT public.refresh_player_search_caches();
SELECT pg_temp.assert_players(ARRAY['R Rookie Season','A Missing Season','B Negative Season','T Tie Season','Y Zero Season','Z High Season'],NULL,'fpts','desc',2091);
DELETE FROM public.player_game_stats WHERE player_id='00000000-0000-4000-8000-000000230106';
UPDATE public.nba_games SET status='Final' WHERE id='00000000-0000-4000-8000-000000230202';
SELECT public.refresh_player_search_caches();
SELECT pg_temp.assert_players(ARRAY['A Missing Season','B Negative Season','R Rookie Season','T Tie Season','Y Zero Season','Z High Season'],NULL,'fpts','desc',2091);
SELECT pg_temp.assert_players(ARRAY['T Tie Season','Z High Season','Y Zero Season','B Negative Season','A Missing Season','R Rookie Season'],2090);
INSERT INTO public.player_game_stats (player_id,game_id,season_year,week_number,points,turnovers,minutes_played,did_not_play)
VALUES ('00000000-0000-4000-8000-000000230106','00000000-0000-4000-8000-000000230202',2091,1,90,0,30,false);
DO $$
DECLARE found record;
BEGIN
  SELECT * INTO STRICT found FROM public.search_players(p_league_id=>'00000000-0000-4000-8000-000000230002',p_include_player_ids=>ARRAY['00000000-0000-4000-8000-000000230106']::uuid[]);
  IF found.stats_season_year IS DISTINCT FROM 2091 OR found.avg_fantasy_points IS DISTINCT FROM 90::numeric
    OR found.avg_points IS DISTINCT FROM 90::numeric OR found.games_played IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Final-game cache lag: season %, FP %, points %, games %, expected 2091 / 90 / 90 / 1',found.stats_season_year,found.avg_fantasy_points,found.avg_points,found.games_played;
  END IF;
END $$;
SELECT pg_temp.assert_players(ARRAY['R Rookie Season','A Missing Season','B Negative Season','T Tie Season','Y Zero Season','Z High Season'],NULL,'fpts','desc',2091);
SELECT public.refresh_player_search_caches();
DELETE FROM public.player_game_stats WHERE player_id='00000000-0000-4000-8000-000000230106';
INSERT INTO public.nba_games (id,nba_game_id,season_year,game_date,week_number,home_team,away_team,status)
VALUES ('00000000-0000-4000-8000-000000230203','002players-midseason',2091,'2091-01-02',12,'BOS','NYK','Final');
INSERT INTO public.player_game_stats (player_id,game_id,season_year,week_number,points,turnovers,minutes_played,did_not_play)
VALUES ('00000000-0000-4000-8000-000000230103','00000000-0000-4000-8000-000000230203',2091,12,3,1,30,false);
INSERT INTO public.player_game_stats (player_id,game_id,season_year,week_number,points,minutes_played,did_not_play)
VALUES ('00000000-0000-4000-8000-000000230103','00000000-0000-4000-8000-000000230202',2091,1,7000,0,true),
       ('00000000-0000-4000-8000-000000230103','00000000-0000-4000-8000-000000230215',2091,1,8000,30,false);
DO $$
DECLARE found record;
BEGIN
  SELECT * INTO STRICT found FROM public.search_players(p_league_id=>'00000000-0000-4000-8000-000000230002',p_include_player_ids=>ARRAY['00000000-0000-4000-8000-000000230103']::uuid[]);
  IF found.avg_fantasy_points IS DISTINCT FROM -2::numeric OR found.avg_points IS DISTINCT FROM 3::numeric OR found.games_played IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Partial cache or ineligible stats: FP %, points %, games %, expected -2 / 3 / 1',found.avg_fantasy_points,found.avg_points,found.games_played;
  END IF;
END $$;
SELECT pg_temp.assert_players(ARRAY['B Negative Season','A Missing Season','R Rookie Season','T Tie Season','Y Zero Season','Z High Season'],NULL,'fpts','desc',2091);
SELECT public.refresh_player_search_caches();
UPDATE public.player_game_stats SET points=13 WHERE player_id='00000000-0000-4000-8000-000000230103' AND game_id='00000000-0000-4000-8000-000000230203';
DO $$
DECLARE found record;
BEGIN
  SELECT * INTO STRICT found FROM public.search_players(p_league_id=>'00000000-0000-4000-8000-000000230002',p_include_player_ids=>ARRAY['00000000-0000-4000-8000-000000230103']::uuid[]);
  IF found.avg_fantasy_points IS DISTINCT FROM 8::numeric OR found.avg_points IS DISTINCT FROM 13::numeric OR found.games_played IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Warm-cache correction lag: FP %, points %, games %, expected 8 / 13 / 1',found.avg_fantasy_points,found.avg_points,found.games_played;
  END IF;
END $$;
SELECT pg_temp.assert_players(ARRAY['B Negative Season','A Missing Season','R Rookie Season','T Tie Season','Y Zero Season','Z High Season'],NULL,'fpts','desc',2091);
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000230001","role":"authenticated"}',true);
SELECT pg_temp.assert_players(ARRAY['B Negative Season','A Missing Season','R Rookie Season','T Tie Season','Y Zero Season','Z High Season'],NULL,'fpts','desc',2091);
RESET ROLE;
DELETE FROM public.player_game_stats s USING public.nba_games g
WHERE s.game_id=g.id AND s.season_year=2091 AND NOT s.did_not_play
  AND public.is_regular_season_game_id(g.nba_game_id)
  AND s.player_id::text LIKE '00000000-0000-4000-8000-00000023010%';
INSERT INTO public.nba_games (id,nba_game_id,season_year,game_date,week_number,home_team,away_team,status)
SELECT ('00000000-0000-4000-8000-'||lpad((230300+n)::text,12,'0'))::uuid,
  '002910010'||n,2091,('2090-12-01'::date+n),7,'BOS','NYK',status
FROM (VALUES (1,'Final'),(2,'Final'),(3,'InProgress'),(4,'Scheduled'),(5,'Final')) f(n,status);
INSERT INTO public.player_game_stats (player_id,game_id,season_year,week_number,points,turnovers,minutes_played,did_not_play)
SELECT ('00000000-0000-4000-8000-'||lpad((230100+player)::text,12,'0'))::uuid,
  ('00000000-0000-4000-8000-'||lpad((230300+game)::text,12,'0'))::uuid,2091,7,pts,tov,30,false
FROM (VALUES
  (2,1,12,0),(2,2,14,0),(2,3,17,1),(2,4,19,1),(2,5,21,1),
  (6,1,23,0),(6,3,24,1),(6,4,25,0),
  (5,1,18,1),(5,2,13,0),(5,3,16,1),(5,4,17,0),
  (4,1,2,1),(4,3,3,1)
) f(player,game,pts,tov);
INSERT INTO public.player_game_stats (player_id,game_id,season_year,week_number,points,minutes_played,did_not_play)
VALUES ('00000000-0000-4000-8000-000000230106','00000000-0000-4000-8000-000000230211',2091,7,9000,30,false),
       ('00000000-0000-4000-8000-000000230106','00000000-0000-4000-8000-000000230215',2091,7,10000,30,false),
       ('00000000-0000-4000-8000-000000230104','00000000-0000-4000-8000-000000230305',2091,7,12000,0,true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_players(ARRAY['R Rookie Season','Z High Season','T Tie Season','Y Zero Season','A Missing Season','B Negative Season'],NULL,'fpts','desc',2091);
DO $$
DECLARE actual jsonb;
BEGIN
  SELECT jsonb_agg(jsonb_build_array(r.display_name,r.avg_fantasy_points,round(r.avg_fantasy_points,1),r.games_played,r.stats_season_year))
    INTO actual
    FROM public.search_players(
      p_league_id=>'00000000-0000-4000-8000-000000230002',
      p_include_player_ids=>ARRAY(SELECT id FROM public.players WHERE id::text LIKE '00000000-0000-4000-8000-00000023010%'),
      p_sort_by=>'fpts',p_sort_dir=>'desc',p_season_year=>NULL
    ) r;
  IF actual IS DISTINCT FROM '[
    ["R Rookie Season",22.33,22.3,3,2091],
    ["Z High Season",13.60,13.6,5,2091],
    ["T Tie Season",13.50,13.5,4,2091],
    ["Y Zero Season",-2.50,-2.5,2,2091],
    ["A Missing Season",null,null,null,2091],
    ["B Negative Season",null,null,null,2091]
  ]'::jsonb THEN
    RAISE EXCEPTION 'Multi-game current-season averages/order/season: %',actual;
  END IF;
  RAISE NOTICE 'Multi-game current-season averages/order/season: %',actual;
END $$;
ROLLBACK;
