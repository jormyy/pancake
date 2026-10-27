CREATE TABLE private.provider_history_policy (
  source text PRIMARY KEY CHECK(source IN ('bbref','cdn-enum','career')),
  first_season_year integer NOT NULL CHECK(first_season_year>0),
  last_season_year integer CHECK(last_season_year>=first_season_year),
  first_game_date date,
  CHECK(source<>'career' OR first_game_date IS NOT NULL)
);
REVOKE ALL ON private.provider_history_policy FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON private.provider_history_policy TO service_role;
INSERT INTO private.provider_history_policy(source,first_season_year,last_season_year,first_game_date) VALUES
  ('bbref',2004,2019,NULL),('cdn-enum',2020,NULL,NULL),('career',2021,NULL,DATE '2020-12-22');

CREATE OR REPLACE FUNCTION public.get_backfill_season_plan(p_now timestamptz DEFAULT now())
RETURNS TABLE(source text,season_year integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH completed AS (
    SELECT season_year FROM public.season_weeks
    GROUP BY season_year HAVING max(week_end)<(p_now AT TIME ZONE 'America/New_York')::date
  ), latest AS (
    SELECT COALESCE(max(season_year),public.current_season_year_et(p_now)-1) AS season_year FROM completed
  )
  SELECT policy.source,years.season_year
  FROM private.provider_history_policy policy CROSS JOIN latest
  CROSS JOIN LATERAL generate_series(policy.first_season_year,
    LEAST(COALESCE(policy.last_season_year,latest.season_year),latest.season_year)) years(season_year)
  WHERE policy.source IN ('bbref','cdn-enum')
  ORDER BY CASE WHEN policy.source='cdn-enum' THEN 0 ELSE 1 END,years.season_year DESC;
$$;

CREATE OR REPLACE FUNCTION private.player_career_appearances(p_player_id uuid, p_after_season integer)
RETURNS integer LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT count(*)::integer
  FROM public.player_game_stats s JOIN public.nba_games g ON g.id=s.game_id
  WHERE s.player_id=p_player_id AND g.season_year>p_after_season
    AND g.game_date>=(SELECT first_game_date FROM private.provider_history_policy WHERE source='career')
    AND public.is_regular_season_game_id(g.nba_game_id) AND private.player_game_appeared(s);
$$;

CREATE OR REPLACE FUNCTION private.player_career_fallback(p_player_id uuid, p_years_exp integer, p_season_year integer)
RETURNS TABLE(base integer, base_season integer, source text)
LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH policy AS (
    SELECT first_season_year,first_game_date FROM private.provider_history_policy WHERE source='career'
  ), appeared AS (
    SELECT g.season_year,g.game_date
    FROM public.player_game_stats s JOIN public.nba_games g ON g.id=s.game_id
    WHERE s.player_id=p_player_id AND g.season_year<=p_season_year
      AND public.is_regular_season_game_id(g.nba_game_id) AND private.player_game_appeared(s)
  ), coverage AS (
    SELECT count(*) FILTER(WHERE season_year>=policy.first_season_year AND game_date>=policy.first_game_date) AS games,
      count(DISTINCT season_year) FILTER(WHERE season_year<p_season_year) AS completed_seasons,
      count(*) FILTER(WHERE season_year<p_season_year) AS past_games,
      count(*) FILTER(WHERE season_year<policy.first_season_year OR game_date<policy.first_game_date) AS before_coverage
    FROM appeared CROSS JOIN policy
  ), resolved AS (
    SELECT CASE WHEN p_years_exp=0 AND past_games=0 THEN 'rookie'
      WHEN p_years_exp>0 AND completed_seasons=p_years_exp AND before_coverage=0 THEN 'coverage'
      WHEN games>=65 THEN 'threshold' END AS source FROM coverage
  )
  SELECT CASE WHEN source IS NOT NULL THEN 0 END,
    CASE WHEN source='rookie' THEN p_season_year-1 WHEN source IS NOT NULL THEN policy.first_season_year-1 END,source FROM resolved CROSS JOIN policy;
$$;

CREATE OR REPLACE FUNCTION public.complete_player_career_base_atomic(
  p_player_id uuid, p_espn_id text, p_nba_id text,
  p_base integer DEFAULT NULL, p_base_season integer DEFAULT NULL,
  p_season_year integer DEFAULT public.current_season_year_et()
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_player public.players%ROWTYPE; v_source text; v_first_season integer;
BEGIN
  SELECT first_season_year INTO v_first_season FROM private.provider_history_policy WHERE source='career';
  IF NOT FOUND THEN RAISE EXCEPTION 'Player career coverage policy is unavailable.' USING ERRCODE='55000'; END IF;
  IF p_season_year IS NULL OR p_season_year<v_first_season OR
    (p_base IS NULL) IS DISTINCT FROM (p_base_season IS NULL) OR p_base<0 OR
    (p_base_season IS NOT NULL AND p_base_season<>p_season_year-1) THEN
    RAISE EXCEPTION 'A completed-season NBA career base is required.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_player FROM public.players WHERE id=p_player_id FOR UPDATE;
  IF NOT FOUND OR (v_player.career_games_base IS NOT NULL AND v_player.career_games_base_source<>'coverage')
    OR v_player.espn_id IS DISTINCT FROM nullif(p_espn_id,'')
    OR v_player.nba_id IS DISTINCT FROM nullif(p_nba_id,'') THEN RETURN false; END IF;
  IF p_base IS NULL AND v_player.career_games_base_source='coverage' THEN RETURN false; END IF;
  IF p_base IS NULL THEN
    SELECT base,base_season,source INTO p_base,p_base_season,v_source
      FROM private.player_career_fallback(p_player_id,v_player.years_exp,p_season_year);
    IF p_base IS NULL THEN RETURN false; END IF;
  ELSE
    v_source:='espn';
  END IF;
  IF p_base+private.player_career_appearances(p_player_id,p_base_season)<v_player.career_regular_season_games THEN RETURN false; END IF;
  UPDATE public.players SET career_games_base=p_base,career_games_base_season=p_base_season,
    career_games_base_source=v_source,career_games_base_checked_at=clock_timestamp()
  WHERE id=p_player_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.get_backfill_season_plan(timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_backfill_season_plan(timestamptz) TO service_role;

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
  v_seed int;
  v_size int;
  v_type public.matchup_type;
BEGIN
  SELECT * INTO v_league FROM public.leagues WHERE id = p_league_id FOR UPDATE;
  SELECT id, season_year, COALESCE(playoff_start_week, v_league.playoff_start_week)
    INTO v_season_id, v_season_year, v_playoff_start_week
    FROM public.league_seasons WHERE league_id = p_league_id AND is_current FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Current league season not found for playoff generation.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('playoff-bracket'), hashtext(v_season_id::text));

  PERFORM 1
    FROM public.matchups AS matchup
   WHERE matchup.league_season_id = v_season_id
     AND matchup.matchup_type <> 'regular_season'
   FOR UPDATE;

  IF FOUND THEN
    RETURN jsonb_build_object('inserted', 0, 'skipped', true);
  END IF;

  PERFORM 1
    FROM public.matchups AS matchup
   WHERE matchup.league_season_id = v_season_id
     AND matchup.matchup_type = 'regular_season'::public.matchup_type
     AND matchup.week_number < v_playoff_start_week
     AND matchup.is_finalized = false AND NOT matchup.is_voided
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

  IF v_member_count < COALESCE(v_league.playoff_entrants,4) THEN
    RAISE EXCEPTION 'Not enough teams to seed playoffs (need %).',COALESCE(v_league.playoff_entrants,4);
  END IF;

  v_playoff_size := COALESCE(v_league.playoff_entrants,CASE WHEN v_member_count >= 10 THEN 6 ELSE 4 END);

  v_rounds := private.league_playoff_round_plan(v_league.id, v_member_count);
  PERFORM private.assert_playoff_window(v_season_year, v_playoff_start_week, v_rounds, v_league.playoff_entrants IS NOT NULL);
  UPDATE public.league_seasons
     SET playoff_start_week = v_playoff_start_week, playoff_round_weeks = v_rounds
   WHERE id = v_season_id;

  SELECT array_agg(seed.member_id ORDER BY seed.seed_rank)
    INTO v_seed_ids
    FROM private.playoff_seed_rankings(p_league_id, v_season_id, v_playoff_start_week) AS seed;

  UPDATE public.league_seasons
     SET playoff_seed_member_ids = CASE WHEN v_playoff_size IN (4,6) THEN v_seed_ids[1:v_playoff_size] END,
         playoff_bracket_seed_ids = CASE WHEN v_league.playoff_entrants IS NOT NULL THEN v_seed_ids[1:v_playoff_size] END
   WHERE id = v_season_id;

  IF v_league.playoff_entrants IS NOT NULL THEN
    RETURN private.generate_playoff_round(p_league_id,v_season_id,1);
  END IF;

  v_size := power(2,cardinality(v_rounds))::int;
  v_type := CASE cardinality(v_rounds) WHEN 3 THEN 'playoff_quarterfinal'::public.matchup_type
    WHEN 2 THEN 'playoff_semifinal'::public.matchup_type ELSE 'playoff_final'::public.matchup_type END;
  FOR v_seed IN 1..(v_size/2) LOOP
    IF v_size+1-v_seed <= v_playoff_size THEN
      INSERT INTO public.matchups(league_id,league_season_id,week_number,end_week_number,matchup_type,home_member_id,away_member_id)
      VALUES(p_league_id,v_season_id,v_playoff_start_week,v_playoff_start_week+v_rounds[1]-1,v_type,
        v_seed_ids[v_seed],v_seed_ids[v_size+1-v_seed])
      ON CONFLICT (league_id,league_season_id,week_number,home_member_id,away_member_id) DO NOTHING;
      v_inserted_count := v_inserted_count+1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('inserted',v_inserted_count,'skipped',false);
END;
$$;

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
  v_last_game_date date;
  v_end_week int;
  v_start_week int;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('generate', 'advance', 'rollover') OR p_reference_at IS NULL THEN
    RAISE EXCEPTION 'Invalid automatic season boundary request.' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.leagues WHERE id = p_league_id FOR UPDATE;
  SELECT COALESCE(season.playoff_start_week, league.playoff_start_week), season.season_year INTO v_start, v_year
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
      (v_count = 0 OR v_ready IS DISTINCT FROM true
        OR (p_action = 'rollover' AND v_latest > p_reference_at - interval '48 hours')) THEN
    RETURN jsonb_build_object('applied', false);
  END IF;

  IF (p_action = 'generate' AND v_start > 1) OR p_action = 'advance' THEN
    IF p_action = 'generate' THEN
      v_end_week := v_start - 1;
      v_start_week := v_end_week;
    ELSE
      SELECT min(week_number), max(COALESCE(end_week_number, week_number)) INTO v_start_week, v_end_week
        FROM public.matchups WHERE league_season_id = p_league_season_id AND NOT is_voided
          AND (CASE WHEN v_round IS NOT NULL THEN playoff_round = v_round ELSE matchup_type = v_type END);
    END IF;
    SELECT COALESCE(max(game.game_date), max(week.week_end)) INTO v_last_game_date
      FROM public.season_weeks AS week
      LEFT JOIN public.nba_games AS game
        ON game.season_year = week.season_year
       AND game.game_date BETWEEN week.week_start AND week.week_end
       AND public.is_regular_season_game_id(game.nba_game_id)
       AND private.lineup_game_available(game.status, game.game_status_text)
     WHERE week.season_year = v_year AND week.week_number BETWEEN v_start_week AND v_end_week;
    IF v_last_game_date IS NULL OR (p_reference_at AT TIME ZONE 'America/New_York')::date
        <= v_last_game_date + 1 THEN
      RETURN jsonb_build_object('applied', false);
    END IF;
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
      RETURN jsonb_build_object('applied', false, 'reason', 'stale_score_inputs', 'retryable', true);
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
