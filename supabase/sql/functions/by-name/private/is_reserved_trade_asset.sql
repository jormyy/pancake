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
    SELECT 1 FROM private.locked_assets(p_league_id,
      COALESCE(p_league_season_id, (SELECT id FROM public.league_seasons WHERE league_id=p_league_id AND is_current)), p_member_id) locked
    JOIN public.trades reservation ON reservation.id=locked.source_id AND reservation.status='accepted'
    WHERE locked.source_kind='trade' AND (p_exclude_trade_id IS NULL OR locked.source_id<>p_exclude_trade_id)
      AND ((locked.asset_kind='player' AND locked.asset_id=p_player_id) OR (locked.asset_kind='pick' AND locked.asset_id=p_pick_id))
  )
$$;
