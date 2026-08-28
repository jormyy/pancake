-- Canonical SQL source for private.sync_roster_linked_state.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.sync_roster_linked_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_left_roster boolean := TG_OP = 'DELETE' OR OLD.member_id IS DISTINCT FROM NEW.member_id;
  v_became_inactive boolean := TG_OP = 'UPDATE'
    AND (NEW.is_on_ir = true OR NEW.is_on_taxi = true)
    AND (OLD.is_on_ir IS DISTINCT FROM NEW.is_on_ir OR OLD.is_on_taxi IS DISTINCT FROM NEW.is_on_taxi);
  v_still_active boolean;
BEGIN
  IF NOT (v_left_roster OR v_became_inactive) THEN
    RETURN NULL;
  END IF;

  PERFORM private.clear_future_unlocked_lineups(
    OLD.league_id,
    OLD.league_season_id,
    OLD.player_id,
    OLD.member_id
  );

  -- Roster-linked state is only stale when no active current-season row is left
  -- for this member and player (an old-season row going away must not touch it).
  SELECT EXISTS (
    SELECT 1
      FROM roster_players AS roster
      JOIN league_seasons AS season
        ON season.id = roster.league_season_id
       AND season.is_current = true
     WHERE roster.league_id = OLD.league_id
       AND roster.member_id = OLD.member_id
       AND roster.player_id = OLD.player_id
       AND roster.is_on_ir = false
       AND roster.is_on_taxi = false
  )
    INTO v_still_active;

  IF v_still_active THEN
    RETURN NULL;
  END IF;

  DELETE FROM trade_block_items
   WHERE league_id = OLD.league_id
     AND member_id = OLD.member_id
     AND player_id = OLD.player_id;

  IF v_left_roster THEN
    UPDATE waiver_claims
       SET drop_player_id = NULL
     WHERE status = 'pending'::waiver_claim_status
       AND league_id = OLD.league_id
       AND league_season_id = OLD.league_season_id
       AND member_id = OLD.member_id
       AND drop_player_id = OLD.player_id;

    PERFORM private.expire_pending_trades_for_lost_asset(
      OLD.league_id,
      OLD.member_id,
      OLD.player_id
    );
  END IF;

  RETURN NULL;
END;
$$;
