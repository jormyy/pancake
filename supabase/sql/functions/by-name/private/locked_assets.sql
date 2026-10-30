-- Canonical SQL source for private.locked_assets.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.locked_assets(p_league_id uuid, p_league_season_id uuid, p_member_id uuid)
RETURNS TABLE(asset_kind text, asset_id uuid, source_kind text, source_id uuid, reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH active_trades AS (
    SELECT trade.* FROM public.trades trade
    WHERE trade.league_id = p_league_id AND trade.league_season_id = p_league_season_id
      AND trade.status IN ('pending', 'accepted')
  ), trade_assets AS (
    SELECT CASE WHEN item.player_id IS NOT NULL THEN 'player' ELSE 'pick' END AS kind,
      COALESCE(item.player_id, item.pick_id) AS id, trade.id AS trade_id, trade.status
    FROM active_trades trade JOIN public.trade_items item ON item.trade_id = trade.id
    WHERE item.from_member_id = p_member_id AND COALESCE(item.player_id, item.pick_id) IS NOT NULL
      AND (item.player_id IS NOT NULL OR trade.status = 'accepted')
    UNION
    SELECT 'player', reserved.id, trade.id, trade.status
    FROM active_trades trade JOIN public.trade_participants participant ON participant.trade_id = trade.id
    CROSS JOIN LATERAL (
      SELECT unnest(participant.drop_player_ids) AS id
      UNION SELECT (move->>'playerId')::uuid FROM jsonb_array_elements(participant.roster_moves) move
    ) reserved
    WHERE participant.member_id = p_member_id
  )
  SELECT kind, id, 'trade', trade_id,
    format('Locked by trade %s. %s', left(trade_id::text, 8),
      CASE WHEN status = 'pending' THEN 'Cancel the trade to change this asset.' ELSE 'Resolve the trade to change this asset.' END)
  FROM trade_assets
  UNION ALL
  SELECT 'player', reserved.id, 'claim', claim.id,
    format('Locked by waiver claim %s. Cancel the claim to change this player.', left(claim.id::text, 8))
  FROM public.waiver_claims claim
  CROSS JOIN LATERAL (SELECT DISTINCT unnest(ARRAY[claim.player_id, claim.drop_player_id]) AS id) reserved
  WHERE claim.league_id = p_league_id AND claim.league_season_id = p_league_season_id
    AND claim.member_id = p_member_id AND claim.status = 'pending' AND reserved.id IS NOT NULL
$$;
