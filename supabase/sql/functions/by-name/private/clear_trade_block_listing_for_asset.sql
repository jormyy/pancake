-- Canonical SQL source for private.clear_trade_block_listing_for_asset.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.clear_trade_block_listing_for_asset(
  p_league_id uuid,
  p_member_id uuid,
  p_player_id uuid DEFAULT NULL,
  p_pick_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM trade_block_items AS item
   WHERE item.league_id = p_league_id
     AND item.member_id = p_member_id
     AND (
       (p_player_id IS NOT NULL AND item.player_id = p_player_id)
       OR (p_pick_id IS NOT NULL AND item.pick_id = p_pick_id)
     );
$$;
