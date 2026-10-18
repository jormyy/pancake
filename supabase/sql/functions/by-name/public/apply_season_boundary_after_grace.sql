CREATE OR REPLACE FUNCTION public.apply_season_boundary_after_grace(
  p_league_id uuid,
  p_league_season_id uuid,
  p_action text,
  p_reference_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start int;
  v_year int;
  v_type matchup_type;
  v_count int;
  v_ready boolean;
  v_latest timestamptz;
  v_result jsonb;
  v_next record;
  v_week int;
  v_input_token jsonb;
  v_round int;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('generate', 'advance', 'rollover') OR p_reference_at IS NULL THEN
    RAISE EXCEPTION 'Invalid automatic season boundary request.' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.leagues WHERE id = p_league_id FOR UPDATE;
  SELECT COALESCE(season.playoff_start_week, league.playoff_start_week, 20), season.season_year INTO v_start, v_year
    FROM public.league_seasons season JOIN public.leagues league ON league.id = season.league_id
    WHERE season.id = p_league_season_id AND season.league_id = p_league_id AND season.is_current
    FOR UPDATE OF season;
  IF NOT FOUND THEN RETURN jsonb_build_object('applied', false); END IF;
  PERFORM pg_advisory_xact_lock(hashtext('playoff-bracket'), hashtext(p_league_season_id::text));
  PERFORM 1 FROM public.matchups WHERE league_season_id = p_league_season_id ORDER BY id FOR UPDATE;

  IF p_action = 'generate' THEN
    IF EXISTS(SELECT 1 FROM public.matchups WHERE league_season_id = p_league_season_id AND matchup_type <> 'regular_season') THEN
      RETURN jsonb_build_object('applied', false);
    END IF;
    v_type := 'regular_season';
  ELSIF p_action = 'advance' THEN
    IF EXISTS(SELECT 1 FROM public.matchups WHERE league_season_id = p_league_season_id AND matchup_type = 'playoff_final') THEN
      RETURN jsonb_build_object('applied', false);
    END IF;
    SELECT max(playoff_round) INTO v_round FROM public.matchups WHERE league_season_id=p_league_season_id;
    v_type := CASE WHEN EXISTS(SELECT 1 FROM public.matchups WHERE league_season_id = p_league_season_id AND matchup_type = 'playoff_semifinal')
      THEN 'playoff_semifinal'::matchup_type ELSE 'playoff_quarterfinal'::matchup_type END;
  ELSE
    v_type := 'playoff_final';
  END IF;

  SELECT count(*), bool_and(is_finalized IS TRUE AND (v_type = 'regular_season' OR winner_member_id IS NOT NULL)), max(finalized_at)
    INTO v_count, v_ready, v_latest
    FROM public.matchups WHERE league_season_id = p_league_season_id AND NOT is_voided AND (CASE WHEN v_round IS NOT NULL THEN playoff_round=v_round ELSE matchup_type=v_type END)
      AND (v_type <> 'regular_season' OR week_number < v_start);
  IF NOT (p_action = 'generate' AND v_start = 1) AND
      (v_count = 0 OR v_ready IS DISTINCT FROM true OR v_latest > p_reference_at - interval '48 hours') THEN
    RETURN jsonb_build_object('applied', false);
  END IF;

  -- Keep input revisions locked through the transition. Missing legacy
  -- certificates require an actual replay, never a timestamp backfill.
  FOR v_week IN SELECT DISTINCT week_number FROM public.matchups
      WHERE league_season_id = p_league_season_id AND NOT is_voided
        AND ((CASE WHEN v_round IS NOT NULL THEN playoff_round=v_round ELSE matchup_type=v_type END) OR (p_action = 'rollover' AND matchup_type = 'regular_season'))
        AND (matchup_type <> 'regular_season' OR week_number < v_start) ORDER BY week_number LOOP
    SELECT input_token INTO v_input_token FROM private.score_week_certificates
      WHERE league_season_id = p_league_season_id AND week_number = v_week;
    IF NOT private.lock_current_score_inputs(p_league_season_id, v_week, v_input_token) THEN
      RETURN jsonb_build_object('applied', false);
    END IF;
  END LOOP;

  IF p_action = 'generate' THEN
    v_result := public.generate_playoff_bracket_atomic(p_league_id);
    UPDATE public.leagues SET status = 'playoffs' WHERE id = p_league_id AND status = 'active';
  ELSIF p_action = 'advance' THEN
    v_result := public.advance_playoff_bracket_atomic(p_league_id);
  ELSE
    SELECT * INTO v_next FROM public.advance_season_atomic(p_league_id);
    RETURN jsonb_build_object('applied', true, 'new_season_id', v_next.new_season_id, 'new_year', v_next.new_year);
  END IF;
  RETURN jsonb_build_object('applied', COALESCE((v_result->>'inserted')::int, 0) > 0);
END;
$$;
