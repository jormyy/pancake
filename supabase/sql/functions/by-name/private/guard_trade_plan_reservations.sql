-- Canonical SQL source for private.guard_trade_plan_reservations.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.guard_trade_plan_reservations()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_trade trades%ROWTYPE; v_player uuid; v_ids uuid[]; v_member uuid; v_exempt uuid[]; v_action private.roster_action;
BEGIN
  SELECT * INTO v_trade FROM trades WHERE id=NEW.trade_id;
  IF TG_TABLE_NAME='trade_items' THEN
    v_ids := ARRAY[NEW.player_id];
    v_member := NEW.from_member_id;
  ELSE
    v_ids := NEW.drop_player_ids || ARRAY(SELECT (move->>'playerId')::uuid FROM jsonb_array_elements(NEW.roster_moves) move);
    v_member := NEW.member_id;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text),hashtext(v_member::text));
  IF v_trade.status IN ('pending','accepted') THEN
    v_exempt := ARRAY[NEW.trade_id] || ARRAY(SELECT source.id FROM trades source WHERE source.status='pending'
      AND source.league_id=v_trade.league_id AND source.league_season_id=v_trade.league_season_id
      AND ((source.id=v_trade.edited_from_trade_id AND source.proposer_member_id=v_trade.proposer_member_id
          AND source.recipient_member_id=v_trade.recipient_member_id)
        OR (source.id=v_trade.countered_from_trade_id AND source.recipient_member_id=v_trade.proposer_member_id
          AND source.proposer_member_id=v_trade.recipient_member_id)));
    v_action := CASE WHEN TG_TABLE_NAME='trade_items' THEN 'trade_offer' ELSE 'trade_plan' END;
    FOR v_player IN SELECT DISTINCT id FROM unnest(v_ids) id WHERE id IS NOT NULL ORDER BY id LOOP
      PERFORM private.assert_roster_action_allowed(v_action, v_trade.league_id, v_trade.league_season_id, v_member, v_player, NULL, v_exempt);
    END LOOP;
    IF TG_TABLE_NAME='trade_items' AND (to_jsonb(NEW)->>'pick_id') IS NOT NULL THEN
      PERFORM private.assert_roster_action_allowed(v_action, v_trade.league_id, v_trade.league_season_id, v_member, NULL,
        (to_jsonb(NEW)->>'pick_id')::uuid, v_exempt);
    END IF;
  END IF;
  FOR v_player IN SELECT DISTINCT id FROM unnest(v_ids) id WHERE id IS NOT NULL ORDER BY id LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text),hashtext(v_player::text));
    IF EXISTS (SELECT 1 FROM trade_participants participant JOIN trades trade ON trade.id=participant.trade_id
      WHERE trade.league_id=v_trade.league_id AND trade.league_season_id=v_trade.league_season_id
        AND trade.status='accepted' AND trade.id<>NEW.trade_id
        AND (v_player=ANY(participant.drop_player_ids) OR participant.roster_moves @> jsonb_build_array(jsonb_build_object('playerId',v_player::text)))) THEN
      RAISE EXCEPTION 'Player is reserved by another trade roster plan.' USING ERRCODE='PA010';
    END IF;
    IF TG_TABLE_NAME='trade_participants' THEN
      IF EXISTS (SELECT 1 FROM trade_items item JOIN trades trade ON trade.id=item.trade_id
        WHERE trade.league_id=v_trade.league_id AND trade.league_season_id=v_trade.league_season_id
          AND trade.status IN ('pending','accepted') AND trade.id<>NEW.trade_id AND item.player_id=v_player)
        OR EXISTS (SELECT 1 FROM waiver_claims WHERE league_season_id=v_trade.league_season_id
          AND status='pending' AND (drop_player_id=v_player OR player_id=v_player)) THEN
        RAISE EXCEPTION 'Planned drop or move is reserved by another trade or active waiver claim.' USING ERRCODE='PA010';
      END IF;
    END IF;
  END LOOP;
  IF TG_TABLE_NAME='trade_items' THEN
  IF NEW.player_id IS NOT NULL AND v_trade.status='pending'
    AND EXISTS (SELECT 1 FROM leagues WHERE id=v_trade.league_id AND allow_inactive_trades)
    AND EXISTS (SELECT 1 FROM roster_players WHERE league_season_id=v_trade.league_season_id
      AND member_id=NEW.from_member_id AND player_id=NEW.player_id AND is_on_taxi) THEN
    NEW.to_taxi := true;
  END IF;
  END IF;
  RETURN NEW;
END;
$$;
