-- Canonical SQL source for private.prevent_trade_drop_reserved_asset.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.prevent_trade_drop_reserved_asset()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, private
AS $$
DECLARE
  v_trade trades%ROWTYPE;
BEGIN
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = NEW.trade_id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM trade_items AS item
      JOIN trades AS trade
        ON trade.id = item.trade_id
       AND trade.status = 'accepted'::trade_status
     WHERE item.trade_id <> NEW.trade_id
       AND item.player_id = NEW.player_id
       AND trade.league_id = v_trade.league_id
       AND trade.league_season_id = v_trade.league_season_id
       AND CASE
         WHEN item.side = 'proposer'::trade_side THEN trade.proposer_member_id
         ELSE trade.recipient_member_id
       END = NEW.member_id
  ) THEN
    RAISE EXCEPTION 'Trade drop player is reserved as an accepted trade asset.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;
