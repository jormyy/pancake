CREATE TYPE private.roster_action AS ENUM ('drop','lineup_move','to_ir','from_ir','to_taxi','from_taxi','transfer',
  'trade_move','trade_settle_move','trade_offer','trade_plan','trade_accept','claim_add','claim_drop');
CREATE TYPE private.roster_hold AS ENUM ('offer_pending','trade_reserved','claim_reserved');

CREATE OR REPLACE FUNCTION private.roster_action_policy()
RETURNS TABLE(action private.roster_action, hold private.roster_hold, errcode text)
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT cell.action::private.roster_action, cell.hold::private.roster_hold, cell.errcode
  FROM (VALUES
    ('drop','offer_pending','PA004'),('drop','trade_reserved','PA004'),('drop','claim_reserved','PA004'),
    ('lineup_move','offer_pending',NULL),('lineup_move','trade_reserved',NULL),('lineup_move','claim_reserved',NULL),
    ('to_ir','offer_pending','PA004'),('to_ir','trade_reserved','PA004'),('to_ir','claim_reserved','PA004'),
    ('from_ir','offer_pending','PA004'),('from_ir','trade_reserved','PA004'),('from_ir','claim_reserved','PA004'),
    ('to_taxi','offer_pending','PA004'),('to_taxi','trade_reserved','PA004'),('to_taxi','claim_reserved','PA004'),
    ('from_taxi','offer_pending','PA004'),('from_taxi','trade_reserved','PA004'),('from_taxi','claim_reserved','PA004'),
    ('transfer','offer_pending','PA004'),('transfer','trade_reserved','PA004'),('transfer','claim_reserved','PA004'),
    ('trade_move','offer_pending',NULL),('trade_move','trade_reserved','PA004'),('trade_move','claim_reserved',NULL),
    ('trade_settle_move','offer_pending',NULL),('trade_settle_move','trade_reserved','PA004'),('trade_settle_move','claim_reserved','PA004'),
    ('trade_offer','offer_pending',NULL),('trade_offer','trade_reserved','PA004'),('trade_offer','claim_reserved','PA004'),
    ('trade_plan','offer_pending','PA004'),('trade_plan','trade_reserved','PA004'),('trade_plan','claim_reserved','PA004'),
    ('trade_accept','offer_pending',NULL),('trade_accept','trade_reserved','PA004'),('trade_accept','claim_reserved',NULL),
    ('claim_add','offer_pending','PA004'),('claim_add','trade_reserved','PA004'),('claim_add','claim_reserved',NULL),
    ('claim_drop','offer_pending','PA004'),('claim_drop','trade_reserved','PA004'),('claim_drop','claim_reserved',NULL)
  ) AS cell(action, hold, errcode)
$$;

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

CREATE OR REPLACE FUNCTION private.assert_not_reserved_trade_asset(
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid,
  p_player_id uuid DEFAULT NULL,
  p_pick_id uuid DEFAULT NULL,
  p_exclude_trade_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  PERFORM private.assert_roster_action_allowed('trade_accept', p_league_id, p_league_season_id, p_member_id, p_player_id, p_pick_id,
    ARRAY[p_exclude_trade_id]);
END;
$$;

CREATE OR REPLACE FUNCTION private.is_reserved_trade_asset(
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid,
  p_player_id uuid DEFAULT NULL,
  p_pick_id uuid DEFAULT NULL,
  p_exclude_trade_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM private.roster_action_blocks('trade_accept', p_league_id, p_league_season_id, p_member_id, ARRAY[p_exclude_trade_id]) block
    WHERE (block.asset_kind='player' AND block.asset_id=p_player_id) OR (block.asset_kind='pick' AND block.asset_id=p_pick_id)
  )
$$;

CREATE OR REPLACE FUNCTION private.prevent_locked_lineup_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE row_data public.weekly_lineups%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM public.leagues WHERE id=OLD.league_id) THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' AND (OLD.member_id, OLD.league_id, OLD.league_season_id, OLD.player_id, OLD.game_date, OLD.slot_type)
    IS NOT DISTINCT FROM (NEW.member_id, NEW.league_id, NEW.league_season_id, NEW.player_id, NEW.game_date, NEW.slot_type) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN row_data := NEW; ELSE row_data := OLD; END IF;
  PERFORM pg_advisory_xact_lock(hashtext(row_data.league_id::text), hashtext(row_data.member_id::text));
  PERFORM private.assert_roster_action_allowed('lineup_move', row_data.league_id, row_data.league_season_id, row_data.member_id, row_data.player_id);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.prevent_accepted_or_inactive_roster_move()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
DECLARE
  v_completing_trade_id uuid;
  v_applied_trade_id text:=current_setting('pancake.applied_trade_id',true);
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
    PERFORM private.assert_roster_action_allowed(CASE
        WHEN v_completing_trade_id IS NOT NULL AND OLD.member_id<>NEW.member_id THEN 'trade_move'
        WHEN v_completing_trade_id IS NOT NULL THEN 'trade_settle_move'
        WHEN (OLD.league_id,OLD.league_season_id,OLD.member_id,OLD.player_id) IS DISTINCT FROM (NEW.league_id,NEW.league_season_id,NEW.member_id,NEW.player_id) THEN 'transfer'
        WHEN NEW.is_on_ir AND NOT OLD.is_on_ir THEN 'to_ir'
        WHEN OLD.is_on_ir AND NOT NEW.is_on_ir THEN 'from_ir'
        WHEN NEW.is_on_taxi THEN 'to_taxi'
        ELSE 'from_taxi' END::private.roster_action,
      OLD.league_id, OLD.league_season_id, OLD.member_id, OLD.player_id, NULL, ARRAY[v_completing_trade_id]);
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

CREATE OR REPLACE FUNCTION private.prevent_accepted_trade_asset_roster_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM leagues WHERE id=OLD.league_id) THEN RETURN OLD; END IF;
  PERFORM private.assert_roster_action_allowed('drop', OLD.league_id, OLD.league_season_id, OLD.member_id, OLD.player_id, NULL,
    CASE WHEN private.trade_lifecycle_write_active() THEN ARRAY(SELECT participant.trade_id FROM trade_participants participant
      JOIN trades trade ON trade.id=participant.trade_id WHERE trade.status='accepted' AND trade.league_season_id=OLD.league_season_id
        AND participant.member_id=OLD.member_id AND OLD.player_id=ANY(participant.drop_player_ids)
        AND trade.id::text=current_setting('pancake.applied_trade_id',true)) ELSE '{}' END);
  RETURN OLD;
END;
$$;

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

CREATE OR REPLACE FUNCTION private.guard_waiver_plan_reservations()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_player uuid;
BEGIN
  IF NEW.status<>'pending' THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtext(NEW.league_id::text),hashtext(NEW.member_id::text));
  FOR v_player IN SELECT DISTINCT id FROM unnest(ARRAY[NEW.player_id,NEW.drop_player_id]) id
    WHERE id IS NOT NULL ORDER BY id LOOP
    PERFORM pg_advisory_xact_lock(hashtext(NEW.league_id::text),hashtext(v_player::text));
    PERFORM private.assert_roster_action_allowed(CASE WHEN v_player=NEW.drop_player_id THEN 'claim_drop' ELSE 'claim_add' END::private.roster_action,
      NEW.league_id, NEW.league_season_id, NEW.member_id, v_player);
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.validate_waiver_claim_drop_player(
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid,
  p_drop_player_id uuid,
  p_missing_message text DEFAULT 'Drop player must be on your roster.'
)
RETURNS TABLE (
  roster_player_id uuid,
  failure_reason text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_roster_player_id uuid;
  lock_reason text;
BEGIN
  IF p_drop_player_id IS NULL THEN
    RETURN QUERY SELECT NULL::uuid, NULL::text;
    RETURN;
  END IF;

  SELECT rp.id
    INTO v_roster_player_id
    FROM roster_players AS rp
   WHERE rp.member_id = p_member_id
     AND rp.league_id = p_league_id
     AND rp.league_season_id = p_league_season_id
     AND rp.player_id = p_drop_player_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, p_missing_message;
    RETURN;
  END IF;

  SELECT block.reason INTO lock_reason FROM private.roster_action_blocks('claim_drop', p_league_id, p_league_season_id, p_member_id) block
    WHERE block.asset_kind='player' AND block.asset_id=p_drop_player_id LIMIT 1;
  IF lock_reason IS NOT NULL THEN
    RETURN QUERY SELECT v_roster_player_id, lock_reason;
    RETURN;
  END IF;

  RETURN QUERY SELECT v_roster_player_id, NULL::text;
END;
$$;

CREATE OR REPLACE FUNCTION private.plan_auto_ir(
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_league leagues%ROWTYPE;
  v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_roster_size int;
  v_ir_slots int;
  v_ir_count int;
  v_active_count int;
  v_open_slots int;
  v_free_places int;
  v_pool_places int;
  v_candidate_count int;
  v_occupant_count int;
  v_incumbent_count int;
  v_pool_count int;
  v_selected_count int;
  v_designate_count int;
  v_healthy_swap_count int;
  v_incumbent_swap_count int;
  v_uncertain_count int;
  v_index int;
  v_boundary_date date;
  v_candidate record;
  v_occupant record;
  v_taxi record;
  v_return_date date;
  v_active_eligible_count int := 0;
  v_cand_roster_ids uuid[] := ARRAY[]::uuid[];
  v_cand_player_ids uuid[] := ARRAY[]::uuid[];
  v_cand_names text[] := ARRAY[]::text[];
  v_cand_dates date[] := ARRAY[]::date[];
  v_cand_reliable boolean[] := ARRAY[]::boolean[];
  v_occ_roster_ids uuid[] := ARRAY[]::uuid[];
  v_occ_player_ids uuid[] := ARRAY[]::uuid[];
  v_occ_names text[] := ARRAY[]::text[];
  v_inc_roster_ids uuid[] := ARRAY[]::uuid[];
  v_inc_player_ids uuid[] := ARRAY[]::uuid[];
  v_inc_names text[] := ARRAY[]::text[];
  v_inc_dates date[] := ARRAY[]::date[];
  v_pool_roster_ids uuid[];
  v_pool_player_ids uuid[];
  v_pool_names text[];
  v_pool_dates date[];
  v_pool_reliable boolean[];
  v_pool_is_incumbent boolean[];
  v_sorted_roster_ids uuid[];
  v_sorted_player_ids uuid[];
  v_sorted_names text[];
  v_sorted_dates date[];
  v_sorted_reliable boolean[];
  v_sorted_is_incumbent boolean[];
  v_placed_contender_roster_ids uuid[] := ARRAY[]::uuid[];
  v_placed_contender_player_ids uuid[] := ARRAY[]::uuid[];
  v_placed_contender_dates date[] := ARRAY[]::date[];
  v_exchange_incumbent_roster_ids uuid[] := ARRAY[]::uuid[];
  v_exchange_incumbent_player_ids uuid[] := ARRAY[]::uuid[];
  v_exchange_incumbent_names text[] := ARRAY[]::text[];
  v_exchange_incumbent_dates date[] := ARRAY[]::date[];
  v_exchange_incumbent_count int;
  v_unambiguous_exchange_count int;
  v_kept_incumbent_player_ids uuid[] := ARRAY[]::uuid[];
  v_j int;
  v_moves jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_notices jsonb := '[]'::jsonb;
  v_active_now int;
  v_unplaced_eligible_active int;
  v_unplaced_usable_active int;
  v_swap_available boolean;
  v_occupant_roster_id uuid;
  v_occupant_player_id uuid;
  v_occupant_name text;
  v_placed_count int;
BEGIN
  SELECT * INTO v_league FROM leagues WHERE id = p_league_id;
  IF NOT FOUND
     OR v_league.status NOT IN ('active'::league_status, 'playoffs'::league_status) THEN
    RETURN jsonb_build_object('moves', '[]'::jsonb, 'skipped', '[]'::jsonb, 'notices', '[]'::jsonb);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM league_seasons
     WHERE id = p_league_season_id AND league_id = p_league_id AND is_current
  ) THEN
    RETURN jsonb_build_object('moves', '[]'::jsonb, 'skipped', '[]'::jsonb, 'notices', '[]'::jsonb);
  END IF;

  v_roster_size := COALESCE(v_league.roster_size, 20);
  v_ir_slots := COALESCE(v_league.ir_slots, 2);

  SELECT count(*) FILTER (WHERE is_on_ir),
         count(*) FILTER (WHERE NOT is_on_ir AND NOT is_on_taxi)
    INTO v_ir_count, v_active_count
    FROM roster_players
   WHERE league_id = p_league_id
     AND league_season_id = p_league_season_id
     AND member_id = p_member_id;

  FOR v_candidate IN
    SELECT rp.id AS roster_player_id,
           rp.player_id,
           p.display_name AS player_name,
           p.injury_status,
           p.injury_expected_return
      FROM roster_players rp
      JOIN players p ON p.id = rp.player_id
     WHERE rp.league_id = p_league_id
       AND rp.league_season_id = p_league_season_id
       AND rp.member_id = p_member_id
       AND NOT rp.is_on_ir
       AND NOT rp.is_on_taxi
     ORDER BY rp.id
  LOOP
    IF NOT private.is_ir_designation(v_candidate.injury_status) THEN
      CONTINUE;
    END IF;
    v_active_eligible_count := v_active_eligible_count + 1;
    IF private.roster_status_game_started(v_candidate.player_id) THEN
      v_skipped := v_skipped || jsonb_build_object('playerId', v_candidate.player_id, 'reason', 'game_locked');
      CONTINUE;
    END IF;
    IF EXISTS (
      SELECT 1 FROM private.roster_action_blocks('to_ir', p_league_id, p_league_season_id, p_member_id) block
       WHERE block.asset_kind = 'player' AND block.asset_id = v_candidate.player_id
    ) THEN
      v_skipped := v_skipped || jsonb_build_object('playerId', v_candidate.player_id, 'reason', 'reserved');
      CONTINUE;
    END IF;

    v_return_date := private.ir_reliable_return(v_candidate.injury_expected_return, v_today);
    v_cand_roster_ids := v_cand_roster_ids || v_candidate.roster_player_id;
    v_cand_player_ids := v_cand_player_ids || v_candidate.player_id;
    v_cand_names := v_cand_names || v_candidate.player_name;
    v_cand_dates := v_cand_dates || v_return_date;
    v_cand_reliable := v_cand_reliable || (v_return_date IS NOT NULL);
  END LOOP;

  FOR v_occupant IN
    SELECT rp.id AS roster_player_id,
           rp.player_id,
           p.display_name AS player_name,
           p.injury_status,
           p.injury_expected_return
      FROM roster_players rp
      JOIN players p ON p.id = rp.player_id
     WHERE rp.league_id = p_league_id
       AND rp.league_season_id = p_league_season_id
       AND rp.member_id = p_member_id
       AND rp.is_on_ir
     ORDER BY rp.id
  LOOP
    IF private.roster_status_game_started(v_occupant.player_id) THEN
      v_skipped := v_skipped || jsonb_build_object('playerId', v_occupant.player_id, 'reason', 'game_locked');
      CONTINUE;
    END IF;
    IF EXISTS (
      SELECT 1 FROM private.roster_action_blocks('from_ir', p_league_id, p_league_season_id, p_member_id) block
       WHERE block.asset_kind = 'player' AND block.asset_id = v_occupant.player_id
    ) THEN
      v_skipped := v_skipped || jsonb_build_object('playerId', v_occupant.player_id, 'reason', 'reserved');
      CONTINUE;
    END IF;

    IF NOT private.is_ir_designation(v_occupant.injury_status) THEN
      v_occ_roster_ids := v_occ_roster_ids || v_occupant.roster_player_id;
      v_occ_player_ids := v_occ_player_ids || v_occupant.player_id;
      v_occ_names := v_occ_names || v_occupant.player_name;
    ELSE
      v_return_date := private.ir_reliable_return(v_occupant.injury_expected_return, v_today);
      IF v_return_date IS NOT NULL THEN
        v_inc_roster_ids := v_inc_roster_ids || v_occupant.roster_player_id;
        v_inc_player_ids := v_inc_player_ids || v_occupant.player_id;
        v_inc_names := v_inc_names || v_occupant.player_name;
        v_inc_dates := v_inc_dates || v_return_date;
      END IF;
    END IF;
  END LOOP;

  FOR v_taxi IN
    SELECT rp.player_id,
           p.display_name AS player_name,
           p.career_regular_season_games
      FROM roster_players rp
      JOIN players p ON p.id = rp.player_id
     WHERE rp.league_id = p_league_id
       AND rp.league_season_id = p_league_season_id
       AND rp.member_id = p_member_id
       AND rp.is_on_taxi
     ORDER BY rp.id
  LOOP
    IF v_taxi.career_regular_season_games IS NOT NULL
       AND NOT private.taxi_player_eligible(p_league_id, v_taxi.player_id) THEN
      v_notices := v_notices || jsonb_build_object(
        'playerId', v_taxi.player_id,
        'playerName', v_taxi.player_name,
        'reason', 'taxi_ineligible',
        'action', 'Activate ' || v_taxi.player_name || ' from taxi or drop a player'
      );
    END IF;
  END LOOP;

  v_candidate_count := COALESCE(array_length(v_cand_roster_ids, 1), 0);
  v_occupant_count := COALESCE(array_length(v_occ_roster_ids, 1), 0);
  v_incumbent_count := COALESCE(array_length(v_inc_roster_ids, 1), 0);
  v_open_slots := GREATEST(v_ir_slots - v_ir_count, 0);
  v_free_places := v_open_slots + v_occupant_count;
  v_pool_places := v_free_places + v_incumbent_count;

  IF v_ir_count > v_ir_slots THEN
    v_placed_contender_roster_ids := ARRAY[]::uuid[];
    v_placed_contender_player_ids := ARRAY[]::uuid[];
    v_placed_contender_dates := ARRAY[]::date[];
  ELSIF v_candidate_count <= v_free_places THEN
    v_placed_contender_roster_ids := v_cand_roster_ids;
    v_placed_contender_player_ids := v_cand_player_ids;
    v_placed_contender_dates := v_cand_dates;
  ELSE
    v_pool_roster_ids := v_cand_roster_ids || v_inc_roster_ids;
    v_pool_player_ids := v_cand_player_ids || v_inc_player_ids;
    v_pool_names := v_cand_names || v_inc_names;
    v_pool_dates := v_cand_dates || v_inc_dates;
    v_pool_reliable := v_cand_reliable || array_fill(true, ARRAY[v_incumbent_count]);
    v_pool_is_incumbent := array_fill(false, ARRAY[v_candidate_count]) || array_fill(true, ARRAY[v_incumbent_count]);
    v_pool_count := v_candidate_count + v_incumbent_count;

    SELECT array_agg(roster_player_id ORDER BY reliable DESC, reliable_date DESC NULLS LAST, is_incumbent ASC, roster_player_id),
           array_agg(player_id ORDER BY reliable DESC, reliable_date DESC NULLS LAST, is_incumbent ASC, roster_player_id),
           array_agg(player_name ORDER BY reliable DESC, reliable_date DESC NULLS LAST, is_incumbent ASC, roster_player_id),
           array_agg(reliable_date ORDER BY reliable DESC, reliable_date DESC NULLS LAST, is_incumbent ASC, roster_player_id),
           array_agg(reliable ORDER BY reliable DESC, reliable_date DESC NULLS LAST, is_incumbent ASC, roster_player_id),
           array_agg(is_incumbent ORDER BY reliable DESC, reliable_date DESC NULLS LAST, is_incumbent ASC, roster_player_id)
      INTO v_sorted_roster_ids, v_sorted_player_ids, v_sorted_names, v_sorted_dates, v_sorted_reliable, v_sorted_is_incumbent
      FROM unnest(v_pool_roster_ids, v_pool_player_ids, v_pool_names, v_pool_dates, v_pool_reliable, v_pool_is_incumbent)
        AS t(roster_player_id, player_id, player_name, reliable_date, reliable, is_incumbent);

    SELECT count(*) INTO v_uncertain_count FROM unnest(v_sorted_reliable) AS r WHERE NOT r;

    v_selected_count := 0;
    IF v_uncertain_count = 0 THEN
      v_index := LEAST(v_pool_places, v_pool_count - 1);
      WHILE v_index >= 1 LOOP
        IF v_sorted_dates[v_index] > v_sorted_dates[v_index + 1] THEN
          v_selected_count := v_index;
          EXIT;
        END IF;
        v_index := v_index - 1;
      END LOOP;
    END IF;

    FOR v_index IN 1..v_selected_count LOOP
      IF NOT v_sorted_is_incumbent[v_index] THEN
        v_placed_contender_roster_ids := v_placed_contender_roster_ids || v_sorted_roster_ids[v_index];
        v_placed_contender_player_ids := v_placed_contender_player_ids || v_sorted_player_ids[v_index];
        v_placed_contender_dates := v_placed_contender_dates || v_sorted_dates[v_index];
      END IF;
    END LOOP;

    FOR v_index IN REVERSE v_pool_count..(v_selected_count + 1) LOOP
      IF v_sorted_is_incumbent[v_index] THEN
        v_exchange_incumbent_roster_ids := v_exchange_incumbent_roster_ids || v_sorted_roster_ids[v_index];
        v_exchange_incumbent_player_ids := v_exchange_incumbent_player_ids || v_sorted_player_ids[v_index];
        v_exchange_incumbent_names := v_exchange_incumbent_names || v_sorted_names[v_index];
        v_exchange_incumbent_dates := v_exchange_incumbent_dates || v_sorted_dates[v_index];
      END IF;
    END LOOP;

    IF v_selected_count < LEAST(v_pool_places, v_pool_count) THEN
      v_boundary_date := v_sorted_dates[v_selected_count + 1];
      FOR v_index IN (v_selected_count + 1)..v_pool_count LOOP
        IF NOT v_sorted_is_incumbent[v_index]
           AND (NOT v_sorted_reliable[v_index]
                OR v_sorted_dates[v_index] IS NOT DISTINCT FROM v_boundary_date) THEN
          v_notices := v_notices || jsonb_build_object(
            'playerId', v_sorted_player_ids[v_index],
            'playerName', v_sorted_names[v_index],
            'reason', 'ir_choice_uncertain',
            'action', 'Choose who moves to IR'
          );
        END IF;
      END LOOP;
    END IF;
  END IF;

  v_placed_count := COALESCE(array_length(v_placed_contender_roster_ids, 1), 0);
  v_designate_count := LEAST(v_open_slots, v_placed_count);
  v_healthy_swap_count := LEAST(v_occupant_count, v_placed_count - v_designate_count);
  v_incumbent_swap_count := v_placed_count - v_designate_count - v_healthy_swap_count;
  v_exchange_incumbent_count := COALESCE(array_length(v_exchange_incumbent_roster_ids, 1), 0);

  v_unambiguous_exchange_count := 0;
  IF v_incumbent_swap_count > 0 THEN
    v_index := v_incumbent_swap_count;
    WHILE v_index >= 1 LOOP
      IF v_index = v_exchange_incumbent_count
         OR v_exchange_incumbent_dates[v_index] < v_exchange_incumbent_dates[v_index + 1] THEN
        v_unambiguous_exchange_count := v_index;
        EXIT;
      END IF;
      v_index := v_index - 1;
    END LOOP;
  END IF;

  v_kept_incumbent_player_ids := ARRAY[]::uuid[];
  FOR v_j IN 1..v_incumbent_count LOOP
    IF NOT (v_inc_player_ids[v_j] = ANY(v_exchange_incumbent_player_ids[1:v_unambiguous_exchange_count])) THEN
      v_kept_incumbent_player_ids := v_kept_incumbent_player_ids || v_inc_player_ids[v_j];
    END IF;
  END LOOP;

  FOR v_index IN 1..v_designate_count LOOP
    v_moves := v_moves || jsonb_build_object(
      'kind', 'designate',
      'designatePlayerId', v_placed_contender_player_ids[v_index],
      'designateRosterPlayerId', v_placed_contender_roster_ids[v_index]
    );
  END LOOP;

  FOR v_index IN 1..v_healthy_swap_count LOOP
    v_moves := v_moves || jsonb_build_object(
      'kind', 'swap',
      'swapKind', 'healthy',
      'designatePlayerId', v_placed_contender_player_ids[v_designate_count + v_index],
      'designateRosterPlayerId', v_placed_contender_roster_ids[v_designate_count + v_index],
      'activatePlayerId', v_occ_player_ids[v_index],
      'activateRosterPlayerId', v_occ_roster_ids[v_index]
    );
  END LOOP;

  FOR v_index IN 1..v_unambiguous_exchange_count LOOP
    v_moves := v_moves || jsonb_build_object(
      'kind', 'swap',
      'swapKind', 'incumbent',
      'designatePlayerId', v_placed_contender_player_ids[v_designate_count + v_healthy_swap_count + v_index],
      'designateRosterPlayerId', v_placed_contender_roster_ids[v_designate_count + v_healthy_swap_count + v_index],
      'activatePlayerId', v_exchange_incumbent_player_ids[v_index],
      'activateRosterPlayerId', v_exchange_incumbent_roster_ids[v_index],
      'plannedContenderReturn', v_placed_contender_dates[v_designate_count + v_healthy_swap_count + v_index]::text,
      'plannedIncumbentReturn', v_exchange_incumbent_dates[v_index]::text,
      'comparedIncumbentPlayerIds', to_jsonb(v_kept_incumbent_player_ids)
    );
  END LOOP;

  IF v_unambiguous_exchange_count < v_incumbent_swap_count THEN
    v_boundary_date := v_exchange_incumbent_dates[v_unambiguous_exchange_count + 1];
    FOR v_index IN (v_unambiguous_exchange_count + 1)..v_exchange_incumbent_count LOOP
      IF v_exchange_incumbent_dates[v_index] = v_boundary_date THEN
        v_notices := v_notices || jsonb_build_object(
          'playerId', v_exchange_incumbent_player_ids[v_index],
          'playerName', v_exchange_incumbent_names[v_index],
          'reason', 'ir_choice_uncertain',
          'action', 'Choose who moves to IR'
        );
      END IF;
    END LOOP;
  END IF;

  v_active_now := v_active_count - v_designate_count;
  v_unplaced_eligible_active := v_active_eligible_count - v_placed_count;
  v_unplaced_usable_active := v_candidate_count - v_placed_count;
  v_swap_available := v_unplaced_usable_active > 0;
  FOR v_index IN (v_healthy_swap_count + 1)..v_occupant_count LOOP
    v_occupant_roster_id := v_occ_roster_ids[v_index];
    v_occupant_player_id := v_occ_player_ids[v_index];
    v_occupant_name := v_occ_names[v_index];
    IF v_active_now < v_roster_size THEN
      v_moves := v_moves || jsonb_build_object(
        'kind', 'activate',
        'activatePlayerId', v_occupant_player_id,
        'activateRosterPlayerId', v_occupant_roster_id
      );
      v_active_now := v_active_now + 1;
    ELSE
      v_notices := v_notices || jsonb_build_object(
        'playerId', v_occupant_player_id,
        'playerName', v_occupant_name,
        'reason', CASE
          WHEN v_ir_count > v_ir_slots THEN 'healthy_ir_bench_full'
          WHEN v_unplaced_usable_active > 0 THEN 'healthy_ir_swap_available'
          WHEN v_unplaced_eligible_active > 0 THEN 'healthy_ir_swap_locked'
          ELSE 'healthy_ir_bench_full' END,
        'action', CASE
          WHEN v_ir_count > v_ir_slots THEN 'Drop a player, then activate ' || v_occupant_name
          WHEN v_unplaced_usable_active > 0 THEN 'Swap ' || v_occupant_name || ' with an injured player'
          WHEN v_unplaced_eligible_active > 0 THEN 'Swap ' || v_occupant_name || ' with an injured player after their game or pending move clears'
          ELSE 'Drop a player, then activate ' || v_occupant_name END
      );
    END IF;
  END LOOP;

  RETURN jsonb_build_object('moves', v_moves, 'skipped', v_skipped, 'notices', v_notices);
END;
$function$;

CREATE OR REPLACE FUNCTION private.activate_rookie_draft_league_if_ready(
  p_draft_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_draft drafts%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_current_season league_seasons%ROWTYPE;
  v_rows int;
  v_unfilled_picks int;
  v_deadline boolean;
  v_member record;
  v_roster record;
  v_active int;
BEGIN
  -- Serialize with picks before taking draft, league or season row locks.
  PERFORM pg_advisory_xact_lock(hashtext(p_draft_id::text), 0);

  SELECT *
    INTO v_draft
    FROM drafts
   WHERE id = p_draft_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_draft.is_mock THEN
    RETURN false;
  END IF;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_draft.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_draft.draft_type <> 'snake'::draft_type OR v_draft.status NOT IN ('completed'::draft_status,'cancelled'::draft_status) THEN
    RETURN false;
  END IF;

  SELECT *
    INTO v_current_season
    FROM league_seasons
   WHERE league_id = v_draft.league_id
     AND is_current = true
   FOR UPDATE;

  IF NOT FOUND OR v_draft.league_season_id <> v_current_season.id THEN
    RETURN false;
  END IF;

  SELECT count(*)
    INTO v_unfilled_picks
    FROM snake_draft_picks
   WHERE draft_id = v_draft.id
     AND player_id IS NULL
     AND skipped_at IS NULL;

  IF v_unfilled_picks > 0 AND v_draft.status<>'cancelled' THEN
    RETURN false;
  END IF;

  PERFORM 1
    FROM drafts AS current_draft
   WHERE current_draft.league_id = v_draft.league_id
     AND current_draft.league_season_id = v_current_season.id
     AND current_draft.id <> v_draft.id
     AND current_draft.draft_type = 'snake'::draft_type
     AND current_draft.is_mock = false
     AND current_draft.status IN (
       'pending'::draft_status,
       'in_progress'::draft_status,
       'paused'::draft_status
     )
   LIMIT 1
   FOR UPDATE;

  IF FOUND THEN
    RETURN false;
  END IF;

  v_deadline := COALESCE(private.draft_timer_opening_night_cutoff(v_current_season.season_year) <= now(), false);
  IF v_league.status = 'drafting' AND v_deadline THEN
    FOR v_member IN SELECT id FROM league_members WHERE league_id = v_draft.league_id ORDER BY id LOOP
      IF NOT pg_try_advisory_xact_lock(hashtext(v_draft.league_id::text), hashtext(v_member.id::text)) THEN
        CONTINUE;
      END IF;
      SELECT count(*) INTO v_active FROM roster_players
        WHERE league_season_id = v_current_season.id AND member_id = v_member.id
          AND NOT is_on_ir AND NOT is_on_taxi;
      FOR v_roster IN
        SELECT roster.id, roster.player_id FROM roster_players AS roster
          JOIN snake_draft_picks AS pick ON pick.draft_id = v_draft.id
            AND pick.member_id = roster.member_id AND pick.player_id = roster.player_id
          JOIN players AS player ON player.id = roster.player_id AND player.years_exp = 0
        WHERE roster.league_season_id = v_current_season.id AND roster.member_id = v_member.id
          AND NOT EXISTS(SELECT 1 FROM private.roster_action_blocks('to_taxi',v_draft.league_id,v_current_season.id,v_member.id) block
            WHERE block.asset_kind='player' AND block.asset_id=roster.player_id)
          AND roster.acquired_via = 'draft' AND NOT roster.is_on_ir AND NOT roster.is_on_taxi
        ORDER BY pick.overall_pick DESC, roster.id FOR UPDATE OF roster SKIP LOCKED
      LOOP
        EXIT WHEN v_active <= v_league.roster_size;
        IF private.can_acquire_draft_taxi(v_draft.league_id, v_current_season.id, v_member.id,
          v_roster.player_id, v_draft.id, v_roster.id) THEN
          PERFORM private.authorize_taxi_acquisition(v_draft.league_id, v_current_season.id,
            v_member.id, v_roster.player_id, 'draft', v_draft.id);
          UPDATE roster_players SET is_on_taxi = true WHERE id = v_roster.id;
          INSERT INTO roster_transactions(league_id, league_season_id, member_id, player_id, transaction_type)
          VALUES(v_draft.league_id, v_current_season.id, v_member.id, v_roster.player_id, 'taxi_designate');
          v_active := v_active - 1;
        END IF;
      END LOOP;
    END LOOP;
  END IF;

  PERFORM 1
    FROM league_seasons AS season
    JOIN league_members AS member
      ON member.league_id = v_draft.league_id
    LEFT JOIN roster_players AS roster
      ON roster.league_id = v_draft.league_id
     AND roster.league_season_id = season.id
     AND roster.member_id = member.id
     AND roster.is_on_ir = false
     AND roster.is_on_taxi = false
   WHERE season.id = v_current_season.id
   GROUP BY member.id
  HAVING count(roster.id) > v_league.roster_size
   LIMIT 1;

  IF FOUND AND NOT v_deadline THEN
    RETURN false;
  END IF;

  UPDATE leagues
     SET status = 'active'
   WHERE id = v_draft.league_id
     AND status = 'drafting';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$;

CREATE OR REPLACE FUNCTION private.check_trade_legality(
  p_league_id uuid,p_season_id uuid,p_member_ids uuid[],p_items jsonb,p_plans jsonb,p_trade_id uuid DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_league leagues%ROWTYPE; v_team record; v_row record; v_item record; v_move jsonb;
  v_plan jsonb; v_roster jsonb; v_drops jsonb; v_reasons jsonb; v_suggestions jsonb; v_teams jsonb:='[]';
  v_unavailable jsonb; v_destinations jsonb; v_ir_error text; v_taxi_error text; v_error text;
  v_active int; v_ir int; v_taxi int; v_total int; v_limit int; v_count int; v_excess int;
  v_year int; v_available int; v_cost int; v_location text; v_rule text; v_name text; v_ir_out text; v_fix text;
  v_reserved_ids uuid[];
  v_claim_reserved_ids uuid[];
BEGIN
  SELECT * INTO STRICT v_league FROM leagues WHERE id=p_league_id;
  SELECT season_year INTO STRICT v_year FROM league_seasons WHERE id=p_season_id AND league_id=p_league_id;
  FOR v_team IN SELECT id,team_name FROM league_members WHERE league_id=p_league_id AND id=ANY(p_member_ids) ORDER BY array_position(p_member_ids,id)
  LOOP
    v_plan:=COALESCE(p_plans->v_team.id::text,'{}'); v_reasons:='[]'; v_unavailable:='{}'; v_destinations:='{}';
    WITH items AS (SELECT * FROM jsonb_to_recordset(p_items) AS i("playerId" uuid,"fromMemberId" uuid,"toMemberId" uuid,"toIR" boolean,"toTaxi" boolean)),
    retained AS (
      SELECT r.player_id,COALESCE(m.value->>'destination',CASE WHEN r.is_on_taxi THEN 'taxi' WHEN r.is_on_ir THEN 'ir' ELSE 'active' END) location,false incoming
      FROM roster_players r LEFT JOIN LATERAL (SELECT value FROM jsonb_array_elements(COALESCE(v_plan->'rosterMoves','[]')) WHERE value->>'playerId'=r.player_id::text) m ON true
      WHERE r.league_season_id=p_season_id AND r.member_id=v_team.id
        AND NOT COALESCE(v_plan->'dropPlayerIds','[]') ? r.player_id::text
        AND NOT EXISTS(SELECT 1 FROM items WHERE "fromMemberId"=v_team.id AND "playerId"=r.player_id)
      UNION ALL
      SELECT i."playerId",CASE WHEN r.is_on_taxi OR COALESCE(i."toTaxi",false) OR COALESCE(v_plan->'taxiPlayerIds','[]') ? i."playerId"::text THEN 'taxi'
        WHEN COALESCE(i."toIR",false) OR COALESCE(v_plan->'irPlayerIds','[]') ? i."playerId"::text THEN 'ir' ELSE 'active' END,true
      FROM items i JOIN roster_players r ON r.league_season_id=p_season_id AND r.member_id=i."fromMemberId" AND r.player_id=i."playerId"
      WHERE i."toMemberId"=v_team.id
    ) SELECT COALESCE(jsonb_agg(jsonb_build_object('playerId',p.id,'name',p.display_name,'location',r.location,'incoming',r.incoming) ORDER BY p.display_name),'[]') INTO v_roster
      FROM retained r JOIN players p ON p.id=r.player_id;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('playerId',p.id,'name',p.display_name)),'[]') INTO v_drops
      FROM players p WHERE COALESCE(v_plan->'dropPlayerIds','[]') ? p.id::text;
    SELECT COALESCE(array_agg(block.asset_id) FILTER (WHERE block.hold<>'claim_reserved'),'{}'::uuid[]),
        COALESCE(array_agg(block.asset_id) FILTER (WHERE block.hold='claim_reserved'),'{}'::uuid[])
      INTO v_reserved_ids, v_claim_reserved_ids
      FROM private.roster_action_blocks('trade_plan',p_league_id,p_season_id,v_team.id,ARRAY[p_trade_id]) block
      WHERE block.asset_kind='player';
    FOR v_row IN
      SELECT DISTINCT p.id,p.display_name,p.injury_status FROM players p WHERE p.id IN
        (SELECT (value->>'playerId')::uuid FROM jsonb_array_elements(v_roster)
         UNION SELECT player_id FROM roster_players WHERE league_season_id=p_season_id AND member_id=v_team.id) ORDER BY p.id
    LOOP
      v_error:=NULL;
      IF v_row.id=ANY(v_reserved_ids) THEN v_error:='Reserved by another trade.';
      ELSIF v_row.id=ANY(v_claim_reserved_ids) THEN v_error:='Reserved as a pending waiver drop.'; END IF;
      IF v_error IS NOT NULL THEN v_unavailable:=v_unavailable||jsonb_build_object(v_row.id,v_error); END IF;
      v_ir_error:=CASE WHEN v_league.ir_slots=0 THEN 'This league has no IR slots.' WHEN NOT private.is_ir_designation(v_row.injury_status) THEN 'IR requires an Out or IR designation.' END;
      v_taxi_error:=CASE WHEN NOT EXISTS(SELECT 1 FROM jsonb_to_recordset(p_items) AS i("playerId" uuid,"toMemberId" uuid)
          WHERE i."playerId"=v_row.id AND i."toMemberId"=v_team.id)
          AND NOT EXISTS(SELECT 1 FROM roster_players WHERE league_season_id=p_season_id AND member_id=v_team.id AND player_id=v_row.id AND is_on_taxi)
          THEN 'Only incoming players can be placed on Taxi.'
        WHEN v_league.taxi_slots=0 THEN 'This league has no taxi slots.'
        WHEN EXISTS(SELECT 1 FROM league_member_taxi_exits WHERE league_id=p_league_id AND member_id=v_team.id AND player_id=v_row.id) THEN 'This player cannot return to this team taxi squad.'
        WHEN NOT private.taxi_player_eligible(p_league_id,v_row.id) THEN 'Taxi requires a rookie or fewer than 65 known career games.'
        WHEN v_league.taxi_max_seasons IS NOT NULL AND v_year-private.taxi_start_year(p_league_id,v_row.id,v_year)>=v_league.taxi_max_seasons THEN 'This player has reached the taxi tenure limit.' END;
      v_destinations:=v_destinations||jsonb_build_object(v_row.id,jsonb_strip_nulls(jsonb_build_object('ir',v_ir_error,'taxi',v_taxi_error)));
      SELECT value->>'location' INTO v_location FROM jsonb_array_elements(v_roster) WHERE value->>'playerId'=v_row.id::text;
      v_rule:=CASE WHEN v_location='ir' AND v_ir_error IS NOT NULL THEN 'ir_eligibility' WHEN v_location='taxi' AND v_taxi_error IS NOT NULL THEN 'taxi_eligibility' END;
      IF v_rule IS NOT NULL THEN
        v_error:=format('%s: %s cannot use %s. %s Move %s to Regular or choose a drop.',v_team.team_name,v_row.display_name,upper(v_location),CASE WHEN v_location='ir' THEN v_ir_error ELSE v_taxi_error END,v_row.display_name);
        v_suggestions:=jsonb_build_array(jsonb_build_object('action','move','playerId',v_row.id,'playerName',v_row.display_name,'destination','active','message',format('Move %s to Regular.',v_row.display_name)));
        IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_roster) WHERE value->>'playerId'=v_row.id::text AND (value->>'incoming')::boolean) THEN
          v_suggestions:=v_suggestions||jsonb_build_array(jsonb_build_object('action','drop','playerId',v_row.id,'playerName',v_row.display_name,'message',format('Drop %s.',v_row.display_name)));
        END IF;
        v_reasons:=v_reasons||jsonb_build_array(jsonb_build_object('memberId',v_team.id,'teamName',v_team.team_name,'rule',v_rule,'playerId',v_row.id,'message',v_error,'suggestedMoves',v_suggestions));
      END IF;
    END LOOP;
    FOR v_item IN SELECT i.*,p.display_name,r.is_on_ir,r.is_on_taxi FROM jsonb_to_recordset(p_items) AS i("playerId" uuid,"fromMemberId" uuid,"toMemberId" uuid,"toIR" boolean,"toTaxi" boolean)
      JOIN players p ON p.id=i."playerId" LEFT JOIN roster_players r ON r.league_season_id=p_season_id AND r.member_id=i."fromMemberId" AND r.player_id=i."playerId"
      WHERE i."fromMemberId"=v_team.id ORDER BY i."playerId"
    LOOP
      v_rule:=NULL; v_error:=NULL;
      IF v_item.is_on_ir IS NULL THEN v_rule:='ownership'; v_error:=format('%s no longer owns %s. Remove this player from the trade.',v_team.team_name,v_item.display_name);
      ELSIF NOT v_league.allow_inactive_trades AND (v_item.is_on_ir OR v_item.is_on_taxi) THEN
        v_rule:=CASE WHEN v_item.is_on_ir THEN 'ir_trade_eligibility' ELSE 'taxi_trade_eligibility' END;
        v_error:=format('%s: the %s trade rule blocks %s. Move %s to Regular before offering this trade.',v_team.team_name,CASE WHEN v_item.is_on_ir THEN 'IR' ELSE 'taxi' END,v_item.display_name,v_item.display_name);
      END IF;
      IF v_rule IS NOT NULL THEN v_reasons:=v_reasons||jsonb_build_array(jsonb_build_object('memberId',v_team.id,'teamName',v_team.team_name,'rule',v_rule,'playerId',v_item."playerId",'message',v_error,
        'suggestedMoves',jsonb_build_array(jsonb_build_object('action','move_before_trade','playerId',v_item."playerId",'destination','active','message',format('Move %s to Regular before offering.',v_item.display_name))))); END IF;
    END LOOP;
    IF EXISTS(SELECT 1 FROM jsonb_to_recordset(p_items) AS i("playerId" uuid,"toMemberId" uuid,"toIR" boolean,"toTaxi" boolean)
      JOIN roster_players r ON r.league_season_id=p_season_id AND r.player_id=i."playerId"
      WHERE i."toMemberId"=v_team.id AND (COALESCE(i."toIR",false) OR COALESCE(v_plan->'irPlayerIds','[]') ? i."playerId"::text)
        AND (r.is_on_taxi OR COALESCE(i."toTaxi",false) OR COALESCE(v_plan->'taxiPlayerIds','[]') ? i."playerId"::text)) THEN
      v_reasons:=v_reasons||jsonb_build_array(jsonb_build_object('memberId',v_team.id,'teamName',v_team.team_name,'rule','destination_slot',
        'message',format('%s: an incoming player cannot use both IR and taxi. Traded taxi players stay on taxi.',v_team.team_name),
        'suggestedMoves',jsonb_build_array(jsonb_build_object('action','change_destination','destination','taxi','message','Keep the taxi destination and remove the IR choice.'))));
    END IF;
    FOR v_move IN SELECT value FROM jsonb_array_elements(COALESCE(v_plan->'rosterMoves','[]')) UNION ALL
      SELECT jsonb_build_object('playerId',value,'destination','drop') FROM jsonb_array_elements_text(COALESCE(v_plan->'dropPlayerIds','[]'))
    LOOP
      IF v_move->>'destination'='taxi' THEN
        v_reasons:=v_reasons||jsonb_build_array(jsonb_build_object('memberId',v_team.id,'teamName',v_team.team_name,'rule','taxi_incoming_only','playerId',v_move->>'playerId',
          'message','Only incoming players can be placed on Taxi.','suggestedMoves',jsonb_build_array(jsonb_build_object('action','remove_move','playerId',v_move->>'playerId','message','Remove this planned move.'))));
      END IF;
      IF NOT EXISTS(SELECT 1 FROM roster_players WHERE league_season_id=p_season_id AND member_id=v_team.id AND player_id=(v_move->>'playerId')::uuid)
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_items) WHERE value->>'playerId'=v_move->>'playerId') OR v_unavailable ? (v_move->>'playerId') THEN
        v_reasons:=v_reasons||jsonb_build_array(jsonb_build_object('memberId',v_team.id,'teamName',v_team.team_name,'rule','planned_move','playerId',v_move->>'playerId',
          'message',format('%s: a planned move uses a missing, offered, or reserved player. Choose another player.',v_team.team_name),'suggestedMoves',jsonb_build_array(jsonb_build_object('action','remove_move','playerId',v_move->>'playerId','message','Remove this planned move.'))));
      END IF;
    END LOOP;
    SELECT count(*),count(*) FILTER(WHERE value->>'location'='active'),count(*) FILTER(WHERE value->>'location'='ir'),count(*) FILTER(WHERE value->>'location'='taxi')
      INTO v_total,v_active,v_ir,v_taxi FROM jsonb_array_elements(v_roster);
    SELECT string_agg(p.display_name,', ') INTO v_ir_out FROM jsonb_to_recordset(p_items) AS i("playerId" uuid,"fromMemberId" uuid)
      JOIN roster_players r ON r.player_id=i."playerId" AND r.league_season_id=p_season_id AND r.member_id=v_team.id AND r.is_on_ir
      JOIN players p ON p.id=r.player_id WHERE i."fromMemberId"=v_team.id;
    FOR v_location,v_count,v_limit,v_rule,v_name IN SELECT * FROM (VALUES
      ('total',v_total,v_league.roster_size+v_league.ir_slots+v_league.taxi_slots,'roster_size','total roster'),
      ('active',v_active,v_league.roster_size,'active_slots','Regular roster'),('ir',v_ir,v_league.ir_slots,'ir_limit','IR'),('taxi',v_taxi,v_league.taxi_slots,'taxi_limit','taxi')) rules
    LOOP
      v_excess:=v_count-v_limit;
      IF v_excess<=0 THEN CONTINUE; END IF;
      v_suggestions:='[]';
      SELECT COALESCE(jsonb_agg(jsonb_build_object('action','drop','playerId',value->>'playerId','playerName',value->>'name','count',v_excess,
        'message',format('Drop %s.',value->>'name'))),'[]') INTO v_suggestions FROM jsonb_array_elements(v_roster)
        WHERE NOT (value->>'incoming')::boolean AND NOT v_unavailable ? (value->>'playerId') AND (v_location='total' OR value->>'location'=v_location);
      IF v_location<>'total' THEN
        SELECT COALESCE(jsonb_agg(jsonb_build_object('action','move','playerId',r.value->>'playerId','playerName',r.value->>'name','destination',d.location,
          'message',format('Move %s to %s.',r.value->>'name',CASE WHEN d.location='active' THEN 'Regular' ELSE upper(d.location) END))),'[]')||v_suggestions INTO v_suggestions
        FROM jsonb_array_elements(v_roster) r CROSS JOIN (VALUES('active',v_league.roster_size-v_active),('ir',v_league.ir_slots-v_ir),('taxi',v_league.taxi_slots-v_taxi)) d(location,free)
        WHERE r.value->>'location'=v_location AND d.location<>v_location AND d.free>0 AND NOT v_unavailable ? (r.value->>'playerId')
          AND NOT COALESCE(v_destinations->(r.value->>'playerId'),'{}') ? d.location
          AND NOT (d.location<>'taxi' AND EXISTS(SELECT 1 FROM roster_players WHERE league_season_id=p_season_id AND player_id=(r.value->>'playerId')::uuid AND is_on_taxi) AND (r.value->>'incoming')::boolean);
      END IF;
      IF jsonb_array_length(v_suggestions)=0 THEN
        SELECT COALESCE(jsonb_agg(jsonb_build_object('action','remove_incoming','playerId',value->>'playerId','count',v_excess,
          'message',format('Remove %s from the trade.',value->>'name'))),'[]') INTO v_suggestions
          FROM jsonb_array_elements(v_roster) WHERE (value->>'incoming')::boolean AND (v_location='total' OR value->>'location'=v_location);
      END IF;
      v_error:=format('%s: %s is %s over the limit of %s. Drop %s %s or change the listed placements.',v_team.team_name,v_name,v_excess,v_limit,v_excess,CASE WHEN v_excess=1 THEN 'player' ELSE 'players' END);
      SELECT rtrim(value->>'message','.') INTO v_fix FROM jsonb_array_elements(v_suggestions) WHERE value->>'action'='move' LIMIT 1;
      IF v_excess=1 AND v_fix IS NOT NULL THEN
        v_error:=format('%s: %s is 1 over the limit of %s. Drop 1 player or %s.',v_team.team_name,v_name,v_limit,lower(left(v_fix,1))||substr(v_fix,2));
      END IF;
      IF v_location='active' AND v_ir_out IS NOT NULL THEN v_error:=v_error||format(' Trading %s from IR does not free a Regular slot.',v_ir_out); END IF;
      v_reasons:=v_reasons||jsonb_build_array(jsonb_build_object('memberId',v_team.id,'teamName',v_team.team_name,'rule',v_rule,'count',v_excess,'limit',v_limit,'message',v_error,'suggestedMoves',v_suggestions));
    END LOOP;
    IF EXISTS(SELECT 1 FROM trades WHERE id=p_trade_id AND status='accepted') THEN
    SELECT COALESCE(sum((value->>'faabAmount')::int),0) INTO v_cost FROM jsonb_array_elements(p_items) WHERE value->>'fromMemberId'=v_team.id::text;
    v_available:=private.read_available_faab_balance(p_league_id,p_season_id,v_team.id,p_trade_id);
    IF v_cost>v_available THEN v_reasons:=v_reasons||jsonb_build_array(jsonb_build_object('memberId',v_team.id,'teamName',v_team.team_name,'rule','budget','count',v_cost-v_available,
      'message',format('%s: the budget is short by %s FAAB. Reduce the offered FAAB by %s.',v_team.team_name,v_cost-v_available,v_cost-v_available),
      'suggestedMoves',jsonb_build_array(jsonb_build_object('action','reduce_faab','amount',v_cost-v_available,'message',format('Reduce offered FAAB by %s.',v_cost-v_available))))); END IF;
    END IF;
    IF EXISTS(
      WITH commitments AS (
        SELECT t.id,p.drop_player_ids,p.roster_moves FROM trades t JOIN trade_participants p ON p.trade_id=t.id
        WHERE t.league_season_id=p_season_id AND p.member_id=v_team.id AND t.status='accepted' AND t.id IS DISTINCT FROM p_trade_id
      ), resulting AS (
        SELECT COALESCE(m.value->>'destination',r.value->>'location') location
        FROM jsonb_array_elements(v_roster) r LEFT JOIN LATERAL (
          SELECT value FROM commitments,jsonb_array_elements(roster_moves) WHERE value->>'playerId'=r.value->>'playerId'
        ) m ON true
        WHERE NOT EXISTS(SELECT 1 FROM commitments WHERE (r.value->>'playerId')::uuid=ANY(drop_player_ids))
          AND NOT EXISTS(SELECT 1 FROM commitments c JOIN trade_items i ON i.trade_id=c.id WHERE i.from_member_id=v_team.id AND i.player_id=(r.value->>'playerId')::uuid)
        UNION ALL
        SELECT CASE WHEN i.to_taxi OR r.is_on_taxi THEN 'taxi' WHEN i.to_ir THEN 'ir' ELSE 'active' END
        FROM commitments c JOIN trade_items i ON i.trade_id=c.id AND i.to_member_id=v_team.id
        JOIN roster_players r ON r.league_season_id=p_season_id AND r.player_id=i.player_id
      ) SELECT 1 FROM resulting HAVING count(*) FILTER(WHERE location='active')>v_league.roster_size
        OR count(*) FILTER(WHERE location='ir')>v_league.ir_slots OR count(*) FILTER(WHERE location='taxi')>v_league.taxi_slots
    ) AND jsonb_array_length(v_reasons)=0 THEN
      v_reasons:=v_reasons||jsonb_build_array(jsonb_build_object('memberId',v_team.id,'teamName',v_team.team_name,'rule','reserved_capacity',
        'message',format('%s: accepted trades reserve these roster slots. Add a drop or choose an eligible open slot.',v_team.team_name),
        'suggestedMoves',jsonb_build_array(jsonb_build_object('action','change_plan','message','Add a drop or resolve another accepted trade.'))));
    END IF;
    SELECT string_agg(value->>'message',' ') INTO v_error FROM jsonb_array_elements(v_reasons);
    v_teams:=v_teams||jsonb_build_array(jsonb_build_object('memberId',v_team.id,'teamName',v_team.team_name,'roster',v_roster,'drops',v_drops,'moves',COALESCE(v_plan->'rosterMoves','[]'),
      'plan',v_plan,'limits',jsonb_build_object('active',v_league.roster_size,'ir',v_league.ir_slots,'taxi',v_league.taxi_slots),'reasons',v_reasons,'legal',jsonb_array_length(v_reasons)=0,
      'error',v_error,'unavailableMoves',v_unavailable,'unavailableDestinations',v_destinations));
  END LOOP;
  RETURN v_teams;
END;
$$;

CREATE OR REPLACE FUNCTION public.toggle_ir_atomic(p_roster_player_id uuid, p_to_ir boolean, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
BEGIN
  __request_context := private.request_begin('public.toggle_ir_atomic', jsonb_build_array(p_roster_player_id, p_to_ir, p_user_id), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN; END IF;
  <<request_write>>
BEGIN
  PERFORM private.assert_roster_action_allowed(CASE WHEN p_to_ir THEN 'to_ir' ELSE 'from_ir' END::private.roster_action,
      roster.league_id,roster.league_season_id,roster.member_id,roster.player_id)
    FROM roster_players roster JOIN league_members member ON member.id=roster.member_id
    WHERE roster.id=p_roster_player_id AND member.user_id=p_user_id;
  PERFORM private.toggle_ir_for_activation(p_roster_player_id,p_to_ir,p_user_id,NULL);
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION public.toggle_taxi_atomic(p_roster_player_id uuid, p_to_taxi boolean, p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  __request_context jsonb;
BEGIN
  __request_context := private.request_begin('public.toggle_taxi_atomic', jsonb_build_array(p_roster_player_id, p_to_taxi, p_user_id), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN; END IF;
  <<request_write>>
DECLARE
  v_rp roster_players%ROWTYPE;
  v_member league_members%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_league_id uuid;
  v_player_id uuid;
  v_member_id uuid;
  v_rookie_draft_id uuid;
  v_roster_size int;
  v_active_count int;
  v_rows int;
BEGIN
  SELECT league_id, player_id, member_id
    INTO v_league_id, v_player_id, v_member_id
    FROM roster_players
   WHERE id = p_roster_player_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Roster player not found'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT draft.id INTO v_rookie_draft_id
    FROM drafts AS draft
    JOIN league_seasons AS season ON season.id = draft.league_season_id AND season.is_current
    JOIN leagues AS league ON league.id = draft.league_id AND league.status = 'drafting'
   WHERE draft.league_id = v_league_id
     AND draft.draft_type = 'snake' AND NOT draft.is_mock AND draft.status IN ('completed','cancelled')
   ORDER BY draft.created_at DESC LIMIT 1;
  IF v_rookie_draft_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext(v_rookie_draft_id::text), 0);
    PERFORM 1 FROM drafts WHERE id = v_rookie_draft_id FOR UPDATE;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(v_league_id::text),
    hashtext(v_member_id::text)
  );

  PERFORM pg_advisory_xact_lock(
    hashtext(v_league_id::text),
    hashtext(v_player_id::text)
  );

  SELECT *
    INTO v_rp
    FROM roster_players
   WHERE id = p_roster_player_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Roster player not found'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT *
    INTO v_member
    FROM league_members
   WHERE id = v_rp.member_id
     AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to modify this roster'
      USING ERRCODE = '42501';
  END IF;

  PERFORM v_member.id;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_rp.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_league.status NOT IN ('drafting'::league_status, 'active'::league_status, 'playoffs'::league_status)
    AND NOT (v_league.status='offseason' AND p_to_taxi=false) THEN
    RAISE EXCEPTION 'Roster moves are only allowed during a draft or active/playoff season.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons AS season
   WHERE season.id = v_rp.league_season_id
     AND season.is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Roster moves are only allowed for the current season.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM private.assert_roster_action_allowed(CASE WHEN p_to_taxi THEN 'to_taxi' ELSE 'from_taxi' END::private.roster_action,
    v_rp.league_id,v_rp.league_season_id,v_rp.member_id,v_rp.player_id);

  IF private.roster_status_game_started(v_rp.player_id) THEN
    RAISE EXCEPTION 'This player''s game has already started. No roster status changes are allowed for that slate.'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT p_to_taxi AND NOT v_rp.is_on_taxi THEN
    EXIT request_write;
  END IF;

  v_roster_size := COALESCE(v_league.roster_size, 20);

  IF p_to_taxi THEN
    RAISE EXCEPTION 'Players enter taxi through a draft, trade, free-agent add or waiver claim.'
      USING ERRCODE = 'P0001';
  ELSE
    SELECT count(*)
      INTO v_active_count
      FROM roster_players
     WHERE member_id = v_rp.member_id
       AND league_season_id = v_rp.league_season_id
       AND is_on_ir = false
       AND is_on_taxi = false
       AND id <> p_roster_player_id;

    IF v_active_count >= v_roster_size THEN
      RAISE EXCEPTION 'Your active roster is full (% players).', v_roster_size
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE roster_players
     SET is_on_taxi = p_to_taxi
   WHERE id = p_roster_player_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to toggle taxi status'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO roster_transactions (
    league_id,
    league_season_id,
    member_id,
    player_id,
    transaction_type
  )
  VALUES (
    v_rp.league_id,
    v_rp.league_season_id,
    v_rp.member_id,
    v_rp.player_id,
    CASE WHEN p_to_taxi THEN 'taxi_designate' ELSE 'taxi_return' END
  );
  IF v_rookie_draft_id IS NOT NULL THEN
    PERFORM private.activate_rookie_draft_league_if_ready(v_rookie_draft_id);
  END IF;
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
END;
$function$;

CREATE OR REPLACE FUNCTION public.auto_manage_ir_service(
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_league leagues%ROWTYPE;
  v_member league_members%ROWTYPE;
  v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_enabled boolean;
  v_league_auto_ir boolean;
  v_roster_size int;
  v_ir_slots int;
  v_ir_before int;
  v_active_before int;
  v_ir_after int;
  v_active_after int;
  v_user_id uuid;
  v_lock_id uuid;
  v_plan jsonb;
  v_move jsonb;
  v_kind text;
  v_swap_kind text;
  v_candidate_roster_id uuid;
  v_candidate_player_id uuid;
  v_occupant_roster_id uuid;
  v_occupant_player_id uuid;
  v_candidate_status text;
  v_candidate_return date;
  v_occupant_status text;
  v_occupant_return date;
  v_occupant_on_ir boolean;
  v_planned_contender_return date;
  v_planned_incumbent_return date;
  v_compared_player_id uuid;
  v_compared_return date;
  v_compared_on_ir boolean;
  v_moves jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_notices jsonb := '[]'::jsonb;
  v_taxi_before jsonb;
  v_taxi_after jsonb;
  v_ids_before uuid[];
  v_ids_after uuid[];
  v_problems_before text[];
  v_problems_after text[];
  v_transient text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(p_member_id::text));

  SELECT enabled INTO v_enabled
    FROM lineup_optimizer_settings
   WHERE league_id = p_league_id
     AND league_season_id = p_league_season_id
     AND member_id = p_member_id;
  v_league_auto_ir := private.league_auto_ir_all_members(p_league_id);
  IF NOT COALESCE(v_enabled, false) AND NOT v_league_auto_ir THEN
    RETURN jsonb_build_object('moves', '[]'::jsonb, 'skipped', '[]'::jsonb, 'notices', '[]'::jsonb);
  END IF;

  SELECT * INTO v_member
    FROM league_members
   WHERE id = p_member_id AND league_id = p_league_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('moves', '[]'::jsonb, 'skipped', '[]'::jsonb, 'notices', '[]'::jsonb);
  END IF;

  SELECT * INTO v_league FROM leagues WHERE id = p_league_id;
  IF NOT FOUND
     OR v_league.status NOT IN ('active'::league_status, 'playoffs'::league_status) THEN
    RETURN jsonb_build_object('moves', '[]'::jsonb, 'skipped', '[]'::jsonb, 'notices', '[]'::jsonb);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM league_seasons
     WHERE id = p_league_season_id AND league_id = p_league_id AND is_current
  ) THEN
    RETURN jsonb_build_object('moves', '[]'::jsonb, 'skipped', '[]'::jsonb, 'notices', '[]'::jsonb);
  END IF;

  v_user_id := v_member.user_id;
  v_roster_size := COALESCE(v_league.roster_size, 20);
  v_ir_slots := COALESCE(v_league.ir_slots, 2);

  FOR v_lock_id IN
    SELECT DISTINCT player_id
      FROM roster_players
     WHERE league_id = p_league_id
       AND league_season_id = p_league_season_id
       AND member_id = p_member_id
     ORDER BY player_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(v_lock_id::text));
  END LOOP;

  SELECT enabled INTO v_enabled
    FROM lineup_optimizer_settings
   WHERE league_id = p_league_id
     AND league_season_id = p_league_season_id
     AND member_id = p_member_id
   FOR SHARE;
  v_league_auto_ir := private.league_auto_ir_all_members(p_league_id);
  IF NOT COALESCE(v_enabled, false) AND NOT v_league_auto_ir THEN
    RETURN jsonb_build_object('moves', '[]'::jsonb, 'skipped', '[]'::jsonb, 'notices', '[]'::jsonb);
  END IF;

  SELECT count(*) FILTER (WHERE is_on_ir),
         count(*) FILTER (WHERE NOT is_on_ir AND NOT is_on_taxi)
    INTO v_ir_before, v_active_before
    FROM roster_players
   WHERE league_id = p_league_id
     AND league_season_id = p_league_season_id
     AND member_id = p_member_id;

  SELECT COALESCE(jsonb_agg(to_jsonb(rp) ORDER BY rp.id), '[]'::jsonb)
    INTO v_taxi_before
    FROM roster_players rp
   WHERE rp.league_id = p_league_id
     AND rp.league_season_id = p_league_season_id
     AND rp.member_id = p_member_id
     AND rp.is_on_taxi;

  SELECT COALESCE(array_agg(id ORDER BY id), ARRAY[]::uuid[])
    INTO v_ids_before
    FROM roster_players
   WHERE league_id = p_league_id
     AND league_season_id = p_league_season_id
     AND member_id = p_member_id;

  SELECT COALESCE(array_agg(kind || ':' || COALESCE(roster_player_id::text, '') ORDER BY kind, roster_player_id), ARRAY[]::text[])
    INTO v_problems_before
    FROM private.roster_problems(p_league_id, p_league_season_id, p_member_id);

  v_plan := private.plan_auto_ir(p_league_id, p_league_season_id, p_member_id);
  v_skipped := COALESCE(v_plan->'skipped', '[]'::jsonb);
  v_notices := COALESCE(v_plan->'notices', '[]'::jsonb);

  FOR v_move IN SELECT * FROM jsonb_array_elements(COALESCE(v_plan->'moves', '[]'::jsonb)) LOOP
    v_kind := v_move->>'kind';
    IF v_league_auto_ir AND (
      (v_move ? 'designatePlayerId' AND private.roster_status_game_started_live((v_move->>'designatePlayerId')::uuid))
      OR (v_move ? 'activatePlayerId' AND private.roster_status_game_started_live((v_move->>'activatePlayerId')::uuid))
    ) THEN
      v_skipped := v_skipped || jsonb_build_object(
        'playerId', COALESCE(v_move->>'designatePlayerId', v_move->>'activatePlayerId'),
        'reason', 'game_started',
        'sqlstate', 'P0001'
      );
      CONTINUE;
    END IF;
    IF v_kind = 'designate' THEN
      v_candidate_roster_id := (v_move->>'designateRosterPlayerId')::uuid;
      v_candidate_player_id := (v_move->>'designatePlayerId')::uuid;
      BEGIN
        PERFORM private.assert_roster_action_allowed('to_ir', p_league_id, p_league_season_id, p_member_id, v_candidate_player_id);
        PERFORM private.toggle_ir_for_activation(v_candidate_roster_id, true, v_user_id, NULL);
        PERFORM private.assert_accepted_trade_capacity(p_league_id, p_league_season_id, p_member_id);
        v_moves := v_moves || jsonb_build_object('kind', 'designate', 'designatePlayerId', v_candidate_player_id);
      EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE IN ('55P03', '40001', '40P01', '57014') THEN v_transient := SQLSTATE; END IF;
        v_skipped := v_skipped || jsonb_build_object('playerId', v_candidate_player_id, 'reason', SQLERRM, 'sqlstate', SQLSTATE);
      END;
    ELSIF v_kind = 'swap' THEN
      v_swap_kind := v_move->>'swapKind';
      v_candidate_roster_id := (v_move->>'designateRosterPlayerId')::uuid;
      v_candidate_player_id := (v_move->>'designatePlayerId')::uuid;
      v_occupant_roster_id := (v_move->>'activateRosterPlayerId')::uuid;
      v_occupant_player_id := (v_move->>'activatePlayerId')::uuid;
      IF v_swap_kind = 'incumbent' THEN
        BEGIN
          PERFORM private.assert_roster_action_allowed('to_ir', p_league_id, p_league_season_id, p_member_id, v_candidate_player_id);
          PERFORM private.assert_roster_action_allowed('from_ir', p_league_id, p_league_season_id, p_member_id, v_occupant_player_id);
          SELECT p.injury_status, private.ir_reliable_return(p.injury_expected_return, v_today)
            INTO v_candidate_status, v_candidate_return
            FROM roster_players rp
            JOIN players p ON p.id = rp.player_id
           WHERE rp.id = v_candidate_roster_id
           FOR SHARE OF p;
          SELECT p.injury_status, private.ir_reliable_return(p.injury_expected_return, v_today), rp.is_on_ir
            INTO v_occupant_status, v_occupant_return, v_occupant_on_ir
            FROM roster_players rp
            JOIN players p ON p.id = rp.player_id
           WHERE rp.id = v_occupant_roster_id
           FOR SHARE OF p;
          v_planned_contender_return := (v_move->>'plannedContenderReturn')::date;
          v_planned_incumbent_return := (v_move->>'plannedIncumbentReturn')::date;
          IF NOT private.is_ir_designation(v_candidate_status)
             OR v_candidate_return IS NULL
             OR v_planned_contender_return IS NULL
             OR v_candidate_return <> v_planned_contender_return
             OR NOT v_occupant_on_ir
             OR NOT private.is_ir_designation(v_occupant_status)
             OR v_occupant_return IS NULL
             OR v_planned_incumbent_return IS NULL
             OR v_occupant_return <> v_planned_incumbent_return
             OR v_planned_contender_return <= v_planned_incumbent_return THEN
            RAISE EXCEPTION 'Incumbent exchange no longer valid.' USING ERRCODE = 'P0001';
          END IF;
          FOR v_compared_player_id IN
            SELECT (value)::uuid
              FROM jsonb_array_elements_text(COALESCE(v_move->'comparedIncumbentPlayerIds', '[]'::jsonb))
             ORDER BY 1
          LOOP
            SELECT private.ir_reliable_return(p.injury_expected_return, v_today), rp.is_on_ir
              INTO v_compared_return, v_compared_on_ir
              FROM roster_players rp
              JOIN players p ON p.id = rp.player_id
             WHERE rp.league_id = p_league_id
               AND rp.league_season_id = p_league_season_id
               AND rp.member_id = p_member_id
               AND rp.player_id = v_compared_player_id
             FOR SHARE OF p;
            IF v_compared_on_ir AND v_compared_return IS NOT NULL AND v_compared_return <= v_planned_incumbent_return THEN
              RAISE EXCEPTION 'Incumbent exchange no longer valid.' USING ERRCODE = 'P0001';
            END IF;
          END LOOP;
          PERFORM private.toggle_ir_for_activation(v_candidate_roster_id, true, v_user_id, v_occupant_roster_id);
          PERFORM private.toggle_ir_for_activation(v_occupant_roster_id, false, v_user_id, NULL);
          PERFORM private.assert_accepted_trade_capacity(p_league_id, p_league_season_id, p_member_id);
          v_moves := v_moves || jsonb_build_object(
            'kind', 'swap',
            'designatePlayerId', v_candidate_player_id,
            'activatePlayerId', v_occupant_player_id
          );
        EXCEPTION WHEN OTHERS THEN
          IF SQLSTATE IN ('55P03', '40001', '40P01', '57014') THEN v_transient := SQLSTATE; END IF;
          v_skipped := v_skipped || jsonb_build_object('playerId', v_candidate_player_id, 'reason', SQLERRM, 'sqlstate', SQLSTATE);
        END;
      ELSE
        BEGIN
          PERFORM private.assert_roster_action_allowed('to_ir', p_league_id, p_league_season_id, p_member_id, v_candidate_player_id);
          PERFORM private.assert_roster_action_allowed('from_ir', p_league_id, p_league_season_id, p_member_id, v_occupant_player_id);
          SELECT p.injury_status, rp.is_on_ir
            INTO v_occupant_status, v_occupant_on_ir
            FROM roster_players rp
            JOIN players p ON p.id = rp.player_id
           WHERE rp.id = v_occupant_roster_id
           FOR SHARE OF p;
          IF NOT v_occupant_on_ir OR private.is_ir_designation(v_occupant_status) THEN
            RAISE EXCEPTION 'Healthy occupant is no longer activatable.' USING ERRCODE = 'P0001';
          END IF;
          PERFORM private.toggle_ir_for_activation(v_candidate_roster_id, true, v_user_id, v_occupant_roster_id);
          PERFORM private.toggle_ir_for_activation(v_occupant_roster_id, false, v_user_id, NULL);
          PERFORM private.assert_accepted_trade_capacity(p_league_id, p_league_season_id, p_member_id);
          v_moves := v_moves || jsonb_build_object(
            'kind', 'swap',
            'designatePlayerId', v_candidate_player_id,
            'activatePlayerId', v_occupant_player_id
          );
        EXCEPTION WHEN OTHERS THEN
          IF SQLSTATE IN ('55P03', '40001', '40P01', '57014') THEN v_transient := SQLSTATE; END IF;
          v_skipped := v_skipped || jsonb_build_object('playerId', v_candidate_player_id, 'reason', SQLERRM, 'sqlstate', SQLSTATE);
        END;
      END IF;
    ELSIF v_kind = 'activate' THEN
      v_occupant_roster_id := (v_move->>'activateRosterPlayerId')::uuid;
      v_occupant_player_id := (v_move->>'activatePlayerId')::uuid;
      BEGIN
        PERFORM private.assert_roster_action_allowed('from_ir', p_league_id, p_league_season_id, p_member_id, v_occupant_player_id);
        SELECT p.injury_status, rp.is_on_ir
          INTO v_occupant_status, v_occupant_on_ir
          FROM roster_players rp
          JOIN players p ON p.id = rp.player_id
         WHERE rp.id = v_occupant_roster_id
         FOR SHARE OF p;
        IF NOT v_occupant_on_ir OR private.is_ir_designation(v_occupant_status) THEN
          RAISE EXCEPTION 'Healthy occupant is no longer activatable.' USING ERRCODE = 'P0001';
        END IF;
        PERFORM private.toggle_ir_for_activation(v_occupant_roster_id, false, v_user_id, NULL);
        PERFORM private.assert_accepted_trade_capacity(p_league_id, p_league_season_id, p_member_id);
        v_moves := v_moves || jsonb_build_object('kind', 'activate', 'activatePlayerId', v_occupant_player_id);
      EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE IN ('55P03', '40001', '40P01', '57014') THEN v_transient := SQLSTATE; END IF;
        v_skipped := v_skipped || jsonb_build_object('playerId', v_occupant_player_id, 'reason', SQLERRM, 'sqlstate', SQLSTATE);
      END;
    END IF;
  END LOOP;

  IF v_transient IS NOT NULL AND v_league_auto_ir THEN
    RAISE EXCEPTION 'Auto IR move failed transiently (%)', v_transient USING ERRCODE = v_transient;
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(rp) ORDER BY rp.id), '[]'::jsonb)
    INTO v_taxi_after
    FROM roster_players rp
   WHERE rp.league_id = p_league_id
     AND rp.league_season_id = p_league_season_id
     AND rp.member_id = p_member_id
     AND rp.is_on_taxi;
  IF v_taxi_after IS DISTINCT FROM v_taxi_before THEN
    RAISE EXCEPTION 'Auto IR management changed taxi rows.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(array_agg(id ORDER BY id), ARRAY[]::uuid[])
    INTO v_ids_after
    FROM roster_players
   WHERE league_id = p_league_id
     AND league_season_id = p_league_season_id
     AND member_id = p_member_id;
  IF v_ids_after IS DISTINCT FROM v_ids_before THEN
    RAISE EXCEPTION 'Auto IR management changed the roster membership.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(array_agg(kind || ':' || COALESCE(roster_player_id::text, '') ORDER BY kind, roster_player_id), ARRAY[]::text[])
    INTO v_problems_after
    FROM private.roster_problems(p_league_id, p_league_season_id, p_member_id);
  IF EXISTS (SELECT 1 FROM unnest(v_problems_after) AS p WHERE p <> ALL(v_problems_before)) THEN
    RAISE EXCEPTION 'Auto IR management introduced a new roster problem.' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) FILTER (WHERE is_on_ir),
         count(*) FILTER (WHERE NOT is_on_ir AND NOT is_on_taxi)
    INTO v_ir_after, v_active_after
    FROM roster_players
   WHERE league_id = p_league_id
     AND league_season_id = p_league_season_id
     AND member_id = p_member_id;

  IF v_ir_after > v_ir_slots
     AND NOT (v_ir_before > v_ir_slots AND v_ir_after <= v_ir_before) THEN
    RAISE EXCEPTION 'Auto IR management exceeded the IR capacity.' USING ERRCODE = 'P0001';
  END IF;
  IF v_active_after > v_roster_size
     AND NOT (v_active_before > v_roster_size AND v_active_after <= v_active_before) THEN
    RAISE EXCEPTION 'Auto IR management exceeded the active roster capacity.' USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object('moves', v_moves, 'skipped', v_skipped, 'notices', v_notices);
END;
$function$;

REVOKE ALL ON FUNCTION private.roster_action_policy() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.roster_action_blocks(private.roster_action, uuid, uuid, uuid, uuid[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.assert_roster_action_allowed(private.roster_action, uuid, uuid, uuid, uuid, uuid, uuid[]) FROM PUBLIC, anon, authenticated, service_role;
DROP FUNCTION private.assert_asset_unlocked(uuid, uuid, uuid, uuid);
