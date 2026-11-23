BEGIN;
SET LOCAL app.supabase_url = 'http://127.0.0.1:1';
INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES ('00000000-0000-0000-0000-0000f7020001','authenticated','authenticated','history-immutable-owner@example.test','x',now(),'{}','{}',now(),now());
INSERT INTO leagues(id,name,slug,commissioner_id,status,roster_size,ir_slots,taxi_slots)
VALUES ('00000000-0000-0000-0000-0000f7020101','History immutable','history-immutable','00000000-0000-0000-0000-0000f7020001','active',5,2,2);
INSERT INTO league_members(id,league_id,user_id,role,team_name)
VALUES ('00000000-0000-0000-0000-0000f7020201','00000000-0000-0000-0000-0000f7020101','00000000-0000-0000-0000-0000f7020001','commissioner','History Home');
INSERT INTO league_seasons(id,league_id,season_year,is_current)
VALUES ('00000000-0000-0000-0000-0000f7020301','00000000-0000-0000-0000-0000f7020101',2127,true);
INSERT INTO season_weeks(season_year,week_number,week_start,week_end)
VALUES (2127,1,(now() AT TIME ZONE 'America/New_York')::date-2,(now() AT TIME ZONE 'America/New_York')::date+4);
INSERT INTO players(id,first_name,last_name,nba_team,position,eligible_positions,injury_status,years_exp) VALUES
('00000000-0000-0000-0000-0000f7020401','Scored','History','XIA','PG',ARRAY['PG'],'Out',0),
('00000000-0000-0000-0000-0000f7020402','Unplayed','Final','XIA','SG',ARRAY['SG'],'Out',0),
('00000000-0000-0000-0000-0000f7020403','Tonight','Pending','XIC','SF',ARRAY['SF'],'Out',0),
('00000000-0000-0000-0000-0000f7020404','Merged','Survivor',NULL,'PG',ARRAY['PG'],'Out',0);
INSERT INTO roster_players(id,league_id,league_season_id,member_id,player_id,acquired_via)
SELECT ('00000000-0000-0000-0000-0000f70205'||lpad(n::text,2,'0'))::uuid,'00000000-0000-0000-0000-0000f7020101','00000000-0000-0000-0000-0000f7020301',
 '00000000-0000-0000-0000-0000f7020201',('00000000-0000-0000-0000-0000f70204'||lpad(n::text,2,'0'))::uuid,'draft'
FROM generate_series(1,3) n;
INSERT INTO nba_games(id,nba_game_id,week_number,season_year,game_date,home_team,away_team,status,game_time) VALUES
('00000000-0000-0000-0000-0000f7020601','002-immutable-yesterday',1,2127,(now() AT TIME ZONE 'America/New_York')::date-1,'XIA','XIB','Final',now()-interval '1 day'),
('00000000-0000-0000-0000-0000f7020602','002-immutable-today-final',1,2127,(now() AT TIME ZONE 'America/New_York')::date,'XIA','XIB','Final',now()-interval '3 hours'),
('00000000-0000-0000-0000-0000f7020603','002-immutable-today-later',1,2127,(now() AT TIME ZONE 'America/New_York')::date,'XIC','XID','Scheduled',now()+interval '3 hours'),
('00000000-0000-0000-0000-0000f7020604','002-immutable-tomorrow',1,2127,(now() AT TIME ZONE 'America/New_York')::date+1,'XIC','XID','Scheduled',now()+interval '1 day');
INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,points,did_not_play) VALUES
('00000000-0000-0000-0000-0000f7020401','00000000-0000-0000-0000-0000f7020601',2127,1,30,false),
('00000000-0000-0000-0000-0000f7020401','00000000-0000-0000-0000-0000f7020602',2127,1,25,false);
INSERT INTO weekly_lineups(id,member_id,league_id,league_season_id,player_id,game_date,week_number,slot_type,is_auto_set)
SELECT ('00000000-0000-0000-0000-0000f70207'||p.n||(d.n+1))::uuid,
 '00000000-0000-0000-0000-0000f7020201','00000000-0000-0000-0000-0000f7020101','00000000-0000-0000-0000-0000f7020301',
 ('00000000-0000-0000-0000-0000f70204'||lpad(p.n::text,2,'0'))::uuid,(now() AT TIME ZONE 'America/New_York')::date+d.n,1,p.slot::roster_slot_type,false
FROM (VALUES (1,'PG'),(2,'SG'),(3,'SF')) p(n,slot)
CROSS JOIN (VALUES (-1),(0),(1)) d(n);
INSERT INTO weekly_lineups(id,member_id,league_id,league_season_id,player_id,game_date,week_number,slot_type,is_auto_set)
VALUES ('00000000-0000-0000-0000-0000f7020740','00000000-0000-0000-0000-0000f7020201','00000000-0000-0000-0000-0000f7020101','00000000-0000-0000-0000-0000f7020301',
 '00000000-0000-0000-0000-0000f7020404',(now() AT TIME ZONE 'America/New_York')::date-1,1,'BE',false);

CREATE FUNCTION pg_temp.expect_history_error(statement text, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE statement;
  RAISE EXCEPTION 'History write was allowed: %', label;
EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM <> 'Lineup history is immutable: game_date is past or the game started; use private.correct_lineup_history()' THEN
    RAISE EXCEPTION 'History error does not name the fix for %: %', label, SQLERRM;
  END IF;
END;
$$;
CREATE FUNCTION pg_temp.lineups(player uuid) RETURNS text LANGUAGE sql AS $$
  SELECT string_agg((game_date-(now() AT TIME ZONE 'America/New_York')::date)::text||':'||slot_type,',' ORDER BY game_date)
  FROM weekly_lineups WHERE league_id='00000000-0000-0000-0000-0000f7020101' AND player_id=player
$$;

DO $$
BEGIN
  PERFORM pg_temp.expect_history_error($q$DELETE FROM weekly_lineups WHERE id='00000000-0000-0000-0000-0000f7020710'$q$,'delete a past day');
  PERFORM pg_temp.expect_history_error($q$UPDATE weekly_lineups SET slot_type='BE' WHERE id='00000000-0000-0000-0000-0000f7020710'$q$,'bench a past day');
  PERFORM pg_temp.expect_history_error($q$UPDATE weekly_lineups SET game_date=game_date+1 WHERE id='00000000-0000-0000-0000-0000f7020710'$q$,'move a past day');
  PERFORM pg_temp.expect_history_error($q$DELETE FROM weekly_lineups WHERE id='00000000-0000-0000-0000-0000f7020721'$q$,'delete a finished game without stats');
  UPDATE weekly_lineups SET is_auto_set=true,set_at=now() WHERE id='00000000-0000-0000-0000-0000f7020710';
  UPDATE weekly_lineups SET slot_type='UTIL' WHERE id='00000000-0000-0000-0000-0000f7020731';
END;
$$;

UPDATE players SET nba_team='XIE' WHERE id='00000000-0000-0000-0000-0000f7020402';
DO $$
BEGIN
  PERFORM pg_temp.expect_history_error($q$DELETE FROM weekly_lineups WHERE id='00000000-0000-0000-0000-0000f7020721'$q$,'delete a finished game after a team change');
END;
$$;

DELETE FROM roster_players WHERE league_id='00000000-0000-0000-0000-0000f7020101';
DO $$
BEGIN
  IF pg_temp.lineups('00000000-0000-0000-0000-0000f7020401') IS DISTINCT FROM '-1:PG,0:PG' THEN
    RAISE EXCEPTION 'Roster removal changed scored history: %', pg_temp.lineups('00000000-0000-0000-0000-0000f7020401');
  END IF;
  IF pg_temp.lineups('00000000-0000-0000-0000-0000f7020402') IS DISTINCT FROM '-1:SG,0:SG' THEN
    RAISE EXCEPTION 'Roster removal changed finished history: %', pg_temp.lineups('00000000-0000-0000-0000-0000f7020402');
  END IF;
  IF pg_temp.lineups('00000000-0000-0000-0000-0000f7020403') IS DISTINCT FROM '-1:SF' THEN
    RAISE EXCEPTION 'Roster removal kept unlocked days or lost history: %', pg_temp.lineups('00000000-0000-0000-0000-0000f7020403');
  END IF;
END;
$$;

SELECT public.merge_players('00000000-0000-0000-0000-0000f7020404','00000000-0000-0000-0000-0000f7020401');
DO $$
BEGIN
  IF pg_temp.lineups('00000000-0000-0000-0000-0000f7020404') IS DISTINCT FROM '-1:PG,0:PG' THEN
    RAISE EXCEPTION 'Merge did not move history to the survivor: %', pg_temp.lineups('00000000-0000-0000-0000-0000f7020404');
  END IF;
  PERFORM pg_temp.expect_history_error($q$DELETE FROM weekly_lineups WHERE id='00000000-0000-0000-0000-0000f7020710'$q$,'delete after a merge');
  PERFORM private.correct_lineup_history();
  DELETE FROM weekly_lineups WHERE id='00000000-0000-0000-0000-0000f7020710';
  PERFORM private.correct_lineup_history(false);
  PERFORM pg_temp.expect_history_error($q$DELETE FROM weekly_lineups WHERE id='00000000-0000-0000-0000-0000f7020711'$q$,'delete after the correction ends');
  IF has_function_privilege('authenticated','private.correct_lineup_history(boolean)','EXECUTE')
    OR has_function_privilege('anon','private.correct_lineup_history(boolean)','EXECUTE') THEN
    RAISE EXCEPTION 'Clients can unlock lineup history';
  END IF;
END;
$$;

DELETE FROM leagues WHERE id='00000000-0000-0000-0000-0000f7020101';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM weekly_lineups WHERE league_id='00000000-0000-0000-0000-0000f7020101') THEN
    RAISE EXCEPTION 'Deleting a league kept its lineups';
  END IF;
END;
$$;
ROLLBACK;
