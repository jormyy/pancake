BEGIN;
CREATE TEMP TABLE pin_checks (name text);
CREATE FUNCTION pg_temp.pin_check(p_pass boolean, p_name text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF p_pass IS DISTINCT FROM true THEN RAISE EXCEPTION 'Failed: %', p_name; END IF;
  INSERT INTO pg_temp.pin_checks VALUES (p_name);
END;
$$;
CREATE FUNCTION pg_temp.pin_error(p_sql text, p_state text, p_message text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = p_state AND SQLERRM LIKE '%' || p_message || '%' THEN RETURN; END IF;
    RAISE;
  END;
  RAISE EXCEPTION 'Expected %: %', p_state, p_sql;
END;
$$;
CREATE TEMP TABLE pin_fixture AS SELECT
  gen_random_uuid() AS owner, gen_random_uuid() AS other_owner,
  gen_random_uuid() AS league, gen_random_uuid() AS other_league,
  gen_random_uuid() AS season, gen_random_uuid() AS other_season,
  gen_random_uuid() AS member, gen_random_uuid() AS other_member,
  gen_random_uuid() AS a, gen_random_uuid() AS b, gen_random_uuid() AS c,
  gen_random_uuid() AS game, (now() AT TIME ZONE 'America/New_York')::date AS day;
GRANT SELECT ON pin_fixture TO authenticated, service_role;
DO $$
DECLARE f record;
BEGIN
  SELECT * INTO f FROM pin_fixture;
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
    (f.owner,f.owner || '@example.test',jsonb_build_object('username',f.owner)),
    (f.other_owner,f.other_owner || '@example.test',jsonb_build_object('username',f.other_owner));
  INSERT INTO public.leagues(id,name,slug,commissioner_id,status,timezone) VALUES
    (f.league,'Lineup pins',f.league::text,f.owner,'active','America/New_York'),
    (f.other_league,'Other pins',f.other_league::text,f.other_owner,'active','America/New_York');
  INSERT INTO public.league_members(id,league_id,user_id,role) VALUES
    (f.member,f.league,f.owner,'commissioner'),(f.other_member,f.league,f.other_owner,'manager');
  INSERT INTO public.league_seasons(id,league_id,season_year,is_current) VALUES
    (f.season,f.league,2197,true),(f.other_season,f.other_league,2197,true);
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(2197,1,f.day-1,f.day+6);
  INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,nba_team) VALUES
    (f.a,'Pin','Start','PG',ARRAY['PG'],'PIN'),(f.b,'Pin','Bench','PG',ARRAY['PG'],'PIN'),
    (f.c,'Other','Player','PG',ARRAY['PG'],'PIN');
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via) VALUES
    (f.league,f.season,f.member,f.a,'draft'),(f.league,f.season,f.member,f.b,'draft'),
    (f.league,f.season,f.other_member,f.c,'draft');
  DELETE FROM public.lineup_slot_templates WHERE league_id=f.league;
  INSERT INTO public.lineup_slot_templates(league_id,slot_type,slot_count) VALUES (f.league,'PG',1),(f.league,'BE',3);
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status)
    VALUES(f.game,f.game::text,2197,1,f.day,now()+interval '3 hours','PIN','OPP','Scheduled');
  INSERT INTO public.weekly_lineups(league_id,league_season_id,member_id,player_id,game_date,week_number,slot_type)
    VALUES(f.league,f.season,f.member,f.a,f.day,1,'PG');
  INSERT INTO public.matchups(league_id,league_season_id,week_number,home_member_id,away_member_id)
    VALUES(f.league,f.season,1,f.member,f.other_member);
  PERFORM set_config('request.jwt.claim.sub',f.owner::text,true);
END;
$$;
SET LOCAL ROLE authenticated;
DO $$
DECLARE f record; result jsonb;
BEGIN
  SELECT * INTO f FROM pin_fixture;
  result:=public.set_lineup_player_pin(f.league,f.a,f.day,'start');
  PERFORM pg_temp.pin_check(result=jsonb_build_object('playerId',f.a,'date',f.day,'lineupPin','start'),'owner RPC contract');
  PERFORM pg_temp.pin_check((SELECT count(*)=1 FROM public.lineup_player_pins),'owner reads own pin');
  PERFORM pg_temp.pin_error(format('SELECT public.set_lineup_player_pin(%L,%L,%L,%L)',f.other_league,f.a,f.day,'start'),'42501','Not authorized');
  PERFORM pg_temp.pin_error(format('SELECT public.set_lineup_player_pin(%L,%L,%L,%L)',f.league,f.c,f.day,'start'),'P0002','roster');
  PERFORM pg_temp.pin_error(format('SELECT public.set_lineup_player_pin(%L,%L,%L,%L)',f.league,f.a,f.day-1,'start'),'P0001','Past');
  PERFORM pg_temp.pin_error(format('SELECT public.set_lineup_player_pin(%L,%L,%L,%L)',f.league,f.a,f.day,'invalid'),'22023','Choose');
  PERFORM pg_temp.pin_error(format('SELECT public.set_lineup_player_pin(%L,%L,NULL,%L)',f.league,f.a,'start'),'22023','Choose');
  PERFORM pg_temp.pin_check(true,'owner, roster, past date and input rejection');
  PERFORM pg_temp.pin_error('UPDATE public.lineup_player_pins SET pin=''bench''','42501','permission denied');
  PERFORM pg_temp.pin_error('DELETE FROM public.lineup_player_pins','42501','permission denied');
  PERFORM pg_temp.pin_error(format('INSERT INTO public.lineup_player_pins VALUES(%L,%L,%L,%L,%L,%L)',f.league,f.season,f.member,f.b,f.day,'bench'),'42501','permission denied');
  PERFORM pg_temp.pin_check(true,'clients cannot write pins directly');
  result:=public.set_lineup_player_pin(f.league,f.a,f.day,NULL);
  PERFORM pg_temp.pin_check(result->'lineupPin'='null'::jsonb AND (SELECT count(*)=0 FROM public.lineup_player_pins),'Auto deletes pin');
  PERFORM public.set_lineup_player_pin(f.league,f.a,f.day,'start');
END;
$$;
RESET ROLE;
DO $$
DECLARE f record; before_pin text; after_pin text;
BEGIN
  SELECT * INTO f FROM pin_fixture;
  PERFORM set_config('request.jwt.claim.sub',f.other_owner::text,true);
  PERFORM pg_temp.pin_error(format('INSERT INTO public.lineup_player_pins VALUES(%L,%L,%L,%L,%L,%L)',f.league,f.other_season,f.member,f.b,f.day,'bench'),'23503','foreign key');
  PERFORM pg_temp.pin_error(format('INSERT INTO public.lineup_player_pins VALUES(%L,%L,%L,%L,%L,%L)',f.other_league,f.other_season,f.member,f.b,f.day,'bench'),'23503','foreign key');
  PERFORM pg_temp.pin_check(true,'composite league/member/season foreign keys');
  before_pin:=private.pre_tipoff_input_fingerprint(f.day);
  INSERT INTO public.lineup_player_pins VALUES(f.league,f.season,f.other_member,f.c,f.day,'bench');
  after_pin:=private.pre_tipoff_input_fingerprint(f.day);
  PERFORM pg_temp.pin_check(before_pin<>after_pin,'pin changes pre-tipoff fingerprint');
END;
$$;
SET LOCAL ROLE authenticated;
DO $$
DECLARE f record;
BEGIN
  SELECT * INTO f FROM pin_fixture;
  PERFORM pg_temp.pin_check((SELECT count(*)=1 AND bool_and(member_id=f.other_member) FROM public.lineup_player_pins),'RLS hides another owner pin');
END;
$$;
RESET ROLE;
DO $$
DECLARE f record;
BEGIN
  SELECT * INTO f FROM pin_fixture;
  PERFORM set_config('request.jwt.claim.sub',f.owner::text,true);
  UPDATE public.nba_games SET game_time=now()-interval '1 minute' WHERE id=f.game;
END;
$$;
SET LOCAL ROLE authenticated;
DO $$
DECLARE f record;
BEGIN
  SELECT * INTO f FROM pin_fixture;
  PERFORM pg_temp.pin_error(format('SELECT public.set_lineup_player_pin(%L,%L,%L,%L)',f.league,f.a,f.day,'bench'),'P0001','locked');
  PERFORM pg_temp.pin_error(format('SELECT public.set_lineup_player_pin(%L,%L,%L,NULL)',f.league,f.a,f.day),'P0001','locked');
  PERFORM pg_temp.pin_check(true,'locked pins cannot change or clear');
END;
$$;
RESET ROLE;
DO $$
DECLARE f record; result jsonb;
BEGIN
  SELECT * INTO f FROM pin_fixture;
  UPDATE public.nba_games SET game_time=now()+interval '3 hours' WHERE id=f.game;
  result:=public.get_pre_tipoff_lineup_context(f.league,f.season,f.member);
  PERFORM pg_temp.pin_check(EXISTS(SELECT 1 FROM jsonb_array_elements(result->'players') p WHERE p->>'playerId'=f.a::text AND p->>'lineupPin'='start'),'scheduled context loads pins');
  result:=public.view_lineup(f.league,f.member,jsonb_build_object('date',f.day));
  PERFORM pg_temp.pin_check(result->'starters'->0->'player'->>'lineupPin'='start','lineup selected-date starter pin');
  result:=public.view_roster(f.league,f.member);
  PERFORM pg_temp.pin_check(EXISTS(SELECT 1 FROM jsonb_array_elements(result->'roster') r WHERE r->'players'->>'id'=f.a::text AND r->'players'->>'lineupPin'='start'),'roster today pin');
  result:=public.view_home(f.league,f.member,jsonb_build_object('date',f.day));
  PERFORM pg_temp.pin_check(result->'myLineup'->'starters'->0->'player'->>'lineupPin'='start','Home today pin');
  result:=public.view_home(f.league,f.member,jsonb_build_object('date',f.day,'compact',true));
  PERFORM pg_temp.pin_check(result->'myLineup'->'starters'->0->1->>12='start','compact Home pin');
  PERFORM public.set_lineup_player_pin(f.league,f.a,f.day+1,'bench');
  result:=public.view_lineup(f.league,f.member,jsonb_build_object('date',f.day+1));
  PERFORM pg_temp.pin_check(EXISTS(SELECT 1 FROM jsonb_array_elements(result->'bench') p WHERE p->>'playerId'=f.a::text AND p->>'lineupPin'='bench'),'future selected-date bench pin');
  result:=public.view_home(f.league,f.member,jsonb_build_object('date',f.day+1));
  PERFORM pg_temp.pin_check(EXISTS(SELECT 1 FROM jsonb_array_elements(result->'myLineup'->'bench') p WHERE p->>'playerId'=f.a::text AND p->>'lineupPin'='start'),'Home shows today pin when browsing another day');
  PERFORM public.set_lineup_player_pin(f.league,f.b,f.day,'bench');
END;
$$;
SET LOCAL ROLE authenticated;
DO $$
DECLARE f record;
BEGIN
  SELECT * INTO f FROM pin_fixture;
  PERFORM public.set_player_slot_moves_atomic(f.member,f.league,f.season,f.day,1,
    jsonb_build_array(jsonb_build_object('player_id',f.a,'slot_type','BE'),jsonb_build_object('player_id',f.b,'slot_type','PG')));
  PERFORM pg_temp.pin_check((SELECT count(*)=0 FROM public.lineup_player_pins WHERE game_date=f.day),'manual moves clear both contradicted pins');
  PERFORM public.set_lineup_player_pin(f.league,f.b,f.day,'start');
  PERFORM public.set_player_slot_moves_atomic(f.member,f.league,f.season,f.day,1,jsonb_build_array(jsonb_build_object('player_id',f.b,'slot_type','PG')));
  PERFORM pg_temp.pin_check((SELECT pin='start' FROM public.lineup_player_pins WHERE player_id=f.b AND game_date=f.day),'consistent manual move keeps pin');
  PERFORM public.set_lineup_player_pin(f.league,f.b,f.day,'bench');
  PERFORM pg_temp.pin_error(format('SELECT public.auto_set_lineup_atomic(%L,%L,%L,%L,%L)',f.member,f.league,f.season,f.day,
    jsonb_build_array(jsonb_build_object('player_id',f.b,'slot_type','PG'))),'40001','pins changed');
  PERFORM pg_temp.pin_check(true,'automatic Bench violation rejected');
  PERFORM public.set_lineup_player_pin(f.league,f.b,f.day,NULL);
  PERFORM public.set_lineup_player_pin(f.league,f.a,f.day,'start');
  PERFORM pg_temp.pin_error(format('SELECT public.auto_set_lineup_atomic(%L,%L,%L,%L,%L)',f.member,f.league,f.season,f.day,
    jsonb_build_array(jsonb_build_object('player_id',f.b,'slot_type','PG'))),'40001','pins changed');
  PERFORM pg_temp.pin_check(true,'automatic healthy Start violation rejected');
END;
$$;
RESET ROLE;
DO $$
DECLARE f record;
BEGIN
  SELECT * INTO f FROM pin_fixture;
  PERFORM pg_temp.pin_error(format('SELECT private.apply_scheduled_lineup(%L,%L,%L,%L,%L)',f.day,f.league,f.season,f.member,
    jsonb_build_array(jsonb_build_object('player_id',f.b,'slot_type','PG'))),'40001','pins changed');
  PERFORM pg_temp.pin_check(true,'scheduled unchanged-assignment guard rejects stale pins');
  UPDATE public.players SET injury_status='Out' WHERE id=f.a;
  PERFORM public.auto_set_lineup_atomic(f.member,f.league,f.season,f.day,jsonb_build_array(jsonb_build_object('player_id',f.b,'slot_type','PG')));
  PERFORM pg_temp.pin_check(true,'Out Start yields to healthy Auto');
  UPDATE public.players SET injury_status=NULL WHERE id=f.a;
  UPDATE public.lineup_optimizer_settings SET enabled=false WHERE member_id=f.member;
  PERFORM public.set_lineup_player_pin(f.league,f.a,f.day,'bench');
  PERFORM pg_temp.pin_check(NOT public.apply_daily_lineup(f.day,f.league,f.season,f.member,
    jsonb_build_array(jsonb_build_object('player_id',f.a,'slot_type','PG'))),'disabled automation skips pinned lineups');
  PERFORM public.auto_set_lineup_atomic(f.member,f.league,f.season,f.day,
    jsonb_build_array(jsonb_build_object('player_id',f.b,'slot_type','PG')));
  PERFORM pg_temp.pin_check((SELECT pin='bench' FROM public.lineup_player_pins WHERE player_id=f.a AND game_date=f.day),'manual optimization uses pins with automatic switch off');
  PERFORM public.set_lineup_player_pin(f.league,f.a,f.day,NULL);
  UPDATE public.nba_games SET game_time=now()-interval '1 minute' WHERE id=f.game;
  INSERT INTO public.lineup_player_pins VALUES(f.league,f.season,f.member,f.b,f.day,'bench');
  PERFORM private.assert_lineup_player_pins(f.league,f.season,f.member,f.day,jsonb_build_array(jsonb_build_object('player_id',f.b,'slot_type','PG')));
  PERFORM pg_temp.pin_check(true,'pin guard preserves locked starter');
  DELETE FROM public.lineup_player_pins WHERE member_id=f.member AND game_date=f.day;
  UPDATE public.nba_games SET game_time=now()+interval '3 hours' WHERE id=f.game;
  PERFORM public.set_lineup_player_pin(f.league,f.a,f.day,'bench');
  INSERT INTO public.lineup_player_pins VALUES(f.league,f.season,f.member,f.a,f.day-1,'start');
  UPDATE public.players SET injury_status='IR' WHERE id=f.a;
  UPDATE public.roster_players SET is_on_ir=true WHERE player_id=f.a AND league_id=f.league;
  PERFORM pg_temp.pin_check((SELECT count(*)=1 AND min(game_date)=f.day-1 FROM public.lineup_player_pins WHERE player_id=f.a),'IR removes today and future pins, keeps history');
END;
$$;
SET LOCAL ROLE authenticated;
DO $$
DECLARE f record;
BEGIN
  SELECT * INTO f FROM pin_fixture;
  PERFORM pg_temp.pin_error(format('SELECT public.set_lineup_player_pin(%L,%L,%L,%L)',f.league,f.a,f.day,'start'),'P0001','Activate');
  PERFORM pg_temp.pin_check(true,'IR pin rejected');
END;
$$;
RESET ROLE;
DO $$
DECLARE f record;
BEGIN
  SELECT * INTO f FROM pin_fixture;
  UPDATE public.players SET injury_status=NULL WHERE id=f.a;
  UPDATE public.roster_players SET is_on_ir=false WHERE player_id=f.a AND league_id=f.league;
  PERFORM public.set_lineup_player_pin(f.league,f.a,f.day,'start');
  PERFORM public.set_lineup_player_pin(f.league,f.a,f.day+1,'start');
  UPDATE public.leagues SET taxi_slots=2 WHERE id=f.league;
  UPDATE public.players SET years_exp=0,career_regular_season_games=0 WHERE id=f.a;
  INSERT INTO private.taxi_acquisition_context VALUES(pg_current_xact_id(),f.league,f.season,f.member,f.a,'draft',gen_random_uuid());
  UPDATE public.roster_players SET is_on_taxi=true WHERE player_id=f.a AND league_id=f.league;
  PERFORM pg_temp.pin_check((SELECT count(*)=1 AND min(game_date)=f.day-1 FROM public.lineup_player_pins WHERE player_id=f.a),'Taxi removes today and future pins');
END;
$$;
SET LOCAL ROLE authenticated;
DO $$
DECLARE f record;
BEGIN
  SELECT * INTO f FROM pin_fixture;
  PERFORM pg_temp.pin_error(format('SELECT public.set_lineup_player_pin(%L,%L,%L,%L)',f.league,f.a,f.day,'start'),'P0001','Activate');
  PERFORM pg_temp.pin_check(true,'Taxi pin rejected');
END;
$$;
RESET ROLE;
DO $$
DECLARE f record;
BEGIN
  SELECT * INTO f FROM pin_fixture;
  UPDATE public.roster_players SET is_on_taxi=false WHERE player_id=f.a AND league_id=f.league;
  PERFORM public.set_lineup_player_pin(f.league,f.a,f.day,'start');
  DELETE FROM public.roster_players WHERE player_id=f.a AND league_id=f.league;
  PERFORM pg_temp.pin_check((SELECT count(*)=0 FROM public.lineup_player_pins WHERE player_id=f.a),'roster removal deletes all pins');
  PERFORM public.set_lineup_player_pin(f.league,f.b,f.day+1,'start');
  UPDATE public.roster_players SET member_id=f.other_member WHERE player_id=f.b AND league_id=f.league;
  PERFORM pg_temp.pin_check((SELECT count(*)=0 FROM public.lineup_player_pins WHERE player_id=f.b),'roster transfer deletes pins');
END;
$$;
SELECT count(*) AS passed_lineup_pin_checks FROM pin_checks;
ROLLBACK;
