BEGIN;
SELECT gen_random_uuid() AS owner_id,gen_random_uuid() AS outsider_id,gen_random_uuid() AS removed_id,
  gen_random_uuid() AS league_id,gen_random_uuid() AS season_id,gen_random_uuid() AS member_id,
  gen_random_uuid() AS removed_member,gen_random_uuid() AS player_id,gen_random_uuid() AS game_id,
  gen_random_uuid() AS stat_id \gset
INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data)
VALUES(:'owner_id','authenticated','authenticated',:'owner_id'||'@example.test','{}'),
(:'outsider_id','authenticated','authenticated',:'outsider_id'||'@example.test','{}'),
(:'removed_id','authenticated','authenticated',:'removed_id'||'@example.test','{}');
INSERT INTO public.leagues(id,name,slug,commissioner_id,status,roster_size,scoring_settings)
VALUES(:'league_id','Access regression',:'league_id',:'owner_id','active',0,'{"points":2}');
INSERT INTO public.league_members(id,league_id,user_id,role)
VALUES(:'member_id',:'league_id',:'owner_id','commissioner'),
(:'removed_member',:'league_id',:'removed_id','manager');
INSERT INTO public.league_seasons(id,league_id,season_year,is_current) VALUES(:'season_id',:'league_id',2187,true);
INSERT INTO public.players(id,first_name,last_name,position,eligible_positions)
VALUES(:'player_id','Access','Regression','PG',ARRAY['PG']);
INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
VALUES(:'league_id',:'season_id',:'member_id',:'player_id','draft');
INSERT INTO public.league_player_taxi_exits(league_id,player_id) VALUES(:'league_id',:'player_id');
INSERT INTO public.league_member_taxi_exits(league_id,member_id,player_id) VALUES(:'league_id',:'member_id',:'player_id');
INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
VALUES(:'game_id','002access-'||:'game_id',2187,1,current_date,'BOS','LAL','Final');
INSERT INTO public.player_game_stats(id,player_id,game_id,season_year,week_number,points,did_not_play)
VALUES(:'stat_id',:'player_id',:'game_id',2187,1,20,false);
CREATE FUNCTION pg_temp.expect_error(p_sql text,p_state text,p_pattern text DEFAULT '%') RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE=p_state AND SQLERRM LIKE p_pattern THEN RETURN; END IF;
    RAISE;
  END;
  RAISE EXCEPTION 'Expected % for %',p_state,p_sql;
END $$;
CREATE FUNCTION pg_temp.check_taxi_reads(p_league uuid,p_expected int) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM public.league_player_taxi_exits WHERE league_id=p_league)<>p_expected
     OR (SELECT count(*) FROM public.league_member_taxi_exits WHERE league_id=p_league)<>p_expected THEN
    RAISE EXCEPTION 'Taxi history access differs from expected %',p_expected;
  END IF;
END $$;
SELECT format('SELECT public.auto_set_lineup_atomic(%L,%L,%L,(now() AT TIME ZONE ''America/New_York'')::date,''[]'')',
  :'member_id',:'league_id',:'season_id') AS auto_call,
  format('SELECT public.set_player_slot_moves_atomic(%L,%L,%L,(now() AT TIME ZONE ''America/New_York'')::date,1,''[]'')',
  :'member_id',:'league_id',:'season_id') AS move_call \gset
SELECT set_config('request.jwt.claim.sub',:'outsider_id',true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.expect_error('SELECT public.place_auction_bid_atomic(NULL,NULL,NULL,1,NULL,false)','42501');
SELECT pg_temp.expect_error('SELECT private.is_ir_designation(NULL)','42501');
SELECT pg_temp.expect_error(:'auto_call','42501');
SELECT pg_temp.expect_error(:'move_call','42501');
SELECT pg_temp.check_taxi_reads(:'league_id',0);
SELECT pg_temp.expect_error(format('INSERT INTO public.league_player_taxi_exits(league_id,player_id) VALUES(%L,%L)',:'league_id',:'player_id'),'42501');
DO $$ BEGIN
  IF has_schema_privilege(current_user,'analytics','USAGE') THEN
    RAISE EXCEPTION 'Authenticated users can access the analytics schema';
  END IF;
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claim.sub',:'owner_id',true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.expect_error('SELECT public.place_auction_bid_atomic(NULL,NULL,NULL,1,NULL,false)','42501');
SELECT pg_temp.expect_error('SELECT private.is_ir_designation(NULL)','42501');
SELECT pg_temp.check_taxi_reads(:'league_id',1);
SELECT pg_temp.expect_error(:'auto_call','P0001','Roster is over%');
SELECT pg_temp.expect_error(:'move_call','P0001','Roster is over%');
SELECT pg_temp.expect_error(format('DELETE FROM public.league_member_taxi_exits WHERE league_id=%L',:'league_id'),'42501');
RESET ROLE;
UPDATE public.leagues SET roster_size=1 WHERE id=:'league_id';
SET LOCAL ROLE authenticated;
SELECT pg_temp.expect_error('SELECT public.place_auction_bid_atomic(NULL,NULL,NULL,1,NULL,false)','42501');
SELECT pg_temp.expect_error('SELECT private.is_ir_designation(NULL)','42501');
SELECT public.auto_set_lineup_atomic(:'member_id',:'league_id',:'season_id',(now() AT TIME ZONE 'America/New_York')::date,'[]');
SELECT public.set_player_slot_moves_atomic(:'member_id',:'league_id',:'season_id',(now() AT TIME ZONE 'America/New_York')::date,1,'[]');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub',:'removed_id',true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.expect_error('SELECT public.place_auction_bid_atomic(NULL,NULL,NULL,1,NULL,false)','42501');
SELECT pg_temp.expect_error('SELECT private.is_ir_designation(NULL)','42501');
SELECT pg_temp.check_taxi_reads(:'league_id',1);
RESET ROLE;
DELETE FROM public.league_members WHERE id=:'removed_member';
SET LOCAL ROLE authenticated;
SELECT pg_temp.expect_error('SELECT public.place_auction_bid_atomic(NULL,NULL,NULL,1,NULL,false)','42501');
SELECT pg_temp.expect_error('SELECT private.is_ir_designation(NULL)','42501');
SELECT pg_temp.check_taxi_reads(:'league_id',0);
SELECT pg_temp.expect_error(:'auto_call','42501');
SELECT pg_temp.expect_error(:'move_call','42501');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub','',true);
SET LOCAL ROLE anon;
SELECT pg_temp.expect_error('SELECT public.place_auction_bid_atomic(NULL,NULL,NULL,1,NULL,false)','42501');
SELECT pg_temp.expect_error('SELECT private.is_ir_designation(NULL)','42501');
SELECT pg_temp.expect_error('SELECT * FROM public.league_player_taxi_exits','42501');
SELECT pg_temp.expect_error('SELECT * FROM public.league_member_taxi_exits','42501');
SELECT pg_temp.expect_error(:'auto_call','42501');
SELECT pg_temp.expect_error(:'move_call','42501');
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT pg_temp.expect_error('SELECT private.is_ir_designation(NULL)','42501');
SELECT pg_temp.check_taxi_reads(:'league_id',1);
SELECT pg_temp.expect_error(:'auto_call','42501');
SELECT pg_temp.expect_error(:'move_call','42501');
RESET ROLE;
CREATE TEMP TABLE leagues AS SELECT * FROM public.leagues WHERE id=:'league_id';
UPDATE pg_temp.leagues SET scoring_settings='{"points":999}';
CREATE TEMP TABLE player_game_stats AS SELECT * FROM public.player_game_stats WHERE id=:'stat_id';
GRANT SELECT ON pg_temp.leagues,pg_temp.player_game_stats TO authenticated;
SELECT set_config('request.jwt.claim.sub',:'owner_id',true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.expect_error('SELECT public.place_auction_bid_atomic(NULL,NULL,NULL,1,NULL,false)','42501');
SELECT pg_temp.expect_error('SELECT private.is_ir_designation(NULL)','42501');
SET LOCAL search_path = pg_temp,public;
SELECT set_config('test.stat',:'stat_id',true),set_config('test.league',:'league_id',true);
DO $$ BEGIN
  IF public.compute_fantasy_points(current_setting('test.stat')::uuid,current_setting('test.league')::uuid) <> 40 THEN
    RAISE EXCEPTION 'Caller search path changes canonical scoring';
  END IF;
END $$;
RESET ROLE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname IN ('public','private') AND p.prokind='f'
      AND NOT EXISTS(SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%')) THEN
    RAISE EXCEPTION 'Application functions retain a mutable search path';
  END IF;
END $$;
ROLLBACK;
