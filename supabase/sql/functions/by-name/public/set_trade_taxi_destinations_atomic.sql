-- Canonical SQL source for public.set_trade_taxi_destinations_atomic.
-- Keep the latest migration definition identical.

CREATE OR REPLACE FUNCTION public.set_trade_taxi_destinations_atomic(p_trade_id uuid,p_member_id uuid,p_player_ids uuid[],p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE v_trade trades%ROWTYPE; v_player_id uuid; v_member_id uuid; v_slots int; v_count int;
BEGIN
  SELECT * INTO v_trade FROM trades WHERE id=p_trade_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trade not found' USING ERRCODE='P0002'; END IF;
  IF NOT EXISTS(SELECT 1 FROM league_members WHERE id=p_member_id AND league_id=v_trade.league_id AND user_id=p_user_id) THEN
    RAISE EXCEPTION 'Not authorized to choose this roster destination.' USING ERRCODE='42501';
  END IF;
  -- Match acceptance and roster mutations: members, players, then the trade.
  FOR v_member_id IN SELECT member_id FROM trade_participants WHERE trade_id=p_trade_id ORDER BY member_id LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text),hashtext(v_member_id::text));
  END LOOP;
  FOR v_player_id IN SELECT DISTINCT player_id FROM trade_items WHERE trade_id=p_trade_id AND player_id IS NOT NULL ORDER BY player_id LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text),hashtext(v_player_id::text));
  END LOOP;
  SELECT * INTO v_trade FROM trades WHERE id=p_trade_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trade not found' USING ERRCODE='P0002'; END IF;
  IF v_trade.status<>'pending' OR (v_trade.expires_at IS NOT NULL AND v_trade.expires_at<=now()) THEN
    RAISE EXCEPTION 'Choose roster destinations while the trade offer is pending.' USING ERRCODE='P0001';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM trade_items WHERE trade_id=p_trade_id AND to_member_id=p_member_id) THEN
    RAISE EXCEPTION 'This member receives no assets in this trade.' USING ERRCODE='42501';
  END IF;
  IF p_player_ids IS NULL OR cardinality(p_player_ids)>100 OR EXISTS(SELECT 1 FROM unnest(p_player_ids) p GROUP BY p HAVING p IS NULL OR count(*)>1) THEN
    RAISE EXCEPTION 'Taxi selections must be a unique list of incoming players.' USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT 1 FROM unnest(p_player_ids) p WHERE NOT EXISTS(SELECT 1 FROM trade_items WHERE trade_id=p_trade_id AND to_member_id=p_member_id AND player_id=p)) THEN
    RAISE EXCEPTION 'Taxi selections must belong to the receiving team.' USING ERRCODE='42501';
  END IF;
  FOR v_player_id IN SELECT p FROM unnest(p_player_ids) p ORDER BY p LOOP
    PERFORM private.assert_taxi_acquisition_allowed(v_trade.league_id,v_trade.league_season_id,p_member_id,v_player_id);
  END LOOP;
  SELECT taxi_slots INTO v_slots FROM leagues WHERE id=v_trade.league_id FOR UPDATE;
  SELECT count(*) INTO v_count FROM roster_players WHERE league_id=v_trade.league_id AND league_season_id=v_trade.league_season_id AND member_id=p_member_id AND is_on_taxi;
  IF v_count+cardinality(p_player_ids)>COALESCE(v_slots,0) THEN
    RAISE EXCEPTION 'The selected players exceed your available taxi slots.' USING ERRCODE='P0001';
  END IF;
  UPDATE trade_items SET to_taxi=player_id=ANY(p_player_ids) WHERE trade_id=p_trade_id AND to_member_id=p_member_id AND player_id IS NOT NULL;
END;
$$;
