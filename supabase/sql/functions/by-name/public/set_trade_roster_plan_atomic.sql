-- Canonical SQL source for public.set_trade_roster_plan_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.set_trade_roster_plan_atomic(
  p_trade_id uuid, p_member_id uuid, p_user_id uuid,
  p_taxi_player_ids uuid[], p_ir_player_ids uuid[], p_drop_player_ids uuid[], p_roster_moves jsonb DEFAULT '[]'::jsonb
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  __request_context jsonb;
  v_trade trades%ROWTYPE;
  v_all uuid[];
BEGIN
  PERFORM set_config('pancake.trade_write','true',true);
  PERFORM set_config('lock_timeout','100ms',true);
  IF jsonb_typeof(p_roster_moves) IS DISTINCT FROM 'array' OR jsonb_array_length(p_roster_moves)>100 THEN
    RAISE EXCEPTION 'Roster moves must be an array of at most 100 players.' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_roster_moves) move WHERE jsonb_typeof(move) IS DISTINCT FROM 'object'
    OR move->>'destination' IS NULL OR move->>'destination' NOT IN ('active','ir','taxi')
    OR move->>'playerId' IS NULL OR move->>'playerId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
    RAISE EXCEPTION 'Each roster move requires a player and a Regular, IR, or taxi destination.' USING ERRCODE='22023';
  END IF;
  v_all := p_taxi_player_ids || p_ir_player_ids || p_drop_player_ids || ARRAY(SELECT (move->>'playerId')::uuid FROM jsonb_array_elements(p_roster_moves) move);
  IF p_taxi_player_ids IS NULL OR p_ir_player_ids IS NULL OR p_drop_player_ids IS NULL
    OR cardinality(v_all) > 100 OR EXISTS (SELECT 1 FROM unnest(v_all) id GROUP BY id HAVING id IS NULL OR count(*) > 1) THEN
    RAISE EXCEPTION 'Placements and drops must be unique players.' USING ERRCODE = '22023';
  END IF;
  v_trade := private.begin_trade_action(p_trade_id, p_member_id, p_user_id, 'plan', '{}', v_all);
  __request_context := private.request_begin('public.set_trade_roster_plan_atomic', jsonb_build_array(p_trade_id, p_member_id, p_user_id, p_taxi_player_ids, p_ir_player_ids, p_drop_player_ids, p_roster_moves), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN; END IF;
  <<request_write>>
DECLARE v_preview jsonb;
BEGIN
  IF v_trade.status NOT IN ('pending','accepted') OR v_trade.status='accepted' AND jsonb_array_length(v_trade.legality_issues)=0
    OR v_trade.status='pending' AND v_trade.expires_at <= now() THEN
    RAISE EXCEPTION 'Choose placements and drops while the trade is pending.';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_roster_moves) move WHERE move->>'destination'='taxi') THEN
    RAISE EXCEPTION 'Only incoming players can be placed on Taxi.' USING ERRCODE='PT422',DETAIL='TRADE_TAXI_INCOMING_ONLY';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_taxi_player_ids) choice(player_id)
    WHERE NOT private.taxi_player_eligible(v_trade.league_id,choice.player_id)) THEN
    RAISE EXCEPTION 'Taxi requires a rookie or fewer than 65 known career games.' USING ERRCODE='PT422',DETAIL='TRADE_TAXI_INELIGIBLE';
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
  IF v_trade.status='accepted' AND jsonb_array_length(v_trade.legality_issues)>0 THEN
    v_preview:=public.get_trade_roster_preview(p_trade_id,p_user_id);
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_preview) team WHERE NOT (team->>'legal')::boolean) THEN
      PERFORM public.hold_trade_for_legality_atomic(p_trade_id,NULL);
    ELSE
      UPDATE trades SET legality_issues='[]',completion_failure_reason=NULL WHERE id=p_trade_id;
    END IF;
  ELSIF EXISTS (SELECT 1 FROM trade_participants WHERE trade_id=p_trade_id AND member_id=p_member_id AND accepted_at IS NOT NULL) THEN
    PERFORM private.validate_trade_rosters(p_trade_id, p_member_id);
  END IF;
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'The league is busy. Try this trade again.' USING ERRCODE='PA010';
END;
$$;
