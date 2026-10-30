-- Canonical SQL source for private.prevent_accepted_or_inactive_roster_move.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.prevent_accepted_or_inactive_roster_move()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
DECLARE
  v_completing_trade_id uuid;
  v_applied_trade_id text:=current_setting('pancake.applied_trade_id',true);
  lock_reason text;
BEGIN
  IF OLD.member_id<>NEW.member_id THEN
    SELECT c.related_id INTO v_completing_trade_id FROM private.taxi_acquisition_context c
    JOIN trades t ON t.id=c.related_id AND t.status='accepted' AND t.id::text=v_applied_trade_id
    JOIN trade_items i ON i.trade_id=t.id AND i.player_id=NEW.player_id
      AND i.from_member_id=OLD.member_id AND i.to_member_id=NEW.member_id
      AND i.to_ir=NEW.is_on_ir AND (i.to_taxi OR OLD.is_on_taxi)=NEW.is_on_taxi
    WHERE c.transaction_id=pg_current_xact_id() AND c.source='trade'
      AND c.league_id=NEW.league_id AND c.league_season_id=NEW.league_season_id
      AND c.member_id=NEW.member_id AND c.player_id=NEW.player_id
      AND t.league_id=NEW.league_id AND t.league_season_id=NEW.league_season_id;
  END IF;
  IF OLD.member_id=NEW.member_id THEN
    SELECT trade.id INTO v_completing_trade_id FROM private.taxi_acquisition_context context
    JOIN trades trade ON trade.id=context.related_id JOIN trade_participants participant ON participant.trade_id=trade.id
    WHERE context.transaction_id=pg_current_xact_id() AND context.source='trade'
      AND context.league_id=OLD.league_id AND context.league_season_id=OLD.league_season_id
      AND context.member_id=OLD.member_id AND context.player_id=OLD.player_id
      AND trade.status='accepted' AND trade.id::text=v_applied_trade_id
      AND trade.league_id=OLD.league_id AND trade.league_season_id=OLD.league_season_id AND participant.member_id=OLD.member_id
      AND NOT (NEW.is_on_ir AND NEW.is_on_taxi)
      AND participant.roster_moves @> jsonb_build_array(jsonb_build_object('playerId',OLD.player_id::text,
        'destination',CASE WHEN NEW.is_on_taxi THEN 'taxi' WHEN NEW.is_on_ir THEN 'ir' ELSE 'active' END));
  END IF;
  IF (OLD.league_id,OLD.league_season_id,OLD.member_id,OLD.player_id) IS DISTINCT FROM (NEW.league_id,NEW.league_season_id,NEW.member_id,NEW.player_id)
    OR OLD.is_on_ir IS DISTINCT FROM NEW.is_on_ir OR OLD.is_on_taxi IS DISTINCT FROM NEW.is_on_taxi THEN
    PERFORM private.assert_not_reserved_trade_asset(OLD.league_id, OLD.league_season_id, OLD.member_id, OLD.player_id, NULL, v_completing_trade_id);
  END IF;

  IF (v_completing_trade_id IS NULL OR OLD.member_id=NEW.member_id) AND ((OLD.league_id,OLD.league_season_id,OLD.member_id,OLD.player_id) IS DISTINCT FROM (NEW.league_id,NEW.league_season_id,NEW.member_id,NEW.player_id)
    OR OLD.is_on_ir IS DISTINCT FROM NEW.is_on_ir OR OLD.is_on_taxi IS DISTINCT FROM NEW.is_on_taxi) THEN
    SELECT locked.reason INTO lock_reason FROM private.locked_assets(OLD.league_id, OLD.league_season_id, OLD.member_id) locked
      WHERE locked.source_kind='claim' AND locked.asset_id=OLD.player_id ORDER BY locked.source_id LIMIT 1;
    IF lock_reason IS NOT NULL THEN RAISE EXCEPTION '%', lock_reason USING ERRCODE='PA004'; END IF;
  END IF;

  IF v_completing_trade_id IS NULL AND (
    (OLD.league_id,OLD.league_season_id,OLD.member_id,OLD.player_id) IS DISTINCT FROM (NEW.league_id,NEW.league_season_id,NEW.member_id,NEW.player_id)
    OR OLD.is_on_ir IS DISTINCT FROM NEW.is_on_ir OR OLD.is_on_taxi IS DISTINCT FROM NEW.is_on_taxi) THEN
    PERFORM private.assert_asset_unlocked(OLD.league_id,OLD.league_season_id,OLD.member_id,OLD.player_id);
  END IF;

  IF OLD.member_id IS DISTINCT FROM NEW.member_id AND v_completing_trade_id IS NULL AND (
    ((OLD.is_on_ir OR OLD.is_on_taxi OR NEW.is_on_ir) AND NOT EXISTS (SELECT 1 FROM leagues WHERE id=NEW.league_id AND allow_inactive_trades)) OR
    (NEW.is_on_taxi = true AND v_completing_trade_id IS NULL AND NOT EXISTS (SELECT 1 FROM leagues WHERE id=NEW.league_id AND allow_inactive_trades))
  ) THEN
    RAISE EXCEPTION 'Inactive roster players must be activated before they can be traded.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;
