BEGIN;
SET LOCAL statement_timeout='60s';
SET LOCAL lock_timeout='5s';
CREATE TEMP TABLE dynasty_checks(label text PRIMARY KEY);
CREATE FUNCTION pg_temp.check_dynasty(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF;
  INSERT INTO dynasty_checks VALUES(label);
END;
$$;
CREATE FUNCTION pg_temp.fail_dynasty(command text,expected text,label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE message text;
BEGIN
  BEGIN EXECUTE command; EXCEPTION WHEN OTHERS THEN message:=SQLERRM; END;
  PERFORM pg_temp.check_dynasty(message ~ expected,label||COALESCE(' ['||message||']',' [unexpected success]'));
END;
$$;
DO $$
DECLARE
  users uuid[]:='{}'; members uuid[]:='{}'; league uuid:=gen_random_uuid(); season uuid:=gen_random_uuid();
  user_id uuid; member_id uuid; other_league uuid; other_season uuid; created jsonb;
  expected_order uuid[]; rookie_draft jsonb;
  i int; result jsonb; seeds uuid[]; player_ids uuid[]:='{}'; player uuid; start_week int;
  week_one date:=date '2026-10-20'+7*greatest(0,ceil((((now() AT TIME ZONE 'America/New_York')::date+1)-date '2026-10-20')/7.0)::int);
BEGIN
  FOR i IN 1..10 LOOP
    user_id:=gen_random_uuid(); member_id:=gen_random_uuid();
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(user_id,'authenticated','authenticated',user_id||'@example.test','x',now(),'{}','{}',now(),now());
    users:=array_append(users,user_id); members:=array_append(members,member_id);
    IF i=1 THEN
      INSERT INTO leagues(id,name,slug,commissioner_id,status,playoff_start_week,taxi_slots)
      VALUES(league,'Dynasty rules fixture',league::text,user_id,'setup',18,3);
      INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(season,league,8200,true);
    END IF;
    INSERT INTO league_members(id,league_id,user_id,role,team_name)
    VALUES(member_id,league,user_id,CASE WHEN i=1 THEN 'commissioner' ELSE 'manager' END::league_member_role,'Team '||i);
  END LOOP;
  INSERT INTO season_weeks(season_year,week_number,week_start,week_end)
  SELECT 8200,w,week_one+CASE WHEN w=1 THEN 0 ELSE 6+(w-2)*7 END,
    week_one+5+(w-1)*7 FROM generate_series(1,30) w;
  PERFORM set_config('request.jwt.claim.sub',users[1]::text,true);
  PERFORM pg_temp.check_dynasty((SELECT team_limit=10 AND taxi_rule='rookies_or_64_games' AND taxi_max_seasons IS NULL
    AND NOT allow_inactive_trades AND playoff_entrants IS NULL AND playoff_start_week=18 FROM leagues WHERE id=league),'existing defaults and saved start preserved');
  created:=create_league('New default fixture','New team');
  PERFORM pg_temp.check_dynasty((SELECT playoff_start_week=17 FROM leagues WHERE id=(created->>'id')::uuid),'new league starts playoffs at 17');
  other_league:=(created->>'id')::uuid;
  SELECT id INTO other_season FROM league_seasons WHERE league_id=other_league AND is_current;
  INSERT INTO league_members(league_id,user_id,role,team_name)
  SELECT other_league,users[n],'manager','New default '||n FROM generate_series(2,4) n;
  INSERT INTO season_weeks(season_year,week_number,week_start,week_end)
  SELECT current.season_year,week.week_number,week.week_start,week.week_end FROM league_seasons current
    CROSS JOIN season_weeks week WHERE current.id=other_season AND week.season_year=8200
  ON CONFLICT DO NOTHING;
  result:=replace_regular_season_matchups_atomic(other_league,other_season,false,private.regular_season_matchup_payload(other_league,other_season,16));
  PERFORM pg_temp.check_dynasty((result->>'inserted')::int=32 AND (SELECT min(week_number)=1 AND max(week_number)=16 FROM matchups WHERE league_season_id=other_season),'new league default regular schedule weeks1 through16');
  PERFORM update_league_settings_atomic(league,'{"taxi_rule":"rookies_or_64_games","taxi_max_seasons":2,"allow_inactive_trades":true,"playoff_entrants":4,"playoff_round_lengths":[2,2],"skipped_weeks":[1]}');
  PERFORM pg_temp.check_dynasty((SELECT playoff_start_week=18 FROM leagues WHERE id=league),'unspecified playoff start stays 18');
  result:=replace_regular_season_matchups_atomic(league,season,false,private.regular_season_matchup_payload(league,season,17));
  PERFORM pg_temp.check_dynasty((result->>'inserted')::int=80 AND (SELECT min(week_number)=2 AND max(week_number)=17 FROM matchups WHERE league_season_id=season),'official regular weeks2 through17 have80 matchups');
  PERFORM pg_temp.check_dynasty(NOT EXISTS(SELECT 1 FROM matchups WHERE league_season_id=season AND week_number=1),'skip before generation creates no week1 matchups');
  result:=finalize_score_week_atomic(league,season,1,'[{"id":"00000000-0000-0000-0000-000000000001"}]','[]');
  PERFORM pg_temp.check_dynasty(result='[]'::jsonb AND NOT EXISTS(SELECT 1 FROM standings WHERE league_season_id=season),'skipped scoring adds no records or zero ties');
  PERFORM pg_temp.fail_dynasty(format('SELECT update_league_settings_atomic(%L,%L)',league,'{"playoff_entrants":8,"playoff_round_lengths":[1,1]}'),'need 3 rounds','too few rounds rejected');
  FOR i IN 1..4 LOOP
    player:=gen_random_uuid(); player_ids:=array_append(player_ids,player);
    INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,career_regular_season_games)
    VALUES(player,'Taxi','Boundary '||i,'PG',ARRAY['PG'],CASE WHEN i=1 THEN 0 ELSE 1 END,CASE i WHEN 2 THEN 64 WHEN 3 THEN 65 ELSE NULL END);
  END LOOP;
  PERFORM pg_temp.check_dynasty(private.taxi_player_eligible(league,player_ids[1]),'undrafted first season eligible with unknown games');
  PERFORM pg_temp.check_dynasty(private.taxi_player_eligible(league,player_ids[2]),'second year64 games eligible');
  PERFORM pg_temp.check_dynasty(NOT private.taxi_player_eligible(league,player_ids[3]),'65 games ineligible');
  PERFORM pg_temp.check_dynasty(NOT private.taxi_player_eligible(league,player_ids[4]),'unknown games nonrookie ineligible');
  PERFORM private.authorize_taxi_acquisition(league,season,members[1],player_ids[2],'draft',gen_random_uuid());
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,is_on_taxi,acquired_via)
    VALUES(league,season,members[1],player_ids[2],true,'draft');
  PERFORM pg_temp.check_dynasty((SELECT taxi_start_season_year=8200 FROM roster_players WHERE league_season_id=season AND player_id=player_ids[2]),'draft explicitly records taxi season');
  PERFORM pg_temp.fail_dynasty(format('INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,is_on_taxi,acquired_via) VALUES(%L,%L,%L,%L,true,''free_agent'')',league,season,members[1],player_ids[1]),'only through a draft or trade','free agent cannot enter taxi');
  UPDATE leagues SET status='active' WHERE id=league;
  PERFORM update_league_settings_atomic(league,'{"taxi_rule":"drafted_rookies"}');
  PERFORM update_league_settings_atomic(league,'{"taxi_rule":"rookies_or_64_games","taxi_max_seasons":2}');
  PERFORM pg_temp.check_dynasty((SELECT is_on_taxi AND taxi_start_season_year=8200 FROM roster_players WHERE league_season_id=season AND player_id=player_ids[2]),'existing league can opt into prospective taxi policies without rewriting its roster');
  PERFORM pg_temp.fail_dynasty(format('SELECT update_league_settings_atomic(%L,%L)',league,'{"team_limit":12}'),'only be changed before the draft','team count retains setup lock');
  UPDATE matchups SET is_finalized=true,winner_member_id=home_member_id,home_points=10,away_points=5,home_max_possible_points=15,away_max_possible_points=10,finalized_at=now()-interval '3 days' WHERE league_season_id=season;
  PERFORM private.rebuild_regular_standings(league,season);
  PERFORM pg_temp.check_dynasty((SELECT sum(wins)=80 AND sum(losses)=80 AND sum(ties)=0 AND sum(points_for)=1200 FROM standings WHERE league_season_id=season AND week_number=17),'official standings contain16 weeks and no skipped tie');
  result:=generate_playoff_bracket_atomic(league);
  SELECT playoff_seed_member_ids INTO seeds FROM league_seasons WHERE id=season;
  PERFORM pg_temp.check_dynasty((result->>'inserted')::int=2 AND (SELECT bool_and(week_number=18 AND end_week_number=19 AND matchup_type='playoff_semifinal') FROM matchups WHERE league_season_id=season AND matchup_type<>'regular_season'),'official four entrant semifinals weeks18 and19');
  UPDATE matchups SET is_finalized=true,winner_member_id=home_member_id,finalized_at=now()-interval '3 days' WHERE league_season_id=season AND matchup_type='playoff_semifinal';
  PERFORM advance_playoff_bracket_atomic(league);
  PERFORM pg_temp.check_dynasty(EXISTS(SELECT 1 FROM matchups WHERE league_season_id=season AND matchup_type='playoff_final' AND week_number=20 AND end_week_number=21),'official final weeks20 and21');
  PERFORM set_config('request.jwt.claim.sub','',true);
  DELETE FROM matchups WHERE league_season_id=season AND matchup_type<>'regular_season';
  PERFORM set_config('request.jwt.claim.sub',users[1]::text,true);
  PERFORM update_league_settings_atomic(league,'{"skipped_weeks":[1,2]}');
  PERFORM pg_temp.check_dynasty((SELECT bool_and(is_voided AND NOT is_finalized AND winner_member_id IS NULL) FROM matchups WHERE league_season_id=season AND week_number=2),'void existing matchups marks skipped and no winner');
  PERFORM pg_temp.check_dynasty((SELECT sum(wins)=75 AND sum(ties)=0 AND sum(points_for)=1125 FROM standings WHERE league_season_id=season AND week_number=17),'void rebuild removes wins points and ties from all later standings');
  PERFORM pg_temp.check_dynasty((SELECT sum(wins)=75 AND sum(points_for)=1125 FROM private.playoff_seed_rankings(league,season,18)),'seeding excludes voided week');
  SELECT array_agg(records.member_id ORDER BY records.wins,records.points_for,records.member_id) INTO expected_order FROM (
    SELECT member.id AS member_id,count(matchup.id) FILTER (WHERE matchup.winner_member_id=member.id) AS wins,
      COALESCE(sum(CASE WHEN matchup.home_member_id=member.id THEN matchup.home_points ELSE matchup.away_points END),0) AS points_for
    FROM league_members member LEFT JOIN matchups matchup ON matchup.league_season_id=season AND matchup.matchup_type='regular_season'
      AND NOT matchup.is_voided AND matchup.is_finalized AND member.id IN (matchup.home_member_id,matchup.away_member_id)
    WHERE member.league_id=league GROUP BY member.id
  ) records;
  UPDATE leagues SET status='playoffs' WHERE id=league;
  PERFORM set_config('request.jwt.claim.sub','',true);
  SELECT new_season_id INTO other_season FROM advance_season_atomic(league);
  PERFORM pg_temp.check_dynasty((SELECT is_on_taxi AND taxi_start_season_year=8200 FROM roster_players WHERE league_season_id=other_season AND player_id=player_ids[2]),'taxi survives second season with original tenure');
  PERFORM pg_temp.check_dynasty((SELECT array_agg(priority.member_id ORDER BY priority.priority)=expected_order FROM waiver_priorities priority WHERE league_season_id=other_season),'waiver reset order excludes voided week');
  PERFORM pg_temp.check_dynasty((SELECT count(*)=30 FROM draft_picks WHERE league_id=league AND season_year=8201),'rollover supplies every rookie round without a fixture repair');
  rookie_draft:=start_rookie_draft_atomic(league,1,false);
  PERFORM pg_temp.check_dynasty((SELECT array_agg(draft_order.member_id ORDER BY draft_order.position)=expected_order FROM draft_orders draft_order WHERE draft_id=(rookie_draft->>'id')::uuid),'real rookie draft order excludes voided week');
  UPDATE drafts SET status='cancelled' WHERE id=(rookie_draft->>'id')::uuid;

  UPDATE leagues SET status='playoffs' WHERE id=league;
  SELECT new_season_id INTO other_season FROM advance_season_atomic(league);
  PERFORM pg_temp.check_dynasty((SELECT NOT is_on_taxi AND taxi_start_season_year=8200 FROM roster_players WHERE league_season_id=other_season AND player_id=player_ids[2]),'third season promotes taxi without losing player');
  PERFORM pg_temp.check_dynasty(EXISTS(SELECT 1 FROM league_member_taxi_exits exit WHERE exit.league_id=league AND exit.member_id=members[1] AND exit.player_id=player_ids[2]),'tenure promotion records permanent team taxi exit');
  DELETE FROM roster_players WHERE league_season_id=other_season AND player_id=player_ids[2];
  PERFORM private.authorize_taxi_acquisition(league,other_season,members[2],player_ids[2],'draft',gen_random_uuid());
  PERFORM pg_temp.fail_dynasty(format('INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,is_on_taxi,acquired_via) VALUES(%L,%L,%L,%L,true,''draft'')',league,other_season,members[2],player_ids[2]),'tenure limit','drop and redraft cannot reset taxi tenure');
  other_league:=gen_random_uuid(); other_season:=gen_random_uuid();
  INSERT INTO leagues(id,name,slug,commissioner_id,status,playoff_start_week,playoff_entrants,playoff_round_lengths)
  VALUES(other_league,'Odd schedule fixture',other_league::text,users[1],'setup',6,4,ARRAY[1,1]);
  INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(other_season,other_league,8200,true);
  INSERT INTO league_members(league_id,user_id,role,team_name)
  SELECT other_league,users[n],CASE WHEN n=1 THEN 'commissioner' ELSE 'manager' END::league_member_role,'Odd '||n FROM generate_series(1,5) n;
  result:=replace_regular_season_matchups_atomic(other_league,other_season,false,private.regular_season_matchup_payload(other_league,other_season,5));
  PERFORM pg_temp.check_dynasty((result->>'inserted')::int=10 AND (SELECT count(*)=5 FROM (SELECT week_number FROM matchups WHERE league_season_id=other_season GROUP BY week_number HAVING count(*)=2) weeks),'odd schedule has one bye every week');
  PERFORM pg_temp.check_dynasty((SELECT bool_and(played=4) FROM (SELECT id,(SELECT count(*) FROM matchups WHERE league_season_id=other_season AND league_members.id IN (home_member_id,away_member_id)) played FROM league_members WHERE league_id=other_league) teams),'odd byes distributed once per team');
  PERFORM set_config('request.jwt.claim.sub',users[1]::text,true);
  PERFORM pg_temp.fail_dynasty(format('SELECT update_league_settings_atomic(%L,%L)',other_league,'{"playoff_entrants":6,"playoff_round_lengths":[1,1,1]}'),'exceed league teams','entrants beyond teams rejected');
  DELETE FROM matchups WHERE league_season_id=other_season;
  INSERT INTO league_members(league_id,user_id,role,team_name) VALUES(other_league,users[6],'manager','Odd6');
  PERFORM update_league_settings_atomic(other_league,'{"playoff_start_week":1,"playoff_entrants":6,"playoff_round_lengths":[1,1,1]}');
  result:=generate_playoff_bracket_atomic(other_league);
  SELECT playoff_seed_member_ids INTO seeds FROM league_seasons WHERE id=other_season;
  PERFORM pg_temp.check_dynasty((result->>'inserted')::int=2 AND NOT EXISTS(SELECT 1 FROM matchups WHERE league_season_id=other_season AND (home_member_id=ANY(seeds[1:2]) OR away_member_id=ANY(seeds[1:2]))),'six entrant top two seeds have first round byes');
  UPDATE matchups SET is_finalized=true,winner_member_id=home_member_id,finalized_at=now()-interval '3 days' WHERE league_season_id=other_season;
  PERFORM advance_playoff_bracket_atomic(other_league);
  PERFORM pg_temp.check_dynasty((SELECT count(*)=2 AND bool_and(week_number=2) FROM matchups WHERE league_season_id=other_season AND matchup_type='playoff_semifinal'),'six entrant byes advance into two semifinals');
END;
$$;
SELECT count(*) AS passed_checks FROM dynasty_checks;
ROLLBACK;
