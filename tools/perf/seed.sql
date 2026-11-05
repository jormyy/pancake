SET session_replication_role = replica;
UPDATE public.season_weeks SET week_start=week_start+(current_date-DATE '2026-11-04'),week_end=week_end+(current_date-DATE '2026-11-04');
UPDATE public.nba_games SET game_date=game_date+(current_date-DATE '2026-11-04'),game_time=game_time+(current_date-DATE '2026-11-04')*interval '1 day';
UPDATE public.weekly_lineups SET game_date=game_date+(current_date-DATE '2026-11-04');
INSERT INTO public.lineup_slot_templates(league_id,slot_type,slot_count)
SELECT id,slot::public.roster_slot_type,n FROM public.leagues CROSS JOIN (VALUES ('PG',1),('SG',1),('SF',1),('PF',1),('C',1),('G',1),('F',1),('UTIL',1),('BE',7)) slots(slot,n)
ON CONFLICT (league_id,slot_type) DO UPDATE SET slot_count=EXCLUDED.slot_count;
INSERT INTO public.weekly_lineups(league_id,league_season_id,member_id,player_id,week_number,game_date,slot_type,is_auto_set)
SELECT r.league_id,r.league_season_id,r.member_id,r.player_id,3,d::date,slots.slot::public.roster_slot_type,true
FROM public.roster_players r
JOIN (SELECT r.id,row_number() OVER (PARTITION BY member_id ORDER BY substring(p.sportsdata_id from '[0-9]+$')::integer) n FROM public.roster_players r JOIN public.players p ON p.id=r.player_id) numbered ON numbered.id=r.id
JOIN (VALUES (1,'PG'),(2,'SG'),(3,'SF'),(4,'PF'),(5,'C'),(6,'G'),(7,'UTIL'),(8,'F')) slots(n,slot) ON slots.n=numbered.n
CROSS JOIN generate_series(current_date-3,current_date+3,interval '1 day')d
ON CONFLICT DO NOTHING;
INSERT INTO public.player_projections(player_id,season_year,week_number,projected_points,projected_minutes,projected_stat_points,projected_rebounds,projected_assists,projected_steals,projected_blocks,projected_turnovers,projected_three_pointers_made,fetched_at)
SELECT id,2027,w,25,30,18,5,4,1,1,2,2,now() FROM public.players CROSS JOIN generate_series(1,26)w;
INSERT INTO public.projection_sync_runs(id,source,projection_type,source_url,season_year,projection_date,status,row_count,matched_count,completed_at)
SELECT bench.profile_id(900000+row_number() OVER(ORDER BY game_date)::integer),'fantasypros','daily','https://www.fantasypros.com/nba/projections/daily.php',2027,game_date,'success',600,600,now()
FROM (SELECT DISTINCT game_date FROM public.nba_games)d;
INSERT INTO public.fantasypros_projection_rows(run_id,projection_type,source_url,source_row_number,season_year,projection_date,fetched_at,source_player_name,normalized_player_name,source_team,source_positions,player_id,match_status,points,rebounds,assists,steals,blocks,turnovers,three_pointers_made,minutes)
SELECT run.id,'daily',run.source_url,row_number() OVER(PARTITION BY run.id ORDER BY p.id),2027,run.projection_date,now(),p.display_name,lower(p.display_name),p.nba_team,p.eligible_positions,p.id,'matched',18,5,4,1,1,2,2,30
FROM public.projection_sync_runs run JOIN public.nba_games g ON g.game_date=run.projection_date JOIN public.players p ON p.nba_team IN(g.home_team,g.away_team);
UPDATE public.player_game_stats s SET game_date=g.game_date FROM public.nba_games g WHERE g.id=s.game_id;
UPDATE public.players SET headshot_url=NULL,career_regular_season_games=82;
UPDATE public.matchups SET is_finalized=week_number<3;
UPDATE public.waiver_wire_log SET clears_at=now()+interval '1 day';
SET session_replication_role = origin;

ANALYZE;
NOTIFY pgrst, 'reload schema';
