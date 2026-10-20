BEGIN;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '5s';
DO $$
DECLARE
  v_league uuid := gen_random_uuid();
  v_season uuid := gen_random_uuid();
  v_users uuid[] := ARRAY[]::uuid[];
  v_members uuid[] := ARRAY[]::uuid[];
  v_user uuid;
  v_member uuid;
  v_token jsonb;
  v_before jsonb;
  v_payload jsonb;
  v_standings jsonb;
  v_week int;
  v_result jsonb;
BEGIN
  FOR i IN 1..4 LOOP
    v_user := gen_random_uuid(); v_member := gen_random_uuid();
    v_users := array_append(v_users, v_user); v_members := array_append(v_members, v_member);
    INSERT INTO auth.users(id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
      VALUES(v_user, 'authenticated', 'authenticated', v_user || '@example.test', '{}', '{}');
    IF i = 1 THEN
      INSERT INTO leagues(id, name, slug, commissioner_id, status, playoff_start_week, playoff_entrants, playoff_round_lengths)
        VALUES(v_league, 'Skipped week certificate regression', v_league::text, v_user, 'active', 4, 4, ARRAY[1,1]);
      INSERT INTO league_seasons(id, league_id, season_year, is_current, skipped_weeks)
        VALUES(v_season, v_league, 8991, true, ARRAY[2]);
    END IF;
    INSERT INTO league_members(id, league_id, user_id, role, team_name)
      VALUES(v_member, v_league, v_user, CASE WHEN i=1 THEN 'commissioner' ELSE 'manager' END::league_member_role, 'Team ' || i);
  END LOOP;
  INSERT INTO season_weeks(season_year, week_number, week_start, week_end)
    SELECT 8991, n, date '2026-01-05' + (n-1)*7, date '2026-01-11' + (n-1)*7 FROM generate_series(1,5) n;
  INSERT INTO matchups(league_id, league_season_id, week_number, home_member_id, away_member_id,
    matchup_type, is_finalized, finalized_at, home_points, away_points, home_max_possible_points, away_max_possible_points, winner_member_id)
    SELECT v_league, v_season, week, v_members[pair], v_members[pair+1], 'regular_season', true, now()-interval '3 days',
      10, 5, 12, 8, v_members[pair] FROM unnest(ARRAY[1,3]) week CROSS JOIN unnest(ARRAY[1,3]) pair;
  PERFORM private.rebuild_regular_standings(v_league, v_season);
  IF EXISTS (
    SELECT 1 FROM standings
    WHERE league_season_id = v_season
      AND (ties <> 0
        OR wins <> CASE WHEN member_id = ANY(ARRAY[v_members[1], v_members[3]]) THEN (week_number + 1) / 2 ELSE 0 END
        OR losses <> CASE WHEN member_id = ANY(ARRAY[v_members[2], v_members[4]]) THEN (week_number + 1) / 2 ELSE 0 END
        OR points_for <> (week_number + 1) / 2 * CASE WHEN member_id = ANY(ARRAY[v_members[1], v_members[3]]) THEN 10 ELSE 5 END
        OR points_against <> (week_number + 1) / 2 * CASE WHEN member_id = ANY(ARRAY[v_members[1], v_members[3]]) THEN 5 ELSE 10 END
        OR max_possible_points <> (week_number + 1) / 2 * CASE WHEN member_id = ANY(ARRAY[v_members[1], v_members[3]]) THEN 12 ELSE 8 END)
  ) THEN
    RAISE EXCEPTION 'Rebuilt standings have incorrect records, points, or maxima';
  END IF;
  SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) INTO v_before FROM standings s WHERE league_season_id=v_season;
  v_token := capture_score_inputs(v_season, 3);
  PERFORM private.rebuild_regular_standings(v_league, v_season);
  IF v_token IS DISTINCT FROM private.score_input_token(v_season, 3) THEN
    RAISE EXCEPTION 'Unchanged standings rebuild invalidates score certificates';
  END IF;
  IF v_before IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM standings s WHERE league_season_id=v_season) THEN
    RAISE EXCEPTION 'Unchanged standings rebuild replaces historical rows';
  END IF;
  FOR v_week IN SELECT unnest(ARRAY[1,3]) LOOP
    v_token := capture_score_inputs(v_season, v_week);
    SELECT jsonb_agg(to_jsonb(m) || jsonb_build_object('input_token',v_token)) INTO v_payload
      FROM matchups m WHERE league_season_id=v_season AND week_number=v_week;
    SELECT jsonb_agg(to_jsonb(s)) INTO v_standings FROM standings s WHERE league_season_id=v_season AND week_number=v_week;
    PERFORM finalize_score_week_atomic(v_league,v_season,v_week,v_payload,v_standings);
  END LOOP;
  IF EXISTS(SELECT 1 FROM get_stale_score_weeks(v_season,3)) THEN
    RAISE EXCEPTION 'Sequential finalization leaves earlier weeks stale';
  END IF;
  UPDATE matchups SET home_points=11 WHERE league_season_id=v_season AND week_number=1;
  PERFORM private.rebuild_regular_standings(v_league,v_season);
  IF (SELECT count(*) FROM get_stale_score_weeks(v_season,3)) <> 2 THEN
    RAISE EXCEPTION 'Real corrections must invalidate dependent weeks';
  END IF;
  IF NOT (SELECT bool_and(points_for=21) FROM standings WHERE league_season_id=v_season AND week_number=3 AND member_id=ANY(ARRAY[v_members[1],v_members[3]])) THEN
    RAISE EXCEPTION 'Corrected standings must include the changed score';
  END IF;
  FOR v_week IN SELECT unnest(ARRAY[1,3]) LOOP
    v_token := capture_score_inputs(v_season,v_week);
    SELECT jsonb_agg(to_jsonb(m) || jsonb_build_object('input_token',v_token)) INTO v_payload
      FROM matchups m WHERE league_season_id=v_season AND week_number=v_week;
    SELECT jsonb_agg(to_jsonb(s)) INTO v_standings FROM standings s WHERE league_season_id=v_season AND week_number=v_week;
    PERFORM finalize_score_week_atomic(v_league,v_season,v_week,v_payload,v_standings);
  END LOOP;
  v_result := apply_season_boundary_after_grace(v_league,v_season,'generate',now());
  IF v_result->>'applied' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Certified skipped-week season must generate playoffs after grace'; END IF;
  INSERT INTO standings(league_id,league_season_id,member_id,week_number,wins,losses,ties,points_for,points_against,max_possible_points,waiver_priority)
    VALUES(v_league,v_season,v_members[1],4,3,0,0,99,50,110,1);
  SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) INTO v_before FROM standings s WHERE league_season_id=v_season;
  PERFORM private.rebuild_regular_standings(v_league,v_season);
  IF v_before IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM standings s WHERE league_season_id=v_season) THEN
    RAISE EXCEPTION 'Playoff transition must not replace standings history';
  END IF;
END;
$$;
SELECT 'skipped-week certificates: PASS';
ROLLBACK;
