-- Canonical SQL source for private.assert_asset_unlocked.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.assert_asset_unlocked(p_league_id uuid,p_league_season_id uuid,p_member_id uuid,p_player_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE lock_reason text;
BEGIN
  SELECT locked.reason INTO lock_reason FROM private.locked_assets(p_league_id,p_league_season_id,p_member_id) locked
    WHERE locked.asset_kind='player' AND locked.asset_id=p_player_id
    ORDER BY locked.source_kind,locked.source_id LIMIT 1;
  IF lock_reason IS NOT NULL THEN RAISE EXCEPTION '%', lock_reason USING ERRCODE='PA004'; END IF;
END;
$$;
