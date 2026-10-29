SET LOCAL app.supabase_url='http://127.0.0.1:1';
SET LOCAL app.edge_internal_token='excellence-fixture';
\ir rules-support.sql
CREATE TEMP TABLE excellence_fixture AS SELECT * FROM pg_temp.rules_fixture(2,2027);
CREATE TEMP TABLE excellence_players AS
SELECT gen_random_uuid() AS id,ordinal FROM generate_series(1,500) ordinal;
INSERT INTO public.players(id,first_name,last_name,nba_id,espn_id,nba_team,position,eligible_positions)
SELECT id,'Excellence',translate(md5(id::text),'0123456789','klmnopqrst'),'excellence-'||id,'excellence-'||id,'BOS','PG',ARRAY['PG']
FROM excellence_players;
INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
VALUES(2027,1,'2026-10-26','2026-11-01') ON CONFLICT(season_year,week_number) DO NOTHING;
INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
VALUES('002-excellence-'||gen_random_uuid(),2027,1,'2026-10-27','LAL','POR','Scheduled');
INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
SELECT league_id,season_id,member_ids[ordinal],id,'draft' FROM excellence_fixture CROSS JOIN excellence_players WHERE ordinal<=2;
INSERT INTO public.draft_picks(league_id,season_year,round,original_owner_id,current_owner_id)
SELECT league_id,year,1,member,member FROM excellence_fixture CROSS JOIN unnest(member_ids) member CROSS JOIN generate_series(2028,2030) year;
INSERT INTO public.drafts(league_id,league_season_id,draft_type,is_mock,created_by_member_id)
SELECT league_id,season_id,'auction',true,member_ids[1] FROM excellence_fixture;
