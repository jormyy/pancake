-- Retention preserves published results after their replay inputs leave the supported window.
BEGIN;
CREATE TABLE private.retired_score_inputs (
  league_season_id uuid PRIMARY KEY REFERENCES public.league_seasons(id) ON DELETE CASCADE,
  retired_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON private.retired_score_inputs FROM PUBLIC, anon, authenticated;
-- Earlier pruning has no durable execution marker. The same existing retention
-- window conservatively protects legacy history without inventing missing inputs.
INSERT INTO private.retired_score_inputs(league_season_id)
  SELECT id FROM (
    SELECT id, row_number() OVER (PARTITION BY league_id ORDER BY season_year DESC) AS rn
    FROM public.league_seasons
  ) ranked WHERE rn > 2;

CREATE OR REPLACE FUNCTION public.prune_unbounded_history()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sync_runs bigint;
  v_projection_runs bigint;
  v_weekly_lineups bigint;
  v_standings bigint;
  v_roster_transactions bigint;
  v_dynasty_news bigint;
  v_cron_runs bigint := 0;
BEGIN
  DELETE FROM public.sync_runs
   WHERE started_at < now() - interval '90 days';
  GET DIAGNOSTICS v_sync_runs = ROW_COUNT;

  -- fantasypros_projection_rows cascades from its run (ON DELETE CASCADE);
  -- product queries only read the latest run per date.
  DELETE FROM public.projection_sync_runs
   WHERE started_at < now() - interval '30 days';
  GET DIAGNOSTICS v_projection_runs = ROW_COUNT;

  -- Per-league season recency: rn 1 = current/most recent season.
  CREATE TEMP TABLE IF NOT EXISTS pruning_season_ranks ON COMMIT DROP AS
  SELECT
    id,
    league_id,
    row_number() OVER (PARTITION BY league_id ORDER BY season_year DESC) AS rn
  FROM public.league_seasons;

  -- Serialize retirement with scoring before any replay inputs disappear.
  PERFORM 1 FROM public.leagues league
    WHERE EXISTS (SELECT 1 FROM public.league_seasons season
      JOIN pruning_season_ranks ranked ON ranked.id = season.id
      WHERE season.league_id = league.id AND ranked.rn > 2)
    ORDER BY league.id FOR UPDATE;
  PERFORM 1 FROM public.league_seasons season
    JOIN pruning_season_ranks ranked ON ranked.id = season.id
    WHERE ranked.rn > 2 ORDER BY season.id FOR UPDATE OF season;
  INSERT INTO private.retired_score_inputs(league_season_id)
    SELECT id FROM pruning_season_ranks WHERE rn > 2
    ON CONFLICT(league_season_id) DO NOTHING;

  -- Keep two seasons of replay inputs. Older results remain authoritative.
  DELETE FROM public.weekly_lineups AS wl
   USING pruning_season_ranks AS ranked
   WHERE wl.league_season_id = ranked.id
     AND ranked.rn > 2;
  GET DIAGNOSTICS v_weekly_lineups = ROW_COUNT;

  -- Old seasons keep each member's final standings snapshot (history and
  -- champion views read it); intermediate weekly snapshots are never shown.
  DELETE FROM public.standings AS s
   USING pruning_season_ranks AS ranked
   WHERE s.league_season_id = ranked.id
     AND ranked.rn > 2
     AND s.week_number < (
       SELECT max(inner_s.week_number)
         FROM public.standings AS inner_s
        WHERE inner_s.league_season_id = s.league_season_id
          AND inner_s.member_id = s.member_id
     );
  GET DIAGNOSTICS v_standings = ROW_COUNT;

  -- News feed shows a bounded recent list; keep 60 days.
  DELETE FROM public.dynasty_news
   WHERE published_at < now() - interval '60 days';
  GET DIAGNOSTICS v_dynasty_news = ROW_COUNT;

  -- Transaction history UI pages recent activity; keep three seasons.
  DELETE FROM public.roster_transactions AS rt
   USING pruning_season_ranks AS ranked
   WHERE rt.league_season_id = ranked.id
     AND ranked.rn > 3;
  GET DIAGNOSTICS v_roster_transactions = ROW_COUNT;

  DROP TABLE IF EXISTS pruning_season_ranks;

  -- pg_cron logs every run and never prunes it; the per-minute jobs add
  -- about 4,400 rows a day. Keep 30 days for debugging.
  IF to_regclass('cron.job_run_details') IS NOT NULL THEN
    DELETE FROM cron.job_run_details
     WHERE start_time < now() - interval '30 days';
    GET DIAGNOSTICS v_cron_runs = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object(
    'sync_runs', v_sync_runs,
    'projection_sync_runs', v_projection_runs,
    'weekly_lineups', v_weekly_lineups,
    'standings', v_standings,
    'roster_transactions', v_roster_transactions,
    'dynasty_news', v_dynasty_news,
    'cron_job_run_details', v_cron_runs
  );
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
  IF EXISTS(SELECT 1 FROM private.retired_score_inputs WHERE league_season_id = p_league_season_id) THEN
    RAISE EXCEPTION 'Historical score inputs have been retired. Existing results are preserved.' USING ERRCODE = '55000';
  END IF;
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

CREATE OR REPLACE FUNCTION private.lock_current_score_inputs(p_season_id uuid, p_week int, p_token jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM private.retired_score_inputs WHERE league_season_id = p_season_id) THEN RETURN false; END IF;
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

CREATE OR REPLACE FUNCTION public.capture_score_inputs(p_league_season_id uuid, p_week_number int)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM private.retired_score_inputs WHERE league_season_id = p_league_season_id) THEN
    RAISE EXCEPTION 'Historical score inputs have been retired. Existing results are preserved.' USING ERRCODE = '55000';
  END IF;
  INSERT INTO private.score_input_revisions(scope, revision)
    SELECT keys.scope, 0 FROM private.score_input_keys(p_league_season_id, p_week_number) keys
    WHERE NOT EXISTS(SELECT 1 FROM private.score_input_revisions revision WHERE revision.scope = keys.scope) ORDER BY keys.scope
    ON CONFLICT(scope) DO NOTHING;
  RETURN private.score_input_token(p_league_season_id, p_week_number);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_stale_score_weeks(p_league_season_id uuid, p_through_week int)
RETURNS TABLE(week_number int) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT matchup.week_number
  FROM public.matchups matchup
  LEFT JOIN private.score_week_certificates certificate
    ON certificate.league_season_id = matchup.league_season_id AND certificate.week_number = matchup.week_number
  WHERE matchup.league_season_id = p_league_season_id AND matchup.week_number <= p_through_week
    AND NOT EXISTS(SELECT 1 FROM private.retired_score_inputs WHERE league_season_id = p_league_season_id)
    AND matchup.is_finalized IS TRUE
    AND NOT private.playoff_round_is_consumed(p_league_season_id, matchup.matchup_type)
    AND (certificate.input_token IS NULL OR certificate.input_token IS DISTINCT FROM private.score_input_token(p_league_season_id, matchup.week_number))
  ORDER BY matchup.week_number;
$$;

COMMIT;
