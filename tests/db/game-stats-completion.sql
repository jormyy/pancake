BEGIN;

CREATE FUNCTION pg_temp.must(p_ok boolean, p_message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Control failed: %', p_message USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION pg_temp.stat_row(p_player uuid, p_game uuid, p_points int)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'player_id', p_player, 'game_id', p_game,
    'season_year', 1900, 'week_number', 999,
    'game_date', '1900-01-01',
    'minutes_played', 30.00, 'points', p_points,
    'rebounds', 4, 'offensive_rebounds', 1, 'defensive_rebounds', 3,
    'assists', 3, 'steals', 1, 'blocks', 1, 'turnovers', 1,
    'personal_fouls', 1, 'field_goals_made', 4, 'field_goals_attempted', 9,
    'three_pointers_made', 1, 'three_pointers_attempted', 3,
    'free_throws_made', 1, 'free_throws_attempted', 2,
    'plus_minus', 2, 'double_double', false, 'triple_double', false,
    'did_not_play', false
  );
$$;

CREATE FUNCTION pg_temp.expect_error(p_sql text, p_states text[], p_label text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_state text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
  END;
  PERFORM pg_temp.must(v_state = ANY(p_states),
    p_label || ': expected ' || array_to_string(p_states, ',') ||
    ', received ' || COALESCE(v_state, 'success'));
END;
$$;

DO $$
DECLARE
  v_a uuid := gen_random_uuid();
  v_b uuid := gen_random_uuid();
  v_live uuid := gen_random_uuid();
  v_p1 uuid := gen_random_uuid();
  v_p2 uuid := gen_random_uuid();
  v_p3 uuid := gen_random_uuid();
  v_p4 uuid := gen_random_uuid();
  v_missing uuid := gen_random_uuid();
  v_pa text := '002-control-' || v_a;
  v_pb text := '002-control-' || v_b;
  v_pl text := '002-control-' || v_live;
  v_payload jsonb;
  v_payload_b jsonb;
  v_live_payload jsonb;
  v_before jsonb;
  v_after jsonb;
  v_stamp timestamptz;
  v_ctid1 text;
  v_ctid2 text;
  v_changed int;
  v_rejected boolean;
  v_role text;
BEGIN
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions, years_exp)
  VALUES (v_p1, 'Atomic', v_p1::text, 'PG', ARRAY['PG']::text[], 2),
         (v_p2, 'Atomic', v_p2::text, 'PG', ARRAY['PG']::text[], 2),
         (v_p3, 'Atomic', v_p3::text, 'PG', ARRAY['PG']::text[], 2),
         (v_p4, 'Atomic', v_p4::text, 'PG', ARRAY['PG']::text[], 2);

  INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number,
    game_date, home_team, away_team, status)
  VALUES (v_a, v_pa, 3990, 1, '3990-01-02', 'XCA', 'XCB', 'InProgress'),
         (v_b, v_pb, 3990, 2, '3990-01-09', 'XCC', 'XCD', 'InProgress'),
         (v_live, v_pl, 3990, 3, '3990-01-16', 'XCE', 'XCF', 'InProgress');

  v_payload := jsonb_build_array(pg_temp.stat_row(v_p1,v_a,10), pg_temp.stat_row(v_p2,v_a,20));
  v_payload_b := jsonb_build_array(pg_temp.stat_row(v_p3,v_b,30), pg_temp.stat_row(v_p4,v_b,40));
  v_live_payload := jsonb_build_array(pg_temp.stat_row(v_p4,v_live,5));

  -- Full Final payload inserts both rows and derives calendar from the game.
  v_changed := public.save_game_stats_atomic(v_a,v_pa,v_payload,true);
  PERFORM pg_temp.must(v_changed=2, 'first full import writes two rows');
  PERFORM pg_temp.must((SELECT status='Final' AND stats_synced_at IS NOT NULL
    FROM public.nba_games WHERE id=v_a), 'full import certifies Final');
  PERFORM pg_temp.must((SELECT count(*)=2 AND bool_and(season_year=3990 AND
    week_number=1 AND game_date='3990-01-02'::date)
    FROM public.player_game_stats WHERE game_id=v_a), 'caller calendar cannot override canonical game calendar');
  SELECT ctid::text INTO v_ctid1 FROM public.player_game_stats WHERE game_id=v_a AND player_id=v_p1;
  SELECT ctid::text INTO v_ctid2 FROM public.player_game_stats WHERE game_id=v_a AND player_id=v_p2;
  SELECT jsonb_agg(to_jsonb(s) ORDER BY player_id) INTO v_before
    FROM public.player_game_stats s WHERE game_id=v_a;

  -- No-op proof uses physical row identity, not timestamps within one transaction.
  v_changed := public.save_game_stats_atomic(v_a,v_pa,v_payload,true);
  SELECT jsonb_agg(to_jsonb(s) ORDER BY player_id) INTO v_after
    FROM public.player_game_stats s WHERE game_id=v_a;
  PERFORM pg_temp.must(v_changed=0 AND v_after=v_before,
    'identical full import leaves every stat field and timestamp unchanged');
  PERFORM pg_temp.must((SELECT ctid::text=v_ctid1 FROM public.player_game_stats
    WHERE game_id=v_a AND player_id=v_p1) AND
    (SELECT ctid::text=v_ctid2 FROM public.player_game_stats
    WHERE game_id=v_a AND player_id=v_p2), 'identical import performs no stat updates');

  -- Full payload with one changed row must write exactly one row.
  v_payload := jsonb_build_array(pg_temp.stat_row(v_p1,v_a,11), pg_temp.stat_row(v_p2,v_a,20));
  v_changed := public.save_game_stats_atomic(v_a,v_pa,v_payload,true);
  PERFORM pg_temp.must(v_changed=1 AND (SELECT points=11 FROM public.player_game_stats
    WHERE game_id=v_a AND player_id=v_p1), 'one correction writes one row');
  PERFORM pg_temp.must((SELECT ctid::text=v_ctid2 FROM public.player_game_stats
    WHERE game_id=v_a AND player_id=v_p2), 'unchanged companion row does not update');

  -- A changed-only subset cannot certify a game that has other stored players.
  SELECT stats_synced_at INTO v_stamp FROM public.nba_games WHERE id=v_a;
  SELECT jsonb_agg(to_jsonb(s) ORDER BY player_id) INTO v_before
    FROM public.player_game_stats s WHERE game_id=v_a;
  PERFORM pg_temp.expect_error(format('SELECT public.save_game_stats_atomic(%L::uuid,%L,%L::jsonb,true)',
    v_a,v_pa,jsonb_build_array(pg_temp.stat_row(v_p1,v_a,99))), ARRAY['22023'], 'Final changed-only subset rejected');
  PERFORM pg_temp.must((SELECT stats_synced_at=v_stamp FROM public.nba_games WHERE id=v_a),
    'rejected omitted-player Final preserves existing stamp');
  SELECT jsonb_agg(to_jsonb(s) ORDER BY player_id) INTO v_after
    FROM public.player_game_stats s WHERE game_id=v_a;
  PERFORM pg_temp.must(v_after=v_before, 'omitted-player rejection preserves every stat');

  -- A valid update plus a bad foreign-key row must roll back the entire RPC.
  PERFORM pg_temp.expect_error(format('SELECT public.save_game_stats_atomic(%L::uuid,%L,%L::jsonb,true)',
    v_a,v_pa,jsonb_build_array(pg_temp.stat_row(v_p1,v_a,99),pg_temp.stat_row(v_p2,v_a,20),
      pg_temp.stat_row(v_missing,v_a,1))), ARRAY['23503'], 'bad row rolls back valid companion writes');
  SELECT jsonb_agg(to_jsonb(s) ORDER BY player_id) INTO v_after
    FROM public.player_game_stats s WHERE game_id=v_a;
  PERFORM pg_temp.must(v_after=v_before AND
    (SELECT stats_synced_at=v_stamp FROM public.nba_games WHERE id=v_a),
    'foreign-key failure preserves prior rows and exact stamp');

  PERFORM pg_temp.expect_error(format('SELECT public.save_game_stats_atomic(%L::uuid,%L,%L::jsonb,true)',
    v_a,v_pa||'-stale',v_payload), ARRAY['PT409'], 'old provider identity rejected');
  PERFORM pg_temp.must((SELECT stats_synced_at=v_stamp FROM public.nba_games WHERE id=v_a),
    'identity rejection preserves stamp');
  PERFORM pg_temp.expect_error(format('SELECT public.save_game_stats_atomic(%L::uuid,%L,%L::jsonb,true)',
    v_a,v_pa,'[]'), ARRAY['22023'], 'empty Final rejected');
  PERFORM pg_temp.expect_error(format('SELECT public.save_game_stats_atomic(%L::uuid,%L,%L::jsonb,NULL)',
    v_a,v_pa,v_payload), ARRAY['22023'], 'null Final flag rejected');
  PERFORM pg_temp.expect_error(format('SELECT public.save_game_stats_atomic(%L::uuid,%L,%L::jsonb,true)',
    v_a,v_pa,jsonb_build_array(pg_temp.stat_row(v_p1,v_a,11),pg_temp.stat_row(v_p1,v_a,11))),
    ARRAY['22023'], 'duplicate canonical player rejected');

  -- Numeric corrections keep row coverage, and therefore keep completion.
  UPDATE public.player_game_stats SET points=12 WHERE game_id=v_a AND player_id=v_p1;
  PERFORM pg_temp.must((SELECT stats_synced_at=v_stamp FROM public.nba_games WHERE id=v_a),
    'ordinary numeric correction retains completion');
  UPDATE public.player_game_stats SET player_id=player_id,game_id=game_id
    WHERE game_id=v_a AND player_id=v_p1;
  PERFORM pg_temp.must((SELECT stats_synced_at=v_stamp FROM public.nba_games WHERE id=v_a),
    'identity no-op does not invalidate');

  -- One deleted row invalidates even when another row survives.
  DELETE FROM public.player_game_stats WHERE game_id=v_a AND player_id=v_p2;
  PERFORM pg_temp.must((SELECT stats_synced_at IS NULL FROM public.nba_games WHERE id=v_a)
    AND (SELECT count(*)=1 FROM public.player_game_stats WHERE game_id=v_a),
    'partial deletion clears completion');
  -- The complete payload restores the deleted row despite a formerly empty client diff.
  v_payload := jsonb_build_array(pg_temp.stat_row(v_p1,v_a,12),pg_temp.stat_row(v_p2,v_a,20));
  v_changed := public.save_game_stats_atomic(v_a,v_pa,v_payload,true);
  PERFORM pg_temp.must(v_changed=1 AND
    (SELECT count(*)=2 FROM public.player_game_stats WHERE game_id=v_a) AND
    (SELECT stats_synced_at IS NOT NULL FROM public.nba_games WHERE id=v_a),
    'full payload restores missing row before recertifying');
  DELETE FROM public.player_game_stats WHERE game_id=v_a;
  PERFORM pg_temp.must((SELECT stats_synced_at IS NULL FROM public.nba_games WHERE id=v_a)
    AND NOT EXISTS(SELECT 1 FROM public.player_game_stats WHERE game_id=v_a),
    'all-row deletion clears completion');
  PERFORM pg_temp.must(public.save_game_stats_atomic(v_a,v_pa,v_payload,true)=2,
    'full recovery restores both deleted rows');

  -- A game move invalidates both source and destination.
  PERFORM public.save_game_stats_atomic(v_b,v_pb,v_payload_b,true);
  UPDATE public.player_game_stats SET game_id=v_b WHERE game_id=v_a AND player_id=v_p2;
  PERFORM pg_temp.must((SELECT stats_synced_at IS NULL FROM public.nba_games WHERE id=v_a)
    AND (SELECT stats_synced_at IS NULL FROM public.nba_games WHERE id=v_b),
    'game reassignment invalidates old and new completion');
  PERFORM pg_temp.must((SELECT season_year=3990 AND week_number=2 AND game_date='3990-01-09'::date
    FROM public.player_game_stats WHERE game_id=v_b AND player_id=v_p2),
    'game reassignment keeps canonical destination calendar');
  UPDATE public.player_game_stats SET game_id=v_a WHERE game_id=v_b AND player_id=v_p2;
  PERFORM public.save_game_stats_atomic(v_a,v_pa,v_payload,true);
  PERFORM public.save_game_stats_atomic(v_b,v_pb,v_payload_b,true);
  UPDATE public.player_game_stats SET player_id=v_p3 WHERE game_id=v_a AND player_id=v_p2;
  PERFORM pg_temp.must((SELECT stats_synced_at IS NULL FROM public.nba_games WHERE id=v_a),
    'player identity reassignment invalidates completion');
  -- Recertify the identity now actually stored before merge controls.
  PERFORM public.save_game_stats_atomic(v_a,v_pa,
    jsonb_build_array(pg_temp.stat_row(v_p1,v_a,12),pg_temp.stat_row(v_p3,v_a,20)),true);

  -- Live writes stay uncertified; a full Final transition certifies them.
  PERFORM pg_temp.must(public.save_game_stats_atomic(v_live,v_pl,'[]'::jsonb,false)=0,
    'empty live import remains a no-op on a live game');
  PERFORM pg_temp.must(public.save_game_stats_atomic(v_live,v_pl,v_live_payload,false)=1,
    'normal live import saves stats');
  PERFORM pg_temp.must((SELECT status='InProgress' AND stats_synced_at IS NULL
    FROM public.nba_games WHERE id=v_live), 'live data does not certify Final');
  PERFORM public.save_game_stats_atomic(v_live,v_pl,v_live_payload,true);
  SELECT stats_synced_at INTO v_stamp FROM public.nba_games WHERE id=v_live;
  PERFORM pg_temp.must((SELECT status='Final' AND stats_synced_at IS NOT NULL
    FROM public.nba_games WHERE id=v_live), 'live-to-Final transition certifies');
  PERFORM pg_temp.expect_error(format('SELECT public.save_game_stats_atomic(%L::uuid,%L,%L::jsonb,false)',
    v_live,v_pl,jsonb_build_array(pg_temp.stat_row(v_p4,v_live,99))),
    ARRAY['22023'], 'nonempty stale live import rejected');
  -- This control is intentionally red for the initial early-return ordering.
  PERFORM pg_temp.expect_error(format('SELECT public.save_game_stats_atomic(%L::uuid,%L,%L::jsonb,false)',
    v_live,v_pl,'[]'), ARRAY['22023'], 'empty stale live import rejected');
  PERFORM pg_temp.must((SELECT stats_synced_at=v_stamp AND status='Final'
    FROM public.nba_games WHERE id=v_live) AND
    (SELECT points=5 FROM public.player_game_stats WHERE game_id=v_live AND player_id=v_p4),
    'stale live responses preserve Final state and values');

  -- The ACL test calls the real RPC under each role, rather than reading grants alone.
  FOREACH v_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    v_rejected := false;
    EXECUTE format('SET LOCAL ROLE %I',v_role);
    BEGIN
      PERFORM public.save_game_stats_atomic(v_live,v_pl,v_live_payload,true);
    EXCEPTION WHEN insufficient_privilege THEN
      v_rejected := true;
    END;
    EXECUTE 'RESET ROLE';
    PERFORM pg_temp.must(v_rejected, v_role || ' cannot certify game stats');
  END LOOP;
  EXECUTE 'SET LOCAL ROLE service_role';
  v_changed := public.save_game_stats_atomic(v_live,v_pl,v_live_payload,true);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.must(v_changed=0, 'service role can execute a safe no-op import');

  -- Both merge cases run through the real merge, without disabling triggers.
  -- Game A has winner and loser rows; game B has only the loser row.
  PERFORM public.merge_players(v_p1,v_p3);
  PERFORM pg_temp.must(NOT EXISTS(SELECT 1 FROM public.players WHERE id=v_p3),
    'merge removes only the fixture loser identity');
  PERFORM pg_temp.must((SELECT points=12 FROM public.player_game_stats
    WHERE game_id=v_a AND player_id=v_p1) AND
    (SELECT count(*)=1 FROM public.player_game_stats WHERE game_id=v_a),
    'merge collision retains canonical winner stat');
  PERFORM pg_temp.must((SELECT points=30 FROM public.player_game_stats
    WHERE game_id=v_b AND player_id=v_p1), 'merge noncollision retains and moves loser stat');
  PERFORM pg_temp.must((SELECT stats_synced_at IS NULL FROM public.nba_games WHERE id=v_a)
    AND (SELECT stats_synced_at IS NULL FROM public.nba_games WHERE id=v_b),
    'merge permits data repair and invalidates affected completion');
  PERFORM public.save_game_stats_atomic(v_a,v_pa,jsonb_build_array(pg_temp.stat_row(v_p1,v_a,12)),true);
  PERFORM public.save_game_stats_atomic(v_b,v_pb,
    jsonb_build_array(pg_temp.stat_row(v_p1,v_b,30),pg_temp.stat_row(v_p4,v_b,40)),true);
  SELECT stats_synced_at INTO v_stamp FROM public.nba_games WHERE id=v_live;

  -- Retention-style removal remains permitted. It never restores completion.
  DELETE FROM public.player_game_stats WHERE game_id IN (v_a,v_b);
  PERFORM pg_temp.must((SELECT count(*)=2 AND bool_and(stats_synced_at IS NULL)
    FROM public.nba_games WHERE id IN (v_a,v_b)), 'retained empty games remain uncertified after pruning stats');
  PERFORM pg_temp.must((SELECT stats_synced_at=v_stamp FROM public.nba_games WHERE id=v_live),
    'cleanup of fixture games leaves unrelated completion unchanged');
  -- Delete children first because the stat FK need not cascade from nba_games.
  DELETE FROM public.nba_games WHERE id IN (v_a,v_b);
  DELETE FROM public.player_game_stats WHERE game_id=v_live;
  DELETE FROM public.nba_games WHERE id=v_live;
  DELETE FROM public.players WHERE id IN (v_p1,v_p2,v_p4);
  PERFORM pg_temp.must(NOT EXISTS(SELECT 1 FROM public.nba_games WHERE id IN (v_a,v_b,v_live))
    AND NOT EXISTS(SELECT 1 FROM public.player_game_stats WHERE game_id IN (v_a,v_b,v_live)),
    'ordinary isolated cleanup remains allowed');

  RAISE NOTICE 'Completion atomic SQL controls reach all assertions; fixtures roll back.';
END;
$$;

ROLLBACK;
