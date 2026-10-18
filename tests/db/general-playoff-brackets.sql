BEGIN;
SET LOCAL statement_timeout='90s';
SET LOCAL lock_timeout='5s';
CREATE TEMP TABLE bracket_checks(label text PRIMARY KEY);
CREATE FUNCTION pg_temp.check_bracket(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF;
  INSERT INTO bracket_checks VALUES(label);
END;
$$;
CREATE FUNCTION pg_temp.reject_bracket(command text,expected text,label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE message text;
BEGIN
  BEGIN EXECUTE command; EXCEPTION WHEN OTHERS THEN message:=SQLERRM; END;
  PERFORM pg_temp.check_bracket(message ~ expected,label||COALESCE(' ['||message||']',' [unexpected success]'));
END;
$$;
DO $$
DECLARE
  league uuid; season uuid; users uuid[]; members uuid[]; seeds uuid[]; expected_seeds uuid[];
  entrants int; teams int; case_number int:=0; rounds int[]; depth int; span int; year int;
  seed_order int[]; slots uuid[]; next_slots uuid[]; position int; round_number int; index int;
  start_week int; end_week int; result jsonb; payload jsonb; token jsonb; winner uuid;
  fixture record; matchup record; frozen uuid; original_winner uuid; expected_games int;
BEGIN
  FOR fixture IN SELECT * FROM (VALUES
    (4,4,ARRAY[2,2]),(6,6,ARRAY[1,1,2]),(10,10,ARRAY[1,2,1,2]),
    (12,12,ARRAY[2,1,2,1]),(16,16,ARRAY[1,1,1,1]),
    (24,25,ARRAY[1,2,1,2,3]),(2,2,ARRAY[1]),(33,33,ARRAY[1,1,1,1,1,2])
  ) cases(entrants,teams,lengths) LOOP
    case_number:=case_number+1;
    entrants:=fixture.entrants; teams:=fixture.teams; rounds:=fixture.lengths;
    depth:=cardinality(rounds); span:=power(2,depth)::int; year:=9200+case_number;
    league:=gen_random_uuid(); season:=gen_random_uuid(); users:='{}'; members:='{}';
    FOR index IN 1..teams LOOP
      users:=array_append(users,gen_random_uuid()); members:=array_append(members,gen_random_uuid());
      INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      VALUES(users[index],'authenticated','authenticated',users[index]||'@example.test','x',now(),'{}','{}',now(),now());
    END LOOP;
    INSERT INTO leagues(id,name,slug,commissioner_id,status,team_limit,playoff_start_week)
    VALUES(league,'General bracket fixture',league::text,users[1],'setup',teams,6);
    INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(season,league,year,true);
    FOR index IN 1..teams LOOP
      INSERT INTO league_members(id,league_id,user_id,role,team_name)
      VALUES(members[index],league,users[index],CASE WHEN index=1 THEN 'commissioner' ELSE 'manager' END::league_member_role,'Seed '||index);
    END LOOP;
    INSERT INTO season_weeks(season_year,week_number,week_start,week_end)
    SELECT year,w,date '2026-10-20'+CASE WHEN w=1 THEN 0 ELSE 6+(w-2)*7 END,
      date '2026-10-25'+(w-1)*7 FROM generate_series(1,30) w;
    PERFORM set_config('request.jwt.claim.sub',users[1]::text,true);
    PERFORM update_league_settings_atomic(league,jsonb_build_object('team_limit',teams+1));
    PERFORM update_league_settings_atomic(league,jsonb_build_object('playoff_entrants',entrants,'playoff_round_lengths',rounds,'skipped_weeks',ARRAY[1]));
    PERFORM pg_temp.check_bracket((SELECT team_limit=teams+1 AND playoff_start_week=6 FROM leagues WHERE id=league),'settings accept league size and preserve start: '||teams);
    IF case_number=1 THEN
      PERFORM pg_temp.reject_bracket(format('SELECT update_league_settings_atomic(%L,%L)',league,'{"playoff_entrants":1}'),'at least 2','entrants below two rejected');
      PERFORM pg_temp.reject_bracket(format('SELECT update_league_settings_atomic(%L,%L)',league,'{"playoff_entrants":5,"playoff_round_lengths":[1,1,1]}'),'exceed league teams','entrants above actual teams rejected');
      PERFORM pg_temp.reject_bracket(format('SELECT update_league_settings_atomic(%L,%L)',league,'{"playoff_round_lengths":[1]}'),'need 2 rounds','wrong elimination depth rejected');
      PERFORM pg_temp.reject_bracket(format('SELECT update_league_settings_atomic(%L,%L)',league,'{"playoff_round_lengths":[0,1]}'),'positive whole weeks','zero round length rejected');
      PERFORM pg_temp.reject_bracket(format('SELECT update_league_settings_atomic(%L,%L)',league,'{"playoff_round_lengths":[-1,1]}'),'positive whole weeks','negative round length rejected');
      PERFORM pg_temp.reject_bracket(format('SELECT update_league_settings_atomic(%L,%L)',league,'{"playoff_start_week":29,"playoff_round_lengths":[2,2]}'),'finish by week 30','regular season and skipped calendar time plus playoffs overflow rejected');
    END IF;
    result:=replace_regular_season_matchups_atomic(league,season,false,private.regular_season_matchup_payload(league,season,5));
    PERFORM pg_temp.check_bracket((result->>'inserted')::int=(teams/2)*4
      AND NOT EXISTS(SELECT 1 FROM matchups WHERE league_season_id=season AND week_number=1),'skipped regular week excluded: '||entrants);
    IF teams%2=1 THEN
      PERFORM pg_temp.check_bracket((SELECT count(*)=4 FROM (SELECT week_number FROM matchups WHERE league_season_id=season GROUP BY week_number HAVING count(*)=teams/2) weeks)
        AND (SELECT count(*)=4 FROM league_members member WHERE member.league_id=league AND (SELECT count(*) FROM matchups
          WHERE league_season_id=season AND member.id IN(home_member_id,away_member_id))=3),'odd team byes are distinct across played weeks: '||teams);
    END IF;
    UPDATE matchups SET is_finalized=true,winner_member_id=CASE WHEN array_position(members,home_member_id)<array_position(members,away_member_id) THEN home_member_id ELSE away_member_id END,
      home_points=(teams-array_position(members,home_member_id))*10+1,away_points=(teams-array_position(members,away_member_id))*10+1,
      finalized_at=now()-interval '3 days' WHERE league_season_id=season;
    PERFORM private.rebuild_regular_standings(league,season);
    IF teams%2=1 THEN
      PERFORM pg_temp.check_bracket((SELECT sum(wins+losses+ties)=teams/2*8 AND sum(ties)=0 FROM standings WHERE league_season_id=season AND week_number=5),'odd byes never add records or ties: '||teams);
    END IF;
    SELECT array_agg(records.member_id ORDER BY records.wins DESC,records.points_for DESC) INTO expected_seeds FROM (
      SELECT member.id AS member_id,count(match.id) FILTER (WHERE match.winner_member_id=member.id) AS wins,
        sum(CASE WHEN match.home_member_id=member.id THEN match.home_points ELSE match.away_points END) AS points_for
      FROM league_members member JOIN matchups match ON match.league_season_id=season AND member.id IN(match.home_member_id,match.away_member_id)
      WHERE member.league_id=league GROUP BY member.id
    ) records;
    IF case_number=1 THEN
      DELETE FROM season_weeks WHERE season_year=year AND week_number=3;
      PERFORM pg_temp.reject_bracket(format('SELECT generate_playoff_bracket_atomic(%L)',league),'missing week','explicit bracket rejects a missing regular season calendar week');
      INSERT INTO season_weeks(season_year,week_number,week_start,week_end)
        VALUES(year,3,date '2026-10-20'+13,date '2026-10-25'+14);
    END IF;
    result:=generate_playoff_bracket_atomic(league);
    SELECT playoff_bracket_seed_ids INTO seeds FROM league_seasons WHERE id=season;
    PERFORM pg_temp.check_bracket(seeds=expected_seeds[1:entrants],'seed order follows saved records: '||entrants);
    seed_order:=CASE span
      WHEN 2 THEN ARRAY[1,2]
      WHEN 4 THEN ARRAY[1,4,2,3]
      WHEN 8 THEN ARRAY[1,8,4,5,2,7,3,6]
      WHEN 16 THEN ARRAY[1,16,8,9,4,13,5,12,2,15,7,10,3,14,6,11]
      WHEN 32 THEN ARRAY[1,32,16,17,8,25,9,24,4,29,13,20,5,28,12,21,2,31,15,18,7,26,10,23,3,30,14,19,6,27,11,22]
      WHEN 64 THEN ARRAY[1,64,32,33,16,49,17,48,8,57,25,40,9,56,24,41,4,61,29,36,13,52,20,45,5,60,28,37,12,53,21,44,2,63,31,34,15,50,18,47,7,58,26,39,10,55,23,42,3,62,30,35,14,51,19,46,6,59,27,38,11,54,22,43]
    END;
    slots:=array_fill(NULL::uuid,ARRAY[span]);
    FOR index IN 1..span LOOP IF seed_order[index]<=entrants THEN slots[index]:=seeds[seed_order[index]]; END IF; END LOOP;
    PERFORM pg_temp.check_bracket(NOT EXISTS(SELECT 1 FROM matchups WHERE league_season_id=season AND playoff_round=1
      AND (array_position(seeds,home_member_id)<=span-entrants OR array_position(seeds,away_member_id)<=span-entrants)),
      'only top seeds receive first round byes: '||entrants);
    start_week:=6;
    FOR round_number IN 1..depth LOOP
      expected_games:=0;
      FOR position IN 1..cardinality(slots)/2 LOOP
        IF slots[position*2-1] IS NOT NULL AND slots[position*2] IS NOT NULL THEN expected_games:=expected_games+1; END IF;
      END LOOP;
      end_week:=start_week+rounds[round_number]-1;
      PERFORM pg_temp.check_bracket((SELECT count(*)=expected_games AND bool_and(week_number=start_week AND end_week_number=end_week)
        FROM matchups WHERE league_season_id=season AND playoff_round=round_number),'exact match count and asymmetric window: '||entrants||' round '||round_number);
      FOR matchup IN SELECT * FROM matchups WHERE league_season_id=season AND playoff_round=round_number LOOP
        PERFORM pg_temp.check_bracket(matchup.home_member_id=slots[matchup.playoff_position*2-1] AND matchup.away_member_id=slots[matchup.playoff_position*2],
          'standard seeded branch pairing: '||entrants||' round '||round_number||' position '||matchup.playoff_position);
      END LOOP;
      IF round_number<depth THEN
        PERFORM pg_temp.reject_bracket(format('SELECT advance_playoff_bracket_atomic(%L)',league),'not yet finalized','undecided round cannot advance: '||entrants||' round '||round_number);
      END IF;
      token:=capture_score_inputs(season,start_week);
      SELECT jsonb_agg(jsonb_build_object('id',id,'winner_member_id',CASE WHEN playoff_position%2=1 THEN away_member_id ELSE home_member_id END,
        'home_points',CASE WHEN playoff_position%2=1 THEN 10 ELSE 20 END,'away_points',CASE WHEN playoff_position%2=1 THEN 20 ELSE 10 END,'home_max_possible_points',30,'away_max_possible_points',40,'input_token',token)) INTO payload
        FROM matchups WHERE league_season_id=season AND playoff_round=round_number;
      PERFORM finalize_score_week_atomic(league,season,start_week,payload,'[]',now()-interval '3 days',now()-interval '3 days');
      next_slots:='{}';
      FOR position IN 1..cardinality(slots)/2 LOOP
        IF slots[position*2-1] IS NULL OR slots[position*2] IS NULL THEN winner:=COALESCE(slots[position*2-1],slots[position*2]);
        ELSE winner:=CASE WHEN position%2=1 THEN slots[position*2] ELSE slots[position*2-1] END; END IF;
        next_slots:=array_append(next_slots,winner);
      END LOOP;
      IF round_number<depth THEN
        result:=apply_season_boundary_after_grace(league,season,'advance',now());
        PERFORM pg_temp.check_bracket((result->>'applied')::boolean,'automatic boundary advances latest numbered round: '||entrants||' round '||round_number);
        SELECT id,winner_member_id INTO frozen,original_winner FROM matchups WHERE league_season_id=season AND playoff_round=round_number ORDER BY playoff_position LIMIT 1;
        token:=capture_score_inputs(season,start_week);
        SELECT jsonb_build_array(jsonb_build_object('id',id,'winner_member_id',CASE WHEN winner_member_id=home_member_id THEN away_member_id ELSE home_member_id END,
          'home_points',999,'away_points',0,'input_token',token)) INTO payload FROM matchups WHERE id=frozen;
        PERFORM finalize_score_week_atomic(league,season,start_week,payload,'[]');
        PERFORM pg_temp.check_bracket((SELECT winner_member_id=original_winner FROM matchups WHERE id=frozen),'consumed numbered round stays frozen: '||entrants||' round '||round_number);
      ELSE
        PERFORM pg_temp.check_bracket((SELECT count(*)=1 AND bool_and(matchup_type='playoff_final' AND winner_member_id=next_slots[1]) FROM matchups
          WHERE league_season_id=season AND playoff_round=round_number),'final completes with the winning branch: '||entrants);
      END IF;
      slots:=next_slots; start_week:=end_week+1;
    END LOOP;
    PERFORM pg_temp.check_bracket((generate_playoff_bracket_atomic(league)->>'skipped')::boolean AND (advance_playoff_bracket_atomic(league)->>'skipped')::boolean,'completed bracket RPC retries are idempotent: '||entrants);
  END LOOP;
  league:=gen_random_uuid(); season:=gen_random_uuid();
  INSERT INTO leagues(id,name,slug,commissioner_id,status,playoff_start_week)
    VALUES(league,'Legacy null bracket',league::text,users[1],'setup',1);
  INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(season,league,year,true);
  FOR index IN 1..10 LOOP
    INSERT INTO league_members(league_id,user_id,role,team_name)
      VALUES(league,users[index],CASE WHEN index=1 THEN 'commissioner' ELSE 'manager' END::league_member_role,'Legacy '||index);
  END LOOP;
  result:=generate_playoff_bracket_atomic(league);
  PERFORM pg_temp.check_bracket((result->>'inserted')::int=2 AND (SELECT playoff_entrants IS NULL AND playoff_round_lengths IS NULL AND team_limit=10 FROM leagues WHERE id=league)
    AND (SELECT cardinality(playoff_seed_member_ids)=6 AND playoff_round_weeks=ARRAY[1,1,1] FROM league_seasons WHERE id=season)
    AND NOT EXISTS(SELECT 1 FROM matchups WHERE league_season_id=season AND playoff_round IS NOT NULL),'legacy null settings generate the original six entrant bracket');
  UPDATE matchups SET is_finalized=true,winner_member_id=home_member_id WHERE league_season_id=season;
  PERFORM advance_playoff_bracket_atomic(league);
  PERFORM pg_temp.check_bracket((SELECT count(*)=2 AND bool_and(week_number=2 AND end_week_number=2) FROM matchups WHERE league_season_id=season AND matchup_type='playoff_semifinal'),'legacy semifinal advancement stays unchanged');
  UPDATE matchups SET is_finalized=true,winner_member_id=home_member_id WHERE league_season_id=season;
  PERFORM advance_playoff_bracket_atomic(league);
  PERFORM pg_temp.check_bracket(EXISTS(SELECT 1 FROM matchups WHERE league_season_id=season AND matchup_type='playoff_final' AND week_number=3 AND end_week_number=3),'legacy final advancement stays unchanged');
END;
$$;
SELECT count(*) AS passed_checks FROM bracket_checks;
ROLLBACK;
