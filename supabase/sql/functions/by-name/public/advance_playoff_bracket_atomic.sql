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
  SELECT season.id
    INTO v_season_id
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
