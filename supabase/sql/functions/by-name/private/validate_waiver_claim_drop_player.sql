-- Canonical SQL source for private.validate_waiver_claim_drop_player.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.validate_waiver_claim_drop_player(
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid,
  p_drop_player_id uuid,
  p_missing_message text DEFAULT 'Drop player must be on your active roster.'
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
BEGIN
  IF p_drop_player_id IS NULL THEN
    RETURN QUERY SELECT NULL::uuid, NULL::text;
    RETURN;
  END IF;

  SELECT rp.id
    INTO v_roster_player_id
    FROM roster_players AS rp
   WHERE rp.member_id = p_member_id
     AND rp.league_id = p_league_id
     AND rp.league_season_id = p_league_season_id
     AND rp.player_id = p_drop_player_id
     AND rp.is_on_ir = false
     AND rp.is_on_taxi = false
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, p_missing_message;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM trade_drop_reservations AS reservation
      JOIN trades AS trade
        ON trade.id = reservation.trade_id
       AND trade.status = 'accepted'::trade_status
     WHERE reservation.roster_player_id = v_roster_player_id
  ) OR EXISTS (
    SELECT 1
      FROM trade_items AS item
      JOIN trades AS trade
        ON trade.id = item.trade_id
       AND trade.status = 'accepted'::trade_status
     WHERE item.player_id = p_drop_player_id
       AND trade.league_id = p_league_id
       AND trade.league_season_id = p_league_season_id
       AND (
         (item.side = 'proposer' AND trade.proposer_member_id = p_member_id)
         OR (item.side = 'recipient' AND trade.recipient_member_id = p_member_id)
       )
  ) THEN
    RETURN QUERY SELECT v_roster_player_id, 'Drop player is reserved for an accepted trade.';
    RETURN;
  END IF;

  RETURN QUERY SELECT v_roster_player_id, NULL::text;
END;
$$;
