-- Explicit playoff windows; null duration preserves legacy one-week rounds.
-- Existing leagues, matchups, scores and schedules are not rewritten.
ALTER TABLE public.leagues DROP CONSTRAINT leagues_playoff_start_week_check;
ALTER TABLE public.leagues ADD CONSTRAINT leagues_playoff_start_week_check CHECK (playoff_start_week > 0);
ALTER TABLE public.leagues ADD COLUMN playoff_total_weeks int;
ALTER TABLE public.leagues ADD COLUMN playoff_round_weeks int[];
ALTER TABLE public.leagues ADD CONSTRAINT leagues_playoff_duration_check CHECK (
  (playoff_total_weeks IS NULL AND playoff_round_weeks IS NULL) OR
  (playoff_total_weeks > 0 AND playoff_total_weeks IS NOT NULL AND playoff_round_weeks IS NOT NULL
   AND array_ndims(playoff_round_weeks) = 1 AND array_lower(playoff_round_weeks, 1) = 1
   AND cardinality(playoff_round_weeks) IN (2, 3) AND 0 < ALL(playoff_round_weeks)
   AND array_position(playoff_round_weeks, NULL) IS NULL
   AND playoff_total_weeks::bigint = playoff_round_weeks[1]::bigint + playoff_round_weeks[2] + COALESCE(playoff_round_weeks[3], 0))
);
ALTER TABLE public.league_seasons ADD COLUMN playoff_start_week int CHECK (playoff_start_week > 0);
ALTER TABLE public.league_seasons ADD COLUMN playoff_round_weeks int[];
ALTER TABLE public.matchups ADD COLUMN end_week_number int;
ALTER TABLE public.matchups ADD CONSTRAINT matchups_end_week_check CHECK (
  end_week_number IS NULL OR (end_week_number >= week_number AND
    (matchup_type <> 'regular_season' OR end_week_number = week_number))
);

CREATE OR REPLACE FUNCTION private.playoff_round_plan(p_member_count int, p_total int, p_rounds int[])
RETURNS int[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_round_count int := CASE WHEN p_member_count >= 10 THEN 3 ELSE 2 END;
BEGIN
  IF p_total IS NULL AND p_rounds IS NULL THEN
    RETURN array_fill(1, ARRAY[v_round_count]);
  END IF;
  IF p_total IS NULL OR p_rounds IS NULL
     OR array_ndims(p_rounds) IS DISTINCT FROM 1
     OR array_lower(p_rounds, 1) IS DISTINCT FROM 1
     OR cardinality(p_rounds) <> v_round_count
     OR EXISTS (SELECT 1 FROM unnest(p_rounds) AS value WHERE value IS NULL OR value < 1)
     OR (SELECT sum(value::bigint) FROM unnest(p_rounds) AS value) IS DISTINCT FROM p_total::bigint THEN
    RAISE EXCEPTION 'Playoffs need % rounds. Enter positive whole weeks for each round, adding up to total playoff weeks.', v_round_count
      USING ERRCODE = '22023';
  END IF;
  RETURN p_rounds;
END;
$$;

CREATE OR REPLACE FUNCTION private.assert_playoff_window(p_year int, p_start int, p_rounds int[], p_include_regular boolean DEFAULT false)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_end bigint := p_start::bigint + (SELECT sum(value::bigint) FROM unnest(p_rounds) AS value) - 1;
  v_first int := CASE WHEN p_include_regular THEN 1 ELSE p_start END;
  v_max int;
  v_count int;
BEGIN
  SELECT max(week_number) INTO v_max FROM public.season_weeks WHERE season_year = p_year;
  IF v_max IS NULL THEN
    RAISE EXCEPTION 'The season % calendar is unavailable. Playoff settings were not changed.', p_year USING ERRCODE = '22023';
  END IF;
  IF p_start IS NULL OR p_start < 1 OR v_end IS NULL OR v_end > v_max OR v_end < p_start THEN
    RAISE EXCEPTION 'Playoffs must start at a positive whole week and finish by week % in season %.', v_max, p_year USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_count FROM public.season_weeks
   WHERE season_year = p_year AND week_number BETWEEN v_first AND v_end;
  IF v_count <> v_end - v_first + 1 THEN
    RAISE EXCEPTION 'The season % calendar has a missing week in the requested schedule (% through %).', p_year, v_first, v_end USING ERRCODE = '22023';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.assert_schedule_not_started(p_season_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.matchups AS matchup
     JOIN public.league_seasons AS season ON season.id = matchup.league_season_id
     LEFT JOIN public.season_weeks AS week ON week.season_year = season.season_year AND week.week_number = matchup.week_number
    WHERE matchup.league_season_id = p_season_id
      AND (matchup.is_finalized OR matchup.winner_member_id IS NOT NULL
           OR COALESCE(matchup.home_points, 0) <> 0 OR COALESCE(matchup.away_points, 0) <> 0
           OR week.id IS NULL OR week.week_start <= (now() AT TIME ZONE 'America/New_York')::date)
  ) THEN
    RAISE EXCEPTION 'The current schedule has started or its dates are unavailable. Playoff settings and existing matchups cannot change.' USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.regular_season_matchup_payload(p_league_id uuid, p_season_id uuid, p_weeks int)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_members uuid[];
  v_count int;
  v_round int;
  v_week int;
  v_pair int;
  v_home uuid;
  v_away uuid;
  v_rows jsonb := '[]'::jsonb;
BEGIN
  SELECT array_agg(id ORDER BY joined_at, id) INTO v_members FROM public.league_members WHERE league_id = p_league_id;
  v_count := COALESCE(cardinality(v_members), 0);
  IF v_count < 2 OR p_weeks < 1 THEN RETURN v_rows; END IF;
  IF v_count % 2 = 1 THEN
    v_members := array_append(v_members, NULL::uuid);
    v_count := v_count + 1;
  END IF;
  -- Same fixed-team rotation as roundRobinRounds in matchupGeneration.ts.
  FOR v_week IN 1..p_weeks LOOP
    v_round := (v_week - 1) % (v_count - 1);
    FOR v_pair IN 0..(v_count / 2 - 1) LOOP
      v_home := CASE WHEN v_pair = 0 THEN v_members[1] ELSE v_members[2 + (v_pair - 1 + v_round) % (v_count - 1)] END;
      v_away := v_members[2 + (v_count - 2 - v_pair + v_round) % (v_count - 1)];
      IF v_home IS NOT NULL AND v_away IS NOT NULL THEN
        v_rows := v_rows || jsonb_build_array(jsonb_build_object(
          'league_id', p_league_id, 'league_season_id', p_season_id,
          'week_number', v_week, 'matchup_type', 'regular_season',
          'home_member_id', v_home, 'away_member_id', v_away));
      END IF;
    END LOOP;
  END LOOP;
  RETURN v_rows;
END;
$$;

CREATE OR REPLACE FUNCTION public.replace_regular_season_matchups_atomic(
  p_league_id uuid,
  p_league_season_id uuid,
  p_force boolean DEFAULT false,
  p_matchups jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing_count int;
  v_start int;
  v_member_count int;
  v_inserted_count int := 0;
BEGIN
  IF p_matchups IS NULL OR jsonb_typeof(p_matchups) <> 'array' THEN
    RAISE EXCEPTION 'p_matchups must be a JSON array.';
  END IF;

  SELECT playoff_start_week INTO v_start FROM public.leagues WHERE id = p_league_id FOR UPDATE;

  PERFORM 1
    FROM public.league_seasons AS season
   WHERE season.id = p_league_season_id
     AND season.league_id = p_league_id
     AND season.is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Current league season not found for matchup generation.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('regular-season-matchups'), hashtext(p_league_season_id::text));

  IF EXISTS (
    SELECT 1
      FROM jsonb_to_recordset(p_matchups) AS requested(
        league_id uuid,
        league_season_id uuid,
        week_number int,
        matchup_type text,
        home_member_id uuid,
        away_member_id uuid
      )
     WHERE requested.league_id IS DISTINCT FROM p_league_id
        OR requested.league_season_id IS DISTINCT FROM p_league_season_id
        OR requested.week_number IS NULL
        OR requested.week_number < 1
        OR requested.week_number >= v_start
        OR requested.matchup_type IS DISTINCT FROM 'regular_season'
        OR requested.home_member_id IS NULL
        OR requested.away_member_id IS NULL
        OR requested.home_member_id = requested.away_member_id
        OR NOT EXISTS (
          SELECT 1
            FROM public.league_members AS member
           WHERE member.id = requested.home_member_id
             AND member.league_id = p_league_id
        )
        OR NOT EXISTS (
          SELECT 1
            FROM public.league_members AS member
           WHERE member.id = requested.away_member_id
             AND member.league_id = p_league_id
        )
  ) THEN
    RAISE EXCEPTION 'p_matchups contains invalid regular-season rows.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_to_recordset(p_matchups) AS requested(
        league_id uuid,
        league_season_id uuid,
        week_number int,
        matchup_type text,
        home_member_id uuid,
        away_member_id uuid
      )
     GROUP BY
        requested.league_id,
        requested.league_season_id,
        requested.week_number,
        requested.matchup_type,
        LEAST(requested.home_member_id::text, requested.away_member_id::text),
        GREATEST(requested.home_member_id::text, requested.away_member_id::text)
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'p_matchups contains duplicate weekly pairings.';
  END IF;

  SELECT count(*) INTO v_member_count FROM public.league_members WHERE league_id = p_league_id;
  IF v_member_count >= 2 AND (
    (SELECT count(DISTINCT (value->>'week_number')::int) FROM jsonb_array_elements(p_matchups)) <> v_start - 1
    OR jsonb_array_length(p_matchups) <> (v_start - 1)::bigint * (v_member_count / 2)
  ) THEN
    RAISE EXCEPTION 'The proposed regular schedule does not match the saved playoff start. Reload settings and retry.';
  END IF;

  SELECT count(*)
    INTO v_existing_count
    FROM public.matchups
   WHERE league_season_id = p_league_season_id;

  IF v_existing_count > 0 AND p_force IS DISTINCT FROM true THEN
    RETURN jsonb_build_object('inserted', 0, 'skipped', true);
  END IF;

  IF v_existing_count > 0 THEN
    PERFORM private.assert_schedule_not_started(p_league_season_id);
    IF EXISTS (
      SELECT 1
        FROM public.matchups
       WHERE league_season_id = p_league_season_id
         AND (
           is_finalized = true
           OR matchup_type IN (
             'playoff_quarterfinal'::public.matchup_type,
             'playoff_semifinal'::public.matchup_type,
             'playoff_final'::public.matchup_type
           )
         )
    ) THEN
      RAISE EXCEPTION 'Cannot force-regenerate matchups after finalized or playoff matchups exist.';
    END IF;

    DELETE FROM public.matchups
     WHERE league_season_id = p_league_season_id;
  END IF;

  WITH requested AS (
    SELECT *
      FROM jsonb_to_recordset(p_matchups) AS requested(
        league_id uuid,
        league_season_id uuid,
        week_number int,
        matchup_type text,
        home_member_id uuid,
        away_member_id uuid
      )
  ),
  inserted AS (
    INSERT INTO public.matchups (
      league_id,
      league_season_id,
      week_number,
      matchup_type,
      home_member_id,
      away_member_id
    )
    SELECT
      requested.league_id,
      requested.league_season_id,
      requested.week_number,
      requested.matchup_type::public.matchup_type,
      requested.home_member_id,
      requested.away_member_id
    FROM requested
    ON CONFLICT (league_id, league_season_id, week_number, home_member_id, away_member_id)
    DO NOTHING
    RETURNING 1
  )
  SELECT count(*)
    INTO v_inserted_count
    FROM inserted;

  RETURN jsonb_build_object('inserted', v_inserted_count, 'skipped', false);
END;
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
  SELECT id, season_year, playoff_round_weeks INTO v_season_id, v_season_year, v_rounds
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

    SELECT array_agg(seed.member_id ORDER BY seed.seed_rank)
      INTO v_seed_ids
      FROM private.playoff_seed_rankings(p_league_id, v_season_id, v_quarterfinal_week) AS seed;

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
     SET playoff_start_week = NEW.playoff_start_week, playoff_round_weeks = NULL
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

CREATE OR REPLACE FUNCTION public.update_league_settings_atomic(
  p_league_id uuid,
  p_settings jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_league public.leagues%ROWTYPE;
  v_user_id uuid := (SELECT auth.uid());
  v_touches_structural boolean;
  v_scoring_settings jsonb;
  v_roster_size int;
  v_ir_slots int;
  v_taxi_slots int;
  v_auction_budget int;
  v_playoff_start_week int;
  v_playoff_total_weeks int;
  v_playoff_round_weeks int[];
  v_trade_deadline date;
  v_trade_deadline_set boolean := false;
  v_trade_deadline_text text;
  v_season_year int;
  v_weekly_add_limit int;
  v_weekly_add_unlimited boolean;
  v_waiver_mode text;
  v_faab_starting_budget int;
  v_trade_veto_mode text;
  v_trade_veto_window_hours int;
  v_trade_veto_threshold_percent int;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.'
      USING ERRCODE = '42501';
  END IF;

  IF p_settings IS NULL OR jsonb_typeof(p_settings) <> 'object' THEN
    RAISE EXCEPTION 'p_settings must be a JSON object.'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_league
    FROM public.leagues
   WHERE id = p_league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT private.is_commissioner(p_league_id) THEN
    RAISE EXCEPTION 'Only the league commissioner can change settings.'
      USING ERRCODE = '42501';
  END IF;

  IF p_settings ? 'scoring_settings' AND jsonb_typeof(p_settings -> 'scoring_settings') = 'object' THEN
    v_scoring_settings := p_settings -> 'scoring_settings';
  END IF;

  IF p_settings ? 'roster_size' AND jsonb_typeof(p_settings -> 'roster_size') = 'number' THEN
    v_roster_size := (p_settings ->> 'roster_size')::int;
    IF v_roster_size <= 0 THEN
      RAISE EXCEPTION 'roster_size must be a positive integer.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'ir_slots' AND jsonb_typeof(p_settings -> 'ir_slots') = 'number' THEN
    v_ir_slots := (p_settings ->> 'ir_slots')::int;
    IF v_ir_slots < 0 THEN
      RAISE EXCEPTION 'ir_slots must be a non-negative integer.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'taxi_slots' AND jsonb_typeof(p_settings -> 'taxi_slots') = 'number' THEN
    v_taxi_slots := (p_settings ->> 'taxi_slots')::int;
    IF v_taxi_slots < 0 THEN
      RAISE EXCEPTION 'taxi_slots must be a non-negative integer.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'auction_budget' AND jsonb_typeof(p_settings -> 'auction_budget') = 'number' THEN
    v_auction_budget := (p_settings ->> 'auction_budget')::int;
    IF v_auction_budget <= 0 THEN
      RAISE EXCEPTION 'auction_budget must be a positive integer.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'playoff_start_week' THEN
    IF jsonb_typeof(p_settings -> 'playoff_start_week') <> 'number'
       OR (p_settings ->> 'playoff_start_week') !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'Playoff start week must be a positive whole number.' USING ERRCODE = '22023';
    END IF;
    v_playoff_start_week := (p_settings ->> 'playoff_start_week')::int;
    IF v_playoff_start_week <= 0 THEN
      RAISE EXCEPTION 'playoff_start_week must be a positive integer.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'playoff_total_weeks' THEN
    IF jsonb_typeof(p_settings -> 'playoff_total_weeks') <> 'number'
       OR (p_settings ->> 'playoff_total_weeks') !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'Total playoff weeks must be a positive whole number.' USING ERRCODE = '22023';
    END IF;
    v_playoff_total_weeks := (p_settings ->> 'playoff_total_weeks')::int;
    IF v_playoff_total_weeks < 1 THEN
      RAISE EXCEPTION 'Total playoff weeks must be a positive whole number.' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF p_settings ? 'playoff_round_weeks' THEN
    IF jsonb_typeof(p_settings -> 'playoff_round_weeks') <> 'array' THEN
      RAISE EXCEPTION 'Enter positive whole weeks for each playoff round.' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_settings -> 'playoff_round_weeks') AS value
      WHERE jsonb_typeof(value) <> 'number' OR value::text !~ '^[0-9]+$') THEN
      RAISE EXCEPTION 'Enter positive whole weeks for each playoff round.' USING ERRCODE = '22023';
    END IF;
    SELECT array_agg(value::text::int ORDER BY ordinality) INTO v_playoff_round_weeks
      FROM jsonb_array_elements(p_settings -> 'playoff_round_weeks') WITH ORDINALITY AS entry(value, ordinality);
    IF v_playoff_round_weeks IS NULL THEN
      RAISE EXCEPTION 'Enter positive whole weeks for each playoff round.' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- The deadline is a month and day ("MM-DD") that repeats every season; a
  -- full date keeps only its month and day. It is stored as the date inside
  -- the league's current season. JSON null removes it.
  IF p_settings ? 'trade_deadline' THEN
    v_trade_deadline_set := true;
    IF jsonb_typeof(p_settings -> 'trade_deadline') = 'string' THEN
      v_trade_deadline_text := trim(p_settings ->> 'trade_deadline');
      BEGIN
        IF v_trade_deadline_text ~ '^[0-9]{1,2}-[0-9]{1,2}$' THEN
          v_trade_deadline := make_date(
            2000,
            split_part(v_trade_deadline_text, '-', 1)::int,
            split_part(v_trade_deadline_text, '-', 2)::int
          );
        ELSE
          v_trade_deadline := v_trade_deadline_text::date;
        END IF;
      EXCEPTION WHEN data_exception THEN
        RAISE EXCEPTION 'trade_deadline must be a month and day such as 02-11.'
          USING ERRCODE = '22023';
      END;

      SELECT season.season_year
        INTO v_season_year
        FROM public.league_seasons AS season
       WHERE season.league_id = p_league_id
         AND season.is_current;
      v_trade_deadline := private.trade_deadline_for_season(
        v_trade_deadline,
        COALESCE(v_season_year, private.setup_season_year_et())
      );
    ELSIF jsonb_typeof(p_settings -> 'trade_deadline') <> 'null' THEN
      RAISE EXCEPTION 'trade_deadline must be a month and day such as 02-11, or null.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'weekly_add_unlimited' THEN
    IF jsonb_typeof(p_settings -> 'weekly_add_unlimited') <> 'boolean' THEN
      RAISE EXCEPTION 'weekly_add_unlimited must be a boolean.'
        USING ERRCODE = '22023';
    END IF;
    v_weekly_add_unlimited := (p_settings ->> 'weekly_add_unlimited')::boolean;
  END IF;

  IF p_settings ? 'weekly_add_limit' AND jsonb_typeof(p_settings -> 'weekly_add_limit') = 'number' THEN
    v_weekly_add_limit := (p_settings ->> 'weekly_add_limit')::int;
    IF v_weekly_add_limit < 1 THEN
      RAISE EXCEPTION 'weekly_add_limit must be at least 1, or use unlimited mode.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'waiver_mode' AND jsonb_typeof(p_settings -> 'waiver_mode') = 'string' THEN
    v_waiver_mode := p_settings ->> 'waiver_mode';
    IF v_waiver_mode NOT IN ('rolling', 'faab') THEN
      RAISE EXCEPTION 'waiver_mode must be rolling or faab.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'faab_starting_budget' AND jsonb_typeof(p_settings -> 'faab_starting_budget') = 'number' THEN
    v_faab_starting_budget := (p_settings ->> 'faab_starting_budget')::int;
    IF v_faab_starting_budget < 0 THEN
      RAISE EXCEPTION 'faab_starting_budget must be a non-negative integer.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'trade_veto_mode' AND jsonb_typeof(p_settings -> 'trade_veto_mode') = 'string' THEN
    v_trade_veto_mode := p_settings ->> 'trade_veto_mode';
    IF v_trade_veto_mode NOT IN ('disabled', 'commissioner', 'member_vote') THEN
      RAISE EXCEPTION 'trade_veto_mode must be disabled, commissioner, or member_vote.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'trade_veto_window_hours' AND jsonb_typeof(p_settings -> 'trade_veto_window_hours') = 'number' THEN
    v_trade_veto_window_hours := (p_settings ->> 'trade_veto_window_hours')::int;
    IF v_trade_veto_window_hours < 0 OR v_trade_veto_window_hours > 168 THEN
      RAISE EXCEPTION 'trade_veto_window_hours must be between 0 and 168.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'trade_veto_threshold_percent' AND jsonb_typeof(p_settings -> 'trade_veto_threshold_percent') = 'number' THEN
    v_trade_veto_threshold_percent := (p_settings ->> 'trade_veto_threshold_percent')::int;
    IF v_trade_veto_threshold_percent < 1 OR v_trade_veto_threshold_percent > 100 THEN
      RAISE EXCEPTION 'trade_veto_threshold_percent must be between 1 and 100.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  v_touches_structural :=
       v_scoring_settings IS NOT NULL
    OR v_roster_size IS NOT NULL
    OR v_ir_slots IS NOT NULL
    OR v_taxi_slots IS NOT NULL
    OR v_auction_budget IS NOT NULL;

  IF v_touches_structural
     AND v_league.status IS DISTINCT FROM 'setup'::public.league_status
  THEN
    RAISE EXCEPTION
      'Structural league settings (scoring_settings, roster_size, ir_slots, taxi_slots, auction_budget) can only be changed before the draft starts.'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.leagues
     SET scoring_settings = COALESCE(v_scoring_settings, scoring_settings),
         roster_size = COALESCE(v_roster_size, roster_size),
         ir_slots = COALESCE(v_ir_slots, ir_slots),
         taxi_slots = COALESCE(v_taxi_slots, taxi_slots),
         auction_budget = COALESCE(v_auction_budget, auction_budget),
         playoff_start_week = COALESCE(v_playoff_start_week, playoff_start_week),
         playoff_total_weeks = COALESCE(v_playoff_total_weeks, playoff_total_weeks),
         playoff_round_weeks = COALESCE(v_playoff_round_weeks, playoff_round_weeks),
         trade_deadline = CASE WHEN v_trade_deadline_set THEN v_trade_deadline ELSE trade_deadline END,
         weekly_add_limit = CASE
           WHEN v_weekly_add_unlimited IS TRUE THEN NULL
           WHEN v_weekly_add_limit IS NOT NULL THEN v_weekly_add_limit
           ELSE weekly_add_limit
         END,
         waiver_mode = COALESCE(v_waiver_mode, waiver_mode),
         faab_starting_budget = COALESCE(v_faab_starting_budget, faab_starting_budget),
         trade_veto_mode = COALESCE(v_trade_veto_mode, trade_veto_mode),
         trade_veto_window_hours = COALESCE(v_trade_veto_window_hours, trade_veto_window_hours),
         trade_veto_threshold_percent = COALESCE(v_trade_veto_threshold_percent, trade_veto_threshold_percent)
   WHERE id = p_league_id;

  IF v_faab_starting_budget IS NOT NULL THEN
    UPDATE public.faab_balances AS balance
       SET balance = v_faab_starting_budget,
           updated_at = now()
      FROM public.league_seasons AS season
     WHERE balance.league_id = p_league_id
       AND balance.league_season_id = season.id
       AND season.is_current = true
       AND balance.balance = v_league.faab_starting_budget;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION private.playoff_round_plan(int,int,int[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.assert_playoff_window(int,int,int[],boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.assert_schedule_not_started(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.regular_season_matchup_payload(uuid,uuid,int) FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER prevent_playoff_start_week_change_after_bracket ON public.leagues;
CREATE TRIGGER prevent_playoff_start_week_change_after_bracket
  AFTER UPDATE OF playoff_start_week, playoff_total_weeks, playoff_round_weeks ON public.leagues
  FOR EACH ROW WHEN (OLD.playoff_start_week IS DISTINCT FROM NEW.playoff_start_week
    OR OLD.playoff_total_weeks IS DISTINCT FROM NEW.playoff_total_weeks
    OR OLD.playoff_round_weeks IS DISTINCT FROM NEW.playoff_round_weeks)
  EXECUTE FUNCTION public.prevent_playoff_start_week_change_after_bracket();
NOTIFY pgrst, 'reload schema';
