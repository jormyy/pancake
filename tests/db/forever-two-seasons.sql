BEGIN;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '250ms';
SET LOCAL app.supabase_url = 'http://127.0.0.1:60421';
SET LOCAL app.edge_internal_token = 'forever-local-recipe';
ALTER TABLE public.notification_outbox DISABLE TRIGGER notif_draft_immediate_wake;

CREATE TEMP TABLE forever_boundary_checks(label text PRIMARY KEY);
CREATE TEMP TABLE forever_boundary_days(day date PRIMARY KEY, season_year int, status text, duration interval);

CREATE FUNCTION pg_temp.forever_check(p_ok boolean, p_label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL: %', p_label;
  END IF;
  INSERT INTO forever_boundary_checks VALUES (p_label);
END;
$$;

CREATE FUNCTION pg_temp.forever_certify(p_league uuid, p_season uuid, p_week int, p_at timestamptz)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_token jsonb;
  v_payload jsonb;
  v_standings jsonb;
BEGIN
  v_token := public.capture_score_inputs(p_season, p_week);
  SELECT jsonb_agg(jsonb_build_object(
    'id', id, 'winner_member_id', home_member_id,
    'home_points', 100, 'away_points', 90,
    'home_max_possible_points', 100, 'away_max_possible_points', 90,
    'input_token', v_token) ORDER BY id)
  INTO v_payload FROM public.matchups
  WHERE league_season_id = p_season AND week_number = p_week AND NOT is_voided;
  SELECT jsonb_agg(jsonb_build_object('member_id', id,
    'wins', CASE WHEN id = (SELECT min(home_member_id::text)::uuid FROM public.matchups
      WHERE league_season_id = p_season AND week_number = p_week) THEN p_week ELSE 0 END,
    'losses', 0, 'ties', 0, 'points_for', p_week * 100,
    'points_against', p_week * 90, 'max_possible_points', p_week * 100) ORDER BY id)
  INTO v_standings FROM public.league_members WHERE league_id = p_league;
  PERFORM public.finalize_score_week_atomic(p_league, p_season, p_week,
    COALESCE(v_payload, '[]'::jsonb), v_standings, p_at, p_at);
END;
$$;

DO $$
DECLARE
  v_league uuid := gen_random_uuid();
  v_season uuid := gen_random_uuid();
  v_previous uuid;
  v_user uuid;
  v_member uuid;
  v_player uuid;
  v_draft uuid;
  v_pick record;
  v_week record;
  v_year int;
  v_base_year int;
  v_season_offset int;
  v_index int;
  v_week_count int;
  v_playoff_start int;
  v_games jsonb;
  v_weeks jsonb;
  v_start date;
  v_day date;
  v_at timestamptz;
  v_started timestamptz;
  v_result jsonb;
  v_action text;
  v_status text;
  v_calendar_rejected boolean := false;
  v_rollovers int := 0;
  v_generations int := 0;
  v_advances int := 0;
  v_drafts int := 0;
  v_native_invocations bigint;
BEGIN
  SELECT candidate INTO v_base_year FROM generate_series(7000, 8800) candidate
  WHERE NOT EXISTS (SELECT 1 FROM public.season_weeks WHERE season_year BETWEEN candidate AND candidate + 2)
    AND NOT EXISTS (SELECT 1 FROM public.nba_games WHERE season_year BETWEEN candidate AND candidate + 2)
    AND NOT EXISTS (SELECT 1 FROM public.league_seasons WHERE season_year BETWEEN candidate AND candidate + 2)
  ORDER BY candidate LIMIT 1;
  PERFORM pg_temp.forever_check(v_base_year IS NOT NULL, 'three empty fixture seasons exist');
  SELECT count(*) INTO v_native_invocations FROM public.edge_invocations;

  FOR v_index IN 1..4 LOOP
    v_user := gen_random_uuid();
    v_member := gen_random_uuid();
    INSERT INTO auth.users(id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES (v_user, 'authenticated', 'authenticated', v_user || '@example.test', 'x', now(), '{}', '{}', now(), now());
    IF v_index = 1 THEN
      INSERT INTO public.leagues(id, name, slug, commissioner_id, status, playoff_start_week,
        playoff_entrants, playoff_round_lengths, roster_size)
      VALUES (v_league, 'Forever two seasons', v_league::text, v_user, 'offseason', 23, 4, ARRAY[1, 1], 12);
      INSERT INTO public.league_seasons(id, league_id, season_year, is_current)
      VALUES (v_season, v_league, v_base_year, true);
    END IF;
    INSERT INTO public.league_members(id, league_id, user_id, role, team_name)
    VALUES (v_member, v_league, v_user,
      CASE WHEN v_index = 1 THEN 'commissioner' ELSE 'manager' END::public.league_member_role,
      'Boundary team ' || v_index);
  END LOOP;

  BEGIN
    PERFORM public.replace_regular_season_matchups_atomic(v_league, v_season);
  EXCEPTION WHEN SQLSTATE '22023' THEN
    v_calendar_rejected := position('calendar' IN SQLERRM) > 0;
  END;
  PERFORM pg_temp.forever_check(v_calendar_rejected
    AND NOT EXISTS (SELECT 1 FROM public.matchups WHERE league_id = v_league),
    'unpublished calendar keeps the league idle without a guessed schedule');

  FOR v_season_offset IN 0..1 LOOP
    v_year := v_base_year + v_season_offset;
    v_week_count := 24 + v_season_offset * 2;
    v_start := make_date(v_year - 1, 10, 17 + v_season_offset * 3);
    SELECT jsonb_agg(jsonb_build_object('season_year', v_year, 'week_number', week_number,
      'week_start', v_start + (week_number - 1) * 7 + CASE WHEN week_number > 8 THEN 7 ELSE 0 END,
      'week_end', v_start + week_number * 7 - 1 + CASE WHEN week_number >= 8 THEN 7 ELSE 0 END)
      ORDER BY week_number)
    INTO v_weeks FROM generate_series(1, v_week_count) week_number;
    SELECT jsonb_agg(jsonb_build_object('nba_game_id', '002' || v_year || lpad(week_number::text, 3, '0'),
      'season_year', v_year, 'week_number', week_number, 'game_date', week_end,
      'home_team', 'XAA', 'away_team', 'XBB', 'status', 'Final') ORDER BY week_number)
    INTO v_games FROM jsonb_to_recordset(v_weeks) week(week_number int, week_end date);
    PERFORM public.publish_nba_schedule_atomic(v_year, v_games, v_weeks);
    SELECT max(week_number) - 1 INTO v_playoff_start FROM public.season_weeks WHERE season_year = v_year;
    UPDATE public.leagues SET playoff_start_week = v_playoff_start WHERE id = v_league;
    UPDATE public.league_seasons SET playoff_start_week = v_playoff_start WHERE id = v_season;
    PERFORM pg_temp.forever_check((SELECT count(*) = v_week_count
      AND max(week_end - week_start + 1) = 14 FROM public.season_weeks WHERE season_year = v_year),
      format('season %s follows its published calendar and extended week', v_season_offset + 1));

    INSERT INTO public.draft_picks(league_id, season_year, round, original_owner_id, current_owner_id)
    SELECT v_league, v_year, 1, id, id FROM public.league_members WHERE league_id = v_league
    ON CONFLICT (league_id, season_year, round, original_owner_id) DO NOTHING;

    FOR v_day IN SELECT generate_series(make_date(v_year - 1, 10, 1), make_date(v_year, 9, 30), interval '1 day')::date LOOP
      v_at := (v_day + time '12:00') AT TIME ZONE 'America/New_York';
      IF v_day = v_start - 1 THEN
        v_result := public.start_rookie_draft_atomic(v_league, 1, false, 60, 'auto_pick');
        v_draft := (v_result->>'id')::uuid;
        FOR v_pick IN SELECT member_id FROM public.snake_draft_picks WHERE draft_id = v_draft ORDER BY overall_pick LOOP
          v_player := gen_random_uuid();
          INSERT INTO public.players(id, first_name, last_name, position, eligible_positions, years_exp, nba_draft_number)
          VALUES (v_player, 'Boundary', v_player::text, 'PG', ARRAY['PG'], 0, 1);
          PERFORM public.make_snake_pick_atomic(v_draft, v_pick.member_id, v_player);
        END LOOP;
        v_drafts := v_drafts + 1;
        PERFORM pg_temp.forever_check((SELECT status = 'active' FROM public.leagues WHERE id = v_league),
          format('season %s activates after the real rookie draft completes', v_season_offset + 1));
        PERFORM public.replace_regular_season_matchups_atomic(v_league, v_season);
      END IF;

      FOR v_week IN
        SELECT DISTINCT matchup.week_number, calendar.week_end
        FROM public.matchups matchup JOIN public.season_weeks calendar
          ON calendar.season_year = v_year AND calendar.week_number = matchup.week_number
        WHERE matchup.league_season_id = v_season AND NOT matchup.is_finalized AND NOT matchup.is_voided
          AND calendar.week_end < v_day ORDER BY matchup.week_number
      LOOP
        PERFORM pg_temp.forever_certify(v_league, v_season, v_week.week_number, v_at);
      END LOOP;

      SELECT status::text INTO v_status FROM public.leagues WHERE id = v_league;
      v_started := clock_timestamp();
      FOREACH v_action IN ARRAY ARRAY['generate', 'advance', 'rollover'] LOOP
        v_result := public.apply_season_boundary_after_grace(v_league, v_season, v_action, v_at);
        IF v_result->>'reason' = 'stale_score_inputs' THEN
          FOR v_week IN SELECT DISTINCT week_number FROM public.matchups
            WHERE league_season_id = v_season AND is_finalized AND NOT is_voided ORDER BY week_number
          LOOP
            PERFORM pg_temp.forever_certify(v_league, v_season, v_week.week_number,
              (SELECT max(finalized_at) FROM public.matchups WHERE league_season_id = v_season
                AND week_number = v_week.week_number));
          END LOOP;
          v_result := public.apply_season_boundary_after_grace(v_league, v_season, v_action, v_at);
        END IF;
        IF COALESCE((v_result->>'applied')::boolean, false) THEN
          IF v_action = 'generate' THEN v_generations := v_generations + 1;
          ELSIF v_action = 'advance' THEN v_advances := v_advances + 1;
          ELSE
            v_rollovers := v_rollovers + 1;
            v_previous := v_season;
            v_season := (v_result->>'new_season_id')::uuid;
            PERFORM pg_temp.forever_check((v_result->>'new_year')::int = v_year + 1,
              format('season %s rolls to the next year exactly once', v_season_offset + 1));
            PERFORM pg_temp.forever_check(NOT (public.apply_season_boundary_after_grace(
              v_league, v_previous, 'rollover', v_at)->>'applied')::boolean,
              format('season %s rejects a repeated rollover', v_season_offset + 1));
          END IF;
        END IF;
      END LOOP;
      INSERT INTO forever_boundary_days VALUES (v_day, v_year, v_status, clock_timestamp() - v_started);
    END LOOP;
  END LOOP;

  PERFORM pg_temp.forever_check(v_drafts = 2 AND v_generations = 2 AND v_advances = 2 AND v_rollovers = 2,
    'two drafts, brackets, finals, and rollovers complete through the real SQL boundaries');
  PERFORM pg_temp.forever_check((SELECT count(*) BETWEEN 730 AND 732 FROM forever_boundary_days),
    'the walk covers every day of two complete calendar years');
  PERFORM pg_temp.forever_check((SELECT count(*) > 250 AND max(duration) < interval '1 second'
    FROM forever_boundary_days WHERE status = 'offseason'),
    'every sampled offseason boundary run returns in under one second');
  PERFORM pg_temp.forever_check((SELECT count(*) = 3 AND count(*) FILTER (WHERE is_current) = 1
    FROM public.league_seasons WHERE league_id = v_league), 'exactly one current season remains after two rollovers');
  PERFORM pg_temp.forever_check((SELECT count(*) = 8 FROM public.roster_players WHERE league_season_id = v_season),
    'both rookie classes survive two automatic season rollovers');
  PERFORM pg_temp.forever_check((SELECT count(*) = v_native_invocations FROM public.edge_invocations),
    'the SQL boundary recipe starts no Edge invocations');
END;
$$;

SELECT count(*) AS passed FROM forever_boundary_checks;
SELECT count(*) AS days, count(*) FILTER (WHERE status = 'offseason') AS offseason_days,
  max(duration) FILTER (WHERE status = 'offseason') AS slowest_offseason_run FROM forever_boundary_days;
ROLLBACK;
