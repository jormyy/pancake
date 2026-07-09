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

  WITH requested AS (
    SELECT *
      FROM jsonb_to_recordset(p_matchups) AS requested(
        id uuid,
        winner_member_id uuid,
        home_max_possible_points numeric,
        away_max_possible_points numeric
      )
  ),
  locked AS (
    SELECT
      matchup.*,
      requested.winner_member_id AS requested_winner_member_id,
      requested.home_max_possible_points AS requested_home_max_possible_points,
      requested.away_max_possible_points AS requested_away_max_possible_points
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
        home_max_possible_points numeric,
        away_max_possible_points numeric
      )
  ),
  locked AS (
    SELECT
      matchup.*,
      requested.winner_member_id AS requested_winner_member_id,
      requested.home_max_possible_points AS requested_home_max_possible_points,
      requested.away_max_possible_points AS requested_away_max_possible_points
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
           home_max_possible_points = locked.requested_home_max_possible_points,
           away_max_possible_points = locked.requested_away_max_possible_points,
           is_finalized = true,
           finalized_at = CASE
             WHEN locked.is_finalized IS FALSE THEN p_finalized_at
             WHEN locked.matchup_type IN (
               'playoff_quarterfinal'::matchup_type,
               'playoff_semifinal'::matchup_type,
               'playoff_final'::matchup_type
             ) THEN p_reconciliation_at
             ELSE matchup.finalized_at
           END
      FROM locked
     WHERE matchup.id = locked.id
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

  RETURN v_notifications;
END;
$$;
