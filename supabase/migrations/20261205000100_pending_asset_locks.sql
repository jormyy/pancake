BEGIN;
CREATE OR REPLACE FUNCTION private.locked_assets(p_league_id uuid, p_league_season_id uuid, p_member_id uuid)
RETURNS TABLE(asset_kind text, asset_id uuid, source_kind text, source_id uuid, reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH active_trades AS (
    SELECT trade.* FROM public.trades trade
    WHERE trade.league_id = p_league_id AND trade.league_season_id = p_league_season_id
      AND trade.status IN ('pending', 'accepted')
  ), trade_assets AS (
    SELECT CASE WHEN item.player_id IS NOT NULL THEN 'player' ELSE 'pick' END AS kind,
      COALESCE(item.player_id, item.pick_id) AS id, trade.id AS trade_id, trade.status
    FROM active_trades trade JOIN public.trade_items item ON item.trade_id = trade.id
    WHERE item.from_member_id = p_member_id AND COALESCE(item.player_id, item.pick_id) IS NOT NULL
      AND (trade.status = 'accepted' OR trade.proposer_member_id = p_member_id OR EXISTS (
        SELECT 1 FROM public.trade_participants participant WHERE participant.trade_id = trade.id
          AND participant.member_id = p_member_id AND participant.accepted_at IS NOT NULL))
    UNION
    SELECT 'player', reserved.id, trade.id, trade.status
    FROM active_trades trade JOIN public.trade_participants participant ON participant.trade_id = trade.id
    CROSS JOIN LATERAL (
      SELECT unnest(participant.drop_player_ids) AS id
      UNION SELECT (move->>'playerId')::uuid FROM jsonb_array_elements(participant.roster_moves) move
    ) reserved
    WHERE participant.member_id = p_member_id
  )
  SELECT kind, id, 'trade', trade_id,
    format('Locked by trade %s. %s', left(trade_id::text, 8),
      CASE WHEN status = 'pending' THEN 'Cancel the trade to change this asset.' ELSE 'Resolve the trade to change this asset.' END)
  FROM trade_assets
  UNION ALL
  SELECT 'player', reserved.id, 'claim', claim.id,
    format('Locked by waiver claim %s. Cancel the claim to change this player.', left(claim.id::text, 8))
  FROM public.waiver_claims claim
  CROSS JOIN LATERAL (SELECT DISTINCT unnest(ARRAY[claim.player_id, claim.drop_player_id]) AS id) reserved
  WHERE claim.league_id = p_league_id AND claim.league_season_id = p_league_season_id
    AND claim.member_id = p_member_id AND claim.status = 'pending' AND reserved.id IS NOT NULL
$$;

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

-- Canonical SQL source for private.assert_not_reserved_trade_asset.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
DECLARE lock_reason text;
BEGIN
  SELECT locked.reason INTO lock_reason FROM private.locked_assets(p_league_id,
    COALESCE(p_league_season_id, (SELECT id FROM public.league_seasons WHERE league_id=p_league_id AND is_current)), p_member_id) locked
    WHERE locked.source_kind='trade' AND (p_exclude_trade_id IS NULL OR locked.source_id<>p_exclude_trade_id)
      AND ((locked.asset_kind='player' AND locked.asset_id=p_player_id) OR (locked.asset_kind='pick' AND locked.asset_id=p_pick_id))
    ORDER BY locked.source_id LIMIT 1;
  IF lock_reason IS NOT NULL THEN RAISE EXCEPTION '%', lock_reason USING ERRCODE = 'PA004'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.guard_trade_plan_reservations()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_trade trades%ROWTYPE; v_player uuid; v_ids uuid[]; v_member uuid; lock_reason text;
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
    SELECT locked.reason INTO lock_reason FROM private.locked_assets(v_trade.league_id,v_trade.league_season_id,v_member) locked
      WHERE (locked.source_kind<>'trade' OR locked.source_id<>NEW.trade_id)
        AND NOT (locked.source_kind='trade' AND locked.source_id IN (v_trade.edited_from_trade_id,v_trade.countered_from_trade_id)
          AND EXISTS (SELECT 1 FROM trades source WHERE source.id=locked.source_id AND source.status='pending'
            AND source.league_id=v_trade.league_id AND source.league_season_id=v_trade.league_season_id
            AND ((source.id=v_trade.edited_from_trade_id AND source.proposer_member_id=v_trade.proposer_member_id
                AND source.recipient_member_id=v_trade.recipient_member_id)
              OR (source.id=v_trade.countered_from_trade_id AND source.recipient_member_id=v_trade.proposer_member_id
                AND source.proposer_member_id=v_trade.recipient_member_id))))
        AND ((locked.asset_kind='player' AND locked.asset_id=ANY(v_ids))
          OR (TG_TABLE_NAME='trade_items' AND locked.asset_kind='pick' AND locked.asset_id=(to_jsonb(NEW)->>'pick_id')::uuid))
      ORDER BY locked.source_kind,locked.source_id LIMIT 1;
    IF lock_reason IS NOT NULL THEN RAISE EXCEPTION '%', lock_reason USING ERRCODE='PA004'; END IF;
  END IF;
  FOR v_player IN SELECT DISTINCT id FROM unnest(v_ids) id WHERE id IS NOT NULL ORDER BY id LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text),hashtext(v_player::text));
    IF EXISTS (SELECT 1 FROM trade_participants participant JOIN trades trade ON trade.id=participant.trade_id
      WHERE trade.league_id=v_trade.league_id AND trade.league_season_id=v_trade.league_season_id
        AND trade.status IN ('pending','accepted') AND trade.id<>NEW.trade_id
        AND (v_player=ANY(participant.drop_player_ids) OR participant.roster_moves @> jsonb_build_array(jsonb_build_object('playerId',v_player::text)))) THEN
      RAISE EXCEPTION 'Player is reserved by another trade roster plan.' USING ERRCODE='PT001';
    END IF;
    IF TG_TABLE_NAME='trade_participants' THEN
      IF EXISTS (SELECT 1 FROM trade_items item JOIN trades trade ON trade.id=item.trade_id
        WHERE trade.league_id=v_trade.league_id AND trade.league_season_id=v_trade.league_season_id
          AND trade.status IN ('pending','accepted') AND trade.id<>NEW.trade_id AND item.player_id=v_player)
        OR EXISTS (SELECT 1 FROM waiver_claims WHERE league_season_id=v_trade.league_season_id
          AND status='pending' AND (drop_player_id=v_player OR player_id=v_player)) THEN
        RAISE EXCEPTION 'Planned drop or move is reserved by another trade or active waiver claim.' USING ERRCODE='PT001';
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
DECLARE v_player uuid; lock_reason text;
BEGIN
  IF NEW.status<>'pending' THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtext(NEW.league_id::text),hashtext(NEW.member_id::text));
  FOR v_player IN SELECT DISTINCT id FROM unnest(ARRAY[NEW.player_id,NEW.drop_player_id]) id
    WHERE id IS NOT NULL ORDER BY id LOOP
    PERFORM pg_advisory_xact_lock(hashtext(NEW.league_id::text),hashtext(v_player::text));
    SELECT locked.reason INTO lock_reason FROM private.locked_assets(NEW.league_id,NEW.league_season_id,NEW.member_id) locked
      WHERE locked.asset_kind='player' AND locked.asset_id=v_player AND locked.source_kind='trade'
      ORDER BY locked.source_id LIMIT 1;
    IF lock_reason IS NOT NULL THEN RAISE EXCEPTION '%', lock_reason USING ERRCODE='PA004'; END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

-- Canonical SQL source for private.is_reserved_trade_asset.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
    SELECT 1 FROM private.locked_assets(p_league_id,
      COALESCE(p_league_season_id, (SELECT id FROM public.league_seasons WHERE league_id=p_league_id AND is_current)), p_member_id) locked
    WHERE locked.source_kind='trade' AND (p_exclude_trade_id IS NULL OR locked.source_id<>p_exclude_trade_id)
      AND ((locked.asset_kind='player' AND locked.asset_id=p_player_id) OR (locked.asset_kind='pick' AND locked.asset_id=p_pick_id))
  )
$$;

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

  IF (OLD.league_id,OLD.league_season_id,OLD.member_id,OLD.player_id) IS DISTINCT FROM (NEW.league_id,NEW.league_season_id,NEW.member_id,NEW.player_id)
    OR OLD.is_on_ir IS DISTINCT FROM NEW.is_on_ir OR OLD.is_on_taxi IS DISTINCT FROM NEW.is_on_taxi THEN
    SELECT locked.reason INTO lock_reason FROM private.locked_assets(OLD.league_id, OLD.league_season_id, OLD.member_id) locked
      WHERE locked.source_kind='claim' AND locked.asset_id=OLD.player_id ORDER BY locked.source_id LIMIT 1;
    IF lock_reason IS NOT NULL THEN RAISE EXCEPTION '%', lock_reason USING ERRCODE='PA004'; END IF;
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

-- Canonical SQL source for private.prevent_accepted_trade_pick_change.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.prevent_accepted_trade_pick_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM leagues WHERE id=OLD.league_id) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF private.trade_lifecycle_write_active() THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    PERFORM private.assert_not_reserved_trade_asset(OLD.league_id,NULL,OLD.current_owner_id,NULL,OLD.id);
    RETURN OLD;
  END IF;

  IF private.pick_left_owner(OLD, NEW) IS NOT NULL THEN
    PERFORM private.assert_not_reserved_trade_asset(OLD.league_id, NULL, OLD.current_owner_id, NULL, OLD.id);
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.prevent_locked_lineup_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE row_data public.weekly_lineups%ROWTYPE; lock_reason text;
BEGIN
  IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM public.leagues WHERE id=OLD.league_id) THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' AND (OLD.member_id, OLD.league_id, OLD.league_season_id, OLD.player_id, OLD.game_date, OLD.slot_type)
    IS NOT DISTINCT FROM (NEW.member_id, NEW.league_id, NEW.league_season_id, NEW.player_id, NEW.game_date, NEW.slot_type) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN row_data := NEW; ELSE row_data := OLD; END IF;
  PERFORM pg_advisory_xact_lock(hashtext(row_data.league_id::text), hashtext(row_data.member_id::text));
  SELECT locked.reason INTO lock_reason
    FROM private.locked_assets(row_data.league_id, row_data.league_season_id, row_data.member_id) locked
    WHERE locked.asset_kind = 'player' AND locked.asset_id = row_data.player_id
      AND NOT (locked.source_kind='trade' AND private.trade_lifecycle_write_active()
        AND EXISTS (SELECT 1 FROM private.taxi_acquisition_context context JOIN public.trades trade ON trade.id=context.related_id
          WHERE context.transaction_id=pg_current_xact_id() AND context.source='trade'
            AND context.league_id=row_data.league_id AND context.league_season_id=row_data.league_season_id
            AND context.player_id=row_data.player_id AND context.related_id=locked.source_id AND trade.status='accepted'))
    ORDER BY locked.source_kind, locked.source_id LIMIT 1;
  IF lock_reason IS NOT NULL THEN RAISE EXCEPTION '%', lock_reason USING ERRCODE = 'PA004'; END IF;
  IF TG_OP = 'UPDATE' THEN
    SELECT locked.reason INTO lock_reason
      FROM private.locked_assets(NEW.league_id, NEW.league_season_id, NEW.member_id) locked
      WHERE locked.asset_kind = 'player' AND locked.asset_id = NEW.player_id
      ORDER BY locked.source_kind, locked.source_id LIMIT 1;
    IF lock_reason IS NOT NULL THEN RAISE EXCEPTION '%', lock_reason USING ERRCODE = 'PA004'; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.publish_asset_lock_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE changed jsonb; previous jsonb; league_id uuid; prior_mode text; topic text;
BEGIN
  changed := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  previous := CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
  IF TG_OP='UPDATE' AND changed=previous THEN RETURN NULL; END IF;
  IF TG_TABLE_NAME IN ('trades','waiver_claims') THEN
    IF COALESCE(changed->>'status','') NOT IN ('pending','accepted')
      AND COALESCE(previous->>'status','') NOT IN ('pending','accepted') THEN RETURN NULL; END IF;
    league_id := (changed->>'league_id')::uuid;
  ELSE
    SELECT trade.league_id INTO league_id FROM public.trades trade WHERE trade.id=(changed->>'trade_id')::uuid
      AND trade.status IN ('pending','accepted');
  END IF;
  IF league_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.leagues WHERE id=league_id) THEN RETURN NULL; END IF;
  topic := CASE WHEN TG_TABLE_NAME='waiver_claims' THEN 'claim' ELSE 'trade' END;
  prior_mode := COALESCE(current_setting('pancake.trade_write',true),'');
  PERFORM set_config('pancake.trade_write','',true);
  PERFORM private.league_version_enqueue(league_id,topic,'locked_assets');
  PERFORM set_config('pancake.trade_write',prior_mode,true);
  RETURN NULL;
END;
$$;

-- Canonical SQL source for private.release_roster_player_to_waivers.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.release_roster_player_to_waivers(
  p_roster_player_id uuid,
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid,
  p_player_id uuid,
  p_transaction_type text,
  p_related_claim_id uuid DEFAULT NULL,
  p_related_trade_id uuid DEFAULT NULL,
  p_missing_message text DEFAULT 'Roster player is no longer on the expected roster.'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows int;
BEGIN
  IF p_related_trade_id IS NOT NULL AND private.trade_lifecycle_write_active() AND EXISTS (
    SELECT 1 FROM trade_participants participant JOIN trades trade ON trade.id=participant.trade_id
    WHERE trade.id=p_related_trade_id AND trade.status='accepted' AND trade.league_id=p_league_id
      AND trade.league_season_id=p_league_season_id AND participant.member_id=p_member_id
      AND p_player_id=ANY(participant.drop_player_ids)
  ) THEN
    PERFORM private.authorize_taxi_acquisition(p_league_id,p_league_season_id,p_member_id,p_player_id,'trade',p_related_trade_id);
  END IF;
  DELETE FROM roster_players AS rp
   WHERE rp.id = p_roster_player_id
     AND rp.league_id = p_league_id
     AND rp.league_season_id = p_league_season_id
     AND rp.member_id = p_member_id
     AND rp.player_id = p_player_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION '%', p_missing_message
      USING ERRCODE = 'PT001';
  END IF;

  INSERT INTO waiver_wire_log (
    league_id,
    league_season_id,
    player_id,
    dropped_by_member_id
  )
  VALUES (
    p_league_id,
    p_league_season_id,
    p_player_id,
    p_member_id
  );

  INSERT INTO roster_transactions (
    league_id,
    league_season_id,
    member_id,
    player_id,
    transaction_type,
    related_claim_id,
    related_trade_id
  )
  VALUES (
    p_league_id,
    p_league_season_id,
    p_member_id,
    p_player_id,
    p_transaction_type,
    p_related_claim_id,
    p_related_trade_id
  );
END;
$$;

-- Canonical SQL source for private.validate_waiver_claim_drop_player.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.validate_waiver_claim_drop_player(
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid,
  p_drop_player_id uuid,
  p_missing_message text DEFAULT 'Drop player must be on your active roster.'
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
     AND rp.is_on_ir = false
     AND rp.is_on_taxi = false
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, p_missing_message;
    RETURN;
  END IF;

  SELECT locked.reason INTO lock_reason FROM private.locked_assets(p_league_id, p_league_season_id, p_member_id) locked
    WHERE locked.source_kind='trade' AND locked.asset_id=p_drop_player_id ORDER BY locked.source_id LIMIT 1;
  IF lock_reason IS NOT NULL THEN
    RETURN QUERY SELECT v_roster_player_id, lock_reason;
    RETURN;
  END IF;

  RETURN QUERY SELECT v_roster_player_id, NULL::text;
END;
$$;

-- Canonical SQL source for public.auto_set_lineup_atomic_unchecked.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.auto_set_lineup_atomic_unchecked(p_member_id uuid, p_league_id uuid, p_league_season_id uuid, p_game_date date, p_assignments jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_member league_members%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_player_ids uuid[];
  v_owned_count int;
  v_total_count int;
  v_duplicate_player uuid;
  v_invalid_slot roster_slot_type;
  v_invalid_player text;
  v_invalid_player_slot roster_slot_type;
  v_locked_player text;
  lock_reason text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(p_member_id::text));
  PERFORM pg_advisory_xact_lock(
    hashtext(p_member_id::text),
    hashtext(p_game_date::text)
  );

  SELECT *
    INTO v_member
    FROM league_members
   WHERE id = p_member_id
     AND league_id = p_league_id
     AND user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to modify this lineup.'
      USING ERRCODE = '42501';
  END IF;

  PERFORM v_member.id;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR NO KEY UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_league.status NOT IN ('active'::league_status, 'playoffs'::league_status) THEN
    RAISE EXCEPTION 'Lineups can only be set during an active or playoff season.'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_assignments IS NULL OR jsonb_typeof(p_assignments) <> 'array' THEN
    RAISE EXCEPTION 'p_assignments must be a JSONB array.'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_assignments) AS a
     WHERE a->>'player_id' IS NULL
        OR a->>'slot_type' IS NULL
  ) THEN
    RAISE EXCEPTION 'Every lineup assignment must include player_id and slot_type.'
      USING ERRCODE = '22023';
  END IF;

  WITH assignments AS (
    SELECT
      (a->>'player_id')::uuid AS player_id,
      (a->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_assignments) AS a
  )
  SELECT player_id
    INTO v_duplicate_player
    FROM assignments
   GROUP BY player_id
  HAVING count(*) > 1
   LIMIT 1;

  IF v_duplicate_player IS NOT NULL THEN
    RAISE EXCEPTION 'A player can only appear once in a lineup.'
      USING ERRCODE = '22023';
  END IF;

  SELECT array_agg(DISTINCT (a->>'player_id')::uuid ORDER BY (a->>'player_id')::uuid)
    INTO v_player_ids
    FROM jsonb_array_elements(p_assignments) AS a
   WHERE a->>'player_id' IS NOT NULL;

  v_player_ids := COALESCE(v_player_ids, ARRAY[]::uuid[]);

  IF array_length(v_player_ids, 1) IS NOT NULL THEN
    PERFORM 1
       FROM roster_players
      WHERE member_id = p_member_id
        AND league_id = p_league_id
        AND league_season_id = p_league_season_id
        AND player_id = ANY (v_player_ids)
      FOR SHARE;

    SELECT count(*)
      INTO v_owned_count
      FROM unnest(v_player_ids) AS requested(player_id)
     WHERE EXISTS (
       SELECT 1 FROM roster_players rp
        WHERE rp.member_id = p_member_id
          AND rp.league_id = p_league_id
          AND rp.league_season_id = p_league_season_id
          AND rp.player_id = requested.player_id
     ) OR EXISTS (
       SELECT 1
         FROM weekly_lineups wl
         JOIN jsonb_array_elements(p_assignments) AS a
           ON (a->>'player_id')::uuid = wl.player_id
          AND (a->>'slot_type')::roster_slot_type = wl.slot_type
        WHERE wl.member_id = p_member_id
          AND wl.league_id = p_league_id
          AND wl.league_season_id = p_league_season_id
          AND wl.game_date = p_game_date
          AND wl.player_id = requested.player_id
          AND private.lineup_game_started(wl.player_id, wl.game_date)
     );

    v_total_count := array_length(v_player_ids, 1);
    IF v_owned_count <> v_total_count THEN
      RAISE EXCEPTION 'One or more players in the lineup are no longer on your roster.'
        USING ERRCODE = 'P0002';
    END IF;
  END IF;

  WITH assignments AS (
    SELECT
      (a->>'player_id')::uuid AS player_id,
      (a->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_assignments) AS a
  )
  SELECT slot_type
    INTO v_invalid_slot
    FROM assignments
   WHERE slot_type = 'IR'::roster_slot_type
   LIMIT 1;

  IF v_invalid_slot IS NOT NULL THEN
    RAISE EXCEPTION 'Use the roster injured reserve action instead of assigning an IR lineup slot.'
      USING ERRCODE = 'P0001';
  END IF;

  WITH assignments AS (
    SELECT
      (a->>'player_id')::uuid AS player_id,
      (a->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_assignments) AS a
  )
  SELECT a.slot_type
    INTO v_invalid_slot
    FROM assignments a
   WHERE a.slot_type <> 'BE'::roster_slot_type
     AND NOT EXISTS (
       SELECT 1
         FROM lineup_slot_templates t
        WHERE t.league_id = p_league_id
          AND t.slot_type = a.slot_type
          AND t.slot_type NOT IN ('BE'::roster_slot_type, 'IR'::roster_slot_type)
     )
   LIMIT 1;

  IF v_invalid_slot IS NOT NULL THEN
    RAISE EXCEPTION 'Lineup slot % is not configured for this league.', v_invalid_slot
      USING ERRCODE = 'P0001';
  END IF;

  WITH assignments AS (
    SELECT
      (a->>'player_id')::uuid AS player_id,
      (a->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_assignments) AS a
  )
  SELECT a.slot_type
    INTO v_invalid_slot
    FROM assignments a
   WHERE a.slot_type <> 'BE'::roster_slot_type
   GROUP BY a.slot_type
  HAVING count(*) > (
      SELECT t.slot_count
        FROM lineup_slot_templates t
       WHERE t.league_id = p_league_id
         AND t.slot_type = a.slot_type
   )
   LIMIT 1;

  IF v_invalid_slot IS NOT NULL THEN
    RAISE EXCEPTION 'Lineup slot % has too many players.', v_invalid_slot
      USING ERRCODE = 'P0001';
  END IF;

  WITH assignments AS (
    SELECT
      (a->>'player_id')::uuid AS player_id,
      (a->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_assignments) AS a
  )
  SELECT p.display_name, a.slot_type
    INTO v_invalid_player, v_invalid_player_slot
    FROM assignments a
    JOIN roster_players rp
      ON rp.member_id = p_member_id
     AND rp.league_id = p_league_id
     AND rp.league_season_id = p_league_season_id
     AND rp.player_id = a.player_id
    JOIN players p ON p.id = rp.player_id
   WHERE a.slot_type <> 'BE'::roster_slot_type
     AND (rp.is_on_ir OR COALESCE(rp.is_on_taxi, false))
   LIMIT 1;

  IF v_invalid_player IS NOT NULL THEN
    RAISE EXCEPTION 'Activate % before assigning a starter slot.', v_invalid_player
      USING ERRCODE = 'P0001';
  END IF;

  WITH assignments AS (
    SELECT
      (a->>'player_id')::uuid AS player_id,
      (a->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_assignments) AS a
  ),
  player_slots AS (
    SELECT
      p.display_name,
      a.slot_type,
      CASE
        WHEN cardinality(COALESCE(p.eligible_positions, '{}'::text[])) > 0
          THEN p.eligible_positions
        WHEN p.position IS NOT NULL
          THEN ARRAY[p.position::text]::text[]
        ELSE '{}'::text[]
      END AS eligible_positions,
      public.lineup_slot_allowed_positions(a.slot_type) AS allowed_positions
      FROM assignments a
      JOIN players p ON p.id = a.player_id
     WHERE a.slot_type <> 'BE'::roster_slot_type
  )
  SELECT display_name, slot_type
    INTO v_invalid_player, v_invalid_player_slot
    FROM player_slots
   WHERE NOT (eligible_positions && allowed_positions)
   LIMIT 1;

  IF v_invalid_player IS NOT NULL THEN
    RAISE EXCEPTION '% is not eligible for %.', v_invalid_player, v_invalid_player_slot
      USING ERRCODE = 'P0001';
  END IF;

  WITH assignments AS (
    SELECT
      (a->>'player_id')::uuid AS player_id,
      (a->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_assignments) AS a
  )
  SELECT p.display_name
    INTO v_locked_player
    FROM weekly_lineups wl
    JOIN players p ON p.id = wl.player_id
   WHERE wl.member_id = p_member_id
     AND wl.league_id = p_league_id
     AND wl.league_season_id = p_league_season_id
     AND wl.game_date = p_game_date
     AND private.lineup_game_started(wl.player_id, wl.game_date)
     AND NOT EXISTS (
       SELECT 1
         FROM assignments a
        WHERE a.player_id = wl.player_id
          AND a.slot_type = wl.slot_type
     )
   LIMIT 1;

  IF v_locked_player IS NOT NULL THEN
    RAISE EXCEPTION 'Lineup changes are locked because %''s game has already started.', v_locked_player
      USING ERRCODE = 'P0001';
  END IF;

  WITH assignments AS (
    SELECT
      (a->>'player_id')::uuid AS player_id,
      (a->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_assignments) AS a
  )
  SELECT p.display_name
    INTO v_locked_player
    FROM assignments a
    JOIN players p ON p.id = a.player_id
    LEFT JOIN weekly_lineups wl
      ON wl.member_id = p_member_id
     AND wl.league_id = p_league_id
     AND wl.league_season_id = p_league_season_id
     AND wl.game_date = p_game_date
     AND wl.player_id = a.player_id
     AND wl.slot_type = a.slot_type
   WHERE a.slot_type <> 'BE'::roster_slot_type
     AND wl.id IS NULL
     AND private.lineup_game_started(a.player_id, p_game_date)
   LIMIT 1;

  IF v_locked_player IS NOT NULL THEN
    RAISE EXCEPTION 'Lineup changes are locked after %''s game has started.', v_locked_player
      USING ERRCODE = 'P0001';
  END IF;

  WITH assignments AS (
    SELECT (a->>'player_id')::uuid AS player_id, (a->>'slot_type')::text AS slot_type
    FROM jsonb_array_elements(p_assignments) a WHERE a->>'slot_type' <> 'BE'
  ), previous AS (
    SELECT player_id, slot_type::text FROM weekly_lineups WHERE member_id=p_member_id
      AND league_id=p_league_id AND league_season_id=p_league_season_id AND game_date=p_game_date
  ), changes AS (
    (SELECT * FROM assignments EXCEPT SELECT * FROM previous)
    UNION (SELECT * FROM previous EXCEPT SELECT * FROM assignments)
  )
  SELECT locked.reason INTO lock_reason FROM private.locked_assets(p_league_id,p_league_season_id,p_member_id) locked
    JOIN changes ON changes.player_id=locked.asset_id WHERE locked.asset_kind='player'
    ORDER BY locked.source_kind,locked.source_id LIMIT 1;
  IF lock_reason IS NOT NULL THEN RAISE EXCEPTION '%', lock_reason USING ERRCODE='PA004'; END IF;

  DELETE FROM weekly_lineups
   WHERE member_id = p_member_id
     AND league_id = p_league_id
     AND league_season_id = p_league_season_id
     AND game_date = p_game_date
     AND NOT private.lineup_game_started(player_id, game_date)
     AND NOT EXISTS (SELECT 1 FROM private.locked_assets(p_league_id,p_league_season_id,p_member_id) locked
       WHERE locked.asset_kind='player' AND locked.asset_id=weekly_lineups.player_id);

  INSERT INTO weekly_lineups (
    member_id,
    league_id,
    league_season_id,
    player_id,
    week_number,
    game_date,
    slot_type,
    is_auto_set,
    set_at
  )
  SELECT
    p_member_id,
    p_league_id,
    p_league_season_id,
    (a->>'player_id')::uuid,
    COALESCE((a->>'week_number')::int, 1),
    p_game_date,
    (a->>'slot_type')::roster_slot_type,
    COALESCE((a->>'is_auto_set')::boolean, true),
    now()
    FROM jsonb_array_elements(p_assignments) AS a
   WHERE a->>'player_id' IS NOT NULL
     AND a->>'slot_type' IS NOT NULL
     AND (a->>'slot_type')::roster_slot_type <> 'BE'::roster_slot_type
     AND NOT EXISTS (
       SELECT 1 FROM weekly_lineups wl
        WHERE wl.member_id = p_member_id
          AND wl.league_id = p_league_id
          AND wl.league_season_id = p_league_season_id
          AND wl.game_date = p_game_date
          AND wl.player_id = (a->>'player_id')::uuid
     );
END;
$function$;

-- Canonical SQL source for public.process_next_waiver_claim_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.process_next_waiver_claim_atomic(
  p_process_date date
)
RETURNS TABLE (
  processed boolean,
  claim_id uuid,
  member_id uuid,
  player_id uuid,
  status waiver_claim_status,
  failure_reason text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claim waiver_claims%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_waiver_log_id uuid;
  v_roster_size int;
  v_active_count int;
  v_projected_active_count int;
  v_drop_roster_id uuid;
  v_max_priority int;
  v_failure text;
  v_lock_player_id uuid;
  v_target_league_id uuid;
  v_target_season_id uuid;
  v_ineligible text;
  v_faab_balance int;
  v_player_name text;
  v_candidate record;
  v_to_ir boolean := false;
  v_ir_count int;
  v_ir_eligible boolean;
  v_ir_failure text;
  v_to_taxi boolean := false;
  v_taxi_failure text;
BEGIN
  FOR v_candidate IN
    WITH candidate_groups AS (
      SELECT
        candidate.league_id,
        candidate.league_season_id,
        candidate.player_id,
        min(candidate.process_date) AS process_date
        FROM waiver_claims AS candidate
        JOIN leagues AS claim_league
          ON claim_league.id = candidate.league_id
         AND claim_league.status IN ('active'::league_status, 'playoffs'::league_status, 'offseason'::league_status)
        JOIN league_seasons AS claim_season
          ON claim_season.id = candidate.league_season_id
         AND claim_season.is_current = true
       WHERE candidate.status = 'pending'
         AND candidate.process_date <= p_process_date
         AND (candidate.process_date + time '00:00') AT TIME ZONE coalesce(claim_league.timezone, 'America/Los_Angeles') <= now()
         AND NOT EXISTS (SELECT 1 FROM waiver_wire_log held WHERE held.league_id=candidate.league_id
           AND held.league_season_id=candidate.league_season_id AND held.player_id=candidate.player_id
           AND held.cleared_at IS NULL AND held.clears_at > (candidate.process_date + time '00:00') AT TIME ZONE coalesce(claim_league.timezone, 'America/Los_Angeles'))
       GROUP BY candidate.league_id, candidate.league_season_id, candidate.player_id
    ), league_candidates AS (
      SELECT DISTINCT ON (candidate_groups.league_id, candidate_groups.league_season_id)
        candidate_groups.*
        FROM candidate_groups
       ORDER BY candidate_groups.league_id, candidate_groups.league_season_id,
         candidate_groups.process_date, candidate_groups.player_id
    )
    SELECT league_candidates.league_id, league_candidates.league_season_id
      FROM league_candidates
     ORDER BY league_candidates.process_date, league_candidates.league_id,
       league_candidates.league_season_id, league_candidates.player_id
     LIMIT 128
  LOOP
    BEGIN
      IF NOT pg_try_advisory_xact_lock(hashtext(v_candidate.league_id::text), hashtext(v_candidate.league_season_id::text)) THEN
        CONTINUE;
      END IF;
      v_target_league_id := v_candidate.league_id;
      v_target_season_id := v_candidate.league_season_id;

      PERFORM 1
        FROM waiver_priorities AS wp_lock
       WHERE wp_lock.league_id = v_target_league_id
         AND wp_lock.league_season_id = v_target_season_id
       ORDER BY wp_lock.priority
       FOR UPDATE;

      SELECT wc.*
        INTO v_claim
        FROM waiver_claims AS wc
        JOIN waiver_priorities AS wp
          ON wp.league_id = wc.league_id
         AND wp.league_season_id = wc.league_season_id
         AND wp.member_id = wc.member_id
        JOIN leagues AS claim_league
          ON claim_league.id = wc.league_id
         AND claim_league.status IN ('active'::league_status, 'playoffs'::league_status, 'offseason'::league_status)
        JOIN league_seasons AS claim_season
          ON claim_season.id = wc.league_season_id
         AND claim_season.is_current = true
       WHERE wc.status = 'pending'
         AND wc.process_date <= p_process_date
         AND (wc.process_date + time '00:00') AT TIME ZONE coalesce(claim_league.timezone, 'America/Los_Angeles') <= now()
         AND NOT EXISTS (SELECT 1 FROM waiver_wire_log held WHERE held.league_id=wc.league_id
           AND held.league_season_id=wc.league_season_id AND held.player_id=wc.player_id
           AND held.cleared_at IS NULL AND held.clears_at > (wc.process_date + time '00:00') AT TIME ZONE coalesce(claim_league.timezone, 'America/Los_Angeles'))
         AND wc.league_id = v_target_league_id
         AND wc.league_season_id = v_target_season_id
       ORDER BY
         wc.process_date ASC,
         CASE WHEN claim_league.waiver_mode = 'faab' THEN wc.bid_amount END DESC NULLS LAST,
         wp.priority ASC,
         wc.claim_order ASC,
         wc.submitted_at ASC,
         wc.id ASC
       LIMIT 1;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Waiver candidate changed.' USING ERRCODE = 'PW001';
      END IF;

      -- Never wait for another team while an earlier batch item retains league rows.
      -- A busy head defers its whole league; lower-priority claims cannot pass it.
      IF NOT pg_try_advisory_xact_lock(hashtext(v_claim.league_id::text), hashtext(v_claim.member_id::text)) THEN
        RAISE EXCEPTION 'Waiver team is busy.' USING ERRCODE = 'PW001';
      END IF;

      -- A trade can clear the pending drop while we select the candidate.
      SELECT wc.* INTO v_claim FROM waiver_claims AS wc
       WHERE wc.id = v_claim.id AND wc.status = 'pending'
         AND wc.league_id = v_target_league_id AND wc.league_season_id = v_target_season_id
         AND wc.member_id = v_claim.member_id AND wc.player_id = v_claim.player_id
         AND wc.process_date <= p_process_date
         AND (wc.process_date + time '00:00') AT TIME ZONE coalesce((SELECT timezone FROM leagues WHERE id=wc.league_id), 'America/Los_Angeles') <= now()
         AND NOT EXISTS (SELECT 1 FROM waiver_wire_log held WHERE held.league_id=wc.league_id
           AND held.league_season_id=wc.league_season_id AND held.player_id=wc.player_id
           AND held.cleared_at IS NULL AND held.clears_at > (wc.process_date + time '00:00') AT TIME ZONE coalesce((SELECT timezone FROM leagues WHERE id=wc.league_id), 'America/Los_Angeles'))
       FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Waiver candidate changed.' USING ERRCODE = 'PW001';
      END IF;

      FOR v_lock_player_id IN
        SELECT DISTINCT pid
          FROM unnest(ARRAY[v_claim.player_id, v_claim.drop_player_id]::uuid[]) AS t(pid)
         WHERE pid IS NOT NULL
         ORDER BY pid ASC
      LOOP
        IF NOT pg_try_advisory_xact_lock(hashtext(v_claim.league_id::text), hashtext(v_lock_player_id::text)) THEN
          RAISE EXCEPTION 'Waiver player is busy.' USING ERRCODE = 'PW001';
        END IF;
      END LOOP;

      SELECT wwl.id
        INTO v_waiver_log_id
        FROM waiver_wire_log AS wwl
       WHERE wwl.league_id = v_claim.league_id
         AND wwl.league_season_id = v_claim.league_season_id
         AND wwl.player_id = v_claim.player_id
         AND wwl.cleared_at IS NULL
         AND wwl.clears_at <= now()
       ORDER BY wwl.clears_at
       LIMIT 1
       FOR UPDATE;

      SELECT *
        INTO v_league
        FROM leagues
       WHERE id = v_claim.league_id
       FOR UPDATE NOWAIT;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'League not found.'
          USING ERRCODE = 'P0002';
      END IF;

      IF v_league.status NOT IN ('active'::league_status, 'playoffs'::league_status, 'offseason'::league_status) THEN
        RAISE EXCEPTION 'Waivers require an active or playoff season.'
          USING ERRCODE = 'P0001';
      END IF;

      PERFORM 1
        FROM league_seasons AS season
       WHERE season.id = v_claim.league_season_id
         AND season.is_current = true
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Waivers require the current season.'
          USING ERRCODE = 'P0001';
      END IF;

      SELECT display_name
        INTO v_player_name
        FROM players
       WHERE id = v_claim.player_id;

      BEGIN
        PERFORM private.assert_weekly_add_available(v_claim.league_id, v_claim.league_season_id, v_claim.member_id);
      EXCEPTION
        WHEN SQLSTATE 'PA001' THEN
          RETURN QUERY SELECT * FROM private.fail_waiver_claim(
            v_claim.id,
            v_claim.league_id,
            v_claim.league_season_id,
            v_claim.member_id,
            v_claim.player_id,
            'failed_roster'::waiver_claim_status,
            SQLERRM,
            'waiver_claim_failed_add_limit',
            'Waiver claim failed',
            jsonb_build_object('bid_amount', v_claim.bid_amount)
          );
          RETURN;
      END;

      IF v_league.waiver_mode = 'faab' THEN
        v_faab_balance := private.available_faab_balance(v_claim.league_id, v_claim.league_season_id, v_claim.member_id);
        IF v_faab_balance < v_claim.bid_amount THEN
          v_failure := 'Insufficient FAAB budget for this bid.';
          RETURN QUERY SELECT * FROM private.fail_waiver_claim(
            v_claim.id,
            v_claim.league_id,
            v_claim.league_season_id,
            v_claim.member_id,
            v_claim.player_id,
            'failed_priority'::waiver_claim_status,
            v_failure,
            'faab_bid_failed',
            'FAAB bid failed',
            jsonb_build_object('bid_amount', v_claim.bid_amount)
          );
          RETURN;
        END IF;
      END IF;

      IF EXISTS (
        SELECT 1
          FROM roster_players AS rp
         WHERE rp.league_id = v_claim.league_id
           AND rp.league_season_id = v_claim.league_season_id
           AND rp.player_id = v_claim.player_id
         FOR UPDATE
      ) THEN
        v_failure := 'Player already on a roster.';
        RETURN QUERY SELECT * FROM private.fail_waiver_claim(
          v_claim.id,
          v_claim.league_id,
          v_claim.league_season_id,
          v_claim.member_id,
          v_claim.player_id,
          'failed_priority'::waiver_claim_status,
          v_failure
        );
        RETURN;
      END IF;

      v_roster_size := v_league.roster_size;

      SELECT string_agg(problem.message,' ' ORDER BY problem.kind,problem.player_name,problem.roster_player_id)
        INTO v_ineligible FROM private.roster_problems(v_claim.league_id,v_claim.league_season_id,v_claim.member_id) problem;
      IF v_ineligible IS NOT NULL THEN
        RETURN QUERY SELECT * FROM private.fail_waiver_claim(
          v_claim.id,v_claim.league_id,v_claim.league_season_id,v_claim.member_id,v_claim.player_id,
          'failed_roster'::waiver_claim_status,v_ineligible
        );
        RETURN;
      END IF;

      v_to_ir := false;
      IF v_claim.to_ir THEN
        SELECT private.is_ir_designation(injury_status) INTO v_ir_eligible
          FROM players WHERE id = v_claim.player_id FOR SHARE;
        SELECT count(*) INTO v_ir_count FROM roster_players AS ir_roster
         WHERE ir_roster.member_id = v_claim.member_id AND ir_roster.league_season_id = v_claim.league_season_id AND ir_roster.is_on_ir;
        v_ir_failure := CASE
          WHEN NOT COALESCE(v_ir_eligible, false) THEN 'Player is no longer IR eligible.'
          WHEN v_ir_count >= COALESCE(v_league.ir_slots, 2) THEN 'Your IR slots are full.'
          WHEN v_league.status = 'offseason'::league_status THEN 'IR moves are unavailable in the offseason.'
          ELSE NULL
        END;
        v_to_ir := v_ir_failure IS NULL;
      END IF;

      v_to_taxi := false;
      v_taxi_failure := NULL;
      IF v_claim.to_taxi THEN
        BEGIN
          PERFORM private.authorize_taxi_acquisition(v_claim.league_id,v_claim.league_season_id,v_claim.member_id,v_claim.player_id,'waiver',v_claim.id);
          PERFORM private.assert_taxi_acquisition_allowed(v_claim.league_id,v_claim.league_season_id,v_claim.member_id,v_claim.player_id);
          v_to_taxi := true;
        EXCEPTION WHEN SQLSTATE 'P0001' THEN
          v_taxi_failure := SQLERRM;
        END;
      END IF;

      SELECT count(*)
        INTO v_active_count
        FROM roster_players AS rp
       WHERE rp.league_id = v_claim.league_id
         AND rp.league_season_id = v_claim.league_season_id
         AND rp.member_id = v_claim.member_id
         AND rp.is_on_ir = false
         AND rp.is_on_taxi = false;

      v_projected_active_count := v_active_count + CASE WHEN v_to_ir OR v_to_taxi THEN 0 ELSE 1 END - CASE WHEN v_claim.drop_player_id IS NULL OR v_to_ir OR v_to_taxi THEN 0 ELSE 1 END;

      IF NOT v_to_ir AND NOT v_to_taxi AND v_projected_active_count > COALESCE(v_roster_size, 20) THEN
        v_failure := CASE
          WHEN v_claim.to_ir THEN v_ir_failure || ' Your active roster is full.'
          WHEN v_claim.to_taxi THEN v_taxi_failure || ' Your active roster is full.'
          WHEN v_claim.drop_player_id IS NULL THEN 'Roster full and no drop player specified.'
          ELSE 'Waiver claim would leave your active roster over the limit.'
        END;
        RETURN QUERY SELECT * FROM private.fail_waiver_claim(
          v_claim.id,
          v_claim.league_id,
          v_claim.league_season_id,
          v_claim.member_id,
          v_claim.player_id,
          'failed_roster'::waiver_claim_status,
          v_failure
        );
        RETURN;
      END IF;

      IF v_claim.drop_player_id IS NOT NULL AND NOT v_to_ir AND NOT v_to_taxi THEN
        SELECT validation.roster_player_id, validation.failure_reason
          INTO v_drop_roster_id, v_failure
          FROM private.validate_waiver_claim_drop_player(
            v_claim.league_id,
            v_claim.league_season_id,
            v_claim.member_id,
            v_claim.drop_player_id,
            'Drop player is no longer on this active roster.'
          ) AS validation;

        IF v_failure IS NOT NULL THEN
          RETURN QUERY SELECT * FROM private.fail_waiver_claim(
            v_claim.id,
            v_claim.league_id,
            v_claim.league_season_id,
            v_claim.member_id,
            v_claim.player_id,
            'failed_roster'::waiver_claim_status,
            v_failure
          );
          RETURN;
        END IF;
      END IF;

      -- Mark the claim before the drop is released: the roster-lifecycle trigger
      -- clears stale drop selections on pending claims, and this claim's recorded
      -- drop must survive as history.
      UPDATE waiver_claims
         SET status = 'succeeded',
             processed_at = now(),
             failure_reason = NULL
       WHERE id = v_claim.id;

      IF v_drop_roster_id IS NOT NULL THEN
        UPDATE waiver_claims AS sibling SET status='cancelled', processed_at=now(),
          failure_reason='The selected drop player was used by another successful waiver claim.'
          WHERE sibling.league_id=v_claim.league_id AND sibling.league_season_id=v_claim.league_season_id
            AND sibling.member_id=v_claim.member_id AND sibling.status='pending' AND sibling.drop_player_id=v_claim.drop_player_id;
        PERFORM private.release_roster_player_to_waivers(
          v_drop_roster_id,
          v_claim.league_id,
          v_claim.league_season_id,
          v_claim.member_id,
          v_claim.drop_player_id,
          'waiver_drop',
          v_claim.id
        );
      END IF;

      INSERT INTO roster_players (
        league_id,
        league_season_id,
        member_id,
        player_id,
        acquired_via,
        is_on_ir,
        is_on_taxi
      )
      VALUES (
        v_claim.league_id,
        v_claim.league_season_id,
        v_claim.member_id,
        v_claim.player_id,
        'waiver',
        v_to_ir,
        v_to_taxi
      );

      PERFORM private.assert_accepted_trade_capacity(v_claim.league_id,v_claim.league_season_id,v_claim.member_id);
      IF v_to_taxi THEN
        UPDATE public.notification_outbox SET body='Your waiver claim succeeded. Placed on taxi.',
          data=data || jsonb_build_object('destination','taxi','body','Your waiver claim succeeded. Placed on taxi.')
        WHERE dedupe_key='waiver_claim_won:' || v_claim.id::text || ':' || v_claim.member_id::text;
      END IF;

      INSERT INTO roster_transactions (
        league_id,
        league_season_id,
        member_id,
        player_id,
        transaction_type,
        related_claim_id,
        acquired_to_taxi
      )
      VALUES (
        v_claim.league_id,
        v_claim.league_season_id,
        v_claim.member_id,
        v_claim.player_id,
        'waiver_add',
        v_claim.id,
        v_to_taxi
      );

      UPDATE waiver_wire_log
         SET cleared_at = now(),
             claimed_by_claim_id = v_claim.id
       WHERE id = v_waiver_log_id;

      IF v_league.waiver_mode = 'faab' THEN
        UPDATE faab_balances AS balance_row
           SET balance = balance_row.balance - v_claim.bid_amount,
               updated_at = now()
         WHERE balance_row.league_id = v_claim.league_id
           AND balance_row.league_season_id = v_claim.league_season_id
           AND balance_row.member_id = v_claim.member_id;
      END IF;

      PERFORM private.consume_weekly_add(v_claim.league_id, v_claim.league_season_id, v_claim.member_id);

      SELECT max(wp.priority)
        INTO v_max_priority
        FROM waiver_priorities AS wp
       WHERE wp.league_id = v_claim.league_id
         AND wp.league_season_id = v_claim.league_season_id;

      UPDATE waiver_priorities AS priority_row
         SET priority = COALESCE(v_max_priority, 0) + 1
       WHERE priority_row.league_id = v_claim.league_id
         AND priority_row.league_season_id = v_claim.league_season_id
         AND priority_row.member_id = v_claim.member_id;

      PERFORM private.log_league_activity(
        v_claim.league_id,
        v_claim.league_season_id,
        CASE WHEN v_league.waiver_mode = 'faab' THEN 'faab_bid_won' ELSE 'waiver_claim_succeeded' END,
        CASE WHEN v_league.waiver_mode = 'faab' THEN 'FAAB bid won' ELSE 'Waiver claim succeeded' END,
        COALESCE(v_player_name, 'Player') || CASE
          WHEN v_league.waiver_mode = 'faab' THEN format(' won for $%s.', v_claim.bid_amount)
          ELSE ' added from waivers.'
        END || CASE WHEN v_to_taxi THEN ' Placed on taxi.' ELSE '' END,
        NULL,
        v_claim.member_id,
        v_claim.player_id,
        NULL,
        v_claim.id,
        jsonb_build_object('bid_amount', v_claim.bid_amount, 'waiver_mode', v_league.waiver_mode)
      );

      RETURN QUERY
        SELECT true, v_claim.id, v_claim.member_id, v_claim.player_id, 'succeeded'::waiver_claim_status, NULL::text;

      RETURN QUERY
      WITH failed AS (
        UPDATE waiver_claims AS wc_other
           SET status = 'failed_priority',
               processed_at = now(),
               failure_reason = CASE
                 WHEN v_league.waiver_mode = 'faab' THEN 'Claimed by a higher FAAB bid or tiebreaker.'
                 ELSE 'Claimed by higher-priority team.'
               END
         WHERE wc_other.status = 'pending'
           AND wc_other.league_id = v_claim.league_id
           AND wc_other.league_season_id = v_claim.league_season_id
           AND wc_other.player_id = v_claim.player_id
           AND wc_other.id <> v_claim.id
         RETURNING wc_other.id, wc_other.member_id, wc_other.player_id, wc_other.status, wc_other.failure_reason, wc_other.bid_amount
      ),
      logged AS (
        INSERT INTO league_activity (
          league_id,
          league_season_id,
          target_member_id,
          related_player_id,
          related_claim_id,
          event_type,
          title,
          body,
          metadata
        )
        SELECT
          v_claim.league_id,
          v_claim.league_season_id,
          failed.member_id,
          failed.player_id,
          failed.id,
          CASE WHEN v_league.waiver_mode = 'faab' THEN 'faab_bid_lost' ELSE 'waiver_claim_failed_priority' END,
          CASE WHEN v_league.waiver_mode = 'faab' THEN 'FAAB bid lost' ELSE 'Waiver claim failed' END,
          failed.failure_reason,
          jsonb_build_object('bid_amount', failed.bid_amount, 'winning_bid_amount', v_claim.bid_amount)
        FROM failed
        RETURNING id
      )
      SELECT true, failed.id, failed.member_id, failed.player_id, failed.status, failed.failure_reason
        FROM failed;
      RETURN;
    EXCEPTION WHEN SQLSTATE 'PA008' OR SQLSTATE 'PT001' THEN
      RETURN QUERY SELECT * FROM private.fail_waiver_claim(
        v_claim.id,
        v_claim.league_id,
        v_claim.league_season_id,
        v_claim.member_id,
        v_claim.player_id,
        'failed_roster'::waiver_claim_status,
        SQLERRM
      );
      RETURN;
    WHEN SQLSTATE 'PW001' OR lock_not_available THEN
      -- Release this attempt when its team, player, or league is busy.
      -- A batch can already hold a different league in the opposite order.
      CONTINUE;
    END;
  END LOOP;
END;
$$;

-- Canonical SQL source for public.toggle_ir_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
  PERFORM private.assert_asset_unlocked(roster.league_id,roster.league_season_id,roster.member_id,roster.player_id)
    FROM roster_players roster JOIN league_members member ON member.id=roster.member_id
    WHERE roster.id=p_roster_player_id AND member.user_id=p_user_id;
  PERFORM private.toggle_ir_for_activation(p_roster_player_id,p_to_ir,p_user_id,NULL);
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
END;
$$;

-- Canonical SQL source for public.toggle_taxi_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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

  PERFORM private.assert_asset_unlocked(v_rp.league_id,v_rp.league_season_id,v_rp.member_id,v_rp.player_id);

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

CREATE OR REPLACE FUNCTION public.view_claims(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE context jsonb; claims jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  WITH selected AS (
    (SELECT claim.* FROM public.waiver_claims claim WHERE claim.league_id = p_league_id AND claim.member_id = p_member_id
      AND claim.league_season_id = (context->>'seasonId')::uuid AND claim.status = 'pending'
      ORDER BY claim.claim_order, claim.submitted_at)
    UNION ALL
    (SELECT claim.* FROM public.waiver_claims claim WHERE claim.league_id = p_league_id AND claim.member_id = p_member_id
      AND claim.league_season_id = (context->>'seasonId')::uuid AND claim.status IN ('succeeded', 'failed_priority', 'failed_roster')
      ORDER BY claim.submitted_at DESC LIMIT 20)
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('assetLocks', COALESCE((SELECT jsonb_agg(jsonb_build_object('assetKind', locked.asset_kind, 'assetId', locked.asset_id, 'sourceKind', locked.source_kind, 'sourceId', locked.source_id, 'reason', locked.reason)) FROM private.locked_assets(p_league_id, (context->>'seasonId')::uuid, p_member_id) locked WHERE locked.source_kind='claim' AND locked.source_id=claim.id), '[]'), 'id', claim.id, 'playerId', claim.player_id,
    'clearsAt', CASE WHEN claim.status = 'pending' THEN (SELECT max(log.clears_at) FROM public.waiver_wire_log log
      WHERE log.player_id = claim.player_id AND log.league_id = p_league_id AND log.league_season_id = claim.league_season_id AND log.cleared_at IS NULL AND log.clears_at > now()) END,
    'playerName', COALESCE(player.display_name, 'Unknown'), 'playerNbaId', player.nba_id,
    'dropPlayerId', claim.drop_player_id, 'dropPlayerName', dropped.display_name, 'dropPlayerNbaId', dropped.nba_id,
    'status', claim.status, 'submittedAt', claim.submitted_at, 'processDate', claim.process_date,
    'priorityAtSubmission', claim.priority_at_submission, 'bidAmount', claim.bid_amount, 'claimOrder', claim.claim_order,
    'toIr', claim.to_ir, 'toTaxi', claim.to_taxi, 'playerTeam', player.nba_team, 'playerPosition', player.position,
    'playerInjuryStatus', player.injury_status, 'playerYearsExp', player.years_exp,
    'playerCareerGames', player.career_regular_season_games, 'failureReason', claim.failure_reason)
    ORDER BY claim.status <> 'pending', CASE WHEN claim.status = 'pending' THEN claim.claim_order END,
      CASE WHEN claim.status = 'pending' THEN claim.submitted_at END, claim.submitted_at DESC, claim.id), '[]')
  INTO claims FROM selected claim LEFT JOIN public.players player ON player.id = claim.player_id
    LEFT JOIN public.players dropped ON dropped.id = claim.drop_player_id
  WHERE (context->'season'->>'is_current')::boolean;
  RETURN jsonb_build_object('context', context, 'claims', claims);
END;
$$;

CREATE OR REPLACE FUNCTION public.view_lineup(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE asset_locks jsonb; context jsonb; target uuid := COALESCE((p_params->>'targetMemberId')::uuid, p_member_id);
  selected date; today date; starters jsonb; bench jsonb; ir jsonb; taxi jsonb; days jsonb; game_day jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('assetKind',asset_kind,'assetId',asset_id,
    'sourceKind',source_kind,'sourceId',source_id,'reason',reason) ORDER BY source_kind,source_id), '[]'::jsonb)
    INTO asset_locks FROM private.locked_assets(p_league_id,(context->>'seasonId')::uuid,p_member_id)
    WHERE target=p_member_id;
  context := context || jsonb_build_object('weekNumber', COALESCE((context->>'weekNumber')::integer, 1));
  IF NOT EXISTS (SELECT 1 FROM public.league_members WHERE id = target AND league_id = p_league_id) THEN
    RAISE EXCEPTION 'This lineup is not available.' USING ERRCODE = '42501'; END IF;
  today := (context->>'today')::date;
  selected := COALESCE((p_params->>'date')::date, today);
  WITH assignments AS MATERIALIZED (
    SELECT player_id, slot_type FROM public.weekly_lineups WHERE member_id = target AND league_id = p_league_id
      AND league_season_id = (context->>'seasonId')::uuid AND game_date = selected
  ), roster AS MATERIALIZED (
    SELECT * FROM public.roster_players WHERE member_id = target AND league_id = p_league_id AND league_season_id = (context->>'seasonId')::uuid
  ), players AS MATERIALIZED (
    SELECT p.id, r.is_on_ir, r.is_on_taxi, r.id AS roster_id, jsonb_build_object('rosterPlayerId', COALESCE(r.id::text, ''),
      'assetLocks', COALESCE((SELECT jsonb_agg(lock) FROM jsonb_array_elements(asset_locks) lock WHERE lock->>'assetKind'='player' AND lock->>'assetId'=p.id::text),'[]'), 'playerId', p.id, 'displayName', COALESCE(p.display_name, ''), 'position', p.position,
      'eligiblePositions', CASE WHEN cardinality(p.eligible_positions) > 0 THEN to_jsonb(p.eligible_positions)
        WHEN p.position IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(p.position) END,
      'nbaTeam', p.nba_team, 'yearsExp', p.years_exp, 'careerGames', p.career_regular_season_games,
      'injuryStatus', p.injury_status, 'nbaId', p.nba_id) AS data
    FROM public.players p LEFT JOIN roster r ON r.player_id = p.id
    WHERE r.id IS NOT NULL OR EXISTS (SELECT 1 FROM assignments a WHERE a.player_id = p.id)
  ), placed AS MATERIALIZED (
    SELECT a.*, row_number() OVER (PARTITION BY a.slot_type ORDER BY a.player_id) AS slot_number
    FROM assignments a LEFT JOIN roster r ON r.player_id = a.player_id
    WHERE a.slot_type NOT IN ('BE', 'IR') AND (selected <= today OR NOT COALESCE(r.is_on_ir OR r.is_on_taxi, false))
  ), occupied AS MATERIALIZED (
    SELECT t.slot_type, sequence.number, player.data, player.id FROM public.lineup_slot_templates t
      CROSS JOIN LATERAL generate_series(1, t.slot_count) sequence(number)
      LEFT JOIN placed a ON a.slot_type = t.slot_type AND a.slot_number = sequence.number
      LEFT JOIN players player ON player.id = a.player_id
    WHERE t.league_id = p_league_id AND t.slot_type NOT IN ('BE', 'IR')
  )
  SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object('slotType', slot_type, 'player', data) ORDER BY slot_type, number) FROM occupied), '[]'),
    COALESCE(jsonb_agg(p.data ORDER BY p.id) FILTER (WHERE p.roster_id IS NOT NULL AND NOT p.is_on_ir AND NOT p.is_on_taxi
      AND NOT EXISTS (SELECT 1 FROM occupied o WHERE o.id = p.id)
      AND NOT (selected < today AND EXISTS (SELECT 1 FROM public.roster_transactions transaction
        WHERE transaction.member_id = target AND transaction.league_id = p_league_id AND transaction.league_season_id = (context->>'seasonId')::uuid
          AND transaction.player_id = p.id AND transaction.transaction_type IN ('fa_add', 'waiver_add', 'trade_in', 'draft_won', 'carry_over')
          AND transaction.occurred_at > ((selected + 1)::timestamp AT TIME ZONE 'America/New_York') - interval '1 millisecond'))), '[]'),
    COALESCE(jsonb_agg(p.data ORDER BY p.id) FILTER (WHERE p.is_on_ir AND NOT EXISTS (SELECT 1 FROM occupied o WHERE o.id = p.id)), '[]'),
    COALESCE(jsonb_agg(p.data ORDER BY p.id) FILTER (WHERE p.is_on_taxi AND NOT EXISTS (SELECT 1 FROM occupied o WHERE o.id = p.id)), '[]')
  INTO starters, bench, ir, taxi FROM players p;
  WITH dates AS (
    SELECT generate_series(CASE WHEN week.week_number = 1 THEN date_trunc('week', week.week_start::timestamp)::date ELSE week.week_start END,
      week.week_end, interval '1 day')::date AS day FROM public.season_weeks week
      WHERE week.season_year = (context->>'seasonYear')::integer AND week.week_number = (context->>'weekNumber')::integer
    UNION
    SELECT DISTINCT game.game_date FROM public.nba_games game
      WHERE game.season_year = (context->>'seasonYear')::integer AND game.week_number = (context->>'weekNumber')::integer
        AND NOT EXISTS (SELECT 1 FROM public.season_weeks week WHERE week.season_year = (context->>'seasonYear')::integer
          AND week.week_number = (context->>'weekNumber')::integer)
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('date', day, 'dayLabel', substring('SMTWTFS', extract(dow FROM day)::integer + 1, 1),
    'dateNum', extract(day FROM day), 'isToday', day = (now() AT TIME ZONE COALESCE(context->'league'->>'timezone', 'America/Los_Angeles'))::date,
    'hasGames', EXISTS (SELECT 1 FROM public.nba_games g WHERE g.season_year = (context->>'seasonYear')::integer AND g.game_date = day),
    'playingTeams', COALESCE((SELECT jsonb_agg(team ORDER BY game_id, side) FROM (
      SELECT g.id AS game_id, 0 AS side, g.home_team AS team FROM public.nba_games g WHERE g.game_date = day AND g.season_year = (context->>'seasonYear')::integer
      UNION ALL SELECT g.id, 1, g.away_team FROM public.nba_games g WHERE g.game_date = day AND g.season_year = (context->>'seasonYear')::integer
    ) teams), '[]')) ORDER BY day), '[]') INTO days FROM dates;
  game_day := public.view_game_day(p_league_id, p_member_id, p_params || jsonb_build_object('date', selected, 'playerIds',
    COALESCE((SELECT jsonb_agg(DISTINCT id) FROM (
      SELECT item->'player'->>'playerId' AS id FROM jsonb_array_elements(starters) item
      UNION SELECT item->>'playerId' FROM jsonb_array_elements(bench || ir || taxi) item) ids WHERE id IS NOT NULL), '[]')));
  RETURN jsonb_build_object('lockedAssets', asset_locks, 'context', context, 'date', selected, 'starters', starters, 'bench', bench, 'ir', ir, 'taxi', taxi,
    'benchSlots', COALESCE((SELECT slot_count FROM public.lineup_slot_templates WHERE league_id = p_league_id AND slot_type = 'BE'), 0),
    'weekDays', days, 'games', game_day->'games', 'startedTeams', game_day->'startedTeams', 'teamMatchups', game_day->'teamMatchups', 'liveStats', game_day->'liveStats',
    'optimizer', (SELECT to_jsonb(settings) FROM public.lineup_optimizer_settings settings
      WHERE settings.member_id = p_member_id AND settings.league_season_id = (context->>'seasonId')::uuid));
END;
$$;

CREATE OR REPLACE FUNCTION public.view_roster(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE asset_locks jsonb; context jsonb; roster jsonb; averages jsonb; stats jsonb; slots jsonb; assignments jsonb;
  target uuid := COALESCE((p_params->>'targetMemberId')::uuid, p_member_id); transaction_state jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('assetKind',asset_kind,'assetId',asset_id,
    'sourceKind',source_kind,'sourceId',source_id,'reason',reason) ORDER BY source_kind,source_id), '[]'::jsonb)
    INTO asset_locks FROM private.locked_assets(p_league_id,(context->>'seasonId')::uuid,p_member_id)
    WHERE target=p_member_id;
  IF NOT EXISTS (SELECT 1 FROM public.league_members WHERE id = target AND league_id = p_league_id) THEN
    RAISE EXCEPTION 'This roster is not available.' USING ERRCODE = '42501'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('assetLocks', COALESCE((SELECT jsonb_agg(lock) FROM jsonb_array_elements(asset_locks) lock WHERE lock->>'assetKind'='player' AND lock->>'assetId'=p.id::text),'[]'), 'id', r.id, 'is_on_ir', r.is_on_ir, 'is_on_taxi', r.is_on_taxi,
    'taxi_start_season_year', r.taxi_start_season_year, 'acquired_via', r.acquired_via, 'players', jsonb_build_object(
      'id', p.id, 'display_name', p.display_name, 'nba_team', p.nba_team, 'position', p.position,
      'eligible_positions', p.eligible_positions, 'injury_status', p.injury_status, 'nba_id', p.nba_id,
      'nba_draft_number', p.nba_draft_number, 'birthdate', p.birthdate, 'years_exp', p.years_exp, 'career_regular_season_games', p.career_regular_season_games))
      ORDER BY r.is_on_taxi, r.is_on_ir), '[]'),
    COALESCE(jsonb_object_agg(p.id::text, COALESCE(average.avg_fantasy_points, source_fantasy.avg_fantasy_points))
      FILTER (WHERE COALESCE(average.avg_fantasy_points, source_fantasy.avg_fantasy_points) IS NOT NULL), '{}'),
    COALESCE(jsonb_object_agg(p.id::text, COALESCE(average.averages, to_jsonb(source_average)))
      FILTER (WHERE COALESCE(average.averages, to_jsonb(source_average)) IS NOT NULL), '{}')
  INTO roster, averages, stats FROM public.roster_players r JOIN public.players p ON p.id = r.player_id
    LEFT JOIN public.player_season_averages average ON average.league_id = p_league_id AND average.player_id = p.id
      AND average.season_year = COALESCE((p_params->>'seasonYear')::integer, public.current_season_year_et())
    LEFT JOIN public.mv_player_season_averages source_average ON average.player_id IS NULL AND source_average.player_id = p.id
      AND source_average.season_year = COALESCE((p_params->>'seasonYear')::integer, public.current_season_year_et())
    LEFT JOIN public.v_player_avg_fantasy_points source_fantasy ON average.player_id IS NULL AND source_fantasy.league_id = p_league_id
      AND source_fantasy.player_id = p.id AND source_fantasy.season_year = COALESCE((p_params->>'seasonYear')::integer, public.current_season_year_et())
  WHERE r.member_id = target AND r.league_id = p_league_id AND r.league_season_id = (context->>'seasonId')::uuid;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('slotType', slot_type, 'slotCount', slot_count)), '[]') INTO slots
    FROM public.lineup_slot_templates WHERE league_id = p_league_id;
  SELECT COALESCE(jsonb_object_agg(player_id::text, slot_type), '{}') INTO assignments FROM public.weekly_lineups
    WHERE league_id = p_league_id AND member_id = target AND league_season_id = (context->>'seasonId')::uuid
      AND game_date = COALESCE((p_params->>'date')::date, (context->>'today')::date);
  transaction_state := public.view_transaction_state(p_league_id, p_member_id, p_params);
  RETURN jsonb_build_object('lockedAssets', asset_locks, 'context', context, 'roster', roster,
    'picks', COALESCE((SELECT jsonb_agg(jsonb_build_object('assetLocks', COALESCE((SELECT jsonb_agg(lock) FROM jsonb_array_elements(asset_locks) lock WHERE lock->>'assetKind'='pick' AND lock->>'assetId'=pick->>'id'),'[]'), 'kind', 'pick', 'pickId', pick->'id', 'seasonYear', pick->'seasonYear',
      'round', pick->'round', 'originalTeamName', pick->'originalTeamName')) FROM jsonb_array_elements(
      public.view_picks(p_league_id, p_member_id, p_params || jsonb_build_object('targetMemberId', target))->'picks') pick), '[]'),
    'claims', public.view_claims(p_league_id, p_member_id, p_params)->'claims', 'avgMap', averages, 'avgStatsMap', stats,
    'waiverPriority', (SELECT priority FROM public.waiver_priorities WHERE member_id = p_member_id AND league_season_id = (context->>'seasonId')::uuid),
    'faabBalance', CASE WHEN context->'league'->>'waiver_mode' = 'faab' THEN transaction_state->'faabBalance' END, 'transactionState', transaction_state,
    'slotPlan', jsonb_build_object('slots', slots, 'assignments', assignments),
    'taxiExitPlayerIds', COALESCE((SELECT jsonb_agg(player_id ORDER BY player_id) FROM public.league_member_taxi_exits
      WHERE member_id = target AND league_id = p_league_id), '[]'));
END;
$$;

REVOKE ALL ON FUNCTION private.assert_asset_unlocked(uuid,uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.locked_assets(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.prevent_locked_lineup_change() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS prevent_accepted_or_inactive_roster_move ON public.roster_players;
DROP TRIGGER IF EXISTS a_pending_asset_roster_move ON public.roster_players;
CREATE TRIGGER a_pending_asset_roster_move BEFORE UPDATE OF league_id,league_season_id,member_id,player_id,is_on_ir,is_on_taxi ON public.roster_players
FOR EACH ROW EXECUTE FUNCTION private.prevent_accepted_or_inactive_roster_move();
DROP TRIGGER IF EXISTS prevent_reserved_pick_delete ON public.draft_picks;
CREATE TRIGGER prevent_reserved_pick_delete BEFORE DELETE ON public.draft_picks
FOR EACH ROW EXECUTE FUNCTION private.prevent_accepted_trade_pick_change();
DROP TRIGGER IF EXISTS prevent_locked_lineup_change ON public.weekly_lineups;
CREATE TRIGGER prevent_locked_lineup_change BEFORE INSERT OR UPDATE OR DELETE ON public.weekly_lineups
FOR EACH ROW EXECUTE FUNCTION private.prevent_locked_lineup_change();
REVOKE ALL ON FUNCTION private.publish_asset_lock_change() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS publish_asset_lock_change ON public.trades;
CREATE TRIGGER publish_asset_lock_change AFTER INSERT OR DELETE OR UPDATE OF status ON public.trades
FOR EACH ROW EXECUTE FUNCTION private.publish_asset_lock_change();
DROP TRIGGER IF EXISTS publish_asset_lock_change ON public.trade_items;
CREATE TRIGGER publish_asset_lock_change AFTER INSERT OR UPDATE OR DELETE ON public.trade_items
FOR EACH ROW EXECUTE FUNCTION private.publish_asset_lock_change();
DROP TRIGGER IF EXISTS publish_asset_lock_change ON public.trade_participants;
CREATE TRIGGER publish_asset_lock_change AFTER INSERT OR DELETE OR UPDATE OF accepted_at,drop_player_ids,roster_moves ON public.trade_participants
FOR EACH ROW EXECUTE FUNCTION private.publish_asset_lock_change();
DROP TRIGGER IF EXISTS publish_asset_lock_change ON public.waiver_claims;
CREATE TRIGGER publish_asset_lock_change AFTER INSERT OR DELETE OR UPDATE OF status,player_id,drop_player_id ON public.waiver_claims
FOR EACH ROW EXECUTE FUNCTION private.publish_asset_lock_change();
SELECT private.league_version_enqueue(league_id,'trade','locked_assets') FROM (
  SELECT league_id FROM public.trades WHERE status IN ('pending','accepted')
  UNION SELECT league_id FROM public.waiver_claims WHERE status='pending'
) affected;
CREATE OR REPLACE FUNCTION public.view_claim_editor(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; roster jsonb; support jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  IF p_params->>'playerId' IS NULL THEN RAISE EXCEPTION 'Player not found.' USING ERRCODE = 'P0002'; END IF;
  roster := public.view_roster(p_league_id, p_member_id, p_params - 'targetMemberId');
  SELECT jsonb_set(roster, '{roster}', COALESCE(jsonb_agg(row_data || jsonb_build_object('assetLocks',
    COALESCE((SELECT jsonb_agg(lock) FROM jsonb_array_elements(row_data->'assetLocks') lock
      WHERE lock->>'sourceKind'<>'claim' OR lock->>'sourceId' IS DISTINCT FROM p_params->>'claimId'), '[]'::jsonb))), '[]'::jsonb))
    INTO roster FROM jsonb_array_elements(roster->'roster') row_data;
  support := public.view_players(p_league_id, p_member_id, p_params || jsonb_build_object('includePlayerIds',
    jsonb_build_array(p_params->>'playerId'), 'limit', 1));
  RETURN jsonb_build_object('context', context, 'player', (public.view_player(p_league_id, p_member_id, p_params)->'player'), 'roster', roster->'roster',
    'claims', roster->'claims', 'transactionState', roster->'transactionState', 'waiverPriority', roster->'waiverPriority',
    'waiverClearsAt', support->'waiverClearsAt', 'ownedMap', support->'ownedMap', 'slotPlan', roster->'slotPlan',
    'priority', roster->'waiverPriority', 'clearsAt', support->'waiverClearsAt'->(p_params->>'playerId'),
    'taxiExitIds', roster->'taxiExitPlayerIds', 'members', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', member.id, 'user_id', member.user_id, 'team_name', member.team_name, 'role', member.role))
      FROM public.league_members member WHERE member.league_id = p_league_id), '[]'));
END;
$$;

COMMIT;
