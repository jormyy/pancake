-- Canonical SQL source for private.is_reserved_trade_asset.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.is_reserved_trade_asset(
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid,
  p_player_id uuid DEFAULT NULL,
  p_pick_id uuid DEFAULT NULL,
  p_exclude_trade_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM private.roster_action_blocks('trade_accept', p_league_id, p_league_season_id, p_member_id, ARRAY[p_exclude_trade_id]) block
    WHERE (block.asset_kind='player' AND block.asset_id=p_player_id) OR (block.asset_kind='pick' AND block.asset_id=p_pick_id)
  )
$$;
