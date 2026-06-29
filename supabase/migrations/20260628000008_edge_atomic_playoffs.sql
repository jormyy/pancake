-- Keep playoff bracket decisions and writes inside one SQL transaction.

CREATE OR REPLACE FUNCTION private.playoff_seed_rankings(
  p_league_id uuid,
  p_league_season_id uuid,
  p_playoff_start_week int
)
RETURNS TABLE (
  member_id uuid,
  wins bigint,
  points_for numeric,
  max_possible_points numeric,
  points_against numeric,
  tie_token text,
  seed_rank bigint,
  group_start bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH member_stats AS (
    SELECT
      member.id AS member_id,
      count(*) FILTER (WHERE matchup.winner_member_id = member.id) AS wins,
      COALESCE(sum(CASE
        WHEN matchup.home_member_id = member.id THEN matchup.home_points
        WHEN matchup.away_member_id = member.id THEN matchup.away_points
        ELSE 0
      END), 0) AS points_for,
      COALESCE(sum(CASE
        WHEN matchup.home_member_id = member.id THEN matchup.home_max_possible_points
        WHEN matchup.away_member_id = member.id THEN matchup.away_max_possible_points
        ELSE 0
      END), 0) AS max_possible_points,
      COALESCE(sum(CASE
        WHEN matchup.home_member_id = member.id THEN matchup.away_points
        WHEN matchup.away_member_id = member.id THEN matchup.home_points
        ELSE 0
      END), 0) AS points_against,
      encode(extensions.digest((p_league_season_id::text || ':' || member.id::text)::bytea, 'sha256'), 'hex') AS tie_token
    FROM public.league_members AS member
    LEFT JOIN public.matchups AS matchup
      ON matchup.league_season_id = p_league_season_id
     AND matchup.matchup_type = 'regular_season'::public.matchup_type
     AND matchup.week_number < p_playoff_start_week
     AND matchup.is_finalized = true
     AND member.id IN (matchup.home_member_id, matchup.away_member_id)
    WHERE member.league_id = p_league_id
    GROUP BY member.id
  ),
  ranked AS (
    SELECT
      member_stats.*,
      row_number() OVER (
        ORDER BY wins DESC, points_for DESC, max_possible_points DESC, points_against ASC, tie_token ASC, member_id ASC
      ) AS seed_rank
    FROM member_stats
  )
  SELECT
    ranked.*,
    min(seed_rank) OVER (
      PARTITION BY wins, points_for, max_possible_points, points_against
    ) AS group_start
  FROM ranked;
$$;

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
  v_playoff_start_week int;
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
  SELECT season.id, COALESCE(league.playoff_start_week, 20)
    INTO v_season_id, v_playoff_start_week
    FROM public.league_seasons AS season
    JOIN public.leagues AS league
      ON league.id = season.league_id
   WHERE season.league_id = p_league_id
     AND season.is_current = true
   FOR UPDATE OF season, league;

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

    SELECT array_agg(seed.member_id ORDER BY seed.seed_rank)
      INTO v_seed_ids
      FROM private.playoff_seed_rankings(p_league_id, v_season_id, v_quarterfinal_week) AS seed;

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
        (p_league_id, v_season_id, v_quarterfinal_week + 1, 'playoff_semifinal'::public.matchup_type, v_seed_ids[1], v_quarterfinal_winners[2]),
        (p_league_id, v_season_id, v_quarterfinal_week + 1, 'playoff_semifinal'::public.matchup_type, v_seed_ids[2], v_quarterfinal_winners[1])
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

  WITH inserted AS (
    INSERT INTO public.matchups (
      league_id,
      league_season_id,
      week_number,
      matchup_type,
      home_member_id,
      away_member_id
    )
    VALUES (
      p_league_id,
      v_season_id,
      v_semifinal_week + 1,
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

DROP FUNCTION IF EXISTS public.insert_playoff_matchups_atomic(uuid, uuid, jsonb, jsonb, jsonb);

REVOKE ALL ON FUNCTION private.playoff_seed_rankings(uuid, uuid, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.playoff_seed_rankings(uuid, uuid, int) FROM anon;
REVOKE ALL ON FUNCTION private.playoff_seed_rankings(uuid, uuid, int) FROM authenticated;
GRANT EXECUTE ON FUNCTION private.playoff_seed_rankings(uuid, uuid, int) TO service_role;

REVOKE ALL ON FUNCTION public.generate_playoff_bracket_atomic(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.generate_playoff_bracket_atomic(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.generate_playoff_bracket_atomic(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.generate_playoff_bracket_atomic(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.advance_playoff_bracket_atomic(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.advance_playoff_bracket_atomic(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.advance_playoff_bracket_atomic(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.advance_playoff_bracket_atomic(uuid) TO service_role;
