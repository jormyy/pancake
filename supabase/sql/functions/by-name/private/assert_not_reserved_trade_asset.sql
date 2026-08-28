-- Canonical SQL source for private.assert_not_reserved_trade_asset.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.assert_not_reserved_trade_asset(
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid,
  p_player_id uuid DEFAULT NULL,
  p_pick_id uuid DEFAULT NULL,
  p_exclude_trade_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF private.is_reserved_trade_asset(p_league_id, p_league_season_id, p_member_id, p_player_id, p_pick_id, p_exclude_trade_id) THEN
    RAISE EXCEPTION '%', private.reserved_trade_asset_message() USING ERRCODE = 'PA004';
  END IF;
END;
$$;
