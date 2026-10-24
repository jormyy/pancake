SELECT cron.alter_job(jobid,active:=false) FROM cron.job WHERE username=current_user;
BEGIN;
INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES ('db000000-0000-4000-8000-000000000001','authenticated','authenticated','db-load@example.test','x',now(),'{}','{}',now(),now());
INSERT INTO public.leagues(id,name,slug,commissioner_id,status,scoring_settings)
SELECT ('db100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'Load '||n,'db-load-'||n,
'db000000-0000-4000-8000-000000000001','active',
jsonb_build_object('points',1,'rebounds',1.2,'assists',1.5,'steals',3,'blocks',3,'turnovers',-1,'double_double',2,'triple_double',4)
FROM generate_series(1,20)n;
INSERT INTO public.league_members(league_id,user_id,role,team_name)
SELECT id,'db000000-0000-4000-8000-000000000001','commissioner','Load' FROM public.leagues WHERE slug LIKE 'db-load-%';
INSERT INTO public.league_seasons(league_id,season_year,is_current)
SELECT id,public.current_season_year_et(),true FROM public.leagues WHERE slug LIKE 'db-load-%';
INSERT INTO public.players(id,first_name,last_name,nba_team,position,eligible_positions,status)
SELECT ('db200000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'Load','Player '||n,'LDB','PG',ARRAY['PG'],'Active'
FROM generate_series(1,500)n;
INSERT INTO public.nba_games(id,nba_game_id,season_year,game_date,week_number,home_team,away_team,status,stats_synced_at)
SELECT ('db300000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'002load'||lpad(n::text,8,'0'),public.current_season_year_et(),
(now() AT TIME ZONE 'America/New_York')::date-10-(n/10),1,'LDB','OPP','Final',now()
FROM generate_series(1,470)n;
INSERT INTO public.player_game_stats(player_id,game_id,season_year,week_number,points,rebounds,offensive_rebounds,defensive_rebounds,assists,steals,blocks,turnovers,personal_fouls,field_goals_made,field_goals_attempted,three_pointers_made,three_pointers_attempted,free_throws_made,free_throws_attempted,minutes_played,plus_minus,double_double,triple_double)
SELECT p.id,g.id,g.season_year,1,10+(x%25),x%15,x%5,x%10,x%12,x%4,x%3,x%6,x%5,8,17,x%5,8,4,5,30,x%20,x%3=0,x%11=0
FROM public.players p CROSS JOIN public.nba_games g CROSS JOIN LATERAL (SELECT (right(p.id::text,6)::int+right(g.id::text,6)::int) AS x) v
WHERE p.id::text LIKE 'db200000-%' AND g.id::text LIKE 'db300000-%';
INSERT INTO public.edge_invocations(function_name,request_id,queued_at,reconciled_at,status_code)
SELECT 'load-fixture',970000000+n,now()-interval '3 hours',CASE WHEN n<=29500 THEN now() END,CASE WHEN n<=29500 THEN 200 END
FROM generate_series(1,30000)n;
UPDATE public.edge_invocations SET worker_started_at=now()-interval '1 minute',worker_status='running',status_code=200 WHERE request_id BETWEEN 970029991 AND 970030000;
INSERT INTO net._http_response(id,status_code,content,created)
SELECT 970000000+n,200,'{"ok":true}',now() FROM generate_series(1,30000)n;
INSERT INTO cron.job_run_details(jobid,runid,database,username,command,status,start_time,end_time)
SELECT 999999,970000000+n,current_database(),current_user,'SELECT public.invoke_live_poll_if_due()','succeeded',now()-interval '2 days',now()-interval '2 days'
FROM generate_series(1,85000)n;
COMMIT;
ANALYZE public.player_game_stats;
ANALYZE public.edge_invocations;
ANALYZE public.nba_games;
ANALYZE public.players;
ANALYZE cron.job_run_details;
ANALYZE net._http_response;
