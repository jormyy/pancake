-- Route-aware multi-team trade reservation guards.

-- Keep this migration in parity with supabase/sql/functions/by-name via npm run check:db-function-sources.
CREATE OR REPLACE FUNCTION private.prevent_reserved_or_inactive_trade_accept()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, private
AS $$
BEGIN
  IF NEW.status = 'accepted'::trade_status AND OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM 1
      FROM trade_items AS ti
      JOIN roster_players AS rp
        ON rp.league_id = NEW.league_id
       AND rp.league_season_id = NEW.league_season_id
       AND rp.player_id = ti.player_id
       AND rp.member_id = COALESCE(
         ti.from_member_id,
         CASE WHEN ti.side = 'proposer'::trade_side THEN NEW.proposer_member_id ELSE NEW.recipient_member_id END
       )
     WHERE ti.trade_id = NEW.id
       AND ti.player_id IS NOT NULL
     FOR UPDATE OF rp;

    PERFORM 1
      FROM trade_items AS ti
      JOIN draft_picks AS pick
        ON pick.id = ti.pick_id
     WHERE ti.trade_id = NEW.id
       AND ti.pick_id IS NOT NULL
     FOR UPDATE OF pick;

    IF EXISTS (
      WITH player_assets AS (
        SELECT
          ti.player_id,
          COALESCE(
            ti.from_member_id,
            CASE WHEN ti.side = 'proposer'::trade_side THEN NEW.proposer_member_id ELSE NEW.recipient_member_id END
          ) AS member_id
        FROM trade_items AS ti
        WHERE ti.trade_id = NEW.id
          AND ti.player_id IS NOT NULL
      )
      SELECT 1
        FROM player_assets AS asset
        JOIN roster_players AS rp
          ON rp.league_id = NEW.league_id
         AND rp.league_season_id = NEW.league_season_id
         AND rp.member_id = asset.member_id
         AND rp.player_id = asset.player_id
       WHERE rp.is_on_ir = true
          OR rp.is_on_taxi = true
          OR EXISTS (
            SELECT 1
              FROM trade_drop_reservations AS reservation
              JOIN trades AS trade
                ON trade.id = reservation.trade_id
               AND trade.status = 'accepted'::trade_status
             WHERE reservation.roster_player_id = rp.id
               AND reservation.trade_id <> NEW.id
          )
          OR EXISTS (
            SELECT 1
              FROM trade_items AS other_item
              JOIN trades AS other_trade
                ON other_trade.id = other_item.trade_id
               AND other_trade.status = 'accepted'::trade_status
             WHERE other_trade.id <> NEW.id
               AND other_trade.league_id = NEW.league_id
               AND other_trade.league_season_id = NEW.league_season_id
               AND other_item.player_id = rp.player_id
               AND COALESCE(
                 other_item.from_member_id,
                 CASE
                   WHEN other_item.side = 'proposer'::trade_side THEN other_trade.proposer_member_id
                   ELSE other_trade.recipient_member_id
                 END
               ) = rp.member_id
          )
    ) THEN
      RAISE EXCEPTION 'Trade player assets must be active and unreserved roster players.'
        USING ERRCODE = 'P0001';
    END IF;

    IF EXISTS (
      WITH pick_assets AS (
        SELECT
          ti.pick_id,
          COALESCE(
            ti.from_member_id,
            CASE WHEN ti.side = 'proposer'::trade_side THEN NEW.proposer_member_id ELSE NEW.recipient_member_id END
          ) AS member_id
        FROM trade_items AS ti
        WHERE ti.trade_id = NEW.id
          AND ti.pick_id IS NOT NULL
      )
      SELECT 1
        FROM pick_assets AS asset
        JOIN draft_picks AS pick
          ON pick.id = asset.pick_id
       WHERE EXISTS (
         SELECT 1
           FROM trade_items AS other_item
           JOIN trades AS other_trade
             ON other_trade.id = other_item.trade_id
            AND other_trade.status = 'accepted'::trade_status
          WHERE other_trade.id <> NEW.id
            AND other_trade.league_id = NEW.league_id
            AND other_trade.league_season_id = NEW.league_season_id
            AND other_item.pick_id = asset.pick_id
            AND COALESCE(
              other_item.from_member_id,
              CASE
                WHEN other_item.side = 'proposer'::trade_side THEN other_trade.proposer_member_id
                ELSE other_trade.recipient_member_id
              END
            ) = asset.member_id
       )
    ) THEN
      RAISE EXCEPTION 'Trade draft-pick assets must be unreserved.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.prevent_reserved_drop_roster_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, private
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM trade_drop_reservations AS reservation
      JOIN trades AS trade
        ON trade.id = reservation.trade_id
       AND trade.status = 'accepted'::trade_status
     WHERE reservation.roster_player_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'This roster player is reserved for an accepted trade.'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM trade_items AS item
      JOIN trades AS trade
        ON trade.id = item.trade_id
       AND trade.status = 'accepted'::trade_status
     WHERE trade.league_id = OLD.league_id
       AND trade.league_season_id = OLD.league_season_id
       AND item.player_id = OLD.player_id
       AND COALESCE(
         item.from_member_id,
         CASE WHEN item.side = 'proposer'::trade_side THEN trade.proposer_member_id ELSE trade.recipient_member_id END
       ) = OLD.member_id
  ) THEN
    RAISE EXCEPTION 'This roster player is reserved as an accepted trade asset.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION private.prevent_reserved_or_inactive_roster_move()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, private
AS $$
BEGIN
  IF (
    OLD.member_id IS DISTINCT FROM NEW.member_id OR
    OLD.is_on_ir IS DISTINCT FROM NEW.is_on_ir OR
    OLD.is_on_taxi IS DISTINCT FROM NEW.is_on_taxi
  ) AND EXISTS (
    SELECT 1
      FROM trade_drop_reservations AS reservation
      JOIN trades AS trade
        ON trade.id = reservation.trade_id
       AND trade.status = 'accepted'::trade_status
     WHERE reservation.roster_player_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'This roster player is reserved for an accepted trade.'
      USING ERRCODE = 'P0001';
  END IF;

  IF (
    OLD.is_on_ir IS DISTINCT FROM NEW.is_on_ir OR
    OLD.is_on_taxi IS DISTINCT FROM NEW.is_on_taxi
  ) AND EXISTS (
    SELECT 1
      FROM trade_items AS item
      JOIN trades AS trade
        ON trade.id = item.trade_id
       AND trade.status = 'accepted'::trade_status
     WHERE trade.league_id = OLD.league_id
       AND trade.league_season_id = OLD.league_season_id
       AND item.player_id = OLD.player_id
       AND COALESCE(
         item.from_member_id,
         CASE WHEN item.side = 'proposer'::trade_side THEN trade.proposer_member_id ELSE trade.recipient_member_id END
       ) = OLD.member_id
  ) THEN
    RAISE EXCEPTION 'This roster player is reserved as an accepted trade asset.'
      USING ERRCODE = 'P0001';
  END IF;

  IF (
    OLD.is_on_ir IS DISTINCT FROM NEW.is_on_ir OR
    OLD.is_on_taxi IS DISTINCT FROM NEW.is_on_taxi
  ) AND EXISTS (
    SELECT 1
      FROM waiver_claims AS claim
     WHERE claim.status = 'pending'::waiver_claim_status
       AND claim.league_id = OLD.league_id
       AND claim.league_season_id = OLD.league_season_id
       AND claim.member_id = OLD.member_id
       AND claim.drop_player_id = OLD.player_id
  ) THEN
    RAISE EXCEPTION 'This roster player is reserved as a pending waiver drop.'
      USING ERRCODE = 'P0001';
  END IF;

  IF OLD.member_id IS DISTINCT FROM NEW.member_id AND (
    OLD.is_on_ir = true OR
    OLD.is_on_taxi = true OR
    NEW.is_on_ir = true OR
    NEW.is_on_taxi = true
  ) THEN
    RAISE EXCEPTION 'Inactive roster players must be activated before they can be traded.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.prevent_trade_drop_reserved_asset()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, private
AS $$
DECLARE
  v_trade trades%ROWTYPE;
BEGIN
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = NEW.trade_id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM trade_items AS item
      JOIN trades AS trade
        ON trade.id = item.trade_id
       AND trade.status = 'accepted'::trade_status
     WHERE item.trade_id <> NEW.trade_id
       AND item.player_id = NEW.player_id
       AND trade.league_id = v_trade.league_id
       AND trade.league_season_id = v_trade.league_season_id
       AND COALESCE(
         item.from_member_id,
         CASE WHEN item.side = 'proposer'::trade_side THEN trade.proposer_member_id ELSE trade.recipient_member_id END
       ) = NEW.member_id
  ) THEN
    RAISE EXCEPTION 'Trade drop player is reserved as an accepted trade asset.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

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

  IF EXISTS (
    SELECT 1
      FROM trade_drop_reservations AS reservation
      JOIN trades AS trade
        ON trade.id = reservation.trade_id
       AND trade.status = 'accepted'::trade_status
     WHERE reservation.roster_player_id = v_roster_player_id
  ) OR EXISTS (
    SELECT 1
      FROM trade_items AS item
      JOIN trades AS trade
        ON trade.id = item.trade_id
       AND trade.status = 'accepted'::trade_status
     WHERE item.player_id = p_drop_player_id
       AND trade.league_id = p_league_id
       AND trade.league_season_id = p_league_season_id
       AND COALESCE(
         item.from_member_id,
         CASE WHEN item.side = 'proposer'::trade_side THEN trade.proposer_member_id ELSE trade.recipient_member_id END
       ) = p_member_id
  ) THEN
    RETURN QUERY SELECT v_roster_player_id, 'Drop player is reserved for an accepted trade.';
    RETURN;
  END IF;

  RETURN QUERY SELECT v_roster_player_id, NULL::text;
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
       AND COALESCE(
         item.from_member_id,
         CASE WHEN item.side = 'proposer'::trade_side THEN trade.proposer_member_id ELSE trade.recipient_member_id END
       ) = v_rp.member_id
  ) THEN
    RAISE EXCEPTION 'Player is reserved as an accepted trade asset.'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM trade_drop_reservations AS reservation
      JOIN trades AS trade
        ON trade.id = reservation.trade_id
       AND trade.status = 'accepted'::trade_status
     WHERE reservation.roster_player_id = v_rp.id
  ) THEN
    RAISE EXCEPTION 'Player is reserved as a drop for an accepted trade.'
      USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM roster_players
   WHERE id = p_roster_player_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Could not drop player - you may not have permission or they are no longer on your roster.'
      USING ERRCODE = 'P0002';
  END IF;

  DELETE FROM weekly_lineups wl
   WHERE wl.league_id = v_rp.league_id
     AND wl.league_season_id = v_rp.league_season_id
     AND wl.member_id = v_rp.member_id
     AND wl.player_id = v_rp.player_id
     AND wl.game_date >= (now() AT TIME ZONE 'America/New_York')::date
     AND NOT EXISTS (
       SELECT 1
         FROM players p
         JOIN nba_games g
           ON g.game_date = wl.game_date
          AND (g.home_team = p.nba_team OR g.away_team = p.nba_team)
        WHERE p.id = wl.player_id
          AND (
            g.status IN ('InProgress', 'Final')
            OR (g.game_time IS NOT NULL AND g.game_time <= now())
            OR (g.started_at IS NOT NULL AND g.started_at <= now())
          )
     );

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
       AND COALESCE(
         item.from_member_id,
         CASE WHEN item.side = 'proposer'::trade_side THEN trade.proposer_member_id ELSE trade.recipient_member_id END
       ) = v_rp.member_id
  ) THEN
    RAISE EXCEPTION 'Player is reserved as an accepted trade asset.'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM trade_drop_reservations AS reservation
      JOIN trades AS trade
        ON trade.id = reservation.trade_id
       AND trade.status = 'accepted'::trade_status
     WHERE reservation.roster_player_id = v_rp.id
  ) THEN
    RAISE EXCEPTION 'Player is reserved as a drop for an accepted trade.'
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

  IF p_to_ir THEN
    DELETE FROM weekly_lineups
     WHERE member_id = v_rp.member_id
       AND league_id = v_rp.league_id
       AND league_season_id = v_rp.league_season_id
       AND player_id = v_rp.player_id
       AND game_date >= (now() AT TIME ZONE 'America/New_York')::date;
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
       AND COALESCE(
         item.from_member_id,
         CASE WHEN item.side = 'proposer'::trade_side THEN trade.proposer_member_id ELSE trade.recipient_member_id END
       ) = v_rp.member_id
  ) THEN
    RAISE EXCEPTION 'Player is reserved as an accepted trade asset.'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM trade_drop_reservations AS reservation
      JOIN trades AS trade
        ON trade.id = reservation.trade_id
       AND trade.status = 'accepted'::trade_status
     WHERE reservation.roster_player_id = v_rp.id
  ) THEN
    RAISE EXCEPTION 'Player is reserved as a drop for an accepted trade.'
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

  IF p_to_taxi THEN
    DELETE FROM weekly_lineups
     WHERE member_id = v_rp.member_id
       AND league_id = v_rp.league_id
       AND league_season_id = v_rp.league_season_id
       AND player_id = v_rp.player_id
       AND game_date >= (now() AT TIME ZONE 'America/New_York')::date;
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
