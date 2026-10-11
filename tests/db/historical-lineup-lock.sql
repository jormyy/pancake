BEGIN;
INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES('00000000-0000-0000-0000-0000f6d42500','authenticated','authenticated','past-lineup@example.test','x',now(),'{}','{}',now(),now());
INSERT INTO leagues(id,name,slug,commissioner_id,status,roster_size)
VALUES('00000000-0000-0000-0000-0000f6d42501','Historical Lock Check','historical-lock-regression','00000000-0000-0000-0000-0000f6d42500','active',2);
INSERT INTO league_members(id,league_id,user_id,role,team_name)
VALUES('00000000-0000-0000-0000-0000f6d42502','00000000-0000-0000-0000-0000f6d42501','00000000-0000-0000-0000-0000f6d42500','commissioner','History Team');
INSERT INTO league_seasons(id,league_id,season_year,is_current)
VALUES('00000000-0000-0000-0000-0000f6d42503','00000000-0000-0000-0000-0000f6d42501',2125,true);
INSERT INTO season_weeks(season_year,week_number,week_start,week_end)
VALUES(2125,1,(now() at time zone 'America/New_York')::date-3,(now() at time zone 'America/New_York')::date+3);
INSERT INTO players(id,first_name,last_name,nba_team,position,eligible_positions)
VALUES('00000000-0000-0000-0000-0000f6d42504','Traded','History','XHA','PG',ARRAY['PG']);
INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,is_on_ir,acquired_via)
VALUES('00000000-0000-0000-0000-0000f6d42501','00000000-0000-0000-0000-0000f6d42503','00000000-0000-0000-0000-0000f6d42502','00000000-0000-0000-0000-0000f6d42504',false,'draft');
INSERT INTO nba_games(id,nba_game_id,week_number,season_year,game_date,home_team,away_team,status,game_time)
VALUES('00000000-0000-0000-0000-0000f6d42506','0022500099',1,2125,(now() at time zone 'America/New_York')::date-1,'XHA','XHC','Final',now()-interval '1 day');
INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,points,did_not_play)
VALUES('00000000-0000-0000-0000-0000f6d42504','00000000-0000-0000-0000-0000f6d42506',2125,1,30,false);
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000f6d42500',true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE v_rejected boolean := false;
BEGIN
  BEGIN
    PERFORM set_player_slot_atomic('00000000-0000-0000-0000-0000f6d42502','00000000-0000-0000-0000-0000f6d42501','00000000-0000-0000-0000-0000f6d42503','00000000-0000-0000-0000-0000f6d42504',(now() at time zone 'America/New_York')::date-1,'PG',1);
  EXCEPTION WHEN SQLSTATE 'P0001' THEN v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Control: historical game was not locked'; END IF;
END;
$$;
RESET ROLE;
UPDATE players SET nba_team='XHB' WHERE id='00000000-0000-0000-0000-0000f6d42504';
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_day date := (now() AT TIME ZONE 'America/New_York')::date;
  v_rejected boolean;
BEGIN
  v_rejected := false;
  BEGIN
    PERFORM set_player_slot_atomic('00000000-0000-0000-0000-0000f6d42502','00000000-0000-0000-0000-0000f6d42501','00000000-0000-0000-0000-0000f6d42503','00000000-0000-0000-0000-0000f6d42504',v_day-1,'PG',1);
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'Past lineups cannot be changed.' THEN RAISE; END IF;
    v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Manual move rewrites yesterday after a team change'; END IF;
  v_rejected := false;
  BEGIN
    PERFORM auto_set_lineup_atomic('00000000-0000-0000-0000-0000f6d42502','00000000-0000-0000-0000-0000f6d42501','00000000-0000-0000-0000-0000f6d42503',v_day-1,
      '[{"player_id":"00000000-0000-0000-0000-0000f6d42504","slot_type":"PG","week_number":1}]');
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'Past lineups cannot be changed.' THEN RAISE; END IF;
    v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Auto-set rewrites yesterday after a team change'; END IF;
  IF EXISTS(SELECT 1 FROM weekly_lineups WHERE league_id='00000000-0000-0000-0000-0000f6d42501') THEN
    RAISE EXCEPTION 'Rejected changes persist a past starter';
  END IF;
  PERFORM set_player_slot_atomic('00000000-0000-0000-0000-0000f6d42502','00000000-0000-0000-0000-0000f6d42501','00000000-0000-0000-0000-0000f6d42503','00000000-0000-0000-0000-0000f6d42504',v_day+1,'PG',1);
  PERFORM auto_set_lineup_atomic('00000000-0000-0000-0000-0000f6d42502','00000000-0000-0000-0000-0000f6d42501','00000000-0000-0000-0000-0000f6d42503',v_day+1,
    '[{"player_id":"00000000-0000-0000-0000-0000f6d42504","slot_type":"PG","week_number":1}]');
END;
$$;
RESET ROLE;
UPDATE nba_games SET game_date=(now() AT TIME ZONE 'America/New_York')::date WHERE id='00000000-0000-0000-0000-0000f6d42506';
SET LOCAL ROLE authenticated;
DO $$
DECLARE v_rejected boolean := false;
BEGIN
  BEGIN
    PERFORM set_player_slot_atomic('00000000-0000-0000-0000-0000f6d42502','00000000-0000-0000-0000-0000f6d42501','00000000-0000-0000-0000-0000f6d42503','00000000-0000-0000-0000-0000f6d42504',(now() AT TIME ZONE 'America/New_York')::date,'PG',1);
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'Lineup changes are locked after %game has started.' THEN RAISE; END IF;
    v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Recorded participation lost the same-day game lock after a team change'; END IF;
END;
$$;
ROLLBACK;
