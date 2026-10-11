-- Keep automatic boundaries behind saved statistics and calendar corrections.

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
    v_type := CASE WHEN EXISTS(SELECT 1 FROM public.matchups WHERE league_season_id = p_league_season_id AND matchup_type = 'playoff_semifinal')
      THEN 'playoff_semifinal'::matchup_type ELSE 'playoff_quarterfinal'::matchup_type END;
  ELSE
    v_type := 'playoff_final';
  END IF;

  SELECT count(*), bool_and(is_finalized IS TRUE AND (v_type = 'regular_season' OR winner_member_id IS NOT NULL)), max(finalized_at)
    INTO v_count, v_ready, v_latest
    FROM public.matchups WHERE league_season_id = p_league_season_id AND matchup_type = v_type
      AND (v_type <> 'regular_season' OR week_number < v_start);
  IF NOT (p_action = 'generate' AND v_start = 1) AND
      (v_count = 0 OR v_ready IS DISTINCT FROM true OR v_latest > p_reference_at - interval '48 hours') THEN
    RETURN jsonb_build_object('applied', false);
  END IF;

  -- A saved correction must be replayed before its old decision becomes immutable.
  IF EXISTS (
    SELECT 1
      FROM public.matchups matchup
      JOIN public.season_weeks week ON week.season_year = v_year
        AND week.week_number BETWEEN matchup.week_number AND COALESCE(matchup.end_week_number, matchup.week_number)
      JOIN (
        SELECT stats.game_id, stats.season_year, stats.game_date, stats.updated_at
          FROM public.player_game_stats stats WHERE stats.season_year = v_year
        UNION ALL
        SELECT correction.game_id, correction.season_year, correction.game_date, correction.updated_at
          FROM public.game_calendar_corrections correction WHERE correction.season_year = v_year
      ) changed ON changed.game_date BETWEEN week.week_start AND week.week_end
      JOIN public.nba_games game ON game.id = changed.game_id
      WHERE matchup.league_season_id = p_league_season_id AND matchup.matchup_type = v_type
        AND (v_type <> 'regular_season' OR matchup.week_number < v_start)
        AND changed.updated_at > COALESCE(matchup.score_read_started_at, matchup.finalized_at, '-infinity'::timestamptz)
        AND btrim(game.nba_game_id) <> ''
        AND (btrim(game.nba_game_id) LIKE '002%' OR btrim(game.nba_game_id) !~ '^00[0-9]')
  ) THEN
    RETURN jsonb_build_object('applied', false);
  END IF;

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
