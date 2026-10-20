DO $$ BEGIN
  IF current_setting('app.bench_profile_target',true) IS DISTINCT FROM 'http://127.0.0.1:56321' THEN
    RAISE EXCEPTION 'Run this fixture through the guarded profile runner';
  END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS bench;
CREATE OR REPLACE FUNCTION bench.profile_id(n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT md5('pancake-perf-6172026:' || n)::uuid $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.leagues WHERE slug NOT LIKE 'perf-6172026-%') THEN
    RAISE EXCEPTION 'Profile requires an isolated empty league database';
  END IF;
END $$;
TRUNCATE public.leagues, public.players, public.nba_games, public.season_weeks,
public.sync_runs, public.edge_invocations, public.projection_sync_runs, public.cron_dispatch_state, public.live_poll_leases, public.lineup_tipoff_dispatches RESTART IDENTITY CASCADE;
INSERT INTO public.sync_runs(function_name,started_at,finished_at,status,rows_affected)
SELECT 'live-poll','2026-03-14T12:00:00Z'::timestamptz-n*interval '2 minutes','2026-03-14T12:00:00Z'::timestamptz-n*interval '2 minutes','success',0 FROM generate_series(1,21600)n;
INSERT INTO public.edge_invocations(function_name,queued_at,reconciled_at,status_code)
SELECT 'live-poll','2026-03-14T12:00:00Z'::timestamptz-n*interval '2 minutes','2026-03-14T12:00:00Z'::timestamptz-n*interval '2 minutes',200 FROM generate_series(1,21600)n;
INSERT INTO public.players(id,sportsdata_id,nba_id,first_name,last_name,nba_team,position,eligible_positions,status,years_exp,nba_draft_number)
SELECT bench.profile_id(1000+n),'perf-6172026-'||n,'perf-'||n,'Player',lpad(n::text,3,'0'),
(ARRAY['ATL','BOS','BKN','CHA','CHI','CLE','DAL','DEN','DET','GSW','HOU','IND','LAC','LAL','MEM','MIA','MIL','MIN','NOP','NYK','OKC','ORL','PHI','PHX','POR','SAC','SAS','TOR','UTA','WAS'])[1+(n-1)/20],
(ARRAY['PG','SG','SF','PF','C'])[1+(n-1)%5]::public.nba_position,
ARRAY[(ARRAY['PG','SG','SF','PF','C'])[1+(n-1)%5]],'Active',(n-1)%15,CASE WHEN n<=60 THEN n END
FROM generate_series(1,600)n;
INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
SELECT 2026,w,'2025-10-20'::date+(w-1)*7,'2025-10-26'::date+(w-1)*7 FROM generate_series(1,26)w;
INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status,stats_synced_at)
SELECT bench.profile_id(10000+(r-1)*15+s),'00225'||lpad(((r-1)*15+s)::text,5,'0'),2026,1+((r-1)*2+1)/7,
'2025-10-21'::date+(r-1)*2,('2025-10-21'::date+(r-1)*2)::timestamp AT TIME ZONE 'UTC',
(ARRAY['ATL','BOS','BKN','CHA','CHI','CLE','DAL','DEN','DET','GSW','HOU','IND','LAC','LAL','MEM','MIA','MIL','MIN','NOP','NYK','OKC','ORL','PHI','PHX','POR','SAC','SAS','TOR','UTA','WAS'])[s],
(ARRAY['ATL','BOS','BKN','CHA','CHI','CLE','DAL','DEN','DET','GSW','HOU','IND','LAC','LAL','MEM','MIA','MIL','MIN','NOP','NYK','OKC','ORL','PHI','PHX','POR','SAC','SAS','TOR','UTA','WAS'])[16+(s+r-2)%15],
'Final',now() FROM generate_series(1,82)r CROSS JOIN generate_series(1,15)s;
INSERT INTO public.player_game_stats(player_id,game_id,season_year,week_number,minutes_played,points,rebounds,assists,steals,blocks,turnovers,three_pointers_made,field_goals_made,field_goals_attempted,free_throws_made,free_throws_attempted,did_not_play)
SELECT p.id,g.id,2026,g.week_number,20+(n%18),8+n%25,2+n%11,1+n%9,n%4,n%3,n%5,n%6,3+n%9,10+n%12,2+n%5,5+n%6,false
FROM public.nba_games g JOIN public.players p ON p.nba_team IN(g.home_team,g.away_team)
CROSS JOIN LATERAL (SELECT abs(hashtext(p.sportsdata_id||g.nba_game_id)%1000) n)z;
INSERT INTO public.dynasty_rankings(source,source_rank,source_player_id,source_player_name,source_positions,source_team,scoring_format,player_id)
SELECT 'hashtagbasketball.com',n,'perf-'||n,'Player '||n,ARRAY[p.position::text],p.nba_team,'overall',p.id
FROM generate_series(1,600)n JOIN public.players p ON p.id=bench.profile_id(1000+n);
INSERT INTO public.dynasty_news(player_id,title,summary,source,url,published_at)
SELECT bench.profile_id(1001+(n-1)%600),'Player update '||n,repeat('Seeded season news. ',15),'perf',
'https://example.test/news/'||n,'2026-03-14T12:00:00Z'::timestamptz-n*interval '10 minutes' FROM generate_series(1,6000)n;
INSERT INTO public.leagues(id,name,slug,commissioner_id,status,roster_size,scoring_settings)
SELECT bench.profile_id(l),'Perf '||l,'perf-6172026-'||l,bench.profile_id(101),'active',15,
jsonb_build_object('points',1+(l%11)::numeric/100,'rebounds',1.2,'assists',1.5,'steals',3,'blocks',3,'turnovers',-1,'three_pointers_made',0.5)
FROM generate_series(1,30)l;
INSERT INTO public.league_seasons(id,league_id,season_year,is_current)
SELECT bench.profile_id(100000+l),bench.profile_id(l),2026,true FROM generate_series(1,30)l;
INSERT INTO public.league_members(id,league_id,user_id,role,team_name)
SELECT bench.profile_id(200000+l*100+m),bench.profile_id(l),bench.profile_id(100+m),CASE WHEN m=1 THEN 'commissioner' ELSE 'manager' END::public.league_member_role,'Team '||m
FROM generate_series(1,30)l CROSS JOIN generate_series(1,12)m;
INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via,acquired_at)
SELECT bench.profile_id(l),bench.profile_id(100000+l),bench.profile_id(200000+l*100+m),bench.profile_id(1000+(m-1)*15+p),'draft','2025-10-01T12:00:00Z'
FROM generate_series(1,30)l CROSS JOIN generate_series(1,12)m CROSS JOIN generate_series(1,15)p;
INSERT INTO public.weekly_lineups(league_id,league_season_id,member_id,player_id,week_number,game_date,slot_type,is_auto_set)
SELECT bench.profile_id(l),bench.profile_id(100000+l),bench.profile_id(200000+l*100+m),bench.profile_id(1000+(m-1)*15+CASE WHEN p=7 THEN 8 WHEN p=8 THEN 7 ELSE p END),21,'2026-03-14',
(ARRAY['PG','SG','SF','PF','C','G','F','UTIL'])[p]::public.roster_slot_type,true
FROM generate_series(1,30)l CROSS JOIN generate_series(1,12)m CROSS JOIN generate_series(1,8)p;
INSERT INTO public.matchups(league_id,league_season_id,week_number,home_member_id,away_member_id,home_points,away_points,is_finalized)
SELECT bench.profile_id(l),bench.profile_id(100000+l),w,bench.profile_id(200000+l*100+m),bench.profile_id(200000+l*100+m+6),800+w*13+m,750+w*15+m,w<21
FROM generate_series(1,30)l CROSS JOIN generate_series(1,26)w CROSS JOIN generate_series(1,6)m;
INSERT INTO public.standings(league_id,league_season_id,member_id,week_number,wins,losses,points_for,points_against,waiver_priority)
SELECT bench.profile_id(l),bench.profile_id(100000+l),bench.profile_id(200000+l*100+m),w,w/2,w-w/2,900*w+m,880*w+m,m
FROM generate_series(1,30)l CROSS JOIN generate_series(1,20)w CROSS JOIN generate_series(1,12)m;
INSERT INTO public.draft_picks(league_id,season_year,round,original_owner_id,current_owner_id)
SELECT bench.profile_id(l),y,r,bench.profile_id(200000+l*100+m),bench.profile_id(200000+l*100+m)
FROM generate_series(1,30)l CROSS JOIN generate_series(2027,2031)y CROSS JOIN generate_series(1,3)r CROSS JOIN generate_series(1,12)m ON CONFLICT DO NOTHING;
INSERT INTO public.waiver_priorities(league_id,league_season_id,member_id,priority)
SELECT bench.profile_id(l),bench.profile_id(100000+l),bench.profile_id(200000+l*100+m),m FROM generate_series(1,30)l CROSS JOIN generate_series(1,12)m ON CONFLICT DO NOTHING;
INSERT INTO public.waiver_claims(league_id,league_season_id,member_id,player_id,priority_at_submission,process_date,status)
SELECT bench.profile_id(l),bench.profile_id(100000+l),bench.profile_id(200000+l*100+m),bench.profile_id(1400+m),m,'2026-03-14','succeeded'
FROM generate_series(1,30)l CROSS JOIN generate_series(1,12)m CROSS JOIN generate_series(1,10)h;
INSERT INTO public.waiver_wire_log(league_id,league_season_id,player_id,clears_at)
SELECT bench.profile_id(l),bench.profile_id(100000+l),bench.profile_id(1400+m),'2026-03-16T12:00:00Z'
FROM generate_series(1,30)l CROSS JOIN generate_series(1,12)m;
INSERT INTO public.trades(id,league_id,league_season_id,proposer_member_id,recipient_member_id,status,proposed_at)
SELECT bench.profile_id(400000+l*100+n),bench.profile_id(l),bench.profile_id(100000+l),bench.profile_id(200001+l*100),bench.profile_id(200002+l*100),'pending',now()-n*interval '1 hour'
FROM generate_series(1,30)l CROSS JOIN generate_series(1,40)n;
INSERT INTO public.trade_participants(trade_id,member_id,sort_order,is_initiator,accepted_at)
SELECT bench.profile_id(400000+l*100+n),bench.profile_id(200000+l*100+m),m-1,m=1,CASE WHEN m=1 THEN now() END
FROM generate_series(1,30)l CROSS JOIN generate_series(1,40)n CROSS JOIN generate_series(1,2)m;
INSERT INTO public.trade_items(trade_id,side,player_id,from_member_id,to_member_id)
SELECT bench.profile_id(400000+l*100+n),'proposer',bench.profile_id(1001),bench.profile_id(200001+l*100),bench.profile_id(200002+l*100)
FROM generate_series(1,30)l CROSS JOIN generate_series(1,40)n;
INSERT INTO public.league_activity(league_id,league_season_id,actor_member_id,event_type,title,body,created_at)
SELECT bench.profile_id(l),bench.profile_id(100000+l),bench.profile_id(200001+l*100),'perf','Season activity '||n,repeat('Seeded activity. ',10),now()-n*interval '1 hour'
FROM generate_series(1,30)l CROSS JOIN generate_series(1,1000)n;
INSERT INTO public.drafts(id,league_id,league_season_id,draft_type,status,budget_per_team)
SELECT bench.profile_id(500000+l*10+d),bench.profile_id(l),bench.profile_id(100000+l),CASE WHEN d=1 THEN 'auction' ELSE 'snake' END::public.draft_type,'pending',200
FROM generate_series(1,30)l CROSS JOIN generate_series(1,2)d;
INSERT INTO public.draft_orders(draft_id,member_id,position)
SELECT bench.profile_id(500000+l*10+d),bench.profile_id(200000+l*100+m),m
FROM generate_series(1,30)l CROSS JOIN generate_series(1,2)d CROSS JOIN generate_series(1,12)m;
INSERT INTO public.draft_budgets(draft_id,member_id,initial_budget,remaining)
SELECT bench.profile_id(500001+l*10),bench.profile_id(200000+l*100+m),200,100
FROM generate_series(1,30)l CROSS JOIN generate_series(1,12)m;
INSERT INTO public.snake_draft_picks(draft_id,overall_pick,round,pick_in_round,member_id)
SELECT bench.profile_id(500002+l*10),n,1+(n-1)/12,1+(n-1)%12,bench.profile_id(200001+l*100+(n-1)%12)
FROM generate_series(1,30)l CROSS JOIN generate_series(1,36)n;
INSERT INTO public.nominations(draft_id,nominating_member_id,player_id,nomination_order,status)
SELECT bench.profile_id(500001+l*10),bench.profile_id(200001+l*100),bench.profile_id(1000+n),n,'no_bid'
FROM generate_series(1,30)l CROSS JOIN generate_series(1,180)n;
SELECT public.refresh_player_search_caches();
ANALYZE;
