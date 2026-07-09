-- Canonical SQL source for private.prevent_reserved_drop_roster_delete.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.prevent_reserved_drop_roster_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, private
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM trade_drop_reservations AS reservation
      JOIN trades AS trade
        ON trade.id = reservation.trade_id
       AND trade.status = 'accepted'::trade_status
     WHERE reservation.roster_player_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'This roster player is reserved for an accepted trade.'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM trade_items AS item
      JOIN trades AS trade
        ON trade.id = item.trade_id
       AND trade.status = 'accepted'::trade_status
     WHERE trade.league_id = OLD.league_id
       AND trade.league_season_id = OLD.league_season_id
       AND item.player_id = OLD.player_id
       AND COALESCE(
         item.from_member_id,
         CASE WHEN item.side = 'proposer'::trade_side THEN trade.proposer_member_id ELSE trade.recipient_member_id END
       ) = OLD.member_id
  ) THEN
    RAISE EXCEPTION 'This roster player is reserved as an accepted trade asset.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN OLD;
END;
$$;
