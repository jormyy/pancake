-- Canonical SQL source for private.assert_roster_action_allowed.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.assert_roster_action_allowed(p_action private.roster_action, p_league_id uuid,
  p_league_season_id uuid, p_member_id uuid, p_player_id uuid, p_pick_id uuid DEFAULT NULL, p_exempt_trade_ids uuid[] DEFAULT '{}')
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE blocked record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM private.roster_action_policy() policy WHERE policy.action=p_action AND policy.errcode IS NOT NULL) THEN
    RETURN;
  END IF;
  SELECT block.errcode, block.reason INTO blocked
    FROM private.roster_action_blocks(p_action, p_league_id, p_league_season_id, p_member_id, p_exempt_trade_ids) block
    WHERE (block.asset_kind='player' AND block.asset_id=p_player_id) OR (block.asset_kind='pick' AND block.asset_id=p_pick_id)
    LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '%', blocked.reason USING ERRCODE=blocked.errcode; END IF;
END;
$$;
