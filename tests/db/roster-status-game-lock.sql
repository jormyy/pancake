-- Compound roster actions must enforce the same game lock as direct actions.
BEGIN;
INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES ('00000000-0000-0000-0000-0000f6d40001','authenticated','authenticated','c002@example.test','x',now(),'{}','{}',now(),now());
INSERT INTO profiles(id,username) VALUES ('00000000-0000-0000-0000-0000f6d40001','c002_owner') ON CONFLICT(id) DO NOTHING;
INSERT INTO leagues(id,name,slug,commissioner_id,status,roster_size,ir_slots,taxi_slots)
VALUES ('00000000-0000-0000-0000-0000f6d40101','C002 Repro','c002-repro','00000000-0000-0000-0000-0000f6d40001','active',1,2,2);
INSERT INTO league_members(id,league_id,user_id,role,team_name)
VALUES ('00000000-0000-0000-0000-0000f6d40201','00000000-0000-0000-0000-0000f6d40101','00000000-0000-0000-0000-0000f6d40001','commissioner','C002 Team');
INSERT INTO league_seasons(id,league_id,season_year,is_current)
VALUES ('00000000-0000-0000-0000-0000f6d40301','00000000-0000-0000-0000-0000f6d40101',2104,true);
INSERT INTO players(id,first_name,last_name,nba_team,position,eligible_positions,injury_status,years_exp,nba_draft_number) VALUES
('00000000-0000-0000-0000-0000f6d40401','Locked','Rookie','LCK','PG',ARRAY['PG'],'Out',0,1),
('00000000-0000-0000-0000-0000f6d40402','Returning','Player','UNL','SG',ARRAY['SG'],'Out',1,20);
INSERT INTO roster_players(id,league_id,league_season_id,member_id,player_id,is_on_ir,acquired_via) VALUES
('00000000-0000-0000-0000-0000f6d40501','00000000-0000-0000-0000-0000f6d40101','00000000-0000-0000-0000-0000f6d40301','00000000-0000-0000-0000-0000f6d40201','00000000-0000-0000-0000-0000f6d40401',false,'draft'),
('00000000-0000-0000-0000-0000f6d40502','00000000-0000-0000-0000-0000f6d40101','00000000-0000-0000-0000-0000f6d40301','00000000-0000-0000-0000-0000f6d40201','00000000-0000-0000-0000-0000f6d40402',true,'draft');
INSERT INTO nba_games(id,week_number,season_year,game_date,home_team,away_team,status,game_time)
VALUES ('00000000-0000-0000-0000-0000f6d40601',1,2104,(now() at time zone 'America/New_York')::date,'LCK','OPP','InProgress',now()-interval '1 hour');
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000f6d40001',true);

CREATE FUNCTION pg_temp.expect_game_lock(p_query text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_rejected boolean := false;
BEGIN
  BEGIN
    EXECUTE p_query;
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE '%game has already started%' THEN RAISE; END IF;
    v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Game lock was bypassed: %', p_query; END IF;
END;
$$;

DO $$
BEGIN
  BEGIN
    PERFORM public.activate_roster_player_with_overflow_atomic(
      '00000000-0000-0000-0000-0000f6d40502', 'ir',
      '00000000-0000-0000-0000-0000f6d40501', 'taxi');
    RAISE EXCEPTION 'Taxi overflow action unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    IF SQLERRM <> 'Invalid roster overflow action: taxi' THEN RAISE; END IF;
  END;
END;
$$;

SET LOCAL ROLE authenticated;
SELECT pg_temp.expect_game_lock(format(
  'SELECT public.activate_roster_player_with_overflow_atomic(%L, %L, %L, %L)',
  '00000000-0000-0000-0000-0000f6d40502', 'ir',
  '00000000-0000-0000-0000-0000f6d40501', action))
FROM unnest(ARRAY['ir']) AS action;

-- The activated player must also be unlocked. A failed activation undoes its drop.
RESET ROLE;
UPDATE players SET nba_team = CASE WHEN id = '00000000-0000-0000-0000-0000f6d40402' THEN 'LCK' ELSE 'UNL' END
WHERE id IN ('00000000-0000-0000-0000-0000f6d40401', '00000000-0000-0000-0000-0000f6d40402');
SET LOCAL ROLE authenticated;
SELECT pg_temp.expect_game_lock(
  'SELECT public.activate_roster_player_with_overflow_atomic(''00000000-0000-0000-0000-0000f6d40502'', ''ir'', ''00000000-0000-0000-0000-0000f6d40501'', ''drop'')');
SELECT pg_temp.expect_game_lock(format(
  'SELECT public.activate_roster_player_with_lineup_atomic(%L, %L, NULL, NULL, %L, %L, %L, current_date, 1, %L)',
  '00000000-0000-0000-0000-0000f6d40502', 'ir',
  '00000000-0000-0000-0000-0000f6d40201', '00000000-0000-0000-0000-0000f6d40101',
  '00000000-0000-0000-0000-0000f6d40301', slot))
FROM unnest(ARRAY[NULL, 'BE', 'SG']) AS slot;

RESET ROLE;
-- Seed an existing taxi member for activation checks. This is fixture setup,
-- not a permitted manual entry. Restore veteran metadata and the started team.
UPDATE players SET years_exp=0,nba_team='UNL' WHERE id='00000000-0000-0000-0000-0000f6d40402';
SELECT private.authorize_taxi_acquisition('00000000-0000-0000-0000-0000f6d40101','00000000-0000-0000-0000-0000f6d40301',
  '00000000-0000-0000-0000-0000f6d40201','00000000-0000-0000-0000-0000f6d40402','draft','00000000-0000-0000-0000-0000f6d40502');
UPDATE roster_players SET is_on_ir = false, is_on_taxi = true
WHERE id = '00000000-0000-0000-0000-0000f6d40502';
UPDATE players SET years_exp=1,nba_team='LCK' WHERE id='00000000-0000-0000-0000-0000f6d40402';
SET LOCAL ROLE authenticated;
SELECT pg_temp.expect_game_lock(
  'SELECT public.activate_roster_player_with_overflow_atomic(''00000000-0000-0000-0000-0000f6d40502'', ''taxi'', ''00000000-0000-0000-0000-0000f6d40501'', ''drop'')');
SELECT pg_temp.expect_game_lock(format(
  'SELECT public.activate_roster_player_with_lineup_atomic(%L, %L, NULL, NULL, %L, %L, %L, current_date, 1, %L)',
  '00000000-0000-0000-0000-0000f6d40502', 'taxi',
  '00000000-0000-0000-0000-0000f6d40201', '00000000-0000-0000-0000-0000f6d40101',
  '00000000-0000-0000-0000-0000f6d40301', slot))
FROM unnest(ARRAY[NULL, 'BE', 'SG']) AS slot;

DO $$
BEGIN
  IF (SELECT count(*) FROM roster_players WHERE member_id = '00000000-0000-0000-0000-0000f6d40201') <> 2
     OR NOT (SELECT is_on_taxi FROM roster_players WHERE id = '00000000-0000-0000-0000-0000f6d40502')
     OR EXISTS (SELECT 1 FROM roster_transactions WHERE league_id = '00000000-0000-0000-0000-0000f6d40101') THEN
    RAISE EXCEPTION 'Rejected compound moves changed roster state or history';
  END IF;
END;
$$;

-- Match the existing API lock across slate boundaries and feed signals.
RESET ROLE;
DO $$
DECLARE v_case record;
BEGIN
  FOR v_case IN SELECT * FROM (VALUES
    (0, 'Scheduled', interval '1 hour', NULL::interval, false),
    (0, 'Scheduled', interval '-1 hour', NULL::interval, true),
    (0, 'Scheduled', NULL::interval, interval '-1 hour', true),
    (0, 'Final', NULL::interval, NULL::interval, true),
    (-1, 'InProgress', interval '-13 hours', NULL::interval, true),
    (-1, 'Final', interval '-13 hours', NULL::interval, false),
    (-1, 'Final', interval '-1 hour', NULL::interval, true),
    (-2, 'InProgress', interval '-1 hour', NULL::interval, false)
  ) AS cases(day_offset, status, tip_offset, start_offset, expected)
  LOOP
    UPDATE nba_games
       SET game_date = (now() AT TIME ZONE 'America/New_York')::date + v_case.day_offset,
           status = v_case.status, game_time = now() + v_case.tip_offset,
           started_at = now() + v_case.start_offset
     WHERE id = '00000000-0000-0000-0000-0000f6d40601';
    IF private.roster_status_game_started('00000000-0000-0000-0000-0000f6d40402') IS DISTINCT FROM v_case.expected THEN
      RAISE EXCEPTION 'Wrong roster lock for %', v_case;
    END IF;
  END LOOP;
END;
$$;

-- Unstarted games still permit the compound action.
UPDATE nba_games SET game_date = (now() AT TIME ZONE 'America/New_York')::date,
  status = 'Scheduled', game_time = now() + interval '1 hour', started_at = NULL
WHERE id = '00000000-0000-0000-0000-0000f6d40601';
SET LOCAL ROLE authenticated;
SELECT public.activate_roster_player_with_overflow_atomic(
  '00000000-0000-0000-0000-0000f6d40502', 'taxi',
  '00000000-0000-0000-0000-0000f6d40501', 'drop');
DO $$
BEGIN
  IF (SELECT count(*) FROM roster_players WHERE member_id = '00000000-0000-0000-0000-0000f6d40201') <> 1
     OR (SELECT is_on_taxi FROM roster_players WHERE id = '00000000-0000-0000-0000-0000f6d40502') THEN
    RAISE EXCEPTION 'Legal unstarted activation did not complete';
  END IF;
END;
$$;
ROLLBACK;
