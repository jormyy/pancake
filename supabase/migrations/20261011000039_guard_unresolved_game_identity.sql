CREATE OR REPLACE FUNCTION private.nba_game_provider(p_id text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE WHEN p_id ~ '^[0-9]{10}$' THEN 'nba'
    WHEN p_id ~ '^[0-9]{8}0[A-Za-z]{3}$' THEN 'bbref' ELSE 'unknown' END;
$$;

CREATE OR REPLACE FUNCTION private.lock_nba_source(p_year int, p_shared boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_year IS NULL THEN RAISE EXCEPTION 'Game season is required.' USING ERRCODE='22023'; END IF;
  IF (p_shared AND NOT pg_try_advisory_xact_lock_shared(hashtext('nba-source'),p_year))
     OR (NOT p_shared AND NOT pg_try_advisory_xact_lock(hashtext('nba-source'),p_year)) THEN
    RAISE EXCEPTION 'Game inputs are being updated. Retry this operation.' USING ERRCODE='40001';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.assert_nba_game_candidate(
  p_provider_id text,p_year int,p_date date,p_home text,p_away text,p_ignore uuid DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_other text;
BEGIN
  SELECT nba_game_id INTO v_other FROM public.nba_games
   WHERE season_year=p_year AND game_date=p_date AND id IS DISTINCT FROM p_ignore
     AND upper(btrim(home_team))=upper(btrim(p_home)) AND upper(btrim(away_team))=upper(btrim(p_away))
     AND nba_game_id IS DISTINCT FROM p_provider_id
     AND private.nba_game_provider(nba_game_id)<>private.nba_game_provider(p_provider_id)
   ORDER BY id LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Unresolved game identity: % and %. Verify the provider relationship before importing or scoring.',p_provider_id,v_other
      USING ERRCODE='55000';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.guard_nba_game_identity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.nba_game_id,NEW.season_year,NEW.game_date,NEW.home_team,NEW.away_team)
       IS NOT DISTINCT FROM ROW(OLD.nba_game_id,OLD.season_year,OLD.game_date,OLD.home_team,OLD.away_team) THEN RETURN NEW; END IF;
    PERFORM private.lock_nba_source(LEAST(OLD.season_year,NEW.season_year));
    PERFORM private.lock_nba_source(GREATEST(OLD.season_year,NEW.season_year));
    IF NEW.nba_game_id IS DISTINCT FROM OLD.nba_game_id AND
       private.nba_game_provider(NEW.nba_game_id)<>private.nba_game_provider(OLD.nba_game_id) THEN
      RAISE EXCEPTION 'Cannot replace a game provider identity without verified mapping.' USING ERRCODE='55000';
    END IF;
  ELSE
    PERFORM private.lock_nba_source(NEW.season_year);
  END IF;
  PERFORM private.assert_nba_game_candidate(NEW.nba_game_id,NEW.season_year,NEW.game_date,NEW.home_team,NEW.away_team,NEW.id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_nba_game_imports(p_games jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_game record;
BEGIN
  IF jsonb_typeof(p_games) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Game imports must be an array.' USING ERRCODE='22023'; END IF;
  FOR v_game IN SELECT DISTINCT season_year FROM jsonb_to_recordset(p_games) AS g(season_year int) ORDER BY season_year LOOP
    PERFORM private.lock_nba_source(v_game.season_year);
  END LOOP;
  FOR v_game IN SELECT * FROM jsonb_to_recordset(p_games) AS g(nba_game_id text,season_year int,game_date date,home_team text,away_team text) LOOP
    IF v_game.nba_game_id IS NULL OR v_game.game_date IS NULL OR NULLIF(btrim(v_game.home_team),'') IS NULL OR NULLIF(btrim(v_game.away_team),'') IS NULL THEN
      RAISE EXCEPTION 'Game identity is incomplete.' USING ERRCODE='22023';
    END IF;
    PERFORM private.assert_nba_game_candidate(v_game.nba_game_id,v_game.season_year,v_game.game_date,v_game.home_team,v_game.away_team);
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_games) AS a(nba_game_id text,season_year int,game_date date,home_team text,away_team text)
    JOIN jsonb_to_recordset(p_games) AS b(nba_game_id text,season_year int,game_date date,home_team text,away_team text)
      USING(season_year,game_date)
    WHERE a.nba_game_id<>b.nba_game_id AND upper(btrim(a.home_team))=upper(btrim(b.home_team))
      AND upper(btrim(a.away_team))=upper(btrim(b.away_team))
      AND private.nba_game_provider(a.nba_game_id)<>private.nba_game_provider(b.nba_game_id)
  ) THEN RAISE EXCEPTION 'Import contains unresolved game identities. Verify the provider relationship.' USING ERRCODE='55000'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_nba_game_unambiguous(p_game_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_game public.nba_games%ROWTYPE; v_year int;
BEGIN
  SELECT season_year INTO v_year FROM public.nba_games WHERE id=p_game_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'NBA game not found.' USING ERRCODE='P0002'; END IF;
  PERFORM private.lock_nba_source(v_year,true);
  SELECT * INTO v_game FROM public.nba_games WHERE id=p_game_id;
  IF NOT FOUND OR v_game.season_year<>v_year THEN RAISE EXCEPTION 'Game inputs changed. Retry.' USING ERRCODE='40001'; END IF;
  PERFORM private.assert_nba_game_candidate(v_game.nba_game_id,v_game.season_year,v_game.game_date,v_game.home_team,v_game.away_team,v_game.id);
END;
$$;

CREATE OR REPLACE FUNCTION private.assert_score_game_identity(p_season_id uuid,p_week int)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_year int; v_first int; v_last int; v_start date; v_end date; v_game record;
BEGIN
  SELECT season_year INTO v_year FROM public.league_seasons WHERE id=p_season_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'League season not found.' USING ERRCODE='22023'; END IF;
  PERFORM private.lock_nba_source(v_year,true);
  SELECT CASE WHEN bool_or(matchup_type='regular_season') THEN 1 ELSE p_week END,
    COALESCE(max(COALESCE(end_week_number,week_number)),p_week) INTO v_first,v_last
    FROM public.matchups WHERE league_season_id=p_season_id AND week_number=p_week;
  SELECT min(week_start),max(week_end) INTO v_start,v_end FROM public.season_weeks
    WHERE season_year=v_year AND week_number BETWEEN v_first AND v_last;
  FOR v_game IN SELECT * FROM public.nba_games WHERE season_year=v_year
    AND (week_number BETWEEN v_first AND v_last OR game_date BETWEEN v_start AND v_end) LOOP
    PERFORM private.assert_nba_game_candidate(v_game.nba_game_id,v_game.season_year,v_game.game_date,v_game.home_team,v_game.away_team,v_game.id);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.capture_score_inputs(p_league_season_id uuid, p_week_number int)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM private.retired_score_inputs WHERE league_season_id = p_league_season_id) THEN
    RAISE EXCEPTION 'Historical score inputs have been retired. Existing results are preserved.' USING ERRCODE = '55000';
  END IF;
  PERFORM private.assert_score_game_identity(p_league_season_id,p_week_number);
  INSERT INTO private.score_input_revisions(scope, revision)
    SELECT keys.scope, 0 FROM private.score_input_keys(p_league_season_id, p_week_number) keys
    WHERE NOT EXISTS(SELECT 1 FROM private.score_input_revisions revision WHERE revision.scope = keys.scope) ORDER BY keys.scope
    ON CONFLICT(scope) DO NOTHING;
  RETURN private.score_input_token(p_league_season_id, p_week_number);
END;
$$;

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

  UPDATE public.matchups AS matchup SET home_points = requested.home_points, away_points = requested.away_points
    FROM jsonb_to_recordset(p_matchups) AS requested(id uuid, home_points numeric, away_points numeric)
    WHERE matchup.id = requested.id
      AND NOT private.playoff_round_is_consumed(p_league_season_id, matchup.matchup_type)
      AND (matchup.matchup_type = 'regular_season' OR matchup.is_finalized IS NOT TRUE)
      AND (matchup.home_points IS DISTINCT FROM requested.home_points OR matchup.away_points IS DISTINCT FROM requested.away_points);
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

CREATE OR REPLACE FUNCTION private.lock_current_score_inputs(p_season_id uuid, p_week int, p_token jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM private.retired_score_inputs WHERE league_season_id = p_season_id) THEN RETURN false; END IF;
  IF p_token IS NULL OR jsonb_typeof(p_token) <> 'object' THEN RETURN false; END IF;
  PERFORM private.assert_score_game_identity(p_season_id,p_week);
  -- Input writers update these same rows through commit. A conflicting writer
  -- defers scoring or advancement; it cannot commit between validation and use.
  BEGIN
    PERFORM 1 FROM private.score_input_revisions revision
      JOIN private.score_input_keys(p_season_id, p_week) keys USING(scope)
      ORDER BY revision.scope FOR SHARE OF revision NOWAIT;
  EXCEPTION WHEN lock_not_available THEN RETURN false;
  END;
  RETURN p_token IS NOT DISTINCT FROM private.score_input_token(p_season_id, p_week);
END;
$$;

CREATE OR REPLACE FUNCTION public.save_game_stats_atomic(
  p_game_id uuid,
  p_provider_game_id text,
  p_stats jsonb,
  p_is_final boolean
)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_game public.nba_games%ROWTYPE;
  v_changed integer;
  v_year integer;
BEGIN
  SELECT season_year INTO v_year FROM public.nba_games WHERE id=p_game_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'NBA game not found.' USING ERRCODE='P0002'; END IF;
  PERFORM private.lock_nba_source(v_year);
  SELECT * INTO v_game FROM public.nba_games WHERE id = p_game_id FOR UPDATE;
  IF v_game.season_year IS DISTINCT FROM v_year THEN RAISE EXCEPTION 'Game inputs changed. Retry.' USING ERRCODE='40001'; END IF;
  PERFORM public.assert_nba_game_unambiguous(p_game_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'NBA game not found.' USING ERRCODE = 'P0002'; END IF;
  IF v_game.nba_game_id IS DISTINCT FROM p_provider_game_id THEN
    RAISE EXCEPTION 'Game provider identity changed. Fetch the game again.' USING ERRCODE = '40001';
  END IF;
  IF jsonb_typeof(p_stats) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'A complete parsed box score is required.' USING ERRCODE = '22023';
  END IF;
  IF p_is_final AND jsonb_array_length(p_stats) = 0 THEN
    RAISE EXCEPTION 'A Final box score must contain resolved players.' USING ERRCODE = '22023';
  END IF;
  IF p_is_final IS NULL OR (v_game.status = 'Final' AND NOT p_is_final) THEN
    RAISE EXCEPTION 'Final game box score is not final.' USING ERRCODE = '22023';
  END IF;
  IF NOT p_is_final AND jsonb_array_length(p_stats) = 0 THEN RETURN 0; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_populate_recordset(NULL::public.player_game_stats, p_stats) AS row
    WHERE row.player_id IS NULL OR row.game_id IS DISTINCT FROM p_game_id
       OR row.did_not_play IS NULL
  ) OR (SELECT count(DISTINCT row->>'player_id') FROM jsonb_array_elements(p_stats) AS row) <> jsonb_array_length(p_stats) THEN
    RAISE EXCEPTION 'Box score rows do not match the current game or contain duplicate players.' USING ERRCODE = '22023';
  END IF;

  IF p_is_final AND EXISTS (
    SELECT 1 FROM public.player_game_stats AS stored
    WHERE stored.game_id = p_game_id
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_stats) AS row WHERE (row->>'player_id')::uuid = stored.player_id)
  ) THEN
    RAISE EXCEPTION 'The complete box score omits stored players. Resolve the game inputs before certifying it.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.player_game_stats AS stored (
    player_id, game_id, season_year, week_number, minutes_played, points, rebounds, offensive_rebounds, defensive_rebounds, assists, steals, blocks, turnovers, personal_fouls, field_goals_made, field_goals_attempted, three_pointers_made, three_pointers_attempted, free_throws_made, free_throws_attempted, plus_minus, double_double, triple_double, did_not_play, updated_at
  )
  SELECT incoming.player_id, v_game.id, v_game.season_year, v_game.week_number, incoming.minutes_played, incoming.points, incoming.rebounds, incoming.offensive_rebounds, incoming.defensive_rebounds, incoming.assists, incoming.steals, incoming.blocks, incoming.turnovers, incoming.personal_fouls, incoming.field_goals_made, incoming.field_goals_attempted, incoming.three_pointers_made, incoming.three_pointers_attempted, incoming.free_throws_made, incoming.free_throws_attempted, incoming.plus_minus, incoming.double_double, incoming.triple_double, incoming.did_not_play, clock_timestamp()
  FROM jsonb_populate_recordset(NULL::public.player_game_stats, p_stats) AS incoming
  ON CONFLICT (player_id, game_id) DO UPDATE SET
    season_year = EXCLUDED.season_year,
    week_number = EXCLUDED.week_number,
    minutes_played = EXCLUDED.minutes_played,
    points = EXCLUDED.points,
    rebounds = EXCLUDED.rebounds,
    offensive_rebounds = EXCLUDED.offensive_rebounds,
    defensive_rebounds = EXCLUDED.defensive_rebounds,
    assists = EXCLUDED.assists,
    steals = EXCLUDED.steals,
    blocks = EXCLUDED.blocks,
    turnovers = EXCLUDED.turnovers,
    personal_fouls = EXCLUDED.personal_fouls,
    field_goals_made = EXCLUDED.field_goals_made,
    field_goals_attempted = EXCLUDED.field_goals_attempted,
    three_pointers_made = EXCLUDED.three_pointers_made,
    three_pointers_attempted = EXCLUDED.three_pointers_attempted,
    free_throws_made = EXCLUDED.free_throws_made,
    free_throws_attempted = EXCLUDED.free_throws_attempted,
    plus_minus = EXCLUDED.plus_minus,
    double_double = EXCLUDED.double_double,
    triple_double = EXCLUDED.triple_double,
    did_not_play = EXCLUDED.did_not_play,
    updated_at = EXCLUDED.updated_at
  WHERE ROW(stored.player_id, stored.game_id, stored.season_year, stored.week_number, stored.minutes_played, stored.points, stored.rebounds, stored.offensive_rebounds, stored.defensive_rebounds, stored.assists, stored.steals, stored.blocks, stored.turnovers, stored.personal_fouls, stored.field_goals_made, stored.field_goals_attempted, stored.three_pointers_made, stored.three_pointers_attempted, stored.free_throws_made, stored.free_throws_attempted, stored.plus_minus, stored.double_double, stored.triple_double, stored.did_not_play)
    IS DISTINCT FROM ROW(EXCLUDED.player_id, EXCLUDED.game_id, EXCLUDED.season_year, EXCLUDED.week_number, EXCLUDED.minutes_played, EXCLUDED.points, EXCLUDED.rebounds, EXCLUDED.offensive_rebounds, EXCLUDED.defensive_rebounds, EXCLUDED.assists, EXCLUDED.steals, EXCLUDED.blocks, EXCLUDED.turnovers, EXCLUDED.personal_fouls, EXCLUDED.field_goals_made, EXCLUDED.field_goals_attempted, EXCLUDED.three_pointers_made, EXCLUDED.three_pointers_attempted, EXCLUDED.free_throws_made, EXCLUDED.free_throws_attempted, EXCLUDED.plus_minus, EXCLUDED.double_double, EXCLUDED.triple_double, EXCLUDED.did_not_play);
  GET DIAGNOSTICS v_changed = ROW_COUNT;

  IF p_is_final THEN
    UPDATE public.nba_games SET stats_synced_at = clock_timestamp(), status = 'Final',
      updated_at = CASE WHEN status <> 'Final' THEN clock_timestamp() ELSE updated_at END
    WHERE id = p_game_id;
  ELSE
    UPDATE public.nba_games SET stats_synced_at = NULL WHERE id = p_game_id AND stats_synced_at IS NOT NULL;
  END IF;
  RETURN v_changed;
END;
$$;

CREATE INDEX IF NOT EXISTS nba_games_identity_candidates_idx ON public.nba_games(season_year,game_date,upper(btrim(home_team)),upper(btrim(away_team)));
CREATE TRIGGER guard_nba_game_identity BEFORE INSERT OR UPDATE OF nba_game_id,season_year,game_date,home_team,away_team
  ON public.nba_games FOR EACH ROW EXECUTE FUNCTION private.guard_nba_game_identity();
REVOKE ALL ON FUNCTION private.nba_game_provider(text),private.lock_nba_source(int,boolean),
  private.assert_nba_game_candidate(text,int,date,text,text,uuid),private.guard_nba_game_identity(),
  private.assert_score_game_identity(uuid,int) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.assert_nba_game_imports(jsonb),public.assert_nba_game_unambiguous(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.assert_nba_game_imports(jsonb),public.assert_nba_game_unambiguous(uuid) TO service_role;
NOTIFY pgrst, 'reload schema';
