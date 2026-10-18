-- Canonical SQL source for public.advance_playoff_bracket_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
  v_branches uuid[];
  v_seed int;
  v_byes int;
  v_winner uuid;
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
    IF v_quarterfinals_ready IS DISTINCT FROM true THEN
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
      RAISE EXCEPTION 'Original playoff seed order is missing. Semifinals cannot be generated until verified original seeds are restored. Existing results are unchanged.';
    END IF;

    v_branches := array_fill(NULL::uuid,ARRAY[4]);
    v_byes := 8-cardinality(v_seed_ids);
    FOR v_seed IN 1..4 LOOP
      IF v_seed<=v_byes THEN
        v_branches[v_seed] := v_seed_ids[v_seed];
      ELSE
        SELECT winner_member_id INTO v_winner FROM public.matchups
          WHERE league_season_id=v_season_id AND matchup_type='playoff_quarterfinal'
            AND home_member_id=v_seed_ids[v_seed];
        v_branches[v_seed] := v_winner;
      END IF;
    END LOOP;

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
        (p_league_id, v_season_id, v_next_start, v_next_end, 'playoff_semifinal'::public.matchup_type, v_branches[1], v_branches[4]),
        (p_league_id, v_season_id, v_next_start, v_next_end, 'playoff_semifinal'::public.matchup_type, v_branches[2], v_branches[3])
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

  IF v_semifinal_count < (CASE WHEN cardinality(v_seed_ids)=3 THEN 1 ELSE 2 END) THEN
    RAISE EXCEPTION 'Semifinals not found.';
  END IF;

  IF v_semifinals_ready IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Semifinals are not yet finalized.';
  END IF;

  IF cardinality(v_seed_ids)=3 THEN
    v_semifinal_winners := ARRAY[v_seed_ids[1],v_semifinal_winners[1]];
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
