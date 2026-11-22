-- Canonical SQL source for private.roster_floor_week_ready.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.roster_floor_week_ready(
  p_league_id uuid,
  p_league_season_id uuid,
  p_week_number int,
  p_week_end date
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_zone text;
  v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_run_at timestamptz;
BEGIN
  IF p_week_number IS NULL OR p_week_end IS NULL THEN
    RETURN jsonb_build_object('ready', false, 'reason', 'no_week');
  END IF;
  IF v_today > p_week_end AND EXISTS (
    SELECT 1
      FROM private.roster_floor_weeks week_row
     WHERE week_row.league_id = p_league_id
       AND week_row.league_season_id = p_league_season_id
       AND week_row.week_number = p_week_number
       AND week_row.status = 'completed'
  ) THEN
    RETURN jsonb_build_object('ready', false, 'reason', 'week_ended');
  END IF;
  IF v_today < p_week_end THEN
    RETURN jsonb_build_object('ready', false, 'reason', 'week_not_started');
  END IF;
  SELECT COALESCE(league.timezone, 'America/Los_Angeles')
    INTO v_zone
    FROM public.leagues league
   WHERE league.id = p_league_id;
  IF v_zone IS NULL THEN
    RETURN jsonb_build_object('ready', false, 'reason', 'league');
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM private.league_roster_policies policy
     WHERE policy.league_id = p_league_id
       AND policy.floor_activated_at IS NOT NULL
  ) THEN
    RETURN jsonb_build_object('ready', false, 'reason', 'worker_pending');
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM private.league_roster_policies policy
     WHERE policy.league_id = p_league_id
       AND policy.ir_activated_at IS NOT NULL
  ) THEN
    RETURN jsonb_build_object('ready', false, 'reason', 'ir_pending');
  END IF;
  v_run_at := (p_week_end + time '00:00') AT TIME ZONE v_zone;
  IF v_run_at > now() THEN
    RETURN jsonb_build_object('ready', false, 'reason', 'waiver_run_pending');
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM private.waiver_run_settlements settlement
     WHERE settlement.league_id = p_league_id
       AND settlement.league_season_id = p_league_season_id
       AND settlement.process_date = p_week_end
  ) THEN
    RETURN jsonb_build_object('ready', false, 'reason', 'settlement_pending');
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.waiver_claims claim
     WHERE claim.league_id = p_league_id
       AND claim.league_season_id = p_league_season_id
       AND claim.status = 'pending'
       AND claim.process_date <= p_week_end
       AND (claim.process_date + time '00:00') AT TIME ZONE v_zone <= now()
       AND NOT EXISTS (
         SELECT 1
           FROM public.waiver_wire_log wire
          WHERE wire.league_id = claim.league_id
            AND wire.league_season_id = claim.league_season_id
            AND wire.player_id = claim.player_id
            AND wire.cleared_at IS NULL
            AND wire.clears_at > (claim.process_date + time '00:00') AT TIME ZONE v_zone
       )
  ) THEN
    RETURN jsonb_build_object('ready', false, 'reason', 'claims_pending');
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.nba_games game
     WHERE game.game_date IN (v_today - 1, v_today)
       AND game.status IN ('Scheduled', 'InProgress')
       AND private.lineup_game_available(game.status, game.game_status_text)
       AND (
         game.status = 'InProgress'
         OR game.game_time <= now()
         OR game.started_at <= now()
       )
  ) THEN
    RETURN jsonb_build_object('ready', false, 'reason', 'game_in_progress');
  END IF;
  RETURN jsonb_build_object('ready', true, 'reason', NULL);
END;
$$;
