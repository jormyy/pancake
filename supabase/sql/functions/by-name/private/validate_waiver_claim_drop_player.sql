-- Canonical SQL source for private.validate_waiver_claim_drop_player.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.validate_waiver_claim_drop_player(
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid,
  p_drop_player_id uuid,
  p_missing_message text DEFAULT 'Drop player must be on your roster.'
)
RETURNS TABLE (
  roster_player_id uuid,
  failure_reason text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_roster_player_id uuid;
  lock_reason text;
  v_inactive boolean;
BEGIN
  IF p_drop_player_id IS NULL THEN
    RETURN QUERY SELECT NULL::uuid, NULL::text;
    RETURN;
  END IF;

  SELECT rp.id, rp.is_on_ir OR rp.is_on_taxi
    INTO v_roster_player_id, v_inactive
    FROM roster_players AS rp
   WHERE rp.member_id = p_member_id
     AND rp.league_id = p_league_id
     AND rp.league_season_id = p_league_season_id
     AND rp.player_id = p_drop_player_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, p_missing_message;
    RETURN;
  END IF;

  SELECT locked.reason INTO lock_reason FROM private.locked_assets(p_league_id, p_league_season_id, p_member_id) locked
    WHERE locked.source_kind='trade' AND locked.asset_id=p_drop_player_id ORDER BY locked.source_id LIMIT 1;
  IF lock_reason IS NOT NULL THEN
    RETURN QUERY SELECT v_roster_player_id, lock_reason;
    RETURN;
  END IF;

  IF v_inactive AND (private.roster_status_game_started(p_drop_player_id) OR EXISTS (
    SELECT 1 FROM weekly_lineups lineup
     WHERE lineup.league_id=p_league_id AND lineup.league_season_id=p_league_season_id
       AND lineup.member_id=p_member_id AND lineup.player_id=p_drop_player_id
       AND lineup.game_date >= (now() AT TIME ZONE 'America/New_York')::date
       AND private.lineup_game_started(p_drop_player_id,lineup.game_date)
  )) THEN
    RETURN QUERY SELECT v_roster_player_id, 'This player''s game has already started. The drop is locked for this slate.'::text;
    RETURN;
  END IF;

  RETURN QUERY SELECT v_roster_player_id, NULL::text;
END;
$$;
