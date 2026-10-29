\ir rules-support.sql
CREATE TEMP TABLE benchmark_fixture AS SELECT * FROM pg_temp.rules_fixture(10,9584);
UPDATE public.leagues SET roster_size=20,ir_slots=2,taxi_slots=3,allow_inactive_trades=true WHERE id=(SELECT league_id FROM benchmark_fixture);
CREATE TEMP TABLE benchmark_players AS SELECT gen_random_uuid() AS id,team,slot
  FROM generate_series(1,10) team CROSS JOIN generate_series(1,25) slot;
INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,nba_team,years_exp,injury_status)
  SELECT id,'Benchmark',id::text,'PG',ARRAY['PG'],'BOS',0,'Out' FROM benchmark_players;
SELECT private.authorize_taxi_acquisition(f.league_id,f.season_id,f.member_ids[p.team],p.id,'draft',gen_random_uuid())
  FROM benchmark_fixture f CROSS JOIN benchmark_players p WHERE p.slot>=23;
INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via,is_on_ir,is_on_taxi)
  SELECT f.league_id,f.season_id,f.member_ids[p.team],p.id,'draft',p.slot BETWEEN 21 AND 22 AND p.team<>3,p.slot>=23
  FROM benchmark_fixture f CROSS JOIN benchmark_players p WHERE p.team<>3 OR p.slot NOT BETWEEN 21 AND 22;
INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
  VALUES(9584,1,current_date-3,current_date+3);
CREATE TEMP TABLE benchmark_matchup AS SELECT gen_random_uuid() AS id;
INSERT INTO public.matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id)
  SELECT m.id,f.league_id,f.season_id,1,f.member_ids[2],f.member_ids[3]
  FROM benchmark_fixture f CROSS JOIN benchmark_matchup m;
CREATE TEMP TABLE benchmark_games AS SELECT gen_random_uuid() AS id,n FROM generate_series(1,41)n;
INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_time)
  SELECT id,'002-benchmark-'||id,9584,1,current_date+21-n,'BOS','NYK',
    CASE WHEN n>21 THEN 'Final' ELSE 'Scheduled' END,(current_date+21-n)+time '22:00' FROM benchmark_games;
INSERT INTO public.player_game_stats(game_id,player_id,season_year,game_date,week_number,points,minutes_played)
  SELECT g.id,p.id,9584,current_date+21-g.n,1,20,25
  FROM benchmark_games g CROSS JOIN benchmark_players p WHERE g.n>21 AND p.slot<=20;
SELECT f.member_ids[2] AS sender_id,f.member_ids[3] AS recipient_id,m.id AS matchup_id
  FROM benchmark_fixture f CROSS JOIN benchmark_matchup m \gset

\if :{?benchmark_large}
SET LOCAL session_replication_role=replica;
CREATE TEMP TABLE benchmark_history_players AS SELECT gen_random_uuid() AS id FROM generate_series(1,10000);
INSERT INTO public.players(id,first_name,last_name)
  SELECT id,'History',id::text FROM benchmark_history_players;
INSERT INTO public.player_game_stats(game_id,player_id,season_year,game_date,week_number,points,minutes_played)
  SELECT g.id,p.id,9584,current_date+21-g.n,1,20,25
  FROM benchmark_games g CROSS JOIN benchmark_history_players p WHERE g.n>21;
SET LOCAL session_replication_role=origin;
\endif
