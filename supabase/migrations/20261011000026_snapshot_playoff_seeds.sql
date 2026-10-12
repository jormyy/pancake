-- Persist seeds for newly generated brackets. Existing rows are not reconstructed.
-- Legacy quarterfinal-only recovery requires a separate explicit decision.
ALTER TABLE public.league_seasons ADD COLUMN playoff_seed_member_ids uuid[];
ALTER TABLE public.league_seasons ADD CONSTRAINT league_seasons_playoff_seed_count
  CHECK (playoff_seed_member_ids IS NULL OR (cardinality(playoff_seed_member_ids) IN (4,6) AND array_position(playoff_seed_member_ids,NULL) IS NULL));

CREATE OR REPLACE FUNCTION public.generate_playoff_bracket_atomic(
  p_league_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_season_id uuid;
  v_season_year int;
  v_playoff_start_week int;
  v_member_count int;
  v_playoff_size int;
  v_rounds int[];
  v_league public.leagues%ROWTYPE;
  v_seed_ids uuid[];
  v_inserted_count int := 0;
  v_pair record;
  v_existing_challenge public.rps_challenges%ROWTYPE;
BEGIN
  SELECT * INTO v_league FROM public.leagues WHERE id = p_league_id FOR UPDATE;
  SELECT id, season_year, COALESCE(playoff_start_week, v_league.playoff_start_week, 20)
    INTO v_season_id, v_season_year, v_playoff_start_week
    FROM public.league_seasons WHERE league_id = p_league_id AND is_current FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Current league season not found for playoff generation.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('playoff-bracket'), hashtext(v_season_id::text));

  PERFORM 1
    FROM public.matchups AS matchup
   WHERE matchup.league_season_id = v_season_id
     AND matchup.matchup_type IN ('playoff_quarterfinal'::public.matchup_type, 'playoff_semifinal'::public.matchup_type)
   FOR UPDATE;

  IF FOUND THEN
    RETURN jsonb_build_object('inserted', 0, 'skipped', true);
  END IF;

  PERFORM 1
    FROM public.matchups AS matchup
   WHERE matchup.league_season_id = v_season_id
     AND matchup.matchup_type = 'regular_season'::public.matchup_type
     AND matchup.week_number < v_playoff_start_week
     AND matchup.is_finalized = false
   FOR UPDATE;

  IF FOUND THEN
    RAISE EXCEPTION 'Regular season matchups must be finalized before generating playoffs.';
  END IF;

  PERFORM 1
    FROM public.matchups AS matchup
   WHERE matchup.league_season_id = v_season_id
     AND matchup.matchup_type = 'regular_season'::public.matchup_type
     AND matchup.week_number < v_playoff_start_week
     AND matchup.is_finalized = true
   FOR UPDATE;

  SELECT count(*)
    INTO v_member_count
    FROM public.league_members AS member
   WHERE member.league_id = p_league_id;

  IF v_member_count < 4 THEN
    RAISE EXCEPTION 'Not enough teams to seed playoffs (need 4).';
  END IF;

  v_playoff_size := CASE WHEN v_member_count >= 10 THEN 6 ELSE 4 END;

  v_rounds := private.playoff_round_plan(v_member_count, v_league.playoff_total_weeks, v_league.playoff_round_weeks);
  PERFORM private.assert_playoff_window(v_season_year, v_playoff_start_week, v_rounds);
  UPDATE public.league_seasons
     SET playoff_start_week = v_playoff_start_week, playoff_round_weeks = v_rounds
   WHERE id = v_season_id;

  SELECT array_agg(seed.member_id ORDER BY seed.seed_rank)
    INTO v_seed_ids
    FROM private.playoff_seed_rankings(p_league_id, v_season_id, v_playoff_start_week) AS seed;

  UPDATE public.league_seasons SET playoff_seed_member_ids = v_seed_ids[1:v_playoff_size]
    WHERE id = v_season_id;

  FOR v_pair IN
    SELECT
      a.member_id AS member_a_id,
      b.member_id AS member_b_id,
      CASE
        WHEN a.tie_token < b.tie_token OR (a.tie_token = b.tie_token AND a.member_id < b.member_id) THEN a.member_id
        ELSE b.member_id
      END AS winner_member_id
    FROM private.playoff_seed_rankings(p_league_id, v_season_id, v_playoff_start_week) AS a
    JOIN private.playoff_seed_rankings(p_league_id, v_season_id, v_playoff_start_week) AS b
      ON b.seed_rank > a.seed_rank
     AND b.wins = a.wins
     AND b.points_for = a.points_for
     AND b.max_possible_points = a.max_possible_points
     AND b.points_against = a.points_against
    WHERE a.group_start <= v_playoff_size
  LOOP
    SELECT *
      INTO v_existing_challenge
      FROM public.rps_challenges AS challenge
     WHERE challenge.league_id = p_league_id
       AND challenge.league_season_id = v_season_id
       AND challenge.context = 'standings_playoff_tiebreaker'
       AND LEAST(challenge.member_a_id, challenge.member_b_id) = LEAST(v_pair.member_a_id, v_pair.member_b_id)
       AND GREATEST(challenge.member_a_id, challenge.member_b_id) = GREATEST(v_pair.member_a_id, v_pair.member_b_id)
     FOR UPDATE;

    IF FOUND THEN
      UPDATE public.rps_challenges
         SET winner_member_id = v_pair.winner_member_id,
             member_a_choice = NULL,
             member_b_choice = NULL,
             status = 'completed'::public.rps_status,
             resolved_at = now()
       WHERE id = v_existing_challenge.id;
    ELSE
      INSERT INTO public.rps_challenges (
        league_id,
        league_season_id,
        member_a_id,
        member_b_id,
        winner_member_id,
        status,
        context,
        resolved_at
      )
      VALUES (
        p_league_id,
        v_season_id,
        v_pair.member_a_id,
        v_pair.member_b_id,
        v_pair.winner_member_id,
        'completed'::public.rps_status,
        'standings_playoff_tiebreaker',
        now()
      );
    END IF;
  END LOOP;

  IF v_playoff_size >= 6 THEN
    WITH inserted AS (
      INSERT INTO public.matchups (
        league_id,
        league_season_id,
        week_number,
        end_week_number,
        matchup_type,
        home_member_id,
        away_member_id
      )
      VALUES
        (p_league_id, v_season_id, v_playoff_start_week, v_playoff_start_week + v_rounds[1] - 1, 'playoff_quarterfinal'::public.matchup_type, v_seed_ids[3], v_seed_ids[6]),
        (p_league_id, v_season_id, v_playoff_start_week, v_playoff_start_week + v_rounds[1] - 1, 'playoff_quarterfinal'::public.matchup_type, v_seed_ids[4], v_seed_ids[5])
      ON CONFLICT (league_id, league_season_id, week_number, home_member_id, away_member_id)
      DO NOTHING
      RETURNING 1
    )
    SELECT count(*) INTO v_inserted_count FROM inserted;
  ELSE
    WITH inserted AS (
      INSERT INTO public.matchups (
        league_id,
        league_season_id,
        week_number,
        end_week_number,
        matchup_type,
        home_member_id,
        away_member_id
      )
      VALUES
        (p_league_id, v_season_id, v_playoff_start_week, v_playoff_start_week + v_rounds[1] - 1, 'playoff_semifinal'::public.matchup_type, v_seed_ids[1], v_seed_ids[4]),
        (p_league_id, v_season_id, v_playoff_start_week, v_playoff_start_week + v_rounds[1] - 1, 'playoff_semifinal'::public.matchup_type, v_seed_ids[2], v_seed_ids[3])
      ON CONFLICT (league_id, league_season_id, week_number, home_member_id, away_member_id)
      DO NOTHING
      RETURNING 1
    )
    SELECT count(*) INTO v_inserted_count FROM inserted;
  END IF;

  RETURN jsonb_build_object('inserted', v_inserted_count, 'skipped', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.advance_playoff_bracket_atomic(
  p_league_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_season_id uuid;
  v_season_year int;
  v_rounds int[];
  v_next_start int;
  v_next_end int;
  v_quarterfinal_count int;
  v_quarterfinal_week int;
  v_quarterfinal_winners uuid[];
  v_quarterfinals_ready boolean;
  v_semifinal_count int;
  v_semifinal_week int;
  v_semifinal_winners uuid[];
  v_semifinals_ready boolean;
  v_seed_ids uuid[];
  v_inserted_count int := 0;
BEGIN
  PERFORM 1 FROM public.leagues WHERE id = p_league_id FOR UPDATE;
  SELECT id, season_year, playoff_round_weeks, playoff_seed_member_ids INTO v_season_id, v_season_year, v_rounds, v_seed_ids
    FROM public.league_seasons WHERE league_id = p_league_id AND is_current FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Current league season not found for playoff advancement.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('playoff-bracket'), hashtext(v_season_id::text));

  PERFORM 1
    FROM public.matchups AS matchup
   WHERE matchup.league_season_id = v_season_id
     AND matchup.matchup_type = 'playoff_final'::public.matchup_type
   FOR UPDATE;

  IF FOUND THEN
    RETURN jsonb_build_object('inserted', 0, 'skipped', true);
  END IF;

  SELECT count(*), min(week_number), array_agg(winner_member_id ORDER BY created_at, id), bool_and(is_finalized AND winner_member_id IS NOT NULL)
    INTO v_quarterfinal_count, v_quarterfinal_week, v_quarterfinal_winners, v_quarterfinals_ready
    FROM (
      SELECT *
        FROM public.matchups AS matchup
       WHERE matchup.league_season_id = v_season_id
         AND matchup.matchup_type = 'playoff_quarterfinal'::public.matchup_type
       ORDER BY matchup.created_at, matchup.id
       FOR UPDATE
    ) AS quarterfinals;

  PERFORM 1
    FROM public.matchups AS matchup
   WHERE matchup.league_season_id = v_season_id
     AND matchup.matchup_type = 'playoff_semifinal'::public.matchup_type
   FOR UPDATE;

  IF v_quarterfinal_count > 0 AND NOT FOUND THEN
    IF v_quarterfinal_count < 2 OR v_quarterfinals_ready IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Quarterfinals are not yet finalized.';
    END IF;

    PERFORM 1
      FROM public.matchups AS matchup
     WHERE matchup.league_season_id = v_season_id
       AND matchup.matchup_type = 'regular_season'::public.matchup_type
       AND matchup.week_number < v_quarterfinal_week
       AND matchup.is_finalized = true
     FOR UPDATE;

    IF v_seed_ids IS NULL THEN
      SELECT array_agg(seed.member_id ORDER BY seed.seed_rank)
        INTO v_seed_ids
        FROM private.playoff_seed_rankings(p_league_id, v_season_id, v_quarterfinal_week) AS seed;
    END IF;

    -- Generated quarterfinals have seed 3 and seed 4 at home. Preserve
    -- those bracket branches regardless of row IDs or which team wins.
    SELECT array_agg(matchup.winner_member_id ORDER BY array_position(v_seed_ids, matchup.home_member_id))
      INTO v_quarterfinal_winners
      FROM public.matchups AS matchup
     WHERE matchup.league_season_id = v_season_id
       AND matchup.matchup_type = 'playoff_quarterfinal'::public.matchup_type;

    SELECT max(COALESCE(end_week_number, week_number)) + 1 INTO v_next_start
      FROM public.matchups WHERE league_season_id = v_season_id AND matchup_type = 'playoff_quarterfinal';
    v_next_end := v_next_start + COALESCE(v_rounds[2], 1) - 1;
    PERFORM private.assert_playoff_window(v_season_year, v_next_start, ARRAY[COALESCE(v_rounds[2], 1), COALESCE(v_rounds[3], 1)]);

    WITH inserted AS (
      INSERT INTO public.matchups (
        league_id,
        league_season_id,
        week_number,
        end_week_number,
        matchup_type,
        home_member_id,
        away_member_id
      )
      VALUES
        (p_league_id, v_season_id, v_next_start, v_next_end, 'playoff_semifinal'::public.matchup_type, v_seed_ids[1], v_quarterfinal_winners[2]),
        (p_league_id, v_season_id, v_next_start, v_next_end, 'playoff_semifinal'::public.matchup_type, v_seed_ids[2], v_quarterfinal_winners[1])
      ON CONFLICT (league_id, league_season_id, week_number, home_member_id, away_member_id)
      DO NOTHING
      RETURNING 1
    )
    SELECT count(*) INTO v_inserted_count FROM inserted;

    RETURN jsonb_build_object('inserted', v_inserted_count, 'skipped', false);
  END IF;

  SELECT count(*), max(week_number), array_agg(winner_member_id ORDER BY created_at, id), bool_and(is_finalized AND winner_member_id IS NOT NULL)
    INTO v_semifinal_count, v_semifinal_week, v_semifinal_winners, v_semifinals_ready
    FROM (
      SELECT *
        FROM public.matchups AS matchup
       WHERE matchup.league_season_id = v_season_id
         AND matchup.matchup_type = 'playoff_semifinal'::public.matchup_type
       ORDER BY matchup.created_at, matchup.id
       FOR UPDATE
    ) AS semifinals;

  IF v_semifinal_count < 2 THEN
    RAISE EXCEPTION 'Semifinals not found.';
  END IF;

  IF v_semifinals_ready IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Semifinals are not yet finalized.';
  END IF;

  SELECT max(COALESCE(end_week_number, week_number)) + 1 INTO v_next_start
    FROM public.matchups WHERE league_season_id = v_season_id AND matchup_type = 'playoff_semifinal';
  v_next_end := v_next_start + COALESCE(v_rounds[cardinality(v_rounds)], 1) - 1;
  PERFORM private.assert_playoff_window(v_season_year, v_next_start, ARRAY[COALESCE(v_rounds[cardinality(v_rounds)], 1)]);

  WITH inserted AS (
    INSERT INTO public.matchups (
      league_id,
      league_season_id,
      week_number,
      end_week_number,
      matchup_type,
      home_member_id,
      away_member_id
    )
    VALUES (
      p_league_id,
      v_season_id,
      v_next_start,
      v_next_end,
      'playoff_final'::public.matchup_type,
      v_semifinal_winners[1],
      v_semifinal_winners[2]
    )
    ON CONFLICT (league_id, league_season_id, week_number, home_member_id, away_member_id)
    DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_inserted_count FROM inserted;

  RETURN jsonb_build_object('inserted', v_inserted_count, 'skipped', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.prevent_playoff_start_week_change_after_bracket()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_season public.league_seasons%ROWTYPE;
  v_rounds int[];
  v_members int;
  v_had_schedule boolean;
  v_had_bracket boolean;
BEGIN
  -- The league UPDATE already holds the first lock. Every schedule writer
  -- takes league, season, advisory locks, then matchup rows in that order.
  SELECT * INTO v_season FROM public.league_seasons
   WHERE league_id = NEW.id AND is_current FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Current league season not found. Playoff settings were not changed.';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('regular-season-matchups'), hashtext(v_season.id::text));
  PERFORM pg_advisory_xact_lock(hashtext('playoff-bracket'), hashtext(v_season.id::text));
  PERFORM 1 FROM public.matchups WHERE league_season_id = v_season.id FOR UPDATE;
  v_had_schedule := FOUND;
  SELECT EXISTS (SELECT 1 FROM public.matchups WHERE league_season_id = v_season.id AND matchup_type <> 'regular_season') INTO v_had_bracket;
  PERFORM private.assert_schedule_not_started(v_season.id);
  SELECT count(*) INTO v_members FROM public.league_members WHERE league_id = NEW.id;
  v_rounds := private.playoff_round_plan(v_members, NEW.playoff_total_weeks, NEW.playoff_round_weeks);
  PERFORM private.assert_playoff_window(v_season.season_year, NEW.playoff_start_week, v_rounds, true);
  UPDATE public.league_seasons
     SET playoff_start_week = NEW.playoff_start_week, playoff_round_weeks = NULL, playoff_seed_member_ids = NULL
   WHERE id = v_season.id;
  IF v_had_schedule THEN
    DELETE FROM public.matchups WHERE league_season_id = v_season.id;
    -- A changed future schedule gets fresh standings tie evidence at seeding.
    DELETE FROM public.rps_challenges WHERE league_season_id = v_season.id AND context = 'standings_playoff_tiebreaker';
    PERFORM public.replace_regular_season_matchups_atomic(NEW.id, v_season.id, false,
      private.regular_season_matchup_payload(NEW.id, v_season.id, NEW.playoff_start_week - 1));
    IF v_had_bracket AND NEW.playoff_start_week = 1 THEN
      PERFORM public.generate_playoff_bracket_atomic(NEW.id);
    ELSIF v_had_bracket AND NEW.status = 'playoffs' THEN
      UPDATE public.leagues SET status = 'active' WHERE id = NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
