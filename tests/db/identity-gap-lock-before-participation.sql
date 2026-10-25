BEGIN;
DO $$
DECLARE
  v_user uuid := gen_random_uuid();
  v_league uuid := gen_random_uuid();
  v_season uuid := gen_random_uuid();
  v_member uuid := gen_random_uuid();
  v_player uuid := gen_random_uuid();
  v_game uuid := gen_random_uuid();
  v_day date := (now() AT TIME ZONE 'America/New_York')::date;
  v_locked boolean := false;
  v_person text := 'membership-' || v_player::text;
BEGIN
  INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  VALUES(v_user,'authenticated','authenticated',v_user||'@example.test','x',now(),'{}','{}',now(),now());
  INSERT INTO leagues(id,name,slug,commissioner_id,status,roster_size)
  VALUES(v_league,'Synthetic stale team before participation',v_league::text,v_user,'active',2);
  INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(v_member,v_league,v_user,'commissioner','Team');
  INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(v_season,v_league,2198,true);
  INSERT INTO season_weeks(season_year,week_number,week_start,week_end) VALUES(2198,1,v_day-3,v_day+3);
  INSERT INTO players(id,first_name,last_name,nba_id,nba_team,position,eligible_positions)
  VALUES(v_player,'Luka','Dončić',v_person,'DAL','PG',ARRAY['PG']);
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via,acquired_at)
  VALUES(v_league,v_season,v_member,v_player,'draft',now()-interval '1 day');
  INSERT INTO weekly_lineups(league_id,league_season_id,member_id,player_id,game_date,week_number,slot_type)
  VALUES(v_league,v_season,v_member,v_player,v_day,1,'PG');
  INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_time)
  VALUES(gen_random_uuid(),'gap-old-'||v_player::text,2198,1,v_day,'DAL','SAC','Scheduled',now()+interval '2 hours'),
    (v_game,'gap-new-'||v_player::text,2198,1,v_day,'LAL','UTA','InProgress',now()-interval '1 hour');
  PERFORM resolve_player_imports_atomic('nba_cdn',jsonb_build_array(jsonb_build_object(
    'provider_id',v_person,'display_name','Luka Dončić','nba_game_id','gap-new-'||v_player::text)));
  IF EXISTS(SELECT FROM player_game_stats WHERE player_id=v_player) THEN
    RAISE EXCEPTION 'Membership creates participation stats';
  END IF;
  IF (SELECT nba_team FROM players WHERE id=v_player) IS DISTINCT FROM 'DAL' THEN
    RAISE EXCEPTION 'Membership rewrites the current team';
  END IF;
  PERFORM set_config('request.jwt.claim.sub',v_user::text,true);
  BEGIN
    PERFORM set_player_slot_atomic(v_member,v_league,v_season,v_player,v_day,'BE',1);
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'Lineup changes are locked%' THEN RAISE; END IF;
    v_locked := true;
  END;
  IF NOT v_locked THEN
    RAISE EXCEPTION 'REPRODUCED: stale team permits benching after new-team tipoff before participation arrives';
  END IF;
  SET LOCAL ROLE authenticated;
  v_locked := false;
  BEGIN
    PERFORM set_player_slot_atomic(v_member,v_league,v_season,v_player,v_day,'BE',1);
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'Lineup changes are locked%' THEN RAISE; END IF;
    v_locked := true;
  END;
  IF NOT v_locked THEN RAISE EXCEPTION 'Authenticated lineup moves ignore membership'; END IF;
  BEGIN
    INSERT INTO private.player_game_memberships(player_id,game_id) VALUES(v_player,v_game);
    RAISE EXCEPTION 'Authenticated clients can write membership';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;
  BEGIN
    PERFORM resolve_player_imports_atomic('nba_cdn',jsonb_build_array(jsonb_build_object(
      'provider_id',v_person,'display_name','Luka Dončić','nba_game_id',null)));
    RAISE EXCEPTION 'Null game context was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM resolve_player_imports_atomic('nba_cdn',jsonb_build_array(jsonb_build_object(
      'provider_id',v_person,'display_name','Luka Dončić','nba_game_id','missing-'||v_player::text)));
    RAISE EXCEPTION 'Unknown game context was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM resolve_player_imports_atomic('espn',jsonb_build_array(jsonb_build_object(
      'provider_id',v_person,'first_name','Luka','last_name','Dončić','nba_game_id','gap-new-'||v_player::text)));
    RAISE EXCEPTION 'Non-CDN context was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  UPDATE nba_games SET status='Scheduled',game_time=now()+interval '1 hour' WHERE id=v_game;
  IF private.lineup_game_started(v_player,v_day) OR private.roster_status_game_started(v_player) THEN
    RAISE EXCEPTION 'Membership alone starts a future game';
  END IF;
  IF EXISTS(SELECT FROM player_game_stats WHERE player_id=v_player)
    OR (SELECT status FROM nba_games WHERE id=v_game) <> 'Scheduled' THEN
    RAISE EXCEPTION 'Membership changes played-season state';
  END IF;
  RAISE NOTICE 'PASS SYNTHETIC: first membership locks before stats; source-only writes, game validation and future-game guards hold';
END $$;
ROLLBACK;
