SET session_replication_role=replica;
INSERT INTO public.players(id,first_name,last_name,nba_team,position,eligible_positions,status,sportsdata_id)
SELECT bench.profile_id(1000+i),'Scale',lpad(i::text,4,'0'),p.nba_team,p.position,p.eligible_positions,p.status,'public-scale-'||i
FROM generate_series(601,3000) i JOIN public.players p ON p.id=bench.profile_id(1000+1+(i-1)%600);
INSERT INTO public.player_game_stats(player_id,game_id,season_year,week_number,game_date,minutes_played,points,rebounds,assists,steals,blocks,turnovers,three_pointers_made,field_goals_made,field_goals_attempted,free_throws_made,free_throws_attempted,did_not_play)
SELECT bench.profile_id(1000+i),s.game_id,s.season_year,s.week_number,s.game_date,s.minutes_played,s.points,s.rebounds,s.assists,s.steals,s.blocks,s.turnovers,s.three_pointers_made,s.field_goals_made,s.field_goals_attempted,s.free_throws_made,s.free_throws_attempted,s.did_not_play
FROM generate_series(601,3000) i JOIN public.player_game_stats s ON s.player_id=bench.profile_id(1000+1+(i-1)%600);
DELETE FROM public.fantasypros_projection_rows WHERE true;
DELETE FROM public.player_projections WHERE true;
INSERT INTO public.player_projections(player_id,season_year,week_number,projected_points,projected_minutes,projected_stat_points,projected_rebounds,projected_assists,projected_steals,projected_blocks,projected_turnovers,projected_three_pointers_made,fetched_at)
SELECT bench.profile_id(1000+i),2027,w,25+i%10,30,18+i%10,5,4,1,1,2,2,now()
FROM generate_series(1,3000) i CROSS JOIN generate_series(1,3) w WHERE i%5=0 OR i<=8;
SET session_replication_role=origin;
ANALYZE;
