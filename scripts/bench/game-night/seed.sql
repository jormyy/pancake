CREATE OR REPLACE FUNCTION game_night.id(n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('ab000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
CREATE TABLE IF NOT EXISTS game_night.parameters(season_year int, game_date date);
SET client_min_messages=warning;
SET session_replication_role=replica;
TRUNCATE game_night.parameters;
TRUNCATE public.leagues,public.players,public.nba_games,public.sync_runs,public.edge_invocations,public.live_poll_leases,private.work_items,cron.job_run_details RESTART IDENTITY CASCADE;
DELETE FROM auth.users WHERE email LIKE 'game-night-%@example.test';
INSERT INTO game_night.parameters SELECT public.current_season_year_et(),(now() AT TIME ZONE 'America/New_York')::date;
SET session_replication_role=replica;
INSERT INTO public.players(id,nba_id,first_name,last_name,nba_team,position,eligible_positions,status,years_exp)
SELECT game_night.id(1000+n),(900000+n)::text,'Synthetic','Player '||n,
(ARRAY['ATL','BOS','BKN','CHA','CHI','CLE','DAL','DEN','DET','GSW','HOU','IND','LAC','LAL','MEM','MIA','MIL','MIN','NOP','NYK','OKC','ORL','PHI','PHX','POR','SAC','SAS','TOR','UTA','WAS'])[1+(n-1)%600/20],
(ARRAY['PG','SG','SF','PF','C'])[1+(n-1)%5]::public.nba_position,
ARRAY[(ARRAY['PG','SG','SF','PF','C'])[1+(n-1)%5]],CASE WHEN n<=600 THEN 'Active' ELSE 'Inactive' END,(n-1)%15
FROM generate_series(1,2600)n;
INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
SELECT p.season_year, w, p.game_date-((extract(isodow FROM p.game_date)::int-1))+(w-2)*7,p.game_date-(extract(isodow FROM p.game_date)::int-1)+(w-2)*7+6
FROM game_night.parameters p CROSS JOIN generate_series(1,26)w ON CONFLICT(season_year,week_number) DO UPDATE SET week_start=excluded.week_start,week_end=excluded.week_end;
INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status,stats_synced_at)
SELECT game_night.id(100000+(s-1)*1230+(r-1)*15+t),'002'||lpad((p.season_year-s-2001)::text,2,'0')||lpad(((r-1)*15+t)::text,5,'0'),p.season_year-s,1+(r-1)*2/7,
make_date(p.season_year-s-1,10,21)+(r-1)*2,(make_date(p.season_year-s-1,10,21)+(r-1)*2)::timestamp AT TIME ZONE 'UTC',
(ARRAY['ATL','BOS','BKN','CHA','CHI','CLE','DAL','DEN','DET','GSW','HOU','IND','LAC','LAL','MEM'])[t],
(ARRAY['MIA','MIL','MIN','NOP','NYK','OKC','ORL','PHI','PHX','POR','SAC','SAS','TOR','UTA','WAS'])[1+(t+r-2)%15],
'Final',now() FROM game_night.parameters p CROSS JOIN generate_series(1,5)s CROSS JOIN generate_series(1,82)r CROSS JOIN generate_series(1,15)t;
INSERT INTO public.player_game_stats(player_id,game_id,season_year,week_number,minutes_played,points,rebounds,offensive_rebounds,defensive_rebounds,assists,steals,blocks,turnovers,personal_fouls,three_pointers_made,three_pointers_attempted,field_goals_made,field_goals_attempted,free_throws_made,free_throws_attempted,plus_minus,double_double,triple_double,did_not_play,game_date,is_home)
SELECT p.id,g.id,g.season_year,g.week_number,20+n%18,8+n%25,2+n%11,n%3,2+n%11-n%3,1+n%9,n%4,n%3,n%5,n%5,n%6,n%6+2,3+n%9,12+n%12,2+n%5,7+n%6,n%10-5,false,false,false,g.game_date,p.nba_team=g.home_team
FROM public.nba_games g JOIN public.players p ON p.nba_team IN(g.home_team,g.away_team) AND right(p.id::text,12)::bigint<=1600
CROSS JOIN LATERAL(SELECT abs(hashtext(p.id::text||g.nba_game_id)%1000)n)v;
SET session_replication_role=origin;
UPDATE public.players SET espn_id='800600',injury_status='Out' WHERE id=game_night.id(1600);
INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
SELECT game_night.id(100+n),'authenticated','authenticated','game-night-'||n||'@example.test','',now(),'{}','{}',now(),now() FROM generate_series(1,10)n;
INSERT INTO public.leagues(id,name,slug,commissioner_id,status,roster_size,scoring_settings)
VALUES(game_night.id(1),'Synthetic game night','game-night',game_night.id(101),'active',20,'{"points":1,"rebounds":1.2,"assists":1.5,"steals":3,"blocks":3,"turnovers":-1}');
INSERT INTO public.league_members(id,league_id,user_id,role,team_name)
SELECT game_night.id(200+n),game_night.id(1),game_night.id(100+n),CASE WHEN n=1 THEN 'commissioner' ELSE 'manager' END::public.league_member_role,'Synthetic team '||n FROM generate_series(1,10)n;
INSERT INTO public.league_seasons(id,league_id,season_year,is_current)
SELECT game_night.id(2),game_night.id(1),season_year,true FROM game_night.parameters;
INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via,acquired_at)
SELECT game_night.id(1),game_night.id(2),game_night.id(200+m),game_night.id(1000+(m-1)*20+p),'draft',now()-interval '30 days'
FROM generate_series(1,10)m CROSS JOIN generate_series(1,20)p;
INSERT INTO public.weekly_lineups(league_id,league_season_id,member_id,player_id,week_number,game_date,slot_type,is_auto_set)
SELECT game_night.id(1),game_night.id(2),game_night.id(200+m),game_night.id(1000+(m-1)*20+CASE WHEN p=7 THEN 8 WHEN p=8 THEN 7 ELSE p END),2,params.game_date,
(ARRAY['PG','SG','SF','PF','C','G','F','UTIL'])[p]::public.roster_slot_type,true
FROM generate_series(1,10)m CROSS JOIN generate_series(1,8)p CROSS JOIN game_night.parameters params;
INSERT INTO public.matchups(league_id,league_season_id,week_number,home_member_id,away_member_id,home_points,away_points,is_finalized)
SELECT game_night.id(1),game_night.id(2),w,game_night.id(200+m),game_night.id(205+m),0,0,false
FROM generate_series(1,26)w CROSS JOIN generate_series(1,5)m;
INSERT INTO public.standings(league_id,league_season_id,member_id,week_number,wins,losses,points_for,points_against,waiver_priority)
SELECT game_night.id(1),game_night.id(2),game_night.id(200+m),1,0,0,0,0,m FROM generate_series(1,10)m ON CONFLICT DO NOTHING;
SELECT public.refresh_player_search_caches();
ANALYZE;
