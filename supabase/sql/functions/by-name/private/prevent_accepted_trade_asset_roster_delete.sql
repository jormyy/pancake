-- Canonical SQL source for private.prevent_accepted_trade_asset_roster_delete.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.prevent_accepted_trade_asset_roster_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
DECLARE lock_reason text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM leagues WHERE id=OLD.league_id) THEN RETURN OLD; END IF;
  PERFORM private.assert_not_reserved_trade_asset(OLD.league_id, OLD.league_season_id, OLD.member_id, OLD.player_id, NULL, CASE WHEN private.trade_lifecycle_write_active() THEN (SELECT participant.trade_id FROM trade_participants participant JOIN trades trade ON trade.id=participant.trade_id WHERE trade.status='accepted' AND trade.league_season_id=OLD.league_season_id AND participant.member_id=OLD.member_id AND OLD.player_id=ANY(participant.drop_player_ids)) ELSE NULL END);

  SELECT locked.reason INTO lock_reason FROM private.locked_assets(OLD.league_id, OLD.league_season_id, OLD.member_id) locked
    WHERE locked.source_kind='claim' AND locked.asset_id=OLD.player_id ORDER BY locked.source_id LIMIT 1;
  IF lock_reason IS NOT NULL THEN RAISE EXCEPTION '%', lock_reason USING ERRCODE='PA004'; END IF;
  RETURN OLD;
END;
$$;
