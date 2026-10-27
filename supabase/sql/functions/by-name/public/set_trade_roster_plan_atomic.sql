CREATE OR REPLACE FUNCTION public.set_trade_roster_plan_atomic(
  p_trade_id uuid, p_member_id uuid, p_user_id uuid,
  p_taxi_player_ids uuid[], p_ir_player_ids uuid[], p_drop_player_ids uuid[], p_roster_moves jsonb DEFAULT '[]'::jsonb
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_trade trades%ROWTYPE; v_member uuid; v_player uuid; v_all uuid[];
BEGIN
  SELECT * INTO v_trade FROM trades WHERE id = p_trade_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trade not found.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM trade_participants participant JOIN league_members member ON member.id = participant.member_id
    WHERE participant.trade_id = p_trade_id AND member.id = p_member_id AND member.user_id = p_user_id) THEN
    RAISE EXCEPTION 'Only the receiving manager can choose placements and drops.' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_roster_moves) IS DISTINCT FROM 'array' OR jsonb_array_length(p_roster_moves)>100 THEN
    RAISE EXCEPTION 'Roster moves must be an array of at most 100 players.' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_roster_moves) move WHERE jsonb_typeof(move) IS DISTINCT FROM 'object'
    OR move->>'destination' IS NULL OR move->>'destination' NOT IN ('active','ir')
    OR move->>'playerId' IS NULL OR move->>'playerId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
    RAISE EXCEPTION 'Each roster move requires a player and an active or IR destination. Owned players cannot move back to taxi.' USING ERRCODE='22023';
  END IF;
  v_all := p_taxi_player_ids || p_ir_player_ids || p_drop_player_ids || ARRAY(SELECT (move->>'playerId')::uuid FROM jsonb_array_elements(p_roster_moves) move);
  IF p_taxi_player_ids IS NULL OR p_ir_player_ids IS NULL OR p_drop_player_ids IS NULL
    OR cardinality(v_all) > 100 OR EXISTS (SELECT 1 FROM unnest(v_all) id GROUP BY id HAVING id IS NULL OR count(*) > 1) THEN
    RAISE EXCEPTION 'Placements and drops must be unique players.' USING ERRCODE = '22023';
  END IF;
  FOR v_member IN SELECT member_id FROM trade_participants WHERE trade_id = p_trade_id ORDER BY member_id LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text), hashtext(v_member::text));
  END LOOP;
  FOR v_player IN SELECT DISTINCT id FROM (
    SELECT unnest(v_all) id UNION SELECT player_id FROM trade_items WHERE trade_id = p_trade_id
  ) ids WHERE id IS NOT NULL ORDER BY id LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text), hashtext(v_player::text));
  END LOOP;
  SELECT * INTO v_trade FROM trades WHERE id = p_trade_id AND status='pending' FOR UPDATE;
  IF NOT FOUND OR v_trade.status <> 'pending' OR v_trade.expires_at <= now() THEN
    RAISE EXCEPTION 'Choose placements and drops while the trade is pending.';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_taxi_player_ids || p_ir_player_ids) choice(player_id) WHERE NOT EXISTS
    (SELECT 1 FROM trade_items WHERE trade_id = p_trade_id AND to_member_id = p_member_id AND player_id = choice.player_id)) THEN
    RAISE EXCEPTION 'Placements must belong to incoming players.';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_drop_player_ids) choice(player_id) WHERE NOT EXISTS
    (SELECT 1 FROM roster_players WHERE league_season_id = v_trade.league_season_id AND member_id = p_member_id AND player_id = choice.player_id)
    OR EXISTS (SELECT 1 FROM trade_items WHERE trade_id = p_trade_id AND player_id = choice.player_id)) THEN
    RAISE EXCEPTION 'Drop choices must be your rostered players outside this offer.';
  END IF;
  IF EXISTS (SELECT 1 FROM roster_players WHERE league_season_id=v_trade.league_season_id AND player_id=ANY(p_ir_player_ids) AND is_on_taxi) THEN
    RAISE EXCEPTION 'Traded taxi players must remain on taxi with their original tenure.' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_roster_moves) move
    WHERE NOT EXISTS (SELECT 1 FROM roster_players roster WHERE roster.league_season_id=v_trade.league_season_id
      AND roster.member_id=p_member_id AND roster.player_id=(move->>'playerId')::uuid)
      OR EXISTS (SELECT 1 FROM trade_items WHERE trade_id=p_trade_id AND player_id=(move->>'playerId')::uuid)) THEN
    RAISE EXCEPTION 'Moves must be retained players from your own roster.' USING ERRCODE='22023';
  END IF;
  UPDATE trade_items item SET to_taxi = item.player_id = ANY(p_taxi_player_ids) OR EXISTS
    (SELECT 1 FROM roster_players WHERE league_season_id = v_trade.league_season_id AND player_id = item.player_id AND is_on_taxi),
    to_ir = item.player_id = ANY(p_ir_player_ids)
  WHERE item.trade_id = p_trade_id AND item.to_member_id = p_member_id AND item.player_id IS NOT NULL;
  UPDATE trade_participants SET drop_player_ids = p_drop_player_ids, roster_moves=p_roster_moves WHERE trade_id = p_trade_id AND member_id = p_member_id;
  IF EXISTS (SELECT 1 FROM trade_participants WHERE trade_id=p_trade_id AND member_id=p_member_id AND accepted_at IS NOT NULL) THEN
    PERFORM private.validate_trade_rosters(p_trade_id, p_member_id);
  END IF;
END;
$$;
