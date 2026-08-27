-- Canonical SQL source for private.expire_pending_trades_for_lost_asset.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.expire_pending_trades_for_lost_asset(
  p_league_id uuid,
  p_member_id uuid,
  p_player_id uuid DEFAULT NULL,
  p_pick_id uuid DEFAULT NULL,
  p_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reason text := NULLIF(BTRIM(COALESCE(p_reason, '')), '');
  v_team text;
  v_previous_flag text := COALESCE(current_setting('app.trade_lifecycle_server_write', true), '');
BEGIN
  IF p_player_id IS NULL AND p_pick_id IS NULL THEN
    RETURN;
  END IF;

  IF v_reason IS NULL THEN
    SELECT member.team_name
      INTO v_team
      FROM league_members AS member
     WHERE member.id = p_member_id;

    IF p_player_id IS NOT NULL THEN
      SELECT format('%s is no longer on %s.', COALESCE(player.display_name, 'A player'), COALESCE(v_team, 'the offering roster'))
        INTO v_reason
        FROM players AS player
       WHERE player.id = p_player_id;
    ELSE
      SELECT format('The %s round %s pick is no longer owned by %s.', pick.season_year, pick.round, COALESCE(v_team, 'the offering team'))
        INTO v_reason
        FROM draft_picks AS pick
       WHERE pick.id = p_pick_id;
    END IF;

    v_reason := COALESCE(v_reason, 'A trade asset is no longer available.');
  END IF;

  -- This runs inside the caller's transaction, which may belong to an
  -- authenticated user; the status guard trusts this flag for the update only.
  -- Trade completion may already hold the flag, so it is restored, not cleared.
  PERFORM set_config('app.trade_lifecycle_server_write', 'on', true);

  WITH expired AS (
    UPDATE trades AS trade
       SET status = 'expired'::trade_status,
           completion_failure_reason = v_reason
     WHERE trade.league_id = p_league_id
       AND trade.status = 'pending'::trade_status
       AND EXISTS (
         SELECT 1
           FROM trade_items AS item
          WHERE item.trade_id = trade.id
            AND item.from_member_id = p_member_id
            AND (
              (p_player_id IS NOT NULL AND item.player_id = p_player_id)
              OR (p_pick_id IS NOT NULL AND item.pick_id = p_pick_id)
            )
       )
     RETURNING trade.id, trade.league_id, trade.league_season_id, trade.proposer_member_id, trade.recipient_member_id
  )
  INSERT INTO league_activity (
    league_id,
    league_season_id,
    actor_member_id,
    target_member_id,
    related_player_id,
    related_trade_id,
    event_type,
    title,
    body
  )
  SELECT
    expired.league_id,
    expired.league_season_id,
    expired.proposer_member_id,
    expired.recipient_member_id,
    p_player_id,
    expired.id,
    'trade_expired',
    'Trade offer expired',
    v_reason
    FROM expired;

  PERFORM set_config('app.trade_lifecycle_server_write', v_previous_flag, true);
END;
$$;
