-- Canonical SQL source for private.release_roster_player_to_waivers.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.release_roster_player_to_waivers(
  p_roster_player_id uuid,
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid,
  p_player_id uuid,
  p_transaction_type text,
  p_related_claim_id uuid DEFAULT NULL,
  p_related_trade_id uuid DEFAULT NULL,
  p_missing_message text DEFAULT 'Roster player is no longer on the expected roster.'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows int;
BEGIN
  DELETE FROM roster_players AS rp
   WHERE rp.id = p_roster_player_id
     AND rp.league_id = p_league_id
     AND rp.league_season_id = p_league_season_id
     AND rp.member_id = p_member_id
     AND rp.player_id = p_player_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION '%', p_missing_message
      USING ERRCODE = 'PT001';
  END IF;

  PERFORM private.clear_trade_block_listing_for_asset(
    p_league_id,
    p_member_id,
    p_player_id
  );

  PERFORM private.clear_future_unlocked_lineups(
    p_league_id,
    p_league_season_id,
    p_player_id,
    p_member_id
  );

  INSERT INTO waiver_wire_log (
    league_id,
    league_season_id,
    player_id,
    dropped_by_member_id,
    clears_at
  )
  VALUES (
    p_league_id,
    p_league_season_id,
    p_player_id,
    p_member_id,
    now() + interval '48 hours'
  );

  INSERT INTO roster_transactions (
    league_id,
    league_season_id,
    member_id,
    player_id,
    transaction_type,
    related_claim_id,
    related_trade_id
  )
  VALUES (
    p_league_id,
    p_league_season_id,
    p_member_id,
    p_player_id,
    p_transaction_type,
    p_related_claim_id,
    p_related_trade_id
  );
END;
$$;
