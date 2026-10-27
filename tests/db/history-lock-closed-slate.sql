BEGIN;
SET LOCAL app.supabase_url = 'http://127.0.0.1:1';
INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES ('00000000-0000-0000-0000-0000f7010001','authenticated','authenticated','history-lock-owner@example.test','x',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-0000f7010002','authenticated','authenticated','history-lock-away@example.test','x',now(),'{}','{}',now(),now());
INSERT INTO leagues(id,name,slug,commissioner_id,status,roster_size,ir_slots,taxi_slots)
VALUES ('00000000-0000-0000-0000-0000f7010101','History lock','history-lock-review','00000000-0000-0000-0000-0000f7010001','active',3,2,2);
INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES
('00000000-0000-0000-0000-0000f7010201','00000000-0000-0000-0000-0000f7010101','00000000-0000-0000-0000-0000f7010001','commissioner','History Home'),
('00000000-0000-0000-0000-0000f7010202','00000000-0000-0000-0000-0000f7010101','00000000-0000-0000-0000-0000f7010002','manager','History Away');
INSERT INTO league_seasons(id,league_id,season_year,is_current)
VALUES ('00000000-0000-0000-0000-0000f7010301','00000000-0000-0000-0000-0000f7010101',2126,true);
INSERT INTO season_weeks(season_year,week_number,week_start,week_end)
VALUES (2126,1,(now() AT TIME ZONE 'America/New_York')::date-2,(now() AT TIME ZONE 'America/New_York')::date+4);
INSERT INTO players(id,first_name,last_name,nba_team,position,eligible_positions,injury_status,years_exp) VALUES
('00000000-0000-0000-0000-0000f7010401','Scored','History','XHA','PG',ARRAY['PG'],'Out',0),
('00000000-0000-0000-0000-0000f7010402','Missing','Participation','XHA','SG',ARRAY['SG'],'Out',0);
INSERT INTO roster_players(id,league_id,league_season_id,member_id,player_id,acquired_via) VALUES
('00000000-0000-0000-0000-0000f7010501','00000000-0000-0000-0000-0000f7010101','00000000-0000-0000-0000-0000f7010301','00000000-0000-0000-0000-0000f7010201','00000000-0000-0000-0000-0000f7010401','draft'),
('00000000-0000-0000-0000-0000f7010502','00000000-0000-0000-0000-0000f7010101','00000000-0000-0000-0000-0000f7010301','00000000-0000-0000-0000-0000f7010201','00000000-0000-0000-0000-0000f7010402','draft');
INSERT INTO nba_games(id,nba_game_id,week_number,season_year,game_date,home_team,away_team,status,game_time) VALUES
('00000000-0000-0000-0000-0000f7010601','002-history-yesterday',1,2126,(now() AT TIME ZONE 'America/New_York')::date-1,'XHA','XHB','Final',now()-interval '1 day'),
('00000000-0000-0000-0000-0000f7010602','002-history-today',1,2126,(now() AT TIME ZONE 'America/New_York')::date,'XHA','XHB','Final',now()-interval '3 hours'),
('00000000-0000-0000-0000-0000f7010603','002-history-tomorrow',1,2126,(now() AT TIME ZONE 'America/New_York')::date+1,'XHC','XHD','Scheduled',now()+interval '1 day');
INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,points,did_not_play)
VALUES ('00000000-0000-0000-0000-0000f7010401','00000000-0000-0000-0000-0000f7010601',2126,1,30,false),
('00000000-0000-0000-0000-0000f7010401','00000000-0000-0000-0000-0000f7010602',2126,1,25,false);
INSERT INTO weekly_lineups(id,member_id,league_id,league_season_id,player_id,game_date,week_number,slot_type,is_auto_set)
SELECT ('00000000-0000-0000-0000-0000f70107'||lpad((p.n*10+d.n)::text,2,'0'))::uuid,
 '00000000-0000-0000-0000-0000f7010201','00000000-0000-0000-0000-0000f7010101','00000000-0000-0000-0000-0000f7010301',
 p.id,(now() AT TIME ZONE 'America/New_York')::date+d.n,1,p.slot::roster_slot_type,false
FROM (VALUES (1,'00000000-0000-0000-0000-0000f7010401'::uuid,'PG'),(2,'00000000-0000-0000-0000-0000f7010402'::uuid,'SG')) p(n,id,slot)
CROSS JOIN (VALUES (-1),(0),(1)) d(n);
INSERT INTO matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id,home_points,away_points,winner_member_id,is_finalized)
VALUES ('00000000-0000-0000-0000-0000f7010801','00000000-0000-0000-0000-0000f7010101','00000000-0000-0000-0000-0000f7010301',1,'00000000-0000-0000-0000-0000f7010201','00000000-0000-0000-0000-0000f7010202',55,20,'00000000-0000-0000-0000-0000f7010201',true);
INSERT INTO standings(league_id,league_season_id,member_id,week_number,wins,losses,points_for,points_against,waiver_priority)
VALUES ('00000000-0000-0000-0000-0000f7010101','00000000-0000-0000-0000-0000f7010301','00000000-0000-0000-0000-0000f7010201',1,1,0,55,20,1),
('00000000-0000-0000-0000-0000f7010101','00000000-0000-0000-0000-0000f7010301','00000000-0000-0000-0000-0000f7010202',1,0,1,20,55,2);
CREATE FUNCTION pg_temp.history_bytes() RETURNS bytea LANGUAGE sql AS $$
SELECT convert_to(jsonb_build_object(
 'lineups',(SELECT jsonb_agg(to_jsonb(w) ORDER BY w.id) FROM weekly_lineups w WHERE w.league_id='00000000-0000-0000-0000-0000f7010101' AND w.game_date<=(now() AT TIME ZONE 'America/New_York')::date),
 'stats',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM player_game_stats s WHERE s.player_id IN ('00000000-0000-0000-0000-0000f7010401','00000000-0000-0000-0000-0000f7010402')),
 'points',(SELECT jsonb_agg(jsonb_build_array(w.id,public.compute_fantasy_points(s.id,w.league_id)) ORDER BY w.id,s.id) FROM weekly_lineups w JOIN player_game_stats s ON s.player_id=w.player_id AND s.game_date=w.game_date WHERE w.league_id='00000000-0000-0000-0000-0000f7010101' AND w.game_date<=(now() AT TIME ZONE 'America/New_York')::date),
 'matchups',(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM matchups m WHERE m.league_id='00000000-0000-0000-0000-0000f7010101'),
 'standings',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM standings s WHERE s.league_id='00000000-0000-0000-0000-0000f7010101')
)::text,'UTF8');
$$;
INSERT INTO players(id,first_name,last_name,nba_team,position,eligible_positions) VALUES('00000000-0000-0000-0000-0000f7010403','Unknown','Team',NULL,'SF',ARRAY['SF']);
INSERT INTO roster_players(id,league_id,league_season_id,member_id,player_id,acquired_via) VALUES('00000000-0000-0000-0000-0000f7010503','00000000-0000-0000-0000-0000f7010101','00000000-0000-0000-0000-0000f7010301','00000000-0000-0000-0000-0000f7010201','00000000-0000-0000-0000-0000f7010403','draft');
INSERT INTO weekly_lineups(member_id,league_id,league_season_id,player_id,game_date,week_number,slot_type)
SELECT '00000000-0000-0000-0000-0000f7010201','00000000-0000-0000-0000-0000f7010101','00000000-0000-0000-0000-0000f7010301','00000000-0000-0000-0000-0000f7010403',(now() AT TIME ZONE 'America/New_York')::date+n,1,'SF' FROM generate_series(0,1) n;
CREATE TEMP TABLE history_before AS SELECT pg_temp.history_bytes() AS bytes;
GRANT SELECT ON history_before TO authenticated;
UPDATE players SET nba_team='XHC' WHERE id IN ('00000000-0000-0000-0000-0000f7010401','00000000-0000-0000-0000-0000f7010402');
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000f7010001',true);
SET LOCAL ROLE authenticated;
SELECT public.drop_player_atomic('00000000-0000-0000-0000-0000f7010501');
DO $$
BEGIN
 IF pg_temp.history_bytes() IS DISTINCT FROM (SELECT bytes FROM history_before) THEN
  RAISE EXCEPTION 'Drop changes history despite recorded game participation';
 END IF;
END;
$$;
SELECT public.drop_player_atomic('00000000-0000-0000-0000-0000f7010502');
SELECT public.drop_player_atomic('00000000-0000-0000-0000-0000f7010503');
DO $$
BEGIN
 IF pg_temp.history_bytes() IS DISTINCT FROM (SELECT bytes FROM history_before) THEN
  RAISE EXCEPTION 'Drop changes finished-day lineup rows, points, matchups or standings';
 END IF;
 IF EXISTS(SELECT 1 FROM weekly_lineups WHERE league_id='00000000-0000-0000-0000-0000f7010101' AND game_date>(now() AT TIME ZONE 'America/New_York')::date) THEN
  RAISE EXCEPTION 'Drop keeps unlocked future lineup rows';
 END IF;
END;
$$;
ROLLBACK;
