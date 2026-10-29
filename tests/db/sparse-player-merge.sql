BEGIN;
INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES('00000000-0000-0000-0000-0000f6d42000','authenticated','authenticated','sparse-merge@example.test','x',now(),'{}','{}',now(),now());
INSERT INTO leagues(id,name,slug,commissioner_id,status,roster_size)
VALUES('00000000-0000-0000-0000-0000f6d42001','Sparse Merge Lock','sparse-merge-lock','00000000-0000-0000-0000-0000f6d42000','active',2);
INSERT INTO league_members(id,league_id,user_id,role,team_name)
VALUES('00000000-0000-0000-0000-0000f6d42002','00000000-0000-0000-0000-0000f6d42001','00000000-0000-0000-0000-0000f6d42000','commissioner','History Team');
INSERT INTO league_seasons(id,league_id,season_year,is_current)
VALUES('00000000-0000-0000-0000-0000f6d42003','00000000-0000-0000-0000-0000f6d42001',2120,true);
INSERT INTO season_weeks(season_year,week_number,week_start,week_end)
VALUES(2120,1,(now() at time zone 'America/New_York')::date-3,(now() at time zone 'America/New_York')::date+3);
INSERT INTO players(id,first_name,last_name,nba_team,position,eligible_positions)
VALUES('00000000-0000-0000-0000-0000f6d42004','Traded','History','XHA','PG',ARRAY['PG']);
INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,is_on_ir,acquired_via)
VALUES('00000000-0000-0000-0000-0000f6d42001','00000000-0000-0000-0000-0000f6d42003','00000000-0000-0000-0000-0000f6d42002','00000000-0000-0000-0000-0000f6d42004',false,'draft');
INSERT INTO nba_games(id,nba_game_id,week_number,season_year,game_date,home_team,away_team,status,game_time)
VALUES('00000000-0000-0000-0000-0000f6d42006','0022599999',1,2120,(now() at time zone 'America/New_York')::date,'XHA','XHC','InProgress',now()-interval '1 day');
INSERT INTO players(id,first_name,last_name,nba_id) VALUES('00000000-0000-0000-0000-0000f6d42005','Sparse','Survivor','f6d4-sparse-nba');
UPDATE players SET espn_id='f6d4-sparse-espn',sportsdata_id='f6d4-sparse-sportsdata',headshot_url='https://example.test/photo.png',years_exp=0,nba_draft_number=7,injury_status='Out',sleeper_id='f6d4-sparse-sleeper' WHERE id='00000000-0000-0000-0000-0000f6d42004';
INSERT INTO weekly_lineups(league_id,league_season_id,member_id,player_id,game_date,week_number,slot_type,is_auto_set)
VALUES('00000000-0000-0000-0000-0000f6d42001','00000000-0000-0000-0000-0000f6d42003','00000000-0000-0000-0000-0000f6d42002','00000000-0000-0000-0000-0000f6d42004',(now() AT TIME ZONE 'America/New_York')::date,1,'PG',false);
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000f6d42000',true);
SET LOCAL ROLE authenticated;
DO $$ BEGIN
 BEGIN
  PERFORM auto_set_lineup_atomic('00000000-0000-0000-0000-0000f6d42002','00000000-0000-0000-0000-0000f6d42001','00000000-0000-0000-0000-0000f6d42003',(now() AT TIME ZONE 'America/New_York')::date,'[]');
  RAISE EXCEPTION 'Control did not lock started player';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM NOT LIKE 'Lineup changes are locked because%' THEN RAISE; END IF; END;
END $$;
RESET ROLE;
SELECT assign_player_nba_id_atomic('00000000-0000-0000-0000-0000f6d42004','f6d4-sparse-nba');
SELECT id,nba_team,position,eligible_positions,espn_id,years_exp,injury_status FROM players WHERE id='00000000-0000-0000-0000-0000f6d42005';
SET LOCAL ROLE authenticated;
DO $$ BEGIN
 BEGIN
  PERFORM auto_set_lineup_atomic('00000000-0000-0000-0000-0000f6d42002','00000000-0000-0000-0000-0000f6d42001','00000000-0000-0000-0000-0000f6d42003',(now() AT TIME ZONE 'America/New_York')::date,'[]');
  RAISE EXCEPTION 'Merging the sparse player unlocked a started lineup';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM NOT LIKE 'Lineup changes are locked because%' THEN RAISE; END IF; END;
END $$;
RESET ROLE;
DO $$ BEGIN
 IF (SELECT (nba_team,position,eligible_positions,espn_id,years_exp,nba_draft_number,injury_status,headshot_url,sleeper_id) IS DISTINCT FROM ('XHA'::text,'PG'::nba_position,ARRAY['PG'],'f6d4-sparse-espn'::text,0,7,'Out'::text,'https://example.test/photo.png'::text,'f6d4-sparse-sleeper'::text) FROM players WHERE id='00000000-0000-0000-0000-0000f6d42005') THEN RAISE EXCEPTION 'Merge lost populated metadata'; END IF;
 IF NOT EXISTS(SELECT FROM weekly_lineups WHERE player_id='00000000-0000-0000-0000-0000f6d42005') THEN RAISE EXCEPTION 'Merged lineup disappeared'; END IF;
END $$;
DO $$
DECLARE v_winner uuid := gen_random_uuid(); v_loser uuid := gen_random_uuid();
BEGIN
 INSERT INTO players(id,first_name,last_name,nba_team,position,eligible_positions,espn_id,years_exp,injury_status)
 VALUES(v_winner,'Populated','Winner','XWB','SG',ARRAY['SG'],'f6d4-populated-espn',3,NULL),
       (v_loser,'Old','Loser','XLB','PG',ARRAY['PG'],'f6d4-old-espn',0,'Out');
 BEGIN
  PERFORM merge_players(v_winner,v_loser);
  RAISE EXCEPTION 'Different ESPN identities merged';
 EXCEPTION WHEN check_violation THEN NULL; END;
 IF (SELECT count(*) FROM players WHERE id IN(v_winner,v_loser)) <> 2 THEN
   RAISE EXCEPTION 'Rejected merge changed identities';
 END IF;
 UPDATE players SET espn_id=NULL WHERE id=v_loser;
 PERFORM merge_players(v_winner,v_loser);
 IF (SELECT (nba_team,position,eligible_positions,espn_id,years_exp,injury_status) IS DISTINCT FROM
    ('XWB'::text,'SG'::nba_position,ARRAY['SG'],'f6d4-populated-espn'::text,3,NULL::text)
    FROM players WHERE id=v_winner) THEN RAISE EXCEPTION 'Merge overwrote populated canonical metadata'; END IF;
 IF EXISTS(SELECT FROM players WHERE id=v_loser) THEN RAISE EXCEPTION 'Merged duplicate remains'; END IF;
END $$;
ROLLBACK;
