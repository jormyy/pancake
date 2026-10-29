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
SET search_path = ''
AS $$
DECLARE lock_reason text;
BEGIN
  SELECT locked.reason INTO lock_reason FROM private.locked_assets(p_league_id,
    COALESCE(p_league_season_id, (SELECT id FROM public.league_seasons WHERE league_id=p_league_id AND is_current)), p_member_id) locked
    WHERE locked.source_kind='trade' AND (p_exclude_trade_id IS NULL OR locked.source_id<>p_exclude_trade_id)
      AND ((locked.asset_kind='player' AND locked.asset_id=p_player_id) OR (locked.asset_kind='pick' AND locked.asset_id=p_pick_id))
    ORDER BY locked.source_id LIMIT 1;
  IF lock_reason IS NOT NULL THEN RAISE EXCEPTION '%', lock_reason USING ERRCODE = 'PA004'; END IF;
END;
$$;
