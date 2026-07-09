-- Canonical SQL source for public.generate_playoff_bracket_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
  v_last_week int;
  v_seed_ids uuid[];
  v_inserted_count int := 0;
  v_pair record;
  v_existing_challenge public.rps_challenges%ROWTYPE;
BEGIN
  SELECT season.id, season.season_year, COALESCE(league.playoff_start_week, 20)
    INTO v_season_id, v_season_year, v_playoff_start_week
    FROM public.league_seasons AS season
    JOIN public.leagues AS league
      ON league.id = season.league_id
   WHERE season.league_id = p_league_id
     AND season.is_current = true
   FOR UPDATE OF season, league;

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

  SELECT max(week_number)
    INTO v_last_week
    FROM public.season_weeks
   WHERE season_year = v_season_year;

  IF COALESCE(v_last_week, 0) < v_playoff_start_week + (CASE WHEN v_playoff_size >= 6 THEN 3 ELSE 2 END) - 1 THEN
    RAISE EXCEPTION 'Playoff start week does not leave enough season weeks for every playoff round.';
  END IF;

  SELECT array_agg(seed.member_id ORDER BY seed.seed_rank)
    INTO v_seed_ids
    FROM private.playoff_seed_rankings(p_league_id, v_season_id, v_playoff_start_week) AS seed;

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
        matchup_type,
        home_member_id,
        away_member_id
      )
      VALUES
        (p_league_id, v_season_id, v_playoff_start_week, 'playoff_quarterfinal'::public.matchup_type, v_seed_ids[3], v_seed_ids[6]),
        (p_league_id, v_season_id, v_playoff_start_week, 'playoff_quarterfinal'::public.matchup_type, v_seed_ids[4], v_seed_ids[5])
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
        matchup_type,
        home_member_id,
        away_member_id
      )
      VALUES
        (p_league_id, v_season_id, v_playoff_start_week, 'playoff_semifinal'::public.matchup_type, v_seed_ids[1], v_seed_ids[4]),
        (p_league_id, v_season_id, v_playoff_start_week, 'playoff_semifinal'::public.matchup_type, v_seed_ids[2], v_seed_ids[3])
      ON CONFLICT (league_id, league_season_id, week_number, home_member_id, away_member_id)
      DO NOTHING
      RETURNING 1
    )
    SELECT count(*) INTO v_inserted_count FROM inserted;
  END IF;

  RETURN jsonb_build_object('inserted', v_inserted_count, 'skipped', false);
END;
$$;
