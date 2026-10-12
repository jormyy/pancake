-- A dropped locked starter retains its exact entry while other slots optimize.
BEGIN;
INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES ('00000000-0000-0000-0000-0000f6d40001','authenticated','authenticated','c002@example.test','x',now(),'{}','{}',now(),now());
INSERT INTO profiles(id,username) VALUES ('00000000-0000-0000-0000-0000f6d40001','c002_owner') ON CONFLICT(id) DO NOTHING;
INSERT INTO leagues(id,name,slug,commissioner_id,status,roster_size,ir_slots,taxi_slots)
VALUES ('00000000-0000-0000-0000-0000f6d40101','C002 Repro','c002-repro','00000000-0000-0000-0000-0000f6d40001','active',2,2,2);
INSERT INTO league_members(id,league_id,user_id,role,team_name)
VALUES ('00000000-0000-0000-0000-0000f6d40201','00000000-0000-0000-0000-0000f6d40101','00000000-0000-0000-0000-0000f6d40001','commissioner','C002 Team');
INSERT INTO league_seasons(id,league_id,season_year,is_current)
VALUES ('00000000-0000-0000-0000-0000f6d40301','00000000-0000-0000-0000-0000f6d40101',2104,true);
INSERT INTO players(id,first_name,last_name,nba_team,position,eligible_positions,injury_status,years_exp,nba_draft_number) VALUES
('00000000-0000-0000-0000-0000f6d40401','Locked','Rookie','LCK','PG',ARRAY['PG'],'Out',0,1),
('00000000-0000-0000-0000-0000f6d40402','Returning','Player','UNL','SG',ARRAY['SG'],'Out',1,20);
INSERT INTO roster_players(id,league_id,league_season_id,member_id,player_id,is_on_ir,acquired_via) VALUES
('00000000-0000-0000-0000-0000f6d40501','00000000-0000-0000-0000-0000f6d40101','00000000-0000-0000-0000-0000f6d40301','00000000-0000-0000-0000-0000f6d40201','00000000-0000-0000-0000-0000f6d40401',false,'draft'),
('00000000-0000-0000-0000-0000f6d40502','00000000-0000-0000-0000-0000f6d40101','00000000-0000-0000-0000-0000f6d40301','00000000-0000-0000-0000-0000f6d40201','00000000-0000-0000-0000-0000f6d40402',false,'draft');
INSERT INTO nba_games(id,week_number,season_year,game_date,home_team,away_team,status,game_time)
VALUES ('00000000-0000-0000-0000-0000f6d40601',1,2104,(now() at time zone 'America/New_York')::date,'LCK','OPP','InProgress',now()-interval '1 hour');
INSERT INTO season_weeks(season_year,week_number,week_start,week_end)
VALUES (2104,1,(now() AT TIME ZONE 'America/New_York')::date-1,(now() AT TIME ZONE 'America/New_York')::date+5);
INSERT INTO lineup_slot_templates(league_id,slot_type,slot_count) VALUES
('00000000-0000-0000-0000-0000f6d40101','PG',1),('00000000-0000-0000-0000-0000f6d40101','SG',1) ON CONFLICT(league_id,slot_type) DO UPDATE SET slot_count=excluded.slot_count;
INSERT INTO weekly_lineups(member_id,league_id,league_season_id,player_id,game_date,week_number,slot_type,is_auto_set)
VALUES ('00000000-0000-0000-0000-0000f6d40201','00000000-0000-0000-0000-0000f6d40101','00000000-0000-0000-0000-0000f6d40301','00000000-0000-0000-0000-0000f6d40401',(now() AT TIME ZONE 'America/New_York')::date,1,'PG',false);
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000f6d40001',true);
CREATE TEMP TABLE locked_before AS SELECT * FROM weekly_lineups WHERE member_id='00000000-0000-0000-0000-0000f6d40201';
GRANT SELECT ON locked_before TO authenticated;
SET LOCAL ROLE authenticated;
SELECT public.drop_player_atomic('00000000-0000-0000-0000-0000f6d40501');
SELECT public.auto_set_lineup_atomic(
'00000000-0000-0000-0000-0000f6d40201','00000000-0000-0000-0000-0000f6d40101','00000000-0000-0000-0000-0000f6d40301',(now() AT TIME ZONE 'America/New_York')::date,
'[{"player_id":"00000000-0000-0000-0000-0000f6d40401","slot_type":"PG","week_number":1,"is_auto_set":true},{"player_id":"00000000-0000-0000-0000-0000f6d40402","slot_type":"SG","week_number":1,"is_auto_set":true}]');
DO $$
BEGIN
  IF EXISTS (SELECT * FROM locked_before EXCEPT SELECT * FROM weekly_lineups) THEN
    RAISE EXCEPTION 'Auto-set changed the stored locked entry';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM weekly_lineups WHERE member_id='00000000-0000-0000-0000-0000f6d40201' AND player_id='00000000-0000-0000-0000-0000f6d40402' AND slot_type='SG') THEN
    RAISE EXCEPTION 'Auto-set did not fill the unlocked SG slot';
  END IF;
END;
$$;
DO $$
DECLARE v_rejected boolean := false;
BEGIN
  BEGIN
    PERFORM public.auto_set_lineup_atomic(
      '00000000-0000-0000-0000-0000f6d40201','00000000-0000-0000-0000-0000f6d40101',
      '00000000-0000-0000-0000-0000f6d40301',(now() AT TIME ZONE 'America/New_York')::date,
      '[{"player_id":"00000000-0000-0000-0000-0000f6d40401","slot_type":"UTIL","week_number":1}]');
  EXCEPTION WHEN SQLSTATE 'P0002' THEN v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Auto-set moved a departed locked player'; END IF;
  v_rejected := false;
  BEGIN
    PERFORM public.auto_set_lineup_atomic(
      '00000000-0000-0000-0000-0000f6d40201','00000000-0000-0000-0000-0000f6d40101',
      '00000000-0000-0000-0000-0000f6d40301',(now() AT TIME ZONE 'America/New_York')::date,'[]');
  EXCEPTION WHEN SQLSTATE 'P0001' THEN v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Auto-set removed a departed locked player'; END IF;
END;
$$;
RESET ROLE;
DELETE FROM roster_players WHERE player_id='00000000-0000-0000-0000-0000f6d40402';
SET LOCAL ROLE authenticated;
DO $$
DECLARE v_rejected boolean := false;
BEGIN
  BEGIN
    PERFORM public.auto_set_lineup_atomic(
      '00000000-0000-0000-0000-0000f6d40201','00000000-0000-0000-0000-0000f6d40101',
      '00000000-0000-0000-0000-0000f6d40301',(now() AT TIME ZONE 'America/New_York')::date,
      '[{"player_id":"00000000-0000-0000-0000-0000f6d40401","slot_type":"PG","week_number":1},{"player_id":"00000000-0000-0000-0000-0000f6d40402","slot_type":"SG","week_number":1}]');
  EXCEPTION WHEN SQLSTATE 'P0002' THEN v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Auto-set admitted an unowned unlocked player'; END IF;
  IF EXISTS (SELECT * FROM locked_before EXCEPT SELECT * FROM weekly_lineups) THEN
    RAISE EXCEPTION 'Rejected requests changed the stored locked entry';
  END IF;
END;
$$;
ROLLBACK;
