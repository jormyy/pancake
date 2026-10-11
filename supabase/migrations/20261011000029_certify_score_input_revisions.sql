-- Certificates remain absent until the actual scorer replays results.
-- Calendar/stat deletion and cross-week moves retain revisions independently of source rows.
BEGIN;
CREATE TABLE private.score_input_revisions(scope text PRIMARY KEY, revision bigint NOT NULL DEFAULT 0);
CREATE TABLE private.score_week_certificates(
  league_season_id uuid NOT NULL REFERENCES public.league_seasons(id) ON DELETE CASCADE,
  week_number int NOT NULL,
  input_token jsonb NOT NULL,
  PRIMARY KEY(league_season_id, week_number)
);
REVOKE ALL ON private.score_input_revisions, private.score_week_certificates FROM PUBLIC, anon, authenticated;


CREATE OR REPLACE FUNCTION private.bump_score_input_revisions(p_keys text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_key text;
BEGIN
  FOR v_key IN SELECT DISTINCT value FROM unnest(p_keys) value WHERE value IS NOT NULL ORDER BY value LOOP
    INSERT INTO private.score_input_revisions(scope, revision) VALUES(v_key, 1)
      ON CONFLICT(scope) DO UPDATE SET revision = score_input_revisions.revision + 1;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION private.track_score_input_revision()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_old jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  v_new jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  v_row jsonb;
  v_keys text[] := ARRAY[]::text[];
  v_fields text[] := string_to_array(TG_ARGV[1], ',');
  v_old_fields jsonb;
  v_new_fields jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    SELECT jsonb_object_agg(key, value) INTO v_old_fields FROM jsonb_each(v_old) WHERE key = ANY(v_fields);
    SELECT jsonb_object_agg(key, value) INTO v_new_fields FROM jsonb_each(v_new) WHERE key = ANY(v_fields);
    IF v_old_fields IS NOT DISTINCT FROM v_new_fields THEN RETURN NEW; END IF;
  END IF;
  FOR v_row IN SELECT value FROM jsonb_array_elements(jsonb_build_array(v_old, v_new)) WHERE value <> 'null'::jsonb LOOP
    IF TG_ARGV[0] = 'nba' THEN
      v_keys := v_keys || COALESCE(ARRAY(
        SELECT 'nba:' || season_year || ':' || week_number FROM public.season_weeks
        WHERE season_year = (v_row->>'season_year')::int
          AND (v_row->>'game_date')::date BETWEEN week_start AND week_end
      ), ARRAY[]::text[]);
    ELSIF TG_ARGV[0] = 'calendar' THEN
      v_keys := array_append(v_keys, 'calendar:' || (v_row->>'season_year'));
    ELSIF TG_ARGV[0] = 'players' THEN
      v_keys := array_append(v_keys, 'players');
    ELSIF TG_ARGV[0] = 'league' THEN
      v_keys := array_append(v_keys, 'league:' || CASE WHEN TG_TABLE_NAME = 'leagues' THEN v_row->>'id' ELSE v_row->>'league_id' END);
    ELSIF TG_ARGV[0] = 'season' THEN
      v_keys := array_append(v_keys, 'season:' || (v_row->>'league_season_id'));
    ELSIF TG_ARGV[0] = 'lineup' THEN
      v_keys := array_append(v_keys, 'lineup:' || (v_row->>'league_season_id') || ':' || (v_row->>'week_number'));
    ELSIF TG_ARGV[0] = 'result' THEN
      v_keys := array_append(v_keys, 'result:' || (v_row->>'league_season_id') || ':' || (v_row->>'week_number'));
    END IF;
  END LOOP;
  PERFORM private.bump_score_input_revisions(v_keys);
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE FUNCTION private.score_input_keys(p_season_id uuid, p_week int)
RETURNS TABLE(scope text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH season AS (
    SELECT id, league_id, season_year FROM public.league_seasons WHERE id = p_season_id
  ), bounds AS (
    SELECT CASE WHEN bool_or(matchup_type = 'regular_season') THEN 1 ELSE p_week END AS first_week,
      COALESCE(max(COALESCE(end_week_number, week_number)), p_week) AS last_week
    FROM public.matchups WHERE league_season_id = p_season_id AND week_number = p_week
  ), keys AS (
    SELECT unnest(ARRAY['players', 'calendar:' || season_year, 'league:' || league_id, 'season:' || id]) AS scope FROM season
    UNION ALL SELECT 'nba:' || season_year || ':' || week FROM season, bounds, generate_series(first_week, last_week) week
    UNION ALL SELECT 'lineup:' || id || ':' || week FROM season, bounds, generate_series(first_week, last_week) week
    UNION ALL SELECT 'result:' || id || ':' || week FROM season, bounds, generate_series(first_week, p_week) week
  ) SELECT DISTINCT scope FROM keys ORDER BY scope;
$$;

CREATE OR REPLACE FUNCTION private.score_input_token(p_season_id uuid, p_week int)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN count(*) > 0 AND bool_and(revision IS NOT NULL)
    THEN jsonb_object_agg(keys.scope, revision::text) ELSE NULL END
  FROM private.score_input_keys(p_season_id, p_week) keys
  LEFT JOIN private.score_input_revisions revision ON revision.scope = keys.scope;
$$;

CREATE OR REPLACE FUNCTION public.capture_score_inputs(p_league_season_id uuid, p_week_number int)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO private.score_input_revisions(scope, revision)
    SELECT keys.scope, 0 FROM private.score_input_keys(p_league_season_id, p_week_number) keys
    WHERE NOT EXISTS(SELECT 1 FROM private.score_input_revisions revision WHERE revision.scope = keys.scope) ORDER BY keys.scope
    ON CONFLICT(scope) DO NOTHING;
  RETURN private.score_input_token(p_league_season_id, p_week_number);
END;
$$;

CREATE OR REPLACE FUNCTION private.lock_current_score_inputs(p_season_id uuid, p_week int, p_token jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_token IS NULL OR jsonb_typeof(p_token) <> 'object' THEN RETURN false; END IF;
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

CREATE OR REPLACE FUNCTION public.get_stale_score_weeks(p_league_season_id uuid, p_through_week int)
RETURNS TABLE(week_number int) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT matchup.week_number
  FROM public.matchups matchup
  LEFT JOIN private.score_week_certificates certificate
    ON certificate.league_season_id = matchup.league_season_id AND certificate.week_number = matchup.week_number
  WHERE matchup.league_season_id = p_league_season_id AND matchup.week_number <= p_through_week
    AND matchup.is_finalized IS TRUE
    AND NOT private.playoff_round_is_consumed(p_league_season_id, matchup.matchup_type)
    AND (certificate.input_token IS NULL OR certificate.input_token IS DISTINCT FROM private.score_input_token(p_league_season_id, matchup.week_number))
  ORDER BY matchup.week_number;
$$;

CREATE TRIGGER score_revision_nba AFTER INSERT OR UPDATE OR DELETE ON public.player_game_stats FOR EACH ROW EXECUTE FUNCTION private.track_score_input_revision('nba', 'player_id,game_id,season_year,week_number,game_date,points,rebounds,assists,steals,blocks,turnovers,three_pointers_made,field_goals_made,field_goals_attempted,free_throws_made,free_throws_attempted,double_double,triple_double,did_not_play');

CREATE TRIGGER score_revision_nba AFTER INSERT OR UPDATE OR DELETE ON public.nba_games FOR EACH ROW EXECUTE FUNCTION private.track_score_input_revision('nba', 'id,nba_game_id,season_year,game_date,status,stats_synced_at,game_time,started_at');

CREATE TRIGGER score_revision_calendar AFTER INSERT OR UPDATE OR DELETE ON public.season_weeks FOR EACH ROW EXECUTE FUNCTION private.track_score_input_revision('calendar', 'season_year,week_number,week_start,week_end');

CREATE TRIGGER score_revision_players AFTER INSERT OR UPDATE OR DELETE ON public.players FOR EACH ROW EXECUTE FUNCTION private.track_score_input_revision('players', 'id,position,eligible_positions');

CREATE TRIGGER score_revision_league AFTER INSERT OR UPDATE OR DELETE ON public.leagues FOR EACH ROW EXECUTE FUNCTION private.track_score_input_revision('league', 'id,scoring_settings');

CREATE TRIGGER score_revision_league AFTER INSERT OR UPDATE OR DELETE ON public.league_members FOR EACH ROW EXECUTE FUNCTION private.track_score_input_revision('league', 'id,league_id');

CREATE TRIGGER score_revision_league AFTER INSERT OR UPDATE OR DELETE ON public.lineup_slot_templates FOR EACH ROW EXECUTE FUNCTION private.track_score_input_revision('league', 'league_id,slot_type,slot_count');

CREATE TRIGGER score_revision_season AFTER INSERT OR UPDATE OR DELETE ON public.roster_players FOR EACH ROW EXECUTE FUNCTION private.track_score_input_revision('season', 'league_season_id,member_id,player_id,acquired_at,is_on_ir,is_on_taxi');

CREATE TRIGGER score_revision_season AFTER INSERT OR UPDATE OR DELETE ON public.roster_transactions FOR EACH ROW EXECUTE FUNCTION private.track_score_input_revision('season', 'league_season_id,member_id,player_id,transaction_type,occurred_at');

CREATE TRIGGER score_revision_season AFTER INSERT OR UPDATE OR DELETE ON public.waiver_priorities FOR EACH ROW EXECUTE FUNCTION private.track_score_input_revision('season', 'league_season_id,member_id,priority');

CREATE TRIGGER score_revision_lineup AFTER INSERT OR UPDATE OR DELETE ON public.weekly_lineups FOR EACH ROW EXECUTE FUNCTION private.track_score_input_revision('lineup', 'league_season_id,week_number,member_id,player_id,game_date,slot_type');

CREATE TRIGGER score_revision_season AFTER INSERT OR UPDATE OR DELETE ON public.matchups FOR EACH ROW EXECUTE FUNCTION private.track_score_input_revision('season', 'id,league_season_id,week_number,end_week_number,matchup_type,home_member_id,away_member_id');

CREATE TRIGGER score_revision_result AFTER INSERT OR UPDATE OR DELETE ON public.matchups FOR EACH ROW EXECUTE FUNCTION private.track_score_input_revision('result', 'league_season_id,week_number,is_finalized,home_points,away_points,home_max_possible_points,away_max_possible_points,winner_member_id');

CREATE TRIGGER score_revision_result AFTER INSERT OR UPDATE OR DELETE ON public.standings FOR EACH ROW EXECUTE FUNCTION private.track_score_input_revision('result', 'league_season_id,week_number,member_id,wins,losses,ties,points_for,points_against,max_possible_points,waiver_priority');

REVOKE ALL ON FUNCTION private.bump_score_input_revisions(text[]) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION private.track_score_input_revision() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION private.score_input_keys(uuid,int) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION private.score_input_token(uuid,int) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION private.lock_current_score_inputs(uuid,int,jsonb) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.capture_score_inputs(uuid,int) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.get_stale_score_weeks(uuid,int) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.capture_score_inputs(uuid,int) TO service_role;

GRANT EXECUTE ON FUNCTION public.get_stale_score_weeks(uuid,int) TO service_role;

-- Canonical SQL source for public.finalize_score_week_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.finalize_score_week_atomic(
  p_league_id uuid,
  p_league_season_id uuid,
  p_week_number int,
  p_matchups jsonb,
  p_standings jsonb,
  p_finalized_at timestamptz DEFAULT now(),
  p_reconciliation_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_requested_count int;
  v_distinct_count int;
  v_locked_count int;
  v_notifications jsonb := '[]'::jsonb;
  v_input_token jsonb;
BEGIN
  IF p_matchups IS NULL OR jsonb_typeof(p_matchups) <> 'array' THEN
    RAISE EXCEPTION 'p_matchups must be a JSON array.'
      USING ERRCODE = '22023';
  END IF;

  IF p_standings IS NULL OR jsonb_typeof(p_standings) <> 'array' THEN
    RAISE EXCEPTION 'p_standings must be a JSON array.'
      USING ERRCODE = '22023';
  END IF;

  SELECT count(*), count(DISTINCT requested.id)
    INTO v_requested_count, v_distinct_count
    FROM jsonb_to_recordset(p_matchups) AS requested(
      id uuid,
      winner_member_id uuid,
      home_max_possible_points numeric,
      away_max_possible_points numeric
    );

  IF v_requested_count = 0 THEN
    RETURN v_notifications;
  END IF;

  IF v_distinct_count <> v_requested_count THEN
    RAISE EXCEPTION 'p_matchups contains duplicate matchup ids.'
      USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.leagues WHERE id = p_league_id FOR UPDATE;
  PERFORM 1 FROM public.league_seasons WHERE id = p_league_season_id AND league_id = p_league_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'League season not found.' USING ERRCODE = '22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('playoff-bracket'), hashtext(p_league_season_id::text));

  v_input_token := p_matchups->0->'input_token';
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_matchups) item WHERE item->'input_token' IS DISTINCT FROM v_input_token)
      OR NOT private.lock_current_score_inputs(p_league_season_id, p_week_number, v_input_token) THEN
    RAISE EXCEPTION 'Score inputs changed or were not certified. Retry scoring.' USING ERRCODE = '40001';
  END IF;

  WITH requested AS (
    SELECT *
      FROM jsonb_to_recordset(p_matchups) AS requested(
        id uuid,
        winner_member_id uuid,
        home_points numeric,
        away_points numeric,
        home_max_possible_points numeric,
        away_max_possible_points numeric,
        score_read_started_at timestamptz,
        reconcile_decision boolean
      )
  ),
  locked AS (
    SELECT
      matchup.*,
      requested.winner_member_id AS requested_winner_member_id,
      requested.home_points AS requested_home_points,
      requested.away_points AS requested_away_points,
      requested.home_max_possible_points AS requested_home_max_possible_points,
      requested.away_max_possible_points AS requested_away_max_possible_points,
      requested.score_read_started_at AS requested_score_read_started_at,
      requested.reconcile_decision AS requested_reconcile_decision
    FROM public.matchups AS matchup
    JOIN requested
      ON requested.id = matchup.id
    WHERE matchup.league_id = p_league_id
      AND matchup.league_season_id = p_league_season_id
      AND matchup.week_number = p_week_number
    FOR UPDATE
  )
  SELECT count(*)
    INTO v_locked_count
    FROM locked;

  IF v_locked_count <> v_requested_count THEN
    RAISE EXCEPTION 'p_matchups contains rows outside the target league season week.'
      USING ERRCODE = '22023';
  END IF;

  WITH requested AS (
    SELECT *
      FROM jsonb_to_recordset(p_matchups) AS requested(
        id uuid,
        winner_member_id uuid,
        home_points numeric,
        away_points numeric,
        home_max_possible_points numeric,
        away_max_possible_points numeric,
        score_read_started_at timestamptz,
        reconcile_decision boolean
      )
  ),
  locked AS (
    SELECT
      matchup.*,
      requested.winner_member_id AS requested_winner_member_id,
      requested.home_points AS requested_home_points,
      requested.away_points AS requested_away_points,
      requested.home_max_possible_points AS requested_home_max_possible_points,
      requested.away_max_possible_points AS requested_away_max_possible_points,
      requested.score_read_started_at AS requested_score_read_started_at,
      requested.reconcile_decision AS requested_reconcile_decision
    FROM public.matchups AS matchup
    JOIN requested
      ON requested.id = matchup.id
    WHERE matchup.league_id = p_league_id
      AND matchup.league_season_id = p_league_season_id
      AND matchup.week_number = p_week_number
    FOR UPDATE
  ),
  updated AS (
    UPDATE public.matchups AS matchup
       SET winner_member_id = locked.requested_winner_member_id,
           home_points = COALESCE(locked.requested_home_points, locked.home_points),
           away_points = COALESCE(locked.requested_away_points, locked.away_points),
           home_max_possible_points = locked.requested_home_max_possible_points,
           away_max_possible_points = locked.requested_away_max_possible_points,
           is_finalized = true,
           score_read_started_at = COALESCE(locked.requested_score_read_started_at, p_finalized_at),
           finalized_at = CASE
             WHEN locked.is_finalized IS FALSE THEN p_finalized_at
             WHEN locked.matchup_type IN (
               'playoff_quarterfinal'::matchup_type,
               'playoff_semifinal'::matchup_type,
               'playoff_final'::matchup_type
             ) AND (locked.winner_member_id IS DISTINCT FROM locked.requested_winner_member_id
               OR locked.home_max_possible_points IS DISTINCT FROM locked.requested_home_max_possible_points
               OR locked.away_max_possible_points IS DISTINCT FROM locked.requested_away_max_possible_points) THEN p_reconciliation_at
             ELSE matchup.finalized_at
           END
      FROM locked
     WHERE matchup.id = locked.id
       AND NOT private.playoff_round_is_consumed(p_league_season_id, locked.matchup_type)
     RETURNING
       matchup.id,
       locked.is_finalized AS was_finalized,
       matchup.home_member_id,
       matchup.away_member_id,
       matchup.home_points,
       matchup.away_points,
       matchup.winner_member_id
  ),
  notification_rows AS (
    SELECT *
      FROM updated
     WHERE was_finalized IS FALSE
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', id,
        'home_member_id', home_member_id,
        'away_member_id', away_member_id,
        'home_points', home_points,
        'away_points', away_points,
        'winner_member_id', winner_member_id
      )
      ORDER BY id
    ),
    '[]'::jsonb
  )
    INTO v_notifications
    FROM notification_rows;

  INSERT INTO public.standings (
    league_id,
    league_season_id,
    member_id,
    week_number,
    created_at,
    wins,
    losses,
    ties,
    points_for,
    points_against,
    max_possible_points,
    waiver_priority
  )
  SELECT
    p_league_id,
    p_league_season_id,
    standing.member_id,
    p_week_number,
    COALESCE(standing.created_at, p_finalized_at),
    standing.wins,
    standing.losses,
    standing.ties,
    standing.points_for,
    standing.points_against,
    standing.max_possible_points,
    standing.waiver_priority
  FROM jsonb_to_recordset(p_standings) AS standing(
    member_id uuid,
    created_at timestamptz,
    wins int,
    losses int,
    ties int,
    points_for numeric,
    points_against numeric,
    max_possible_points numeric,
    waiver_priority int
  )
  ON CONFLICT (league_id, league_season_id, member_id, week_number)
  DO UPDATE SET
    created_at = EXCLUDED.created_at,
    wins = EXCLUDED.wins,
    losses = EXCLUDED.losses,
    ties = EXCLUDED.ties,
    points_for = EXCLUDED.points_for,
    points_against = EXCLUDED.points_against,
    max_possible_points = EXCLUDED.max_possible_points,
    waiver_priority = EXCLUDED.waiver_priority;

  INSERT INTO private.score_week_certificates(league_season_id, week_number, input_token)
    VALUES(p_league_season_id, p_week_number, private.score_input_token(p_league_season_id, p_week_number))
    ON CONFLICT(league_season_id, week_number) DO UPDATE SET input_token = EXCLUDED.input_token;

  RETURN v_notifications;
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

  -- Keep input revisions locked through the transition. Missing legacy
  -- certificates require an actual replay, never a timestamp backfill.
  FOR v_week IN SELECT DISTINCT week_number FROM public.matchups
      WHERE league_season_id = p_league_season_id AND matchup_type = v_type
        AND (v_type <> 'regular_season' OR week_number < v_start) ORDER BY week_number LOOP
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

COMMIT;
