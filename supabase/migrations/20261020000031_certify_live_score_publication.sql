BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.update_score_points_atomic(
  p_league_id uuid,
  p_league_season_id uuid,
  p_week_number int,
  p_matchups jsonb
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_requested int;
  v_distinct int;
  v_locked int;
  v_updated int;
  v_input_token jsonb;
BEGIN
  IF p_matchups IS NULL OR jsonb_typeof(p_matchups) <> 'array' THEN
    RAISE EXCEPTION 'p_matchups must be a JSON array.' USING ERRCODE = '22023';
  END IF;
  SELECT count(*), count(DISTINCT id) INTO v_requested, v_distinct
    FROM jsonb_to_recordset(p_matchups) AS requested(id uuid);
  IF v_requested = 0 THEN RETURN 0; END IF;
  IF v_requested <> v_distinct THEN
    RAISE EXCEPTION 'p_matchups contains duplicate or missing matchup ids.' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.leagues WHERE id = p_league_id FOR UPDATE;
  PERFORM 1 FROM public.league_seasons WHERE id = p_league_season_id AND league_id = p_league_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'League season not found.' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM public.league_seasons WHERE id=p_league_season_id AND p_week_number=ANY(skipped_weeks)) THEN RETURN 0; END IF;
  IF EXISTS(SELECT 1 FROM private.retired_score_inputs WHERE league_season_id = p_league_season_id) THEN
    RAISE EXCEPTION 'Historical score inputs have been retired. Existing results are preserved.' USING ERRCODE = '55000';
  END IF;
  PERFORM private.assert_score_game_identity(p_league_season_id,p_week_number);
  PERFORM pg_advisory_xact_lock(hashtext('playoff-bracket'), hashtext(p_league_season_id::text));

  WITH locked AS (
    SELECT matchup.id FROM public.matchups AS matchup
    JOIN jsonb_to_recordset(p_matchups) AS requested(id uuid) ON requested.id = matchup.id
    WHERE matchup.league_id = p_league_id AND matchup.league_season_id = p_league_season_id
      AND matchup.week_number = p_week_number
    ORDER BY matchup.id FOR UPDATE OF matchup
  ) SELECT count(*) INTO v_locked FROM locked;
  IF v_locked <> v_requested THEN
    RAISE EXCEPTION 'p_matchups contains rows outside the target league season week.' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_matchups) item WHERE item ? 'input_token') THEN
    v_input_token := p_matchups->0->'input_token';
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_matchups) item WHERE item->'input_token' IS DISTINCT FROM v_input_token)
      OR NOT private.lock_current_score_inputs(p_league_season_id, p_week_number, v_input_token) THEN
      RAISE EXCEPTION 'Score inputs changed or were not certified. Retry scoring.' USING ERRCODE = 'PT409';
    END IF;
  END IF;

  UPDATE public.matchups AS matchup SET home_points = requested.home_points, away_points = requested.away_points
    FROM jsonb_to_recordset(p_matchups) AS requested(id uuid, home_points numeric, away_points numeric)
    WHERE matchup.id = requested.id
      AND NOT private.playoff_matchup_is_consumed(matchup.id)
      AND (matchup.matchup_type = 'regular_season' OR matchup.is_finalized IS NOT TRUE)
      AND (matchup.home_points IS DISTINCT FROM requested.home_points OR matchup.away_points IS DISTINCT FROM requested.away_points);
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

COMMIT;
