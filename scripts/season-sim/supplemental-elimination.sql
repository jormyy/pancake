SET LOCAL statement_timeout='60s';
DO $test$
DECLARE
  yr int;
  league uuid;
  season uuid;
  users uuid[];
  members uuid[];
  index int;
  result jsonb;
  token jsonb;
  payload jsonb;
  frozen jsonb;
  after_points jsonb;
  losers uuid[];
  game uuid;
  player uuid;
  future_day date;
  changed int;
BEGIN
  FOR yr IN SELECT DISTINCT season_year FROM supp_calendar ORDER BY season_year LOOP
    INSERT INTO season_weeks(season_year,week_number,week_start,week_end)
      SELECT season_year,week_number,week_start,week_end FROM supp_calendar WHERE season_year=yr
      ON CONFLICT(season_year,week_number) DO UPDATE SET week_start=excluded.week_start,week_end=excluded.week_end;
    league:=gen_random_uuid();season:=gen_random_uuid();users:='{}';members:='{}';
    FOR index IN 1..6 LOOP
      users:=array_append(users,gen_random_uuid());members:=array_append(members,gen_random_uuid());
      INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
        VALUES(users[index],'authenticated','authenticated',users[index]::text||'@example.test','x',now(),'{}','{}',now(),now());
    END LOOP;
    INSERT INTO leagues(id,name,slug,commissioner_id,status,playoff_start_week,playoff_entrants,playoff_round_lengths)
      VALUES(league,'Synthetic eliminated-team publication',league::text,users[1],'setup',22,6,ARRAY[1,1,1]);
    INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(season,league,yr,true);
    FOR index IN 1..6 LOOP
      INSERT INTO league_members(id,league_id,user_id,role,team_name)
        VALUES(members[index],league,users[index],CASE WHEN index=1 THEN 'commissioner' ELSE 'manager' END::league_member_role,'Synthetic team '||index);
    END LOOP;
    FOR index IN 1..3 LOOP
      INSERT INTO matchups(league_id,league_season_id,week_number,home_member_id,away_member_id,home_points,away_points,
        home_max_possible_points,away_max_possible_points,winner_member_id,is_finalized,finalized_at)
      SELECT league,season,w,members[index*2-1],members[index*2],100-index*2+1,10-index*2,
        100-index*2+1,10-index*2,members[index*2-1],true,now()-interval '3 days' FROM generate_series(1,21) w;
    END LOOP;
    PERFORM private.rebuild_regular_standings(league,season);
    result:=generate_playoff_bracket_atomic(league);
    IF (result->>'inserted')::int<>2 THEN RAISE EXCEPTION 'Six entrants require two games and two byes'; END IF;
    IF (SELECT playoff_bracket_seed_ids FROM league_seasons WHERE id=season) IS DISTINCT FROM ARRAY[members[1],members[3],members[5],members[2],members[4],members[6]] THEN
      RAISE EXCEPTION 'Seeds disagree with independent fixture wins and points';
    END IF;
    IF EXISTS(SELECT 1 FROM matchups WHERE league_season_id=season AND playoff_round=1 AND (home_member_id=ANY(ARRAY[members[1],members[3]]) OR away_member_id=ANY(ARRAY[members[1],members[3]]))) THEN
      RAISE EXCEPTION 'The highest two seeds must receive byes';
    END IF;
    token:=capture_score_inputs(season,22);
    SELECT jsonb_agg(jsonb_build_object('id',id,'home_points',20,'away_points',10,'home_max_possible_points',20,'away_max_possible_points',10,'winner_member_id',home_member_id,'input_token',token))
      INTO payload FROM matchups WHERE league_season_id=season AND playoff_round=1;
    PERFORM finalize_score_week_atomic(league,season,22,payload,'[]',now()-interval '3 days',now()-interval '3 days');
    result:=apply_season_boundary_after_grace(league,season,'advance',now());
    IF NOT (result->>'applied')::boolean THEN RAISE EXCEPTION 'The guarded boundary must advance the consumed round'; END IF;
    SELECT array_agg(away_member_id),jsonb_agg(jsonb_build_object('id',id,'home_points',home_points,'away_points',away_points,'winner',winner_member_id) ORDER BY id)
      INTO losers,frozen FROM matchups WHERE league_season_id=season AND playoff_round=1;
    IF EXISTS(SELECT 1 FROM matchups WHERE league_season_id=season AND playoff_round>1 AND (home_member_id=ANY(losers) OR away_member_id=ANY(losers))) THEN
      RAISE EXCEPTION 'An eliminated member receives a later matchup';
    END IF;
    SELECT week_start INTO future_day FROM supp_calendar WHERE season_year=yr AND week_number=23;
    game:=gen_random_uuid();player:=gen_random_uuid();
    INSERT INTO players(id,first_name,last_name,position,eligible_positions,nba_team) VALUES(player,'Synthetic','Eliminated player','PG',ARRAY['PG'],'SYN');
    INSERT INTO roster_players(player_id,league_id,league_season_id,member_id,acquired_via,acquired_at)
      VALUES(player,league,season,losers[1],'draft',future_day-interval '1 day');
    INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status,stats_synced_at)
      VALUES(game,'002'||right((yr-1)::text,2)||'09999',yr,23,future_day,future_day+time '20:00','SYN','TST','Final',now());
    INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,game_date,points,did_not_play)
      VALUES(player,game,yr,23,future_day,99999,false);
    INSERT INTO weekly_lineups(player_id,league_id,league_season_id,member_id,week_number,game_date,slot_type,is_auto_set)
      VALUES(player,league,season,losers[1],23,future_day,'PG',true);
    token:=capture_score_inputs(season,22);
    SELECT jsonb_agg(jsonb_build_object('id',id,'home_points',99999,'away_points',99999,'home_max_possible_points',99999,'away_max_possible_points',99999,'winner_member_id',away_member_id,'input_token',token))
      INTO payload FROM matchups WHERE league_season_id=season AND playoff_round=1;
    changed:=update_score_points_atomic(league,season,22,payload);
    IF changed<>0 THEN RAISE EXCEPTION 'A consumed matchup accepts later points'; END IF;
    PERFORM finalize_score_week_atomic(league,season,22,payload,'[]');
    SELECT jsonb_agg(jsonb_build_object('id',id,'home_points',home_points,'away_points',away_points,'winner',winner_member_id) ORDER BY id)
      INTO after_points FROM matchups WHERE league_season_id=season AND playoff_round=1;
    IF after_points IS DISTINCT FROM frozen THEN RAISE EXCEPTION 'An eliminated result accrues future points or changes winner'; END IF;
    IF (SELECT points FROM player_game_stats WHERE player_id=player AND game_id=game)<>99999 THEN RAISE EXCEPTION 'The future source input must remain present'; END IF;
    RAISE NOTICE 'PASS eliminated %: two real-calendar byes; future 99999-point input; zero publication changes; frozen consumed scores',yr;
  END LOOP;
END;
$test$;
ROLLBACK;
