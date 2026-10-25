\set ON_ERROR_STOP on
\getenv players_db_url SUPABASE_DB_URL
\getenv players_db_port PANCAKE_TEST_DB_PORT
\if :{?players_db_port}
\else
  \set players_db_port 54322
\endif
\if :{?players_latency_games}
\else
  \set players_latency_games 1
\endif
SELECT :'players_db_port' ~ '^[0-9]{4,5}$'
  AND :'players_db_url' ~ ('^postgres(ql)?://[^/]+@(127\.0\.0\.1|localhost):' || :'players_db_port' || '/[^?]+$') AS players_local \gset
\if :players_local
\else
  DO $$ BEGIN RAISE EXCEPTION 'Refusing non-players local database'; END $$;
\endif
BEGIN;
SET LOCAL statement_timeout = '120s';
CREATE OR REPLACE FUNCTION public.current_season_year_et(p_now timestamptz DEFAULT now()) RETURNS integer LANGUAGE sql STABLE AS $$ SELECT 2092 $$;
INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
VALUES ('00000000-0000-4000-8000-000000231001','authenticated','authenticated','players-latency@example.test','x',now(),'{}','{}',now(),now());
INSERT INTO public.leagues (id,name,slug,commissioner_id,status,scoring_settings)
VALUES ('00000000-0000-4000-8000-000000231002','Players latency','players-latency','00000000-0000-4000-8000-000000231001','active','{"points":1,"rebounds":1.2,"assists":1.5,"steals":3,"blocks":3,"turnovers":-1}');
INSERT INTO public.league_members (league_id,user_id,role,team_name)
VALUES ('00000000-0000-4000-8000-000000231002','00000000-0000-4000-8000-000000231001','commissioner','Players latency');
INSERT INTO public.players (id,first_name,last_name,position,eligible_positions,nba_team)
SELECT ('00000000-0000-4000-8000-'||lpad((231100+n)::text,12,'0'))::uuid,'Latency',lpad(n::text,3,'0'),'PG',ARRAY['PG'],'BOS'
FROM generate_series(1,600) n;
INSERT INTO public.nba_games (id,nba_game_id,season_year,game_date,week_number,home_team,away_team,status)
VALUES ('00000000-0000-4000-8000-000000232001','002players-latency-prior',2091,'2091-01-02',1,'BOS','NYK','Final');
INSERT INTO public.player_game_stats (player_id,game_id,season_year,week_number,points,rebounds,assists,steals,blocks,turnovers,minutes_played,did_not_play)
SELECT ('00000000-0000-4000-8000-'||lpad((231100+n)::text,12,'0'))::uuid,'00000000-0000-4000-8000-000000232001',2091,1,n%41,n%20,n%7,n%4,n%3,n%5,30,false
FROM generate_series(1,300) n;
SELECT public.refresh_player_search_caches();
INSERT INTO public.nba_games (id,nba_game_id,season_year,game_date,week_number,home_team,away_team,status)
SELECT ('00000000-0000-4000-8000-'||lpad((233000+n)::text,12,'0'))::uuid,'002players-latency-'||n,2092,'2091-10-21'::date+(n-1)/10,1,'BOS','NYK','Final'
FROM generate_series(1,10*:players_latency_games) n;
INSERT INTO public.player_game_stats (player_id,game_id,season_year,week_number,points,rebounds,assists,steals,blocks,turnovers,minutes_played,did_not_play)
SELECT ('00000000-0000-4000-8000-'||lpad((231100+n)::text,12,'0'))::uuid,
       ('00000000-0000-4000-8000-'||lpad((233000+(g-1)*10+(n+29)/30)::text,12,'0'))::uuid,
       2092,1,(n+g)%41,n%20,n%7,n%4,n%3,n%5,30,false
FROM generate_series(1,300) n CROSS JOIN generate_series(1,:players_latency_games) g;
ANALYZE public.players;
ANALYZE public.nba_games;
ANALYZE public.player_game_stats;
CREATE TEMP TABLE players_latency_samples (phase text,elapsed_ms numeric,fp_rows integer,games_rows integer);
GRANT ALL ON players_latency_samples TO authenticated;
CREATE FUNCTION pg_temp.measure_players(phase text,chosen integer DEFAULT NULL,health text DEFAULT 'all') RETURNS void LANGUAGE plpgsql AS $$
DECLARE started timestamptz; fp_count integer; games_count integer;
BEGIN
  FOR n IN 1..21 LOOP
    started:=clock_timestamp();
    SELECT count(avg_fantasy_points),count(games_played) INTO fp_count,games_count
    FROM public.search_players(p_league_id=>'00000000-0000-4000-8000-000000231002',p_include_player_ids=>ARRAY(SELECT id FROM public.players WHERE first_name='Latency'),p_season_year=>chosen,p_health=>health);
    INSERT INTO players_latency_samples VALUES(phase,extract(epoch FROM clock_timestamp()-started)*1000,fp_count,games_count);
  END LOOP;
END $$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000231001","role":"authenticated"}',true);
SELECT pg_temp.measure_players('current-no-cache');
SELECT pg_temp.measure_players('current-no-cache-healthy',NULL,'healthy');
SELECT pg_temp.measure_players('historical',2091);
RESET ROLE;
SELECT public.refresh_player_search_caches();
SET LOCAL ROLE authenticated;
SELECT pg_temp.measure_players('current-cache-present');
RESET ROLE;
SELECT json_build_object('players',600,'current_stat_rows',300*:players_latency_games,'phase',phase,'samples',count(*),'min_ms',round(min(elapsed_ms),3),'p50_ms',round(percentile_cont(0.5) WITHIN GROUP (ORDER BY elapsed_ms)::numeric,3),'p95_ms',round(percentile_cont(0.95) WITHIN GROUP (ORDER BY elapsed_ms)::numeric,3),'max_ms',round(max(elapsed_ms),3),'fp_rows',min(fp_rows),'games_rows',min(games_rows))
FROM players_latency_samples GROUP BY phase ORDER BY phase;
ROLLBACK;
