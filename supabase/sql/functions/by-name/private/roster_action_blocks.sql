-- Canonical SQL source for private.roster_action_blocks.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.roster_action_blocks(p_action private.roster_action, p_league_id uuid, p_league_season_id uuid,
  p_member_id uuid, p_exempt_trade_ids uuid[] DEFAULT '{}')
RETURNS TABLE(asset_kind text, asset_id uuid, hold private.roster_hold, errcode text, reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT locked.asset_kind, locked.asset_id, held.hold, policy.errcode, locked.reason
  FROM private.locked_assets(p_league_id,
    COALESCE(p_league_season_id, (SELECT id FROM public.league_seasons WHERE league_id=p_league_id AND is_current)), p_member_id) locked
  LEFT JOIN public.trades trade ON locked.source_kind='trade' AND trade.id=locked.source_id
  CROSS JOIN LATERAL (SELECT CASE WHEN locked.source_kind='claim' THEN 'claim_reserved'
    WHEN trade.status='accepted' THEN 'trade_reserved' ELSE 'offer_pending' END::private.roster_hold AS hold) held
  JOIN private.roster_action_policy() policy ON policy.action=p_action AND policy.hold=held.hold
  WHERE policy.errcode IS NOT NULL
    AND NOT (locked.source_kind='trade' AND COALESCE(locked.source_id=ANY(p_exempt_trade_ids), false))
  ORDER BY locked.source_kind, locked.source_id
$$;
