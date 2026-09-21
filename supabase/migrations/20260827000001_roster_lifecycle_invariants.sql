-- Roster lifecycle invariants.
--
-- One trigger on roster_players now owns every piece of roster-linked state that
-- must react when a player leaves a roster (drop, waiver drop, trade, merge,
-- reset, commissioner or service-role delete) or becomes inactive (IR, taxi):
--   * trade_block_items for that member/player are removed,
--   * future unlocked weekly_lineups are cleared,
--   * pending waiver claims lose a drop selection that is no longer rosterable,
--   * pending trades offering the lost asset expire with a recorded reason.
-- A sibling trigger on draft_picks does the same for pick listings and pick
-- offers when a pick changes owner or is used in a draft.
-- The explicit, scattered cleanup calls in the drop/waiver/trade/IR/taxi RPCs are
-- removed; the waiver processor marks a claim succeeded before releasing its drop
-- so the succeeded claim keeps its drop player as history.
-- Existing stale rows are backfilled at the end of this migration.


-- New helpers -------------------------------------------------------------

CREATE OR REPLACE FUNCTION private.expire_pending_trades_for_lost_asset(
  p_league_id uuid,
  p_member_id uuid,
  p_player_id uuid DEFAULT NULL,
  p_pick_id uuid DEFAULT NULL,
  p_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reason text := NULLIF(BTRIM(COALESCE(p_reason, '')), '');
  v_team text;
BEGIN
  IF p_player_id IS NULL AND p_pick_id IS NULL THEN
    RETURN;
  END IF;

  IF v_reason IS NULL THEN
    SELECT member.team_name
      INTO v_team
      FROM league_members AS member
     WHERE member.id = p_member_id;

    IF p_player_id IS NOT NULL THEN
      SELECT format('%s is no longer on %s.', COALESCE(player.display_name, 'A player'), COALESCE(v_team, 'the offering roster'))
        INTO v_reason
        FROM players AS player
       WHERE player.id = p_player_id;
    ELSE
      SELECT format('The %s round %s pick is no longer owned by %s.', pick.season_year, pick.round, COALESCE(v_team, 'the offering team'))
        INTO v_reason
        FROM draft_picks AS pick
       WHERE pick.id = p_pick_id;
    END IF;

    v_reason := COALESCE(v_reason, 'A trade asset is no longer available.');
  END IF;

  -- This runs inside the caller's transaction, which may belong to an
  -- authenticated user; the status guard trusts this flag for the update only.
  PERFORM set_config('app.trade_lifecycle_server_write', 'on', true);

  WITH expired AS (
    UPDATE trades AS trade
       SET status = 'expired'::trade_status,
           completion_failure_reason = v_reason
     WHERE trade.league_id = p_league_id
       AND trade.status = 'pending'::trade_status
       AND EXISTS (
         SELECT 1
           FROM trade_items AS item
          WHERE item.trade_id = trade.id
            AND item.from_member_id = p_member_id
            AND (
              (p_player_id IS NOT NULL AND item.player_id = p_player_id)
              OR (p_pick_id IS NOT NULL AND item.pick_id = p_pick_id)
            )
       )
     RETURNING trade.id, trade.league_id, trade.league_season_id, trade.proposer_member_id, trade.recipient_member_id
  )
  INSERT INTO league_activity (
    league_id,
    league_season_id,
    actor_member_id,
    target_member_id,
    related_player_id,
    related_trade_id,
    event_type,
    title,
    body
  )
  SELECT
    expired.league_id,
    expired.league_season_id,
    expired.proposer_member_id,
    expired.recipient_member_id,
    p_player_id,
    expired.id,
    'trade_expired',
    'Trade offer expired',
    v_reason
    FROM expired;

  PERFORM set_config('app.trade_lifecycle_server_write', '', true);
END;
$$;

CREATE OR REPLACE FUNCTION private.sync_roster_linked_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_left_roster boolean := TG_OP = 'DELETE' OR OLD.member_id IS DISTINCT FROM NEW.member_id;
  v_became_inactive boolean := TG_OP = 'UPDATE'
    AND (NEW.is_on_ir = true OR NEW.is_on_taxi = true)
    AND (OLD.is_on_ir IS DISTINCT FROM NEW.is_on_ir OR OLD.is_on_taxi IS DISTINCT FROM NEW.is_on_taxi);
  v_still_active boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.player_id IS DISTINCT FROM NEW.player_id THEN
    -- Player identity merge: the listing follows the surviving player row.
    DELETE FROM trade_block_items AS stale
     WHERE stale.league_id = OLD.league_id
       AND stale.member_id = OLD.member_id
       AND stale.player_id = OLD.player_id
       AND EXISTS (
         SELECT 1
           FROM trade_block_items AS kept
          WHERE kept.league_id = OLD.league_id
            AND kept.member_id = OLD.member_id
            AND kept.player_id = NEW.player_id
       );

    UPDATE trade_block_items
       SET player_id = NEW.player_id
     WHERE league_id = OLD.league_id
       AND member_id = OLD.member_id
       AND player_id = OLD.player_id;
  END IF;

  IF NOT (v_left_roster OR v_became_inactive) THEN
    RETURN NULL;
  END IF;

  PERFORM private.clear_future_unlocked_lineups(
    OLD.league_id,
    OLD.league_season_id,
    OLD.player_id,
    OLD.member_id
  );

  -- Roster-linked state is only stale when no active current-season row is left
  -- for this member and player (an old-season row going away must not touch it).
  SELECT EXISTS (
    SELECT 1
      FROM roster_players AS roster
      JOIN league_seasons AS season
        ON season.id = roster.league_season_id
       AND season.is_current = true
     WHERE roster.league_id = OLD.league_id
       AND roster.member_id = OLD.member_id
       AND roster.player_id = OLD.player_id
       AND roster.is_on_ir = false
       AND roster.is_on_taxi = false
  )
    INTO v_still_active;

  IF v_still_active THEN
    RETURN NULL;
  END IF;

  DELETE FROM trade_block_items
   WHERE league_id = OLD.league_id
     AND member_id = OLD.member_id
     AND player_id = OLD.player_id;

  IF v_left_roster THEN
    UPDATE waiver_claims
       SET drop_player_id = NULL
     WHERE status = 'pending'::waiver_claim_status
       AND league_id = OLD.league_id
       AND league_season_id = OLD.league_season_id
       AND member_id = OLD.member_id
       AND drop_player_id = OLD.player_id;

    PERFORM private.expire_pending_trades_for_lost_asset(
      OLD.league_id,
      OLD.member_id,
      OLD.player_id
    );
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION private.sync_trade_block_on_pick_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner_changed boolean := OLD.current_owner_id IS DISTINCT FROM NEW.current_owner_id;
  v_consumed boolean := NEW.is_used = true AND OLD.is_used IS DISTINCT FROM NEW.is_used;
BEGIN
  IF NOT (v_owner_changed OR v_consumed) THEN
    RETURN NULL;
  END IF;

  DELETE FROM trade_block_items
   WHERE league_id = OLD.league_id
     AND pick_id = OLD.id
     AND (v_consumed OR member_id = OLD.current_owner_id);

  PERFORM private.expire_pending_trades_for_lost_asset(
    OLD.league_id,
    OLD.current_owner_id,
    NULL,
    OLD.id,
    CASE
      WHEN v_consumed THEN format('The %s round %s pick has been used in the draft.', OLD.season_year, OLD.round)
      ELSE NULL
    END
  );

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION private.prevent_trade_status_client_writes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller uuid;
BEGIN
  v_caller := (SELECT auth.uid());

  -- Service role / internal SECURITY DEFINER RPCs run with auth.uid() = NULL.
  -- All legitimate status transitions (accept / complete / veto / reject /
  -- withdraw) flow through service-role paths, so we trust them. Server-owned
  -- lifecycle code that runs inside an authenticated transaction (the roster
  -- lifecycle trigger expiring an offer whose asset just left a roster) marks
  -- itself with the transaction-local app.trade_lifecycle_server_write flag.
  IF v_caller IS NULL
     OR current_setting('app.trade_lifecycle_server_write', true) = 'on' THEN
    RETURN NEW;
  END IF;

  -- Authenticated end-user path: any change to status or to a
  -- lifecycle timestamp is forbidden. These are exclusively owned by
  -- the atomic RPCs and backend routes.
  IF NEW.status                 IS DISTINCT FROM OLD.status
     OR NEW.accepted_at            IS DISTINCT FROM OLD.accepted_at
     OR NEW.veto_window_expires_at IS DISTINCT FROM OLD.veto_window_expires_at
     OR NEW.completed_at           IS DISTINCT FROM OLD.completed_at
     OR NEW.vetoed_at              IS DISTINCT FROM OLD.vetoed_at
  THEN
    RAISE EXCEPTION
      'Trade status and lifecycle timestamps can only be changed via the trade RPCs.'
      USING ERRCODE = '42501';
  END IF;

  -- Also forbid rewriting the trade parties themselves. The WITH CHECK
  -- on the policy already prevents reassignment AWAY from the caller,
  -- but defense-in-depth: forbid any change to proposer/recipient or
  -- league/season scoping fields from the client path entirely.
  IF NEW.proposer_member_id  IS DISTINCT FROM OLD.proposer_member_id
     OR NEW.recipient_member_id IS DISTINCT FROM OLD.recipient_member_id
     OR NEW.league_id           IS DISTINCT FROM OLD.league_id
     OR NEW.league_season_id    IS DISTINCT FROM OLD.league_season_id
     OR NEW.proposed_at          IS DISTINCT FROM OLD.proposed_at
  THEN
    RAISE EXCEPTION
      'Trade identity fields are immutable from client-side updates.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.expire_pending_trades_for_lost_asset(uuid, uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.sync_roster_linked_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.sync_trade_block_on_pick_change() FROM PUBLIC;

-- Mutation RPCs without inline cleanup ---------------------------------------

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
    dropped_by_member_id,
    clears_at
  )
  VALUES (
    p_league_id,
    p_league_season_id,
    p_player_id,
    p_member_id,
    now() + interval '48 hours'
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

CREATE OR REPLACE FUNCTION public.drop_player_atomic(p_roster_player_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rp roster_players%ROWTYPE;
  v_member league_members%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_league_id uuid;
  v_player_id uuid;
  v_member_id uuid;
  v_clears_at timestamptz := now() + interval '48 hours';
  v_rows int;
BEGIN
  SELECT league_id, player_id, member_id
    INTO v_league_id, v_player_id, v_member_id
    FROM roster_players
   WHERE id = p_roster_player_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not drop player - you may not have permission or they are no longer on your roster.'
      USING ERRCODE = 'P0002';
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
    RAISE EXCEPTION 'Could not drop player - you may not have permission or they are no longer on your roster.'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_rp.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_league.status NOT IN ('drafting'::league_status, 'active'::league_status, 'playoffs'::league_status, 'offseason'::league_status) THEN
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

  SELECT *
    INTO v_member
    FROM league_members
   WHERE id = v_rp.member_id
     AND user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not drop player - you may not have permission or they are no longer on your roster.'
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM v_member.id;

  IF EXISTS (
    SELECT 1
      FROM trade_items AS item
      JOIN trades AS trade
        ON trade.id = item.trade_id
       AND trade.status = 'accepted'::trade_status
     WHERE item.player_id = v_rp.player_id
       AND trade.league_id = v_rp.league_id
       AND trade.league_season_id = v_rp.league_season_id
       AND item.from_member_id = v_rp.member_id
  ) THEN
    RAISE EXCEPTION 'Player is reserved as an accepted trade asset.'
      USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM roster_players
   WHERE id = p_roster_player_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Could not drop player - you may not have permission or they are no longer on your roster.'
      USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO waiver_wire_log (
    league_id,
    league_season_id,
    player_id,
    dropped_by_member_id,
    clears_at
  )
  VALUES (
    v_rp.league_id,
    v_rp.league_season_id,
    v_rp.player_id,
    v_rp.member_id,
    v_clears_at
  );

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
    'fa_drop'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.toggle_ir_atomic(p_roster_player_id uuid, p_to_ir boolean, p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rp roster_players%ROWTYPE;
  v_member league_members%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_league_id uuid;
  v_player_id uuid;
  v_member_id uuid;
  v_injury text;
  v_roster_size int;
  v_ir_slots int;
  v_other_ir_count int;
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

  IF v_league.status NOT IN ('drafting'::league_status, 'active'::league_status, 'playoffs'::league_status) THEN
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

  IF EXISTS (
    SELECT 1
      FROM trade_items AS item
      JOIN trades AS trade
        ON trade.id = item.trade_id
       AND trade.status = 'accepted'::trade_status
     WHERE item.player_id = v_rp.player_id
       AND trade.league_id = v_rp.league_id
       AND trade.league_season_id = v_rp.league_season_id
       AND item.from_member_id = v_rp.member_id
  ) THEN
    RAISE EXCEPTION 'Player is reserved as an accepted trade asset.'
      USING ERRCODE = 'P0001';
  END IF;

  v_roster_size := COALESCE(v_league.roster_size, 20);
  v_ir_slots := COALESCE(v_league.ir_slots, 2);

  IF p_to_ir THEN
    SELECT p.injury_status
      INTO v_injury
      FROM players p
     WHERE p.id = v_rp.player_id;

    IF NOT (
      lower(COALESCE(v_injury, '')) = 'out'
      OR lower(COALESCE(v_injury, '')) LIKE 'ir%'
    ) THEN
      RAISE EXCEPTION 'Only players with Out or IR designations can be placed on IR.'
        USING ERRCODE = 'P0001';
    END IF;

    SELECT count(*)
      INTO v_other_ir_count
      FROM roster_players
     WHERE member_id = v_rp.member_id
       AND league_season_id = v_rp.league_season_id
       AND is_on_ir = true
       AND id <> p_roster_player_id;

    IF v_other_ir_count >= v_ir_slots THEN
      RAISE EXCEPTION 'You only have % IR slot%.', v_ir_slots, CASE WHEN v_ir_slots = 1 THEN '' ELSE 's' END
        USING ERRCODE = 'P0001';
    END IF;
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
     SET is_on_ir = p_to_ir,
         is_on_taxi = CASE WHEN p_to_ir THEN false ELSE is_on_taxi END
   WHERE id = p_roster_player_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to toggle IR status'
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
    CASE WHEN p_to_ir THEN 'ir_designate' ELSE 'ir_return' END
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.toggle_taxi_atomic(p_roster_player_id uuid, p_to_taxi boolean, p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rp roster_players%ROWTYPE;
  v_member league_members%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_league_id uuid;
  v_player_id uuid;
  v_member_id uuid;
  v_draft_number int;
  v_years_exp int;
  v_roster_size int;
  v_taxi_slots int;
  v_other_taxi_count int;
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

  IF v_league.status NOT IN ('drafting'::league_status, 'active'::league_status, 'playoffs'::league_status) THEN
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

  IF EXISTS (
    SELECT 1
      FROM trade_items AS item
      JOIN trades AS trade
        ON trade.id = item.trade_id
       AND trade.status = 'accepted'::trade_status
     WHERE item.player_id = v_rp.player_id
       AND trade.league_id = v_rp.league_id
       AND trade.league_season_id = v_rp.league_season_id
       AND item.from_member_id = v_rp.member_id
  ) THEN
    RAISE EXCEPTION 'Player is reserved as an accepted trade asset.'
      USING ERRCODE = 'P0001';
  END IF;

  v_roster_size := COALESCE(v_league.roster_size, 20);
  v_taxi_slots := COALESCE(v_league.taxi_slots, 0);

  IF p_to_taxi THEN
    IF v_rp.is_on_ir THEN
      RAISE EXCEPTION 'Activate the player from IR before moving them to taxi.'
        USING ERRCODE = 'P0001';
    END IF;

    SELECT p.nba_draft_number, p.years_exp
      INTO v_draft_number, v_years_exp
      FROM players p
     WHERE p.id = v_rp.player_id;

    IF v_draft_number IS NULL OR v_years_exp IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'Only current rookies can be placed on the taxi squad.'
        USING ERRCODE = 'P0001';
    END IF;

    SELECT count(*)
      INTO v_other_taxi_count
      FROM roster_players
     WHERE member_id = v_rp.member_id
       AND league_season_id = v_rp.league_season_id
       AND is_on_taxi = true
       AND id <> p_roster_player_id;

    IF v_other_taxi_count >= v_taxi_slots THEN
      RAISE EXCEPTION 'You only have % taxi squad slot%.', v_taxi_slots, CASE WHEN v_taxi_slots = 1 THEN '' ELSE 's' END
        USING ERRCODE = 'P0001';
    END IF;
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
END;
$function$;

CREATE OR REPLACE FUNCTION public.complete_accepted_trade_atomic(
  p_trade_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trade trades%ROWTYPE;
  v_item trade_items%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_from_member uuid;
  v_to_member uuid;
  v_member_lock uuid;
  v_lock_player_id uuid;
  v_rows int;
  v_balance int;
  v_item_faab_amount int;
BEGIN
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found';
  END IF;

  IF v_trade.status <> 'accepted' THEN
    RAISE EXCEPTION 'Trade is not ready to complete';
  END IF;

  IF v_trade.veto_window_expires_at IS NULL OR v_trade.veto_window_expires_at > now() THEN
    RAISE EXCEPTION 'Trade veto window is still open';
  END IF;

  FOR v_member_lock IN
    SELECT member_id
      FROM (
        VALUES (v_trade.proposer_member_id), (v_trade.recipient_member_id)
        UNION
        SELECT participant.member_id
          FROM trade_participants AS participant
         WHERE participant.trade_id = p_trade_id
      ) AS members(member_id)
     ORDER BY member_id ASC
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text), hashtext(v_member_lock::text));
  END LOOP;

  FOR v_lock_player_id IN
    SELECT DISTINCT player_id
      FROM trade_items
     WHERE trade_id = p_trade_id
       AND player_id IS NOT NULL
     ORDER BY player_id ASC
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text), hashtext(v_lock_player_id::text));
  END LOOP;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_trade.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.';
  END IF;

  IF v_league.status = 'archived'::league_status THEN
    RAISE EXCEPTION 'Archived leagues are read-only.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons AS season
   WHERE season.id = v_trade.league_season_id
     AND season.is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trades require the current season.'
      USING ERRCODE = 'P0001';
  END IF;

  FOR v_from_member, v_item_faab_amount IN
    SELECT
      item.from_member_id,
      sum(item.faab_amount)::int
      FROM trade_items AS item
     WHERE item.trade_id = p_trade_id
       AND item.faab_amount > 0
     GROUP BY 1
  LOOP
    v_balance := private.ensure_faab_balance(v_trade.league_id, v_trade.league_season_id, v_from_member);
    IF v_balance < v_item_faab_amount THEN
      RAISE EXCEPTION 'Trade participant no longer has enough FAAB for this trade.'
        USING ERRCODE = 'PT001';
    END IF;
  END LOOP;

  FOR v_item IN
    SELECT * FROM trade_items WHERE trade_id = p_trade_id ORDER BY created_at, id
  LOOP
    v_from_member := v_item.from_member_id;

    IF v_item.player_id IS NOT NULL THEN
      PERFORM 1
        FROM roster_players
       WHERE league_id = v_trade.league_id
         AND league_season_id = v_trade.league_season_id
         AND member_id = v_from_member
         AND player_id = v_item.player_id
         AND is_on_ir = false
         AND is_on_taxi = false
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Player asset is no longer owned by the expected active roster side'
          USING ERRCODE = 'PT001';
      END IF;
    ELSIF v_item.pick_id IS NOT NULL THEN
      PERFORM 1
        FROM draft_picks
       WHERE id = v_item.pick_id
         AND league_id = v_trade.league_id
         AND current_owner_id = v_from_member
         AND is_used = false
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Draft-pick asset is no longer owned by the expected trade side'
          USING ERRCODE = 'PT001';
      END IF;
    ELSE
      v_item_faab_amount := COALESCE(v_item.faab_amount, 0);
      IF v_item_faab_amount <= 0 THEN
        RAISE EXCEPTION 'Trade item must include a player, pick, or positive FAAB amount'
          USING ERRCODE = 'PT001';
      END IF;

    END IF;
  END LOOP;

  FOR v_from_member, v_item_faab_amount IN
    SELECT
      item.from_member_id,
      sum(item.faab_amount)::int
      FROM trade_items AS item
     WHERE item.trade_id = p_trade_id
       AND item.faab_amount > 0
     GROUP BY 1
  LOOP
    UPDATE faab_balances
       SET balance = balance - v_item_faab_amount,
           updated_at = now()
     WHERE league_id = v_trade.league_id
       AND league_season_id = v_trade.league_season_id
       AND member_id = v_from_member
       AND balance >= v_item_faab_amount;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'Trade participant no longer has enough FAAB for this trade.'
        USING ERRCODE = 'PT001';
    END IF;
  END LOOP;

  FOR v_item IN
    SELECT * FROM trade_items WHERE trade_id = p_trade_id ORDER BY created_at, id
  LOOP
    v_from_member := v_item.from_member_id;
    v_to_member := v_item.to_member_id;

    IF v_item.player_id IS NOT NULL THEN
      UPDATE roster_players
         SET member_id = v_to_member,
             acquired_via = 'trade'
       WHERE league_id = v_trade.league_id
         AND league_season_id = v_trade.league_season_id
         AND member_id = v_from_member
         AND player_id = v_item.player_id
         AND is_on_ir = false
         AND is_on_taxi = false;

      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'Failed to move player asset atomically'
          USING ERRCODE = 'PT001';
      END IF;

      INSERT INTO roster_transactions (
        league_id,
        league_season_id,
        member_id,
        player_id,
        transaction_type,
        related_trade_id
      )
      VALUES
        (v_trade.league_id, v_trade.league_season_id, v_from_member, v_item.player_id, 'trade_out', p_trade_id),
        (v_trade.league_id, v_trade.league_season_id, v_to_member, v_item.player_id, 'trade_in', p_trade_id);
    ELSIF v_item.pick_id IS NOT NULL THEN
      UPDATE draft_picks
         SET current_owner_id = v_to_member
       WHERE id = v_item.pick_id
         AND league_id = v_trade.league_id
         AND current_owner_id = v_from_member
         AND is_used = false;

      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'Failed to move draft-pick asset atomically'
          USING ERRCODE = 'PT001';
      END IF;
    ELSE
      v_item_faab_amount := COALESCE(v_item.faab_amount, 0);
      IF v_item_faab_amount <= 0 THEN
        RAISE EXCEPTION 'Trade item must include a player, pick, or positive FAAB amount'
          USING ERRCODE = 'PT001';
      END IF;

      INSERT INTO faab_balances (
        league_id,
        league_season_id,
        member_id,
        balance
      )
      VALUES (
        v_trade.league_id,
        v_trade.league_season_id,
        v_to_member,
        v_item_faab_amount
      )
      ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE
         SET balance = faab_balances.balance + EXCLUDED.balance,
             updated_at = now();
    END IF;
  END LOOP;

  UPDATE trades
     SET status = 'completed',
         completed_at = now(),
         completion_failure_reason = NULL
   WHERE id = p_trade_id
     AND status = 'accepted';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to complete trade atomically';
  END IF;

  PERFORM private.log_league_activity(
    v_trade.league_id,
    v_trade.league_season_id,
    'trade_completed',
    'Trade completed',
    NULL,
    v_trade.proposer_member_id,
    v_trade.recipient_member_id,
    NULL,
    p_trade_id,
    NULL,
    jsonb_build_object(
      'proposer_faab_amount', v_trade.proposer_faab_amount,
      'recipient_faab_amount', v_trade.recipient_faab_amount,
      'is_multi_team', COALESCE(v_trade.is_multi_team, false)
    )
  );
END;
$$;

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
  v_target_player_id uuid;
  v_ineligible text;
  v_faab_balance int;
  v_week int;
  v_weekly_add_count int;
  v_player_name text;
  v_candidate record;
BEGIN
  FOR v_candidate IN
    WITH candidate_groups AS (
      SELECT
        candidate.league_id,
        candidate.league_season_id,
        candidate.player_id,
        min(candidate.process_date) AS process_date
        FROM waiver_claims AS candidate
        JOIN waiver_wire_log AS due_wwl
          ON due_wwl.league_id = candidate.league_id
         AND due_wwl.league_season_id = candidate.league_season_id
         AND due_wwl.player_id = candidate.player_id
         AND due_wwl.cleared_at IS NULL
         AND due_wwl.clears_at <= now()
        JOIN leagues AS claim_league
          ON claim_league.id = candidate.league_id
         AND claim_league.status IN ('active'::league_status, 'playoffs'::league_status, 'offseason'::league_status)
        JOIN league_seasons AS claim_season
          ON claim_season.id = candidate.league_season_id
         AND claim_season.is_current = true
       WHERE candidate.status = 'pending'
         AND candidate.process_date <= p_process_date
       GROUP BY candidate.league_id, candidate.league_season_id, candidate.player_id
    ), league_candidates AS (
      SELECT DISTINCT ON (candidate_groups.league_id, candidate_groups.league_season_id)
        candidate_groups.*
        FROM candidate_groups
       ORDER BY candidate_groups.league_id, candidate_groups.league_season_id,
         candidate_groups.process_date, candidate_groups.player_id
    )
    SELECT league_candidates.league_id, league_candidates.league_season_id, league_candidates.player_id
      FROM league_candidates
     ORDER BY league_candidates.process_date, league_candidates.league_id,
       league_candidates.league_season_id, league_candidates.player_id
     LIMIT 128
  LOOP
    IF pg_try_advisory_xact_lock(hashtext(v_candidate.league_id::text), hashtext(v_candidate.league_season_id::text)) THEN
      v_target_league_id := v_candidate.league_id;
      v_target_season_id := v_candidate.league_season_id;
      v_target_player_id := v_candidate.player_id;
      EXIT;
    END IF;
  END LOOP;

  IF v_target_league_id IS NULL THEN
    RETURN;
  END IF;

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
    JOIN waiver_wire_log AS due_wwl
      ON due_wwl.league_id = wc.league_id
     AND due_wwl.league_season_id = wc.league_season_id
     AND due_wwl.player_id = wc.player_id
     AND due_wwl.cleared_at IS NULL
     AND due_wwl.clears_at <= now()
    JOIN leagues AS claim_league
      ON claim_league.id = wc.league_id
     AND claim_league.status IN ('active'::league_status, 'playoffs'::league_status, 'offseason'::league_status)
    JOIN league_seasons AS claim_season
      ON claim_season.id = wc.league_season_id
     AND claim_season.is_current = true
   WHERE wc.status = 'pending'
     AND wc.process_date <= p_process_date
     AND wc.league_id = v_target_league_id
     AND wc.league_season_id = v_target_season_id
     AND wc.player_id = v_target_player_id
   ORDER BY
     CASE WHEN claim_league.waiver_mode = 'faab' THEN wc.bid_amount END DESC NULLS LAST,
     wp.priority ASC,
     wc.claim_order ASC,
     wc.submitted_at ASC,
     wc.id ASC
   LIMIT 1
   FOR UPDATE OF wc;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(v_claim.league_id::text), hashtext(v_claim.member_id::text));

  FOR v_lock_player_id IN
    SELECT DISTINCT pid
      FROM unnest(ARRAY[v_claim.player_id, v_claim.drop_player_id]::uuid[]) AS t(pid)
     WHERE pid IS NOT NULL
     ORDER BY pid ASC
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_claim.league_id::text), hashtext(v_lock_player_id::text));
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

  IF NOT FOUND THEN
    v_failure := 'Player no longer on waivers.';
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

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_claim.league_id
   FOR UPDATE;

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

  IF v_league.weekly_add_limit IS NOT NULL THEN
    v_week := private.current_add_week_number(v_claim.league_id, v_claim.league_season_id);

    INSERT INTO weekly_add_counts (
      league_id,
      league_season_id,
      member_id,
      week_number,
      add_count
    )
    VALUES (
      v_claim.league_id,
      v_claim.league_season_id,
      v_claim.member_id,
      v_week,
      0
    )
    ON CONFLICT ON CONSTRAINT weekly_add_counts_league_id_league_season_id_member_id_week_key DO NOTHING;

    SELECT count_row.add_count
      INTO v_weekly_add_count
      FROM weekly_add_counts AS count_row
     WHERE count_row.league_id = v_claim.league_id
       AND count_row.league_season_id = v_claim.league_season_id
       AND count_row.member_id = v_claim.member_id
       AND count_row.week_number = v_week
     FOR UPDATE;

    IF COALESCE(v_weekly_add_count, 0) >= v_league.weekly_add_limit THEN
      v_failure := private.weekly_add_limit_message(COALESCE(v_weekly_add_count, 0), v_league.weekly_add_limit);
      RETURN QUERY SELECT * FROM private.fail_waiver_claim(
        v_claim.id,
        v_claim.league_id,
        v_claim.league_season_id,
        v_claim.member_id,
        v_claim.player_id,
        'failed_roster'::waiver_claim_status,
        v_failure,
        'waiver_claim_failed_add_limit',
        'Waiver claim failed',
        jsonb_build_object('bid_amount', v_claim.bid_amount)
      );
      RETURN;
    END IF;
  END IF;

  IF v_league.waiver_mode = 'faab' THEN
    v_faab_balance := private.ensure_faab_balance(v_claim.league_id, v_claim.league_season_id, v_claim.member_id);
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

  SELECT string_agg(COALESCE(p.display_name, 'Unknown'), ', ')
    INTO v_ineligible
    FROM roster_players AS rp
    JOIN players AS p ON p.id = rp.player_id
   WHERE rp.member_id = v_claim.member_id
     AND rp.league_id = v_claim.league_id
     AND rp.league_season_id = v_claim.league_season_id
     AND rp.is_on_ir = true
     AND NOT (
       lower(COALESCE(p.injury_status, '')) = 'out'
       OR lower(COALESCE(p.injury_status, '')) LIKE 'ir%'
     );

  IF v_ineligible IS NOT NULL AND length(v_ineligible) > 0 THEN
    v_failure := format(
      'You have ineligible players on IR (%s). Activate or drop them before waiver claims can process.',
      v_ineligible
    );
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

  SELECT count(*)
    INTO v_active_count
    FROM roster_players AS rp
   WHERE rp.league_id = v_claim.league_id
     AND rp.league_season_id = v_claim.league_season_id
     AND rp.member_id = v_claim.member_id
     AND rp.is_on_ir = false
     AND rp.is_on_taxi = false;

  v_projected_active_count := v_active_count + 1 - CASE WHEN v_claim.drop_player_id IS NULL THEN 0 ELSE 1 END;

  IF v_projected_active_count > COALESCE(v_roster_size, 20) THEN
    v_failure := CASE
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

  IF v_claim.drop_player_id IS NOT NULL THEN
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

  PERFORM private.clear_future_unlocked_lineups(
    v_claim.league_id,
    v_claim.league_season_id,
    v_claim.player_id
  );

  INSERT INTO roster_players (
    league_id,
    league_season_id,
    member_id,
    player_id,
    acquired_via
  )
  VALUES (
    v_claim.league_id,
    v_claim.league_season_id,
    v_claim.member_id,
    v_claim.player_id,
    'waiver'
  );

  INSERT INTO roster_transactions (
    league_id,
    league_season_id,
    member_id,
    player_id,
    transaction_type,
    related_claim_id
  )
  VALUES (
    v_claim.league_id,
    v_claim.league_season_id,
    v_claim.member_id,
    v_claim.player_id,
    'waiver_add',
    v_claim.id
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
    END,
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
END;
$$;

-- Triggers ----------------------------------------------------------------

DROP TRIGGER IF EXISTS clear_trade_block_listing_on_inactive_roster ON public.roster_players;
DROP FUNCTION IF EXISTS private.clear_trade_block_listing_on_inactive_roster();
DROP FUNCTION IF EXISTS private.clear_trade_block_listing_for_asset(uuid, uuid, uuid, uuid);

DROP TRIGGER IF EXISTS sync_roster_linked_state ON public.roster_players;
CREATE TRIGGER sync_roster_linked_state
AFTER DELETE OR UPDATE OF member_id, player_id, is_on_ir, is_on_taxi ON public.roster_players
FOR EACH ROW
EXECUTE FUNCTION private.sync_roster_linked_state();

DROP TRIGGER IF EXISTS sync_trade_block_on_pick_change ON public.draft_picks;
CREATE TRIGGER sync_trade_block_on_pick_change
AFTER UPDATE OF current_owner_id, is_used ON public.draft_picks
FOR EACH ROW
EXECUTE FUNCTION private.sync_trade_block_on_pick_change();

-- Backfill rows that drifted before the trigger existed ---------------------

DELETE FROM public.trade_block_items AS item
 WHERE item.player_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1
       FROM public.roster_players AS roster
       JOIN public.league_seasons AS season
         ON season.id = roster.league_season_id
        AND season.is_current = true
      WHERE roster.league_id = item.league_id
        AND roster.member_id = item.member_id
        AND roster.player_id = item.player_id
        AND roster.is_on_ir = false
        AND roster.is_on_taxi = false
   );

DELETE FROM public.trade_block_items AS item
 WHERE item.pick_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1
       FROM public.draft_picks AS pick
      WHERE pick.id = item.pick_id
        AND pick.league_id = item.league_id
        AND pick.current_owner_id = item.member_id
        AND pick.is_used = false
   );

UPDATE public.waiver_claims AS claim
   SET drop_player_id = NULL
 WHERE claim.status = 'pending'::public.waiver_claim_status
   AND claim.drop_player_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1
       FROM public.roster_players AS roster
      WHERE roster.league_id = claim.league_id
        AND roster.league_season_id = claim.league_season_id
        AND roster.member_id = claim.member_id
        AND roster.player_id = claim.drop_player_id
   );

DO $$
DECLARE
  v_item record;
BEGIN
  FOR v_item IN
    SELECT DISTINCT trade.league_id, item.from_member_id, item.player_id, item.pick_id
      FROM public.trades AS trade
      JOIN public.trade_items AS item
        ON item.trade_id = trade.id
     WHERE trade.status = 'pending'::public.trade_status
       AND (
         (item.player_id IS NOT NULL AND NOT EXISTS (
           SELECT 1
             FROM public.roster_players AS roster
            WHERE roster.league_id = trade.league_id
              AND roster.league_season_id = trade.league_season_id
              AND roster.member_id = item.from_member_id
              AND roster.player_id = item.player_id
         ))
         OR (item.pick_id IS NOT NULL AND NOT EXISTS (
           SELECT 1
             FROM public.draft_picks AS pick
            WHERE pick.id = item.pick_id
              AND pick.current_owner_id = item.from_member_id
              AND pick.is_used = false
         ))
       )
  LOOP
    PERFORM private.expire_pending_trades_for_lost_asset(
      v_item.league_id,
      v_item.from_member_id,
      v_item.player_id,
      v_item.pick_id
    );
  END LOOP;
END $$;
